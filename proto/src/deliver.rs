//! Delivery protocol v0: handing a notice to a stranger's node.
//!
//! This is the **delivered** half of Arrival and Attention (PROJECT_PLAN). You *pull* from
//! people you have chosen; things *arrive* from people whose chains you have no reason to
//! sync. A follow from a stranger is the first citizen: their node dials one of yours and
//! offers an envelope; your node judges it (The Inbound Gate) and, if it passes, transcribes
//! it onto an inbox chain. Nothing here writes anything - this module is the wire, strict in
//! both directions, and a message decoding successfully says nothing about whether its
//! contents should be believed.
//!
//! ## Why its own ALPN rather than a sync message
//!
//! Sync is a conversation between nodes that already have a relationship: a pull, streaming,
//! with a member-proof notion of who may see what. Delivery is the opposite conversation -
//! one request, one answer, from a **stranger** the recipient has no reason to know. Different
//! authority, different shape, different abuse surface. Sync's own rule ("protocol version
//! lives in the ALPN, not in the messages") says a different table of messages is a different
//! protocol, so this is [`DELIVER_ALPN`] and not two more tags on [`crate::sync`].
//!
//! ## Envelopes carry evidence, not claims
//!
//! The load-bearing property, and the reason this format looks the way it does: an envelope
//! must verify **offline, from its own bytes, with zero fetches**. The moment verifying a
//! stranger's claim costs a sync, "broadcast implausible claims to force a malicious sync"
//! becomes the attack. So the envelope carries its own proof:
//!
//! - the **authorization path** - the chain of `authorize` entries from the sender's root to
//!   the leaf that signed, each self-authenticating, verifiable from the root pubkey alone;
//! - the **evidence** - the sender's own signed entry making the claim (for a follow, the
//!   `public-edge` statement naming the recipient as its subject).
//!
//! What that buys is a gate that needs a few signature checks over bytes it was already
//! handed. What it honestly does not buy: **revocation** (the path cannot prove the leaf was
//! not revoked yesterday - accepted for a notification) and **publication** (the sender may
//! have signed the entry and never served it - but it occupies a `(chain, seq)`, so their
//! real chain must eventually carry it or hand every recipient fork proof).
//!
//! Wire shape mirrors [`crate::entry`]: a signed envelope is the canonical CBOR array
//! `[bstr body, bstr(64) sig]`, and the signature covers `DOMAIN_ENVELOPE || body-bytes`, so
//! verification slices the received bytes and never re-serializes. The body is an
//! integer-keyed map; unknown keys are skipped, so the format grows additively.

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};

use crate::cbor::{Reader, Writer};
use crate::error::ProtoError;
use crate::{HASH_LEN, SIG_LEN};

/// ALPN for delivery connections. The trailing `/0` is the protocol version.
pub const DELIVER_ALPN: &[u8] = b"ringtome/deliver/0";

/// Signature domain for a delivery envelope. Distinct from `DOMAIN_ENTRY`, so an envelope
/// signature can never be replayed as an entry signature or the reverse.
pub const DOMAIN_ENVELOPE: &[u8] = b"ringtome-v0/envelope";

/// Hard cap on one signed envelope. The number is not free: transcription stores the envelope
/// **verbatim inside the recipient's encryption**, so it has to fit a private record's
/// ciphertext (`PrivateRecord::MAX_CIPHERTEXT`, 6 KiB) with room for the notice wrapper and the
/// AEAD tag. Four KiB leaves that headroom and is still ample for the realistic shape - a
/// one-or-two-deep key tree plus one small evidence entry lands under 1 KiB - while bounding
/// the pathological one (maximal usurper lists at every rung). The gate checks this **before**
/// it verifies any signature: a length comparison is a subtraction, a signature check is not.
pub const MAX_ENVELOPE_BYTES: usize = 4 * 1024;

/// Hard cap on one framed delivery message, with room for the envelope plus framing.
pub const MAX_DELIVER_FRAME_BYTES: usize = 8 * 1024;

/// Ceiling on the authorization path's depth. A key tree's design center is 2-5 keys and its
/// depth is smaller still; a path claiming more rungs than this is an attack or a bug.
pub const MAX_AUTH_PATH: usize = 8;

/// Byte ceiling on a first-contact greeting: big enough for "it's Dave from the conference",
/// too small to be a payload channel (PROJECT_PLAN, The Inbound Gate).
pub const MAX_GREETING_LEN: usize = 280;

/// What a notice claims happened. One kind exists; the rest of the space is named in
/// PROJECT_PLAN (comment, tag, rebroadcast, first-contact, group invite) and each will arrive
/// with its own evidence rule, so ids are minted as their verification is written rather than
/// reserved in advance.
pub mod notice_kind {
    /// "I published an edge naming you" - evidence is the sender's `public-edge` entry, and
    /// the bands it carries say whether that reads as a follow, a vouch, or both. Deliberately
    /// the same kind the DERIVED path already folds (`notifications::KIND_PUBLIC_EDGE`): the
    /// reader should not care whether a fact arrived by pull or by envelope, so both paths
    /// produce the same row and the same sentence.
    pub const PUBLIC_EDGE: u32 = 1;

    pub fn name(id: u32) -> &'static str {
        match id {
            PUBLIC_EDGE => "public-edge",
            _ => "unknown-kind",
        }
    }
}

