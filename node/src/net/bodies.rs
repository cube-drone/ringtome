//! The gravedigger's rounds: an index of missing bodies, checked up on periodically.
//!
//! Headers ride entry sync; bodies ride iroh-blobs behind them. The EVENT half of that lane
//! (sync.rs: every exchange ends in a body walk, and a fruitful walk re-rides the fan-out
//! edge) heals the ordinary case in about a round trip. This module is the RECOVERY half -
//! events for latency, sweeps for recovery - for the case where every event missed: the
//! pusher's poke failed in transit, and a node that only ever *responds* (a follower holding
//! a mirror) sees no further exchange until the author's next post.
//!
//! The design is three small moves on machinery that already exists:
//!   * the body walk already computes each persona's missing set on every exchange - it now
//!     RECORDS the shortfall in `missing_bodies` (replace-set per persona) instead of
//!     discarding it;
//!   * the sweep's worklist is `SELECT DISTINCT root FROM missing_bodies` - an empty ledger
//!     is a zero-cost tick, and the guard *is* the memo, no stat-marks needed;
//!   * per due persona it guesses who might have the bytes - the via that answered our
//!     fetch, the nodes that asked us, the device peers - and runs the same walk at each
//!     until whole. A blob fetch is hash-capability, so a wrong guess costs a dial and
//!     discloses nothing new (each candidate already knew of our interest in this persona).
//!
//! Owns the `missing_bodies` SQL (tests/conventions.rs). Backoff lives in `tries` /
//! `last_tried_ms`, which belong to the sweep alone - walks reconcile membership only, so
//! steady-state exchange churn never resets a backoff clock.

use anyhow::{Context, Result};

use crate::clock::now_ms;
use crate::db::Db;
use crate::AppState;

/// Asker candidates per healing attempt. Wider than the push's dial cap on purpose: healing
/// wants breadth (any one candidate holding the bytes ends the walk - the loop below exits
/// at whole), and the backoff ladder already paces how often a stubborn persona retries.
const ASKER_CANDIDATE_CAP: i64 = 64;

/// A wanted body is LOST when every computer of the persona's that's been around has been asked
/// for it and none had it (2026-10-29: the first version of a post edited on 2026-09-29, its words
/// reaped by the day-after rule that 2026-10-02 retired, held "1 still on their way" on every
/// computer for good, and no new computer's first sync could ever finish). Every exchange between
/// a persona's computers ends in a body walk against the other side, so a computer that synced
/// with this one an hour or more after the want was noted has been asked by a walk other than the
/// one that noted it - the hour is the margin for a transfer that failed on the way.
const LOST_GRACE_MS: i64 = 60 * 60 * 1000;
/// ...and the sweep has tried it this many times too, asking every candidate it can name.
const LOST_AFTER_TRIES: i64 = 3;
/// A computer that hasn't synced with this one in a week isn't waited for: an old laptop in a
/// drawer must not keep a file "on its way" forever.
const LOST_PEER_WINDOW_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// A lost body is still asked for, once a day: nothing is forgotten, and a computer back from
/// the drawer may have it after all. It just stops counting as on its way.
const LOST_REST_MS: i64 = 24 * 60 * 60 * 1000;

/// Is this want lost? `peers_synced` is when each of the persona's other computers last synced
/// with this one. With none seen in the window there is nobody whose silence means anything,
/// and the body stays on its way.
fn lost(first_noted_ms: i64, tries: i64, peers_synced: &[i64], now: i64) -> bool {
    let recent: Vec<i64> =
        peers_synced.iter().copied().filter(|s| *s >= now - LOST_PEER_WINDOW_MS).collect();
    tries >= LOST_AFTER_TRIES
        && !recent.is_empty()
        && recent.iter().all(|s| *s >= first_noted_ms + LOST_GRACE_MS)
}

