//! The crowd serves (plans/CROWD.md): a popular persona's public lane, served by the nodes of
//! the people who follow it.
//!
//! This first slice is the rule for WHEN a node may answer a stranger about a persona it holds
//! but doesn't host (ruling 1, Curtis, 2026-10-11). Before it, the sync door's `wanted` gate
//! served any persona somebody here followed or had merely looked at, to anyone who asked - so
//! a stranger naming a root at a household node read out "somebody here follows them" for a
//! quiet follow, and "somebody here looked at them" for no follow at all. The comment there
//! argued the disclosure was only what our own fetch had told the author's node; but the
//! prober is not the author's node.
//!
//! A node answers a stranger about such a persona when either:
//!   - somebody here holds a PUBLISHED relationship with them (`edges_public`, the default
//!     tier since 2026-08-09) - anyone may already know it; or
//!   - the node serves more than [`QUIET_CROWD`] personas, enough that "somebody here" could
//!     be any of them (Curtis: "the anonymizing effect of 'well, it could be any of these
//!     people' should do the trick").
//!
//! And it answers, whatever the above says, a node that already knows: the household (the
//! cohort - machines bound to one of our personas by a ceremony), and on the sync door the
//! persona's own nodes, proven by member proof - the author pushing a new post to a follower
//! must not be turned away by the follow it is feeding.
//!
//! The rest is the crowd itself (slices 2 and 3, the same day). A node that passes the rule for
//! a persona it follows says so when it asks the persona's node (`holds`, the Hello's crowd
//! slot); that node keeps the word beside the ask (`net::demand`) and names a few such
//! holders to every stranger it answers. The stranger keeps the names here, in
//! `crowd_holders`, believing only the persona's own nodes; and its fetch ladder asks them when
//! those nodes are busy or dark (`idface::fetch_foreign_with`).
//!
//! And a holder passes moves on (slice 4, 2026-10-12): when a persona it holds moves here, it
//! pushes to the nodes that asked it, as the author does (`fanout`). The door it pushes at
//! answers it as a holder it was referred to ([`is_holder`]), however quiet the follow there.
//!
//! And a revalidation asks a holder before the author (slice 5, ruling 6): the wake pass's
//! staleness pull, a popular author's whole steady load, lands on the crowd, and the author is
//! asked again once [`next_author_due`]'s six hours, give or take a quarter, are up
//! (`idface::fetch_foreign_with`).

use crate::AppState;

/// Served personas past which a quiet follow hides in the crowd (plans/CROWD.md, ruling 1): 10.
/// A static only so LOCAL_TEST can move it (`/test/quiet-crowd`) - the rig's nodes each serve
/// dozens of personas by the time a claim runs, so a claim about a small node raises the bar.
pub static QUIET_CROWD: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(10);

/// May this node answer a stranger about `root_hex`, a persona it holds but doesn't host?
/// Fails closed: a read that errors answers "no", which a stranger sees as "nobody here has
/// heard of them" - the same polite empty answer as before the persona arrived.
pub async fn answers_strangers(state: &AppState, root_hex: &str) -> bool {
    // The operator's switch (ruling 9): off, the crowd is somebody else's.
    if !state.config.serve_crowd {
        return false;
    }
    if crate::net::subscriptions::publicly_dialed(&state.node_db, root_hex).await.unwrap_or(false) {
        return true;
    }
    crowded(state).await
}

/// Does this node HOLD `root_hex` for the crowd - the `holds` it says in its Hello, which the
/// persona's author keeps beside the ask and refers others to (ruling 2)? A persona somebody
/// here follows (the mirror, not a peek), that this node doesn't host, and that it would
/// answer a stranger about. Saying so of a persona it would then refuse would only send the
/// referred to a closed door.
pub async fn holds(state: &AppState, root_hex: &str) -> bool {
    if crate::identity::is_agented(&state.node_db, root_hex).await.unwrap_or(true) {
        return false;
    }
    let followed = crate::net::subscriptions::followers_of(&state.node_db, root_hex)
        .await
        .map(|f| !f.is_empty())
        .unwrap_or(false);
    followed && answers_strangers(state, root_hex).await
}

