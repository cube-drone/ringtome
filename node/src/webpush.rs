//! Web Push: a browser with no tab open still hears when a badge lights (Curtis, 2026-09-25).
//!
//! The node is the push SENDER. A browser that opted in hands over a subscription - its vendor's
//! push-service URL for that one browser (Google's, Mozilla's, Apple's), plus a public key and a
//! secret - and whenever the attention watcher (attention.rs) raises an alert for that persona,
//! this encrypts the alert to the browser's key and POSTs it to the URL. The push service holds
//! it until the browser is reachable, and the browser's service worker (js/sw.js) shows it.
//!
//! **No vendor credentials.** The sender identifies itself with VAPID (RFC 8292): a P-256 keypair
//! this node mints for itself, and a short ES256-signed JWT on every request. The browser recorded
//! the public half when it subscribed, so only this node can push to that subscription. The
//! payload is encrypted end to end (RFC 8291) - the push service carries ciphertext, and learns
//! WHEN a browser is notified, never what about. That timing, and delivery depending on three
//! vendors' services, is the trade this feature was taken on with.
//!
//! **Hand-rolled on RustCrypto**, about as long as the RFCs' own pseudocode: P-256 ECDH, HKDF-SHA256
//! and AES-128-GCM for the payload, ECDSA-SHA256 for the JWT. RFC 8291's worked example is the unit
//! test, byte for byte. The `web-push` crate would have brought OpenSSL, which this tree has none of.

use std::collections::HashSet;

use aes_gcm::aead::{Aead, KeyInit};
use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use p256::ecdsa::signature::Signer;
use p256::elliptic_curve::sec1::ToEncodedPoint;

use crate::db::Db;
use crate::AppState;

/// Who the pushes are from, for the push services' abuse desks (RFC 8292's `sub`): a URL, never
/// a person's address - it rides on every request to three companies.
const VAPID_SUBJECT: &str = "https://horsedrawingtycoon.com";
/// How long a push service keeps an undelivered alert. A notification a day late is stale news.
const TTL_SECS: u64 = 24 * 60 * 60;
/// The record size the header declares: one record carries the whole payload.
const RECORD_SIZE: u32 = 4096;
/// The payload's words, bounded: the push services cap a message at 4 KiB, ciphertext and all.
const MAX_BODY_CHARS: usize = 600;
/// The keystore's name for the VAPID key.
const KEY_NAME: &str = "webpush-vapid";

/// The node's push identity and its HTTP client, shared through [`AppState`].
#[derive(Clone)]
pub struct WebPush {
    key: p256::ecdsa::SigningKey,
    http: reqwest::Client,
    /// Local-test mode only: a subscription may name plain `http://` (the rig's fake push
    /// service). Everywhere else a push goes over HTTPS or not at all.
    allow_http: bool,
}

impl WebPush {
    /// Load the node's VAPID key, minting it on first boot (like the database keys, sealed in the
    /// keystore). A key that changes invalidates every subscription made against the old one, so
    /// it is minted once and kept.
    pub fn load(keystore: &crate::keystore::Keystore, allow_http: bool) -> Result<Self> {
        let key = if keystore.contains(KEY_NAME) {
            let bytes = keystore.load_key(KEY_NAME, KEY_NAME.as_bytes()).context("opening the VAPID key")?;
            p256::ecdsa::SigningKey::from_slice(&bytes).map_err(|e| anyhow!("the VAPID key is not a P-256 key: {e}"))?
        } else {
            let key = p256::ecdsa::SigningKey::random(&mut rand_core_compat::OsRng);
            keystore
                .store(KEY_NAME, &key.to_bytes(), KEY_NAME.as_bytes())
                .context("sealing the VAPID key")?;
            tracing::info!("minted this node's Web Push (VAPID) key");
            key
        };
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .context("building the push client")?;
        Ok(Self { key, http, allow_http })
    }

    /// The public key a browser subscribes against (`applicationServerKey`): uncompressed P-256,
    /// base64url.
    pub fn public_key(&self) -> String {
        B64.encode(self.key.verifying_key().to_encoded_point(false).as_bytes())
    }
}

/// `rand_core`'s OsRng under the name p256's `random` wants, so one import reads plainly.
mod rand_core_compat {
    pub use p256::elliptic_curve::rand_core::OsRng;
}

// ---------------------------------------------------------------------------------------------
// The payload: RFC 8291 (aes128gcm content encoding, RFC 8188), one record.