/// When each of the persona's other computers last synced with this one - those that ever have.
async fn peers_synced(node_db: &Db, root_hex: &str) -> Result<Vec<i64>> {
    Ok(crate::net::sync::peer_leaves(node_db, root_hex)
        .await?
        .into_iter()
        .filter_map(|(_, _, synced)| synced)
        .collect())
}

/// Note ONE blob as wanted, additively.
///
/// The counterpart to [`reconcile`], which replaces a whole persona's set from a body walk over
/// chains this node holds. A fragment's body has no such walk behind it - the document's author
/// is not synced here at all (`fragments`), so nothing would ever compute it into a missing set.
/// Without this, a shared document's words would depend entirely on the one direct fetch at
/// journal time succeeding, with no retry, forever.
///
/// Idempotent, and it never disturbs an existing row's backoff: re-noting a blob already wanted
/// must not reset the ladder that is pacing it.
pub async fn want(node_db: &Db, root_hex: &str, blob_hash: &[u8; 32]) -> Result<()> {
    node_db
        .execute(
            "INSERT INTO missing_bodies (root_pubkey, blob_hash, first_noted_ms)
             VALUES (?1, ?2, ?3)
             ON CONFLICT (root_pubkey, blob_hash) DO NOTHING",
            (root_hex, blob_hash.to_vec(), now_ms()),
        )
        .await
        .context("noting a wanted body")?;
    Ok(())
}

/// Replace one persona's ledger rows with the freshly computed missing set. Called by the
/// body walk after every attempt, with whatever is STILL absent - so satisfied rows clear on
/// arrival regardless of which path the bytes took, and rows whose documents vanished
/// (retraction, repudiation) clear on the next look. An empty `still_missing` empties the
/// persona's ledger. Existing rows keep their backoff state; only membership changes.
///
/// `spare`: blobs the caller can't see and so doesn't rule on - rows for them stay as they are,
/// neither cleared nor added. The walk sees the chains held here; a persona's fragments (a
/// peek's avatar, a shared post) are wanted by their own intake (`fragments::want_bytes`), and
/// until 2026-10-14 every walk erased those wants - an inbound sync landing a moment after a
/// face was asked for left it "still on its way" for good.
pub async fn reconcile(
    node_db: &Db,
    root_hex: &str,
    still_missing: &[[u8; 32]],
    spare: &[[u8; 32]],
) -> Result<()> {
    let quoted: Vec<String> =
        still_missing.iter().chain(spare).map(|h| format!("X'{}'", hex::encode(h))).collect();
    node_db
        .execute(
            &format!(
                "DELETE FROM missing_bodies WHERE root_pubkey = ?1 AND blob_hash NOT IN ({})",
                if quoted.is_empty() { "X''".into() } else { quoted.join(",") }
            ),
            (root_hex,),
        )
        .await
        .context("clearing satisfied missing-body rows")?;
    let now = now_ms();
    for hash in still_missing {
        node_db
            .execute(
                "INSERT OR IGNORE INTO missing_bodies (root_pubkey, blob_hash, first_noted_ms)
                 VALUES (?1, ?2, ?3)",
                (root_hex, hash.to_vec(), now),
            )
            .await
            .context("noting a missing body")?;
    }
    Ok(())
}

/// How long a row rests after `tries` failed sweep attempts: 30s doubling to a one-hour
/// ceiling. Pure, so the ladder is testable without a clock.
fn backoff_ms(tries: i64) -> i64 {
    let capped = tries.clamp(0, 7) as u32; // 30s << 7 = 64min, past the ceiling already
    (30_000i64 << capped).min(3_600_000)
}

/// Is a row worth another attempt now? Never-tried rows are always due; a lost one rests a day.
fn due(tries: i64, last_tried_ms: i64, now: i64, lost: bool) -> bool {
    let rest = if lost { LOST_REST_MS } else { backoff_ms(tries) };
    last_tried_ms == 0 || last_tried_ms + rest <= now
}