/// Does this node serve enough personas to hide one quiet follow among them? Served, not
/// hosted: a prober shares its suspicion among the personas it can see, so a dark one hides
/// nobody.
pub async fn crowded(state: &AppState) -> bool {
    crate::identity::served_roots(&state.node_db)
        .await
        .map(|r| r.len() > QUIET_CROWD.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false)
}

/// Is `peer` (an endpoint id, as `identity_peers` spells it) one of this node's household -
/// a sibling of some persona hosted here? Asking a housemate discloses nothing a stranger
/// could see (`net::sync::cohort_endpoints`), and the cohort rung depends on its answer.
pub async fn is_household(state: &AppState, peer: &str) -> bool {
    crate::net::sync::cohort_endpoints(state)
        .await
        .map(|cohort| cohort.iter().any(|e| e == peer))
        .unwrap_or(false)
}

// ---------------------------------------------------------------------------------------------
// The holders memo (ruling 2): who the persona's own node said holds it.

/// How long a referral is good for: a week, the referring node's own demand window
/// (`net::demand`), past which it would not have named the holder either.
const REFERRAL_FRESHNESS_MS: i64 = 7 * 24 * 3600 * 1000;

/// Holders kept per persona. A referral names at most `MAX_HOLDERS`; a few referrals' worth
/// is plenty of doors, and a bound keeps one noisy persona from growing the table without end.
const HOLDERS_KEPT: i64 = 32;

/// Note the holders the persona's own node just named. The caller has proven the referrer is
/// one of the persona's nodes (`net::sync`); a stranger's list is never written here.
pub async fn remember_holders(
    node_db: &crate::db::Db,
    root_hex: &str,
    holders: &[[u8; 32]],
) -> anyhow::Result<()> {
    use anyhow::Context;
    if holders.is_empty() {
        return Ok(());
    }
    let now = crate::clock::now_ms();
    for h in holders {
        node_db
            .execute(
                "INSERT INTO crowd_holders (root_pubkey, endpoint_id, referred_ms) VALUES (?1, ?2, ?3)
                 ON CONFLICT (root_pubkey, endpoint_id) DO UPDATE SET referred_ms = excluded.referred_ms",
                (root_hex, hex::encode(h), now),
            )
            .await
            .context("remembering a holder")?;
    }
    node_db
        .execute(
            "DELETE FROM crowd_holders WHERE root_pubkey = ?1 AND endpoint_id NOT IN (
                 SELECT endpoint_id FROM crowd_holders WHERE root_pubkey = ?1
                 ORDER BY referred_ms DESC LIMIT ?2)",
            (root_hex, HOLDERS_KEPT),
        )
        .await
        .context("keeping the holders bounded")?;
    Ok(())
}

/// The holders to ask for a persona, freshest referral first, endpoint ids in hex.
pub async fn holders(
    node_db: &crate::db::Db,
    root_hex: &str,
    limit: i64,
) -> anyhow::Result<Vec<String>> {
    use anyhow::Context;
    let rows: Vec<(String,)> = node_db
        .fetch_all(
            "SELECT endpoint_id FROM crowd_holders WHERE root_pubkey = ?1 AND referred_ms > ?2
             ORDER BY referred_ms DESC LIMIT ?3",
            (root_hex, crate::clock::now_ms() - REFERRAL_FRESHNESS_MS, limit),
        )
        .await
        .context("reading the holders")?;
    Ok(rows.into_iter().map(|(e,)| e).collect())
}

/// Was `endpoint_hex` named to us, lately, as a holder of `root_hex`? The sync door answers
/// such a node about the persona whatever ruling 1 says (`net::sync::answers_for_held`): it can
/// only be relaying because we asked it, and the memo is the record of whom we would ask.
pub async fn is_holder(node_db: &crate::db::Db, root_hex: &str, endpoint_hex: &str) -> bool {
    node_db
        .fetch_optional::<(i64,)>(
            "SELECT 1 FROM crowd_holders WHERE root_pubkey = ?1 AND endpoint_id = ?2
             AND referred_ms > ?3",
            (root_hex, endpoint_hex, crate::clock::now_ms() - REFERRAL_FRESHNESS_MS),
        )
        .await
        .map(|r| r.is_some())
        .unwrap_or(false)
}

