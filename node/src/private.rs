//! Private chains: the epoch-key machinery and the member-only key/value + set store built on it.
//!
//! The scheme (PROJECT_PLAN, Private Chains): each identity has a sequence of **epoch keys** -
//! 32-byte symmetric keys, each published on the identity-public chain as a `key-epoch` entry
//! sealing the key to every member's X25519 encryption pubkey (NaCl sealed boxes via
//! [`crate::seal`]). Private records are XChaCha20-Poly1305 ciphertext under the current epoch
//! key, on the `private` service chain. Rotation is the forward-secrecy boundary: revoking a
//! member mints a fresh epoch sealed to everyone *except* it, so the departed key reads its era
//! forever and nothing after. Adoption is the reverse gesture: the granting node re-seals every
//! historical epoch key to the newcomer, so a new device materializes the full private state.
//!
//! Views are computed in memory on demand, never persisted: the entries table already holds the
//! ciphertext, private state is small (contact names, follows, settings), and a decrypted view
//! on disk would be a second secret to manage for zero read-path benefit at this scale.

use std::collections::BTreeMap;

use anyhow::{anyhow, Result};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use ringtome_proto::registry::{entry_type, service};
use ringtome_proto::{
    Authorize, KeyEpoch, KeyTree, Payload, PrivateKind, PrivatePlain, PrivateRecord, SignedEntry,
    SigningKey,
};
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::keystore::Keystore;
use crate::seal::{self, EncKeyPair};

/// AAD binding record ciphertext to its purpose; the signed envelope already binds authorship
/// and chain position.
const RECORD_AAD: &[u8] = b"ringtome-v0/private-record";

// ---------------------------------------------------------------------------------------------
// Encryption keypairs in the keystore

/// Keystore name for a leaf's X25519 encryption secret, alongside (never inside) its signing key.
fn enc_key_name(leaf_hex: &str) -> String {
    format!("enc:{leaf_hex}")
}

pub fn store_enc_keypair(keystore: &Keystore, leaf_hex: &str, kp: &EncKeyPair) -> Result<()> {
    let name = enc_key_name(leaf_hex);
    keystore.store(&name, &kp.secret, name.as_bytes())
}

pub fn load_enc_keypair(keystore: &Keystore, leaf_hex: &str) -> Result<EncKeyPair> {
    let name = enc_key_name(leaf_hex);
    let bytes = keystore.load_key(&name, name.as_bytes())?;
    let secret: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("encryption key wrong length"))?;
    Ok(EncKeyPair::from_secret(secret))
}

// ---------------------------------------------------------------------------------------------
// Epoch keys: reading them off the chain, minting new ones

/// The epoch keys this node can open, keyed by epoch number. An epoch number can map to several
/// keys: two nodes racing a rotation both mint "epoch N" on their own chains (single-writer means
/// that is not a fork). Writers use one; readers try all - the AEAD tag says which one a record
/// was really under. Convergence, not coordination.
#[derive(Debug, Default)]
pub struct EpochKeys {
    keys: BTreeMap<u64, Vec<[u8; 32]>>,
}

impl EpochKeys {
    /// The newest epoch we hold a key for - what new records are written under.
    pub fn current(&self) -> Option<(u64, [u8; 32])> {
        self.keys
            .iter()
            .next_back()
            .map(|(epoch, keys)| (*epoch, keys[0]))
    }

    pub fn for_epoch(&self, epoch: u64) -> &[[u8; 32]] {
        self.keys.get(&epoch).map_or(&[], |v| v.as_slice())
    }

    pub fn iter(&self) -> impl Iterator<Item = (u64, &[u8; 32])> {
        self.keys
            .iter()
            .flat_map(|(e, keys)| keys.iter().map(move |k| (*e, k)))
    }

