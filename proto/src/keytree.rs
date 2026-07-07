//! The key tree: authority resolution for one identity.
//!
//! Input: the identity's `identity-public` chain entries (from every key claiming membership).
//! Output: a total authority order plus a status for every key - who exists, who outranks whom,
//! who is retired, repudiated, or invalid - computed **from local data alone**: no global view,
//! no synchronized clock, no coordinator (PROJECT_PLAN, Identity System).
//!
//! ## How the pieces line up
//!
//! 1. **Linearize.** Each key's chain is reassembled by hash links. Two entries at the same
//!    `(chain, seq)` are a fork - the *only* way un-orderable siblings can arise, and portable
//!    proof of key duplication or compromise. Forks are resolved by a fixed, attacker-independent
//!    tiebreaker (competing `authorize` entries: lowest child pubkey; otherwise lowest entry
//!    hash), recorded as evidence, and the losing branch's descendants fall out naturally because
//!    their `prev_hash` links point at the losing entry. Convergence, not fairness: every honest
//!    observer picks the same winner regardless of the order entries arrived.
//! 2. **Grow the tree.** `authorize` entries on accepted chains add children. Each child's
//!    **rank path** is its parent's rank path plus its birth index among the parent's children
//!    (root = `[]`). The stamped usurper list is cross-checked against the list recomputed from
//!    the parent's own history; a mismatch invalidates the authorization - this is what makes
//!    truncated-lineage forgery unrepresentable rather than merely detectable.
//! 3. **Order.** Authority is lexicographic comparison of rank paths: a prefix is an ancestor
//!    (senior), and at a divergence the smaller branch index is senior. Total, local, stable
//!    under partition - a brand-new child of the senior branch outranks an old child of the
//!    junior branch, deliberately (birth *time* is not derivable under partition; branch
//!    seniority is).
//! 4. **Revoke.** Revocations apply most-senior-first (then lowest entry hash - deterministic).
//!    Retirement (self-issuable) honors all anchored history and leaves the subtree alive;
//!    repudiation (strictly-senior-issuable) quarantines everything beyond the anchored prefixes
//!    and kills the subtree, because a hostile key's child authorizations can be backdated.
//!    Anchors become per-(key, service) **ceilings** the content layer consults.

use std::collections::{BTreeMap, BTreeSet};

use crate::entry::{Payload, SignedEntry, HASH_LEN};
use crate::error::ProtoError;
use crate::registry::{entry_type, service, Anchor, Authorize, Disposition, Revoke};
use crate::validate_next;

type Pubkey = [u8; 32];

/// A key's standing in the tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyStatus {
    /// In the tree, unrevoked.
    Active,
    /// Closed without prejudice: anchored history honored, subtree alive.
    Retired,
    /// Quarantined as hostile: entries beyond the anchors distrusted, subtree dead.
    Repudiated,
    /// Structurally void: on a losing fork branch, or beneath a repudiated key.
    Invalid,
    /// Never (validly) authorized into this tree.
    Unknown,
}

impl KeyStatus {
    pub fn name(self) -> &'static str {
        match self {
            KeyStatus::Active => "active",
            KeyStatus::Retired => "retired",
            KeyStatus::Repudiated => "repudiated",
            KeyStatus::Invalid => "invalid",
            KeyStatus::Unknown => "unknown",
        }
    }
}

/// Per-(key, service) validity ceiling established by a revocation's anchors: entries with
/// `seq <= final_seq` stand; anything beyond is invalid (retirement) or actively distrusted
/// (repudiation).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ceiling {
    pub final_seq: u64,
    pub disposition: Disposition,
}

/// Evidence of a fork: one key signed two different entries at the same sequence number.
/// Byte-for-byte indistinguishable between malice and a stale-backup restore; either way it
/// condemns the *key* (duplication or compromise) and the tiebreaker picks a convergent winner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fork {
    pub author: Pubkey,
    pub seq: u64,
    pub winner: [u8; HASH_LEN],
    pub losers: Vec<[u8; HASH_LEN]>,
}

/// An entry that was structurally sound but semantically rejected, with the reason - kept as
/// evidence and for debugging, never applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejected {
    pub entry_hash: [u8; HASH_LEN],
    pub reason: &'static str,
}

#[derive(Debug, Clone)]
struct Node {
    parent: Option<Pubkey>,
    rank_path: Vec<u64>,
    status: KeyStatus,
}

