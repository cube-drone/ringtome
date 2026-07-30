//! The CROWN - the key tree: authority resolution for one identity.
//!
//! CROWN is the name of this specific scheme (the hierarchical pubkey tree with ranks,
//! structural seniority, and usurper lists - PROJECT_PLAN, Identity System). In prose and in
//! most code, plain "identity"/"key tree" stays the clearer word; `Crown` is the shorthand for
//! this exact structure and its verdicts.
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
//!    Anchors become per-(key, service) **ceilings** the content layer consults - and the
//!    anchor's *hash*, not just its seq, is what a ceiling enforces: the sealed prefix is the
//!    exact hash-linked chain culminating in `head_hash`. A revoked key is still attacker-held,
//!    so `seq <= final_seq` alone proves nothing - the attacker can sign a fresh under-ceiling
//!    prefix at will. For the identity chain this tree credits a ceilinged key's statements
//!    (authorizations, revokes) **only** from a prefix that provably seals: held through
//!    `final_seq` and matching `head_hash` there. Anything else - contradicted, incomplete, or
//!    unanchored entirely - credits nothing: fail closed, authority must be proven.

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

/// Per-(key, service) validity ceiling established by a revocation's anchors: the exact
/// hash-linked prefix culminating in `head_hash` at `final_seq` stands; anything beyond is
/// invalid (retirement) or actively distrusted (repudiation). The hash is load-bearing: the
/// revoked key is still attacker-held, so a bare `seq <= final_seq` check would admit a freshly
/// forged under-ceiling prefix. Enforcers must require the prefix that actually seals.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ceiling {
    pub final_seq: u64,
    pub disposition: Disposition,
    /// Hash of the anchored entry at `final_seq` - transitively, of the whole sealed prefix.
    pub head_hash: [u8; HASH_LEN],
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
    /// Seq of the authorize entry (on the parent's chain) that admitted this key; 0 for the
    /// root. A ceiling on the parent's identity chain consults this: children born beyond the
    /// sealed prefix are phantoms.
    birth_seq: u64,
    /// Entry hash of the revocation this tree credited against the key, if any. A revoke can
    /// never anchor itself, so a *self*-retirement sits where seal-or-nothing would refuse it
    /// (one seq beyond its own anchor - or an anchorless chain's only entry); this names the
    /// one statement an enforcer must keep anyway, competing forks already settled.
    revocation: Option<[u8; HASH_LEN]>,
}

/// How one accepted chain stands against a ceiling's anchor.
enum Seal {
    /// The held prefix reaches `final_seq` and the entry there is exactly the anchored one -
    /// hash links make the entire prefix beneath it the anchored history.
    Sealed,
    /// The chain stops short of `final_seq`: nothing proven, so nothing credited (fail closed);
    /// a later, fuller view may still seal.
    Incomplete,
    /// The held entry at `final_seq` is not the anchored one - cryptographic proof that this
    /// chain is a fabrication, not the sealed prefix. Carries the offending entry's hash.
    Contradicted([u8; HASH_LEN]),
}

/// Judge a linearized chain (dense from seq 0, so index == seq) against a ceiling's anchor.
fn seal_state(chain: &[&SignedEntry], c: &Ceiling) -> Seal {
    match usize::try_from(c.final_seq).ok().and_then(|i| chain.get(i)) {
        None => Seal::Incomplete,
        Some(e) if *e.hash() == c.head_hash => Seal::Sealed,
        Some(e) => Seal::Contradicted(*e.hash()),
    }
}

/// The resolved tree. Build once from entries, query many times.
#[derive(Debug, Clone)]
pub struct Crown {
    root: Pubkey,
    nodes: BTreeMap<Pubkey, Node>,
    children: BTreeMap<Pubkey, Vec<Pubkey>>,
    ceilings: BTreeMap<(Pubkey, u32), Ceiling>,
    forks: Vec<Fork>,
    rejected: Vec<Rejected>,
}