/// The logical content of a delivery envelope.
///
/// `signer` is stated rather than derived: the authorization path's last rung names it, but a
/// root key may sign for itself (an empty path), and a field that is always present beats a
/// special case in every reader. Verification checks the two agree.
///
/// There is deliberately **no timestamp**. The evidence entry already carries the sender's
/// claimed time, and the recipient's transcription carries the recipient's; a third clock in
/// the middle would be one more thing to disagree, and nothing consults it (No Clocks!).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Envelope {
    /// The identity making the claim - the sender's root pubkey, which IS their name.
    pub sender_root: [u8; 32],
    /// The leaf that signed this envelope, authorized under `sender_root` by `auth_path`.
    pub signer: [u8; 32],
    /// Who this is for. Binds the envelope to its target so it cannot be carried to a third
    /// party - load-bearing for kinds whose evidence does not itself name a subject.
    pub recipient_root: [u8; 32],
    /// Which claim this is ([`notice_kind`]).
    pub kind: u32,
    /// `authorize` entries from the sender's root down to `signer`, root first, each as the
    /// author's exact envelope bytes. Empty when the root signed for itself.
    pub auth_path: Vec<Vec<u8>>,
    /// The signed entry that makes the claim checkable, as its author's exact bytes.
    pub evidence: Option<Vec<u8>>,
    /// A first-contact greeting - the one unverifiable field, hence the cap.
    pub greeting: Option<String>,
    /// Proof-of-work stamp. The slot exists from birth and is empty at rest: the dial's
    /// resting position is zero, and a price is only ever quoted by a node under flood
    /// (PROJECT_PLAN, The proof-of-work dial).
    pub stamp: Option<Vec<u8>>,
}

impl Envelope {
    fn check(&self) -> Result<(), ProtoError> {
        if self.auth_path.len() > MAX_AUTH_PATH {
            return Err(ProtoError::BadEntry("authorization path too deep"));
        }
        if self
            .greeting
            .as_ref()
            .is_some_and(|g| g.len() > MAX_GREETING_LEN)
        {
            return Err(ProtoError::BadEntry("greeting too long"));
        }
        Ok(())
    }

    fn encode_body(&self) -> Vec<u8> {
        let mut fields = 4; // sender, signer, recipient, kind
        if !self.auth_path.is_empty() {
            fields += 1;
        }
        fields += u64::from(self.evidence.is_some());
        fields += u64::from(self.greeting.is_some());
        fields += u64::from(self.stamp.is_some());

        let mut w = Writer::new();
        w.map(fields);
        w.uint(0);
        w.bytes(&self.sender_root);
        w.uint(1);
        w.bytes(&self.signer);
        w.uint(2);
        w.bytes(&self.recipient_root);
        w.uint(3);
        w.uint(u64::from(self.kind));
        if !self.auth_path.is_empty() {
            w.uint(4);
            w.array(self.auth_path.len() as u64);
            for rung in &self.auth_path {
                w.bytes(rung);
            }
        }
        if let Some(evidence) = &self.evidence {
            w.uint(5);
            w.bytes(evidence);
        }
        if let Some(greeting) = &self.greeting {
            w.uint(6);
            w.text(greeting);
        }
        if let Some(stamp) = &self.stamp {
            w.uint(7);
            w.bytes(stamp);
        }
        w.into_bytes()
    }

    fn decode_body(bytes: &[u8]) -> Result<Self, ProtoError> {
        let mut r = Reader::new(bytes);
        let mut map = r.int_map()?;
        let mut sender_root: Option<[u8; 32]> = None;
        let mut signer: Option<[u8; 32]> = None;
        let mut recipient_root: Option<[u8; 32]> = None;
        let mut kind: Option<u32> = None;
        let mut auth_path: Vec<Vec<u8>> = Vec::new();
        let mut evidence: Option<Vec<u8>> = None;
        let mut greeting: Option<String> = None;
        let mut stamp: Option<Vec<u8>> = None;
        while let Some(key) = map.next_key()? {
            match key {
                0 => sender_root = Some(map.bytes_fixed::<32>()?),
                1 => signer = Some(map.bytes_fixed::<32>()?),
                2 => recipient_root = Some(map.bytes_fixed::<32>()?),
                3 => {
                    let raw = map.uint()?;
                    kind = Some(
                        u32::try_from(raw).map_err(|_| ProtoError::BadEntry("kind out of range"))?,
                    );
                }
                4 => {
                    let len = map.array()?;
                    if len > MAX_AUTH_PATH as u64 {
                        return Err(ProtoError::BadEntry("authorization path too deep"));
                    }
                    for _ in 0..len {
                        auth_path.push(map.bytes()?.to_vec());
                    }
                }
                5 => evidence = Some(map.bytes()?.to_vec()),
                6 => greeting = Some(map.text()?.to_string()),
                7 => stamp = Some(map.bytes()?.to_vec()),
                _ => map.skip_value()?,
            }
        }
        r.finish()?;

        let out = Self {
            sender_root: sender_root.ok_or(ProtoError::BadEntry("envelope missing sender"))?,
            signer: signer.ok_or(ProtoError::BadEntry("envelope missing signer"))?,
            recipient_root: recipient_root
                .ok_or(ProtoError::BadEntry("envelope missing recipient"))?,
            kind: kind.ok_or(ProtoError::BadEntry("envelope missing kind"))?,
            auth_path,
            evidence,
            greeting,
            stamp,
        };
        out.check()?;
        Ok(out)
    }
}

/// A decoded delivery envelope: the sender's exact bytes plus the parsed view of them.
///
/// The bytes are the artifact - they are what gets hashed (the notice's id, which makes
/// transcription idempotent), stored verbatim inside the recipient's encryption, and verified
/// independently by the recipient's *other* nodes rather than trusted because one node said so.
#[derive(Debug, Clone)]
pub struct SignedEnvelope {
    bytes: Vec<u8>,
    body_start: usize,
    body_len: usize,
    sig: [u8; SIG_LEN],
    hash: [u8; HASH_LEN],
    envelope: Envelope,
}

impl PartialEq for SignedEnvelope {
    fn eq(&self, other: &Self) -> bool {
        self.bytes == other.bytes
    }
}
impl Eq for SignedEnvelope {}