/// The resolved tree. Build once from entries, query many times.
#[derive(Debug, Clone)]
pub struct KeyTree {
    root: Pubkey,
    nodes: BTreeMap<Pubkey, Node>,
    children: BTreeMap<Pubkey, Vec<Pubkey>>,
    ceilings: BTreeMap<(Pubkey, u32), Ceiling>,
    forks: Vec<Fork>,
    rejected: Vec<Rejected>,
}

impl KeyTree {
    /// Resolve an identity's tree from its identity-chain entries.
    ///
    /// `entries` may arrive in any order and from any mixture of keys; the result is identical
    /// for any permutation of the same set (this is load-bearing - every relying party must
    /// converge). Entries with invalid signatures are a hard error: storage and sync must never
    /// have admitted them. Entries on services other than `identity-public` are ignored.
    pub fn build(root: Pubkey, entries: &[SignedEntry]) -> Result<KeyTree, ProtoError> {
        // Group identity-chain entries by author, deduplicating by entry hash.
        let mut by_author: BTreeMap<Pubkey, BTreeMap<[u8; HASH_LEN], &SignedEntry>> =
            BTreeMap::new();
        for e in entries {
            if e.entry().chain.service != service::IDENTITY_PUBLIC {
                continue;
            }
            e.verify()?;
            by_author
                .entry(e.entry().chain.author)
                .or_default()
                .insert(*e.hash(), e);
        }

        let mut tree = KeyTree {
            root,
            nodes: BTreeMap::new(),
            children: BTreeMap::new(),
            ceilings: BTreeMap::new(),
            forks: Vec::new(),
            rejected: Vec::new(),
        };
        tree.nodes.insert(
            root,
            Node {
                parent: None,
                rank_path: Vec::new(),
                status: KeyStatus::Active,
            },
        );

        // Linearize every author's chain up front (fork resolution is per-chain and does not
        // depend on tree membership).
        let mut chains: BTreeMap<Pubkey, Vec<&SignedEntry>> = BTreeMap::new();
        for (author, candidates) in &by_author {
            chains.insert(*author, tree.linearize(*author, candidates));
        }

        // Grow the tree to fixpoint: processing an author's chain may admit new keys, whose
        // chains then become processable. Usurper stamps are cross-checked as we go.
        let mut usurpers: BTreeMap<Pubkey, Vec<Pubkey>> = BTreeMap::new();
        usurpers.insert(root, Vec::new());
        let mut processed: BTreeSet<Pubkey> = BTreeSet::new();
        loop {
            let ready: Vec<Pubkey> = tree
                .nodes
                .keys()
                .filter(|k| !processed.contains(*k) && chains.contains_key(*k))
                .copied()
                .collect();
            if ready.is_empty() {
                break;
            }
            for author in ready {
                tree.process_authorizations(&author, &chains[&author], &mut usurpers);
                processed.insert(author);
            }
        }

        // Apply revocations most-senior-first (then lowest entry hash), so a senior's word about
        // a junior lands before the junior's own statements are consulted.
        tree.apply_revocations(&chains);

        // Propagate structural death: everything beneath a repudiated or invalid key is invalid.
        tree.propagate_invalidity();

        Ok(tree)
    }