    fn insert(&mut self, epoch: u64, key: [u8; 32]) {
        let keys = self.keys.entry(epoch).or_default();
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
}

/// Every decodable `key-epoch` entry stored on the identity-public chains.
async fn load_epoch_entries(db: &SqlitePool) -> Result<Vec<KeyEpoch>, AppError> {
    let entries =
        crate::imaol::entries_of_type(db, service::IDENTITY_PUBLIC, entry_type::KEY_EPOCH).await?;
    let mut out = Vec::with_capacity(entries.len());
    for signed in entries {
        let Payload::Inline(payload) = &signed.entry().payload else {
            continue;
        };
        match KeyEpoch::decode(payload) {
            Ok(ke) => out.push(ke),
            // An undecodable payload from a member is that member's bug; it cannot be allowed to
            // wedge everyone's private store.
            Err(e) => tracing::warn!("skipping undecodable key-epoch payload: {e}"),
        }
    }
    Ok(out)
}

/// Walk the chain's `key-epoch` entries and unseal every box addressed to our leaf.
pub async fn unseal_epoch_keys(
    db: &SqlitePool,
    our_leaf: &[u8; 32],
    our_enc: &EncKeyPair,
) -> Result<EpochKeys, AppError> {
    let mut keys = EpochKeys::default();
    for ke in load_epoch_entries(db).await? {
        for (leaf, _enc_pub, sealed) in &ke.recipients {
            if leaf != our_leaf {
                continue;
            }
            match seal::unseal(sealed, our_enc) {
                Some(plain) => match <[u8; 32]>::try_from(plain.as_slice()) {
                    Ok(key) => keys.insert(ke.epoch, key),
                    Err(_) => tracing::warn!(epoch = ke.epoch, "epoch box held a non-key"),
                },
                // Sealed to our leaf id but not our enc key: stale roster data. Fail closed.
                None => tracing::warn!(epoch = ke.epoch, "epoch box addressed to us won't open"),
            }
        }
    }
    Ok(keys)
}

/// The highest epoch number anyone has published, openable by us or not - what a rotation must
/// step past.
pub async fn max_epoch(db: &SqlitePool) -> Result<Option<u64>, AppError> {
    Ok(load_epoch_entries(db)
        .await?
        .iter()
        .map(|ke| ke.epoch)
        .max())
}

/// Every member encryption pubkey learnable from the chain: authorize stamps (field 2) plus the
/// recipient lists of past epochs. This is how a rotator seals to members it never met.
pub async fn enc_roster(db: &SqlitePool) -> Result<BTreeMap<[u8; 32], [u8; 32]>, AppError> {
    let mut roster = BTreeMap::new();

    let authorizes =
        crate::imaol::entries_of_type(db, service::IDENTITY_PUBLIC, entry_type::AUTHORIZE).await?;
    for signed in authorizes {
        let Payload::Inline(payload) = &signed.entry().payload else {
            continue;
        };
        if let Ok(az) = Authorize::decode(payload) {
            if let Some(enc) = az.enc_pubkey {
                roster.insert(az.child, enc);
            }
        }
    }

    for ke in load_epoch_entries(db).await? {
        for (leaf, enc_pub, _sealed) in &ke.recipients {
            roster.insert(*leaf, *enc_pub);
        }
    }
    Ok(roster)
}

/// A fresh random epoch key.
pub fn fresh_epoch_key() -> [u8; 32] {
    use rand::RngCore;
    let mut key = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut key);
    key
}

/// Publish one epoch key sealed to a set of recipients, as a `key-epoch` entry signed by this
/// node's key. Used for genesis (epoch 0), rotation, and adoption re-seals alike.
pub async fn mint_epoch(
    db: &SqlitePool,
    signer: &SigningKey,
    epoch: u64,
    epoch_key: &[u8; 32],
    recipients: &[([u8; 32], [u8; 32])],
) -> Result<SignedEntry, AppError> {
    let mut sealed_recipients = Vec::with_capacity(recipients.len());
    for (leaf, enc_pub) in recipients {
        let sealed = seal::seal(epoch_key, enc_pub)
            .map_err(|e| AppError::Internal(anyhow!("sealing epoch key: {e}")))?;
        sealed_recipients.push((*leaf, *enc_pub, sealed));
    }
    let payload = KeyEpoch {
        epoch,
        recipients: sealed_recipients,
    }
    .encode()
    .map_err(|e| AppError::Internal(anyhow!("encoding key-epoch: {e}")))?;
    crate::imaol::append(
        db,
        signer,
        service::IDENTITY_PUBLIC,
        entry_type::KEY_EPOCH,
        Payload::Inline(payload),
    )
    .await
}

