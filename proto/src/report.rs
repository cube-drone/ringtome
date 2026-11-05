//! Reports (plans/MODERATION.md, _Reports_): a person asking a moderator they trust to consider
//! an entry for their list.
//!
//! A report rides the delivery lane ([`crate::deliver`]) as an envelope of kind
//! [`notice_kind::REPORT`], signed by the reporter's leaf under their root like any notice - but it
//! is never transcribed onto a chain (Curtis, 2026-11-02: "I don't want moderation to go on any
//! chains, not even the incoming message chain"). The receiving node keeps it in a table, if the
//! moderator takes reports there, and nowhere else.
//!
//! Its evidence is not the reporter's own entry, as a notice's is: it is the [`Report`] below,
//! carrying - when the report is about something someone published - **the author's own signed
//! document header and its authorization path**, so the moderator's node checks, offline, that
//! the author really signed exactly that version ([`crate::fragment::verify_fragment`]). Nothing
//! the reporter made up travels: no text of theirs but the reason, no screenshot. Pictures are
//! named by the hashes inside that signed header, and only ever travel afterwards, over HTTPS,
//! where an upload-scanning layer can see them (plans/SCANNING.md).
//!
//! **A post's pictures are documents of their own**, named in its signed header's `refs`, so a
//! report carries their signed headers too ([`Report::parts`]): as many as the envelope has room
//! for. Each must be one its post names. A node that holds the rest can read them for itself.

use crate::cbor::{Reader, Writer};
use crate::deliver::{notice_kind, walk_auth_path, SignedEnvelope, MAX_AUTH_PATH};
use crate::error::ProtoError;
use crate::fragment::{verify_fragment, VerifiedFragment};
use crate::registry::{DocHeaderPlain, ModerationTarget};
use crate::HASH_LEN;

/// The reason's ceiling, in UTF-8 bytes: an entry's, since a report asks for one.
pub const MAX_REPORT_REASON_BYTES: usize = crate::registry::ModerationEntry::MAX_REASON_BYTES;

/// One published thing a report points at: whose, which document, and the author's own signed
/// header for the version being reported, with the path from their root to the leaf that signed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReportedItem {
    pub author: [u8; 32],
    pub doc_id: [u8; 16],
    pub entry: Vec<u8>,
    pub auth_path: Vec<Vec<u8>>,
}

/// A document the reported item embeds - a post's picture: the author's signed header for it. Its
/// author is the item's. An empty path means the item's own, which is nearly always the same one
/// and would otherwise cost the envelope room for another picture.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReportedPart {
    pub doc_id: [u8; 16],
    pub entry: Vec<u8>,
    pub auth_path: Vec<Vec<u8>>,
}

/// What a report says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    /// What the reporter asks the moderator to list: a persona or a node.
    pub kind: ModerationTarget,
    pub target: [u8; 32],
    /// Why, in the reporter's words - the one thing of theirs a report carries.
    pub reason: String,
    /// "A child is being sexually abused or exploited": the report carries the reference and
    /// nothing else ever follows it - no picture is uploaded, whatever the moderator's node offers.
    pub child_abuse: bool,
    pub item: Option<ReportedItem>,
    /// What the item embeds, as far as the envelope has room: older nodes skip the key.
    pub parts: Vec<ReportedPart>,
}

impl Report {
    fn well_formed(&self) -> Result<(), ProtoError> {
        if self.reason.len() > MAX_REPORT_REASON_BYTES {
            return Err(ProtoError::BadEntry("report reason length"));
        }
        // Pictures are listed from what a moderator holds, not reported by hash: nothing asks a
        // reporter to name one yet.
        if self.kind == ModerationTarget::Picture {
            return Err(ProtoError::BadEntry("report target kind"));
        }
        if let Some(item) = &self.item {
            if item.auth_path.len() > MAX_AUTH_PATH {
                return Err(ProtoError::BadEntry("report item path too deep"));
            }
            // A persona report about something they published is about its author: anything else
            // would let a report name one persona and carry another's words.
            if self.kind == ModerationTarget::Persona && item.author != self.target {
                return Err(ProtoError::ChainViolation("the reported item is somebody else's"));
            }
        }
        if !self.parts.is_empty() && self.item.is_none() {
            return Err(ProtoError::BadEntry("report parts with no item"));
        }
        if self.parts.len() > DocHeaderPlain::MAX_REFS
            || self.parts.iter().any(|p| p.auth_path.len() > MAX_AUTH_PATH)
        {
            return Err(ProtoError::BadEntry("report parts too many or too deep"));
        }
        Ok(())
    }

