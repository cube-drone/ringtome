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
//! Views persist now (PROJECT_PLAN, The Substrate: "Views persist now"): the decrypted state
//! folds into ordinary tables (`private_registers`, `private_set_elements`) in the per-user
//! database, which is itself encrypted at rest - so a persisted view is no longer a second
//! secret. Folding is **catch-up-on-read**, not fold-on-ingest: decrypting takes epoch keys,
//! which the read paths hold and sync ingest deliberately does not. Each `materialize`
//! fast-forwards from a per-`(author, service)` watermark (`view_watermarks`), folds what it
//! can open with statement-atomic stamp-compare upserts (the `apply_profile_set` discipline, so
//! concurrent catch-ups are benign), and advances the watermark. **The stall rule**: a
//! watermark never advances past an entry this key-set cannot decrypt - an epoch key may still
//! arrive via adoption resealing, so every later read retries from the stall. Entries past the
//! stall are still folded when they open (idempotent, just re-attempted per read), which keeps
//! the old decrypt-everything semantics exact for mixed-era readers.

use std::collections::BTreeMap;

use crate::db::Db;
use anyhow::{anyhow, Context, Result};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use ringtome_proto::registry::{entry_type, service};
use ringtome_proto::{
    Authorize, Crown, KeyEpoch, Payload, PrivateKind, PrivatePlain, PrivateRecord, SignedEntry,
    SigningKey,
};

use crate::error::AppError;
use crate::keystore::Keystore;
use crate::seal::{self, EncKeyPair};

/// AAD binding record ciphertext to its purpose; the signed envelope already binds authorship
/// and chain position.
const RECORD_AAD: &[u8] = b"ringtome-v0/private-record";

/// AAD for file-body blobs (the file layer). A distinct domain from records so the two AEAD
/// contexts can never be confused for one another.
const FILE_AAD: &[u8] = b"ringtome-v0/file";

/// AAD for doc-header entries (versioned documents). Same envelope as private records, its own
/// domain.
const DOC_AAD: &[u8] = b"ringtome-v0/doc-header";

/// AAD for private records on the doc-meta chain (annotations, tags). Domain separation from
/// general-private is mandatory mechanics, not hygiene (PROJECT_PLAN, Annotations): the two
/// chains share an entry type, a codec, and their epoch keys, so the AAD is the only thing
/// refusing a ciphertext transplanted from one chain to the other.
const DOC_META_AAD: &[u8] = b"ringtome-v0/doc-meta-record";

/// AAD for transcribed inbox notices. One domain for both tiers on purpose: the tier is a
/// property of which CHAIN a notice sits on (retention and sync depth), never of the
/// ciphertext, and a notice promoted between tiers would otherwise have to be re-encrypted to
/// move. Distinct from every other domain, so a notice ciphertext cannot be transplanted onto
/// a contact register's chain or the reverse.
const NOTICE_AAD: &[u8] = b"ringtome-v0/inbox-notice";