    /// Reassemble one author's chain from candidates, resolving forks deterministically.
    fn linearize<'e>(
        &mut self,
        author: Pubkey,
        candidates: &BTreeMap<[u8; HASH_LEN], &'e SignedEntry>,
    ) -> Vec<&'e SignedEntry> {
        let mut accepted: Vec<&SignedEntry> = Vec::new();
        loop {
            let seq = accepted.len() as u64;
            let prev = accepted.last().copied();
            let mut linkable: Vec<&SignedEntry> = candidates
                .values()
                .filter(|e| e.entry().seq == seq && validate_next(prev, e).is_ok())
                .copied()
                .collect();
            match linkable.len() {
                0 => break,
                1 => accepted.push(linkable[0]),
                _ => {
                    // Fork: pick the convergent winner. Competing authorizations tie-break on
                    // the lowest child pubkey (the plan's rule); anything else on entry hash.
                    linkable.sort_by_key(|e| fork_rank(e));
                    let winner = linkable[0];
                    self.forks.push(Fork {
                        author,
                        seq,
                        winner: *winner.hash(),
                        losers: linkable[1..].iter().map(|e| *e.hash()).collect(),
                    });
                    accepted.push(winner);
                }
            }
        }
        accepted
    }

    /// Walk one accepted chain and admit its validly-stamped children.
    fn process_authorizations(
        &mut self,
        author: &Pubkey,
        chain: &[&SignedEntry],
        usurpers: &mut BTreeMap<Pubkey, Vec<Pubkey>>,
    ) {
        for e in chain {
            if e.entry().entry_type != entry_type::AUTHORIZE {
                continue;
            }
            let Payload::Inline(payload) = &e.entry().payload else {
                self.reject(e, "authorize payload must be inline");
                continue;
            };
            let az = match Authorize::decode(payload) {
                Ok(az) => az,
                Err(_) => {
                    self.reject(e, "undecodable authorize payload");
                    continue;
                }
            };
            if az.child == self.root || self.nodes.contains_key(&az.child) {
                self.reject(e, "child key already present in tree");
                continue;
            }

            // Recompute the expected stamp: parent's usurpers + parent + parent's prior children.
            let mut expected = usurpers[author].clone();
            expected.push(*author);
            expected.extend(self.children.get(author).into_iter().flatten().copied());
            if az.usurpers != expected {
                self.reject(e, "usurper stamp does not match parent history");
                continue;
            }

            let birth_index = self.children.get(author).map_or(0, |c| c.len()) as u64;
            let mut rank_path = self.nodes[author].rank_path.clone();
            rank_path.push(birth_index);

            self.nodes.insert(
                az.child,
                Node {
                    parent: Some(*author),
                    rank_path,
                    status: KeyStatus::Active,
                },
            );
            self.children.entry(*author).or_default().push(az.child);
            usurpers.insert(az.child, az.usurpers);
        }
    }

    fn apply_revocations(&mut self, chains: &BTreeMap<Pubkey, Vec<&SignedEntry>>) {
        // A revoke awaiting application: (signer rank, entry hash, signer, entry seq, payload).
        // Sorted by the first two fields for a deterministic application order.
        type PendingRevoke = (Vec<u64>, [u8; HASH_LEN], Pubkey, u64, Revoke);

        // Collect every revoke from accepted chains of tree members, then order them
        // most-senior-signer-first, tie-broken by entry hash: a deterministic application order
        // is what makes the outcome independent of arrival order.
        let mut revokes: Vec<PendingRevoke> = Vec::new();
        for (signer, chain) in chains {
            let Some(node) = self.nodes.get(signer) else {
                continue;
            };
            let signer_rank = node.rank_path.clone();
            for e in chain {
                if e.entry().entry_type != entry_type::REVOKE {
                    continue;
                }
                let Payload::Inline(payload) = &e.entry().payload else {
                    self.reject(e, "revoke payload must be inline");
                    continue;
                };
                match Revoke::decode(payload) {
                    Ok(rv) => {
                        revokes.push((signer_rank.clone(), *e.hash(), *signer, e.entry().seq, rv))
                    }
                    Err(_) => self.reject(e, "undecodable revoke payload"),
                }
            }
        }
        revokes.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));

        for (signer_rank, entry_hash, signer, entry_seq, rv) in revokes {
            // A signer already quarantined (or writing beyond its own retirement seal) has no
            // voice: its statement past the ceiling is exactly what the ceiling distrusts.
            if let Some(c) = self.ceilings.get(&(signer, service::IDENTITY_PUBLIC)) {
                if entry_seq > c.final_seq {
                    self.rejected.push(Rejected {
                        entry_hash,
                        reason: "revoke lies beyond the signer's own ceiling",
                    });
                    continue;
                }
            }
            if matches!(
                self.nodes.get(&signer).map(|n| n.status),
                Some(KeyStatus::Repudiated) | Some(KeyStatus::Invalid) | None
            ) {
                self.rejected.push(Rejected {
                    entry_hash,
                    reason: "revoke signed by a repudiated or invalid key",
                });
                continue;
            }

            let Some(target_node) = self.nodes.get(&rv.target) else {
                self.rejected.push(Rejected {
                    entry_hash,
                    reason: "revoke targets an unknown key",
                });
                continue;
            };

            // Authority: self-retirement, or a strictly senior signer for either disposition.
            // Lexicographic Less on rank paths *is* strict seniority (prefix = ancestor;
            // divergence = senior branch), so no structural check is needed beyond the compare.
            let strictly_senior = signer_rank.as_slice() < target_node.rank_path.as_slice();
            let authorized = match rv.disposition {
                Disposition::Retirement => signer == rv.target || strictly_senior,
                Disposition::Repudiation => signer != rv.target && strictly_senior,
            };
            if !authorized {
                self.rejected.push(Rejected {
                    entry_hash,
                    reason: "revoker is not senior to its target",
                });
                continue;
            }

            // Conflicts: the strictest standing claim wins. Repudiation over retirement;
            // first-applied (most senior, then lowest hash) among equals.
            let current = self.nodes[&rv.target].status;
            let apply = matches!(
                (current, rv.disposition),
                (KeyStatus::Active, _) | (KeyStatus::Retired, Disposition::Repudiation)
            );
            if !apply {
                continue;
            }

            self.nodes.get_mut(&rv.target).unwrap().status = match rv.disposition {
                Disposition::Retirement => KeyStatus::Retired,
                Disposition::Repudiation => KeyStatus::Repudiated,
            };
            for Anchor {
                service: svc,
                seq,
                head_hash: _,
            } in &rv.anchors
            {
                self.ceilings.insert(
                    (rv.target, *svc),
                    Ceiling {
                        final_seq: *seq,
                        disposition: rv.disposition,
                    },
                );
            }
        }
    }

    /// Everything beneath a repudiated (or already-invalid) key is structurally void: a hostile
    /// key's child authorizations can be backdated, so none can be trusted. Retirement leaves
    /// children standing. Parents sort before children by rank-path length, so one pass suffices.
    fn propagate_invalidity(&mut self) {
        let mut order: Vec<Pubkey> = self.nodes.keys().copied().collect();
        order.sort_by_key(|k| self.nodes[k].rank_path.len());
        for key in order {
            let Some(parent) = self.nodes[&key].parent else {
                continue;
            };
            let parent_status = self.nodes[&parent].status;
            if matches!(parent_status, KeyStatus::Repudiated | KeyStatus::Invalid) {
                self.nodes.get_mut(&key).unwrap().status = KeyStatus::Invalid;
            }
        }
    }

    fn reject(&mut self, e: &SignedEntry, reason: &'static str) {
        self.rejected.push(Rejected {
            entry_hash: *e.hash(),
            reason,
        });
    }

    // -------------------------------------------------------------------------------------
    // Queries

    pub fn root(&self) -> &Pubkey {
        &self.root
    }

    pub fn status(&self, key: &Pubkey) -> KeyStatus {
        self.nodes.get(key).map_or(KeyStatus::Unknown, |n| n.status)
    }

    /// The total authority order: `Less` means `a` is senior to `b`. `None` if either key is not
    /// a tree member - unknown keys have no rank, which is the point.
    pub fn compare(&self, a: &Pubkey, b: &Pubkey) -> Option<core::cmp::Ordering> {
        let (na, nb) = (self.nodes.get(a)?, self.nodes.get(b)?);
        Some(na.rank_path.cmp(&nb.rank_path))
    }

    pub fn is_senior(&self, a: &Pubkey, b: &Pubkey) -> bool {
        matches!(self.compare(a, b), Some(core::cmp::Ordering::Less))
    }

    /// The key's rank path (root = `[]`), if it is a member.
    pub fn rank_path(&self, key: &Pubkey) -> Option<&[u64]> {
        self.nodes.get(key).map(|n| n.rank_path.as_slice())
    }

    /// The children of `key` in birth order. Needed by anyone *extending* the tree: the usurper
    /// stamp for a new child is `usurpers(parent) + parent + children_of(parent)`.
    pub fn children_of(&self, key: &Pubkey) -> &[Pubkey] {
        self.children.get(key).map_or(&[], |v| v.as_slice())
    }

    /// Validity ceiling for one of the key's chains, if a revocation has sealed it.
    pub fn ceiling(&self, key: &Pubkey, service_id: u32) -> Option<Ceiling> {
        self.ceilings.get(&(*key, service_id)).copied()
    }

    /// Every key the tree has admitted (any status), in pubkey order.
    pub fn members(&self) -> impl Iterator<Item = (&Pubkey, KeyStatus)> {
        self.nodes.iter().map(|(k, n)| (k, n.status))
    }

    /// Fork evidence gathered during linearization. A non-empty list condemns the forking key
    /// (duplication or compromise) - policy above this layer decides what to do about it.
    pub fn forks(&self) -> &[Fork] {
        &self.forks
    }

    /// Entries that were structurally sound but semantically refused, with reasons.
    pub fn rejected(&self) -> &[Rejected] {
        &self.rejected
    }
}