/// Every blob the ledger still wants, for the reaper's mark: a blob mid-heal is referenced by
/// intent, and reaping it would race the very fetch trying to land it.
pub async fn wanted_hashes(node_db: &Db) -> Result<Vec<[u8; 32]>> {
    let rows: Vec<(Vec<u8>,)> = node_db
        .fetch_all("SELECT blob_hash FROM missing_bodies", ())
        .await
        .context("reading the wants for the reaper")?;
    rows.into_iter()
        .map(|(b,)| {
            <[u8; 32]>::try_from(b.as_slice())
                .map_err(|_| anyhow::anyhow!("corrupt blob_hash in missing_bodies"))
        })
        .collect()
}

/// Fetch exactly what the ledger says is missing, from one provider - the walk a FRAGMENT
/// author gets. `fetch_missing_bodies` recomputes its fetch list from a held chain's
/// `doc_versions`, and a fragment author has no chain here to walk (`user_dbs.held` refuses,
/// the walk heals nothing) - but the ledger already names the precise blobs, noted at fragment
/// intake, and a public blob's hash is the whole capability. Landed rows clear; the rest stay
/// for the next candidate or beat.
pub async fn fetch_wanted(
    state: &AppState,
    root_hex: &str,
    provider: impl Into<crate::files::Provider>,
) -> u64 {
    let provider = provider.into();
    let inner: Result<u64> = async {
        let rows: Vec<(Vec<u8>,)> = state
            .node_db
            .fetch_all("SELECT blob_hash FROM missing_bodies WHERE root_pubkey = ?1", (root_hex,))
            .await
            .context("reading wanted bodies")?;
        // A tagged song's audio, where the operator refuses it (rights.rs): not fetched, and no
        // longer wanted.
        let fenced = crate::rights::fenced_hashes(state, root_hex, None).await?;
        let mut hashes: Vec<iroh_blobs::Hash> = Vec::new();
        for (bytes,) in rows {
            if let Ok(h) = <[u8; 32]>::try_from(bytes.as_slice()) {
                if fenced.contains(&h) {
                    state
                        .node_db
                        .execute(
                            "DELETE FROM missing_bodies WHERE root_pubkey = ?1 AND blob_hash = ?2",
                            (root_hex, h.to_vec()),
                        )
                        .await
                        .context("forgetting a refused body")?;
                    continue;
                }
                let hash = iroh_blobs::Hash::from_bytes(h);
                if !state.files.has(hash).await {
                    hashes.push(hash);
                }
            }
        }
        if hashes.is_empty() {
            return Ok(0);
        }
        let fetched = state.files.fetch_many(&state.endpoint, provider, &hashes).await as u64;
        for hash in &hashes {
            if state.files.has(*hash).await {
                state
                    .node_db
                    .execute(
                        "DELETE FROM missing_bodies WHERE root_pubkey = ?1 AND blob_hash = ?2",
                        (root_hex, hash.as_bytes().to_vec()),
                    )
                    .await
                    .context("clearing a landed body")?;
            }
        }
        Ok(fetched)
    }
    .await;
    inner.unwrap_or_else(|e| {
        tracing::debug!(root = %root_hex, error = ?e, "wanted-body fetch failed");
        0
    })
}