/// Encrypt `plaintext` to a browser's key and secret, with a fresh sender keypair and salt.
pub fn encrypt(plaintext: &[u8], ua_public: &[u8], auth_secret: &[u8]) -> Result<Vec<u8>> {
    let as_secret = p256::SecretKey::random(&mut rand_core_compat::OsRng);
    let mut salt = [0u8; 16];
    use p256::elliptic_curve::rand_core::RngCore;
    rand_core_compat::OsRng.fill_bytes(&mut salt);
    encrypt_with(plaintext, ua_public, auth_secret, &as_secret, &salt)
}

/// The deterministic core, so RFC 8291's example can pin it byte for byte.
fn encrypt_with(
    plaintext: &[u8],
    ua_public: &[u8],
    auth_secret: &[u8],
    as_secret: &p256::SecretKey,
    salt: &[u8; 16],
) -> Result<Vec<u8>> {
    use hkdf::Hkdf;
    use sha2::Sha256;

    let ua_key = p256::PublicKey::from_sec1_bytes(ua_public).map_err(|_| anyhow!("the browser's key is not a P-256 point"))?;
    let as_public = as_secret.public_key().to_encoded_point(false);
    let shared = p256::ecdh::diffie_hellman(as_secret.to_nonzero_scalar(), ua_key.as_affine());

    // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(ua_public);
    key_info.extend_from_slice(as_public.as_bytes());
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth_secret), shared.raw_secret_bytes().as_slice())
        .expand(&key_info, &mut ikm)
        .map_err(|_| anyhow!("HKDF expand (ikm)"))?;

    // CEK and NONCE from the salt (RFC 8188).
    let prk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut cek = [0u8; 16];
    prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek).map_err(|_| anyhow!("HKDF expand (cek)"))?;
    let mut nonce = [0u8; 12];
    prk.expand(b"Content-Encoding: nonce\0", &mut nonce).map_err(|_| anyhow!("HKDF expand (nonce)"))?;

    // One record, so it is the last: the plaintext, then the 0x02 delimiter, no padding.
    let mut record = plaintext.to_vec();
    record.push(0x02);
    let cipher = aes_gcm::Aes128Gcm::new_from_slice(&cek).map_err(|_| anyhow!("AES-128-GCM key"))?;
    let sealed = cipher
        .encrypt(aes_gcm::Nonce::from_slice(&nonce), record.as_slice())
        .map_err(|_| anyhow!("AES-128-GCM seal"))?;
    if sealed.len() + 86 > RECORD_SIZE as usize {
        bail!("push payload too large ({} bytes)", sealed.len());
    }

    // Header: salt(16) || rs(4, big-endian) || idlen(1) || keyid (the sender's public key).
    let mut body = Vec::with_capacity(86 + sealed.len());
    body.extend_from_slice(salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(as_public.as_bytes().len() as u8);
    body.extend_from_slice(as_public.as_bytes());
    body.extend_from_slice(&sealed);
    Ok(body)
}

// ---------------------------------------------------------------------------------------------
// VAPID: RFC 8292.

/// The `Authorization` header for a push to `endpoint`: a JWT naming the push service's origin
/// as its audience, signed ES256 with the node's key, and the key itself.
fn vapid_header(key: &p256::ecdsa::SigningKey, endpoint: &str, now_secs: u64) -> Result<String> {
    let url = reqwest::Url::parse(endpoint).context("parsing the push endpoint")?;
    let audience = url.origin().ascii_serialization();
    let header = B64.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = B64.encode(
        serde_json::json!({ "aud": audience, "exp": now_secs + 12 * 60 * 60, "sub": VAPID_SUBJECT }).to_string(),
    );
    let signing_input = format!("{header}.{claims}");
    let signature: p256::ecdsa::Signature = key.sign(signing_input.as_bytes());
    let token = format!("{signing_input}.{}", B64.encode(signature.to_bytes()));
    let k = B64.encode(key.verifying_key().to_encoded_point(false).as_bytes());
    Ok(format!("vapid t={token}, k={k}"))
}

// ---------------------------------------------------------------------------------------------
// Subscriptions: the table's owner.

/// One browser's subscription, as it arrives from `PushSubscription.toJSON()`.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct Subscription {
    pub endpoint: String,
    pub keys: SubscriptionKeys,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct SubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}

