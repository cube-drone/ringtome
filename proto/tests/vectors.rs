//! Conformance test vectors: "this logical entry MUST produce exactly these bytes, this hash,
//! this signature."
//!
//! The checked-in file `spec/test-vectors/entry-v0.json` is the conformance boundary for other
//! implementations and the regression tripwire for this one: if an encoding change ever alters
//! the bytes, this test fails loudly instead of silently orphaning all previously-signed data.
//!
//! To regenerate after an *intentional* format change (which is a protocol-breaking event and
//! should be treated with corresponding gravity):
//!
//! ```sh
//! RINGTOME_BLESS=1 cargo test -p ringtome-proto --test vectors
//! ```

use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};

use ringtome_proto::registry::{entry_type, service};
use ringtome_proto::{
    Anchor, Authorize, ChainId, Disposition, Entry, Payload, ProfileSet, Revoke, SignedEntry,
    ENTRY_VERSION, ZERO_HASH,
};

const VECTORS_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../spec/test-vectors/entry-v0.json"
);

/// Deterministic key: this seed exists only for test vectors. Never reuse it for anything real.
const TEST_SEED: [u8; 32] = [7u8; 32];

#[derive(Debug, Serialize, Deserialize, PartialEq)]
struct VectorFile {
    description: String,
    domain: String,
    signing_key_seed: String,
    author_pubkey: String,
    vectors: Vec<Vector>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
struct Vector {
    name: String,
    entry: LogicalEntry,
    envelope_hex: String,
    hash_hex: String,
    sig_hex: String,
}

/// The logical entry spelled out field by field, so a second implementation can rebuild it
/// without parsing our hex.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
struct LogicalEntry {
    v: u16,
    entry_type: u32,
    service: u32,
    seq: u64,
    prev_hash_hex: String,
    timestamp_ms: u64,
    payload_kind: String,
    payload_hex: String,
}

fn build_vectors() -> VectorFile {
    let key = SigningKey::from_bytes(&TEST_SEED);
    let author = key.verifying_key().to_bytes();

    let mut vectors = Vec::new();
    let mut make = |name: &str,
                    entry_type_id: u32,
                    service_id: u32,
                    seq: u64,
                    prev_hash: [u8; 32],
                    timestamp_ms: u64,
                    payload: Payload| {
        let entry = Entry {
            v: ENTRY_VERSION,
            entry_type: entry_type_id,
            chain: ChainId {
                author,
                service: service_id,
            },
            seq,
            prev_hash,
            timestamp_ms,
            payload: payload.clone(),
        };
        let signed = SignedEntry::create(&entry, &key).expect("vector entry must sign");
        let (payload_kind, payload_hex) = match &payload {
            Payload::Inline(b) => ("inline", hex::encode(b)),
            Payload::Blob(h) => ("blob", hex::encode(h)),
        };
        vectors.push(Vector {
            name: name.to_string(),
            entry: LogicalEntry {
                v: ENTRY_VERSION,
                entry_type: entry_type_id,
                service: service_id,
                seq,
                prev_hash_hex: hex::encode(prev_hash),
                timestamp_ms,
                payload_kind: payload_kind.to_string(),
                payload_hex,
            },
            envelope_hex: hex::encode(signed.bytes()),
            hash_hex: hex::encode(signed.hash()),
            sig_hex: hex::encode(signed.sig()),
        });
        signed
    };

    // Vector 1: genesis profile-set (ASCII).
    let ps_name = ProfileSet {
        field: "name".into(),
        value: "Curtis".into(),
    }
    .encode()
    .unwrap();
    let e0 = make(
        "profile-set genesis (ascii)",
        entry_type::PROFILE_SET,
        service::PROFILE,
        0,
        ZERO_HASH,
        1_700_000_000_000,
        Payload::Inline(ps_name),
    );

    // Vector 2: chained profile-set with non-ASCII (NFC-normalized) text.
    let ps_bio = ProfileSet {
        field: "bio".into(),
        value: "z\u{0308}oe\u{0308} \u{2014} MIDI enjoyer".into(),
    }
    .encode()
    .unwrap();
    let _e1 = make(
        "profile-set chained (unicode nfc)",
        entry_type::PROFILE_SET,
        service::PROFILE,
        1,
        *e0.hash(),
        1_700_000_060_000,
        Payload::Inline(ps_bio),
    );

    // Vector 3: genesis post with a blob payload on a different service chain.
    let blob_hash = *blake3::hash(b"ringtome test-vector blob content").as_bytes();
    let _p0 = make(
        "post genesis (blob payload)",
        entry_type::POST,
        service::POSTS,
        0,
        ZERO_HASH,
        1_700_000_120_000,
        Payload::Blob(blob_hash),
    );

    // Vector 4: the identity chain's genesis - authorizing a recovery key as the root's first
    // child, stamped with the usurper list [root].
    let recovery = SigningKey::from_bytes(&[8u8; 32]);
    let az = Authorize {
        child: recovery.verifying_key().to_bytes(),
        usurpers: vec![author],
    }
    .encode()
    .unwrap();
    let i0 = make(
        "authorize genesis (recovery key)",
        entry_type::AUTHORIZE,
        service::IDENTITY_PUBLIC,
        0,
        ZERO_HASH,
        1_700_000_180_000,
        Payload::Inline(az),
    );

    // Vector 5: a chained retirement revocation with one anchor.
    let rv = Revoke {
        target: recovery.verifying_key().to_bytes(),
        disposition: Disposition::Retirement,
        anchors: vec![Anchor {
            service: service::IDENTITY_PUBLIC,
            seq: 0,
            head_hash: *blake3::hash(b"ringtome test-vector anchor head").as_bytes(),
        }],
    }
    .encode()
    .unwrap();
    let _i1 = make(
        "revoke chained (retirement, one anchor)",
        entry_type::REVOKE,
        service::IDENTITY_PUBLIC,
        1,
        *i0.hash(),
        1_700_000_240_000,
        Payload::Inline(rv),
    );

    VectorFile {
        description: "Ringtome entry format v0 conformance vectors. A conformant implementation \
                      encoding each logical entry with the given signing key MUST produce exactly \
                      envelope_hex, whose BLAKE3-256 is hash_hex and whose signature is sig_hex \
                      (ed25519 over domain || body-bytes)."
            .to_string(),
        domain: String::from_utf8(ringtome_proto::DOMAIN_ENTRY.to_vec()).unwrap(),
        signing_key_seed: hex::encode(TEST_SEED),
        author_pubkey: hex::encode(author),
        vectors,
    }
}

#[test]
fn vectors_match_the_published_file() {
    let built = build_vectors();

    if std::env::var("RINGTOME_BLESS").is_ok() {
        let dir = std::path::Path::new(VECTORS_PATH).parent().unwrap();
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(VECTORS_PATH, serde_json::to_string_pretty(&built).unwrap()).unwrap();
        eprintln!("blessed: wrote {VECTORS_PATH}");
        return;
    }

    let published = std::fs::read_to_string(VECTORS_PATH).unwrap_or_else(|e| {
        panic!("cannot read {VECTORS_PATH}: {e}. Run RINGTOME_BLESS=1 to generate.")
    });
    let published: VectorFile = serde_json::from_str(&published).unwrap();
    assert_eq!(
        built, published,
        "entry encoding no longer matches the published test vectors - this is a \
         protocol-breaking change; if intentional, re-bless and bump the version"
    );
}

/// The vectors must also be *readable*: decode every published envelope, verify its signature,
/// and confirm the hash. This is the half a non-Rust implementation exercises first.
#[test]
fn published_envelopes_decode_and_verify() {
    if std::env::var("RINGTOME_BLESS").is_ok() {
        return; // file may not exist yet during a bless run
    }
    let published: VectorFile =
        serde_json::from_str(&std::fs::read_to_string(VECTORS_PATH).unwrap()).unwrap();
    for v in &published.vectors {
        let bytes = hex::decode(&v.envelope_hex).unwrap();
        let signed = SignedEntry::decode(&bytes).unwrap_or_else(|e| {
            panic!("vector {:?} failed to decode: {e}", v.name);
        });
        signed.verify().unwrap_or_else(|e| {
            panic!("vector {:?} failed signature verification: {e}", v.name);
        });
        assert_eq!(
            hex::encode(signed.hash()),
            v.hash_hex,
            "vector {:?}",
            v.name
        );
        assert_eq!(signed.entry().seq, v.entry.seq, "vector {:?}", v.name);
    }
}
