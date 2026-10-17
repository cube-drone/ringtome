//! The ROSTER - one group's membership, folded from its members' lanes (plans/GROUPS.md).
//!
//! A group is a founding statement and the entries its members write on their own chains, one
//! lane per `(device, GROUP, group id)` (plans/GROUPS.md, section 2). Nobody writes anyone
//! else's record, so who is in, who is an owner and what the group is called are a FOLD over
//! every member's lanes - computed from local data alone, with no clock and no coordinator,
//! and the same on every node that holds the same entries, whatever order they arrived in.
//!
//! ## How the pieces line up (plans/GROUPS.md, section 3)
//!
//! 1. **Found.** The founding statement is signed once by a key minted for the group, and its
//!    hash is the group's id - the id proves itself, and nothing needs that key again.
//! 2. **Owners, top-down.** The founder's founding is the root appointment, path `[]`. Every
//!    other appointment's rank path is its appointer's plus the appointment's own place on the
//!    appointer's lane, so owners compare as CROWN keys do: a prefix is senior, and at a
//!    divergence the smaller element is. Appointments are judged in path order, so everything
//!    that can end one - a removal or demotion, which only a strictly senior owner may make -
//!    has been judged before it is.
//! 3. **Anchors end authority.** An act that ends someone's authority says how much of their
//!    lanes it lets stand: per device lane, a seq and the head hash there (CROWN's anchored
//!    revocation, at group scale). Everything past an anchor is void, wherever and whenever it
//!    arrives; a lane the act didn't name stands at nothing. A hostile end (removal, demotion)
//!    ends the appointment's whole subtree; a friendly one (retiring, leaving) ends only the
//!    owner's own, and their appointees keep their rank.
//! 4. **Members, lane by lane.** A lane counts from a join whose grant is valid until the
//!    persona leaves or a removal's anchor cuts it. A join past a removal's anchor counts only
//!    under an invite that readmits that removal - and a ban's, only once an owner has lifted
//!    the ban.
//! 5. **Registers.** A setting or a hide names the one it replaces; concurrent heads are settled
//!    by the senior owner's, then the smaller entry hash.
//!
//! ## What this module is not
//!
//! Not the chain layer. Lanes arrive verified and linear - signatures checked, each device
//! proven a key of its persona by that persona's CROWN, forks resolved by the chain machinery
//! every service shares - and the entries arrive decoded. The wire encoding of [`GroupEntry`]
//! is slice 1b's.
use std::collections::{BTreeMap, BTreeSet};

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};

use crate::cbor::{Reader, Writer};
use crate::error::ProtoError;

/// A persona's root key.
pub type Root = [u8; 32];
/// One computer's key: a lane is one device's chain for the group.
pub type Device = [u8; 32];
/// An entry's hash.
pub type Hash = [u8; 32];
/// A group's id: the chain instance its lanes carry, so 16 bytes, like a room's.
pub type GroupId = [u8; 16];
/// An owner's rank path: one `(seq, device)` per appointment from the founder down - where on
/// the appointer's lane the appointment was made. Lexicographic; a prefix is senior.
pub type Path = Vec<(u64, Device)>;

/// Signature domain for a founding statement, distinct from every entry's.
pub const DOMAIN_FOUNDING: &[u8] = b"ringtome-v0/group-founding";

/// The founding statement: the group's name and its first owner, signed by a key minted for
/// the group and used for nothing else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Founding {
    pub founder: Root,
    pub name: String,
    pub group_key: [u8; 32],
    pub sig: [u8; 64],
}

impl Founding {
    fn preimage(group_key: &[u8; 32], founder: &Root, name: &str) -> Vec<u8> {
        let mut p = Vec::with_capacity(DOMAIN_FOUNDING.len() + 64 + name.len());
        p.extend_from_slice(DOMAIN_FOUNDING);
        p.extend_from_slice(group_key);
        p.extend_from_slice(founder);
        p.extend_from_slice(name.as_bytes());
        p
    }

    /// Found a group: `key` is the group's own, minted for this and nothing after.
    pub fn sign(key: &SigningKey, founder: Root, name: &str) -> Self {
        let group_key = key.verifying_key().to_bytes();
        let sig = key.sign(&Self::preimage(&group_key, &founder, name)).to_bytes();
        Self { founder, name: name.to_string(), group_key, sig }
    }

    pub fn verify(&self) -> bool {
        let Ok(key) = VerifyingKey::from_bytes(&self.group_key) else { return false };
        key.verify(
            &Self::preimage(&self.group_key, &self.founder, &self.name),
            &Signature::from_bytes(&self.sig),
        )
        .is_ok()
    }

    /// The statement's hash: what the founder's acts cite as their authority.
    pub fn hash(&self) -> Hash {
        let mut p = Self::preimage(&self.group_key, &self.founder, &self.name);
        p.extend_from_slice(&self.sig);
        *blake3::hash(&p).as_bytes()
    }

    /// The group's id: the statement's hash, cut to an instance's 16 bytes. Of the STATEMENT,
    /// not of the entry carrying it - that entry's chain is keyed by this id.
    pub fn id(&self) -> GroupId {
        self.hash()[..16].try_into().expect("16 of 32")
    }
}

/// How much of one device's lane an act lets stand: through `seq`, whose entry is `head_hash`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LaneAnchor {
    pub device: Device,
    pub seq: u64,
    pub head_hash: Hash,
}

/// What a join stands on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Grant {
    /// The founder, on any of their computers.
    Founder,
    /// Another computer of a member: cites that persona's own earlier join.
    Device(Hash),
    /// An owner's invite naming this persona.
    Invite(Hash),
    /// An owner's link token.
    Link(Hash),
    /// An owner's appointment of this persona: taking it up is joining.
    Appointment(Hash),
    /// The setting that opened the group (ruling 4). Cited, so closing the group voids only
    /// the joins the closing write didn't accept - never the ones it saw.
    Open(Hash),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum JoinMode {
    InviteOnly,
    Open,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Setting {
    Name(String),
    Description(String),
    JoinMode(JoinMode),
    /// The group's face (Curtis, 2026-10-16): its picture and its banner, each a media document
    /// on the setting owner's own lane for the group - `None`, back to none.
    Picture(Option<[u8; 16]>),
    Banner(Option<[u8; 16]>),
    /// The group's standing room (plans/GROUP_ROOMS.md; Curtis, 2026-10-16: "when a group is
    /// created a default #general is founded"): a room post in the group, by its author and doc.
    Room(Option<(Root, [u8; 16])>),
}

impl Setting {
    fn kind(&self) -> u8 {
        match self {
            Setting::Name(_) => 0,
            Setting::Description(_) => 1,
            Setting::JoinMode(_) => 2,
            Setting::Picture(_) => 3,
            Setting::Banner(_) => 4,
            Setting::Room(_) => 5,
        }
    }
}

/// One entry on a member's lane. The owner acts carry `by`: the appointment they act under,
/// or the founding for the founder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupEntry {
    Found(Founding),
    Join {
        grant: Grant,
    },
    /// Leaving, from every computer at once: `anchors` covers the persona's other lanes. It
    /// ends membership only: an owner leaving writes a [`GroupEntry::Retire`] first, because a
    /// leave names no appointment and so can't say which it ends - one made after a rejoin
    /// isn't among them.
    Leave {
        anchors: Vec<LaneAnchor>,
    },
    /// A document on the lane - a post's version (`DOC_HEADER`) or its takedown
    /// (`POST_RETRACT`), each its own entry type on the wire, never a group entry's kind. The
    /// fold sees it as content: counted while its author is a member at that point of the
    /// lane, like everything else on it (plans/GROUPS.md, section 7: a group post is a
    /// document like any other post).
    Document {
        doc: [u8; 16],
        retract: bool,
    },
    /// A label on a group post - a tag, a description, a mention (plans/GROUPS.md, section 7) -
    /// as a `PUBLIC_ANNOTATION` entry on the lane, never a group entry's kind. Counted like any
    /// entry: while its author is a member at that point of the lane.
    Label {
        doc: [u8; 16],
    },
    /// An invite carries the group's founding statement, so it says on its own which group it
    /// is for, who founded it and what it was called: an invitee's node that has never heard
    /// of the group finds it from the invite alone (plans/GROUPS.md, section 5). An invite
    /// whose founding isn't this group's opens nothing.
    Invite {
        by: Hash,
        invitee: Root,
        readmits: Vec<Hash>,
        founding: Founding,
    },
    Link {
        by: Hash,
        token: [u8; 16],
    },
    /// Revoking a link names the joins under it that stand (section 3, rule 6).
    Unlink {
        by: Hash,
        link: Hash,
        accepted: Vec<Hash>,
    },
    Appoint {
        by: Hash,
        appointee: Root,
    },
    /// Stepping down from the appointment `by`; `anchors` covers the owner's other lanes.
    Retire {
        by: Hash,
        anchors: Vec<LaneAnchor>,
    },
    /// Taking ownership away: `ends` names the target's appointments, `anchors` their lanes and
    /// the lanes of every owner beneath them.
    Demote {
        by: Hash,
        target: Root,
        ends: Vec<Hash>,
        anchors: Vec<LaneAnchor>,
    },
    /// A demotion that also takes the target out of the group; a ban refuses them back.
    Remove {
        by: Hash,
        target: Root,
        ends: Vec<Hash>,
        anchors: Vec<LaneAnchor>,
        ban: bool,
    },
    Unban {
        by: Hash,
        ban: Hash,
    },
    /// `replaces` names every head the writer saw, so one write settles a conflict. A write
    /// that replaces an opening of the group lists the joins under it that stand, as revoking
    /// a link does (`accepted`); empty otherwise.
    Set {
        by: Hash,
        setting: Setting,
        replaces: Vec<Hash>,
        accepted: Vec<Hash>,
    },
    Hide {
        by: Hash,
        post: Hash,
        hidden: bool,
        replaces: Vec<Hash>,
    },
    /// An owner's pin on a post, or its taking away (plans/GROUPS.md, slice 4d; Curtis,
    /// 2026-10-15): a register per post, named by its first version's hash as a hide is, and
    /// settled as a hide is - the heads no counted write replaces, the senior's winning. Owners'
    /// pins show above members'.
    Pin {
        by: Hash,
        post: Hash,
        pinned: bool,
        replaces: Vec<Hash>,
    },
    /// A member's pin on any post, or its taking away - anyone's, since members unpin each other's
    /// (Curtis, 2026-10-15/16): a member's own act, counted while they're in the group, as a post
    /// or a label is. Members have no seniority, so concurrent heads settle by their hashes - the
    /// same answer on every node.
    MemberPin {
        post: Hash,
        pinned: bool,
        replaces: Vec<Hash>,
    },
}