impl SignedEnvelope {
    /// Sign `envelope` with the leaf it declares. Fails if the key is not that leaf - an
    /// envelope signed by a key it does not name should be unrepresentable.
    pub fn create(envelope: &Envelope, key: &SigningKey) -> Result<Self, ProtoError> {
        envelope.check()?;
        if envelope.signer != key.verifying_key().to_bytes() {
            return Err(ProtoError::BadEntry("signing key is not the declared signer"));
        }
        let body = envelope.encode_body();
        let mut preimage = Vec::with_capacity(DOMAIN_ENVELOPE.len() + body.len());
        preimage.extend_from_slice(DOMAIN_ENVELOPE);
        preimage.extend_from_slice(&body);
        let sig = key.sign(&preimage).to_bytes();

        let mut w = Writer::new();
        w.array(2);
        w.bytes(&body);
        w.bytes(&sig);
        let bytes = w.into_bytes();

        // Decode our own output: a free round-trip self-check, and it derives the hash and
        // body range exactly as every other holder of these bytes will.
        Self::decode(&bytes)
    }

    /// Strictly parse an envelope. Rejects non-canonical bytes and anything over the size cap;
    /// does NOT check the signature (see [`SignedEnvelope::verify`]) and does NOT walk the
    /// authorization path (see `verify_claim` in the node's gate).
    pub fn decode(bytes: &[u8]) -> Result<Self, ProtoError> {
        if bytes.len() > MAX_ENVELOPE_BYTES {
            return Err(ProtoError::BadEntry("envelope exceeds size limit"));
        }
        let mut r = Reader::new(bytes);
        if r.array()? != 2 {
            return Err(ProtoError::BadEntry("envelope must be [body, sig]"));
        }
        let body = r.bytes()?;
        let body_len = body.len();
        let body_start = r.position() - body_len;
        let envelope = Envelope::decode_body(body)?;
        let sig = r.bytes_fixed::<SIG_LEN>()?;
        r.finish()?;

        Ok(Self {
            hash: *blake3::hash(bytes).as_bytes(),
            bytes: bytes.to_vec(),
            body_start,
            body_len,
            sig,
            envelope,
        })
    }

    /// Verify the signature against the declared signer, over the domain-separated preimage.
    /// Slices the received bytes; never re-serializes.
    ///
    /// This proves only that the declared leaf signed these bytes. Whether that leaf speaks
    /// for the claimed root is the authorization path's job, and whether the claim is true is
    /// the evidence's - both checked by the node's gate.
    pub fn verify(&self) -> Result<(), ProtoError> {
        let vk = VerifyingKey::from_bytes(&self.envelope.signer)
            .map_err(|_| ProtoError::BadEntry("signer is not a valid ed25519 public key"))?;
        let body = &self.bytes[self.body_start..self.body_start + self.body_len];
        let mut preimage = Vec::with_capacity(DOMAIN_ENVELOPE.len() + body.len());
        preimage.extend_from_slice(DOMAIN_ENVELOPE);
        preimage.extend_from_slice(body);
        vk.verify_strict(&preimage, &Signature::from_bytes(&self.sig))
            .map_err(|_| ProtoError::BadSignature)
    }

    pub fn envelope(&self) -> &Envelope {
        &self.envelope
    }

    /// BLAKE3-256 of the envelope bytes: the notice's id, and what makes a sender who knocks
    /// on all three of your doors produce one row.
    pub fn hash(&self) -> &[u8; HASH_LEN] {
        &self.hash
    }

    /// The sender's exact bytes - stored verbatim, never re-encoded.
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn sig(&self) -> &[u8; SIG_LEN] {
        &self.sig
    }
}

/// What an envelope turned out to prove, once its path and its evidence check out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedClaim {
    pub sender_root: [u8; 32],
    pub signer: [u8; 32],
    pub recipient_root: [u8; 32],
    pub kind: u32,
    /// The evidence entry's hash, so a recipient can recognise the same claim twice.
    pub evidence_hash: [u8; HASH_LEN],
    /// The published bands, for `PUBLIC_EDGE`: what the sender says about the recipient.
    pub trust: Option<String>,
    pub interest: Option<String>,
}