/// Record a subscription for a persona (idempotent: the same browser subscribing again replaces
/// its keys). Refuses anything that is not a real subscription - the endpoint is a URL this node
/// will POST to, so it must be one a browser could have handed over.
pub async fn subscribe(state: &AppState, root: &str, sub: &Subscription) -> Result<()> {
    let url = reqwest::Url::parse(&sub.endpoint).context("the endpoint is not a URL")?;
    let https = url.scheme() == "https";
    let http_ok = state.webpush.allow_http && url.scheme() == "http";
    if !(https || http_ok) || url.host_str().is_none() || sub.endpoint.len() > 1024 {
        bail!("the endpoint must be an https URL");
    }
    let p256dh = B64.decode(sub.keys.p256dh.trim_end_matches('=')).context("p256dh is not base64url")?;
    let auth = B64.decode(sub.keys.auth.trim_end_matches('=')).context("auth is not base64url")?;
    if p256::PublicKey::from_sec1_bytes(&p256dh).is_err() || p256dh.len() != 65 {
        bail!("p256dh is not an uncompressed P-256 point");
    }
    if auth.len() != 16 {
        bail!("auth must be 16 bytes");
    }
    state
        .node_db
        .execute(
            "INSERT INTO push_subscriptions (root_pubkey, endpoint, p256dh, auth, created_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (root_pubkey, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth",
            (root, sub.endpoint.as_str(), p256dh, auth, crate::clock::now_ms()),
        )
        .await
        .context("recording a push subscription")?;
    state.attention.watch_for_push(root);
    Ok(())
}

/// Forget one browser's subscription for a persona.
pub async fn unsubscribe(state: &AppState, root: &str, endpoint: &str) -> Result<()> {
    forget(state, root, endpoint).await
}

async fn forget(state: &AppState, root: &str, endpoint: &str) -> Result<()> {
    state
        .node_db
        .execute(
            "DELETE FROM push_subscriptions WHERE root_pubkey = ?1 AND endpoint = ?2",
            (root, endpoint),
        )
        .await
        .context("forgetting a push subscription")?;
    if subscriptions(&state.node_db, root).await?.is_empty() {
        state.attention.unwatch_for_push(root);
    }
    Ok(())
}

/// A persona's subscriptions: `(endpoint, p256dh, auth)`.
async fn subscriptions(node_db: &Db, root: &str) -> Result<Vec<(String, Vec<u8>, Vec<u8>)>> {
    node_db
        .fetch_all(
            "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE root_pubkey = ?1",
            (root,),
        )
        .await
        .context("listing push subscriptions")
}

/// The endpoints a persona is subscribed at - what lets a browser's toggle tell whether IT is on
/// for this persona (one browser subscription serves every persona it was offered to).
pub async fn endpoints(node_db: &Db, root: &str) -> Result<Vec<String>> {
    Ok(subscriptions(node_db, root).await?.into_iter().map(|(endpoint, _, _)| endpoint).collect())
}

/// Every persona with at least one subscription - what the watcher is told to watch at boot.
pub async fn subscribed_roots(node_db: &Db) -> Result<HashSet<String>> {
    let rows: Vec<(String,)> = node_db
        .fetch_all("SELECT DISTINCT root_pubkey FROM push_subscriptions", ())
        .await
        .context("listing subscribed personas")?;
    Ok(rows.into_iter().map(|(r,)| r).collect())
}

// ---------------------------------------------------------------------------------------------
// Delivery.

/// The sender: spawned once at boot. Every alert for a persona with subscriptions goes to each
/// of its browsers.
pub async fn deliver(state: AppState) {
    match subscribed_roots(&state.node_db).await {
        Ok(roots) => roots.iter().for_each(|r| state.attention.watch_for_push(r)),
        Err(e) => tracing::warn!(error = %e, "could not load push subscriptions"),
    }
    let mut alerts = state.attention.subscribe();
    loop {
        match alerts.recv().await {
            Ok(alert) => push_to_all(&state, &alert).await,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(missed)) => {
                tracing::debug!(missed, "push delivery lagged");
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
        }
    }
}