/// Heal one author's missing bodies NOW, from one named origin - the evented half of the
/// ledger (events for latency, sweeps for recovery), rung at fragment intake so a shared
/// post's words arrive on the heels of its header rather than a sweep beat later. Spawn-safe
/// and best-effort: a miss here is exactly what the sweep above recovers, from the same
/// origin among others.
pub async fn heal_from(state: &AppState, author_root: &str, origin_root: &str) {
    let mut tried = 0u32;
    // The deliverer rung first (2026-08-23): whoever most recently served this author's
    // fragments provably holds - or knows who holds - the bytes their headers name, and the
    // origin's own resolution ladder below can be all dark exactly when this rung matters.
    let mut endpoints: Vec<String> =
        crate::fragments::deliverers_of(&state.node_db, author_root).await.unwrap_or_default();
    // Then the crowd (plans/CROWD.md, ruling 7): the author's holders, named by the author's
    // own node, hold the bytes their copy of the chain references.
    for ep in crowd_candidates(state, author_root).await {
        if !endpoints.contains(&ep) {
            endpoints.push(ep);
        }
    }
    for c in crate::net::deliver::candidates(state, origin_root).await {
        let ep = crate::idface::leaf_via_to_endpoint(state, origin_root, &c).await;
        if !endpoints.contains(&ep) {
            endpoints.push(ep);
        }
    }
    // The connects raced, staggered (net::sync::connect_first, 2026-10-31): a dark rung used to
    // cost the next its whole connect timeout. The download runs on the winner alone - racing it
    // would pull the same bytes from everyone - and the next is raced for only if bodies remain.
    let mut fetched = 0u64;
    let mut left = endpoints;
    while let Some((_, _, conn)) =
        crate::net::sync::connect_first(state, &mut left, crate::files::BLOB_ALPN).await
    {
        tried += 1;
        fetched += fetch_wanted(state, author_root, conn).await;
        if let Ok(0) = remaining(&state.node_db, author_root).await {
            // Spoken too (2026-10-14): "healed" and "found nothing wanted" were both silent, and
            // the face flake's wants had been erased under it by a walk - indistinguishable here.
            tracing::debug!(author = %author_root, origin = %origin_root, tried, fetched,
                "eager body heal left nothing wanted");
            return;
        }
    }
    // Every exit past this line left wants standing - the sweep's backoff ladder owns them
    // now. Silent until 2026-08-23 (the cascade intermittent's eager half): whether this
    // fired-and-failed or never resolved a single endpoint was indistinguishable from it
    // having healed.
    tracing::debug!(author = %author_root, origin = %origin_root, tried,
        "eager body heal left wants standing");
}

/// The author's holders as body candidates (plans/CROWD.md, ruling 7): one referral's worth,
/// freshest first. A blob fetch is a hash, so nothing new crosses the wire - any holder with
/// the bytes serves them, and whatever it serves is checked against the hash.
async fn crowd_candidates(state: &AppState, author_root: &str) -> Vec<String> {
    crate::crowd::holders(&state.node_db, author_root, ringtome_proto::sync::MAX_HOLDERS as i64)
        .await
        .unwrap_or_default()
}

/// One pass of the rounds. For every persona with due rows: guess who might have the bytes,
/// run the ordinary body walk at each candidate (the walk itself reconciles the ledger as
/// bodies land), and mark whatever remains as tried so the backoff ladder advances.
/// Zero the healer's backoff stamps - the test beat's "try again NOW" (test_endpoints).
pub(crate) async fn force_due(node_db: &crate::db::Db) -> Result<()> {
    node_db.execute("UPDATE missing_bodies SET last_tried_ms = 0", ()).await?;
    Ok(())
}