/// Adoption's second half: re-seal every epoch key this node holds to the newcomer, so its
/// private view reaches back to epoch 0. One `key-epoch` entry per (epoch, key) we hold.
pub async fn reseal_epochs_to(
    db: &SqlitePool,
    signer: &SigningKey,
    newcomer_leaf: &[u8; 32],
    newcomer_enc: &[u8; 32],
    keys: &EpochKeys,
) -> Result<u64, AppError> {
    let mut count = 0u64;
    for (epoch, key) in keys.iter() {
        mint_epoch(db, signer, epoch, key, &[(*newcomer_leaf, *newcomer_enc)]).await?;
        count += 1;
    }
    Ok(count)
}

/// The forward-secrecy boundary: mint a fresh epoch sealed to every Active member *except*
/// `exclude`, stepping the epoch number past everything published. Members whose enc pubkey the
/// chain never learned are skipped (they fail closed: they keep reading their old era and a
/// later re-seal can catch them up) - never silently, though.
pub async fn rotate_epoch(
    db: &SqlitePool,
    signer: &SigningKey,
    tree: &KeyTree,
    exclude: &[u8; 32],
) -> Result<SignedEntry, AppError> {
    use ringtome_proto::keytree::KeyStatus;

    let roster = enc_roster(db).await?;
    let mut recipients: Vec<([u8; 32], [u8; 32])> = Vec::new();
    for (member, status) in tree.members() {
        if status != KeyStatus::Active || member == exclude {
            continue;
        }
        match roster.get(member) {
            Some(enc_pub) => recipients.push((*member, *enc_pub)),
            None => tracing::warn!(
                member = %hex::encode(member),
                "rotating without a member: no encryption pubkey on chain"
            ),
        }
    }
    // The root's enc pubkey never appears in an authorize stamp (the root has none); it rides in
    // epoch recipient lists, so the roster covers it from epoch 0 onward.
    if recipients.is_empty() {
        return Err(AppError::Internal(anyhow!(
            "epoch rotation would have zero recipients"
        )));
    }

    let epoch = max_epoch(db).await?.map_or(0, |e| e + 1);
    let key = fresh_epoch_key();
    mint_epoch(db, signer, epoch, &key, &recipients).await
}

// ---------------------------------------------------------------------------------------------
// Record encryption

fn cipher(key: &[u8; 32]) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new(key.into())
}

/// Encrypt one plaintext record under an epoch key.
pub fn encrypt_record(
    epoch: u64,
    epoch_key: &[u8; 32],
    plain: &PrivatePlain,
) -> Result<PrivateRecord, AppError> {
    let plaintext = plain
        .encode()
        .map_err(|e| AppError::BadRequest(format!("invalid private record: {e}")))?;
    let mut nonce = [0u8; 24];
    {
        use rand::RngCore;
        rand::rngs::OsRng.fill_bytes(&mut nonce);
    }
    let ciphertext = cipher(epoch_key)
        .encrypt(
            XNonce::from_slice(&nonce),
            chacha20poly1305::aead::Payload {
                msg: &plaintext,
                aad: RECORD_AAD,
            },
        )
        .map_err(|e| AppError::Internal(anyhow!("encrypting private record: {e}")))?;
    Ok(PrivateRecord {
        epoch,
        nonce,
        ciphertext,
    })
}

/// Decrypt a record with whichever key of its epoch authenticates. `None` means we hold no
/// working key for that epoch - the normal state of a revoked-then-rotated-away member looking
/// at the future, or a newcomer not yet re-sealed into the past.
pub fn decrypt_record(record: &PrivateRecord, keys: &EpochKeys) -> Option<PrivatePlain> {
    for key in keys.for_epoch(record.epoch) {
        if let Ok(plaintext) = cipher(key).decrypt(
            XNonce::from_slice(&record.nonce),
            chacha20poly1305::aead::Payload {
                msg: &record.ciphertext,
                aad: RECORD_AAD,
            },
        ) {
            return PrivatePlain::decode(&plaintext).ok();
        }
    }
    None
}

