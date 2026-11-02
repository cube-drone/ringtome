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

use crate::cbor::{Reader, Writer};
use crate::deliver::{notice_kind, walk_auth_path, SignedEnvelope, MAX_AUTH_PATH};
use crate::error::ProtoError;
use crate::fragment::{verify_fragment, VerifiedFragment};
use crate::registry::ModerationTarget;
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
}

impl Report {
    fn well_formed(&self) -> Result<(), ProtoError> {
        if self.reason.len() > MAX_REPORT_REASON_BYTES {
            return Err(ProtoError::BadEntry("report reason length"));
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
        Ok(())
    }

    pub fn encode(&self) -> Result<Vec<u8>, ProtoError> {
        self.well_formed()?;
        let mut w = Writer::new();
        w.map(4 + u64::from(self.child_abuse) + u64::from(self.item.is_some()));
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
    Ok(VerifiedReport {
        reporter_root: envelope.sender_root,
        moderator_root: envelope.recipient_root,
        id: *signed.hash(),
        report,
        item,
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
}
