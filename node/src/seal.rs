//! Sealing: anonymous public-key encryption for private-chain epoch keys, plus the recovery-seed
//! key derivation.
//!
//! We talk to dryoc (libsodium's `crypto_box_seal` — an interoperable, cross-language standard)
//! in **bytes only**: `[u8; 32]` keys in, `Vec<u8>` boxes out. dryoc's curve25519-dalek is a
//! different major version than iroh's and they never exchange a typed value, so our crypto is
//! immune to iroh's dependency-version weather (PROJECT_PLAN, crypto boundary note). Nothing
//! outside this module names a dryoc type.
//!
//! A sealed box needs only the *recipient's public key* to encrypt (an ephemeral sender key is
//! generated per box), which is exactly what epoch rotation needs: seal the new key to every
//! member — including the offline recovery key — from its published pubkey alone. Authorship of
//! the rotation is already proven by the signed chain entry, so the box needs no sender auth.

use anyhow::{anyhow, Result};
use dryoc::dryocbox::{DryocBox, KeyPair, PublicKey, SecretKey, VecBox};
use dryoc::generichash::GenericHash;

use ringtome_proto::SigningKey;

/// An X25519 encryption keypair as raw bytes. This is the only key type this module exports;
/// dryoc's own types stay inside.
#[derive(Clone)]
pub struct EncKeyPair {
    pub public: [u8; 32],
    pub secret: [u8; 32],
}

impl EncKeyPair {
    /// A fresh random encryption keypair (for a leaf or root).
    pub fn generate() -> Self {
        use rand::RngCore;
        let mut secret = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut secret);
        Self::from_secret(secret)
    }

    /// Reconstruct a keypair from its secret bytes (public is derived).
    pub fn from_secret(secret: [u8; 32]) -> Self {
        let kp = KeyPair::from_secret_key(SecretKey::from(secret));
        EncKeyPair {
            public: *kp.public_key.as_ref(),
            secret: *kp.secret_key.as_ref(),
        }
    }

    fn dryoc(&self) -> KeyPair {
        KeyPair {
            public_key: PublicKey::from(self.public),
            secret_key: SecretKey::from(self.secret),
        }
    }
}

/// Seal `plaintext` to a recipient's encryption public key. Anyone can produce this; only the
/// holder of the matching secret can open it.
pub fn seal(plaintext: &[u8], recipient_pub: &[u8; 32]) -> Result<Vec<u8>> {
    let sealed: VecBox = DryocBox::seal_to_vecbox(plaintext, &PublicKey::from(*recipient_pub))
        .map_err(|e| anyhow!("sealing: {e}"))?;
    Ok(sealed.to_vec())
}

/// Open a sealed box with our keypair. Returns `None` if it wasn't sealed to us (or is corrupt) -
/// which is the normal, expected case for every epoch box not addressed to this node.
pub fn unseal(sealed: &[u8], kp: &EncKeyPair) -> Option<Vec<u8>> {
    let boxed = VecBox::from_sealed_bytes(sealed).ok()?;
    boxed.unseal_to_vec(&kp.dryoc()).ok()
}

/// Domain-separated derivation from a 32-byte seed. BLAKE2b (keyless, prefix-domain-separated) is
/// a PRF, so distinct contexts yield independent 32-byte outputs.
fn derive(seed: &[u8; 32], context: &[u8]) -> [u8; 32] {
    let mut input = context.to_vec();
    input.extend_from_slice(seed);
    let out: Vec<u8> = GenericHash::hash_with_defaults_to_vec::<_, [u8; 32]>(&input, None)
        .expect("blake2b default output");
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&out[..32]);
    arr
}

/// Split a recovery seed (the photo's single secret) into its two *independent* keypairs — the
/// signing key (its pubkey names the recovery key in the tree) and the encryption key (epoch keys
/// are sealed to it). One artifact, minted-grade key separation via domain-separated derivation.
pub fn derive_recovery(seed: &[u8; 32]) -> (SigningKey, EncKeyPair) {
    let sign_seed = derive(seed, b"ringtome-v0/recovery/sign");
    let enc_seed = derive(seed, b"ringtome-v0/recovery/enc");
    (
        SigningKey::from_bytes(&sign_seed),
        EncKeyPair::from_secret(enc_seed),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_round_trips_to_the_right_key_only() {
        let alice = EncKeyPair::generate();
        let bob = EncKeyPair::generate();
        let secret = b"epoch key material goes here!!!!";

        let sealed = seal(secret, &alice.public).unwrap();
        assert_eq!(
            unseal(&sealed, &alice).unwrap(),
            secret,
            "recipient opens it"
        );
        assert!(unseal(&sealed, &bob).is_none(), "non-recipient cannot");
    }

    #[test]
    fn from_secret_is_deterministic() {
        let s = [9u8; 32];
        assert_eq!(
            EncKeyPair::from_secret(s).public,
            EncKeyPair::from_secret(s).public
        );
    }

    #[test]
    fn recovery_split_is_deterministic_and_independent() {
        let seed = [3u8; 32];
        let (sign_a, enc_a) = derive_recovery(&seed);
        let (sign_b, enc_b) = derive_recovery(&seed);
        // Same seed -> same keys (so the photo reconstructs them).
        assert_eq!(sign_a.to_bytes(), sign_b.to_bytes());
        assert_eq!(enc_a.public, enc_b.public);
        // The two derived keys are independent (sign seed != enc seed).
        assert_ne!(sign_a.to_bytes(), enc_a.secret);
        // A different photo seed yields entirely different keys.
        let (sign_c, enc_c) = derive_recovery(&[4u8; 32]);
        assert_ne!(sign_a.to_bytes(), sign_c.to_bytes());
        assert_ne!(enc_a.public, enc_c.public);
    }

    #[test]
    fn a_sealed_epoch_key_round_trips_through_bytes() {
        // The exact shape the epoch machinery uses: seal a 32-byte key to a recovery-derived enc
        // pubkey, unseal with the recovery-derived keypair.
        let seed = [7u8; 32];
        let (_sign, enc) = derive_recovery(&seed);
        let epoch_key = [0x42u8; 32];
        let sealed = seal(&epoch_key, &enc.public).unwrap();
        assert_eq!(unseal(&sealed, &enc).unwrap(), epoch_key);
    }
}