impl Crown {
    /// Resolve an identity's tree from its identity-chain entries.
    ///
    /// `entries` may arrive in any order and from any mixture of keys; the result is identical
    /// for any permutation of the same set (this is load-bearing - every relying party must
    /// converge). Entries with invalid signatures are a hard error: storage and sync must never
    /// have admitted them. Entries on services other than `identity-public` are ignored.
    pub fn build(root: Pubkey, entries: &[SignedEntry]) -> Result<Crown, ProtoError> {
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

        let mut tree = Crown {
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
                birth_seq: 0,
                revocation: None,
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
            let authorization = match Authorize::decode(payload) {
                Ok(authorization) => authorization,
                Err(_) => {
                    self.reject(e, "undecodable authorize payload");
                    continue;
                }
            };
            if authorization.child == self.root || self.nodes.contains_key(&authorization.child) {
                self.reject(e, "child key already present in tree");
                continue;
            }

            // Recompute the expected stamp: parent's usurpers + parent + parent's prior children.
            let mut expected = usurpers[author].clone();
            expected.push(*author);
            expected.extend(self.children.get(author).into_iter().flatten().copied());
            if authorization.usurpers != expected {
                self.reject(e, "usurper stamp does not match parent history");
                continue;
            }

            let birth_index = self.children.get(author).map_or(0, |c| c.len()) as u64;
            let mut rank_path = self.nodes[author].rank_path.clone();
            rank_path.push(birth_index);

            self.nodes.insert(
                authorization.child,
                Node {
                    parent: Some(*author),
                    rank_path,
                    status: KeyStatus::Active,
                    birth_seq: e.entry().seq,
                    revocation: None,
                },
            );
            self.children
                .entry(*author)
                .or_default()
                .push(authorization.child);
            usurpers.insert(authorization.child, authorization.usurpers);
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
                    Ok(revocation) => revokes.push((
                        signer_rank.clone(),
                        *e.hash(),
                        *signer,
                        e.entry().seq,
                        revocation,
                    )),
                    Err(_) => self.reject(e, "undecodable revoke payload"),
                }
            }
        }
        revokes.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));

        for (signer_rank, entry_hash, signer, entry_seq, revocation) in revokes {
            // A signer already quarantined (or writing beyond its own retirement seal) has no
            // voice: its statement past the ceiling is exactly what the ceiling distrusts.
            // Under the ceiling is not enough, either: the revoked key is still attacker-held,
            // so the revoke must sit on the *sealed* prefix - the one culminating in the
            // anchor's hash - or it is a fresh fabrication wearing an old seq.
            if let Some(c) = self.ceilings.get(&(signer, service::IDENTITY_PUBLIC)) {
                if entry_seq > c.final_seq {
                    self.rejected.push(Rejected {
                        entry_hash,
                        reason: "revoke lies beyond the signer's own ceiling",
                    });
                    continue;
                }
                let held = chains.get(&signer).map_or(&[][..], Vec::as_slice);
                if !matches!(seal_state(held, c), Seal::Sealed) {
                    self.rejected.push(Rejected {
                        entry_hash,
                        reason: "revoke is not on the signer's sealed prefix",
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

            let Some(target_node) = self.nodes.get(&revocation.target) else {
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
            let authorized = match revocation.disposition {
                Disposition::Retirement => signer == revocation.target || strictly_senior,
                Disposition::Repudiation => signer != revocation.target && strictly_senior,
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
            let current = self.nodes[&revocation.target].status;
            let apply = matches!(
                (current, revocation.disposition),
                (KeyStatus::Active, _) | (KeyStatus::Retired, Disposition::Repudiation)
            );
            if !apply {
                continue;
            }

            let target_node = self.nodes.get_mut(&revocation.target).unwrap();
            target_node.status = match revocation.disposition {
                Disposition::Retirement => KeyStatus::Retired,
                Disposition::Repudiation => KeyStatus::Repudiated,
            };
            target_node.revocation = Some(entry_hash);
            for Anchor {
                service: svc,
                seq,
                head_hash,
            } in &revocation.anchors
            {
                self.ceilings.insert(
                    (revocation.target, *svc),
                    Ceiling {
                        final_seq: *seq,
                        disposition: revocation.disposition,
                        head_hash: *head_hash,
                    },
                );
            }
            self.enforce_identity_seal(&revocation.target, chains);
        }
    }

    /// Fail-closed crediting for a freshly-ceilinged key's identity chain: the ceilinged key is
    /// (by hypothesis) attacker-holdable, so its chain is believed only as the exact sealed
    /// prefix the anchor pins. Runs *inside* the deterministic revoke-application order, not
    /// after it, because interim status matters: a phantom child minted by an unsealed chain
    /// must already be Invalid when its own (later-sorted, junior) revokes come up for
    /// application.
    ///
    /// - **Sealed:** anchored history is credited; children authorized *beyond* the seal are
    ///   phantoms (only the attacker can extend a ceilinged chain) and their subtrees die.
    /// - **Contradicted:** the held entry at `final_seq` is not the anchored one - cryptographic
    ///   proof of forgery, recorded as evidence; the whole chain credits nothing.
    /// - **Incomplete / unanchored:** nothing is proven, so nothing is credited (a fuller view
    ///   may still seal; until then, authority must be proven, not presumed). A revocation that
    ///   anchors no identity chain while we hold identity entries for the key is the same
    ///   posture: an honest revoker anchors every chain it has seen, so an unanchored chain is
    ///   a straggler at best and a fabrication at worst.
    fn enforce_identity_seal(
        &mut self,
        target: &Pubkey,
        chains: &BTreeMap<Pubkey, Vec<&SignedEntry>>,
    ) {
        let held = chains.get(target).map_or(&[][..], Vec::as_slice);
        let child_list = self.children.get(target).cloned().unwrap_or_default();
        let doomed: Vec<Pubkey> = match self.ceilings.get(&(*target, service::IDENTITY_PUBLIC)) {
            Some(c) => match seal_state(held, c) {
                Seal::Sealed => {
                    let final_seq = c.final_seq;
                    child_list
                        .into_iter()
                        .filter(|ch| self.nodes[ch].birth_seq > final_seq)
                        .collect()
                }
                Seal::Contradicted(entry_hash) => {
                    self.rejected.push(Rejected {
                        entry_hash,
                        reason: "identity chain contradicts the revocation anchor",
                    });
                    child_list
                }
                Seal::Incomplete => child_list,
            },
            None => child_list,
        };
        // Structurally void the phantom subtrees now; the final propagate_invalidity pass would
        // reach the descendants too, but too late for the revoke checks above.
        let mut stack = doomed;
        while let Some(key) = stack.pop() {
            if let Some(n) = self.nodes.get_mut(&key) {
                n.status = KeyStatus::Invalid;
            }
            stack.extend(self.children.get(&key).into_iter().flatten().copied());
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
    /// The entry hash of the revocation this tree credited against `key`, if any. This is what
    /// lets an enforcer keep the one statement seal-or-nothing would otherwise refuse: a
    /// *self*-retirement's revoke can never sit on its own sealed prefix (a revoke cannot
    /// anchor itself), landing instead one seq beyond the anchor - or, for a key that retired
    /// before ever writing identity history, as an anchorless chain's only entry. Competing
    /// revokes forked at the same seat were already settled by resolution; this names the
    /// winner.
    pub fn revocation_of(&self, key: &Pubkey) -> Option<[u8; HASH_LEN]> {
        self.nodes.get(key).and_then(|n| n.revocation)
    }

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

    /// The complete usurper stamp for a new child of `parent` - the formula above, computed for
    /// ANY member, not just the root: walk the parent's rank path from the root accumulating
    /// each ancestor and its earlier siblings (everyone who outranks the parent), then append
    /// the parent and its existing children. This is what un-trims junior grants: any Active
    /// key can extend the tree, and this is the confession-of-seniors its new child must carry.
    /// `None` when `parent` is not a member.
    pub fn usurper_stamp_for_new_child(&self, parent: &Pubkey) -> Option<Vec<Pubkey>> {
        let path = self.rank_path(parent)?;
        let mut stamp = Vec::new();
        let mut current = *self.root();
        for &idx in path {
            let kids = self.children_of(&current);
            let idx = usize::try_from(idx).ok()?;
            stamp.push(current);
            stamp.extend_from_slice(kids.get(..idx)?);
            current = *kids.get(idx)?;
        }
        debug_assert_eq!(&current, parent, "rank path must lead to the parent");
        stamp.push(current);
        stamp.extend_from_slice(self.children_of(&current));
        Some(stamp)
    }

    /// Validity ceiling for one of the key's chains, if a revocation has sealed it.
    pub fn ceiling(&self, key: &Pubkey, service_id: u32) -> Option<Ceiling> {
        self.ceilings.get(&(*key, service_id)).copied()
    }

    /// Every established ceiling, in (key, service) order. The node's ingest gate sweeps these
    /// to disprove already-stored chains: a stored entry at `final_seq` that is not the anchored
    /// one convicts the whole stored chain as fabrication.
    pub fn ceilings(&self) -> impl Iterator<Item = (&(Pubkey, u32), &Ceiling)> {
        self.ceilings.iter()
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
            if let Ok(authorization) = Authorize::decode(p) {
                return (0, authorization.child);
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
                timestamp_ms: 1_700_000_000_000 + self.seq as i64,
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
                enc_pubkey: None,
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

        /// The real anchor for this key's identity chain at its current head - the (seq, hash)
        /// every fixture used to fake with zeros, which is exactly how the hash check went
        /// untested. A revoke entry can never anchor *itself* (its payload would have to contain
        /// its own hash), so a self-retirement anchors the pre-revocation head and the revoke
        /// entry hash-links onto the sealed head from just beyond it.
        fn head_anchor(&self) -> Anchor {
            assert!(self.seq > 0, "no head to anchor yet");
            Anchor {
                service: service::IDENTITY_PUBLIC,
                seq: self.seq - 1,
                head_hash: self.prev,
            }
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
        let tree = Crown::build(root.pk(), &entries).unwrap();

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
        let forward = Crown::build(root.pk(), &entries).unwrap();
        entries.reverse();
        let backward = Crown::build(root.pk(), &entries).unwrap();

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
            enc_pubkey: None,
        } // missing recovery
        .encode()
        .unwrap();
        let e1 = root.append(entry_type::AUTHORIZE, bad_stamp);

        let tree = Crown::build(root.pk(), &[e0, e1]).unwrap();
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

        let tree_ab = Crown::build(root_pk, &[ea.clone(), eb.clone()]).unwrap();
        let tree_ba = Crown::build(root_pk, &[eb, ea]).unwrap();

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

        // Laptop retires itself, anchoring its identity chain at its real current head (the
        // authorize-phone entry at seq 0; the retirement entry itself sits just beyond the
        // seal, hash-linked onto the anchored head).
        let anchor = laptop.head_anchor();
        let retirement = laptop.revoke(laptop.pk(), Disposition::Retirement, vec![anchor]);
        let origin = *retirement.hash();
        entries.push(retirement);

        let tree = Crown::build(root.pk(), &entries).unwrap();
        assert_eq!(tree.status(&laptop.pk()), KeyStatus::Retired);
        assert_eq!(
            tree.status(&phone.pk()),
            KeyStatus::Active,
            "retirement spares anchored children"
        );
        assert_eq!(
            tree.ceiling(&laptop.pk(), service::IDENTITY_PUBLIC),
            Some(Ceiling {
                final_seq: 0,
                disposition: Disposition::Retirement,
                head_hash: anchor.head_hash,
            })
        );
        assert_eq!(
            tree.revocation_of(&laptop.pk()),
            Some(origin),
            "the credited revoke is named, for enforcers to keep beyond the seal"
        );
    }

    #[test]
    fn an_anchorless_first_entry_self_retirement_is_credited() {
        // A key that retires before ever writing identity history: the revoke is its chain's
        // only entry, with nothing to anchor. Seal-or-nothing has no prefix to credit -
        // `revocation_of` is what still names the statement enforcers must keep.
        let (root, _recovery, _laptop, mut phone, mut entries) = family();

        let retirement = phone.revoke(phone.pk(), Disposition::Retirement, vec![]);
        let origin = *retirement.hash();
        entries.push(retirement);

        let tree = Crown::build(root.pk(), &entries).unwrap();
        assert_eq!(tree.status(&phone.pk()), KeyStatus::Retired);
        assert_eq!(tree.ceiling(&phone.pk(), service::IDENTITY_PUBLIC), None);
        assert_eq!(tree.revocation_of(&phone.pk()), Some(origin));
    }

    #[test]
    fn a_phantom_child_beyond_a_self_retirement_is_invalid() {
        // The dumpster-diver's first move: extend the retired key's chain past its own seal
        // with a fresh authorize. The ceiling makes it a phantom: the subtree dies, the
        // retirement stands, the honest pre-seal child is untouched.
        let (root, _recovery, mut laptop, phone, mut entries) = family();

        entries.push(laptop.revoke(
            laptop.pk(),
            Disposition::Retirement,
            vec![laptop.head_anchor()],
        ));
        let (phantom, e_phantom) = laptop.authorize(9); // beyond both the seal and the revoke
        entries.push(e_phantom);

        let tree = Crown::build(root.pk(), &entries).unwrap();
        assert_eq!(tree.status(&laptop.pk()), KeyStatus::Retired);
        assert_eq!(tree.status(&phone.pk()), KeyStatus::Active);
        assert_eq!(
            tree.status(&phantom.pk()),
            KeyStatus::Invalid,
            "a post-seal mint is a phantom"
        );
    }

    #[test]
    fn competing_self_retirements_converge_on_one_origin() {
        // The dumpster-diver's second move: the retired key is attacker-held, so nothing
        // stops it signing an *alternative* self-retirement at the same seat - a fork over
        // the revoke itself. Both candidates retire the key; what must converge is which one
        // the tree credits, because `origin` is the one beyond-seal entry enforcers keep.
        // (The anchors are attacker-chosen on the forged branch - the accepted bound; the
        // remedy is senior repudiation, tested elsewhere.)
        let (root, _recovery, mut laptop, _phone, entries) = family();

        let anchor = laptop.head_anchor();
        let (seat_seq, seat_prev) = (laptop.seq, laptop.prev);
        let honest = laptop.revoke(laptop.pk(), Disposition::Retirement, vec![anchor]);
        laptop.seq = seat_seq;
        laptop.prev = seat_prev; // same key, rewound: the fork
        let forged = laptop.revoke(
            laptop.pk(),
            Disposition::Retirement,
            vec![
                anchor,
                Anchor {
                    service: service::POSTS,
                    seq: 7,
                    head_hash: [0xEE; 32],
                },
            ],
        );

        let winner_hash = *if forged.hash() < honest.hash() {
            &forged
        } else {
            &honest
        }
        .hash();

        let mut ab = entries.clone();
        ab.extend([honest.clone(), forged.clone()]);
        let mut ba = entries;
        ba.extend([forged, honest]);

        for input in [ab, ba] {
            let tree = Crown::build(root.pk(), &input).unwrap();
            assert_eq!(tree.status(&laptop.pk()), KeyStatus::Retired);
            assert_eq!(tree.forks().len(), 1, "the revoke seat forked");
            assert_eq!(
                tree.revocation_of(&laptop.pk()),
                Some(winner_hash),
                "the credited revoke follows the fork winner"
            );
        }
    }

    #[test]
    fn repudiation_kills_the_subtree() {
        let (mut root, recovery, laptop, phone, mut entries) = family();

        entries.push(root.revoke(
            laptop.pk(),
            Disposition::Repudiation,
            vec![laptop.head_anchor()],
        ));

        let tree = Crown::build(root.pk(), &entries).unwrap();
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

        let tree = Crown::build(root.pk(), &entries).unwrap();
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

        // Root anchors its real pre-retirement head (the authorize-laptop entry at seq 1); the
        // retirement entry itself sits just beyond the seal, hash-linked onto the anchored head.
        entries.push(root.revoke(root.pk(), Disposition::Retirement, vec![root.head_anchor()]));
        entries.push(recovery.revoke(
            laptop.pk(),
            Disposition::Repudiation,
            vec![laptop.head_anchor()],
        ));

        let tree = Crown::build(root.pk(), &entries).unwrap();
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

        // Root anchors the frontier it has seen - laptop's seq 0 - deliberately excluding the
        // hostile revoke laptop signs at seq 1.
        let laptop_seq0 = *entries[2].hash();
        entries.push(laptop.revoke(recovery.pk(), Disposition::Repudiation, vec![]));
        entries.push(root.revoke(
            laptop.pk(),
            Disposition::Repudiation,
            vec![Anchor {
                service: service::IDENTITY_PUBLIC,
                seq: 0,
                head_hash: laptop_seq0,
            }],
        ));

        let tree = Crown::build(root.pk(), &entries).unwrap();
        assert_eq!(tree.status(&recovery.pk()), KeyStatus::Active);
        assert_eq!(tree.status(&laptop.pk()), KeyStatus::Repudiated);
        assert!(tree.rejected().iter().any(|r| r.reason
            == "revoke signed by a repudiated or invalid key"
            || r.reason == "revoke lies beyond the signer's own ceiling"
            || r.reason == "revoker is not senior to its target"));
    }

    /// `usurper_stamp_for_new_child` must agree with the stamp the validator recomputes - for
    /// ANY member, not just the root. Proven by round trip: build a daisy chain
    /// (root → recovery, root → B, B → C), ask the crown for C's-grandchild stamp at each
    /// level, mint the authorization with it, and assert the extended tree accepts the child
    /// as Active. A wrong stamp would be rejected by the validator's exact-match check, so
    /// acceptance IS agreement.
    #[test]
    fn usurper_stamp_extends_the_tree_at_any_depth() {
        let mut root = TestKey::new(1, vec![]);
        let mut entries = Vec::new();
        let (_recovery, e) = root.authorize(2);
        entries.push(e);
        let (mut leaf_b, e) = root.authorize(3);
        entries.push(e);

        // The crown's stamp for a new child of B matches what the honest helper computes.
        let tree = Crown::build(root.pk(), &entries).unwrap();
        let stamp = tree.usurper_stamp_for_new_child(&leaf_b.pk()).unwrap();
        let mut expected = leaf_b.usurpers.clone();
        expected.push(leaf_b.pk());
        assert_eq!(stamp, expected, "junior stamp: seniors + parent + no siblings yet");

        // And the validator accepts a child minted with it - at depth 1 (B → C)...
        let (mut leaf_c, e) = leaf_b.authorize(4);
        entries.push(e);
        let tree = Crown::build(root.pk(), &entries).unwrap();
        assert_eq!(tree.status(&leaf_c.pk()), KeyStatus::Active);
        assert_eq!(tree.rank_path(&leaf_c.pk()).unwrap(), &[1, 0]);

        // ...and at depth 2 (C → D), the full daisy chain, stamp from the crown itself.
        let stamp = tree.usurper_stamp_for_new_child(&leaf_c.pk()).unwrap();
        let d = TestKey::new(5, stamp.clone());
        let payload = Authorize {
            child: d.pk(),
            usurpers: stamp,
            enc_pubkey: None,
        }
        .encode()
        .unwrap();
        entries.push(leaf_c.append(entry_type::AUTHORIZE, payload));
        let tree = Crown::build(root.pk(), &entries).unwrap();
        assert_eq!(tree.status(&d.pk()), KeyStatus::Active);
        assert_eq!(tree.rank_path(&d.pk()).unwrap(), &[1, 0, 0]);
        assert!(tree.is_senior(&_recovery.pk(), &d.pk()), "the spare outranks the whole chain");

        // A stranger has no stamp.
        assert!(tree.usurper_stamp_for_new_child(&[0xEE; 32]).is_none());
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
            let tree = Crown::build(root_pk, &entries).unwrap();

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
            let tree2 = Crown::build(root_pk, &shuffled).unwrap();
            for pk in &pks {
                assert_eq!(tree.status(pk), tree2.status(pk), "seed {seed}");
                assert_eq!(tree.rank_path(pk), tree2.rank_path(pk), "seed {seed}");
            }
        }
    }

    #[test]
    fn sealed_prefix_is_credited_a_forged_prefix_is_not() {
        // The phantom-authorize attack. Root RETIRES the laptop (no prejudice - the subtree may
        // live), anchoring laptop's real head. A relying party holding the honest prefix
        // credits the phone. One fed the attacker's fabricated prefix instead - valid
        // signatures, same seqs, all under the ceiling - must credit nothing: the anchor's hash
        // is cryptographic proof the fabrication is not the sealed history.
        let (mut root, _recovery, laptop, phone, entries) = family();
        let anchor = laptop.head_anchor();
        let retire = root.revoke(laptop.pk(), Disposition::Retirement, vec![anchor]);

        let mut honest = entries.clone();
        honest.push(retire.clone());
        let tree = Crown::build(root.pk(), &honest).unwrap();
        assert_eq!(tree.status(&laptop.pk()), KeyStatus::Retired);
        assert_eq!(
            tree.status(&phone.pk()),
            KeyStatus::Active,
            "sealed history is honored"
        );

        // The fresh/late-syncing node's view: the attacker (still holding laptop's key)
        // replaced laptop's chain wholesale with a prefix minting a phantom child.
        let mut forged_laptop = TestKey::new(3, laptop.usurpers.clone());
        let (phantom, forged_e) = forged_laptop.authorize(9);
        let forged_view = vec![entries[0].clone(), entries[1].clone(), forged_e, retire];
        let tree = Crown::build(root.pk(), &forged_view).unwrap();
        assert_eq!(tree.status(&laptop.pk()), KeyStatus::Retired);
        assert_eq!(
            tree.status(&phantom.pk()),
            KeyStatus::Invalid,
            "a forged under-ceiling prefix mints no authority"
        );
        assert!(tree
            .rejected()
            .iter()
            .any(|r| r.reason == "identity chain contradicts the revocation anchor"));
    }

    #[test]
    fn incomplete_prefix_under_a_ceiling_credits_nothing() {
        // Laptop authorized the phone (seq 0) and a tablet (seq 1); root retires it anchoring
        // seq 1. A view holding only seq 0 - consistent with the seal but short of it - credits
        // nothing: fail closed, because "consistent so far" is exactly what a truncation attack
        // looks like. A fuller view (the whole sealed prefix) credits both children.
        let (mut root, _recovery, mut laptop, phone, entries) = family();
        let (tablet, e_tablet) = laptop.authorize(5);
        let anchor = laptop.head_anchor(); // seq 1, real hash
        let retire = root.revoke(laptop.pk(), Disposition::Retirement, vec![anchor]);

        let mut short_view = entries.clone(); // holds laptop seq 0, not seq 1
        short_view.push(retire.clone());
        let tree = Crown::build(root.pk(), &short_view).unwrap();
        assert_eq!(
            tree.status(&phone.pk()),
            KeyStatus::Invalid,
            "an unsealed prefix proves nothing, so it grants nothing"
        );
        assert_eq!(tree.status(&tablet.pk()), KeyStatus::Unknown);

        let mut full_view = entries;
        full_view.push(e_tablet);
        full_view.push(retire);
        let tree = Crown::build(root.pk(), &full_view).unwrap();
        assert_eq!(tree.status(&phone.pk()), KeyStatus::Active);
        assert_eq!(tree.status(&tablet.pk()), KeyStatus::Active);
    }

    #[test]
    fn the_seal_boundary_is_exact() {
        // Root retires the laptop at its real head (seq 0). The attacker, still holding the
        // laptop key, extends the *honest* chain with an authorize at seq 1 - hash-linked
        // perfectly, one past the seal. The child at final_seq is anchored history; the child
        // one beyond is a phantom.
        let (mut root, _recovery, mut laptop, phone, mut entries) = family();
        let anchor = laptop.head_anchor(); // seq 0
        entries.push(root.revoke(laptop.pk(), Disposition::Retirement, vec![anchor]));
        let (tablet, e_tablet) = laptop.authorize(5); // seq 1, links the honest head
        entries.push(e_tablet);

        let tree = Crown::build(root.pk(), &entries).unwrap();
        assert_eq!(tree.status(&laptop.pk()), KeyStatus::Retired);
        assert_eq!(
            tree.status(&phone.pk()),
            KeyStatus::Active,
            "the entry exactly at final_seq is sealed history"
        );
        assert_eq!(
            tree.status(&tablet.pk()),
            KeyStatus::Invalid,
            "final_seq + 1 is beyond the seal, however well it links"
        );
    }

    #[test]
    fn a_forged_under_ceiling_revoke_is_refused() {
        // The phantom-repudiation attack. S is senior to J; root retires S anchoring S's real
        // head. The attacker, holding S, fabricates an alternative S chain whose seq-0 entry
        // repudiates J - under the ceiling *by seq*, but not on the sealed prefix. A seq-only
        // check would let a retired key's ghost keep evicting juniors forever.
        let mut root = TestKey::new(1, vec![]);
        let (_recovery, e0) = root.authorize(2);
        let (mut s, e1) = root.authorize(3);
        let (j, e2) = root.authorize(4);
        let (_c, _e_honest) = s.authorize(5); // S's honest chain: one authorize at seq 0
        let retire = root.revoke(s.pk(), Disposition::Retirement, vec![s.head_anchor()]);

        let mut forged_s = TestKey::new(3, s.usurpers.clone());
        let forged_revoke = forged_s.revoke(j.pk(), Disposition::Repudiation, vec![]);

        // The victim's view: honest root chain, the retirement, and only the forged S chain.
        let view = vec![e0, e1, e2, retire, forged_revoke];
        let tree = Crown::build(root.pk(), &view).unwrap();
        assert_eq!(tree.status(&s.pk()), KeyStatus::Retired);
        assert_eq!(
            tree.status(&j.pk()),
            KeyStatus::Active,
            "a revoke off the sealed prefix has no voice"
        );
        assert!(tree
            .rejected()
            .iter()
            .any(|r| r.reason == "revoke is not on the signer's sealed prefix"));
    }

    #[test]
    fn attack_resolution_is_arrival_order_independent() {
        // One honest set plus one attack set - a forged fork of laptop's chain alongside the
        // anchored retirement - fed in several arrival orders. Verdicts, ceilings, forks, and
        // evidence must be identical every time: convergence is the module's core promise, and
        // it has to hold under fire, not just for honest trees.
        let (mut root, recovery, laptop, phone, mut entries) = family();
        let anchor = laptop.head_anchor();
        entries.push(root.revoke(laptop.pk(), Disposition::Retirement, vec![anchor]));
        let mut forged_laptop = TestKey::new(3, laptop.usurpers.clone());
        let (phantom, forged_e) = forged_laptop.authorize(9);
        entries.push(forged_e); // forks laptop's chain at seq 0

        let keys = [
            root.pk(),
            recovery.pk(),
            laptop.pk(),
            phone.pk(),
            phantom.pk(),
        ];
        let baseline = Crown::build(root.pk(), &entries).unwrap();
        for perm in 0..entries.len() {
            let mut shuffled = entries.clone();
            shuffled.rotate_left(perm);
            if perm % 2 == 1 {
                shuffled.reverse();
            }
            let tree = Crown::build(root.pk(), &shuffled).unwrap();
            for k in &keys {
                assert_eq!(tree.status(k), baseline.status(k), "perm {perm}");
            }
            assert_eq!(
                tree.ceiling(&laptop.pk(), service::IDENTITY_PUBLIC),
                baseline.ceiling(&laptop.pk(), service::IDENTITY_PUBLIC),
                "perm {perm}"
            );
            assert_eq!(tree.forks(), baseline.forks(), "perm {perm}");
            assert_eq!(tree.rejected(), baseline.rejected(), "perm {perm}");
        }
        // And the attack failed in every ordering: whichever branch won the fork, the phantom
        // was never credited (fork loser -> Unknown; fork winner -> disproven by the anchor).
        assert_ne!(baseline.status(&phantom.pk()), KeyStatus::Active);
        assert_eq!(
            baseline.forks().len(),
            1,
            "the equivocation is on the record"
        );
    }

    #[test]
    fn senior_repudiation_beats_self_retirement() {
        // The "attacker eased out the door quietly" case: the compromised laptop self-retires
        // (innocently-looking), but root repudiates it. The stricter senior claim wins.
        let (mut root, _recovery, mut laptop, phone, mut entries) = family();

        // Both revokers anchor the same real head: laptop's seq 0 (root never saw - or never
        // trusted - anything later).
        let anchor = laptop.head_anchor();
        entries.push(laptop.revoke(laptop.pk(), Disposition::Retirement, vec![anchor]));
        entries.push(root.revoke(laptop.pk(), Disposition::Repudiation, vec![anchor]));

        let tree = Crown::build(root.pk(), &entries).unwrap();
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