/// Append one private record under the current epoch.
pub async fn write_record(
    db: &SqlitePool,
    signer: &SigningKey,
    keys: &EpochKeys,
    plain: &PrivatePlain,
) -> Result<SignedEntry, AppError> {
    let (epoch, key) = keys.current().ok_or_else(|| {
        AppError::Internal(anyhow!("this node holds no epoch key for the identity"))
    })?;
    let record = encrypt_record(epoch, &key, plain)?;
    let payload = record
        .encode()
        .map_err(|e| AppError::Internal(anyhow!("encoding private record: {e}")))?;
    crate::imaol::append(
        db,
        signer,
        service::PRIVATE,
        entry_type::PRIVATE_RECORD,
        Payload::Inline(payload),
    )
    .await
}

// ---------------------------------------------------------------------------------------------
// The in-memory view

/// LWW stamp, same total order the profile view uses: claimed timestamp, then seq, then hash.
type Stamp = (u64, u64, [u8; 32]);

#[derive(Debug, Clone, serde::Serialize)]
pub struct RegisterValue {
    pub key: String,
    pub value: String,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SetElement {
    pub element: String,
    pub value: Option<String>,
    pub updated_at_ms: u64,
}

/// The materialized private state: LWW registers and LWW-element-sets, folded from every record
/// this node can decrypt.
#[derive(Debug, Default)]
pub struct PrivateView {
    registers: BTreeMap<(String, String), (String, Stamp)>,
    /// `(present, value, stamp)` per element - LWW-element-set semantics.
    sets: BTreeMap<(String, String), (bool, Option<String>, Stamp)>,
    /// Records we hold but cannot open (epochs from outside our membership era).
    pub undecryptable: u64,
}

impl PrivateView {
    pub fn registers_in(&self, collection: &str) -> Vec<RegisterValue> {
        self.registers
            .iter()
            .filter(|((c, _), _)| c == collection)
            .map(|((_, k), (v, stamp))| RegisterValue {
                key: k.clone(),
                value: v.clone(),
                updated_at_ms: stamp.0,
            })
            .collect()
    }

    pub fn set_elements(&self, collection: &str) -> Vec<SetElement> {
        self.sets
            .iter()
            .filter(|((c, _), (present, _, _))| c == collection && *present)
            .map(|((_, e), (_, value, stamp))| SetElement {
                element: e.clone(),
                value: value.clone(),
                updated_at_ms: stamp.0,
            })
            .collect()
    }

    fn fold(&mut self, plain: PrivatePlain, stamp: Stamp) {
        match plain.kind {
            PrivateKind::Register => {
                let slot = (plain.collection, plain.key);
                let value = plain.value.unwrap_or_default();
                match self.registers.get(&slot) {
                    Some((_, existing)) if *existing >= stamp => {}
                    _ => {
                        self.registers.insert(slot, (value, stamp));
                    }
                }
            }
            PrivateKind::SetAdd | PrivateKind::SetRemove => {
                let present = plain.kind == PrivateKind::SetAdd;
                let slot = (plain.collection, plain.key);
                match self.sets.get(&slot) {
                    Some((_, _, existing)) if *existing >= stamp => {}
                    _ => {
                        self.sets.insert(slot, (present, plain.value, stamp));
                    }
                }
            }
        }
    }
}

/// Fold every stored private record we can decrypt into a fresh view. Recomputed per read:
/// private state is small by design, and this is exactly the disposable-view discipline with the
/// persistence dial at zero.
pub async fn materialize(db: &SqlitePool, keys: &EpochKeys) -> Result<PrivateView, AppError> {
    let records =
        crate::imaol::entries_of_type(db, service::PRIVATE, entry_type::PRIVATE_RECORD).await?;

    let mut view = PrivateView::default();
    for signed in records {
        let Payload::Inline(payload) = &signed.entry().payload else {
            continue;
        };
        let Ok(record) = PrivateRecord::decode(payload) else {
            tracing::warn!("skipping undecodable private-record payload");
            continue;
        };
        match decrypt_record(&record, keys) {
            Some(plain) => {
                let stamp = (
                    signed.entry().timestamp_ms,
                    signed.entry().seq,
                    *signed.hash(),
                );
                view.fold(plain, stamp);
            }
            None => view.undecryptable += 1,
        }
    }
    Ok(view)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_db() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::db::user_migrator_for_test(&pool).await;
        pool
    }