/// Verify an envelope end to end, offline: the signature, the delegation from the claimed
/// root down to the signing leaf, and the evidence that makes the claim checkable.
///
/// ## What the authorization path proves, precisely
///
/// The path is a chain of `authorize` entries, root first: entry *i* is signed by the key that
/// entry *i-1* authorized, and the last one authorizes the leaf that signed the envelope. Each
/// link is one ed25519 verification against the previous link's declared child, so the whole
/// path reduces to: **the root key signed a statement delegating to a key that (transitively)
/// delegated to this signer.** Forging it requires the root's private key, at which point the
/// attacker *is* the identity.
///
/// This is deliberately NOT [`crate::crown::Crown::build`], and the difference is worth stating
/// because the weaker check is the correct one here. `Crown` linearizes each key's whole
/// identity-public chain from genesis, which is what lets it enforce usurper stamps, rank-path
/// seniority, forks and revocation ceilings. That requires shipping every intermediate key's
/// complete chain - key-epoch entries and all - which is kilobytes for a mature persona and
/// blows the envelope budget that keeps a notice storable inside one private record.
///
/// So the gate asks the smaller question it actually needs answered - "may this leaf speak for
/// this root?" - and a signature chain answers it soundly. What is given up, named:
///
/// - **Revocation.** A path cannot show the leaf was not revoked yesterday. Already accepted
///   doctrine ("verifiable-modulo-revocation" - PROJECT_PLAN, Envelopes carry evidence): a
///   notification is not an authorization, and the truth surfaces the moment you answer the
///   door and sync them properly.
/// - **Seniority and forks.** Nothing here ranks keys against each other or notices
///   equivocation. A notice never grants anything, so there is nothing for rank to decide.
///
/// The cost of being wrong is one row in a bounded, prunable list, which is the whole reason
/// this trade is available here and nowhere else in the system.
pub fn verify_claim(signed: &SignedEnvelope) -> Result<VerifiedClaim, ProtoError> {
    signed.verify()?;
    let envelope = signed.envelope();

    // The delegation walk. An empty path means the root signed for itself, which is legal and
    // is what a brand-new persona's founding key does.
    let mut speaks_for = envelope.sender_root;
    for rung in &envelope.auth_path {
        let entry = crate::SignedEntry::decode(rung)?;
        if entry.entry().chain.author != speaks_for {
            return Err(ProtoError::ChainViolation(
                "authorization path is not a chain from the claimed root",
            ));
        }
        if entry.entry().chain.service != crate::registry::service::IDENTITY_PUBLIC
            || entry.entry().entry_type != crate::registry::entry_type::AUTHORIZE
        {
            return Err(ProtoError::ChainViolation(
                "authorization path holds something that is not an authorize entry",
            ));
        }
        entry.verify()?;
        let crate::Payload::Inline(payload) = &entry.entry().payload else {
            return Err(ProtoError::BadEntry("authorize payload must be inline"));
        };
        speaks_for = crate::Authorize::decode(payload)?.child;
    }
    if speaks_for != envelope.signer {
        return Err(ProtoError::ChainViolation(
            "authorization path does not reach the signer",
        ));
    }

    // The evidence: the sender's own signed entry, which must be theirs and must name the
    // recipient. Without this a notice is a bare assertion, and only first-contact gets to be
    // one of those.
    let Some(evidence_bytes) = &envelope.evidence else {
        return Err(ProtoError::BadEntry("notice carries no evidence"));
    };
    let evidence = crate::SignedEntry::decode(evidence_bytes)?;
    if evidence.entry().chain.author != envelope.signer {
        return Err(ProtoError::ChainViolation(
            "evidence was not signed by the envelope's signer",
        ));
    }
    evidence.verify()?;

    let (trust, interest) = match envelope.kind {
        notice_kind::PUBLIC_EDGE => {
            if evidence.entry().chain.service != crate::registry::service::FOLLOWS_PUBLIC
                || evidence.entry().entry_type != crate::registry::entry_type::PUBLIC_EDGE
            {
                return Err(ProtoError::ChainViolation(
                    "a public-edge notice needs a public-edge entry",
                ));
            }
            let crate::Payload::Inline(payload) = &evidence.entry().payload else {
                return Err(ProtoError::BadEntry("public-edge payload must be inline"));
            };
            let edge = crate::PublicEdge::decode(payload)?;
            if edge.subject != envelope.recipient_root {
                return Err(ProtoError::ChainViolation(
                    "the published edge is about somebody else",
                ));
            }
            if edge.trust.is_none() && edge.interest.is_none() {
                // A retraction. Correct to publish, never worth announcing: "I no longer
                // follow you" is an absence, not a notice.
                return Err(ProtoError::BadEntry("the published edge is empty"));
            }
            (edge.trust, edge.interest)
        }
        _ => return Err(ProtoError::BadEntry("unknown notice kind")),
    };

    Ok(VerifiedClaim {
        sender_root: envelope.sender_root,
        signer: envelope.signer,
        recipient_root: envelope.recipient_root,
        kind: envelope.kind,
        evidence_hash: *evidence.hash(),
        trust,
        interest,
    })
}

/// Why a node would not take an envelope.
///
/// The gate's refusal is deliberately coarse. Doctrine (The Inbound Gate): refusal is visible
/// to the sender and leaks exactly one bit - "they are not accepting this from you" - and says
/// nothing about the floor's value or the graph behind it. So every reason the gate might have
/// shares one code, on purpose: distinguishing them would turn a refusal into an oracle.
///
/// **Coarseness was not enough for a block** (2026-08-10). Sharing a code only hides a reason
/// while it has company, and the ring buffer retired the quota check while the floor is still
/// the degenerate pre-Trust classifier - which left `blocked` alone under [`GATE`], where one
/// probe would read it. A block is now answered [`super::DeliverMessage::Accepted`] instead, so
/// it is invisible rather than merely unlabelled; the codes below carry only facts about the
/// *sender* or about *this node*, never about the recipient's opinion of them.
pub mod refusal {
    /// The gate said no - below the floor, over quota - indistinguishable by design.
    ///
    /// **Nothing emits this today** (2026-08-10), and that is the honest state rather than an
    /// oversight: the quota check is gone (the ring buffer), the pre-Trust classifier refuses
    /// nobody, a block answers `Accepted`, and this node's own failures answer
    /// [`super::DeliverMessage::Busy`]. It is kept because below-floor refusal returns with
    /// Trust and *is* a spoken refusal - a fact about the sender's standing, which they may
    /// act on. Until then the door's only refusals are `MALFORMED` and `NOT_SERVED`, both
    /// facts about the envelope or about this node, never about what the recipient thinks.
    pub const GATE: u32 = 0;
    /// The bytes were not a well-formed, correctly-signed envelope with checkable evidence.
    pub const MALFORMED: u32 = 1;
    /// This node does not serve the recipient. (Not a secret: serving records are public.)
    pub const NOT_SERVED: u32 = 2;

    pub fn name(id: u32) -> &'static str {
        match id {
            GATE => "gate",
            MALFORMED => "malformed",
            NOT_SERVED => "not-served",
            _ => "unknown-refusal",
        }
    }
}