/// Fork tiebreak rank: competing authorizations compare by child pubkey (lowest wins - the
/// plan's fixed, attacker-independent property), everything else by entry hash. The leading
/// discriminant keeps the two classes from interleaving.
fn fork_rank(e: &SignedEntry) -> (u8, [u8; 32]) {
    if e.entry().entry_type == entry_type::AUTHORIZE {
        if let Payload::Inline(p) = &e.entry().payload {
            if let Ok(az) = Authorize::decode(p) {
                return (0, az.child);
            }
        }
    }
    (1, *e.hash())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entry::{ChainId, Entry, ENTRY_VERSION, ZERO_HASH};
    use ed25519_dalek::SigningKey;

    /// A test key with its identity-chain state, so chains stay dense and hash-linked.
    struct TestKey {
        sk: SigningKey,
        seq: u64,
        prev: [u8; 32],
        usurpers: Vec<Pubkey>,
        children: Vec<Pubkey>,
    }

    impl TestKey {
        fn new(seed: u8, usurpers: Vec<Pubkey>) -> Self {
            Self {
                sk: SigningKey::from_bytes(&[seed; 32]),
                seq: 0,
                prev: ZERO_HASH,
                usurpers,
                children: Vec::new(),
            }
        }

        fn pk(&self) -> Pubkey {
            self.sk.verifying_key().to_bytes()
        }

        fn append(&mut self, entry_type_id: u32, payload: Vec<u8>) -> SignedEntry {
            let entry = Entry {
                v: ENTRY_VERSION,
                entry_type: entry_type_id,
                chain: ChainId {
                    author: self.pk(),
                    service: service::IDENTITY_PUBLIC,
                },
                seq: self.seq,
                prev_hash: self.prev,
                timestamp_ms: 1_700_000_000_000 + self.seq,
                payload: Payload::Inline(payload),
            };
            let signed = SignedEntry::create(&entry, &self.sk).unwrap();
            self.seq += 1;
            self.prev = *signed.hash();
            signed
        }

        /// Authorize a new child with a correctly-computed stamp; returns (child, entry).
        fn authorize(&mut self, child_seed: u8) -> (TestKey, SignedEntry) {
            let mut stamp = self.usurpers.clone();
            stamp.push(self.pk());
            stamp.extend(self.children.iter().copied());

            let child = TestKey::new(child_seed, stamp.clone());
            let payload = Authorize {
                child: child.pk(),
                usurpers: stamp,
            }
            .encode()
            .unwrap();
            let entry = self.append(entry_type::AUTHORIZE, payload);
            self.children.push(child.pk());
            (child, entry)
        }

        fn revoke(
            &mut self,
            target: Pubkey,
            disposition: Disposition,
            anchors: Vec<Anchor>,
        ) -> SignedEntry {
            let payload = Revoke {
                target,
                disposition,
                anchors,
            }
            .encode()
            .unwrap();
            self.append(entry_type::REVOKE, payload)
        }
    }

    /// R -> recovery(A), laptop(B); B -> phone(C). The canonical family.
    fn family() -> (TestKey, TestKey, TestKey, TestKey, Vec<SignedEntry>) {
        let mut root = TestKey::new(1, vec![]);
        let (recovery, e0) = root.authorize(2);
        let (mut laptop, e1) = root.authorize(3);
        let (phone, e2) = laptop.authorize(4);
        (root, recovery, laptop, phone, vec![e0, e1, e2])
    }

    #[test]
    fn family_tree_is_totally_ordered() {
        let (root, recovery, laptop, phone, entries) = family();
        let tree = KeyTree::build(root.pk(), &entries).unwrap();

        use core::cmp::Ordering::Less;
        assert_eq!(tree.rank_path(&root.pk()).unwrap(), &[] as &[u64]);
        assert_eq!(tree.rank_path(&recovery.pk()).unwrap(), &[0]);
        assert_eq!(tree.rank_path(&laptop.pk()).unwrap(), &[1]);
        assert_eq!(tree.rank_path(&phone.pk()).unwrap(), &[1, 0]);

        // Root over everyone; recovery over every later key including its "nephew".
        for junior in [recovery.pk(), laptop.pk(), phone.pk()] {
            assert_eq!(tree.compare(&root.pk(), &junior), Some(Less));
        }
        assert_eq!(tree.compare(&recovery.pk(), &laptop.pk()), Some(Less));
        assert_eq!(
            tree.compare(&recovery.pk(), &phone.pk()),
            Some(Less),
            "senior branch wins"
        );
        assert_eq!(tree.compare(&laptop.pk(), &phone.pk()), Some(Less));

        // Everyone is Active; a stranger is Unknown.
        for k in [root.pk(), recovery.pk(), laptop.pk(), phone.pk()] {
            assert_eq!(tree.status(&k), KeyStatus::Active);
        }
        assert_eq!(tree.status(&[0xEE; 32]), KeyStatus::Unknown);
        assert!(tree.forks().is_empty());
        assert!(tree.rejected().is_empty());
    }

    #[test]
    fn build_is_order_independent() {
        let (root, _, _, _, mut entries) = family();
        let forward = KeyTree::build(root.pk(), &entries).unwrap();
        entries.reverse();
        let backward = KeyTree::build(root.pk(), &entries).unwrap();

        let f: Vec<_> = forward.members().map(|(k, s)| (*k, s)).collect();
        let b: Vec<_> = backward.members().map(|(k, s)| (*k, s)).collect();
        assert_eq!(f, b);
    }

    #[test]
    fn forged_usurper_stamp_is_rejected() {
        let mut root = TestKey::new(1, vec![]);
        let (_recovery, e0) = root.authorize(2);

        // Root authorizes a second child but the stamp claims it is the *first* (hiding the
        // recovery key) - the truncated-lineage forgery.
        let liar = TestKey::new(3, vec![]);
        let bad_stamp = Authorize {
            child: liar.pk(),
            usurpers: vec![root.pk()],
        } // missing recovery
        .encode()
        .unwrap();
        let e1 = root.append(entry_type::AUTHORIZE, bad_stamp);

        let tree = KeyTree::build(root.pk(), &[e0, e1]).unwrap();
        assert_eq!(tree.status(&liar.pk()), KeyStatus::Unknown);
        assert_eq!(tree.rejected().len(), 1);
        assert_eq!(
            tree.rejected()[0].reason,
            "usurper stamp does not match parent history"
        );
    }

    #[test]
    fn equivocation_resolves_convergently() {
        // The stale-backup accident: the same root, in two histories unaware of each other,
        // authorizes two different children at seq 0.
        let mut history_a = TestKey::new(1, vec![]);
        let (child_a, ea) = history_a.authorize(10);
        let mut history_b = TestKey::new(1, vec![]); // same key, pristine state
        let (child_b, eb) = history_b.authorize(20);
        let root_pk = history_a.pk();

        let tree_ab = KeyTree::build(root_pk, &[ea.clone(), eb.clone()]).unwrap();
        let tree_ba = KeyTree::build(root_pk, &[eb, ea]).unwrap();

        // Same winner regardless of arrival order: the lowest child pubkey.
        let winner = if child_a.pk() < child_b.pk() {
            child_a.pk()
        } else {
            child_b.pk()
        };
        let loser = if winner == child_a.pk() {
            child_b.pk()
        } else {
            child_a.pk()
        };
        for tree in [&tree_ab, &tree_ba] {
            assert_eq!(tree.status(&winner), KeyStatus::Active);
            assert_eq!(
                tree.status(&loser),
                KeyStatus::Unknown,
                "losing fork never enters"
            );
            assert_eq!(tree.forks().len(), 1);
            assert_eq!(tree.forks()[0].author, root_pk);
        }
        assert_eq!(tree_ab.forks(), tree_ba.forks());
    }

    #[test]
    fn retirement_preserves_the_subtree_and_seals_the_chain() {
        let (root, _recovery, mut laptop, phone, mut entries) = family();

        // Laptop retires itself, anchoring its identity chain at its current head (the
        // retirement entry itself will sit at seq 1, so the final word is seq 1).
        let anchors = vec![Anchor {
            service: service::IDENTITY_PUBLIC,
            seq: 1,
            head_hash: [0u8; 32],
        }];
        entries.push(laptop.revoke(laptop.pk(), Disposition::Retirement, anchors));

        let tree = KeyTree::build(root.pk(), &entries).unwrap();
        assert_eq!(tree.status(&laptop.pk()), KeyStatus::Retired);
        assert_eq!(
            tree.status(&phone.pk()),
            KeyStatus::Active,
            "retirement spares children"
        );
        assert_eq!(
            tree.ceiling(&laptop.pk(), service::IDENTITY_PUBLIC),
            Some(Ceiling {
                final_seq: 1,
                disposition: Disposition::Retirement
            })
        );
    }

    #[test]
    fn repudiation_kills_the_subtree() {
        let (mut root, recovery, laptop, phone, mut entries) = family();

        entries.push(root.revoke(
            laptop.pk(),
            Disposition::Repudiation,
            vec![Anchor {
                service: service::IDENTITY_PUBLIC,
                seq: 0,
                head_hash: [0u8; 32],
            }],
        ));

        let tree = KeyTree::build(root.pk(), &entries).unwrap();
        assert_eq!(tree.status(&laptop.pk()), KeyStatus::Repudiated);
        assert_eq!(
            tree.status(&phone.pk()),
            KeyStatus::Invalid,
            "the subtree dies"
        );
        assert_eq!(tree.status(&recovery.pk()), KeyStatus::Active);
        assert_eq!(tree.status(&root.pk()), KeyStatus::Active);
    }

    #[test]
    fn juniors_cannot_revoke_seniors_and_repudiation_is_never_self_issued() {
        let (root, recovery, laptop, mut phone, mut entries) = family();

        // The phone tries to repudiate the recovery key (junior over senior) and itself.
        entries.push(phone.revoke(recovery.pk(), Disposition::Repudiation, vec![]));
        entries.push(phone.revoke(phone.pk(), Disposition::Repudiation, vec![]));

        let tree = KeyTree::build(root.pk(), &entries).unwrap();
        assert_eq!(tree.status(&recovery.pk()), KeyStatus::Active);
        assert_eq!(tree.status(&phone.pk()), KeyStatus::Active);
        assert_eq!(tree.rejected().len(), 2);
        let _ = laptop;
    }

    #[test]
    fn the_recovery_key_repudiates_a_compromised_branch_after_root_retires() {
        // The migration story: root retires (its history stands), then the laptop turns out to
        // be compromised and the structurally-senior recovery key evicts it - no root required.
        let (mut root, mut recovery, laptop, phone, mut entries) = family();

        entries.push(root.revoke(
            root.pk(),
            Disposition::Retirement,
            // The retirement entry itself is root's seq 2 (after two authorizes): its own final
            // word is part of the honored history.
            vec![Anchor {
                service: service::IDENTITY_PUBLIC,
                seq: 2,
                head_hash: [0u8; 32],
            }],
        ));
        entries.push(recovery.revoke(
            laptop.pk(),
            Disposition::Repudiation,
            vec![Anchor {
                service: service::IDENTITY_PUBLIC,
                seq: 0,
                head_hash: [0u8; 32],
            }],
        ));

        let tree = KeyTree::build(root.pk(), &entries).unwrap();
        assert_eq!(tree.status(&root.pk()), KeyStatus::Retired);
        assert_eq!(tree.status(&recovery.pk()), KeyStatus::Active);
        assert_eq!(tree.status(&laptop.pk()), KeyStatus::Repudiated);
        assert_eq!(tree.status(&phone.pk()), KeyStatus::Invalid);
    }

    #[test]
    fn a_repudiated_key_has_no_voice() {
        // Root repudiates the laptop; the laptop (already quarantined) tries to repudiate the
        // recovery key. Application order is seniority-sorted, so the laptop's statement is
        // refused no matter the arrival order of entries.
        let (mut root, recovery, mut laptop, _phone, mut entries) = family();

        entries.push(laptop.revoke(recovery.pk(), Disposition::Repudiation, vec![]));
        entries.push(root.revoke(
            laptop.pk(),
            Disposition::Repudiation,
            vec![Anchor {
                service: service::IDENTITY_PUBLIC,
                seq: 0,
                head_hash: [0u8; 32],
            }],
        ));

        let tree = KeyTree::build(root.pk(), &entries).unwrap();
        assert_eq!(tree.status(&recovery.pk()), KeyStatus::Active);
        assert_eq!(tree.status(&laptop.pk()), KeyStatus::Repudiated);
        assert!(tree.rejected().iter().any(|r| r.reason
            == "revoke signed by a repudiated or invalid key"
            || r.reason == "revoke lies beyond the signer's own ceiling"
            || r.reason == "revoker is not senior to its target"));
    }

    /// The M2 exit property: arbitrary honest trees are always totally ordered, with no
    /// tiebreaker needed, and the resolution is independent of entry arrival order. Seeded LCG
    /// instead of a proptest dependency: deterministic, replayable by seed, zero deps.
    #[test]
    fn random_honest_trees_are_totally_ordered_and_convergent() {
        for seed in 0..25u64 {
            let mut state = seed.wrapping_mul(2654435761).wrapping_add(1);
            let mut next = |bound: usize| -> usize {
                state = state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                ((state >> 33) as usize) % bound
            };

            // Grow a random tree: each step authorizes a fresh key under a random existing one.
            let mut keys: Vec<TestKey> = vec![TestKey::new(1, vec![])];
            let mut entries: Vec<SignedEntry> = Vec::new();
            let n_children = 3 + next(9);
            for i in 0..n_children {
                let parent_idx = next(keys.len());
                let (child, entry) = keys[parent_idx].authorize(10 + i as u8);
                keys.push(child);
                entries.push(entry);
            }
            let root_pk = keys[0].pk();
            let tree = KeyTree::build(root_pk, &entries).unwrap();

            // Everyone admitted, nothing rejected, no forks in an honest tree.
            assert!(tree.forks().is_empty(), "seed {seed}");
            assert!(tree.rejected().is_empty(), "seed {seed}");
            let pks: Vec<Pubkey> = keys.iter().map(|k| k.pk()).collect();
            for pk in &pks {
                assert_eq!(tree.status(pk), KeyStatus::Active, "seed {seed}");
            }

            // Total order: reflexively equal, antisymmetric, transitive, no incomparable pairs.
            use core::cmp::Ordering;
            for a in &pks {
                for b in &pks {
                    let ab = tree.compare(a, b).expect("members are always comparable");
                    let ba = tree.compare(b, a).unwrap();
                    assert_eq!(ab, ba.reverse(), "seed {seed}: antisymmetry");
                    assert_eq!(
                        ab == Ordering::Equal,
                        a == b,
                        "seed {seed}: equality iff same key"
                    );
                    for c in &pks {
                        let bc = tree.compare(b, c).unwrap();
                        if ab == Ordering::Less && bc == Ordering::Less {
                            assert_eq!(
                                tree.compare(a, c),
                                Some(Ordering::Less),
                                "seed {seed}: transitivity"
                            );
                        }
                    }
                }
            }

            // Root is senior to everyone; every parent is senior to its child; and the first
            // child of root (the recovery-key position) is senior to every other non-root key -
            // forever, no matter how the tree grew afterward.
            let recovery_pk = pks[1];
            for pk in &pks[1..] {
                assert!(tree.is_senior(&root_pk, pk), "seed {seed}: root over all");
                if *pk != recovery_pk {
                    assert!(
                        tree.is_senior(&recovery_pk, pk),
                        "seed {seed}: recovery position outranks all later keys"
                    );
                }
            }

            // Convergence: a deterministically shuffled arrival order yields the identical tree.
            let mut shuffled = entries.clone();
            shuffled.reverse();
            let rot = next(shuffled.len().max(1));
            shuffled.rotate_left(rot);
            let tree2 = KeyTree::build(root_pk, &shuffled).unwrap();
            for pk in &pks {
                assert_eq!(tree.status(pk), tree2.status(pk), "seed {seed}");
                assert_eq!(tree.rank_path(pk), tree2.rank_path(pk), "seed {seed}");
            }
        }
    }

    #[test]
    fn senior_repudiation_beats_self_retirement() {
        // The "attacker eased out the door quietly" case: the compromised laptop self-retires
        // (innocently-looking), but root repudiates it. The stricter senior claim wins.
        let (mut root, _recovery, mut laptop, phone, mut entries) = family();

        entries.push(laptop.revoke(
            laptop.pk(),
            Disposition::Retirement,
            vec![Anchor {
                service: service::IDENTITY_PUBLIC,
                seq: 1,
                head_hash: [0u8; 32],
            }],
        ));
        entries.push(root.revoke(
            laptop.pk(),
            Disposition::Repudiation,
            vec![Anchor {
                service: service::IDENTITY_PUBLIC,
                seq: 0,
                head_hash: [0u8; 32],
            }],
        ));

        let tree = KeyTree::build(root.pk(), &entries).unwrap();
        assert_eq!(tree.status(&laptop.pk()), KeyStatus::Repudiated);
        assert_eq!(tree.status(&phone.pk()), KeyStatus::Invalid);
        assert_eq!(
            tree.ceiling(&laptop.pk(), service::IDENTITY_PUBLIC)
                .unwrap()
                .disposition,
            Disposition::Repudiation
        );
    }
}