    fn signer(byte: u8) -> SigningKey {
        SigningKey::from_bytes(&[byte; 32])
    }

    fn plain_register(collection: &str, key: &str, value: &str) -> PrivatePlain {
        PrivatePlain {
            kind: PrivateKind::Register,
            collection: collection.into(),
            key: key.into(),
            value: Some(value.into()),
        }
    }

    #[tokio::test]
    async fn epoch_mint_unseal_write_read_round_trip() {
        let db = test_db().await;
        let root_key = signer(1);
        let root_leaf = root_key.verifying_key().to_bytes();
        let enc = EncKeyPair::generate();

        let epoch_key = fresh_epoch_key();
        mint_epoch(&db, &root_key, 0, &epoch_key, &[(root_leaf, enc.public)])
            .await
            .unwrap();

        let keys = unseal_epoch_keys(&db, &root_leaf, &enc).await.unwrap();
        assert_eq!(keys.current(), Some((0, epoch_key)));

        write_record(
            &db,
            &root_key,
            &keys,
            &plain_register("config", "theme", "hotdog"),
        )
        .await
        .unwrap();
        write_record(
            &db,
            &root_key,
            &keys,
            &plain_register("config", "theme", "plain"),
        )
        .await
        .unwrap();

        let view = materialize(&db, &keys).await.unwrap();
        let regs = view.registers_in("config");
        assert_eq!(regs.len(), 1);
        assert_eq!(regs[0].value, "plain", "later write wins");
        assert_eq!(view.undecryptable, 0);
    }

    #[tokio::test]
    async fn sets_add_remove_readd() {
        let db = test_db().await;
        let key = signer(2);
        let leaf = key.verifying_key().to_bytes();
        let enc = EncKeyPair::generate();
        mint_epoch(&db, &key, 0, &fresh_epoch_key(), &[(leaf, enc.public)])
            .await
            .unwrap();
        let keys = unseal_epoch_keys(&db, &leaf, &enc).await.unwrap();

        let add = |k: &str| PrivatePlain {
            kind: PrivateKind::SetAdd,
            collection: "follows".into(),
            key: k.into(),
            value: None,
        };
        let remove = |k: &str| PrivatePlain {
            kind: PrivateKind::SetRemove,
            collection: "follows".into(),
            key: k.into(),
            value: None,
        };

        write_record(&db, &key, &keys, &add("alice")).await.unwrap();
        write_record(&db, &key, &keys, &add("bob")).await.unwrap();
        write_record(&db, &key, &keys, &remove("alice"))
            .await
            .unwrap();
        write_record(&db, &key, &keys, &add("alice")).await.unwrap();

        let view = materialize(&db, &keys).await.unwrap();
        let elements: Vec<String> = view
            .set_elements("follows")
            .into_iter()
            .map(|e| e.element)
            .collect();
        assert_eq!(elements, vec!["alice", "bob"], "re-add after remove sticks");
    }