impl GroupEntry {
    fn by(&self) -> Option<&Hash> {
        match self {
            GroupEntry::Invite { by, .. }
            | GroupEntry::Link { by, .. }
            | GroupEntry::Unlink { by, .. }
            | GroupEntry::Appoint { by, .. }
            | GroupEntry::Retire { by, .. }
            | GroupEntry::Demote { by, .. }
            | GroupEntry::Remove { by, .. }
            | GroupEntry::Unban { by, .. }
            | GroupEntry::Set { by, .. }
            | GroupEntry::Hide { by, .. }
            | GroupEntry::Pin { by, .. } => Some(by),
            GroupEntry::Found(_)
            | GroupEntry::Join { .. }
            | GroupEntry::Leave { .. }
            | GroupEntry::Document { .. }
            | GroupEntry::Label { .. }
            | GroupEntry::MemberPin { .. } => None,
        }
    }
}

impl GroupEntry {
    /// The most anchors one entry carries: a removal's are the target's device lanes plus every
    /// owner beneath them, which a group with more owners than this has outgrown.
    pub const MAX_ANCHORS: usize = 256;
    /// The most hashes in one list (ends, readmits, accepted, replaces).
    pub const MAX_HASHES: usize = 256;
    /// A group's name, at most.
    pub const MAX_NAME_BYTES: usize = 128;
    /// A group's description, at most.
    pub const MAX_DESCRIPTION_BYTES: usize = 2048;