/// The messages on a delivery connection: one offer, one answer.
///
/// | tag | message  | fields                        |
/// |-----|----------|-------------------------------|
/// | 0   | Offer    | bstr signed-envelope bytes    |
/// | 1   | Accepted | -                             |
/// | 2   | Refused  | uint reason ([`refusal`])     |
/// | 3   | Busy     | -                             |
///
/// **Accepted means "dealt with", not "shown to a human"** - a notice the recipient discarded
/// because they already follow the sender (the follow-edge rule: evidence they already pull
/// needs no envelope) is accepted, because the sender's job is done and retrying is pointless.
///
/// **The three answers say three different things about whose problem it is**, which is the
/// whole reason [`Busy`](Self::Busy) exists: `Accepted` is the sender's business concluded,
/// `Refused` is a fact about the sender or the envelope that they can act on, and `Busy` is
/// this node admitting *its own* failure - the 500 to the other two's 200 and 4xx. Before it
/// existed, a node whose keystore was briefly locked answered `Refused`, and a refusal is
/// retired forever: our fault, their notice destroyed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeliverMessage {
    Offer(Vec<u8>),
    Accepted,
    Refused(u32),
    /// This node could not judge the offer for reasons of its own. Try again in a bit - and
    /// carrying no detail on purpose, because an internal failure is not the sender's to debug
    /// and its shape is not theirs to learn.
    Busy,
}

const TAG_OFFER: u64 = 0;
const TAG_ACCEPTED: u64 = 1;
const TAG_REFUSED: u64 = 2;
const TAG_BUSY: u64 = 3;

