//! The add-a-node ceremony (PROJECT_PLAN, Adding a New Node).
//!
//! Two copy-pastes: the joining node emits a *request code* (its fresh leaf key + how to reach
//! it); the identity's root node turns that into a signed authorization and emits a *grant code*
//! (the root + how to reach the granter); the joining node completes by syncing the identity
//! chains and finding its own authorization there. Codes are JSON - the M4 client dresses them
//! as QR.
//!
//! This module owns the `pending_adoptions` table (the joining node's between-steps state).

use anyhow::{anyhow, Context};
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use ringtome_proto::crown::KeyStatus;
use ringtome_proto::registry::{entry_type, service};
use ringtome_proto::{Authorize, Payload};
use uuid::Uuid;

use crate::clock::now_ms;
use crate::error::AppError;
use crate::pubkey;
use crate::AppState;

const REQUEST_KIND: &str = "ringtome-adopt-request";
const GRANT_KIND: &str = "ringtome-adopt-grant";

/// The codes' visible costume: `rt1.` + base64url(deflate(JSON)). Purely decorative armor -
/// raw JSON full of pubkeys and socket addresses reads as "code? so complicated!" to a person
/// carrying it between computers, and an opaque strip reads as a ticket. The inner JSON is
/// unchanged (still versioned by its `v` field); the prefix versions the envelope itself. The
/// deflate is not vanity: hex pubkeys are 4-bits-per-char, so the strip comes out ~40%
/// shorter than the JSON it wraps.
const CODE_PREFIX: &str = "rt1.";

/// Wrap a code artifact into its carryable form.
pub fn pack<T: serde::Serialize>(value: &T) -> Result<String, AppError> {
    use flate2::{write::DeflateEncoder, Compression};
    use std::io::Write as _;
    let json = serde_json::to_vec(value)
        .map_err(|e| AppError::Internal(anyhow!("encoding code: {e}")))?;
    let mut enc = DeflateEncoder::new(Vec::new(), Compression::best());
    enc.write_all(&json)
        .and_then(|()| enc.finish())
        .map_err(|e| AppError::Internal(anyhow!("compressing code: {e}")))
        .map(|deflated| {
            use base64::Engine as _;
            format!(
                "{CODE_PREFIX}{}",
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(deflated)
            )
        })
}

