//! The release manifest and the checks a download must pass before it is ever executed.
//!
//! `server-latest.json` is written by `release.yml`'s `server-publish` job:
//!
//! ```json
//! {"version": "0.1.10", "name": "0.1.10-cape-jab", "tag": "v0.1.10-cape-jab", "pub_date": "...",
//!  "notes": "...", "platforms": {"linux-x86_64": {"url": "...", "signature": "...", "sha256": "..."}}}
//! ```
//!
//! `signature` is the Tauri signer's output: base64 of a whole minisign signature file (prehashed
//! Ed25519, algorithm `ED`), the same shape the desktop updater's manifest carries. The manifest
//! itself is NOT signed and needs no signature: it only says where to look, and every byte it
//! points at is checked against the release key compiled into this program. A forged manifest can
//! at worst name a real, older signed release - which `is_newer` refuses - or waste a download.
//!
//! Value in, value out: nothing here touches the network or the disk.

use std::collections::BTreeMap;

use anyhow::{bail, Context, Result};
use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Deserialize)]
pub struct Manifest {
    /// Strict `major.minor.patch`: what is compared.
    pub version: String,
    /// `<version>-<release name>`: what is shown.
    #[serde(default)]
    pub name: String,
    pub platforms: BTreeMap<String, Download>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Download {
    pub url: String,
    pub signature: String,
    pub sha256: String,
}

/// `major.minor.patch` as numbers, or None for anything else (a pre-release suffix included: the
/// release pipeline never makes one, so meeting one means something is wrong).
pub fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let mut parts = v.trim().split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// Is `candidate` strictly newer than `current`? Anything unparseable is never newer: the
/// supervisor only ever moves forward, and only onto a version it understands.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    match (parse_version(candidate), parse_version(current)) {
        (Some(c), Some(i)) => c > i,
        _ => false,
    }
}