impl DeliverMessage {
    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer::new();
        match self {
            Self::Offer(bytes) => {
                w.array(2);
                w.uint(TAG_OFFER);
                w.bytes(bytes);
            }
            Self::Accepted => {
                w.array(1);
                w.uint(TAG_ACCEPTED);
            }
            Self::Refused(reason) => {
                w.array(2);
                w.uint(TAG_REFUSED);
                w.uint(u64::from(*reason));
            }
            Self::Busy => {
                w.array(1);
                w.uint(TAG_BUSY);
            }
        }
        w.into_bytes()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtoError> {
        if bytes.len() > MAX_DELIVER_FRAME_BYTES {
            return Err(ProtoError::BadEntry("delivery frame exceeds size limit"));
        }
        let mut r = Reader::new(bytes);
        let len = r.array()?;
        if len == 0 {
            return Err(ProtoError::BadEntry("empty delivery message"));
        }
        let tag = r.uint()?;
        let out = match (tag, len) {
            (TAG_OFFER, 2) => Self::Offer(r.bytes()?.to_vec()),
            (TAG_ACCEPTED, 1) => Self::Accepted,
            (TAG_REFUSED, 2) => {
                let raw = r.uint()?;
                Self::Refused(
                    u32::try_from(raw).map_err(|_| ProtoError::BadEntry("reason out of range"))?,
                )
            }
            (TAG_BUSY, 1) => Self::Busy,
            _ => return Err(ProtoError::BadEntry("unknown delivery message")),
        };
        r.finish()?;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::{entry_type, service};
    use crate::{ChainId, Entry, Payload, PublicEdge, SignedEntry, ENTRY_VERSION, ZERO_HASH};

    fn key(seed: u8) -> SigningKey {
        SigningKey::from_bytes(&[seed; 32])
    }

    fn pubkey(k: &SigningKey) -> [u8; 32] {
        k.verifying_key().to_bytes()
    }

    /// One `authorize` entry: `parent` delegating to `child`.
    fn authorize(parent: &SigningKey, child: &SigningKey, seq: u64) -> SignedEntry {
        let payload = crate::Authorize {
            child: pubkey(child),
            usurpers: vec![pubkey(parent)],
            enc_pubkey: None,
        }
        .encode()
        .unwrap();
        SignedEntry::create(
            &Entry {
                v: ENTRY_VERSION,
                entry_type: entry_type::AUTHORIZE,
                chain: ChainId {
                    author: pubkey(parent),
                    service: service::IDENTITY_PUBLIC,
                },
                seq,
                prev_hash: ZERO_HASH,
                timestamp_ms: 1_700_000_000_000,
                payload: Payload::Inline(payload),
            },
            parent,
        )
        .unwrap()
    }

    /// One `public-edge` entry: `signer` publishing bands about `subject`.
    fn public_edge(
        signer: &SigningKey,
        subject: [u8; 32],
        trust: Option<&str>,
        interest: Option<&str>,
    ) -> SignedEntry {
        let payload = PublicEdge {
            subject,
            trust: trust.map(str::to_string),
            interest: interest.map(str::to_string),
        }
        .encode()
        .unwrap();
        SignedEntry::create(
            &Entry {
                v: ENTRY_VERSION,
                entry_type: entry_type::PUBLIC_EDGE,
                chain: ChainId {
                    author: pubkey(signer),
                    service: service::FOLLOWS_PUBLIC,
                },
                seq: 0,
                prev_hash: ZERO_HASH,
                timestamp_ms: 1_700_000_060_000,
                payload: Payload::Inline(payload),
            },
            signer,
        )
        .unwrap()
    }

    /// The ordinary shape: a root, one authorized leaf, and a published follow of `recipient`.
    fn honest_notice(
        root: &SigningKey,
        leaf: &SigningKey,
        recipient: [u8; 32],
    ) -> SignedEnvelope {
        let envelope = Envelope {
            sender_root: pubkey(root),
            signer: pubkey(leaf),
            recipient_root: recipient,
            kind: notice_kind::PUBLIC_EDGE,
            auth_path: vec![authorize(root, leaf, 0).bytes().to_vec()],
            evidence: Some(
                public_edge(leaf, recipient, Some("max"), Some("high"))
                    .bytes()
                    .to_vec(),
            ),
            greeting: None,
            stamp: None,
        };
        SignedEnvelope::create(&envelope, leaf).unwrap()
    }

    fn follow_envelope(signer: &SigningKey) -> Envelope {
        Envelope {
            sender_root: [1u8; 32],
            signer: pubkey(signer),
            recipient_root: [2u8; 32],
            kind: notice_kind::PUBLIC_EDGE,
            auth_path: vec![vec![0xAA; 40]],
            evidence: Some(vec![0xBB; 60]),
            greeting: None,
            stamp: None,
        }
    }

    #[test]
    fn round_trips_and_verifies() {
        let k = key(9);
        let signed = SignedEnvelope::create(&follow_envelope(&k), &k).unwrap();
        signed.verify().unwrap();
        let seen = SignedEnvelope::decode(signed.bytes()).unwrap();
        assert_eq!(seen, signed);
        assert_eq!(seen.envelope(), signed.envelope());
        assert_eq!(seen.hash(), signed.hash(), "the id is the bytes' hash");
    }

    #[test]
    fn the_minimal_envelope_is_a_bare_claim() {
        // First-contact's shape: no evidence, no path (the root signed for itself), a greeting.
        // It round-trips and its signature verifies; `verify_claim` still refuses it, because
        // the one bare-claim KIND does not exist yet.
        let k = key(3);
        let envelope = Envelope {
            sender_root: pubkey(&k),
            signer: pubkey(&k),
            recipient_root: [7u8; 32],
            kind: notice_kind::PUBLIC_EDGE,
            auth_path: vec![],
            evidence: None,
            greeting: Some("it's Dave from the conference".into()),
            stamp: None,
        };
        let signed = SignedEnvelope::create(&envelope, &k).unwrap();
        signed.verify().unwrap();
        assert_eq!(SignedEnvelope::decode(signed.bytes()).unwrap().envelope(), &envelope);
        assert!(verify_claim(&signed).is_err(), "no evidence, no claim");
    }

    #[test]
    fn refuses_to_sign_for_a_key_it_does_not_name() {
        let declared = key(9);
        let impostor = key(10);
        let err = SignedEnvelope::create(&follow_envelope(&declared), &impostor);
        assert!(err.is_err(), "an envelope signed by an unnamed key is unrepresentable");
    }

    #[test]
    fn a_tampered_body_fails_verification() {
        let k = key(9);
        let signed = SignedEnvelope::create(&follow_envelope(&k), &k).unwrap();
        let mut bytes = signed.bytes().to_vec();
        // Flip a byte inside the body (the recipient field's first byte region).
        let i = bytes.len() / 3;
        bytes[i] ^= 0xFF;
        match SignedEnvelope::decode(&bytes) {
            // Either the structure no longer parses, or it parses and the signature fails.
            Err(_) => {}
            Ok(tampered) => assert!(tampered.verify().is_err(), "a changed body must not verify"),
        }
    }

    #[test]
    fn enforces_its_caps() {
        let k = key(9);
        let mut deep = follow_envelope(&k);
        deep.auth_path = vec![vec![0u8; 8]; MAX_AUTH_PATH + 1];
        assert!(SignedEnvelope::create(&deep, &k).is_err(), "path depth is capped");

        let mut chatty = follow_envelope(&k);
        chatty.greeting = Some("w".repeat(MAX_GREETING_LEN + 1));
        assert!(
            SignedEnvelope::create(&chatty, &k).is_err(),
            "the greeting is not a payload channel"
        );
    }

    #[test]
    fn unknown_body_fields_are_skipped_not_fatal() {
        // Additive evolution: a v0 reader must survive a field it has never heard of.
        let k = key(4);
        let mut w = Writer::new();
        w.map(5);
        w.uint(0);
        w.bytes(&[1u8; 32]);
        w.uint(1);
        w.bytes(&k.verifying_key().to_bytes());
        w.uint(2);
        w.bytes(&[2u8; 32]);
        w.uint(3);
        w.uint(u64::from(notice_kind::PUBLIC_EDGE));
        w.uint(99);
        w.text("from the future");
        let body = w.into_bytes();

        let mut preimage = DOMAIN_ENVELOPE.to_vec();
        preimage.extend_from_slice(&body);
        let sig = k.sign(&preimage).to_bytes();
        let mut outer = Writer::new();
        outer.array(2);
        outer.bytes(&body);
        outer.bytes(&sig);

        let signed = SignedEnvelope::decode(&outer.into_bytes()).unwrap();
        signed.verify().unwrap();
        assert_eq!(signed.envelope().kind, notice_kind::PUBLIC_EDGE);
    }

    #[test]
    fn messages_round_trip() {
        for message in [
            DeliverMessage::Offer(vec![1, 2, 3]),
            DeliverMessage::Accepted,
            DeliverMessage::Refused(refusal::GATE),
            DeliverMessage::Busy,
        ] {
            assert_eq!(DeliverMessage::decode(&message.encode()).unwrap(), message);
        }
    }

    /// `Busy` and `Accepted` are both fieldless, so the only thing separating them on the wire
    /// is the tag - and confusing them would turn "try again" into "your job is done", which
    /// loses the notice silently. Cheap to pin, and the mistake it catches is invisible.
    #[test]
    fn busy_is_not_accepted_on_the_wire() {
        assert_ne!(
            DeliverMessage::Busy.encode(),
            DeliverMessage::Accepted.encode()
        );
    }

    #[test]
    fn messages_reject_nonsense() {
        assert!(DeliverMessage::decode(&[]).is_err());
        let mut w = Writer::new();
        w.array(2);
        w.uint(77);
        w.uint(0);
        assert!(DeliverMessage::decode(&w.into_bytes()).is_err(), "unknown tag");
    }

    #[test]
    fn oversize_bytes_die_before_anything_else() {
        // The gate leans on this: a size check runs before any signature verification.
        assert!(SignedEnvelope::decode(&vec![0u8; MAX_ENVELOPE_BYTES + 1]).is_err());
    }

    // ------------------------------------------------------------------------------------
    // verify_claim: the delegation walk and the evidence rule. Every test below is an
    // attacker's attempt except the first two.

    #[test]
    fn an_honest_notice_verifies_and_carries_its_bands() {
        let (root, leaf, recipient) = (key(1), key(2), [9u8; 32]);
        let claim = verify_claim(&honest_notice(&root, &leaf, recipient)).unwrap();
        assert_eq!(claim.sender_root, pubkey(&root));
        assert_eq!(claim.signer, pubkey(&leaf));
        assert_eq!(claim.recipient_root, recipient);
        assert_eq!(claim.trust.as_deref(), Some("max"));
        assert_eq!(claim.interest.as_deref(), Some("high"));
    }

    #[test]
    fn a_root_may_sign_for_itself_with_an_empty_path() {
        // A founding node's key IS the root; an empty path is the honest expression of that.
        let (root, recipient) = (key(5), [8u8; 32]);
        let envelope = Envelope {
            sender_root: pubkey(&root),
            signer: pubkey(&root),
            recipient_root: recipient,
            kind: notice_kind::PUBLIC_EDGE,
            auth_path: vec![],
            evidence: Some(public_edge(&root, recipient, None, Some("low")).bytes().to_vec()),
            greeting: None,
            stamp: None,
        };
        let claim = verify_claim(&SignedEnvelope::create(&envelope, &root).unwrap()).unwrap();
        assert_eq!(claim.interest.as_deref(), Some("low"));
        assert_eq!(claim.trust, None, "an interest-only edge is a follow with no vouch");
    }

    #[test]
    fn a_deep_path_verifies_rung_by_rung() {
        let (root, phone, watch, recipient) = (key(1), key(2), key(3), [9u8; 32]);
        let envelope = Envelope {
            sender_root: pubkey(&root),
            signer: pubkey(&watch),
            recipient_root: recipient,
            kind: notice_kind::PUBLIC_EDGE,
            auth_path: vec![
                authorize(&root, &phone, 0).bytes().to_vec(),
                authorize(&phone, &watch, 0).bytes().to_vec(),
            ],
            evidence: Some(public_edge(&watch, recipient, None, Some("max")).bytes().to_vec()),
            greeting: None,
            stamp: None,
        };
        let claim = verify_claim(&SignedEnvelope::create(&envelope, &watch).unwrap()).unwrap();
        assert_eq!(claim.sender_root, pubkey(&root), "the ROOT is the identity, not the leaf");
        assert_eq!(claim.signer, pubkey(&watch));
    }

    #[test]
    fn a_stranger_cannot_claim_someone_elses_root() {
        // The whole point: Mallory signs everything correctly, but her path starts at HER
        // root, so declaring Alice's root cannot be made to check out.
        let (alice_root, mallory, recipient) = (key(1), key(4), [9u8; 32]);
        let envelope = Envelope {
            sender_root: pubkey(&alice_root), // the lie
            signer: pubkey(&mallory),
            recipient_root: recipient,
            kind: notice_kind::PUBLIC_EDGE,
            auth_path: vec![authorize(&mallory, &mallory, 0).bytes().to_vec()],
            evidence: Some(public_edge(&mallory, recipient, Some("max"), None).bytes().to_vec()),
            greeting: None,
            stamp: None,
        };
        let err = verify_claim(&SignedEnvelope::create(&envelope, &mallory).unwrap());
        assert!(err.is_err(), "a path that does not start at the claimed root is no path");
    }

    #[test]
    fn a_path_that_stops_short_of_the_signer_is_refused() {
        let (root, phone, watch, recipient) = (key(1), key(2), key(3), [9u8; 32]);
        let envelope = Envelope {
            sender_root: pubkey(&root),
            signer: pubkey(&watch),
            recipient_root: recipient,
            // Only the first rung: root -> phone. Nothing authorizes the watch.
            auth_path: vec![authorize(&root, &phone, 0).bytes().to_vec()],
            kind: notice_kind::PUBLIC_EDGE,
            evidence: Some(public_edge(&watch, recipient, None, Some("high")).bytes().to_vec()),
            greeting: None,
            stamp: None,
        };
        assert!(verify_claim(&SignedEnvelope::create(&envelope, &watch).unwrap()).is_err());
    }

    #[test]
    fn a_broken_link_mid_path_is_refused() {
        // root -> phone, then an unrelated key -> watch. The middle does not join up.
        let (root, phone, other, watch, recipient) = (key(1), key(2), key(6), key(3), [9u8; 32]);
        let envelope = Envelope {
            sender_root: pubkey(&root),
            signer: pubkey(&watch),
            recipient_root: recipient,
            kind: notice_kind::PUBLIC_EDGE,
            auth_path: vec![
                authorize(&root, &phone, 0).bytes().to_vec(),
                authorize(&other, &watch, 0).bytes().to_vec(),
            ],
            evidence: Some(public_edge(&watch, recipient, None, Some("high")).bytes().to_vec()),
            greeting: None,
            stamp: None,
        };
        assert!(verify_claim(&SignedEnvelope::create(&envelope, &watch).unwrap()).is_err());
    }

    #[test]
    fn evidence_signed_by_another_key_is_refused() {
        // The path authorizes the watch, but the edge was signed by the phone. Even inside one
        // identity this is refused: one envelope, one signer, one story.
        let (root, phone, watch, recipient) = (key(1), key(2), key(3), [9u8; 32]);
        let envelope = Envelope {
            sender_root: pubkey(&root),
            signer: pubkey(&watch),
            recipient_root: recipient,
            kind: notice_kind::PUBLIC_EDGE,
            auth_path: vec![authorize(&root, &watch, 0).bytes().to_vec()],
            evidence: Some(public_edge(&phone, recipient, None, Some("high")).bytes().to_vec()),
            greeting: None,
            stamp: None,
        };
        assert!(verify_claim(&SignedEnvelope::create(&envelope, &watch).unwrap()).is_err());
    }

    #[test]
    fn an_edge_about_somebody_else_is_refused() {
        // Bob follows Carol, then waves the proof at Alice. The subject check is what stops
        // one genuine act from becoming a notice to everyone.
        let (root, leaf) = (key(1), key(2));
        let envelope = Envelope {
            sender_root: pubkey(&root),
            signer: pubkey(&leaf),
            recipient_root: [9u8; 32], // Alice
            kind: notice_kind::PUBLIC_EDGE,
            auth_path: vec![authorize(&root, &leaf, 0).bytes().to_vec()],
            evidence: Some(
                public_edge(&leaf, [7u8; 32], None, Some("max")).bytes().to_vec(), // about Carol
            ),
            greeting: None,
            stamp: None,
        };
        assert!(verify_claim(&SignedEnvelope::create(&envelope, &leaf).unwrap()).is_err());
    }

    #[test]
    fn a_retraction_is_not_a_notice() {
        let (root, leaf, recipient) = (key(1), key(2), [9u8; 32]);
        let envelope = Envelope {
            sender_root: pubkey(&root),
            signer: pubkey(&leaf),
            recipient_root: recipient,
            kind: notice_kind::PUBLIC_EDGE,
            auth_path: vec![authorize(&root, &leaf, 0).bytes().to_vec()],
            evidence: Some(public_edge(&leaf, recipient, None, None).bytes().to_vec()),
            greeting: None,
            stamp: None,
        };
        assert!(
            verify_claim(&SignedEnvelope::create(&envelope, &leaf).unwrap()).is_err(),
            "'I no longer follow you' is an absence, not an announcement"
        );
    }

    #[test]
    fn the_wrong_sort_of_entry_is_not_evidence() {
        // A profile-set is a perfectly good signed entry and proves nothing about a follow.
        let (root, leaf, recipient) = (key(1), key(2), [9u8; 32]);
        let profile = SignedEntry::create(
            &Entry {
                v: ENTRY_VERSION,
                entry_type: entry_type::PROFILE_SET,
                chain: ChainId {
                    author: pubkey(&leaf),
                    service: service::PROFILE_PUBLIC,
                },
                seq: 0,
                prev_hash: ZERO_HASH,
                timestamp_ms: 1_700_000_000_000,
                payload: Payload::Inline(
                    crate::ProfileSet {
                        field: "name".into(),
                        value: "Mallory".into(),
                    }
                    .encode()
                    .unwrap(),
                ),
            },
            &leaf,
        )
        .unwrap();
        let envelope = Envelope {
            sender_root: pubkey(&root),
            signer: pubkey(&leaf),
            recipient_root: recipient,
            kind: notice_kind::PUBLIC_EDGE,
            auth_path: vec![authorize(&root, &leaf, 0).bytes().to_vec()],
            evidence: Some(profile.bytes().to_vec()),
            greeting: None,
            stamp: None,
        };
        assert!(verify_claim(&SignedEnvelope::create(&envelope, &leaf).unwrap()).is_err());
    }

    #[test]
    fn a_non_authorize_entry_in_the_path_is_refused() {
        // Smuggling a public-edge entry into the delegation walk must not delegate anything.
        let (root, leaf, recipient) = (key(1), key(2), [9u8; 32]);
        let envelope = Envelope {
            sender_root: pubkey(&root),
            signer: pubkey(&leaf),
            recipient_root: recipient,
            kind: notice_kind::PUBLIC_EDGE,
            auth_path: vec![public_edge(&root, recipient, None, Some("max")).bytes().to_vec()],
            evidence: Some(public_edge(&leaf, recipient, None, Some("max")).bytes().to_vec()),
            greeting: None,
            stamp: None,
        };
        assert!(verify_claim(&SignedEnvelope::create(&envelope, &leaf).unwrap()).is_err());
    }

    #[test]
    fn tampered_evidence_fails_its_own_signature() {
        let (root, leaf, recipient) = (key(1), key(2), [9u8; 32]);
        let mut evidence = public_edge(&leaf, recipient, None, Some("low")).bytes().to_vec();
        let i = evidence.len() / 2;
        evidence[i] ^= 0xFF;
        let envelope = Envelope {
            sender_root: pubkey(&root),
            signer: pubkey(&leaf),
            recipient_root: recipient,
            kind: notice_kind::PUBLIC_EDGE,
            auth_path: vec![authorize(&root, &leaf, 0).bytes().to_vec()],
            evidence: Some(evidence),
            greeting: None,
            stamp: None,
        };
        assert!(verify_claim(&SignedEnvelope::create(&envelope, &leaf).unwrap()).is_err());
    }

    #[test]
    fn an_unknown_kind_is_refused_rather_than_guessed() {
        let (root, leaf, recipient) = (key(1), key(2), [9u8; 32]);
        let envelope = Envelope {
            sender_root: pubkey(&root),
            signer: pubkey(&leaf),
            recipient_root: recipient,
            kind: 777,
            auth_path: vec![authorize(&root, &leaf, 0).bytes().to_vec()],
            evidence: Some(public_edge(&leaf, recipient, None, Some("max")).bytes().to_vec()),
            greeting: None,
            stamp: None,
        };
        assert!(verify_claim(&SignedEnvelope::create(&envelope, &leaf).unwrap()).is_err());
    }
}
