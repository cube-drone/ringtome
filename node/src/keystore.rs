//! Envelope encryption for private keys at rest.
//!
//! Private keys never touch the database; each is stored as a small encrypted blob in a key file.
//! The blob is sealed with XChaCha20-Poly1305 (AEAD - so a tampered/corrupt file fails loudly
//! rather than yielding a subtly-wrong key) under an *envelope key*.
//!
//! The envelope key is read unattended on boot so the node stays trivially restartable:
//! `RINGTOME_ENVELOPE_KEY` (hex) if set, otherwise a random key generated on first boot and
//! persisted to `data/envelope.key` (0600). This protects the leaked-file / stolen-backup window;
//! it does not (and the threat model does not claim to) protect against a fully-compromised running
//! machine, which already holds whatever the node can decrypt.
//!
//! Sealed blobs carry a version + algorithm byte so the scheme can change later without stranding
//! old files (crypto agility).

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use chacha20poly1305::aead::{Aead, KeyInit, OsRng};
use chacha20poly1305::{AeadCore, XChaCha20Poly1305, XNonce};

/// Sealed-blob format version + algorithm marker (first byte of every sealed blob).
const SEAL_V1_XCHACHA: u8 = 0x01;
const ENVELOPE_KEY_LEN: usize = 32;

/// Holds the node's envelope key and seals/opens private-key blobs with it.
#[derive(Clone)]
pub struct Keystore {
    /// Directory for individual key files (`data/keys/`).
    keys_directory: PathBuf,
    envelope_key: chacha20poly1305::Key,
}

impl Keystore {
    /// Load (from `RINGTOME_ENVELOPE_KEY`) or first-boot-generate (persisting to
    /// `<data_dir>/envelope.key`) the envelope key, and prepare the keys directory.
    pub fn load(data_directory: &Path) -> Result<Self> {
        let keys_directory = data_directory.join("keys");
        std::fs::create_dir_all(&keys_directory).context("creating keys directory")?;

        let envelope_key = match std::env::var("RINGTOME_ENVELOPE_KEY") {
            Ok(hex_key) => {
                let bytes = hex::decode(hex_key.trim())
                    .context("RINGTOME_ENVELOPE_KEY is not valid hex")?;
                if bytes.len() != ENVELOPE_KEY_LEN {
                    bail!(
                        "RINGTOME_ENVELOPE_KEY must be {ENVELOPE_KEY_LEN} bytes ({} hex chars)",
                        ENVELOPE_KEY_LEN * 2
                    );
                }
                *chacha20poly1305::Key::from_slice(&bytes)
            }
            Err(_) => load_or_create_envelope_key_file(data_directory)?,
        };

        Ok(Self {
            keys_directory,
            envelope_key,
        })
    }

    fn cipher(&self) -> XChaCha20Poly1305 {
        XChaCha20Poly1305::new(&self.envelope_key)
    }

    fn key_path(&self, name: &str) -> PathBuf {
        self.keys_directory.join(format!("{name}.key"))
    }

    /// Seal `plaintext` and write it to a key file named `name`. `aad` is bound into the
    /// authentication tag (not encrypted) - pass the identity's pubkey so a key file can't be
    /// silently swapped for a different identity's.
    pub fn store(&self, name: &str, plaintext: &[u8], aad: &[u8]) -> Result<()> {
        let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
        let ciphertext = self
            .cipher()
            .encrypt(
                &nonce,
                chacha20poly1305::aead::Payload { msg: plaintext, aad },
            )
            .map_err(|_| anyhow!("sealing key"))?;

        // Layout: [version byte][24-byte nonce][ciphertext+tag]
        let mut blob = Vec::with_capacity(1 + nonce.len() + ciphertext.len());
        blob.push(SEAL_V1_XCHACHA);
        blob.extend_from_slice(nonce.as_slice());
        blob.extend_from_slice(&ciphertext);

        write_private_file(&self.key_path(name), &blob)
            .with_context(|| format!("writing key file {name}"))
    }

    /// Read and open the key file named `name`, verifying against `aad`.
    pub fn load_key(&self, name: &str, aad: &[u8]) -> Result<Vec<u8>> {
        let blob = std::fs::read(self.key_path(name))
            .with_context(|| format!("reading key file {name}"))?;

        let Some((&version, rest)) = blob.split_first() else {
            bail!("empty key file {name}");
        };
        if version != SEAL_V1_XCHACHA {
            bail!("unknown key-file version {version:#x} in {name}");
        }
        if rest.len() < 24 {
            bail!("truncated key file {name}");
        }
        let (nonce_bytes, ciphertext) = rest.split_at(24);
        let nonce = XNonce::from_slice(nonce_bytes);

        self.cipher()
            .decrypt(nonce, chacha20poly1305::aead::Payload { msg: ciphertext, aad })
            .map_err(|_| anyhow!("opening key file {name}: authentication failed (corrupt, tampered, or wrong envelope key)"))
    }
}

/// Read the persisted envelope key, or generate + persist one on first boot.
fn load_or_create_envelope_key_file(data_directory: &Path) -> Result<chacha20poly1305::Key> {
    let path = data_directory.join("envelope.key");

    if path.exists() {
        let bytes = std::fs::read(&path).context("reading envelope.key")?;
        if bytes.len() != ENVELOPE_KEY_LEN {
            bail!("envelope.key is corrupt (wrong length)");
        }
        return Ok(*chacha20poly1305::Key::from_slice(&bytes));
    }

    let key = XChaCha20Poly1305::generate_key(&mut OsRng);
    write_private_file(&path, key.as_slice()).context("writing envelope.key")?;
    tracing::info!(path = %path.display(), "generated new node envelope key");
    Ok(key)
}

/// Write a file with owner-only permissions (0600 on Unix; best-effort elsewhere).
fn write_private_file(path: &Path, contents: &[u8]) -> Result<()> {
    std::fs::write(path, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_keystore() -> (Keystore, PathBuf) {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("ringtome-ks-{}-{}", std::process::id(), nanos));
        std::fs::create_dir_all(&dir).unwrap();
        // Ensure we don't pick up an ambient RINGTOME_ENVELOPE_KEY from the environment.
        std::env::remove_var("RINGTOME_ENVELOPE_KEY");
        (Keystore::load(&dir).unwrap(), dir)
    }

    #[test]
    fn seal_and_open_round_trips() {
        let (ks, dir) = temp_keystore();
        let secret = b"a 32-byte-ish private key blob!!";
        ks.store("identity_a", secret, b"identity_a").unwrap();

        let opened = ks.load_key("identity_a", b"identity_a").unwrap();
        assert_eq!(opened, secret);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn wrong_aad_fails_to_open() {
        let (ks, dir) = temp_keystore();
        ks.store("identity_a", b"secret bytes", b"identity_a").unwrap();

        // Opening with a different AAD (as if the file were swapped for another identity's) fails.
        assert!(ks.load_key("identity_a", b"identity_b").is_err());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tampered_file_fails_to_open() {
        let (ks, dir) = temp_keystore();
        ks.store("identity_a", b"secret bytes", b"identity_a").unwrap();

        // Flip a byte in the ciphertext region and confirm authentication rejects it.
        let path = ks.key_path("identity_a");
        let mut blob = std::fs::read(&path).unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 0xff;
        std::fs::write(&path, &blob).unwrap();

        assert!(ks.load_key("identity_a", b"identity_a").is_err());

        std::fs::remove_dir_all(&dir).ok();
    }
}