/// How long the persona's own machinery may go unasked by a mirror with holders (ruling 6,
/// settled 2026-10-11): six hours. That bounds how long a holder that is behind - or a
/// retraction it hasn't heard of - can keep a mirror behind. Measured in time and not in wake
/// passes, because a laptop's passes follow its sleep, and the promise worth making is about
/// how long a retraction stays visible.
const AUTHOR_PASS_MS: i64 = 6 * 3600 * 1000;

/// When the author is next owed the staleness pull, heard from at `now`: six hours, give or
/// take a quarter, drawn fresh each time. The jitter matters more than the six: a burst of
/// newcomers who joined in the same minute would otherwise come back to the author together,
/// every six hours, for good.
pub fn next_author_due(now: i64) -> i64 {
    use rand::RngExt;
    let spread = AUTHOR_PASS_MS / 4;
    now + AUTHOR_PASS_MS + rand::rng().random_range(-spread..=spread)
}

/// Up to `n` of `holders`, chosen at random, so the pulls a crowd serves spread across it
/// rather than piling on whoever was referred last.
pub fn pick(holders: &[String], n: usize) -> Vec<String> {
    use rand::seq::IndexedRandom;
    holders.sample(&mut rand::rng(), n).cloned().collect()
}

/// How long a built busy referral is reused. A flood refuses thousands of connections a second;
/// one lookup per half minute is the whole cost to the refusing node.
const BUSY_REASON_FRESH_MS: i64 = 30 * 1000;

/// The busy referral as last built: when, and the close reason bytes.
static BUSY_REASON: tokio::sync::Mutex<Option<(i64, Vec<u8>)>> =
    tokio::sync::Mutex::const_new(None);

/// The close reason for a connection refused at the admission ceiling (ruling 3, settled
/// 2026-10-11): `busy`, then for the three personas hosted here that the most nodes ask about,
/// up to four holders each (`ringtome_proto::sync::encode_busy`). Admission refuses before any
/// Hello, so the refused takes the list for the persona it came for and ignores the rest. Built
/// at most once per [`BUSY_REASON_FRESH_MS`]; refusals meanwhile wait on the one lookup rather
/// than each making their own. Off with the crowd (ruling 9): a bare `busy`.
pub async fn busy_reason(state: &AppState) -> Vec<u8> {
    use ringtome_proto::sync::{encode_busy, MAX_BUSY_HOLDERS, MAX_BUSY_PERSONAS};
    if !state.config.serve_crowd {
        return ringtome_proto::sync::BUSY.to_vec();
    }
    let mut cached = BUSY_REASON.lock().await;
    let now = crate::clock::now_ms();
    if let Some((built, bytes)) = cached.as_ref() {
        if now - built < BUSY_REASON_FRESH_MS {
            return bytes.clone();
        }
    }
    let mut referrals = Vec::new();
    // A few more than three, because the most asked may be personas this node only holds.
    let asked = crate::net::demand::most_asked(&state.node_db, 4 * MAX_BUSY_PERSONAS as i64)
        .await
        .unwrap_or_default();
    for root_hex in asked {
        if referrals.len() >= MAX_BUSY_PERSONAS {
            break;
        }
        if !crate::identity::is_agented(&state.node_db, &root_hex).await.unwrap_or(false) {
            continue;
        }
        let (Some(root), Ok(holders)) = (
            crate::pubkey::decode(&root_hex),
            crate::net::demand::holders_of(&state.node_db, &root_hex, "", MAX_BUSY_HOLDERS as i64)
                .await,
        ) else {
            continue;
        };
        if !holders.is_empty() {
            referrals.push((root, holders));
        }
    }
    let bytes = encode_busy(&referrals);
    *cached = Some((now, bytes.clone()));
    bytes
}

