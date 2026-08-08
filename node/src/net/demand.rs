//! Who asked us about whom: the demand record behind fan-out.
//!
//! The question this exists to answer is "a public post for P just landed here - which nodes
//! should I tell?", and the answer was already crossing the wire unrecorded. A node that dials
//! us and names P in its Hello has told us it wants P. Asking is telling: no disclosure flag is
//! involved, because they initiated the contact rather than consenting to be known.
//!
//! What it deliberately is NOT:
//!
//!   - Not `identity_peers`. That table means "nodes that ARE this identity" - member-proven,
//!     entitled to private chains, and driving the eager push loop on that assumption. A reader
//!     is a stranger who wants public words.
//!   - Not a log. One row per pair, updated in place: a record of every request grows without
//!     bound and answers "who wants this?" worse than one row that says "recently".
//!   - Not a person. An endpoint id is transport identity. We learn that a NODE wants P, never
//!     which of its humans - and the receiving node routes internally, which is "the node
//!     routes; the user ranks" falling out of the mechanism rather than being enforced on top.
//!
//! Trust was considered as the routing signal and rejected: trust is "do I believe they're
//! real", never "do I like them" (the Interest dial is the liking one), so it is over-inclusive
//! for vouchers who don't care and - fatally - under-inclusive for the ordinary case of
//! following someone without making any claim about whether they're impersonated.
use anyhow::{Context, Result};

use crate::clock::now_ms;
use crate::db::Db;

/// Note that `endpoint_id` asked about `root_hex`, now.
///
/// Called from the responder for every exchange it serves, including from the persona's own
/// devices - they ask like anyone else, and a device appearing here is true, harmless, and
/// deduped by whatever unions this with `identity_peers`.
pub async fn record_ask(node_db: &Db, root_hex: &str, endpoint_id: &str) -> Result<()> {
    node_db
        .execute(
            "INSERT INTO identity_demand (root_pubkey, endpoint_id, last_asked_ms)
             VALUES (?1, ?2, ?3)
             ON CONFLICT (root_pubkey, endpoint_id) DO UPDATE SET
                 last_asked_ms = excluded.last_asked_ms",
            (root_hex, endpoint_id, now_ms()),
        )
        .await
        .context("recording a demand edge")?;
    Ok(())
}

/// How recent an ask must be to earn a push. An asker who still cares re-asks on every wake
/// pass (`idface::refresh_followed_pass` - staleness-triggered, so even a long partition
/// re-asks on heal), which means a week of silence is demand that LEFT, not demand at rest -
/// and the push was only ever latency; the pull on re-contact is what carries correctness.
/// Same window as `identity_peers`' pruning (`sync::PEER_FORGET_MS`), for the same reason.
/// The table itself still grows without bound - its pruning is the retention debt recorded
/// in the schema comment and NEXT_STEPS (Popularity Problems); this bounds the DIALS.
const ASK_FRESHNESS_MS: i64 = 7 * 24 * 3600 * 1000;

/// The `limit` most-recently-asking nodes for this persona - the fan-out address list.
///
/// Most-recent-first under a cap is a free round-robin, not a fixed clique: a node that got
/// the push stays fresh, stops dialing, and its row ages DOWN this ordering, while a node
/// past the cap goes stale, pulls on its own wake pass, and the pull re-stamps it back to
/// the top. Successive moves sweep the whole asker set with no rotation bookkeeping - the
/// ordering key advances BECAUSE delivery succeeded, on the other side of the wire.
pub async fn askers_of(node_db: &Db, root_hex: &str, limit: i64) -> Result<Vec<String>> {
    let rows: Vec<(String,)> = node_db
        .fetch_all(
            "SELECT endpoint_id FROM identity_demand
             WHERE root_pubkey = ?1 AND last_asked_ms > ?2
             ORDER BY last_asked_ms DESC LIMIT ?3",
            (root_hex, now_ms() - ASK_FRESHNESS_MS, limit),
        )
        .await
        .context("reading demand")?;
    Ok(rows.into_iter().map(|(e,)| e).collect())
}