/// The checks, in the order that fails cheapest: the sha256 the manifest promised, then the
/// signature over the bytes by `public_key` (a minisign public key's base64 line). Both must
/// pass; the sha256 alone proves only that the download matches a manifest anyone could write.
pub fn verify(bytes: &[u8], download: &Download, public_key: &str) -> Result<()> {
    let digest = hex::encode(Sha256::digest(bytes));
    if !digest.eq_ignore_ascii_case(download.sha256.trim()) {
        bail!(
            "sha256 mismatch: the manifest promised {}, the download is {digest}",
            download.sha256.trim()
        );
    }
    let key = minisign_verify::PublicKey::from_base64(public_key.trim())
        .map_err(|e| anyhow::anyhow!("the update public key is not a minisign key: {e}"))?;
    let sig_text = base64::engine::general_purpose::STANDARD
        .decode(download.signature.trim())
        .context("the signature is not base64")?;
    let sig_text = String::from_utf8(sig_text).context("the signature is not text")?;
    let signature = minisign_verify::Signature::decode(&sig_text)
        .map_err(|e| anyhow::anyhow!("the signature is not a minisign signature: {e}"))?;
    // `false`: refuse legacy (non-prehashed) signatures; the Tauri signer never makes one.
    key.verify(bytes, &signature, false).map_err(|e| {
        anyhow::anyhow!("the signature does not verify against the release key: {e}")
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use blake2::Blake2b512;
    use ed25519_dalek::{Signer, SigningKey};

    const KEY_ID: [u8; 8] = [1, 2, 3, 4, 5, 6, 7, 8];

    /// A minisign public key line for `key`, in the format `minisign -G` writes.
    fn public_line(key: &SigningKey) -> String {
        let mut raw = b"Ed".to_vec();
        raw.extend_from_slice(&KEY_ID);
        raw.extend_from_slice(key.verifying_key().as_bytes());
        base64::engine::general_purpose::STANDARD.encode(raw)
    }

    /// What `tauri signer sign` produces for `bytes`: a prehashed minisign signature file,
    /// base64-wrapped whole.
    fn tauri_signature(key: &SigningKey, bytes: &[u8]) -> String {
        let b64 = base64::engine::general_purpose::STANDARD;
        let prehash = Blake2b512::digest(bytes);
        let signature = key.sign(&prehash).to_bytes();
        let mut sig_raw = b"ED".to_vec();
        sig_raw.extend_from_slice(&KEY_ID);
        sig_raw.extend_from_slice(&signature);
        let trusted = "timestamp:1790361012\tfile:ringtome-server.tar.gz";
        let mut global = signature.to_vec();
        global.extend_from_slice(trusted.as_bytes());
        let global = key.sign(&global).to_bytes();
        let text = format!(
            "untrusted comment: signature from tauri secret key\n{}\ntrusted comment: {trusted}\n{}\n",
            b64.encode(sig_raw),
            b64.encode(global)
        );
        b64.encode(text)
    }

    fn download_for(key: &SigningKey, bytes: &[u8]) -> Download {
        Download {
            url: "https://example.invalid/x.tar.gz".into(),
            signature: tauri_signature(key, bytes),
            sha256: hex::encode(Sha256::digest(bytes)),
        }
    }

    #[test]
    fn a_signed_download_verifies() {
        let key = SigningKey::from_bytes(&[7; 32]);
        let bytes = b"the node, in a tarball";
        verify(bytes, &download_for(&key, bytes), &public_line(&key)).unwrap();
    }

    #[test]
    fn the_real_release_key_parses() {
        minisign_verify::PublicKey::from_base64(crate::config::RELEASE_PUBLIC_KEY).unwrap();
    }

    /// One key signs both kinds of update (SIGNING.md). If the desktop's key is ever rotated and
    /// this one is not, every server release would be refused by every supervisor - silently, as
    /// far as the release job can tell - so the two are held together here.
    #[test]
    fn the_release_key_is_the_desktop_updaters_key() {
        let conf = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../desktop/tauri.conf.json"
        ))
        .unwrap();
        let conf: serde_json::Value = serde_json::from_str(&conf).unwrap();
        let wrapped = conf["plugins"]["updater"]["pubkey"]
            .as_str()
            .expect("the desktop updater's pubkey");
        let key_file = String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(wrapped)
                .unwrap(),
        )
        .unwrap();
        assert!(
            key_file.lines().any(|l| l.trim() == crate::config::RELEASE_PUBLIC_KEY),
            "supervisor/src/config.rs RELEASE_PUBLIC_KEY is not the key in desktop/tauri.conf.json:\n{key_file}"
        );
    }

    #[test]
    fn every_forgery_is_refused() {
        let key = SigningKey::from_bytes(&[7; 32]);
        let stranger = SigningKey::from_bytes(&[9; 32]);
        let bytes = b"the node, in a tarball";

        // Other bytes behind a matching sha256 - a manifest written to fit - still need the key.
        let tampered = b"a different node, in a tarball";
        let mut forged = download_for(&stranger, tampered);
        let err = verify(tampered, &forged, &public_line(&key))
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("does not verify"),
            "signed by a stranger: {err}"
        );

        // A correctly signed file whose bytes changed in transit fails at the sha256.
        forged = download_for(&key, bytes);
        let err = verify(tampered, &forged, &public_line(&key))
            .unwrap_err()
            .to_string();
        assert!(err.contains("sha256"), "{err}");

        // The right bytes and hash with a signature that is not base64 at all.
        forged.signature = "not base64!".into();
        assert!(verify(bytes, &forged, &public_line(&key)).is_err());
    }

    #[test]
    fn versions_only_move_forward() {
        assert!(is_newer("0.1.11", "0.1.10"));
        assert!(is_newer("0.2.0", "0.1.99"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(
            !is_newer("0.1.10", "0.1.10"),
            "the same version is not an update"
        );
        assert!(!is_newer("0.1.9", "0.1.10"), "never back");
        assert!(!is_newer("0.1.11-rc1", "0.1.10"), "nothing unparseable");
        assert!(!is_newer("0.1.11", "garbage"));
        assert_eq!(
            parse_version("0.10.2"),
            Some((0, 10, 2)),
            "numeric, not lexical"
        );
    }
}