    pub fn encode(&self) -> Result<Vec<u8>, ProtoError> {
        self.well_formed()?;
        let mut w = Writer::new();
        w.map(
            4 + u64::from(self.child_abuse)
                + u64::from(self.item.is_some())
                + u64::from(!self.parts.is_empty()),
        );
        w.uint(0);
        w.uint(self.kind.code());
        w.uint(1);
        w.bytes(&self.target);
        w.uint(2);
        w.text(&self.reason);
        w.uint(3);
        w.uint(1); // the format's version, so the map can grow
        if self.child_abuse {
            w.uint(4);
            w.uint(1);
        }
        if let Some(item) = &self.item {
            w.uint(5);
            w.array(4);
            w.bytes(&item.author);
            w.bytes(&item.doc_id);
            w.bytes(&item.entry);
            w.array(item.auth_path.len() as u64);
            for rung in &item.auth_path {
                w.bytes(rung);
            }
        }
        if !self.parts.is_empty() {
            w.uint(6);
            w.array(self.parts.len() as u64);
            for part in &self.parts {
                w.array(3);
                w.bytes(&part.doc_id);
                w.bytes(&part.entry);
                w.array(part.auth_path.len() as u64);
                for rung in &part.auth_path {
                    w.bytes(rung);
                }
            }
        }
        Ok(w.into_bytes())
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtoError> {
        let mut r = Reader::new(bytes);
        let mut map = r.int_map()?;
        let mut kind = None;
        let mut target = None;
        let mut reason = None;
        let mut child_abuse = false;
        let mut item = None;
        let mut parts = Vec::new();
        while let Some(k) = map.next_key()? {
            match k {
                0 => {
                    kind = Some(
                        ModerationTarget::from_code(map.uint()?)
                            .ok_or(ProtoError::BadEntry("report target kind"))?,
                    )
                }
                1 => target = Some(map.bytes_fixed::<32>()?),
                2 => reason = Some(map.text()?.to_string()),
                4 => child_abuse = map.uint()? != 0,
                5 => {
                    if map.array()? != 4 {
                        return Err(ProtoError::BadEntry("report item shape"));
                    }
                    let author = map.bytes_fixed::<32>()?;
                    let doc_id = map.bytes_fixed::<16>()?;
                    let entry = map.bytes()?.to_vec();
                    let len = map.array()?;
                    if len > MAX_AUTH_PATH as u64 {
                        return Err(ProtoError::BadEntry("report item path too deep"));
                    }
                    let mut auth_path = Vec::new();
                    for _ in 0..len {
                        auth_path.push(map.bytes()?.to_vec());
                    }
                    item = Some(ReportedItem { author, doc_id, entry, auth_path });
                }
                6 => {
                    let count = map.array()?;
                    if count > DocHeaderPlain::MAX_REFS as u64 {
                        return Err(ProtoError::BadEntry("report parts too many or too deep"));
                    }
                    for _ in 0..count {
                        if map.array()? != 3 {
                            return Err(ProtoError::BadEntry("report part shape"));
                        }
                        let doc_id = map.bytes_fixed::<16>()?;
                        let entry = map.bytes()?.to_vec();
                        let len = map.array()?;
                        if len > MAX_AUTH_PATH as u64 {
                            return Err(ProtoError::BadEntry("report parts too many or too deep"));
                        }
                        let mut auth_path = Vec::new();
                        for _ in 0..len {
                            auth_path.push(map.bytes()?.to_vec());
                        }
                        parts.push(ReportedPart { doc_id, entry, auth_path });
                    }
                }
                _ => map.skip_value()?,
            }
        }
        r.finish()?;
        let out = Self {
            kind: kind.ok_or(ProtoError::BadEntry("report missing kind"))?,
            target: target.ok_or(ProtoError::BadEntry("report missing target"))?,
            reason: reason.ok_or(ProtoError::BadEntry("report missing reason"))?,
            child_abuse,
            item,
            parts,
        };
        out.well_formed()?;
        Ok(out)
    }
}

/// A report whose envelope, delegation and evidence all check out.
#[derive(Clone, Debug)]
pub struct VerifiedReport {
    pub reporter_root: [u8; 32],
    pub moderator_root: [u8; 32],
    /// The envelope's hash: the report's id, so a report delivered twice is one report.
    pub id: [u8; HASH_LEN],
    pub report: Report,
    /// The reported item's header as its author signed it, when the report names one.
    pub item: Option<VerifiedFragment>,
    /// What it embeds, each signed by the same author and named in the item's own header.
    pub parts: Vec<VerifiedFragment>,
}

/// Check a report envelope from its own bytes, with no fetch: the envelope's signature, the
/// reporter's delegation, the report's shape, and - when it names something published - the
/// author's signature over that version.
pub fn verify_report(signed: &SignedEnvelope) -> Result<VerifiedReport, ProtoError> {
    signed.verify()?;
    let envelope = signed.envelope();
    if envelope.kind != notice_kind::REPORT {
        return Err(ProtoError::BadEntry("not a report"));
    }
    walk_auth_path(envelope.sender_root, &envelope.auth_path, envelope.signer)?;
    let bytes = envelope.evidence.as_ref().ok_or(ProtoError::BadEntry("report carries nothing"))?;
    let report = Report::decode(bytes)?;
    if report.kind == ModerationTarget::Persona && report.target == envelope.sender_root {
        return Err(ProtoError::BadEntry("a report about yourself"));
    }
    let item = match &report.item {
        Some(i) => Some(verify_fragment(i.author, i.doc_id, &i.entry, &i.auth_path)?),
        None => None,
    };
    let mut parts = Vec::with_capacity(report.parts.len());
    if let (Some(named), Some(signed)) = (&report.item, &item) {
        for part in &report.parts {
            if !signed.header.refs.contains(&part.doc_id) {
                return Err(ProtoError::ChainViolation("the reported item doesn't embed that"));
            }
            let path = if part.auth_path.is_empty() { &named.auth_path } else { &part.auth_path };
            parts.push(verify_fragment(named.author, part.doc_id, &part.entry, path).or_else(
                |e| {
                    // Empty also means what it says, for a header its root signed itself.
                    if part.auth_path.is_empty() {
                        verify_fragment(named.author, part.doc_id, &part.entry, &[])
                    } else {
                        Err(e)
                    }
                },
            )?);
        }
    }
    Ok(VerifiedReport {
        reporter_root: envelope.sender_root,
        moderator_root: envelope.recipient_root,
        id: *signed.hash(),
        report,
        item,
        parts,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(reason: &str) -> Report {
        Report {
            kind: ModerationTarget::Persona,
            target: [7; 32],
            reason: reason.to_string(),
            child_abuse: false,
            item: None,
            parts: Vec::new(),
        }
    }

    #[test]
    fn a_report_round_trips_and_caps_its_reason_in_bytes() {
        let mut r = report("spam, all of it");
        assert_eq!(Report::decode(&r.encode().unwrap()).unwrap(), r);
        r.child_abuse = true;
        r.item = Some(ReportedItem {
            author: [7; 32],
            doc_id: [3; 16],
            entry: vec![1, 2, 3],
            auth_path: vec![vec![4; 10]],
        });
        assert_eq!(Report::decode(&r.encode().unwrap()).unwrap(), r);
        r.parts = vec![ReportedPart { doc_id: [4; 16], entry: vec![5, 6], auth_path: vec![] }];
        assert_eq!(Report::decode(&r.encode().unwrap()).unwrap(), r);
        assert!(report(&"x".repeat(512)).encode().is_ok());
        assert!(report(&"\u{8bf4}".repeat(171)).encode().is_err(), "513 bytes, 171 characters");
    }

    #[test]
    fn a_persona_report_carries_only_that_persona_s_words() {
        let mut r = report("hers, not his");
        r.item = Some(ReportedItem {
            author: [9; 32],
            doc_id: [3; 16],
            entry: vec![],
            auth_path: vec![],
        });
        assert!(r.encode().is_err());
        r.kind = ModerationTarget::Node;
        assert!(r.encode().is_ok(), "a node's report may carry anyone's words from it");
    }

    fn signed_doc(
        author: &ed25519_dalek::SigningKey,
        doc_id: [u8; 16],
        refs: Vec<[u8; 16]>,
    ) -> Vec<u8> {
        use crate::entry::{ChainId, Entry, Payload, SignedEntry, ENTRY_VERSION, ZERO_HASH};
        let payload = DocHeaderPlain {
            dated_ms: None,
            animation: false,
            im: false,
            part_of: None,
            trusted_only: false,
            settled: false,
            doc_id,
            parents: Vec::new(),
            file_hash: [doc_id[0]; 32],
            body_hash: [doc_id[0]; 32],
            title: "a post".into(),
            format: Some(1),
            width: None,
            height: None,
            duration_ms: None,
            thumb_hash: None,
            preview_hash: None,
            refs,
            genesis_ms: None,
            reply_to: None,
            thread_root: None,
            sealed_title: None,
            seal_of: None,
            onward: false,
            prints: Default::default(),
        }
        .encode()
        .unwrap();
        SignedEntry::create(
            &Entry {
                v: ENTRY_VERSION,
                entry_type: crate::registry::entry_type::DOC_HEADER,
                chain: ChainId {
                    author: author.verifying_key().to_bytes(),
                    service: crate::registry::service::POSTS,
                    instance: None,
                },
                seq: 0,
                prev_hash: ZERO_HASH,
                timestamp_ms: 1_700_000_000_000,
                payload: Payload::Inline(payload),
            },
            author,
        )
        .unwrap()
        .bytes()
        .to_vec()
    }

    #[test]
    fn a_report_can_only_name_what_its_post_embeds() {
        use crate::deliver::Envelope;
        let author = ed25519_dalek::SigningKey::from_bytes(&[1; 32]);
        let reporter = ed25519_dalek::SigningKey::from_bytes(&[2; 32]);
        let author_root = author.verifying_key().to_bytes();
        let (post, embedded, other) = ([10; 16], [20; 16], [30; 16]);
        let with = |doc_id: [u8; 16]| {
            let report = Report {
                kind: ModerationTarget::Persona,
                target: author_root,
                reason: String::new(),
                child_abuse: false,
                item: Some(ReportedItem {
                    author: author_root,
                    doc_id: post,
                    entry: signed_doc(&author, post, vec![embedded]),
                    auth_path: Vec::new(),
                }),
                parts: vec![ReportedPart {
                    doc_id,
                    entry: signed_doc(&author, doc_id, Vec::new()),
                    auth_path: Vec::new(),
                }],
            };
            let root = reporter.verifying_key().to_bytes();
            let envelope = Envelope {
                sender_root: root,
                signer: root,
                recipient_root: [9; 32],
                kind: notice_kind::REPORT,
                auth_path: Vec::new(),
                evidence: Some(report.encode().unwrap()),
                greeting: None,
                stamp: None,
                display_name: None,
            };
            verify_report(&SignedEnvelope::create(&envelope, &reporter).unwrap())
        };
        let verified = with(embedded).expect("the post names it, and its author signed it");
        assert_eq!(verified.parts[0].header.file_hash, [20; 32]);
        assert!(with(other).is_err(), "signed by the author, but not in this post");
    }

    #[test]
    fn a_report_s_parts_belong_to_an_item() {
        let mut r = report("a picture of what");
        r.parts = vec![ReportedPart { doc_id: [4; 16], entry: vec![], auth_path: vec![] }];
        assert!(r.encode().is_err(), "nothing for them to be parts of");
    }
}