/// Forget the built busy referral, so the next refusal builds it fresh - for the test switch
/// that stands in for a flood (`/test/admission-full`), whose claim can't wait half a minute.
pub async fn forget_busy_reason() {
    *BUSY_REASON.lock().await = None;
}

/// Note the holders a busy refusal named for `root_hex` (ruling 3). Believed as far as the
/// dial was: only a refusal from the persona's own round (`idface::fetch_foreign_with`) -
/// an endpoint this node dialed AS the persona's machinery, by a signed serving record or the
/// hint it was given - is asked to refer. A referral grants nothing either way: whatever a
/// holder answers is validated against the root.
pub async fn remember_busy_referral(
    node_db: &crate::db::Db,
    root_hex: &str,
    referrals: &[ringtome_proto::sync::BusyReferral],
) {
    let Some(root) = crate::pubkey::decode(root_hex) else {
        return;
    };
    for (r, holders) in referrals {
        if *r == root {
            if let Err(e) = remember_holders(node_db, root_hex, holders).await {
                tracing::debug!(root = %root_hex, error = ?e, "remembering a busy referral failed");
            }
        }
    }
}

/// Drop referrals past the week, on the derive beat beside the demand rows' own pruning: the
/// memo is somewhere to ask now, never a record of who once read whom.
pub async fn prune_holders(node_db: &crate::db::Db, now: i64) -> anyhow::Result<u64> {
    use anyhow::Context;
    node_db
        .execute("DELETE FROM crowd_holders WHERE referred_ms < ?1", (now - REFERRAL_FRESHNESS_MS,))
        .await
        .context("pruning old referrals")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The author's turn lands within six hours, give or take a quarter, and isn't one fixed
    /// point - the spread is what keeps a burst of newcomers from returning together.
    #[test]
    fn the_authors_turn_is_six_hours_give_or_take_a_quarter() {
        let draws: Vec<i64> = (0..200).map(|_| next_author_due(0)).collect();
        assert!(draws
            .iter()
            .all(|d| (AUTHOR_PASS_MS * 3 / 4..=AUTHOR_PASS_MS * 5 / 4).contains(d)));
        assert!(draws.iter().any(|d| *d != draws[0]), "jittered, not fixed");
        let some: Vec<String> = (0..8).map(|i| i.to_string()).collect();
        let few = pick(&some, 2);
        assert_eq!(few.len(), 2);
        assert_ne!(few[0], few[1]);
        assert_eq!(pick(&some[..1], 2).len(), 1);
    }

    /// Freshest first, bounded per persona, and gone after a week.
    #[tokio::test]
    async fn the_holders_memo_is_fresh_and_bounded() {
        let db = crate::db::test_node_db().await;
        let root = "aa".repeat(32);
        let many: Vec<[u8; 32]> = (0..(HOLDERS_KEPT as u8 + 5)).map(|i| [i; 32]).collect();
        remember_holders(&db, &root, &many).await.unwrap();
        assert_eq!(holders(&db, &root, 1000).await.unwrap().len(), HOLDERS_KEPT as usize);

        remember_holders(&db, &root, &[[200u8; 32]]).await.unwrap();
        db.execute(
            "UPDATE crowd_holders SET referred_ms = referred_ms - 1 WHERE endpoint_id != ?1",
            (hex::encode([200u8; 32]),),
        )
        .await
        .unwrap();
        assert_eq!(holders(&db, &root, 1).await.unwrap(), vec![hex::encode([200u8; 32])]);
        assert!(is_holder(&db, &root, &hex::encode([200u8; 32])).await);
        assert!(!is_holder(&db, &"bb".repeat(32), &hex::encode([200u8; 32])).await);

        let later = crate::clock::now_ms() + REFERRAL_FRESHNESS_MS + 1;
        assert!(prune_holders(&db, later).await.unwrap() > 0);
        assert!(holders(&db, &root, 1000).await.unwrap().is_empty());
        assert!(!is_holder(&db, &root, &hex::encode([200u8; 32])).await);
    }
}