/// The AAD for one service's private-record ciphertexts. Unknown service = error: a service
/// earns private records by being named here, never by default.
fn aad_for_service(service_id: u32) -> Result<&'static [u8], AppError> {
    match service_id {
        service::GENERAL_PRIVATE => Ok(RECORD_AAD),
        service::DOC_META_PRIVATE => Ok(DOC_META_AAD),
        _ => Err(AppError::Internal(anyhow!(
            "service {service_id} carries no private records"
        ))),
    }
}


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

    /// A one-entry ring - the per-post sealing key's shape (PROJECT_PLAN's Post visibility slice 2b), and
    /// what tests hand to `decrypt_file`.
    pub(crate) fn single(epoch: u64, key: [u8; 32]) -> Self {
        let mut keys = std::collections::BTreeMap::new();
        keys.insert(epoch, vec![key]);
        Self { keys }
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
async fn load_epoch_entries(db: &Db) -> Result<Vec<KeyEpoch>, AppError> {
    let entries =
        crate::record::imaol::entries_of_type(db, service::IDENTITY_PUBLIC, entry_type::KEY_EPOCH)
            .await?;
    let mut out = Vec::with_capacity(entries.len());
    for signed in entries {
        let Payload::Inline(payload) = &signed.entry().payload else {
            continue;
        };
        match KeyEpoch::decode(payload) {
            Ok(key_epoch) => out.push(key_epoch),
            // An undecodable payload from a member is that member's bug; it cannot be allowed to
            // wedge everyone's private store.
            Err(e) => tracing::warn!("skipping undecodable key-epoch payload: {e}"),
        }
    }
    Ok(out)
}

/// Walk the chain's `key-epoch` entries and unseal every box addressed to our leaf.
pub async fn unseal_epoch_keys(
    db: &Db,
    our_leaf: &[u8; 32],
    our_enc: &EncKeyPair,
) -> Result<EpochKeys, AppError> {
    let mut keys = EpochKeys::default();
    for key_epoch in load_epoch_entries(db).await? {
        for (leaf, _enc_pub, sealed) in &key_epoch.recipients {
            if leaf != our_leaf {
                continue;
            }
            match seal::unseal(sealed, our_enc) {
                Some(plain) => match <[u8; 32]>::try_from(plain.as_slice()) {
                    Ok(key) => keys.insert(key_epoch.epoch, key),
                    Err(_) => tracing::warn!(epoch = key_epoch.epoch, "epoch box held a non-key"),
                },
                // Sealed to our leaf id but not our enc key: stale roster data. Fail closed.
                None => tracing::warn!(
                    epoch = key_epoch.epoch,
                    "epoch box addressed to us won't open"
                ),
            }
        }
    }
    Ok(keys)
}

/// The highest epoch number anyone has published, openable by us or not - what a rotation must
/// step past.
pub async fn max_epoch(db: &Db) -> Result<Option<u64>, AppError> {
    Ok(load_epoch_entries(db)
        .await?
        .iter()
        .map(|key_epoch| key_epoch.epoch)
        .max())
}

/// Every member encryption pubkey learnable from the chain: authorize stamps (field 2) plus the
/// recipient lists of past epochs. This is how a rotator seals to members it never met.
pub async fn enc_roster(db: &Db) -> Result<BTreeMap<[u8; 32], [u8; 32]>, AppError> {
    let mut roster = BTreeMap::new();

    let authorizes =
        crate::record::imaol::entries_of_type(db, service::IDENTITY_PUBLIC, entry_type::AUTHORIZE)
            .await?;
    for signed in authorizes {
        let Payload::Inline(payload) = &signed.entry().payload else {
            continue;
        };
        if let Ok(authorization) = Authorize::decode(payload) {
            if let Some(enc) = authorization.enc_pubkey {
                roster.insert(authorization.child, enc);
            }
        }
    }

    for key_epoch in load_epoch_entries(db).await? {
        for (leaf, enc_pub, _sealed) in &key_epoch.recipients {
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
    db: &Db,
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
    crate::record::imaol::append(
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
    db: &Db,
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
    db: &Db,
    signer: &SigningKey,
    tree: &Crown,
    exclude: &[u8; 32],
) -> Result<SignedEntry, AppError> {
    use ringtome_proto::crown::KeyStatus;

    // The minter rule: you may not sign the epoch that excludes you - a key that mints an
    // epoch knows it, excluded or not, so the boundary it claims to draw is fiction. Callers
    // route self-retirement rotations to a surviving member; this guard keeps them honest.
    if signer.verifying_key().to_bytes() == *exclude {
        return Err(AppError::Internal(anyhow!(
            "minter rule: a key may not sign the epoch that excludes it"
        )));
    }

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

/// Encrypt one plaintext record under an epoch key, bound to `service_id`'s AAD domain.
pub fn encrypt_record(
    epoch: u64,
    epoch_key: &[u8; 32],
    service_id: u32,
    plain: &PrivatePlain,
) -> Result<PrivateRecord, AppError> {
    let aad = aad_for_service(service_id)?;
    let plaintext = plain
        .encode()
        .map_err(|e| AppError::BadRequest(crate::msg!("record.private.invalid-private-record-e", "invalid private record: {e}", e = e)))?;
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
                aad,
            },
        )
        .map_err(|e| AppError::Internal(anyhow!("encrypting private record: {e}")))?;
    Ok(PrivateRecord {
        epoch,
        nonce,
        ciphertext,
    })
}

/// The outcome of opening one encrypted record against a key-set. The persisted-view fold
/// needs a distinction a plain `Option` can't carry: `NoKey` stalls the fold watermark (an
/// epoch key may still arrive via adoption resealing - retry forever), while `Garbage`
/// (a key authenticated, but the plaintext doesn't decode) is skipped and passed - stored
/// bytes never improve.
pub(crate) enum Opened<T> {
    Plain(T),
    NoKey,
    Garbage,
}

/// Try every key of the record's epoch; on the one that authenticates, decode the plaintext.
fn open_with<T>(
    record: &PrivateRecord,
    keys: &EpochKeys,
    aad: &[u8],
    decode: impl Fn(&[u8]) -> Option<T>,
) -> Opened<T> {
    for key in keys.for_epoch(record.epoch) {
        if let Ok(plaintext) = cipher(key).decrypt(
            XNonce::from_slice(&record.nonce),
            chacha20poly1305::aead::Payload {
                msg: &record.ciphertext,
                aad,
            },
        ) {
            return match decode(&plaintext) {
                Some(plain) => Opened::Plain(plain),
                None => Opened::Garbage,
            };
        }
    }
    Opened::NoKey
}

/// Open one private record under the given service's AAD domain. `NoKey` is the normal state of
/// a revoked-then-rotated-away member looking at the future, or a newcomer not yet re-sealed
/// into the past - and also of a ciphertext offered under the wrong domain (the AEAD cannot
/// tell "no key" from "right key, wrong AAD"; both simply refuse).
pub(crate) fn open_record(
    record: &PrivateRecord,
    keys: &EpochKeys,
    aad: &[u8],
) -> Opened<PrivatePlain> {
    open_with(record, keys, aad, |p| PrivatePlain::decode(p).ok())
}

/// Encrypt one delivered envelope for transcription onto an inbox chain.
///
/// The plaintext is the sender's envelope bytes **verbatim** - not a re-encoding, not a
/// summary. That is the whole point of transcription: the recipient's other nodes decrypt
/// these bytes and run the same offline verification the transcribing node ran, so a notice is
/// believed because it checks out, never because one of your machines said so.
pub fn encrypt_notice(
    epoch: u64,
    epoch_key: &[u8; 32],
    envelope_bytes: &[u8],
) -> Result<PrivateRecord, AppError> {
    let mut nonce = [0u8; 24];
    {
        use rand::RngCore;
        rand::rngs::OsRng.fill_bytes(&mut nonce);
    }
    let ciphertext = cipher(epoch_key)
        .encrypt(
            XNonce::from_slice(&nonce),
            chacha20poly1305::aead::Payload {
                msg: envelope_bytes,
                aad: NOTICE_AAD,
            },
        )
        .map_err(|e| AppError::Internal(anyhow!("encrypting inbox notice: {e}")))?;
    Ok(PrivateRecord {
        epoch,
        nonce,
        ciphertext,
    })
}

/// Open one transcribed notice, yielding the sender's envelope bytes as they were delivered.
/// Structural decoding happens in the fold, which re-verifies rather than trusting.
pub(crate) fn open_notice(record: &PrivateRecord, keys: &EpochKeys) -> Opened<Vec<u8>> {
    open_with(record, keys, NOTICE_AAD, |p| Some(p.to_vec()))
}

/// Open one doc header (its own AAD domain - see [`encrypt_doc_header`]).
pub(crate) fn open_doc_header(
    record: &PrivateRecord,
    keys: &EpochKeys,
) -> Opened<ringtome_proto::DocHeaderPlain> {
    open_with(record, keys, DOC_AAD, |p| {
        ringtome_proto::DocHeaderPlain::decode(p).ok()
    })
}

/// Decrypt a record with whichever key of its epoch authenticates; `None` on no working key
/// (or an undecodable plaintext). Production reads go through [`open_record`], which keeps the
/// distinction; this collapse survives for the crypto round-trip tests.
#[cfg(test)]
pub(crate) fn decrypt_record(
    record: &PrivateRecord,
    keys: &EpochKeys,
    aad: &[u8],
) -> Option<PrivatePlain> {
    match open_record(record, keys, aad) {
        Opened::Plain(plain) => Some(plain),
        Opened::NoKey | Opened::Garbage => None,
    }
}

/// Encrypt one doc header under an epoch key, into the same `{epoch, nonce, ciphertext}`
/// envelope private records use (its own AAD domain keeps the two apart).
pub fn encrypt_doc_header(
    epoch: u64,
    epoch_key: &[u8; 32],
    plain: &ringtome_proto::DocHeaderPlain,
) -> Result<PrivateRecord, AppError> {
    let plaintext = plain
        .encode()
        .map_err(|e| AppError::BadRequest(crate::msg!("record.private.invalid-doc-header-e", "invalid doc header: {e}", e = e)))?;
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
                aad: DOC_AAD,
            },
        )
        .map_err(|e| AppError::Internal(anyhow!("encrypting doc header: {e}")))?;
    Ok(PrivateRecord {
        epoch,
        nonce,
        ciphertext,
    })
}

// ---------------------------------------------------------------------------------------------
// File-body encryption (the file layer).
//
// A file body is encrypted into a **self-describing blob**: `epoch (8 bytes, big-endian) ||
// nonce (24) || ciphertext`. The epoch rides in the clear - epoch numbers are already public on
// the identity-public chain - so a reader knows which keys to try without a side table. The
// random nonce is what makes the blob's content-hash unforgeable and unlinkable: no one can
// precompute a target file's hash or reverse a hash to known content, so iroh-blobs may serve it
// ungated (NOTES_APP, The file layer). No size cap - file bodies are not register-sized facts.

/// Encrypt a file body under a specific epoch key into a self-describing blob.
pub fn encrypt_file(
    epoch: u64,
    epoch_key: &[u8; 32],
    plaintext: &[u8],
) -> Result<Vec<u8>, AppError> {
    let mut nonce = [0u8; 24];
    {
        use rand::RngCore;
        rand::rngs::OsRng.fill_bytes(&mut nonce);
    }
    let ciphertext = cipher(epoch_key)
        .encrypt(
            XNonce::from_slice(&nonce),
            chacha20poly1305::aead::Payload {
                msg: plaintext,
                aad: FILE_AAD,
            },
        )
        .map_err(|e| AppError::Internal(anyhow!("encrypting file: {e}")))?;
    let mut blob = Vec::with_capacity(8 + 24 + ciphertext.len());
    blob.extend_from_slice(&epoch.to_be_bytes());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ciphertext);
    Ok(blob)
}