pub async fn sweep(state: AppState) -> Result<()> {
    let rows: Vec<(String, i64, i64, i64)> = state
        .node_db
        .fetch_all(
            "SELECT root_pubkey, tries, last_tried_ms, first_noted_ms FROM missing_bodies",
            (),
        )
        .await
        .context("reading the missing-bodies ledger")?;
    let now = now_ms();
    let mut roots: Vec<String> = Vec::new();
    let mut synced: std::collections::HashMap<String, Vec<i64>> = std::collections::HashMap::new();
    for (root, tries, last_tried, first_noted) in rows {
        if roots.contains(&root) {
            continue;
        }
        if !synced.contains_key(&root) {
            synced.insert(root.clone(), peers_synced(&state.node_db, &root).await?);
        }
        let lost = lost(first_noted, tries, &synced[&root], now);
        if due(tries, last_tried, now, lost) {
            roots.push(root);
        }
    }

    // Once a pass, not once a persona (plans/CACHE.md, Stage 3): the cohort is the same for every
    // root, and the same origins recur across them - each resolution a key-tree load and a lookup.
    let cohort = crate::net::sync::cohort_endpoints(&state).await.unwrap_or_default();
    let mut resolved: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    // one at a time: a background sweep, each root due only on its backoff ladder and its
    // candidates raced in `connect_first`; nobody waits on it.
    for root in roots {
        // Candidates, most-likely first - split by WHICH relationship vouches for them
        // (2026-08-22, second draft: the first gated a hunch-held author down to the
        // introducer alone, which also severed the share rungs below and broke "heal from
        // the other sharer" - the very fallback the fragment ledger exists for).
        //
        // The AUTHOR-relationship rungs (a profile fetch, their askers, their sync peers)
        // exist only for personas somebody here has a real relationship with; for a
        // hunch-held mirror (speculative.rs) the one author-side candidate is the
        // introducer endpoint that answered the pull - it already knows our interest, and
        // nothing else on the author's side does or should. The SHARE-relationship rungs
        // further down (fragment origins, sharers of the author) are facts about the
        // shares, not the author, and stand for hunch-held authors exactly as for
        // strangers we hold nothing of.
        let mut candidates: Vec<String> = Vec::new();
        let hunch = crate::speculative::speculative_only(&state, &root).await?;
        if hunch {
            if let Some(via) = crate::speculative::last_via(&state.node_db, &root).await? {
                candidates.push(via);
            }
        } else {
            if let Some(via) = crate::idface::fetched_via(&state.node_db, &root).await? {
                candidates.push(via);
            }
            for asker in
                crate::net::demand::askers_of(&state.node_db, &root, ASKER_CANDIDATE_CAP).await?
            {
                if !candidates.contains(&asker) {
                    candidates.push(asker);
                }
            }
            for peer in crate::net::sync::peers_for(&state.node_db, &root).await? {
                if !candidates.contains(&peer) {
                    candidates.push(peer);
                }
            }
        }
        // The DELIVERERS first among the share rungs (2026-08-23): the endpoints that most
        // recently served this author's fragments, stamped at intake. Fresher than any
        // ledger-derived name - they answered - and the fix for the cascade diagnosis, where
        // origins and sharers below both resolved to one dark node while the endpoint that
        // handed over the header appeared on no list at all. Already endpoint-shaped: no
        // resolution ladder, no unresolved-key dial.
        for ep in crate::fragments::deliverers_of(&state.node_db, &root).await.unwrap_or_default() {
            if !candidates.contains(&ep) {
                candidates.push(ep);
            }
        }
        // The crowd after the deliverers (plans/CROWD.md, ruling 7, 2026-10-13): the holders
        // the author's own node named, which hold whatever bytes their copy of the chain
        // references - the rung that heals a body while the author is dark. Never for a
        // hunch-held author, whose only author-side candidate is the introducer (above): a
        // holder asked for the bytes would learn the hunch.
        if !hunch {
            for ep in crowd_candidates(&state, &root).await {
                if !candidates.contains(&ep) {
                    candidates.push(ep);
                }
            }
        }
        // The fragment ORIGINS (2026-08-14) - and for a reader past the chain, the only list
        // with anything in it. The three sources above all come from a relationship with the
        // AUTHOR (a profile fetch, their askers, their sync peers); a node holding this
        // persona's documents purely by way of a share has none of those, so its want rows
        // aged forever with zero candidates and the words never arrived. Who it does have is
        // whoever handed it the pointer - who by construction holds (or knows who holds) the
        // very bytes the pointer names.
        let mut fragment_peers =
            crate::fragments::origins_of(&state.node_db, &root).await.unwrap_or_default();
        // ...and every sharer of any of this author's documents that a local reader follows
        // (2026-08-15): the recorded origin is one name; the byline ledger's union is the
        // rest of the tree, and any of them holds - or knows who holds - the author's public
        // bytes. Designed resilience where origins_of gave coincidental resilience.
        for sharer in
            crate::fanout::sharers_of_author(&state.node_db, &root).await.unwrap_or_default()
        {
            if !fragment_peers.contains(&sharer) {
                fragment_peers.push(sharer);
            }
        }
        for origin in fragment_peers {
            if !resolved.contains_key(&origin) {
                let mut eps = Vec::new();
                for c in crate::net::deliver::candidates(&state, &origin).await {
                    eps.push(crate::idface::leaf_via_to_endpoint(&state, &origin, &c).await);
                }
                resolved.insert(origin.clone(), eps);
            }
            for ep in &resolved[&origin] {
                if !candidates.contains(ep) {
                    candidates.push(ep.clone());
                }
            }
        }
        // The cohort, last (2026-08-15): every list above traces the AUTHOR or the share
        // tree, and all of it can be gone for good while a sibling node of one of our own
        // personas still holds the bytes. Already endpoint-shaped; a blob fetch is
        // hash-capability, and asking our own household discloses nothing.
        for ep in &cohort {
            if !candidates.contains(ep) {
                candidates.push(ep.clone());
            }
        }

        // A due root that resolves ZERO candidates is the sweep's worst state - the rows age
        // forever with nobody to ask - and it was invisible until 2026-08-23, when the
        // cascade heal-from-the-other-sharer intermittent took a two-hour log dig precisely
        // because every failure path here was silent. Speak on every outcome.
        if candidates.is_empty() {
            tracing::debug!(root = %root, "missing-body sweep: due rows, zero candidates");
        }
        let mut healed = 0u64;
        // The connects raced, staggered (net::sync::connect_first, 2026-10-31), the downloads on
        // the winner alone, as `heal_from`. A candidate that won't resolve or connect is logged
        // there and left behind.
        let mut left = candidates.clone();
        while let Some((candidate, _, conn)) =
            crate::net::sync::connect_first(&state, &mut left, crate::files::BLOB_ALPN).await
        {
            // The ledger-exact fetch first (it is what works for fragment authors, where the
            // chain walk below has nothing to open), then the walk, which can additionally
            // discover references nothing had noted yet.
            let here = fetch_wanted(&state, &root, conn.clone()).await
                + crate::record::documents::fetch_missing_bodies(&state, &root, conn).await;
            tracing::trace!(root = %root, candidate = %candidate, healed = here,
                "missing-body sweep: candidate tried");
            healed += here;
            if remaining(&state.node_db, &root).await? == 0 {
                break;
            }
        }
        if healed > 0 {
            tracing::info!(root = %root, healed, "recovered missing bodies on the sweep");
            crate::fold::nudge(&state, &root);
        } else {
            tracing::debug!(root = %root, candidates = candidates.len(),
                "missing-body sweep: nothing healed this pass");
        }
        // Whatever survived every candidate ages one rung; rows the walks cleared are gone
        // and never see this.
        state
            .node_db
            .execute(
                "UPDATE missing_bodies SET tries = tries + 1, last_tried_ms = ?2
                 WHERE root_pubkey = ?1",
                (root.as_str(), now),
            )
            .await
            .context("aging the missing-body rows that survived the rounds")?;
    }
    Ok(())
}