    #[tokio::test]
    async fn a_non_recipient_reads_its_era_and_nothing_after() {
        // The revocation story in miniature: two members at epoch 0; epoch 1 excludes B. B keeps
        // reading epoch-0 records forever and sees only ciphertext counts afterward.
        let db = test_db().await;
        let a_key = signer(3);
        let a_leaf = a_key.verifying_key().to_bytes();
        let a_enc = EncKeyPair::generate();
        let b_enc = EncKeyPair::generate();
        let b_leaf = signer(4).verifying_key().to_bytes();

        let k0 = fresh_epoch_key();
        mint_epoch(
            &db,
            &a_key,
            0,
            &k0,
            &[(a_leaf, a_enc.public), (b_leaf, b_enc.public)],
        )
        .await
        .unwrap();
        let a_keys = unseal_epoch_keys(&db, &a_leaf, &a_enc).await.unwrap();
        write_record(
            &db,
            &a_key,
            &a_keys,
            &plain_register("contacts", "dave", "Dave"),
        )
        .await
        .unwrap();

        // Rotation: epoch 1, B excluded.
        mint_epoch(
            &db,
            &a_key,
            1,
            &fresh_epoch_key(),
            &[(a_leaf, a_enc.public)],
        )
        .await
        .unwrap();
        let a_keys = unseal_epoch_keys(&db, &a_leaf, &a_enc).await.unwrap();
        assert_eq!(a_keys.current().unwrap().0, 1);
        write_record(
            &db,
            &a_key,
            &a_keys,
            &plain_register("contacts", "eve", "Eve"),
        )
        .await
        .unwrap();

        // A (still a member) sees everything.
        let a_view = materialize(&db, &a_keys).await.unwrap();
        assert_eq!(a_view.registers_in("contacts").len(), 2);

        // B holds only epoch 0: the pre-rotation record opens, the post-rotation one does not.
        let b_keys = unseal_epoch_keys(&db, &b_leaf, &b_enc).await.unwrap();
        assert_eq!(b_keys.current().unwrap().0, 0);
        let b_view = materialize(&db, &b_keys).await.unwrap();
        let names: Vec<String> = b_view
            .registers_in("contacts")
            .into_iter()
            .map(|r| r.key)
            .collect();
        assert_eq!(names, vec!["dave"]);
        assert_eq!(b_view.undecryptable, 1);
    }

    #[tokio::test]
    async fn reseal_gives_a_newcomer_the_full_history() {
        let db = test_db().await;
        let a_key = signer(5);
        let a_leaf = a_key.verifying_key().to_bytes();
        let a_enc = EncKeyPair::generate();

        // Two epochs of history before the newcomer exists.
        mint_epoch(
            &db,
            &a_key,
            0,
            &fresh_epoch_key(),
            &[(a_leaf, a_enc.public)],
        )
        .await
        .unwrap();
        let keys = unseal_epoch_keys(&db, &a_leaf, &a_enc).await.unwrap();
        write_record(&db, &a_key, &keys, &plain_register("config", "old", "era0"))
            .await
            .unwrap();
        mint_epoch(
            &db,
            &a_key,
            1,
            &fresh_epoch_key(),
            &[(a_leaf, a_enc.public)],
        )
        .await
        .unwrap();
        let keys = unseal_epoch_keys(&db, &a_leaf, &a_enc).await.unwrap();
        write_record(&db, &a_key, &keys, &plain_register("config", "new", "era1"))
            .await
            .unwrap();

        let n_enc = EncKeyPair::generate();
        let n_leaf = signer(6).verifying_key().to_bytes();
        let resealed = reseal_epochs_to(&db, &a_key, &n_leaf, &n_enc.public, &keys)
            .await
            .unwrap();
        assert_eq!(resealed, 2);

        let n_keys = unseal_epoch_keys(&db, &n_leaf, &n_enc).await.unwrap();
        let n_view = materialize(&db, &n_keys).await.unwrap();
        assert_eq!(n_view.registers_in("config").len(), 2);
        assert_eq!(n_view.undecryptable, 0);
    }

    #[test]
    fn tampered_ciphertext_fails_closed() {
        let epoch_key = fresh_epoch_key();
        let mut record = encrypt_record(0, &epoch_key, &plain_register("c", "k", "v")).unwrap();
        let mut keys = EpochKeys::default();
        keys.insert(0, epoch_key);

        assert!(decrypt_record(&record, &keys).is_some());
        let last = record.ciphertext.len() - 1;
        record.ciphertext[last] ^= 0xff;
        assert!(decrypt_record(&record, &keys).is_none());
    }
}