/// Decrypt a self-describing file blob with whichever key of its epoch authenticates. `None`
/// means the blob is malformed, or we hold no working key for its epoch (a revoked-then-rotated
/// member, or a newcomer not yet re-sealed into that era).
pub fn decrypt_file(blob: &[u8], keys: &EpochKeys) -> Option<Vec<u8>> {
    if blob.len() < 8 + 24 {
        return None;
    }
    let epoch = u64::from_be_bytes(blob[0..8].try_into().ok()?);
    let nonce = &blob[8..32];
    let ciphertext = &blob[32..];
    for key in keys.for_epoch(epoch) {
        if let Ok(plaintext) = cipher(key).decrypt(
            XNonce::from_slice(nonce),
            chacha20poly1305::aead::Payload {
                msg: ciphertext,
                aad: FILE_AAD,
            },
        ) {
            return Some(plaintext);
        }
    }
    None
}

/// The sentinel epoch for per-post keys (PROJECT_PLAN's Post visibility slice 2b): a trusted-only post's
/// body is sealed under its own random key, not an era's - the blob's self-describing
/// epoch field carries this value so no reader ever tries their epoch ring on it.
pub const POST_KEY_EPOCH: u64 = u64::MAX;

/// Seal a trusted-only post body under its per-post key. Same blob shape as every
/// encrypted file - `epoch || nonce || ciphertext` - so the store, the caps, and the blob
/// lane treat it as any other bytes.
pub fn seal_post_body(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, AppError> {
    encrypt_file(POST_KEY_EPOCH, key, plaintext)
}

/// Open a sealed post body with its per-post key. `None` = malformed, wrong key, or not a
/// post-sealed blob at all. A one-entry ring at the sentinel epoch, so `decrypt_file`'s own
/// parsing and epoch dispatch do all the work - the private lane's decryption, not a copy
/// of it (Curtis's overlap check, 2026-09-01).
pub fn open_post_body(blob: &[u8], key: &[u8; 32]) -> Option<Vec<u8>> {
    decrypt_file(blob, &EpochKeys::single(POST_KEY_EPOCH, *key))
}

/// Append one private record under the current epoch, onto `service_id`'s chain (general-private
/// and doc-meta share this one append path; the service picks the chain and its AAD domain).
pub async fn write_record(
    db: &Db,
    signer: &SigningKey,
    keys: &EpochKeys,
    service_id: u32,
    plain: &PrivatePlain,
) -> Result<SignedEntry, AppError> {
    let (epoch, key) = keys.current().ok_or_else(|| {
        AppError::Internal(anyhow!("this node holds no epoch key for the identity"))
    })?;
    let record = encrypt_record(epoch, &key, service_id, plain)?;
    let payload = record
        .encode()
        .map_err(|e| AppError::Internal(anyhow!("encoding private record: {e}")))?;
    crate::record::imaol::append(
        db,
        signer,
        service_id,
        entry_type::PRIVATE_RECORD,
        Payload::Inline(payload),
    )
    .await
}

// ---------------------------------------------------------------------------------------------
// The persisted view (the fold rules live in the module doc above)

/// LWW stamp, same total order the profile view uses - defined once in `imaol`, which owns
/// The Ordering Contract.
use crate::record::imaol::Stamp;

#[derive(Debug, Clone, serde::Serialize)]
pub struct RegisterValue {
    pub key: String,
    pub value: String,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SetElement {
    pub element: String,
    pub value: Option<String>,
    pub updated_at_ms: i64,
}

/// The materialized private state: LWW registers and LWW-element-sets, folded from every record
/// this node can decrypt.
#[derive(Debug, Default)]
pub struct PrivateView {
    registers: BTreeMap<(String, String), (String, Stamp)>,
    /// `(present, value, stamp)` per element - LWW-element-set semantics.
    sets: BTreeMap<(String, String), (bool, Option<String>, Stamp)>,
    /// Records we hold but cannot open (epochs from outside our membership era). Production
    /// callers read this count from the per-collection readers' tuples (`catch_up`'s return);
    /// on the view it remains the fold tests' window into the stall rule.
    #[cfg_attr(not(test), allow(dead_code))]
    pub undecryptable: u64,
}

impl PrivateView {
    /// Readers walk their collection as a contiguous `range` of the `(collection, key)` map,
    /// never a filter over the whole of it: a filter is O(everything) per call, and
    /// `Store::contacts` calls a reader once per contact collection - at large follow counts
    /// the full-map scan made that quadratic.
    pub fn registers_in(&self, collection: &str) -> Vec<RegisterValue> {
        self.registers
            .range((collection.to_string(), String::new())..)
            .take_while(|((c, _), _)| c == collection)
            .map(|((_, k), (v, stamp))| RegisterValue {
                key: k.clone(),
                value: v.clone(),
                updated_at_ms: stamp.0,
            })
            .collect()
    }

    pub fn set_elements(&self, collection: &str) -> Vec<SetElement> {
        self.sets
            .range((collection.to_string(), String::new())..)
            .take_while(|((c, _), _)| c == collection)
            .filter(|(_, (present, _, _))| *present)
            .map(|((_, e), (_, value, stamp))| SetElement {
                element: e.clone(),
                value: value.clone(),
                updated_at_ms: stamp.0,
            })
            .collect()
    }

    /// Set elements in LWW-stamp order - i.e. INSERTION order: the same total order the CRDT
    /// resolves conflicts by, `(timestamp_ms, seq, hash)`. `set_elements` returns element-key
    /// (alphabetical) order; this returns the order the elements were actually added, so a
    /// same-millisecond burst still orders by chain position (seq) rather than a string tiebreak.
    pub fn set_elements_ordered(&self, collection: &str) -> Vec<SetElement> {
        let mut items: Vec<(&Stamp, SetElement)> = self
            .sets
            .range((collection.to_string(), String::new())..)
            .take_while(|((c, _), _)| c == collection)
            .filter(|(_, (present, _, _))| *present)
            .map(|((_, e), (_, value, stamp))| {
                (
                    stamp,
                    SetElement {
                        element: e.clone(),
                        value: value.clone(),
                        updated_at_ms: stamp.0,
                    },
                )
            })
            .collect();
        items.sort_by_key(|(stamp, _)| *stamp);
        items.into_iter().map(|(_, e)| e).collect()
    }

    /// Every collection name this view holds anything under (registers or present set
    /// elements) - the enumeration the per-doc readers above deliberately don't need, for
    /// callers that sweep a whole service (the search index gathering annotation text).
    pub fn collections(&self) -> std::collections::BTreeSet<&str> {
        self.registers
            .keys()
            .map(|(c, _)| c.as_str())
            .chain(
                self.sets
                    .iter()
                    .filter(|(_, (present, _, _))| *present)
                    .map(|((c, _), _)| c.as_str()),
            )
            .collect()
    }
}

/// Fold one decrypted record into the persisted tables. The LWW judgment is the statement's
/// WHERE clause - the same statement-atomic stamp-compare upsert as `imaol::apply_profile_set`,
/// so a rebuild replaying old entries can race a live catch-up and the row stays monotone in
/// the stamp tuple regardless of interleaving.
async fn fold_record(
    db: &Db,
    service_id: u32,
    signed: &SignedEntry,
    plain: PrivatePlain,
) -> Result<(), AppError> {
    // The arms await individually: each generic `execute` call is its own future type.
    let folded = match plain.kind {
        PrivateKind::Register => {
            db.execute(
                "INSERT INTO private_registers
               (service, collection, key, value, timestamp_ms, seq, entry_hash)
             VALUES (:service, :collection, :key, :value, :timestamp_ms, :seq, :entry_hash)
             ON CONFLICT(service, collection, key) DO UPDATE SET
               value = excluded.value,
               timestamp_ms = excluded.timestamp_ms,
               seq = excluded.seq,
               entry_hash = excluded.entry_hash
             WHERE (excluded.timestamp_ms, excluded.seq, excluded.entry_hash)
                 > (private_registers.timestamp_ms, private_registers.seq,
                    private_registers.entry_hash)",
                turso::named_params! {
                    ":service": i64::from(service_id),
                    ":collection": plain.collection,
                    ":key": plain.key,
                    // BLOB column: bind bytes, not Text
                    ":value": plain.value.map(String::into_bytes),
                    ":timestamp_ms": signed.entry().timestamp_ms,
                    ":seq": signed.entry().seq as i64,
                    ":entry_hash": signed.hash().as_slice(),
                },
            )
            .await
        }
        PrivateKind::SetAdd | PrivateKind::SetRemove => {
            db.execute(
                "INSERT INTO private_set_elements
               (service, collection, element, present, value, timestamp_ms, seq, entry_hash)
             VALUES (:service, :collection, :element, :present, :value, :timestamp_ms, :seq,
                     :entry_hash)
             ON CONFLICT(service, collection, element) DO UPDATE SET
               present = excluded.present,
               value = excluded.value,
               timestamp_ms = excluded.timestamp_ms,
               seq = excluded.seq,
               entry_hash = excluded.entry_hash
             WHERE (excluded.timestamp_ms, excluded.seq, excluded.entry_hash)
                 > (private_set_elements.timestamp_ms, private_set_elements.seq,
                    private_set_elements.entry_hash)",
                turso::named_params! {
                    ":service": i64::from(service_id),
                    ":collection": plain.collection,
                    ":element": plain.key,
                    ":present": i64::from(plain.kind == PrivateKind::SetAdd),
                    // BLOB column: bind bytes, not Text
                    ":value": plain.value.map(String::into_bytes),
                    ":timestamp_ms": signed.entry().timestamp_ms,
                    ":seq": signed.entry().seq as i64,
                    ":entry_hash": signed.hash().as_slice(),
                },
            )
            .await
        }
    };
    folded
        .context("folding private record into view")
        .map_err(AppError::Internal)?;
    Ok(())
}

/// Catch the persisted tables up to one service's chains: fetch entries past each chain's
/// watermark, open + fold each, advance watermarks (stall rule in the module doc). Returns how
/// many fetched records this key-set could not open - which, because a watermark never passes
/// an unopenable record, equals the count across the whole stored log.
async fn catch_up(db: &Db, keys: &EpochKeys, service_id: u32) -> Result<u64, AppError> {
    let aad = aad_for_service(service_id)?;
    let entries =
        crate::record::imaol::entries_past_watermarks(db, service_id, entry_type::PRIVATE_RECORD)
            .await?;

    let mut by_author: BTreeMap<String, Vec<SignedEntry>> = BTreeMap::new();
    for signed in entries {
        by_author
            .entry(hex::encode(signed.entry().chain.author))
            .or_default()
            .push(signed);
    }

    let mut undecryptable = 0u64;
    for (author_hex, chain) in by_author {
        let mut advance_to: Option<u64> = None;
        let mut stalled = false;
        for signed in chain {
            let seq = signed.entry().seq;
            let record = match &signed.entry().payload {
                Payload::Inline(payload) => match PrivateRecord::decode(payload) {
                    Ok(record) => Some(record),
                    Err(_) => {
                        tracing::warn!(seq, "skipping undecodable private-record payload");
                        None
                    }
                },
                _ => None,
            };
            let opened = match record {
                Some(record) => open_record(&record, keys, aad),
                None => Opened::Garbage, // wrong shape from a buggy writer: never improves
            };
            match opened {
                Opened::Plain(plain) => {
                    fold_record(db, service_id, &signed, plain).await?;
                    if !stalled {
                        advance_to = Some(seq);
                    }
                }
                Opened::Garbage => {
                    if !stalled {
                        advance_to = Some(seq);
                    }
                }
                Opened::NoKey => {
                    undecryptable += 1;
                    if !stalled {
                        stalled = true;
                        tracing::warn!(
                            author = %author_hex,
                            seq,
                            "private fold stalled: no key for this entry's epoch; \
                             will retry (adoption resealing may deliver it)"
                        );
                    }
                }
            }
        }
        if let Some(folded_seq) = advance_to {
            crate::record::imaol::advance_watermark(db, &author_hex, service_id, folded_seq)
                .await?;
        }
    }
    Ok(undecryptable)
}

/// The drop half of rebuild (`imaol::rebuild_views`): wipe the persisted private tables; the
/// next keyed materialize refolds them from the log.
pub(crate) async fn clear_view(db: &Db) -> Result<(), AppError> {
    for sql in [
        "DELETE FROM private_registers",
        "DELETE FROM private_set_elements",
    ] {
        db.execute(sql, ())
            .await
            .context("clearing private view tables")
            .map_err(AppError::Internal)?;
    }
    Ok(())
}

/// Register row shape, in SELECT order: collection, key, value, timestamp_ms, seq, entry_hash.
type RegisterRow = (String, String, Option<Vec<u8>>, i64, i64, Vec<u8>);
/// Set-element row shape: collection, element, present, value, timestamp_ms, seq, entry_hash.
type SetElementRow = (String, String, i64, Option<Vec<u8>>, i64, i64, Vec<u8>);

/// One private-record service's view: catch the persisted tables up to that service's chains
/// (with its AAD domain), then read its rows back. General-private and doc-meta are the same
/// machinery pointed at different chains; the watermark table is keyed `(author, service)`, so
/// their folds never see each other.
pub async fn materialize_service(
    db: &Db,
    keys: &EpochKeys,
    service_id: u32,
) -> Result<PrivateView, AppError> {
    let undecryptable = catch_up(db, keys, service_id).await?;
    let mut view = PrivateView {
        undecryptable,
        ..Default::default()
    };

    fn stamp(timestamp_ms: i64, seq: i64, hash: Vec<u8>) -> Result<Stamp, AppError> {
        let hash: [u8; 32] = hash
            .try_into()
            .map_err(|_| AppError::Internal(anyhow!("corrupt entry_hash in private view row")))?;
        Ok((timestamp_ms, seq as u64, hash))
    }
    let utf8 = |v: Vec<u8>| String::from_utf8_lossy(&v).into_owned();

    let registers: Vec<RegisterRow> = db
        .fetch_all(
            "SELECT collection, key, value, timestamp_ms, seq, entry_hash
             FROM private_registers WHERE service = ?1",
            (i64::from(service_id),),
        )
        .await
        .context("reading private registers")
        .map_err(AppError::Internal)?;
    for (collection, key, value, timestamp_ms, seq, hash) in registers {
        view.registers.insert(
            (collection, key),
            (
                value.map(utf8).unwrap_or_default(),
                stamp(timestamp_ms, seq, hash)?,
            ),
        );
    }

    let elements: Vec<SetElementRow> = db
        .fetch_all(
            "SELECT collection, element, present, value, timestamp_ms, seq, entry_hash
             FROM private_set_elements WHERE service = ?1",
            (i64::from(service_id),),
        )
        .await
        .context("reading private set elements")
        .map_err(AppError::Internal)?;
    for (collection, element, present, value, timestamp_ms, seq, hash) in elements {
        view.sets.insert(
            (collection, element),
            (
                present != 0,
                value.map(utf8),
                stamp(timestamp_ms, seq, hash)?,
            ),
        );
    }
    Ok(view)
}

/// The inverted set-element read: every collection on one service whose LWW-element-set
/// currently contains `element`, after catching that service's fold up. Both read directions -
/// "this collection's elements" and "the collections holding this element" - are indexes over
/// the same materialized table; neither is privileged (PROJECT_PLAN, Annotations: which is how
/// "all of D's tags" vs "all docs tagged X" turned out to be a false choice).
pub async fn collections_with_element(
    db: &Db,
    keys: &EpochKeys,
    service_id: u32,
    element: &str,
) -> Result<Vec<String>, AppError> {
    catch_up(db, keys, service_id).await?;
    let rows: Vec<(String,)> = db
        .fetch_all(
            "SELECT collection FROM private_set_elements
             WHERE service = ?1 AND element = ?2 AND present = 1
             ORDER BY collection",
            (i64::from(service_id), element),
        )
        .await
        .context("reading collections holding a set element")
        .map_err(AppError::Internal)?;
    Ok(rows.into_iter().map(|(collection,)| collection).collect())
}

// The per-collection readers: catch up, then SEEK. `(service, collection, key)` is the primary
// key of both persisted tables, so each of these reads rows proportional to its ANSWER, never
// to the size of the store. This is the hot-path door; `materialize_service`'s whole-view load
// remains for callers that genuinely sweep every collection (the search indexer, the mirror's
// bulk annotation read, the taxonomy graph walks). Field-found 2026-08-07: every private read
// was loading the entire folded store into a fresh BTreeMap to answer one collection's
// question - a cost that grows with the lifetime of the account (feed_seen marks, per-doc
// annotations), not just its relationships.

/// One collection's registers (key order), plus the undecryptable count (see `catch_up`).
/// Cleared registers (absent value) appear with an empty value, same as the view readers.
pub async fn collection_registers(
    db: &Db,
    keys: &EpochKeys,
    service_id: u32,
    collection: &str,
) -> Result<(Vec<RegisterValue>, u64), AppError> {
    let undecryptable = catch_up(db, keys, service_id).await?;
    let rows: Vec<(String, Option<Vec<u8>>, i64)> = db
        .fetch_all(
            "SELECT key, value, timestamp_ms FROM private_registers
             WHERE service = ?1 AND collection = ?2 ORDER BY key",
            (i64::from(service_id), collection),
        )
        .await
        .context("reading one collection's registers")
        .map_err(AppError::Internal)?;
    Ok((
        rows.into_iter()
            .map(|(key, value, timestamp_ms)| RegisterValue {
                key,
                value: value
                    .map(|v| String::from_utf8_lossy(&v).into_owned())
                    .unwrap_or_default(),
                updated_at_ms: timestamp_ms,
            })
            .collect(),
        undecryptable,
    ))
}

/// One collection's present set elements (element order), plus the undecryptable count.
pub async fn collection_set_elements(
    db: &Db,
    keys: &EpochKeys,
    service_id: u32,
    collection: &str,
) -> Result<(Vec<SetElement>, u64), AppError> {
    let undecryptable = catch_up(db, keys, service_id).await?;
    Ok((
        set_element_rows(db, service_id, collection, "ORDER BY element").await?,
        undecryptable,
    ))
}

/// One collection's present set elements in LWW-stamp (insertion) order - the SQL twin of
/// `PrivateView::set_elements_ordered`, same `(timestamp_ms, seq, entry_hash)` total order.
pub async fn collection_set_elements_ordered(
    db: &Db,
    keys: &EpochKeys,
    service_id: u32,
    collection: &str,
) -> Result<Vec<SetElement>, AppError> {
    catch_up(db, keys, service_id).await?;
    set_element_rows(db, service_id, collection, "ORDER BY timestamp_ms, seq, entry_hash").await
}

/// Shared bottom of the two set readers; `order_by` is one of two fixed literals above, never
/// caller input.
async fn set_element_rows(
    db: &Db,
    service_id: u32,
    collection: &str,
    order_by: &str,
) -> Result<Vec<SetElement>, AppError> {
    let rows: Vec<(String, Option<Vec<u8>>, i64)> = db
        .fetch_all(
            &format!(
                "SELECT element, value, timestamp_ms FROM private_set_elements
                 WHERE service = ?1 AND collection = ?2 AND present = 1 {order_by}"
            ),
            (i64::from(service_id), collection),
        )
        .await
        .context("reading one collection's set elements")
        .map_err(AppError::Internal)?;
    Ok(rows
        .into_iter()
        .map(|(element, value, timestamp_ms)| SetElement {
            element,
            value: value.map(|v| String::from_utf8_lossy(&v).into_owned()),
            updated_at_ms: timestamp_ms,
        })
        .collect())
}

/// Registers across every collection sharing a prefix (`contact:` is the consumer), as
/// `(collection, register)` rows in collection-then-key order - one index range scan. The
/// bound arithmetic instead of LIKE is deliberate: LIKE is case-insensitive by default, so
/// the planner cannot drive it through the index, while `>= prefix AND < bumped-prefix` is a
/// straight primary-key range. ASCII prefixes only, by construction of the callers.
pub async fn prefixed_registers(
    db: &Db,
    keys: &EpochKeys,
    service_id: u32,
    prefix: &str,
) -> Result<Vec<(String, RegisterValue)>, AppError> {
    catch_up(db, keys, service_id).await?;
    let mut upper = prefix.as_bytes().to_vec();
    let last = upper.last_mut().expect("a collection prefix is never empty");
    *last += 1; // "contact:" -> "contact;" - sound because prefixes are ASCII punctuation-terminated
    let upper = String::from_utf8(upper)
        .context("bumping a collection prefix")
        .map_err(AppError::Internal)?;
    let rows: Vec<(String, String, Option<Vec<u8>>, i64)> = db
        .fetch_all(
            "SELECT collection, key, value, timestamp_ms FROM private_registers
             WHERE service = ?1 AND collection >= ?2 AND collection < ?3
             ORDER BY collection, key",
            (i64::from(service_id), prefix, upper.as_str()),
        )
        .await
        .context("reading a collection prefix's registers")
        .map_err(AppError::Internal)?;
    Ok(rows
        .into_iter()
        .map(|(collection, key, value, timestamp_ms)| {
            (
                collection,
                RegisterValue {
                    key,
                    value: value
                        .map(|v| String::from_utf8_lossy(&v).into_owned())
                        .unwrap_or_default(),
                    updated_at_ms: timestamp_ms,
                },
            )
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_db() -> Db {
        crate::db::test_user_db().await
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

    #[test]
    fn file_encrypt_decrypt_round_trip() {
        let epoch = 7u64;
        let key = [42u8; 32];
        let mut keys = EpochKeys::default();
        keys.insert(epoch, key);

        let plaintext = b"the quick brown note jumped over the lazy epoch".to_vec();
        let blob = encrypt_file(epoch, &key, &plaintext).unwrap();

        // self-describing: the epoch prefix rides in the clear
        assert_eq!(&blob[0..8], &epoch.to_be_bytes());

        // random nonce: the same plaintext encrypts differently every time (no dedup, no oracle)
        let blob2 = encrypt_file(epoch, &key, &plaintext).unwrap();
        assert_ne!(blob, blob2);

        // round-trips under the right epoch key
        assert_eq!(decrypt_file(&blob, &keys).unwrap(), plaintext);

        // wrong key for the epoch yields nothing
        let mut wrong = EpochKeys::default();
        wrong.insert(epoch, [1u8; 32]);
        assert!(decrypt_file(&blob, &wrong).is_none());

        // a malformed (too-short) blob is None, never a panic
        assert!(decrypt_file(&blob[..10], &keys).is_none());
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
            service::GENERAL_PRIVATE,
            &plain_register("config", "theme", "hotdog"),
        )
        .await
        .unwrap();
        write_record(
            &db,
            &root_key,
            &keys,
            service::GENERAL_PRIVATE,
            &plain_register("config", "theme", "plain"),
        )
        .await
        .unwrap();

        let view = materialize_service(&db, &keys, service::GENERAL_PRIVATE).await.unwrap();
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

        write_record(&db, &key, &keys, service::GENERAL_PRIVATE, &add("alice"))
            .await
            .unwrap();
        write_record(&db, &key, &keys, service::GENERAL_PRIVATE, &add("bob"))
            .await
            .unwrap();
        write_record(&db, &key, &keys, service::GENERAL_PRIVATE, &remove("alice"))
            .await
            .unwrap();
        write_record(&db, &key, &keys, service::GENERAL_PRIVATE, &add("alice"))
            .await
            .unwrap();

        let view = materialize_service(&db, &keys, service::GENERAL_PRIVATE).await.unwrap();
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
            service::GENERAL_PRIVATE,
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
            service::GENERAL_PRIVATE,
            &plain_register("contacts", "eve", "Eve"),
        )
        .await
        .unwrap();

        // A (still a member) sees everything.
        let a_view = materialize_service(&db, &a_keys, service::GENERAL_PRIVATE).await.unwrap();
        assert_eq!(a_view.registers_in("contacts").len(), 2);

        // B holds only epoch 0: the pre-rotation record opens, the post-rotation one does not.
        // B reads from its OWN replica of the same chains - in production every member's node
        // folds its own per-user DB with its own keys; two key-sets never share one folded view
        // (A's fold above already persisted everything A could open).
        let b_db = test_db().await;
        crate::record::imaol::clone_entries_for_test(&db, &b_db).await;
        let b_keys = unseal_epoch_keys(&b_db, &b_leaf, &b_enc).await.unwrap();
        assert_eq!(b_keys.current().unwrap().0, 0);
        let b_view = materialize_service(&b_db, &b_keys, service::GENERAL_PRIVATE).await.unwrap();
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
        write_record(
            &db,
            &a_key,
            &keys,
            service::GENERAL_PRIVATE,
            &plain_register("config", "old", "era0"),
        )
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
        write_record(
            &db,
            &a_key,
            &keys,
            service::GENERAL_PRIVATE,
            &plain_register("config", "new", "era1"),
        )
        .await
        .unwrap();

        let n_enc = EncKeyPair::generate();
        let n_leaf = signer(6).verifying_key().to_bytes();
        let resealed = reseal_epochs_to(&db, &a_key, &n_leaf, &n_enc.public, &keys)
            .await
            .unwrap();
        assert_eq!(resealed, 2);

        let n_keys = unseal_epoch_keys(&db, &n_leaf, &n_enc).await.unwrap();
        let n_view = materialize_service(&db, &n_keys, service::GENERAL_PRIVATE).await.unwrap();
        assert_eq!(n_view.registers_in("config").len(), 2);
        assert_eq!(n_view.undecryptable, 0);
    }

    /// Domain separation between the two private-record chains: the same epoch key, and the AAD
    /// alone refuses a ciphertext transplanted from one chain to the other. If this ever passes
    /// cross-domain, a member could replay a general-private fact as a doc-meta one (or vice
    /// versa) without holding anything it wasn't given.
    #[test]
    fn record_aads_are_domain_separated() {
        let epoch_key = fresh_epoch_key();
        let keys = EpochKeys::single(0, epoch_key);
        let plain = plain_register("c", "k", "v");

        let general = encrypt_record(0, &epoch_key, service::GENERAL_PRIVATE, &plain).unwrap();
        let doc_meta = encrypt_record(0, &epoch_key, service::DOC_META_PRIVATE, &plain).unwrap();

        // Each opens in its own domain...
        assert!(decrypt_record(&general, &keys, RECORD_AAD).is_some());
        assert!(decrypt_record(&doc_meta, &keys, DOC_META_AAD).is_some());
        // ...and refuses in the other, with the very key that encrypted it.
        assert!(decrypt_record(&general, &keys, DOC_META_AAD).is_none());
        assert!(decrypt_record(&doc_meta, &keys, RECORD_AAD).is_none());

        // A service without private records has no AAD at all - encrypting for it is an error,
        // not a default domain.
        assert!(encrypt_record(0, &epoch_key, service::POSTS, &plain).is_err());
    }

    #[test]
    fn tampered_ciphertext_fails_closed() {
        let epoch_key = fresh_epoch_key();
        let mut record = encrypt_record(
            0,
            &epoch_key,
            service::GENERAL_PRIVATE,
            &plain_register("c", "k", "v"),
        )
        .unwrap();
        let mut keys = EpochKeys::default();
        keys.insert(0, epoch_key);

        assert!(decrypt_record(&record, &keys, RECORD_AAD).is_some());
        let last = record.ciphertext.len() - 1;
        record.ciphertext[last] ^= 0xff;
        assert!(decrypt_record(&record, &keys, RECORD_AAD).is_none());
    }

    /// The watermark does its job: the first materialize folds and advances; a second call
    /// fetches nothing, refolds nothing, and the persisted rows are untouched. And a forced
    /// refold over already-populated tables (watermarks wiped, rows kept - the shape two
    /// concurrent catch-ups produce) changes nothing: the stamp-compare upsert is idempotent.
    #[tokio::test]
    async fn watermark_advances_and_refolds_are_idempotent() {
        let db = test_db().await;
        let key = signer(7);
        let author_hex = hex::encode(key.verifying_key().to_bytes());
        let keys = EpochKeys::single(0, [8u8; 32]);

        write_record(
            &db,
            &key,
            &keys,
            service::GENERAL_PRIVATE,
            &plain_register("config", "theme", "hotdog"),
        )
        .await
        .unwrap();
        write_record(
            &db,
            &key,
            &keys,
            service::GENERAL_PRIVATE,
            &plain_register("config", "theme", "plain"),
        )
        .await
        .unwrap();

        let view = materialize_service(&db, &keys, service::GENERAL_PRIVATE).await.unwrap();
        assert_eq!(view.registers_in("config")[0].value, "plain");
        assert_eq!(
            crate::record::imaol::view_watermark(&db, &author_hex, service::GENERAL_PRIVATE).await,
            Some(1),
            "both entries folded, watermark at the chain head"
        );

        type RegRow = (String, String, Option<Vec<u8>>, i64, i64, Vec<u8>);
        async fn rows(db: &Db) -> Vec<RegRow> {
            db.fetch_all(
                "SELECT collection, key, value, timestamp_ms, seq, entry_hash
                 FROM private_registers ORDER BY collection, key",
                (),
            )
            .await
            .unwrap()
        }
        let before = rows(&db).await;
        assert_eq!(before.len(), 1, "LWW: one row per register");

        // Second materialize: nothing new to fold, identical view and tables.
        let again = materialize_service(&db, &keys, service::GENERAL_PRIVATE).await.unwrap();
        assert_eq!(again.registers_in("config")[0].value, "plain");
        assert_eq!(rows(&db).await, before);
        assert_eq!(
            crate::record::imaol::view_watermark(&db, &author_hex, service::GENERAL_PRIVATE).await,
            Some(1)
        );

        // Forced double-fold: same entries over the same rows land identically.
        crate::record::imaol::reset_watermarks_for_test(&db).await;
        materialize_service(&db, &keys, service::GENERAL_PRIVATE).await.unwrap();
        assert_eq!(rows(&db).await, before);
    }

    /// The stall rule end to end: a record under an epoch this reader doesn't hold pins the
    /// watermark BEFORE it (later reads retry), while records past it that DO open stay
    /// visible; when the missing key arrives (adoption resealing), the fold completes.
    #[tokio::test]
    async fn watermark_stalls_on_undecryptable_and_recovers_when_the_key_arrives() {
        let db = test_db().await;
        let key = signer(9);
        let author_hex = hex::encode(key.verifying_key().to_bytes());
        let (k0, k1) = ([1u8; 32], [2u8; 32]);
        let era0 = EpochKeys::single(0, k0);
        let era1 = EpochKeys::single(1, k1);

        // seq 0 and 2 under epoch 0, seq 1 under epoch 1.
        write_record(
            &db,
            &key,
            &era0,
            service::GENERAL_PRIVATE,
            &plain_register("c", "before", "x"),
        )
        .await
        .unwrap();
        write_record(
            &db,
            &key,
            &era1,
            service::GENERAL_PRIVATE,
            &plain_register("c", "hidden", "y"),
        )
        .await
        .unwrap();
        write_record(
            &db,
            &key,
            &era0,
            service::GENERAL_PRIVATE,
            &plain_register("c", "after", "z"),
        )
        .await
        .unwrap();

        // A reader holding only epoch 0, twice (the second call is the retry).
        for _ in 0..2 {
            let view = materialize_service(&db, &era0, service::GENERAL_PRIVATE).await.unwrap();
            let names: Vec<String> = view.registers_in("c").into_iter().map(|r| r.key).collect();
            assert_eq!(
                names,
                vec!["after", "before"],
                "everything openable is visible, even past the stall"
            );
            assert_eq!(
                view.undecryptable, 1,
                "counted once per read, never inflated"
            );
            assert_eq!(
                crate::record::imaol::view_watermark(&db, &author_hex, service::GENERAL_PRIVATE)
                    .await,
                Some(0),
                "the watermark holds before the sealed entry"
            );
        }

        // The epoch-1 key arrives: the stalled entry folds and the watermark completes.
        let mut both = EpochKeys::single(0, k0);
        both.insert(1, k1);
        let view = materialize_service(&db, &both, service::GENERAL_PRIVATE).await.unwrap();
        assert_eq!(view.registers_in("c").len(), 3);
        assert_eq!(view.undecryptable, 0);
        assert_eq!(
            crate::record::imaol::view_watermark(&db, &author_hex, service::GENERAL_PRIVATE).await,
            Some(2)
        );
    }

    /// The per-collection door answers exactly what the whole view answers - registers, sets,
    /// insertion order, prefix sweep - and does it by SEEKING the primary key. The plan
    /// assertion is the proportionality tripwire: the moment someone rewrites one of these
    /// reads into a table scan, this goes red, whatever the collection count.
    #[tokio::test]
    async fn per_collection_readers_match_the_view_and_seek_the_index() {
        let db = test_db().await;
        let key = signer(9);
        let leaf = key.verifying_key().to_bytes();
        let enc = EncKeyPair::generate();
        mint_epoch(&db, &key, 0, &fresh_epoch_key(), &[(leaf, enc.public)])
            .await
            .unwrap();
        let keys = unseal_epoch_keys(&db, &leaf, &enc).await.unwrap();

        for (collection, k, v) in [
            ("contact:aa", "nickname", "greg"),
            ("contact:aa", "interest", "80"),
            ("contact:bb", "nickname", "dave"),
            ("config", "theme", "hotdog"),
        ] {
            write_record(
                &db,
                &key,
                &keys,
                service::GENERAL_PRIVATE,
                &plain_register(collection, k, v),
            )
            .await
            .unwrap();
        }
        // A set whose insertion order (zz then aa) differs from element order, plus a removal.
        for (kind, element) in [
            (PrivateKind::SetAdd, "zz"),
            (PrivateKind::SetAdd, "aa"),
            (PrivateKind::SetAdd, "dropped"),
            (PrivateKind::SetRemove, "dropped"),
        ] {
            write_record(
                &db,
                &key,
                &keys,
                service::GENERAL_PRIVATE,
                &PrivatePlain {
                    kind,
                    collection: "roster".into(),
                    key: element.into(),
                    value: None,
                },
            )
            .await
            .unwrap();
        }

        let view = materialize_service(&db, &keys, service::GENERAL_PRIVATE)
            .await
            .unwrap();
        let as_tuples =
            |rs: Vec<RegisterValue>| -> Vec<(String, String)> {
                rs.into_iter().map(|r| (r.key, r.value)).collect()
            };

        let (regs, undecryptable) =
            collection_registers(&db, &keys, service::GENERAL_PRIVATE, "config")
                .await
                .unwrap();
        assert_eq!(undecryptable, 0);
        assert_eq!(as_tuples(regs), as_tuples(view.registers_in("config")));

        let (elements, _) = collection_set_elements(&db, &keys, service::GENERAL_PRIVATE, "roster")
            .await
            .unwrap();
        let names: Vec<&str> = elements.iter().map(|e| e.element.as_str()).collect();
        assert_eq!(names, vec!["aa", "zz"], "element order, removals absent");

        let ordered =
            collection_set_elements_ordered(&db, &keys, service::GENERAL_PRIVATE, "roster")
                .await
                .unwrap();
        let ordered_names: Vec<&str> = ordered.iter().map(|e| e.element.as_str()).collect();
        let view_names: Vec<String> = view
            .set_elements_ordered("roster")
            .into_iter()
            .map(|e| e.element)
            .collect();
        assert_eq!(ordered_names, view_names, "same LWW-stamp insertion order");

        let contacts = prefixed_registers(&db, &keys, service::GENERAL_PRIVATE, "contact:")
            .await
            .unwrap();
        let rows: Vec<(String, String, String)> = contacts
            .into_iter()
            .map(|(c, r)| (c, r.key, r.value))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("contact:aa".into(), "interest".into(), "80".into()),
                ("contact:aa".into(), "nickname".into(), "greg".into()),
                ("contact:bb".into(), "nickname".into(), "dave".into()),
            ],
            "the prefix range takes both contacts and nothing else"
        );

        // The tripwire: both per-collection SELECTs must run as an index SEARCH, never a SCAN
        // of the whole table - "proportional to the question, not the store".
        for sql in [
            "EXPLAIN QUERY PLAN SELECT key FROM private_registers
             WHERE service = ?1 AND collection = ?2",
            "EXPLAIN QUERY PLAN SELECT element FROM private_set_elements
             WHERE service = ?1 AND collection = ?2 AND present = 1",
        ] {
            let plan: Vec<(i64, i64, i64, String)> = db
                .fetch_all(sql, (i64::from(service::GENERAL_PRIVATE), "config"))
                .await
                .unwrap();
            let detail: String = plan
                .iter()
                .map(|(_, _, _, d)| d.as_str())
                .collect::<Vec<_>>()
                .join(" | ");
            assert!(
                detail.contains("SEARCH") && !detail.contains("SCAN"),
                "per-collection read must seek the index, got plan: {detail}"
            );
        }
    }
}