/// One persona's wanted bodies, as a person reads them: those still on their way, and those
/// none of its computers has (`lost`, above).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Waiting {
    pub coming: u64,
    pub lost: u64,
}

/// Count one persona's wants, split by [`lost`] - what the sync pages and the sync ledger's
/// "bodies waiting" (crate::syncstatus) read. The healing loops ask [`remaining`] instead:
/// a lost body is still worth every candidate when it is asked for.
pub async fn waiting(node_db: &Db, root_hex: &str) -> Result<Waiting> {
    let rows: Vec<(i64, i64)> = node_db
        .fetch_all(
            "SELECT first_noted_ms, tries FROM missing_bodies WHERE root_pubkey = ?1",
            (root_hex,),
        )
        .await
        .context("reading a persona's wanted bodies")?;
    if rows.is_empty() {
        return Ok(Waiting { coming: 0, lost: 0 });
    }
    let synced = peers_synced(node_db, root_hex).await?;
    let now = now_ms();
    let lost_n = rows.iter().filter(|(noted, tries)| lost(*noted, *tries, &synced, now)).count();
    Ok(Waiting { coming: (rows.len() - lost_n) as u64, lost: lost_n as u64 })
}

/// How many rows one persona still has on the ledger, lost or not - the healing loops' "is
/// anything still wanted".
pub async fn remaining(node_db: &Db, root_hex: &str) -> Result<u64> {
    let row: Vec<(i64,)> = node_db
        .fetch_all("SELECT COUNT(*) FROM missing_bodies WHERE root_pubkey = ?1", (root_hex,))
        .await
        .context("counting a persona's missing bodies")?;
    Ok(row.first().map(|(n,)| *n as u64).unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_climbs_and_caps() {
        assert_eq!(backoff_ms(0), 30_000, "first rest is 30s");
        assert_eq!(backoff_ms(1), 60_000);
        assert_eq!(backoff_ms(6), 1_920_000, "still doubling under the ceiling");
        assert_eq!(backoff_ms(7), 3_600_000, "the hour ceiling");
        assert_eq!(backoff_ms(50), 3_600_000, "and it never leaves it");
    }

    #[test]
    fn never_tried_rows_are_always_due() {
        assert!(due(0, 0, 1, false));
        assert!(due(99, 0, 1, false), "tries without a timestamp cannot delay a first attempt");
    }

    #[test]
    fn rested_rows_wait_their_rung_out() {
        let now = 1_000_000;
        assert!(!due(0, now - 29_999, now, false), "still resting");
        assert!(due(0, now - 30_000, now, false), "rested exactly long enough");
        assert!(!due(3, now - 200_000, now, false), "higher rungs rest longer (240s at 3)");
        assert!(due(3, now - 240_000, now, false));
    }

    #[test]
    fn a_lost_body_is_asked_for_once_a_day() {
        let now = 10 * LOST_REST_MS;
        assert!(!due(9, now - 2 * 3_600_000, now, true), "past the hour ceiling, still resting");
        assert!(due(9, now - LOST_REST_MS, now, true));
    }

    /// Lost means every computer seen this week synced here an hour past the want, and the sweep
    /// tried it too - each condition short by a hair keeps it on its way.
    #[test]
    fn lost_is_every_recent_computer_asked_since() {
        let now = 100 * LOST_PEER_WINDOW_MS;
        let noted = now - 3 * LOST_GRACE_MS;
        let after = noted + LOST_GRACE_MS;
        assert!(lost(noted, LOST_AFTER_TRIES, &[after, now], now));
        assert!(
            !lost(noted, LOST_AFTER_TRIES - 1, &[after, now], now),
            "the sweep hasn't tried enough"
        );
        assert!(
            !lost(noted, LOST_AFTER_TRIES, &[after - 1, now], now),
            "one synced only within the hour"
        );
        assert!(!lost(noted, LOST_AFTER_TRIES, &[], now), "no computer to have asked");
        let drawer = now - LOST_PEER_WINDOW_MS - 1;
        assert!(
            lost(noted, LOST_AFTER_TRIES, &[drawer, now], now),
            "a week-gone computer isn't waited for"
        );
        assert!(!lost(noted, LOST_AFTER_TRIES, &[drawer], now), "nor does it count as asked");
    }

    async fn node_db() -> Db {
        crate::db::test_node_db().await
    }

    #[tokio::test]
    async fn reconcile_is_replace_set_per_persona() {
        let db = node_db().await;
        let (a, b, c) = ([1u8; 32], [2u8; 32], [3u8; 32]);
        reconcile(&db, "aa11", &[a, b], &[]).await.unwrap();
        assert_eq!(remaining(&db, "aa11").await.unwrap(), 2);

        // b arrived, c newly missing: membership follows the walk exactly.
        reconcile(&db, "aa11", &[a, c], &[]).await.unwrap();
        let rows: Vec<(Vec<u8>,)> = db
            .fetch_all(
                "SELECT blob_hash FROM missing_bodies WHERE root_pubkey = 'aa11' ORDER BY blob_hash",
                (),
            )
            .await
            .unwrap();
        assert_eq!(rows, vec![(a.to_vec(),), (c.to_vec(),)]);

        // A whole persona coming up empty clears its ledger - and touches nobody else's.
        reconcile(&db, "bb22", &[b], &[]).await.unwrap();
        reconcile(&db, "aa11", &[], &[]).await.unwrap();
        assert_eq!(remaining(&db, "aa11").await.unwrap(), 0);
        assert_eq!(remaining(&db, "bb22").await.unwrap(), 1, "the neighbor's grave is not mine");
    }

    /// A walk that can't see a want leaves it be (2026-10-14): a peek's face, wanted at fragment
    /// intake, outlived the inbound sync's walk that followed it by milliseconds - until the walk
    /// erased it, and nothing ever asked for the face again.
    #[tokio::test]
    async fn reconcile_spares_what_it_cannot_see() {
        let db = node_db().await;
        let (chain, face) = ([5u8; 32], [6u8; 32]);
        want(&db, "aa11", &face).await.unwrap();
        reconcile(&db, "aa11", &[chain], &[face]).await.unwrap();
        assert_eq!(remaining(&db, "aa11").await.unwrap(), 2, "the face is still wanted");
        // Sparing is not wanting: a spared blob nobody had asked for gains no row.
        reconcile(&db, "bb22", &[], &[face]).await.unwrap();
        assert_eq!(remaining(&db, "bb22").await.unwrap(), 0);
    }

    #[tokio::test]
    async fn reconcile_preserves_backoff_state_of_surviving_rows() {
        let db = node_db().await;
        let h = [4u8; 32];
        reconcile(&db, "aa11", &[h], &[]).await.unwrap();
        db.execute(
            "UPDATE missing_bodies SET tries = 5, last_tried_ms = 777 WHERE root_pubkey = 'aa11'",
            (),
        )
        .await
        .unwrap();
        // The next walk sees it still missing: membership unchanged, backoff untouched -
        // steady exchange churn must never reset the ladder.
        reconcile(&db, "aa11", &[h], &[]).await.unwrap();
        let rows: Vec<(i64, i64)> = db
            .fetch_all(
                "SELECT tries, last_tried_ms FROM missing_bodies WHERE root_pubkey = 'aa11'",
                (),
            )
            .await
            .unwrap();
        assert_eq!(rows, vec![(5, 777)]);
    }

    /// The split the sync pages read: a want every computer has been asked for is lost, a fresh
    /// one is on its way, and a persona with no computer seen counts all of its wants as coming.
    #[tokio::test]
    async fn waiting_splits_lost_from_coming() {
        let db = node_db().await;
        let (old, fresh) = ([7u8; 32], [8u8; 32]);
        reconcile(&db, "aa11", &[old, fresh], &[]).await.unwrap();
        db.execute(
            "UPDATE missing_bodies SET first_noted_ms = ?1, tries = ?2 WHERE blob_hash = ?3",
            (now_ms() - 2 * LOST_GRACE_MS, LOST_AFTER_TRIES, old.to_vec()),
        )
        .await
        .unwrap();
        assert_eq!(
            waiting(&db, "aa11").await.unwrap(),
            Waiting { coming: 2, lost: 0 },
            "no computer"
        );
        crate::net::sync::add_peer(&db, "aa11", "laptop").await.unwrap();
        crate::net::sync::mark_synced(&db, "aa11", "laptop").await.unwrap();
        assert_eq!(waiting(&db, "aa11").await.unwrap(), Waiting { coming: 1, lost: 1 });
        assert_eq!(remaining(&db, "aa11").await.unwrap(), 2, "the healers still want both");
    }
}