/// Unwrap a carried code. Tolerates surrounding whitespace, and still accepts the bare-JSON
/// form (a `{`-leading paste) so nothing breaks for anyone mid-ceremony across an upgrade -
/// cheap tolerance, not a compatibility promise (the User-1 rule stands).
pub fn unpack<T: serde::de::DeserializeOwned>(code: &str, what: &str) -> Result<T, AppError> {
    let code = code.trim();
    let json: Vec<u8> = if let Some(b64) = code.strip_prefix(CODE_PREFIX) {
        use base64::Engine as _;
        use std::io::Read as _;
        let deflated = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(b64.trim())
            .map_err(|_| AppError::BadRequest(format!("unreadable {what}")))?;
        let mut out = Vec::new();
        // A code is ~1 KiB; anything decompressing past this is not a code.
        flate2::read::DeflateDecoder::new(&deflated[..])
            .take(64 * 1024)
            .read_to_end(&mut out)
            .map_err(|_| AppError::BadRequest(format!("unreadable {what}")))?;
        out
    } else if code.starts_with('{') {
        code.as_bytes().to_vec()
    } else {
        return Err(AppError::BadRequest(format!("unreadable {what}")));
    };
    serde_json::from_slice(&json).map_err(|_| AppError::BadRequest(format!("unreadable {what}")))
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct RequestCode {
    pub v: u8,
    pub kind: String,
    pub leaf_pubkey: String,
    /// The leaf's X25519 encryption pubkey - parent-attested in the authorize stamp so epoch
    /// keys can be sealed to this node from birth.
    pub enc_pubkey: String,
    pub endpoint_id: String,
    pub addrs: Vec<String>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct GrantCode {
    pub v: u8,
    pub kind: String,
    pub root_pubkey: String,
    pub leaf_pubkey: String,
    pub endpoint_id: String,
    pub addrs: Vec<String>,
}

/// Step 1, on the joining node: mint a leaf keypair for a prospective identity and emit the
/// request code. The leaf is sealed immediately; nothing about the identity is known yet.
pub async fn begin(state: &AppState, account_id: &Uuid) -> Result<RequestCode, AppError> {
    let leaf = SigningKey::generate(&mut OsRng);
    let leaf_hex = hex::encode(leaf.verifying_key().to_bytes());

    state
        .keystore
        .store(&leaf_hex, &leaf.to_bytes(), leaf_hex.as_bytes())
        .context("sealing adoption leaf key")
        .map_err(AppError::Internal)?;
    let leaf_enc = crate::seal::EncKeyPair::generate();
    crate::record::private::store_enc_keypair(&state.keystore, &leaf_hex, &leaf_enc)
        .context("sealing adoption encryption key")
        .map_err(AppError::Internal)?;
    state
        .node_db
        .execute(
            "INSERT INTO pending_adoptions (leaf_pubkey, account_id, created_at_ms) VALUES (?1, ?2, ?3)",
            (leaf_hex.as_str(), account_id.to_string(), now_ms()),
        )
        .await
        .context("recording pending adoption")
        .map_err(AppError::Internal)?;

    Ok(RequestCode {
        v: 0,
        kind: REQUEST_KIND.to_string(),
        leaf_pubkey: leaf_hex,
        enc_pubkey: hex::encode(leaf_enc.public),
        endpoint_id: state.endpoint.id().to_string(),
        addrs: crate::net::p2p::addr_strings(&state.endpoint),
    })
}

/// Step 2, on the granting node: this node's leaf signs the newcomer into the tree as its own
/// child and emits the grant code. ANY Active member may grant (the M3 root-only trim was
/// un-trimmed 2026-07-24 - `Crown::usurper_stamp_for_new_child` computes the stamp at any
/// depth), so invitation chains daisy: A founds, B joins from A, C joins from B, and the tree
/// records exactly who vouched for whom in its rank paths.
pub async fn authorize_node(
    state: &AppState,
    account_id: &Uuid,
    root_hex: &str,
    code: RequestCode,
) -> Result<GrantCode, AppError> {
    if code.kind != REQUEST_KIND {
        return Err(AppError::BadRequest("not an adoption request code".into()));
    }
    // Refuse self-adoption HERE, before any tree pollution: granting a request minted by this
    // very node would authorize a stray leaf and then die at completion's sync (iroh refuses
    // self-dial - correctly, since the data is already local). Adoption is for bringing a
    // persona to a computer that doesn't have it; a second account on THIS node joining the
    // same persona is a different, future mechanism (account linking - no new keys, no sync).
    if code.endpoint_id == state.endpoint.id().to_string() {
        return Err(AppError::BadRequest(
            "that request code comes from this very computer - it is already this persona. \
             Adoption brings a persona to a NEW computer; run \"bring your persona\" there \
             instead."
                .into(),
        ));
    }
    super::require_owned(&state.node_db, account_id, root_hex).await?;

    let leaf = pubkey::require(&code.leaf_pubkey, "leaf pubkey in request code")?;
    let leaf_enc = pubkey::require(&code.enc_pubkey, "encryption pubkey in request code")?;
    // Validate the root's shape even though the grant no longer signs with it.
    pubkey::require(root_hex, "root pubkey")?;

    let signer =
        super::load_signing_key(&state.node_db, &state.keystore, account_id, root_hex).await?;
    let our_leaf = signer.verifying_key().to_bytes();

    let db = state
        .user_dbs
        .get(root_hex)
        .await
        .map_err(AppError::Internal)?;
    let tree = crate::record::imaol::load_key_tree(&db, root_hex).await?;
    if tree.status(&leaf) != KeyStatus::Unknown {
        return Err(AppError::BadRequest(
            "that key is already in the tree".into(),
        ));
    }
    // Any Active member may extend the tree (the M3 root-only trim, un-trimmed 2026-07-24:
    // rank-path growth was always the model - spare-key succession depends on it - and the
    // crown computes the junior stamp now). A node whose own leaf has been revoked cannot
    // grant: its authorize entries would be quarantined anyway, so refuse in words up front.
    if tree.status(&our_leaf) != KeyStatus::Active {
        return Err(AppError::Forbidden(
            "this computer's key is no longer active for this persona - it can't invite new \
             ones."
                .into(),
        ));
    }

    // The stamp: everyone who outranks the parent, then the parent, then its prior children -
    // computed by the crown for any member, at any depth.
    let stamp = tree
        .usurper_stamp_for_new_child(&our_leaf)
        .ok_or_else(|| AppError::Internal(anyhow!("active key has no rank path")))?;
    let payload = Authorize {
        child: leaf,
        usurpers: stamp,
        enc_pubkey: Some(leaf_enc),
    }
    .encode()
    .map_err(|e| AppError::Internal(anyhow!("encoding authorization: {e}")))?;
    crate::record::imaol::append(
        &db,
        &signer,
        service::IDENTITY_PUBLIC,
        entry_type::AUTHORIZE,
        Payload::Inline(payload),
    )
    .await?;

    // Adoption's private half: re-seal every epoch key this node holds to the newcomer, so its
    // private view reaches all the way back. A member is a member of the whole history - the
    // exclusion boundary is revocation's rotation, never adoption. (The enc keypair is keyed by
    // OUR leaf - which is the root hex only on the founding node.)
    let our_leaf_hex = hex::encode(our_leaf);
    let our_enc = crate::record::private::load_enc_keypair(&state.keystore, &our_leaf_hex)
        .context("loading our encryption key")
        .map_err(AppError::Internal)?;
    let epoch_keys = crate::record::private::unseal_epoch_keys(&db, &our_leaf, &our_enc).await?;
    let resealed =
        crate::record::private::reseal_epochs_to(&db, &signer, &leaf, &leaf_enc, &epoch_keys)
            .await?;
    tracing::info!(root = %root_hex, leaf = %code.leaf_pubkey, resealed, "sealed epoch history");

    // Remember the joining node as a peer so future syncs reach it.
    crate::net::sync::add_peer(&state.node_db, root_hex, &code.endpoint_id)
        .await
        .map_err(AppError::Internal)?;

    tracing::info!(root = %root_hex, leaf = %code.leaf_pubkey, "authorized new node");
    Ok(GrantCode {
        v: 0,
        kind: GRANT_KIND.to_string(),
        root_pubkey: root_hex.to_string(),
        leaf_pubkey: code.leaf_pubkey,
        endpoint_id: state.endpoint.id().to_string(),
        addrs: crate::net::p2p::addr_strings(&state.endpoint),
    })
}

/// Step 3, back on the joining node: sync the identity chains from the granter, verify our leaf
/// actually landed in the tree, and start agenting the identity.
/// Completion for an in-band-delivered grant (net::adopt): the pending row itself says which
/// account minted the request, so no session is involved - possession of a matching pending
/// leaf IS the authorization (the leaf pubkey is a 32-byte unguessable this node created).
/// A grant for a leaf with no pending row is refused unless that exact adoption already
/// completed (redelivery of a done deal acks ok).
pub async fn complete_delivered(state: &AppState, code: GrantCode) -> Result<(), AppError> {
    let pending: Option<(String,)> = state
        .node_db
        .fetch_optional(
            "SELECT account_id FROM pending_adoptions WHERE leaf_pubkey = ?1",
            (code.leaf_pubkey.as_str(),),
        )
        .await
        .context("checking pending adoption")
        .map_err(AppError::Internal)?;
    let Some((account_id,)) = pending else {
        if super::leaf_agents_root(&state.node_db, &code.root_pubkey, &code.leaf_pubkey).await? {
            return Ok(());
        }
        return Err(AppError::NotFound(
            "no pending adoption for that key".into(),
        ));
    };
    let account_uuid = Uuid::parse_str(&account_id)
        .map_err(|e| AppError::Internal(anyhow!("malformed pending account id: {e}")))?;
    complete(state, &account_uuid, code).await.map(|_| ())
}

pub async fn complete(
    state: &AppState,
    account_id: &Uuid,
    code: GrantCode,
) -> Result<super::Identity, AppError> {
    if code.kind != GRANT_KIND {
        return Err(AppError::BadRequest("not an adoption grant code".into()));
    }
    // Belt to the grant-side braces: a grant whose addresses point back at this same computer
    // can only end in iroh's self-dial refusal - say so in words instead.
    if code.endpoint_id == state.endpoint.id().to_string() {
        return Err(AppError::BadRequest(
            "that invite points back at this very computer - it was granted here. Paste it on \
             the NEW computer instead."
                .into(),
        ));
    }
    // The pending leaf must belong to this account (uniform 404 otherwise). One carve-out
    // makes completion IDEMPOTENT: if there is no pending row but this account already agents
    // the identity with this exact leaf, the adoption finished by another path (in-band grant
    // delivery beat the human's paste) - confirm success instead of 404ing a done deal.
    let pending: Option<(String,)> = state
        .node_db
        .fetch_optional(
            "SELECT account_id FROM pending_adoptions WHERE leaf_pubkey = ?1",
            (code.leaf_pubkey.as_str(),),
        )
        .await
        .context("checking pending adoption")
        .map_err(AppError::Internal)?;
    if pending.map(|(a,)| a) != Some(account_id.to_string()) {
        if let Some(identity) = super::adopted_identity(
            &state.node_db,
            account_id,
            &code.root_pubkey,
            &code.leaf_pubkey,
        )
        .await?
        {
            return Ok(identity);
        }
        return Err(AppError::NotFound(
            "no pending adoption for that key".into(),
        ));
    }

    let leaf = pubkey::require(&code.leaf_pubkey, "leaf pubkey in grant code")?;

    crate::net::sync::add_peer(&state.node_db, &code.root_pubkey, &code.endpoint_id)
        .await
        .map_err(AppError::Internal)?;
    // Bootstrap dial: the grant code's addresses are ephemeral single-use hints (allowed to be
    // addresses precisely because they don't live long enough to rot). Later syncs resolve via
    // the directory.
    let addr = crate::net::sync::endpoint_addr(&code.endpoint_id, &code.addrs)
        .map_err(|e| AppError::BadRequest(format!("bad grant code addresses: {e}")))?;

    let stats = crate::net::sync::sync_with_peer(state, &code.root_pubkey, addr)
        .await
        .map_err(|e| AppError::Internal(anyhow!("initial sync failed: {e}")))?;
    tracing::info!(root = %code.root_pubkey, ?stats, "adoption sync complete");

    let db = state
        .user_dbs
        .get(&code.root_pubkey)
        .await
        .map_err(AppError::Internal)?;
    let tree = crate::record::imaol::load_key_tree(&db, &code.root_pubkey).await?;
    if tree.status(&leaf) != KeyStatus::Active {
        return Err(AppError::BadRequest(
            "our key is not (yet) authorized on the identity chain - paste the request code at \
             the granting node first"
                .into(),
        ));
    }

    let created_at_ms = now_ms();
    super::record_identity(
        &state.node_db,
        account_id,
        &code.root_pubkey,
        &code.leaf_pubkey,
        created_at_ms,
    )
    .await?;
    state
        .node_db
        .execute(
            "DELETE FROM pending_adoptions WHERE leaf_pubkey = ?1",
            (code.leaf_pubkey.as_str(),),
        )
        .await
        .context("clearing pending adoption")
        .map_err(AppError::Internal)?;
    crate::net::sync::mark_synced(&state.node_db, &code.root_pubkey, &code.endpoint_id)
        .await
        .map_err(AppError::Internal)?;

    // Second pass, now that we agent the identity: the first sync ran proof-less (no identities
    // row yet), so the granter rightly withheld the private chains. This one carries our member
    // proof and pulls them - adoption ends with the private state here, not eventually.
    let addr = crate::net::sync::endpoint_addr(&code.endpoint_id, &code.addrs)
        .map_err(|e| AppError::BadRequest(format!("bad grant code addresses: {e}")))?;
    let stats = crate::net::sync::sync_with_peer(state, &code.root_pubkey, addr)
        .await
        .map_err(|e| AppError::Internal(anyhow!("private-chain sync failed: {e}")))?;
    tracing::info!(root = %code.root_pubkey, ?stats, "adoption private sync complete");

    // The new key's device name - this node labeling itself, as its first authored write on
    // the identity (PROJECT_PLAN, Device Names). Best-effort by design: the epoch keys just
    // arrived on the private sync above, but if anything about that is still settling, a
    // missing label is a rename away - it must never fail an otherwise-complete adoption.
    match crate::record::store::open(state, account_id, &code.root_pubkey).await {
        Ok(data) => {
            if let Err(e) = data
                .devices()
                .set_name(&leaf, &state.config.node_name)
                .await
            {
                tracing::warn!(root = %code.root_pubkey, "could not write device name: {e}");
            }
        }
        Err(e) => {
            tracing::warn!(root = %code.root_pubkey, "could not open store for device name: {e}");
        }
    }

    Ok(super::Identity {
        root_pubkey: code.root_pubkey,
        created_at_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_wear_the_opaque_costume_and_round_trip() {
        let request = RequestCode {
            v: 0,
            kind: REQUEST_KIND.to_string(),
            leaf_pubkey: "cf".repeat(32),
            enc_pubkey: "40".repeat(32),
            endpoint_id: "6f".repeat(32),
            addrs: vec![
                "172.218.33.194:59216".into(),
                "[2001:569:5b8a:a600:18d0:36e2:f595:7882]:63541".into(),
                "127.0.0.1:58663".into(),
            ],
        };
        let packed = pack(&request).unwrap();

        // Opaque: prefixed, no JSON gubbins visible, and meaningfully shorter than the JSON.
        assert!(packed.starts_with("rt1."));
        assert!(!packed.contains('{') && !packed.contains(':'));
        let json_len = serde_json::to_string(&request).unwrap().len();
        assert!(
            packed.len() < json_len * 3 / 4,
            "the deflate earns its keep: {} vs {json_len}",
            packed.len()
        );

        let back: RequestCode = unpack(&packed, "request code").unwrap();
        assert_eq!(back.leaf_pubkey, request.leaf_pubkey);
        assert_eq!(back.addrs, request.addrs);

        // Whitespace tolerance (a code pasted with a stray newline) and the bare-JSON form
        // (cheap mid-upgrade tolerance, not a compatibility promise).
        let padded = format!("  {packed}\n");
        let back: RequestCode = unpack(&padded, "request code").unwrap();
        assert_eq!(back.endpoint_id, request.endpoint_id);
        let json = serde_json::to_string(&request).unwrap();
        let back: RequestCode = unpack(&json, "request code").unwrap();
        assert_eq!(back.leaf_pubkey, request.leaf_pubkey);

        // Garbage in every costume is a clean refusal, never a panic.
        for junk in ["", "rt1.", "rt1.!!!not-base64!!!", "rt1.AAAA", "hello there"] {
            assert!(unpack::<RequestCode>(junk, "request code").is_err(), "{junk:?}");
        }
    }
}