async fn push_to_all(state: &AppState, alert: &crate::attention::Alert) {
    let subs = match subscriptions(&state.node_db, &alert.root).await {
        Ok(subs) if !subs.is_empty() => subs,
        _ => return,
    };
    let body: String = alert.body.chars().take(MAX_BODY_CHARS).collect();
    let payload = serde_json::json!({ "title": alert.title, "body": body, "route": alert.route }).to_string();
    for (endpoint, p256dh, auth) in subs {
        match push_one(state, &endpoint, &p256dh, &auth, payload.as_bytes()).await {
            Ok(Outcome::Delivered) => {
                let _ = state
                    .node_db
                    .execute(
                        "UPDATE push_subscriptions SET last_ok_ms = ?3 WHERE root_pubkey = ?1 AND endpoint = ?2",
                        (alert.root.as_str(), endpoint.as_str(), crate::clock::now_ms()),
                    )
                    .await;
            }
            Ok(Outcome::Gone) => {
                tracing::info!(root = %alert.root, "a browser let go of its push subscription");
                if let Err(e) = forget(state, &alert.root, &endpoint).await {
                    tracing::warn!(error = %e, "could not forget a gone subscription");
                }
            }
            Ok(Outcome::Refused(status)) => {
                tracing::warn!(root = %alert.root, status, "the push service refused a push");
            }
            Err(e) => tracing::debug!(root = %alert.root, error = %e, "a push failed"),
        }
    }
}

enum Outcome {
    Delivered,
    /// 404 or 410: the subscription is dead - the browser unsubscribed, or expired it.
    Gone,
    Refused(u16),
}

async fn push_one(state: &AppState, endpoint: &str, p256dh: &[u8], auth: &[u8], payload: &[u8]) -> Result<Outcome> {
    let body = encrypt(payload, p256dh, auth)?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs();
    let response = state
        .webpush
        .http
        .post(endpoint)
        .header("Authorization", vapid_header(&state.webpush.key, endpoint, now)?)
        .header("Content-Encoding", "aes128gcm")
        .header("Content-Type", "application/octet-stream")
        .header("TTL", TTL_SECS.to_string())
        .header("Urgency", "normal")
        .body(body)
        .send()
        .await
        .context("posting to the push service")?;
    let status = response.status().as_u16();
    Ok(match status {
        200..=299 => Outcome::Delivered,
        404 | 410 => Outcome::Gone,
        other => Outcome::Refused(other),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(s: &str) -> Vec<u8> {
        B64.decode(s).unwrap()
    }

    /// RFC 8291, Section 5: the worked example, byte for byte - the sender's keypair and salt
    /// fixed, the ciphertext exact. If this passes, every browser can read what we send.
    #[test]
    fn rfc_8291_example_encrypts_byte_for_byte() {
        let plaintext = b"When I grow up, I want to be a watermelon";
        let as_secret = p256::SecretKey::from_slice(&b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")).unwrap();
        assert_eq!(
            B64.encode(as_secret.public_key().to_encoded_point(false).as_bytes()),
            "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
        );
        let ua_public = b64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
        let auth = b64("BTBZMqHH6r4Tts7J_aSIgg");
        let salt: [u8; 16] = b64("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let body = encrypt_with(plaintext, &ua_public, &auth, &as_secret, &salt).unwrap();
        let expected = concat!(
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml",
            "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT",
            "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
        );
        assert_eq!(B64.encode(body), expected);
    }

    /// The VAPID token verifies against the key it carries, names the push service's origin, and
    /// has not expired.
    #[test]
    fn a_vapid_token_verifies_with_its_own_key() {
        use p256::ecdsa::signature::Verifier;
        let key = p256::ecdsa::SigningKey::random(&mut rand_core_compat::OsRng);
        let header = vapid_header(&key, "https://fcm.googleapis.com/fcm/send/abc", 1_000).unwrap();
        let token = header.strip_prefix("vapid t=").unwrap().split(", k=").next().unwrap();
        let k = header.split(", k=").nth(1).unwrap();
        let (signed, sig) = token.rsplit_once('.').unwrap();
        let verifying = p256::ecdsa::VerifyingKey::from_sec1_bytes(&b64(k)).unwrap();
        let signature = p256::ecdsa::Signature::from_slice(&b64(sig)).unwrap();
        verifying.verify(signed.as_bytes(), &signature).expect("the signature verifies");
        let claims: serde_json::Value = serde_json::from_slice(&b64(signed.split('.').nth(1).unwrap())).unwrap();
        assert_eq!(claims["aud"], "https://fcm.googleapis.com");
        assert!(claims["exp"].as_u64().unwrap() > 1_000);
        assert_eq!(claims["sub"], VAPID_SUBJECT);
    }
}