    /// Encoding: an integer-keyed map, `0` the kind and every other key one field, the same key
    /// for the same field in every kind - `{0: kind, 1: by, 2: who, 3: anchors, 4: ends,
    /// 5: readmits, 6: accepted, 7: replaces, 8: flag, 9: grant, 10: id16, 11: ref,
    /// 12: setting, 13: name, 14: group key, 15: sig}`. A list or a flag that is empty or
    /// false is absent. An anchor is `[device, seq, head]`; a grant `[kind]` or `[kind, hash]`;
    /// a setting `[kind, value]`. Kind 3 is unused: slice 1b's stand-in post, never released,
    /// gone now that a group post is a document. [`GroupEntry::Document`] has no kind and
    /// refuses to encode.
    pub fn encode(&self) -> Result<Vec<u8>, ProtoError> {
        enum V<'a> {
            U(u64),
            B(&'a [u8]),
            T(&'a str),
            Anchors(&'a [LaneAnchor]),
            Hashes(&'a [Hash]),
            Grant(&'a Grant),
            Setting(&'a Setting),
        }
        let mut f: Vec<(u64, V)> = Vec::new();
        macro_rules! list {
            ($key:expr, $list:expr) => {{
                if $list.len() > Self::MAX_HASHES {
                    return Err(ProtoError::BadEntry("a group entry's list is too long"));
                }
                if !$list.is_empty() {
                    f.push(($key, V::Hashes($list)));
                }
            }};
        }
        macro_rules! anchors {
            ($list:expr) => {{
                if $list.len() > Self::MAX_ANCHORS {
                    return Err(ProtoError::BadEntry("a group entry carries too many anchors"));
                }
                if !$list.is_empty() {
                    f.push((3, V::Anchors($list)));
                }
            }};
        }
        let kind: u64 = match self {
            GroupEntry::Found(found) => {
                if found.name.is_empty() || found.name.len() > Self::MAX_NAME_BYTES {
                    return Err(ProtoError::BadEntry("a group's name is one line"));
                }
                f.push((2, V::B(&found.founder)));
                f.push((13, V::T(&found.name)));
                f.push((14, V::B(&found.group_key)));
                f.push((15, V::B(&found.sig)));
                0
            }
            GroupEntry::Join { grant } => {
                f.push((9, V::Grant(grant)));
                1
            }
            GroupEntry::Leave { anchors } => {
                anchors!(anchors);
                2
            }
            GroupEntry::Document { .. } => {
                return Err(ProtoError::BadEntry(
                    "a group document travels as a document entry, not a group entry",
                ));
            }
            GroupEntry::Label { .. } => {
                return Err(ProtoError::BadEntry(
                    "a group post's label travels as an annotation entry, not a group entry",
                ));
            }
            GroupEntry::Invite { by, invitee, readmits, founding } => {
                f.push((1, V::B(by)));
                f.push((2, V::B(invitee)));
                list!(5, readmits);
                f.push((13, V::T(&founding.name)));
                f.push((14, V::B(&founding.group_key)));
                f.push((15, V::B(&founding.sig)));
                f.push((16, V::B(&founding.founder)));
                4
            }
            GroupEntry::Link { by, token } => {
                f.push((1, V::B(by)));
                f.push((10, V::B(token)));
                5
            }
            GroupEntry::Unlink { by, link, accepted } => {
                f.push((1, V::B(by)));
                list!(6, accepted);
                f.push((11, V::B(link)));
                6
            }
            GroupEntry::Appoint { by, appointee } => {
                f.push((1, V::B(by)));
                f.push((2, V::B(appointee)));
                7
            }
            GroupEntry::Retire { by, anchors } => {
                f.push((1, V::B(by)));
                anchors!(anchors);
                8
            }
            GroupEntry::Demote { by, target, ends, anchors } => {
                f.push((1, V::B(by)));
                f.push((2, V::B(target)));
                anchors!(anchors);
                list!(4, ends);
                9
            }
            GroupEntry::Remove { by, target, ends, anchors, ban } => {
                f.push((1, V::B(by)));
                f.push((2, V::B(target)));
                anchors!(anchors);
                list!(4, ends);
                if *ban {
                    f.push((8, V::U(1)));
                }
                10
            }
            GroupEntry::Unban { by, ban } => {
                f.push((1, V::B(by)));
                f.push((11, V::B(ban)));
                11
            }
            GroupEntry::Set { by, setting, replaces, accepted } => {
                match setting {
                    Setting::Name(n) if n.is_empty() || n.len() > Self::MAX_NAME_BYTES => {
                        return Err(ProtoError::BadEntry("a group's name is one line"));
                    }
                    Setting::Description(d) if d.len() > Self::MAX_DESCRIPTION_BYTES => {
                        return Err(ProtoError::BadEntry("a group's description is too long"));
                    }
                    _ => {}
                }
                f.push((1, V::B(by)));
                list!(6, accepted);
                list!(7, replaces);
                f.push((12, V::Setting(setting)));
                12
            }
            GroupEntry::Hide { by, post, hidden, replaces } => {
                f.push((1, V::B(by)));
                list!(7, replaces);
                if *hidden {
                    f.push((8, V::U(1)));
                }
                f.push((11, V::B(post)));
                13
            }
            GroupEntry::Pin { by, post, pinned, replaces } => {
                f.push((1, V::B(by)));
                list!(7, replaces);
                if *pinned {
                    f.push((8, V::U(1)));
                }
                f.push((11, V::B(post)));
                14
            }
            GroupEntry::MemberPin { post, pinned, replaces } => {
                list!(7, replaces);
                if *pinned {
                    f.push((8, V::U(1)));
                }
                f.push((11, V::B(post)));
                15
            }
        };
        f.push((0, V::U(kind)));
        f.sort_by_key(|(k, _)| *k);
        let mut w = Writer::new();
        w.map(f.len() as u64);
        for (key, value) in f {
            w.uint(key);
            match value {
                V::U(u) => w.uint(u),
                V::B(b) => w.bytes(b),
                V::T(t) => w.text(t),
                V::Anchors(list) => {
                    w.array(list.len() as u64);
                    for a in list {
                        w.array(3);
                        w.bytes(&a.device);
                        w.uint(a.seq);
                        w.bytes(&a.head_hash);
                    }
                }
                V::Hashes(list) => {
                    w.array(list.len() as u64);
                    for h in list {
                        w.bytes(h);
                    }
                }
                V::Grant(g) => {
                    let (k, h): (u64, Option<&Hash>) = match g {
                        Grant::Founder => (0, None),
                        Grant::Device(h) => (1, Some(h)),
                        Grant::Invite(h) => (2, Some(h)),
                        Grant::Link(h) => (3, Some(h)),
                        Grant::Appointment(h) => (4, Some(h)),
                        Grant::Open(h) => (5, Some(h)),
                    };
                    w.array(if h.is_some() { 2 } else { 1 });
                    w.uint(k);
                    if let Some(h) = h {
                        w.bytes(h);
                    }
                }
                V::Setting(s) => {
                    w.array(2);
                    match s {
                        Setting::Name(n) => {
                            w.uint(0);
                            w.text(n);
                        }
                        Setting::Description(d) => {
                            w.uint(1);
                            w.text(d);
                        }
                        Setting::JoinMode(m) => {
                            w.uint(2);
                            w.uint(match m {
                                JoinMode::InviteOnly => 0,
                                JoinMode::Open => 1,
                            });
                        }
                        // A document id, or empty bytes for none.
                        Setting::Picture(d) | Setting::Banner(d) => {
                            w.uint(if matches!(s, Setting::Picture(_)) { 3 } else { 4 });
                            w.bytes(d.as_ref().map_or(&[][..], |d| &d[..]));
                        }
                        // The room's author and doc, 48 bytes, or empty bytes for none.
                        Setting::Room(room) => {
                            w.uint(5);
                            let mut b = Vec::with_capacity(48);
                            if let Some((author, doc)) = room {
                                b.extend_from_slice(author);
                                b.extend_from_slice(doc);
                            }
                            w.bytes(&b);
                        }
                    }
                }
            }
        }
        Ok(w.into_bytes())
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtoError> {
        let bad = ProtoError::BadEntry;
        let mut r = Reader::new(bytes);
        let mut map = r.int_map()?;
        let mut kind: Option<u64> = None;
        let (mut by, mut who, mut link_ref) = (None, None, None);
        let mut anchors: Vec<LaneAnchor> = Vec::new();
        let (mut ends, mut readmits, mut accepted, mut replaces) =
            (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let mut flag = false;
        let mut grant: Option<Grant> = None;
        let mut id16: Option<[u8; 16]> = None;
        let mut setting: Option<Setting> = None;
        let (mut name, mut group_key, mut sig, mut founder) = (None, None, None, None);
        while let Some(key) = map.next_key()? {
            let hash_list = |map: &mut crate::cbor::MapReader<'_, '_>| {
                let len = map.array()?;
                if len > Self::MAX_HASHES as u64 {
                    return Err(bad("a group entry's list is too long"));
                }
                (0..len).map(|_| map.bytes_fixed::<32>()).collect::<Result<Vec<Hash>, _>>()
            };
            match key {
                0 => kind = Some(map.uint()?),
                1 => by = Some(map.bytes_fixed::<32>()?),
                2 => who = Some(map.bytes_fixed::<32>()?),
                3 => {
                    let len = map.array()?;
                    if len > Self::MAX_ANCHORS as u64 {
                        return Err(bad("a group entry carries too many anchors"));
                    }
                    for _ in 0..len {
                        if map.array()? != 3 {
                            return Err(bad("an anchor is [device, seq, head]"));
                        }
                        anchors.push(LaneAnchor {
                            device: map.bytes_fixed::<32>()?,
                            seq: map.uint()?,
                            head_hash: map.bytes_fixed::<32>()?,
                        });
                    }
                }
                4 => ends = hash_list(&mut map)?,
                5 => readmits = hash_list(&mut map)?,
                6 => accepted = hash_list(&mut map)?,
                7 => replaces = hash_list(&mut map)?,
                8 => flag = map.uint()? == 1,
                9 => {
                    let arity = map.array()?;
                    let k = map.uint()?;
                    let h = if arity == 2 { Some(map.bytes_fixed::<32>()?) } else { None };
                    grant = Some(match (k, h) {
                        (0, None) => Grant::Founder,
                        (1, Some(h)) => Grant::Device(h),
                        (2, Some(h)) => Grant::Invite(h),
                        (3, Some(h)) => Grant::Link(h),
                        (4, Some(h)) => Grant::Appointment(h),
                        (5, Some(h)) => Grant::Open(h),
                        _ => return Err(bad("unknown join grant")),
                    });
                }
                10 => id16 = Some(map.bytes_fixed::<16>()?),
                11 => link_ref = Some(map.bytes_fixed::<32>()?),
                12 => {
                    if map.array()? != 2 {
                        return Err(bad("a setting is [kind, value]"));
                    }
                    setting = Some(match map.uint()? {
                        0 => Setting::Name(map.text()?.to_string()),
                        1 => Setting::Description(map.text()?.to_string()),
                        2 => Setting::JoinMode(match map.uint()? {
                            0 => JoinMode::InviteOnly,
                            1 => JoinMode::Open,
                            _ => return Err(bad("unknown join mode")),
                        }),
                        k @ (3 | 4) => {
                            let doc = match map.bytes()? {
                                [] => None,
                                b => Some(
                                    <[u8; 16]>::try_from(b)
                                        .map_err(|_| bad("a group's picture is a document id"))?,
                                ),
                            };
                            if k == 3 {
                                Setting::Picture(doc)
                            } else {
                                Setting::Banner(doc)
                            }
                        }
                        5 => Setting::Room(match map.bytes()? {
                            [] => None,
                            b if b.len() == 48 => {
                                let (author, doc) = b.split_at(32);
                                Some((
                                    author.try_into().map_err(|_| bad("a room's author"))?,
                                    doc.try_into().map_err(|_| bad("a room's doc"))?,
                                ))
                            }
                            _ => return Err(bad("a group's room is an author and a document")),
                        }),
                        _ => return Err(bad("unknown group setting")),
                    });
                }
                13 => name = Some(map.text()?.to_string()),
                14 => group_key = Some(map.bytes_fixed::<32>()?),
                15 => sig = Some(map.bytes_fixed::<64>()?),
                16 => founder = Some(map.bytes_fixed::<32>()?),
                _ => map.skip_value()?,
            }
        }
        r.finish()?;
        let need = |v: Option<Hash>| v.ok_or(bad("a group entry is missing a field"));
        let entry = match kind.ok_or(bad("a group entry names no kind"))? {
            0 => GroupEntry::Found(Founding {
                founder: need(who)?,
                name: name.ok_or(bad("a founding names the group"))?,
                group_key: need(group_key)?,
                sig: sig.ok_or(bad("a founding is signed"))?,
            }),
            1 => GroupEntry::Join { grant: grant.ok_or(bad("a join names its grant"))? },
            2 => GroupEntry::Leave { anchors },
            4 => GroupEntry::Invite {
                by: need(by)?,
                invitee: need(who)?,
                readmits,
                founding: Founding {
                    founder: need(founder)?,
                    name: name.ok_or(bad("an invite names its group"))?,
                    group_key: need(group_key)?,
                    sig: sig.ok_or(bad("an invite's founding is signed"))?,
                },
            },
            5 => GroupEntry::Link { by: need(by)?, token: id16.ok_or(bad("a link has a token"))? },
            6 => GroupEntry::Unlink { by: need(by)?, link: need(link_ref)?, accepted },
            7 => GroupEntry::Appoint { by: need(by)?, appointee: need(who)? },
            8 => GroupEntry::Retire { by: need(by)?, anchors },
            9 => GroupEntry::Demote { by: need(by)?, target: need(who)?, ends, anchors },
            10 => {
                GroupEntry::Remove { by: need(by)?, target: need(who)?, ends, anchors, ban: flag }
            }
            11 => GroupEntry::Unban { by: need(by)?, ban: need(link_ref)? },
            12 => GroupEntry::Set {
                by: need(by)?,
                setting: setting.ok_or(bad("a setting names what it sets"))?,
                replaces,
                accepted,
            },
            13 => GroupEntry::Hide { by: need(by)?, post: need(link_ref)?, hidden: flag, replaces },
            14 => GroupEntry::Pin { by: need(by)?, post: need(link_ref)?, pinned: flag, replaces },
            15 => GroupEntry::MemberPin { post: need(link_ref)?, pinned: flag, replaces },
            _ => return Err(bad("unknown group entry kind")),
        };
        // One accepted byte form: what decodes must encode back to the same bytes.
        if entry.encode()? != bytes {
            return Err(bad("a group entry is not in its canonical form"));
        }
        Ok(entry)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaneEntry {
    pub seq: u64,
    pub hash: Hash,
    pub body: GroupEntry,
}

/// One device's lane, verified and linear, entries in seq order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lane {
    pub persona: Root,
    pub device: Device,
    pub entries: Vec<LaneEntry>,
}

/// One appointment, as the fold judged it: the founder's founding is the root, path `[]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Appointment {
    pub persona: Root,
    pub path: Path,
    /// The appointment it was made under; none for the founding.
    pub parent: Option<Hash>,
    /// Not ended by a demotion, a removal or a retirement: what an owner acts under now.
    pub standing: bool,
}

/// The fold's verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Roster {
    pub id: GroupId,
    pub founder: Root,
    /// Everyone in the group now.
    pub members: BTreeSet<Root>,
    /// Owners now, each by their most senior standing appointment's path.
    pub owners: BTreeMap<Root, Path>,
    pub name: String,
    pub description: String,
    pub join_mode: JoinMode,
    /// The group's face (Curtis, 2026-10-16): its picture and banner, media documents on an
    /// owner's lane - and every document a face setting that counts has ever named, which is
    /// the face's and never a post.
    pub picture: Option<[u8; 16]>,
    pub banner: Option<[u8; 16]>,
    pub face_docs: BTreeSet<[u8; 16]>,
    /// The standing room (#general): a room post in the group, by its author and doc.
    pub room: Option<(Root, [u8; 16])>,
    /// Every entry that counts. Anything held and not here is void.
    pub counted: BTreeSet<Hash>,
    /// The document versions that count (each a `DOC_HEADER` entry's hash), and of those, the
    /// ones an owner has hidden.
    pub posts: BTreeSet<Hash>,
    pub hidden: BTreeSet<Hash>,
    /// The posts pinned (slice 4d), by first version as a hide names them: by an owner, shown
    /// first, and by a member - a post an owner pinned is in the owners' set alone.
    pub owner_pins: BTreeSet<Hash>,
    pub member_pins: BTreeSet<Hash>,
    /// Personas under a ban no owner has lifted.
    pub banned: BTreeSet<Root>,
    /// Personas an invite that counts names, not yet in the group and not banned: whose nodes
    /// the group's door opens to, so they can fetch what they're joining.
    pub invited: BTreeSet<Root>,
    /// Every appointment that counts, by its hash - the founding's under the founding hash.
    pub appointments: BTreeMap<Hash, Appointment>,
}

impl Roster {
    /// The appointment `who` acts under now: their most senior standing one.
    pub fn acting_as(&self, who: &Root) -> Option<Hash> {
        self.appointments
            .iter()
            .filter(|(_, a)| a.persona == *who && a.standing)
            .min_by(|a, b| a.1.path.cmp(&b.1.path))
            .map(|(h, _)| *h)
    }

    /// Every persona holding an appointment beneath `appointment`, however deep - whose lanes a
    /// hostile end anchors too.
    pub fn beneath(&self, appointment: &Hash) -> BTreeSet<Root> {
        let mut out = BTreeSet::new();
        let mut frontier = vec![*appointment];
        while let Some(at) = frontier.pop() {
            for (h, a) in &self.appointments {
                if a.parent == Some(at) {
                    out.insert(a.persona);
                    frontier.push(*h);
                }
            }
        }
        out
    }
}

/// Through which seq a lane stands under some anchors: `None` is nothing at all.
type Ceiling = Option<u64>;

fn stands(seq: u64, ceiling: Ceiling) -> bool {
    ceiling.is_some_and(|c| seq <= c)
}

/// The ceiling `anchors` put on `lane`. Unnamed, nothing stands. Named, the prefix through the
/// anchor's seq stands - if the entry held there is the one named. A different entry there is a
/// fork or a forgery, and fails closed: nothing stands (CROWN's rule - a duplicated key can sign
/// a fresh prefix under any seq, so the seq alone proves nothing). An anchor past what's held is
/// taken at its word until the lane catches up, which it can only do by meeting the hash.
fn ceiling_of(lane: &Lane, anchors: &[LaneAnchor]) -> Ceiling {
    let anchor = anchors.iter().find(|a| a.device == lane.device)?;
    match lane.entries.iter().find(|e| e.seq == anchor.seq) {
        Some(e) if e.hash == anchor.head_hash => Some(anchor.seq),
        Some(_) => None,
        None if lane.entries.last().is_none_or(|e| e.seq < anchor.seq) => Some(anchor.seq),
        None => None, // a gap where the anchor sits: fail closed
    }
}

struct Appt {
    persona: Root,
    path: Path,
    parent: Option<Hash>,
}

/// An act ending appointments: hostile ends the named appointments and everything beneath them,
/// friendly ends the owner's own and nothing beneath.
struct Ending {
    hostile: bool,
    target: Root,
    ends: BTreeSet<Hash>,
    anchors: Vec<LaneAnchor>,
    /// For a friendly end, the lane it was written on and where: that lane stands through it.
    at: Option<(Device, u64)>,
}

struct Removal {
    hash: Hash,
    target: Root,
    anchors: Vec<LaneAnchor>,
    ban: bool,
}

/// A register write (a setting or a hide) that counts, with its author's rank.
struct Write<'a> {
    hash: Hash,
    path: &'a Path,
    replaces: Vec<Hash>,
}

/// The register's value: the heads no counted write replaces, the senior's winning.
fn head(writes: &[Write]) -> Option<Hash> {
    let replaced: BTreeSet<Hash> = writes.iter().flat_map(|w| w.replaces.iter().copied()).collect();
    writes
        .iter()
        .filter(|w| !replaced.contains(&w.hash))
        .min_by(|a, b| a.path.cmp(b.path).then(a.hash.cmp(&b.hash)))
        .map(|w| w.hash)
}

/// Fold a group's lanes into its roster. `None` when no valid founding for `group` is held.
pub fn build(group: GroupId, lanes: &[Lane]) -> Option<Roster> {
    // One lane per device, in device order, so nothing below depends on the order lanes arrived.
    let mut by_device: BTreeMap<Device, &Lane> = BTreeMap::new();
    for lane in lanes {
        by_device
            .entry(lane.device)
            .and_modify(|held| {
                if lane.persona < held.persona {
                    *held = lane;
                }
            })
            .or_insert(lane);
    }
    let lanes: Vec<&Lane> = by_device.into_values().collect();
    let mut of_persona: BTreeMap<Root, Vec<usize>> = BTreeMap::new();
    let mut at: BTreeMap<Hash, (usize, usize)> = BTreeMap::new();
    for (l, lane) in lanes.iter().enumerate() {
        of_persona.entry(lane.persona).or_default().push(l);
        for (i, e) in lane.entries.iter().enumerate() {
            at.entry(e.hash).or_insert((l, i));
        }
    }
    let entry = |h: &Hash| at.get(h).map(|&(l, i)| (lanes[l], &lanes[l].entries[i]));

    // 1. The founding: on the founder's own lane, signed by the group's key, naming this group.
    let (found_hash, founding) = lanes.iter().find_map(|lane| {
        lane.entries.iter().find_map(|e| match &e.body {
            GroupEntry::Found(f) if f.founder == lane.persona && f.id() == group && f.verify() => {
                Some((e.hash, f))
            }
            _ => None,
        })
    })?;
    let root_appt = founding.hash();

    // Retiring is the owner's own end, and always honoured - a persona may always limit itself.
    let mut endings: Vec<Ending> = Vec::new();
    for lane in &lanes {
        for e in &lane.entries {
            if let GroupEntry::Retire { by, anchors } = &e.body {
                endings.push(Ending {
                    hostile: false,
                    target: lane.persona,
                    ends: BTreeSet::from([*by]),
                    anchors: anchors.clone(),
                    at: Some((lane.device, e.seq)),
                });
            }
        }
    }

    // 2. Owners, in path order. Everything that can end an appointment comes from a strictly
    // senior one, so it has been judged before the appointment is.
    let mut appts: BTreeMap<Hash, Appt> = BTreeMap::new();
    let mut queue: BTreeMap<Path, Hash> = BTreeMap::new();
    appts.insert(root_appt, Appt { persona: founding.founder, path: Vec::new(), parent: None });
    queue.insert(Vec::new(), root_appt);
    let mut ended: BTreeSet<Hash> = BTreeSet::new();
    let mut counted: BTreeSet<Hash> = BTreeSet::new();
    let mut removals: Vec<Removal> = Vec::new();
    let mut acts: Vec<(Hash, Hash)> = Vec::new(); // (entry, appointment) for the member stratum

    while let Some((path, appt)) = queue.pop_first() {
        let persona = appts[&appt].persona;
        // The ancestry, for hostile ends that reach down from an appointment above.
        let mut line = vec![appt];
        while let Some(parent) = appts[line.last().unwrap()].parent {
            line.push(parent);
        }
        // Hostile ends reach down from any appointment in the line; a retirement ends only the
        // appointment it names.
        let ceilings: Vec<(usize, Ceiling)> = of_persona
            .get(&persona)
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .map(|&l| {
                let lane = lanes[l];
                let mut mine = endings.iter().filter(|end| {
                    if end.hostile {
                        line.iter().any(|a| end.ends.contains(a) && appts[a].persona == end.target)
                    } else {
                        end.target == persona && end.ends.contains(&appt)
                    }
                });
                // `None` at any end is nothing standing at all.
                let ceiling = mine.try_fold(u64::MAX, |c, end| {
                    let this = match end.at {
                        Some((device, seq)) if device == lane.device => Some(seq),
                        _ => ceiling_of(lane, &end.anchors),
                    };
                    Some(c.min(this?))
                });
                (l, ceiling)
            })
            .collect();
        let is_ended = endings.iter().any(|end| {
            if end.hostile {
                line.iter().any(|a| end.ends.contains(a) && appts[a].persona == end.target)
            } else {
                end.target == persona && end.ends.contains(&appt)
            }
        });
        if is_ended {
            ended.insert(appt);
        }
        for (l, ceiling) in ceilings {
            let lane = lanes[l];
            for e in &lane.entries {
                if e.body.by() != Some(&appt) || !stands(e.seq, ceiling) {
                    continue;
                }
                match &e.body {
                    GroupEntry::Appoint { appointee, .. } if *appointee != persona => {
                        let mut child = path.clone();
                        child.push((e.seq, lane.device));
                        appts.insert(
                            e.hash,
                            Appt { persona: *appointee, path: child.clone(), parent: Some(appt) },
                        );
                        queue.insert(child, e.hash);
                    }
                    GroupEntry::Appoint { .. } => continue,
                    GroupEntry::Demote { target, ends, anchors, .. }
                    | GroupEntry::Remove { target, ends, anchors, .. } => {
                        // A junior can never end a senior: the target may hold no appointment
                        // above this one - standing or since ended. Rank is where an appointment
                        // was made, and it stays: judged by whether the senior still stood, a
                        // junior's void act against them would come back to life the day a
                        // third owner demoted them, since nothing orders the two (2026-10-15,
                        // the groups suite's mutiny). Everything above has been judged.
                        let senior = appts.values().any(|a| a.persona == *target && a.path < path);
                        if *target == persona || senior {
                            continue;
                        }
                        endings.push(Ending {
                            hostile: true,
                            target: *target,
                            ends: ends.iter().copied().collect(),
                            anchors: anchors.clone(),
                            at: None,
                        });
                        if let GroupEntry::Remove { ban, .. } = &e.body {
                            removals.push(Removal {
                                hash: e.hash,
                                target: *target,
                                anchors: anchors.clone(),
                                ban: *ban,
                            });
                        }
                    }
                    _ => {}
                }
                counted.insert(e.hash);
                acts.push((e.hash, appt));
            }
        }
    }
    let path_of = |appt: &Hash| &appts[appt].path;

    // The owners' acts the member stratum reads.
    let mut invites: BTreeMap<Hash, (&Root, BTreeSet<Hash>)> = BTreeMap::new();
    let mut links: BTreeSet<Hash> = BTreeSet::new();
    let mut unlinks: BTreeMap<Hash, Vec<BTreeSet<Hash>>> = BTreeMap::new();
    let mut unbanned: BTreeSet<Hash> = BTreeSet::new();
    let mut settings: BTreeMap<u8, Vec<Write>> = BTreeMap::new();
    let mut hides: BTreeMap<Hash, Vec<Write>> = BTreeMap::new();
    let mut pins: BTreeMap<Hash, Vec<Write>> = BTreeMap::new();
    for (h, appt) in &acts {
        let (_, e) = entry(h).expect("an act is held");
        match &e.body {
            // The founding's hash is the group's id, so a match is the founder's own statement,
            // checked once already where it founded the group.
            GroupEntry::Invite { invitee, readmits, founding, .. } if founding.id() == group => {
                invites.insert(*h, (invitee, readmits.iter().copied().collect()));
            }
            GroupEntry::Link { .. } => {
                links.insert(*h);
            }
            GroupEntry::Unlink { link, accepted, .. } => {
                unlinks.entry(*link).or_default().push(accepted.iter().copied().collect());
            }
            GroupEntry::Unban { ban, .. } => {
                unbanned.insert(*ban);
            }
            GroupEntry::Set { setting, replaces, .. } => {
                // A write replaces only its own setting's history.
                let replaces = replaces
                    .iter()
                    .copied()
                    .filter(|r| {
                        entry(r).is_some_and(|(_, w)| match &w.body {
                            GroupEntry::Set { setting: s, .. } => s.kind() == setting.kind(),
                            _ => false,
                        })
                    })
                    .collect();
                settings.entry(setting.kind()).or_default().push(Write {
                    hash: *h,
                    path: path_of(appt),
                    replaces,
                });
            }
            GroupEntry::Hide { post, replaces, .. } => {
                // A write replaces only that post's own history.
                let replaces = replaces
                    .iter()
                    .copied()
                    .filter(|r| {
                        entry(r).is_some_and(|(_, w)| {
                            matches!(&w.body, GroupEntry::Hide { post: p, .. } if p == post)
                        })
                    })
                    .collect();
                hides.entry(*post).or_default().push(Write {
                    hash: *h,
                    path: path_of(appt),
                    replaces,
                });
            }
            GroupEntry::Pin { post, replaces, .. } => {
                // A write replaces only that post's own pin history, the owners' layer.
                let replaces = replaces
                    .iter()
                    .copied()
                    .filter(|r| {
                        entry(r).is_some_and(|(_, w)| {
                            matches!(&w.body, GroupEntry::Pin { post: p, .. } if p == post)
                        })
                    })
                    .collect();
                pins.entry(*post).or_default().push(Write {
                    hash: *h,
                    path: path_of(appt),
                    replaces,
                });
            }
            _ => {}
        }
    }
    let setting = |kind: u8| {
        settings.get(&kind).and_then(|w| head(w)).and_then(|h| match &entry(&h)?.1.body {
            GroupEntry::Set { setting, .. } => Some(setting.clone()),
            _ => None,
        })
    };
    let face_docs: BTreeSet<[u8; 16]> = [3u8, 4]
        .iter()
        .flat_map(|k| settings.get(k).into_iter().flatten())
        .filter_map(|w| match &entry(&w.hash)?.1.body {
            GroupEntry::Set { setting: Setting::Picture(d) | Setting::Banner(d), .. } => *d,
            _ => None,
        })
        .collect();
    let banned: BTreeSet<Root> = removals
        .iter()
        .filter(|r| r.ban && !unbanned.contains(&r.hash))
        .map(|r| r.target)
        .collect();

    // 3. Members, lane by lane. A grant is judged on its own terms - never on how the lane that
    // holds it fared - so lanes never wait on one another.
    fn grant_ok(persona: &Root, join: &Hash, grant: &Grant, ctx: &Ctx, depth: usize) -> bool {
        match grant {
            Grant::Founder => *persona == ctx.founder,
            Grant::Device(earlier) => {
                depth < 64
                    && ctx.joins.get(earlier).is_some_and(|(p, g)| {
                        *p == persona && grant_ok(persona, earlier, g, ctx, depth + 1)
                    })
            }
            Grant::Invite(h) => ctx.invites.get(h).is_some_and(|(to, _)| *to == persona),
            Grant::Link(h) => {
                ctx.links.contains(h)
                    && ctx
                        .unlinks
                        .get(h)
                        .is_none_or(|all| all.iter().all(|accepted| accepted.contains(join)))
            }
            Grant::Appointment(h) => ctx.appointed.get(h).is_some_and(|p| p == persona),
            Grant::Open(h) => ctx
                .opened
                .get(h)
                .is_some_and(|closes| closes.iter().all(|accepted| accepted.contains(join))),
        }
    }
    struct Ctx<'a> {
        founder: Root,
        joins: BTreeMap<Hash, (&'a Root, &'a Grant)>,
        invites: &'a BTreeMap<Hash, (&'a Root, BTreeSet<Hash>)>,
        links: &'a BTreeSet<Hash>,
        unlinks: &'a BTreeMap<Hash, Vec<BTreeSet<Hash>>>,
        appointed: BTreeMap<Hash, Root>,
        /// Each counted opening of the group, with what every write replacing it accepted.
        opened: BTreeMap<Hash, Vec<BTreeSet<Hash>>>,
    }
    let ctx = Ctx {
        founder: founding.founder,
        joins: lanes
            .iter()
            .flat_map(|lane| {
                lane.entries.iter().filter_map(move |e| match &e.body {
                    GroupEntry::Join { grant } => Some((e.hash, (&lane.persona, grant))),
                    _ => None,
                })
            })
            .collect(),
        invites: &invites,
        links: &links,
        unlinks: &unlinks,
        appointed: appts.iter().map(|(h, a)| (*h, a.persona)).collect(),
        opened: {
            let mut opened: BTreeMap<Hash, Vec<BTreeSet<Hash>>> = acts
                .iter()
                .filter(|(h, _)| {
                    entry(h).is_some_and(|(_, e)| {
                        matches!(
                            e.body,
                            GroupEntry::Set { setting: Setting::JoinMode(JoinMode::Open), .. }
                        )
                    })
                })
                .map(|(h, _)| (*h, Vec::new()))
                .collect();
            for (h, _) in &acts {
                if let Some((_, e)) = entry(h) {
                    if let GroupEntry::Set {
                        setting: Setting::JoinMode(_),
                        replaces,
                        accepted,
                        ..
                    } = &e.body
                    {
                        for r in replaces {
                            if let Some(closes) = opened.get_mut(r) {
                                closes.push(accepted.iter().copied().collect());
                            }
                        }
                    }
                }
            }
            opened
        },
    };

    let mut members: BTreeSet<Root> = BTreeSet::new();
    // Every member pin that counts, settled into the members' layer below.
    let mut member_pins: Vec<Hash> = Vec::new();
    let mut posts: BTreeSet<Hash> = BTreeSet::new();
    for lane in &lanes {
        // Where removals cut this lane, and the leaves written on the persona's other lanes.
        // `-1` is "before the first entry".
        let mut cuts: Vec<(i128, Option<&Removal>)> = Vec::new();
        for r in removals.iter().filter(|r| r.target == lane.persona) {
            cuts.push((ceiling_of(lane, &r.anchors).map_or(-1, i128::from), Some(r)));
        }
        for other in of_persona[&lane.persona].iter().map(|&l| lanes[l]) {
            if other.device == lane.device {
                continue;
            }
            for e in &other.entries {
                if let GroupEntry::Leave { anchors } = &e.body {
                    cuts.push((ceiling_of(lane, anchors).map_or(-1, i128::from), None));
                }
            }
        }
        cuts.sort_by_key(|(at, r)| (*at, r.map(|r| r.hash)));
        let mut cuts = cuts.into_iter().peekable();
        let mut member = false;
        let mut pending: BTreeSet<Hash> = BTreeSet::new(); // removals a rejoin must readmit
        for e in &lane.entries {
            while let Some((_, removal)) = cuts.next_if(|(at, _)| *at < i128::from(e.seq)) {
                member = false;
                if let Some(r) = removal {
                    pending.insert(r.hash);
                }
            }
            match &e.body {
                GroupEntry::Found(_) if e.hash == found_hash => {
                    member = true;
                    counted.insert(e.hash);
                }
                GroupEntry::Join { .. } if member => {
                    counted.insert(e.hash);
                }
                GroupEntry::Join { grant } => {
                    let readmits = match grant {
                        Grant::Invite(h) => invites.get(h).map(|(_, r)| r.clone()),
                        _ => None,
                    }
                    .unwrap_or_default();
                    let lifted = pending.iter().all(|p| {
                        readmits.contains(p)
                            && removals
                                .iter()
                                .find(|r| r.hash == *p)
                                .is_none_or(|r| !r.ban || unbanned.contains(&r.hash))
                    });
                    if lifted && grant_ok(&lane.persona, &e.hash, grant, &ctx, 0) {
                        member = true;
                        pending.clear();
                        counted.insert(e.hash);
                    }
                }
                GroupEntry::Leave { .. } if member => {
                    member = false;
                    counted.insert(e.hash);
                }
                GroupEntry::Document { retract, .. } if member => {
                    if !retract {
                        posts.insert(e.hash);
                    }
                    counted.insert(e.hash);
                }
                GroupEntry::Label { .. } if member => {
                    counted.insert(e.hash);
                }
                GroupEntry::MemberPin { .. } if member => {
                    counted.insert(e.hash);
                    member_pins.push(e.hash);
                }
                _ => {}
            }
        }
        // Cuts past the lane's last entry still end it now.
        if cuts.next().is_some() {
            member = false;
        }
        if member {
            members.insert(lane.persona);
        }
    }

    // Owners now: a standing appointment, held by someone in the group.
    let mut owners: BTreeMap<Root, Path> = BTreeMap::new();
    for (h, a) in &appts {
        if ended.contains(h) || !members.contains(&a.persona) {
            continue;
        }
        let best = owners.entry(a.persona).or_insert_with(|| a.path.clone());
        if a.path < *best {
            *best = a.path.clone();
        }
    }

    // The pins (slice 4d): each layer a register per post, of the posts that count. The members'
    // layer has no ranks, so every write sits at one rank and the hash settles concurrent heads.
    let no_rank: Path = Vec::new();
    let mut by_members: BTreeMap<Hash, Vec<Write>> = BTreeMap::new();
    for h in &member_pins {
        let Some((_, e)) = entry(h) else { continue };
        let GroupEntry::MemberPin { post, replaces, .. } = &e.body else { continue };
        let replaces = replaces
            .iter()
            .copied()
            .filter(|r| {
                counted.contains(r)
                    && entry(r).is_some_and(|(_, w)| {
                        matches!(&w.body, GroupEntry::MemberPin { post: p, .. } if p == post)
                    })
            })
            .collect();
        by_members.entry(*post).or_default().push(Write { hash: *h, path: &no_rank, replaces });
    }
    let pinned_in = |layer: &BTreeMap<Hash, Vec<Write>>| -> BTreeSet<Hash> {
        layer
            .iter()
            .filter(|(post, _)| posts.contains(*post))
            .filter_map(|(post, writes)| {
                let h = head(writes)?;
                matches!(
                    entry(&h)?.1.body,
                    GroupEntry::Pin { pinned: true, .. }
                        | GroupEntry::MemberPin { pinned: true, .. }
                )
                .then_some(*post)
            })
            .collect()
    };
    let owner_pins = pinned_in(&pins);
    let member_pins: BTreeSet<Hash> =
        pinned_in(&by_members).into_iter().filter(|p| !owner_pins.contains(p)).collect();
    let hidden: BTreeSet<Hash> = hides
        .iter()
        .filter(|(post, _)| posts.contains(*post))
        .filter_map(|(post, writes)| {
            let h = head(writes)?;
            matches!(entry(&h)?.1.body, GroupEntry::Hide { hidden: true, .. }).then_some(*post)
        })
        .collect();

    // An invite a counted join took up is spent: its invitee isn't waiting at the door any more,
    // in the group or out of it again.
    let spent: BTreeSet<Hash> = lanes
        .iter()
        .flat_map(|l| l.entries.iter())
        .filter(|e| counted.contains(&e.hash))
        .filter_map(|e| match &e.body {
            GroupEntry::Join { grant: Grant::Invite(h) } => Some(*h),
            _ => None,
        })
        .collect();
    // ...and an invite that couldn't let its invitee back in opens no door either: one made
    // before their removal, that doesn't readmit it (2026-10-15, the groups suite - a leftover
    // invite kept serving a removed member the group, removal and all).
    let invited: BTreeSet<Root> = invites
        .iter()
        .filter(|(h, _)| !spent.contains(*h))
        .filter(|(_, (to, readmits))| {
            removals.iter().filter(|r| r.target == **to).all(|r| readmits.contains(&r.hash))
        })
        .map(|(_, (to, _))| **to)
        .filter(|to| !members.contains(to) && !banned.contains(to))
        .collect();
    let appointments: BTreeMap<Hash, Appointment> = appts
        .iter()
        .map(|(h, a)| {
            let standing = !ended.contains(h);
            (
                *h,
                Appointment {
                    persona: a.persona,
                    path: a.path.clone(),
                    parent: a.parent,
                    standing,
                },
            )
        })
        .collect();

    Some(Roster {
        id: group,
        founder: founding.founder,
        members,
        owners,
        name: match setting(0) {
            Some(Setting::Name(n)) => n,
            _ => founding.name.clone(),
        },
        description: match setting(1) {
            Some(Setting::Description(d)) => d,
            _ => String::new(),
        },
        join_mode: match setting(2) {
            Some(Setting::JoinMode(m)) => m,
            _ => JoinMode::InviteOnly,
        },
        picture: match setting(3) {
            Some(Setting::Picture(d)) => d,
            _ => None,
        },
        banner: match setting(4) {
            Some(Setting::Banner(d)) => d,
            _ => None,
        },
        face_docs,
        room: match setting(5) {
            Some(Setting::Room(r)) => r,
            _ => None,
        },
        counted,
        posts,
        hidden,
        owner_pins,
        member_pins,
        banned,
        invited,
        appointments,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const F: Root = [1; 32]; // the founder
    const A: Root = [2; 32];
    const B: Root = [3; 32];
    const C: Root = [4; 32];
    const J: Root = [5; 32];
    const S: Root = [6; 32];
    const X: Root = [7; 32];
    const Y: Root = [8; 32];
    const Z: Root = [9; 32];

    fn dev(persona: &Root, k: u8) -> Device {
        let mut d = *persona;
        d[31] = 200 + k;
        d
    }

    /// A group and its lanes, appended to as members would.
    #[derive(Clone)]
    struct World {
        group: GroupId,
        found: Hash,
        founding: Founding,
        lanes: BTreeMap<Device, Lane>,
    }

    impl World {
        fn new() -> Self {
            let founding = Founding::sign(&SigningKey::from_bytes(&[42; 32]), F, "Potato Bunch");
            let mut w = World {
                group: founding.id(),
                found: founding.hash(),
                founding: founding.clone(),
                lanes: BTreeMap::new(),
            };
            w.add(F, 0, GroupEntry::Found(founding));
            w
        }

        fn add(&mut self, persona: Root, k: u8, body: GroupEntry) -> Hash {
            let device = dev(&persona, k);
            let lane =
                self.lanes.entry(device).or_insert(Lane { persona, device, entries: Vec::new() });
            let seq = lane.entries.len() as u64;
            let hash = *blake3::hash(format!("{device:?}/{seq}/{body:?}").as_bytes()).as_bytes();
            lane.entries.push(LaneEntry { seq, hash, body });
            hash
        }

        /// Every lane of these personas, anchored at its head: what a node that had folded
        /// them all would write.
        fn anchors(&self, personas: &[Root]) -> Vec<LaneAnchor> {
            self.lanes
                .values()
                .filter(|l| personas.contains(&l.persona))
                .filter_map(|l| {
                    let e = l.entries.last()?;
                    Some(LaneAnchor { device: l.device, seq: e.seq, head_hash: e.hash })
                })
                .collect()
        }

        fn invite(&mut self, to: Root) -> Hash {
            let by = self.found;
            let founding = self.founding.clone();
            let inv =
                self.add(F, 0, GroupEntry::Invite { by, invitee: to, readmits: vec![], founding });
            self.add(to, 0, GroupEntry::Join { grant: Grant::Invite(inv) })
        }

        /// The founder appoints `who` under `by`, written on `on`'s first lane, and `who`
        /// takes it up.
        fn appoint(&mut self, on: Root, by: Hash, who: Root) -> Hash {
            let ap = self.add(on, 0, GroupEntry::Appoint { by, appointee: who });
            self.add(who, 0, GroupEntry::Join { grant: Grant::Appointment(ap) });
            ap
        }

        fn post(&mut self, who: Root, k: u8) -> Hash {
            let n = self.lanes.get(&dev(&who, k)).map_or(0, |l| l.entries.len());
            self.add(who, k, GroupEntry::Document { doc: [n as u8; 16], retract: false })
        }

        /// The roster, folded from the lanes in every order they could arrive in - all of them
        /// for six lanes or fewer, every rotation and its reverse beyond - and the same each time.
        fn fold(&self) -> Roster {
            let lanes: Vec<Lane> = self.lanes.values().cloned().collect();
            let first = build(self.group, &lanes).expect("a founded group");
            let mut orders: Vec<Vec<Lane>> = Vec::new();
            if lanes.len() <= 6 {
                permutations(lanes.clone(), 0, &mut orders);
            } else {
                for r in 0..lanes.len() {
                    let mut o = lanes.clone();
                    o.rotate_left(r);
                    orders.push(o.clone());
                    o.reverse();
                    orders.push(o);
                }
            }
            for order in orders {
                assert_eq!(build(self.group, &order).as_ref(), Some(&first), "order-dependent");
            }
            first
        }
    }

    fn permutations(mut v: Vec<Lane>, k: usize, out: &mut Vec<Vec<Lane>>) {
        if k == v.len() {
            out.push(v);
            return;
        }
        for i in k..v.len() {
            v.swap(k, i);
            permutations(v.clone(), k + 1, out);
            v.swap(k, i);
        }
    }

    fn set(people: &[Root]) -> BTreeSet<Root> {
        people.iter().copied().collect()
    }

    #[test]
    fn a_join_then_a_leave() {
        let mut w = World::new();
        w.invite(B);
        let before = w.post(B, 0);
        let r = w.fold();
        assert_eq!(r.members, set(&[F, B]));
        assert_eq!(r.owners.keys().copied().collect::<BTreeSet<_>>(), set(&[F]));
        assert!(r.posts.contains(&before));

        w.add(B, 0, GroupEntry::Leave { anchors: vec![] });
        let after = w.post(B, 0);
        let r = w.fold();
        assert_eq!(r.members, set(&[F]));
        assert!(r.posts.contains(&before), "what they said while in stands");
        assert!(!r.posts.contains(&after), "nothing after leaving counts");
        assert_eq!(r.name, "Potato Bunch");
    }

    /// Section 3's spammer: posts written while the removal was on its way are void everywhere
    /// once it arrives - on a node that counted them first, too.
    #[test]
    fn a_removal_voids_what_was_posted_past_its_anchor() {
        let mut w = World::new();
        w.invite(B);
        let seen = w.post(B, 0);
        let anchors = w.anchors(&[B]);
        let flood = w.post(B, 0); // written before the removal reached B

        let third_node = w.fold();
        assert!(third_node.posts.contains(&flood), "before the removal, it counts");

        let by = w.found;
        w.add(F, 0, GroupEntry::Remove { by, target: B, ends: vec![], anchors, ban: false });
        let r = w.fold();
        assert_eq!(r.members, set(&[F]));
        assert!(r.posts.contains(&seen), "the anchored prefix stands");
        assert!(!r.posts.contains(&flood), "past the anchor is void");
    }

    #[test]
    fn a_junior_cannot_remove_a_senior() {
        let mut w = World::new();
        let found = w.found;
        let ap_a = w.appoint(F, found, A);
        let ap_j = w.appoint(A, ap_a, J);
        let anchors = w.anchors(&[A]);
        let mutiny = w.add(
            J,
            0,
            GroupEntry::Remove { by: ap_j, target: A, ends: vec![ap_a], anchors, ban: false },
        );
        let anchors = w.anchors(&[F]);
        let regicide = w.add(
            J,
            0,
            GroupEntry::Remove { by: ap_j, target: F, ends: vec![], anchors, ban: false },
        );
        let r = w.fold();
        assert_eq!(r.members, set(&[F, A, J]));
        assert_eq!(r.owners.keys().copied().collect::<BTreeSet<_>>(), set(&[F, A, J]));
        assert!(!r.counted.contains(&mutiny) && !r.counted.contains(&regicide));
        assert!(r.owners[&A] < r.owners[&J], "A appointed J, so A is senior");

        // The other way round stands.
        let anchors = w.anchors(&[J]);
        w.add(
            A,
            0,
            GroupEntry::Remove { by: ap_a, target: J, ends: vec![ap_j], anchors, ban: false },
        );
        let r = w.fold();
        assert_eq!(r.members, set(&[F, A]));
        assert_eq!(r.owners.keys().copied().collect::<BTreeSet<_>>(), set(&[F, A]));
    }

    /// A junior's act against a senior stays void when a third owner later demotes the senior:
    /// rank is where the appointment was made, not whether it still stands (the groups suite's
    /// mutiny, 2026-10-15).
    #[test]
    fn a_void_act_against_a_senior_stays_void_after_the_senior_falls() {
        let mut w = World::new();
        let found = w.found;
        let ap_b = w.appoint(F, found, B);
        let ap_c = w.appoint(B, ap_b, C);
        let anchors = w.anchors(&[B]);
        let mutiny = w.add(
            C,
            0,
            GroupEntry::Remove { by: ap_c, target: B, ends: vec![ap_b], anchors, ban: false },
        );
        let anchors = w.anchors(&[B, C]);
        w.add(F, 0, GroupEntry::Demote { by: found, target: B, ends: vec![ap_b], anchors });
        let r = w.fold();
        assert!(!r.counted.contains(&mutiny));
        assert_eq!(r.members, set(&[F, B, C]), "demoted, and still in");
        assert_eq!(r.owners.keys().copied().collect::<BTreeSet<_>>(), set(&[F]));
    }

    #[test]
    fn an_invite_that_cannot_readmit_opens_no_door() {
        let mut w = World::new();
        let found = w.found;
        w.invite(B);
        w.add(
            F,
            0,
            GroupEntry::Invite {
                by: found,
                invitee: B,
                readmits: vec![],
                founding: w.founding.clone(),
            },
        ); // left over
        let anchors = w.anchors(&[B]);
        let removal = w.add(
            F,
            0,
            GroupEntry::Remove { by: found, target: B, ends: vec![], anchors, ban: false },
        );
        assert!(w.fold().invited.is_empty(), "the leftover invite predates the removal");
        w.add(
            F,
            0,
            GroupEntry::Invite {
                by: found,
                invitee: B,
                readmits: vec![removal],
                founding: w.founding.clone(),
            },
        );
        assert_eq!(w.fold().invited, set(&[B]), "one that readmits it does");
    }

    #[test]
    fn a_spent_invite_opens_no_door() {
        let mut w = World::new();
        w.invite(B);
        assert!(w.fold().invited.is_empty(), "taken up");
        w.add(B, 0, GroupEntry::Leave { anchors: vec![] });
        let r = w.fold();
        assert!(r.invited.is_empty() && !r.members.contains(&B), "out, and not waiting");
    }

    /// Rule 5: a hostile end takes the subtree's ownership, and their acts before the anchors
    /// stand; a retirement leaves the retiring owner's appointees their rank.
    #[test]
    fn a_demotion_takes_the_subtree_and_a_retirement_does_not() {
        let mut w = World::new();
        let found = w.found;
        let ap_a = w.appoint(F, found, A);
        let ap_s = w.appoint(A, ap_a, S); // A's sock puppet
        let inv_x = w.add(
            S,
            0,
            GroupEntry::Invite {
                by: ap_s,
                invitee: X,
                readmits: vec![],
                founding: w.founding.clone(),
            },
        );
        w.add(X, 0, GroupEntry::Join { grant: Grant::Invite(inv_x) });
        let anchors = w.anchors(&[A, S]);
        let inv_y = w.add(
            S,
            0,
            GroupEntry::Invite {
                by: ap_s,
                invitee: Y,
                readmits: vec![],
                founding: w.founding.clone(),
            },
        );
        w.add(Y, 0, GroupEntry::Join { grant: Grant::Invite(inv_y) });
        w.add(F, 0, GroupEntry::Demote { by: found, target: A, ends: vec![ap_a], anchors });
        let r = w.fold();
        assert_eq!(r.owners.keys().copied().collect::<BTreeSet<_>>(), set(&[F]));
        assert_eq!(r.members, set(&[F, A, S, X]), "demoted, not removed; Y's invite came too late");
        assert!(r.counted.contains(&inv_x) && !r.counted.contains(&inv_y));

        let ap_b = w.appoint(F, found, B);
        let ap_c = w.appoint(B, ap_b, C);
        w.add(B, 0, GroupEntry::Retire { by: ap_b, anchors: vec![] });
        let inv_z = w.add(
            C,
            0,
            GroupEntry::Invite {
                by: ap_c,
                invitee: Z,
                readmits: vec![],
                founding: w.founding.clone(),
            },
        );
        w.add(Z, 0, GroupEntry::Join { grant: Grant::Invite(inv_z) });
        let r = w.fold();
        assert_eq!(r.owners.keys().copied().collect::<BTreeSet<_>>(), set(&[F, C]));
        assert_eq!(r.acting_as(&C), Some(ap_c));
        assert_eq!(r.acting_as(&B), None, "retired");
        assert_eq!(r.beneath(&ap_b), set(&[C]));
        assert_eq!(r.beneath(&ap_a), set(&[S]));
        assert_eq!(r.acting_as(&F), Some(found));
        assert!(r.members.contains(&Z), "C's rank outlived B's retirement");
        assert!(r.members.contains(&B), "retiring isn't leaving");
    }

    #[test]
    fn concurrent_settings_go_to_the_senior_until_someone_moves_on() {
        let mut w = World::new();
        let found = w.found;
        let ap_a = w.appoint(F, found, A);
        let name = |n: &str| Setting::Name(n.to_string());
        let senior = w.add(
            F,
            0,
            GroupEntry::Set {
                by: found,
                setting: name("Senior"),
                replaces: vec![],
                accepted: vec![],
            },
        );
        let junior = w.add(
            A,
            0,
            GroupEntry::Set {
                by: ap_a,
                setting: name("Junior"),
                replaces: vec![],
                accepted: vec![],
            },
        );
        assert_eq!(w.fold().name, "Senior");
        w.add(
            A,
            0,
            GroupEntry::Set {
                by: ap_a,
                setting: name("Moved on"),
                replaces: vec![senior, junior],
                accepted: vec![],
            },
        );
        assert_eq!(w.fold().name, "Moved on");
    }

    #[test]
    fn a_revoked_link_keeps_the_joins_it_saw() {
        let mut w = World::new();
        let found = w.found;
        let link = w.add(F, 0, GroupEntry::Link { by: found, token: [7; 16] });
        let jx = w.add(X, 0, GroupEntry::Join { grant: Grant::Link(link) });
        w.add(Y, 0, GroupEntry::Join { grant: Grant::Link(link) }); // in flight at the revocation
        w.add(F, 0, GroupEntry::Unlink { by: found, link, accepted: vec![jx] });
        assert_eq!(w.fold().members, set(&[F, X]));
    }

    #[test]
    fn a_ban_holds_until_it_is_lifted() {
        let mut w = World::new();
        let found = w.found;
        w.invite(B);
        let anchors = w.anchors(&[B]);
        let ban = w.add(
            F,
            0,
            GroupEntry::Remove { by: found, target: B, ends: vec![], anchors, ban: true },
        );
        let back = w.add(
            F,
            0,
            GroupEntry::Invite {
                by: found,
                invitee: B,
                readmits: vec![ban],
                founding: w.founding.clone(),
            },
        );
        w.add(B, 0, GroupEntry::Join { grant: Grant::Invite(back) });
        let r = w.fold();
        assert_eq!(r.members, set(&[F]));
        assert_eq!(r.banned, set(&[B]));
        assert!(r.invited.is_empty(), "a banned persona's invite opens no door");

        w.add(F, 0, GroupEntry::Unban { by: found, ban });
        let r = w.fold();
        assert_eq!(r.members, set(&[F, B]), "lifted, and the readmitting invite stands");
        assert!(r.banned.is_empty());
    }

    #[test]
    fn a_rejoin_after_a_removal_needs_an_invite_that_readmits_it() {
        let mut w = World::new();
        let found = w.found;
        w.invite(B);
        let anchors = w.anchors(&[B]);
        let removal = w.add(
            F,
            0,
            GroupEntry::Remove { by: found, target: B, ends: vec![], anchors, ban: false },
        );
        let plain = w.add(
            F,
            0,
            GroupEntry::Invite {
                by: found,
                invitee: B,
                readmits: vec![],
                founding: w.founding.clone(),
            },
        );
        w.add(B, 0, GroupEntry::Join { grant: Grant::Invite(plain) });
        assert_eq!(w.fold().members, set(&[F]), "an invite that doesn't know of the removal");
        let knowing = w.add(
            F,
            0,
            GroupEntry::Invite {
                by: found,
                invitee: B,
                readmits: vec![removal],
                founding: w.founding.clone(),
            },
        );
        w.add(B, 0, GroupEntry::Join { grant: Grant::Invite(knowing) });
        assert_eq!(w.fold().members, set(&[F, B]));
    }

    /// Rule 10: an anchor naming an entry the lane doesn't hold at that seq is a fork or a
    /// forgery, and nothing on the lane stands.
    #[test]
    fn an_anchor_that_misnames_its_entry_fails_closed() {
        let mut w = World::new();
        let found = w.found;
        w.invite(B);
        let early = w.post(B, 0);
        let mut anchors = w.anchors(&[B]);
        anchors[0].head_hash = [0xee; 32];
        w.add(F, 0, GroupEntry::Remove { by: found, target: B, ends: vec![], anchors, ban: false });
        let r = w.fold();
        assert!(!r.posts.contains(&early));
        assert!(!r.members.contains(&B));
    }

    #[test]
    fn a_second_computer_joins_as_its_persona_and_falls_with_it() {
        let mut w = World::new();
        let found = w.found;
        let jb = w.invite(B);
        w.add(B, 1, GroupEntry::Join { grant: Grant::Device(jb) });
        let from_phone = w.post(B, 1);
        let r = w.fold();
        assert!(r.posts.contains(&from_phone));

        // The remover had seen only B's first computer: the second stands at nothing.
        let anchors: Vec<LaneAnchor> =
            w.anchors(&[B]).into_iter().filter(|a| a.device == dev(&B, 0)).collect();
        w.add(F, 0, GroupEntry::Remove { by: found, target: B, ends: vec![], anchors, ban: false });
        let r = w.fold();
        assert!(!r.posts.contains(&from_phone));
        assert_eq!(r.members, set(&[F]));
    }

    #[test]
    fn closing_an_open_group_keeps_the_joins_it_saw() {
        let mut w = World::new();
        let found = w.found;
        let open = w.add(
            F,
            0,
            GroupEntry::Set {
                by: found,
                setting: Setting::JoinMode(JoinMode::Open),
                replaces: vec![],
                accepted: vec![],
            },
        );
        let jz = w.add(Z, 0, GroupEntry::Join { grant: Grant::Open(open) });
        assert_eq!(w.fold().join_mode, JoinMode::Open);
        w.add(
            F,
            0,
            GroupEntry::Set {
                by: found,
                setting: Setting::JoinMode(JoinMode::InviteOnly),
                replaces: vec![open],
                accepted: vec![jz],
            },
        );
        w.add(Y, 0, GroupEntry::Join { grant: Grant::Open(open) }); // after the door shut
        let r = w.fold();
        assert_eq!(r.join_mode, JoinMode::InviteOnly);
        assert_eq!(r.members, set(&[F, Z]));
    }

    #[test]
    fn an_owner_hides_a_post_and_a_later_write_shows_it_again() {
        let mut w = World::new();
        let found = w.found;
        w.invite(B);
        let post = w.post(B, 0);
        let hide =
            w.add(F, 0, GroupEntry::Hide { by: found, post, hidden: true, replaces: vec![] });
        assert!(w.fold().hidden.contains(&post));
        w.add(F, 0, GroupEntry::Hide { by: found, post, hidden: false, replaces: vec![hide] });
        let r = w.fold();
        assert!(!r.hidden.contains(&post) && r.posts.contains(&post));
    }

    /// Pins, slice 4d (Curtis, 2026-10-15/16): owners and members both pin, any post; an owner's
    /// pin is the owners' layer and wins the post from the members'; a member unpins another
    /// member's pin; an owner unpins anything; and a non-member's pin counts for nothing.
    #[test]
    fn owners_and_members_pin_and_members_unpin_each_other() {
        let mut w = World::new();
        let found = w.found;
        w.invite(B);
        let post = w.post(B, 0);
        let other = w.post(B, 0);
        // B pins one of B's own posts in the members' layer.
        let b_pin = w.add(B, 0, GroupEntry::MemberPin { post, pinned: true, replaces: vec![] });
        let r = w.fold();
        assert!(r.member_pins.contains(&post) && r.owner_pins.is_empty());
        // The founder unpins it - an owner is a member, and members unpin each other's.
        w.add(F, 0, GroupEntry::MemberPin { post, pinned: false, replaces: vec![b_pin] });
        assert!(!w.fold().member_pins.contains(&post), "unpinned by someone else");
        // The founder pins the other one as an owner; B pinning it too changes no layer.
        let f_pin =
            w.add(F, 0, GroupEntry::Pin { by: found, post: other, pinned: true, replaces: vec![] });
        w.add(B, 0, GroupEntry::MemberPin { post: other, pinned: true, replaces: vec![] });
        let r = w.fold();
        assert!(r.owner_pins.contains(&other));
        assert!(!r.member_pins.contains(&other), "an owner's pin holds the post alone");
        w.add(
            F,
            0,
            GroupEntry::Pin { by: found, post: other, pinned: false, replaces: vec![f_pin] },
        );
        let r = w.fold();
        assert!(!r.owner_pins.contains(&other));
        assert!(r.member_pins.contains(&other), "the member's pin shows once the owner's goes");
        // A stranger's pin is no member's act.
        w.add(C, 0, GroupEntry::MemberPin { post, pinned: true, replaces: vec![] });
        assert!(!w.fold().member_pins.contains(&post), "a non-member's pin counts for nothing");
    }

    #[test]
    fn owners_set_the_groups_face_and_every_face_document_is_kept_from_the_posts() {
        let mut w = World::new();
        let found = w.found;
        w.invite(B);
        let set = |setting: Setting, replaces: Vec<Hash>| GroupEntry::Set {
            by: found,
            setting,
            replaces,
            accepted: vec![],
        };
        let first = w.add(F, 0, set(Setting::Picture(Some([1; 16])), vec![]));
        let r = w.fold();
        assert_eq!(r.picture, Some([1; 16]));
        assert_eq!(r.banner, None);
        // A member who isn't an owner can't: B citing the founding's authority counts for nothing.
        w.add(B, 0, set(Setting::Picture(Some([2; 16])), vec![first]));
        assert_eq!(w.fold().picture, Some([1; 16]), "only an owner sets the face");
        let second = w.add(F, 0, set(Setting::Picture(Some([3; 16])), vec![first]));
        w.add(F, 0, set(Setting::Banner(Some([4; 16])), vec![]));
        let r = w.fold();
        assert_eq!(r.picture, Some([3; 16]));
        assert_eq!(r.banner, Some([4; 16]), "the banner is a register of its own");
        assert_eq!(
            r.face_docs,
            BTreeSet::from([[1; 16], [3; 16], [4; 16]]),
            "every picture an owner named, the replaced one too, and never the member's"
        );
        w.add(F, 0, set(Setting::Picture(None), vec![second]));
        assert_eq!(w.fold().picture, None, "and back to none");
    }

    #[test]
    fn the_standing_room_is_an_owners_setting() {
        let mut w = World::new();
        let found = w.found;
        w.invite(B);
        let set = |setting: Setting, replaces: Vec<Hash>| GroupEntry::Set {
            by: found,
            setting,
            replaces,
            accepted: vec![],
        };
        let general = w.add(F, 0, set(Setting::Room(Some((F, [7; 16]))), vec![]));
        assert_eq!(w.fold().room, Some((F, [7; 16])));
        w.add(B, 0, set(Setting::Room(Some((B, [8; 16]))), vec![general]));
        assert_eq!(w.fold().room, Some((F, [7; 16])), "only an owner names the standing room");
        w.add(F, 0, set(Setting::Room(Some((B, [8; 16]))), vec![general]));
        assert_eq!(w.fold().room, Some((B, [8; 16])), "an owner may point it at another room");
    }

    #[test]
    fn a_founding_needs_the_group_keys_signature() {
        let mut w = World::new();
        let lane = w.lanes.get_mut(&dev(&F, 0)).unwrap();
        if let GroupEntry::Found(f) = &mut lane.entries[0].body {
            f.name = "Not The Potato Bunch".to_string();
        }
        let lanes: Vec<Lane> = w.lanes.values().cloned().collect();
        assert!(build(w.group, &lanes).is_none());
    }

    /// Every kind survives the wire, and its bytes are the one form a reader accepts.
    #[test]
    fn every_entry_round_trips() {
        let h = |n: u8| [n; 32];
        let a = LaneAnchor { device: h(9), seq: 4, head_hash: h(8) };
        let founding = Founding::sign(&SigningKey::from_bytes(&[42; 32]), F, "Potato Bunch");
        let all = vec![
            GroupEntry::Found(founding.clone()),
            GroupEntry::Join { grant: Grant::Founder },
            GroupEntry::Join { grant: Grant::Open(h(1)) },
            GroupEntry::Leave { anchors: vec![] },
            GroupEntry::Leave { anchors: vec![a] },
            GroupEntry::Invite {
                by: h(1),
                invitee: B,
                readmits: vec![h(2), h(3)],
                founding: founding.clone(),
            },
            GroupEntry::Link { by: h(1), token: [5; 16] },
            GroupEntry::Unlink { by: h(1), link: h(2), accepted: vec![h(3)] },
            GroupEntry::Appoint { by: h(1), appointee: A },
            GroupEntry::Retire { by: h(1), anchors: vec![a, a] },
            GroupEntry::Demote { by: h(1), target: A, ends: vec![h(4)], anchors: vec![a] },
            GroupEntry::Remove { by: h(1), target: B, ends: vec![], anchors: vec![a], ban: true },
            GroupEntry::Remove { by: h(1), target: B, ends: vec![], anchors: vec![], ban: false },
            GroupEntry::Unban { by: h(1), ban: h(6) },
            GroupEntry::Set {
                by: h(1),
                setting: Setting::Name("Tater Tots".into()),
                replaces: vec![h(2)],
                accepted: vec![],
            },
            GroupEntry::Set {
                by: h(1),
                setting: Setting::JoinMode(JoinMode::InviteOnly),
                replaces: vec![h(2)],
                accepted: vec![h(7)],
            },
            GroupEntry::Set {
                by: h(1),
                setting: Setting::Description(String::new()),
                replaces: vec![],
                accepted: vec![],
            },
            GroupEntry::Set {
                by: h(1),
                setting: Setting::Picture(Some([9; 16])),
                replaces: vec![h(2)],
                accepted: vec![],
            },
            GroupEntry::Set {
                by: h(1),
                setting: Setting::Banner(None),
                replaces: vec![],
                accepted: vec![],
            },
            GroupEntry::Set {
                by: h(1),
                setting: Setting::Room(Some(([5; 32], [6; 16]))),
                replaces: vec![h(2)],
                accepted: vec![],
            },
            GroupEntry::Set {
                by: h(1),
                setting: Setting::Room(None),
                replaces: vec![],
                accepted: vec![],
            },
            GroupEntry::Hide { by: h(1), post: h(2), hidden: true, replaces: vec![] },
            GroupEntry::Pin { by: h(1), post: h(2), pinned: true, replaces: vec![h(3)] },
            GroupEntry::MemberPin { post: h(2), pinned: false, replaces: vec![h(3)] },
        ];
        for e in all {
            let bytes = e.encode().unwrap();
            assert_eq!(GroupEntry::decode(&bytes).unwrap(), e);
        }
        let too_long = GroupEntry::Set {
            by: h(1),
            setting: Setting::Name("x".repeat(GroupEntry::MAX_NAME_BYTES + 1)),
            replaces: vec![],
            accepted: vec![],
        };
        assert!(too_long.encode().is_err());
        // A flag written out as false is a second spelling of absent, and refused.
        let spelled = |flag: Option<u64>| {
            let mut w = Writer::new();
            w.map(if flag.is_some() { 4 } else { 3 });
            w.uint(0);
            w.uint(13);
            w.uint(1);
            w.bytes(&h(1));
            if let Some(flag) = flag {
                w.uint(8);
                w.uint(flag);
            }
            w.uint(11);
            w.bytes(&h(2));
            w.into_bytes()
        };
        assert!(GroupEntry::decode(&spelled(None)).is_ok());
        assert!(GroupEntry::decode(&spelled(Some(1))).is_ok());
        assert!(GroupEntry::decode(&spelled(Some(0))).is_err());
    }

    /// A takedown is the author's, counted while they're a member; the version it takes down
    /// stays counted (what was said was said), and the page reads the takedown.
    #[test]
    fn a_label_counts_while_its_author_is_in_the_group() {
        let mut w = World::new();
        w.invite(B);
        let before = w.add(B, 0, GroupEntry::Label { doc: [1; 16] });
        let found = w.found;
        let anchors = w.anchors(&[B]);
        w.add(F, 0, GroupEntry::Remove { by: found, target: B, ends: vec![], anchors, ban: false });
        let after = w.add(B, 0, GroupEntry::Label { doc: [1; 16] });
        let r = w.fold();
        assert!(r.counted.contains(&before), "said while a member");
        assert!(!r.counted.contains(&after), "said past the removal's anchor");
        assert!(GroupEntry::Label { doc: [1; 16] }.encode().is_err(), "never a group entry's kind");
    }

    #[test]
    fn a_documents_takedown_counts_like_any_entry() {
        let mut w = World::new();
        w.invite(B);
        let version = w.post(B, 0);
        let takedown = w.add(B, 0, GroupEntry::Document { doc: [0; 16], retract: true });
        let r = w.fold();
        assert!(r.posts.contains(&version) && !r.posts.contains(&takedown));
        assert!(r.counted.contains(&takedown));
        assert!(GroupEntry::Document { doc: [0; 16], retract: false }.encode().is_err());
    }

    #[test]
    fn only_the_invited_may_use_an_invite() {
        let mut w = World::new();
        let found = w.found;
        let inv = w.add(
            F,
            0,
            GroupEntry::Invite {
                by: found,
                invitee: B,
                readmits: vec![],
                founding: w.founding.clone(),
            },
        );
        w.add(X, 0, GroupEntry::Join { grant: Grant::Invite(inv) });
        w.add(Y, 0, GroupEntry::Join { grant: Grant::Founder });
        let r = w.fold();
        assert_eq!(r.members, set(&[F]));
        assert_eq!(r.invited, set(&[B]), "invited, until they take it up");
    }

    #[test]
    fn an_invite_carrying_another_groups_founding_opens_nothing() {
        let mut w = World::new();
        let found = w.found;
        let elsewhere = Founding::sign(&SigningKey::from_bytes(&[43; 32]), F, "Turnip Lot");
        let inv = w.add(
            F,
            0,
            GroupEntry::Invite { by: found, invitee: B, readmits: vec![], founding: elsewhere },
        );
        w.add(B, 0, GroupEntry::Join { grant: Grant::Invite(inv) });
        let r = w.fold();
        assert_eq!(r.members, set(&[F]));
        assert!(r.invited.is_empty(), "it names some other group");
    }
}
