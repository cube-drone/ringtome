//! Second-order edges: the assembled graph, and the implicit fold over it.
//!
//! Two memos, one per level, and the split is the design (2026-08-16, the friend-of-friend
//! conversation):
//!
//!   - **`edge_graph`** (node.db) - what synced personas say PUBLICLY about each other, one
//!     row per published statement, assembled from each persona's own `published_edges` view
//!     so graph questions are a JOIN instead of an encrypted-file open per friend. Second-
//!     order where `subscriptions` is first-order: that table holds our own personas' dials;
//!     this one holds third parties' published facts about third parties. Consented by
//!     construction - an unpublished edge never exists anywhere this fold can see.
//!
//!   - **`implicit_edges`** (each persona's own db) - the composition: my dial toward a
//!     friend x their published band toward a stranger, min of the two, one row per
//!     (target, lane, introducer). In the USER database deliberately, because the reader's
//!     side of the composition legitimately uses their PRIVATE trust dial - ranking your own
//!     feed is not a disclosure (the `subscriptions` doctrine, applied one level up) - and a
//!     level derived from a withheld dial must not leave the persona's own database.
//!
//! The trust lane composes my TRUST dial with their published TRUST band; the taste lane
//! composes my REBROADCAST dial with their published INTEREST band - my rebroadcast dial is
//! what I think of their taste, and an implicit follow is a taste judgment, not a character
//! one. The two lanes never mix.
//!
//! Sybil doctrine, enforced by shape: rows are per-introducer (the `feed_shares` discipline:
//! keep the crowd, roll up at read), consumers take MAX across introducers and never sums,
//! `introducer_vouches` is stored raw so banded promiscuity discounts stay tunable at read
//! time, and an explicit ledger dial on the target beats every row here.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use anyhow::{Context, Result};

use crate::clock::now_ms;
use crate::db::Db;
use crate::AppState;

/// Rows per multi-row upsert: 5-6 binds each, the fanout/subscriptions batching discipline.
const EDGE_CHUNK_ROWS: usize = 150;

/// A band ordinal back to its word - proto's ladder is the one source of truth.
fn band_word(ordinal: i64) -> &'static str {
    ringtome_proto::PublicEdge::BANDS[ordinal.clamp(0, 4) as usize]
}

/// Mirror one synced persona's published edges into the node-level graph - the fold's node
/// half, riding `fanout::after_public_move` for every persona whose frontier moved. The
/// probe answers first: most public moves are posts, and a persona with no follows-public
/// chain at all must cost one node.db primary-key read, not a database open.
///
/// Replace-set per author via the stamp sweep (the `subscriptions` idiom): every standing
/// edge is re-upserted with one timestamp, and rows the rewrite didn't touch - statements
/// since retracted, where the view keeps an empty-banded LWW tombstone this memo doesn't
/// want - are deleted by being older. Infallible-logging: this rides the fan-out edge, and
/// bookkeeping must not fail the machinery that detected the move.
pub async fn refresh_from(state: &AppState, author_root: &str) {
    let result: Result<()> = async {
        if !crate::net::frontier::has_service_chain(
            &state.node_db,
            author_root,
            ringtome_proto::registry::service::FOLLOWS_PUBLIC,
        )
        .await?
        {
            return Ok(());
        }
        let Some(db) = state
            .user_dbs
            .get(author_root)
            .await
            .with_context(|| format!("opening {author_root} to read its published edges"))?
        else {
            return Ok(());
        };
        let edges = crate::record::imaol::published_edges(&db)
            .await
            .map_err(|e| anyhow::anyhow!("reading published edges: {e}"))?;
        let now = now_ms();
        let standing: Vec<(&String, &crate::record::imaol::PublishedRow)> = edges
            .iter()
            .filter(|(_, row)| !row.edge.is_empty())
            .collect();
        for chunk in standing.chunks(EDGE_CHUNK_ROWS) {
            let placeholders: Vec<String> = (0..chunk.len())
                .map(|i| {
                    let b = i * 5;
                    format!("(?{},?{},?{},?{},?{})", b + 1, b + 2, b + 3, b + 4, b + 5)
                })
                .collect();
            let sql = format!(
                "INSERT INTO edge_graph (author_root, subject_root, trust, interest, updated_at_ms)
                 VALUES {}
                 ON CONFLICT (author_root, subject_root) DO UPDATE SET
                     trust = excluded.trust,
                     interest = excluded.interest,
                     updated_at_ms = excluded.updated_at_ms",
                placeholders.join(",")
            );
            let text = |v: &Option<String>| {
                v.clone().map(turso::Value::Text).unwrap_or(turso::Value::Null)
            };
            let params: Vec<turso::Value> = chunk
                .iter()
                .flat_map(|(subject, row)| {
                    [
                        turso::Value::Text(author_root.to_string()),
                        turso::Value::Text((*subject).clone()),
                        text(&row.edge.trust),
                        text(&row.edge.interest),
                        turso::Value::Integer(now),
                    ]
                })
                .collect();
            state
                .node_db
                .execute(&sql, turso::params_from_iter(params))
                .await
                .context("mirroring published edges into the graph")?;
        }
        state
            .node_db
            .execute(
                "DELETE FROM edge_graph WHERE author_root = ?1 AND updated_at_ms < ?2",
                (author_root, now),
            )
            .await
            .context("sweeping withdrawn edges from the graph")?;

        // The readers whose implicit sets this move may have changed: everyone here who has
        // any dial on the mover. Their whole memo choreography re-runs (subscriptions +
        // implicit ride one refresh) - heavier than the delta, but a friend's follows-public
        // chain moves at dial-mint cadence, and one choreography beats two drifting.
        for reader in crate::net::subscriptions::dialed_by(&state.node_db, author_root).await? {
            crate::net::subscriptions::refresh_root(state, &reader).await;
        }
        Ok(())
    }
    .await;
    if let Err(e) = result {
        tracing::debug!(author = %author_root, error = ?e, "edge graph refresh failed");
    }
}

/// Rebuild one persona's implicit set from their ledger x the assembled graph - the fold's
/// user half, riding `subscriptions::refresh` (the one place already holding the store open
/// with the whole ledger read). Whole-set rewrite via the stamp sweep, like the memo it
/// rides beside: implicit rows are pure derivation, and membership follows the inputs.
pub async fn refresh_implicit(
    state: &AppState,
    store: &crate::record::store::Store,
    reader_root: &str,
    contacts: &[(String, BTreeMap<String, String>)],
) -> Result<()> {
    // My side of every composition, PRIVATE dials included - the module doc carries the
    // posture argument. Blocked beats everything: a blocked target composes to nothing,
    // whoever vouches.
    let mut trust_dial: HashMap<&str, i64> = HashMap::new();
    let mut taste_dial: HashMap<&str, i64> = HashMap::new();
    let mut blocked: HashSet<&str> = HashSet::new();
    // Contacts the reader has ANY explicit dial on - including "none", which is an opinion
    // - for the demand rollup's exclusion: promotion out of (and refusal to enter) the
    // speculative pipeline is a real dial's job, and speculation must not overrule one.
    let mut explicit: HashSet<&str> = HashSet::new();
    for (root, facts) in contacts {
        if facts.get("blocked").map(String::as_str) == Some("yes") {
            blocked.insert(root);
            explicit.insert(root);
        }
        let band = |key: &str| {
            facts
                .get(key)
                .and_then(|v| crate::net::subscriptions::band_ordinal(v))
        };
        for dial in ["trust", "interest", "interest_rebroadcasts"] {
            if band(dial).is_some() {
                explicit.insert(root);
            }
        }
        if let Some(t) = band("trust").filter(|t| *t > 0) {
            trust_dial.insert(root, t);
        }
        if let Some(r) = band("interest_rebroadcasts").filter(|r| *r > 0) {
            taste_dial.insert(root, r);
        }
    }
    let introducers: BTreeSet<&str> = trust_dial.keys().chain(taste_dial.keys()).copied().collect();
    let now = now_ms();

    // The graph's rows for exactly these authors, one query. Quoted hex IN-list, the
    // belt-and-braces idiom: a non-root can name no row.
    let quoted: Vec<String> = introducers
        .iter()
        .filter(|r| r.len() == 64 && r.chars().all(|c| c.is_ascii_hexdigit()))
        .map(|r| format!("'{r}'"))
        .collect();
    type GraphRow = (String, String, Option<String>, Option<String>);
    let rows: Vec<GraphRow> = if quoted.is_empty() {
        Vec::new()
    } else {
        state
            .node_db
            .fetch_all(
                &format!(
                    "SELECT author_root, subject_root, trust, interest FROM edge_graph
                     WHERE author_root IN ({})",
                    quoted.join(",")
                ),
                (),
            )
            .await
            .context("reading the friends' slice of the edge graph")?
    };

    // Promiscuity, per introducer per lane, counted over PUBLISHED vouches above the
    // bottom band - an anti-vouch ("none") is not a spent capacity. Raw counts; the
    // banded discount is the reader's, at read time.
    let mut vouches: HashMap<(&str, &str), i64> = HashMap::new();
    for (author, _, trust, interest) in &rows {
        let counted = |v: &Option<String>| {
            v.as_deref()
                .and_then(crate::net::subscriptions::band_ordinal)
                .is_some_and(|o| o > 0)
        };
        if counted(trust) {
            *vouches.entry((author, "trust")).or_default() += 1;
        }
        if counted(interest) {
            *vouches.entry((author, "taste")).or_default() += 1;
        }
    }

    // The composition: min(my dial, their band), per lane, floor discarded - a row that
    // composes to the bottom band says "don't show", and a row nobody will read is never
    // written (the feed journal's own rule).
    let mut composed: Vec<crate::speculative::ComposedEdge<'_>> = Vec::new();
    for (author, subject, trust, interest) in &rows {
        if subject == reader_root || blocked.contains(subject.as_str()) {
            continue;
        }
        let theirs = |v: &Option<String>| {
            v.as_deref().and_then(crate::net::subscriptions::band_ordinal)
        };
        if let (Some(mine), Some(published)) = (trust_dial.get(author.as_str()), theirs(trust))
        {
            let level = (*mine).min(published);
            if level > 0 {
                let count = vouches.get(&(author.as_str(), "trust")).copied().unwrap_or(0);
                composed.push(crate::speculative::ComposedEdge {
                    target: subject,
                    lane: "trust",
                    introducer: author,
                    level,
                    introducer_vouches: count,
                });
            }
        }
        if let (Some(mine), Some(published)) =
            (taste_dial.get(author.as_str()), theirs(interest))
        {
            let level = (*mine).min(published);
            if level > 0 {
                let count = vouches.get(&(author.as_str(), "taste")).copied().unwrap_or(0);
                composed.push(crate::speculative::ComposedEdge {
                    target: subject,
                    lane: "taste",
                    introducer: author,
                    level,
                    introducer_vouches: count,
                });
            }
        }
    }

    for chunk in composed.chunks(EDGE_CHUNK_ROWS) {
        let placeholders: Vec<String> = (0..chunk.len())
            .map(|i| {
                let b = i * 6;
                format!(
                    "(?{},?{},?{},2,?{},?{},?{})",
                    b + 1,
                    b + 2,
                    b + 3,
                    b + 4,
                    b + 5,
                    b + 6
                )
            })
            .collect();
        let sql = format!(
            "INSERT INTO implicit_edges
               (target_root, lane, introducer_root, depth, level, introducer_vouches, updated_at_ms)
             VALUES {}
             ON CONFLICT (target_root, lane, introducer_root) DO UPDATE SET
                 level = excluded.level,
                 introducer_vouches = excluded.introducer_vouches,
                 updated_at_ms = excluded.updated_at_ms",
            placeholders.join(",")
        );
        let params: Vec<turso::Value> = chunk
            .iter()
            .flat_map(|edge| {
                [
                    turso::Value::Text(edge.target.to_string()),
                    turso::Value::Text(edge.lane.to_string()),
                    turso::Value::Text(edge.introducer.to_string()),
                    turso::Value::Text(band_word(edge.level).to_string()),
                    turso::Value::Integer(edge.introducer_vouches),
                    turso::Value::Integer(now),
                ]
            })
            .collect();
        store
            .db()
            .execute(&sql, turso::params_from_iter(params))
            .await
            .context("writing implicit edges")?;
    }

    // The stamp sweep: rows this rewrite didn't touch are compositions whose inputs went
    // away - a friend unfollowed, a vouch withdrawn, a dial dropped to the floor.
    store
        .db()
        .execute(
            "DELETE FROM implicit_edges WHERE updated_at_ms < ?1",
            (now,),
        )
        .await
        .context("sweeping stale implicit edges")?;

    // The demand rollup rides the same pass (DISCOVERY.md slice 1), for the same reason the
    // implicit fold rides subscriptions::refresh: the composed rows exist as values exactly
    // here, so the two memos are one choreography and cannot drift. This is the ONE read of
    // the reader's private-dial-derived levels that leaves their database, and what leaves
    // is the rollup's conclusion (acquire these strangers), not the dials it came from.
    crate::speculative::refresh_demand(state, reader_root, &composed, &explicit)
        .await
        .context("rolling up speculative demand")?;
    Ok(())
}

/// One implicit row, as the API serves it - raw ingredients on purpose (depth, level,
/// introducer, their vouch count), so the UI can explain a suggestion rather than assert a
/// score, and read-side policy (promiscuity discounts, explicit-dial precedence, MAX-across-
/// introducers rollup) stays where policy belongs.
#[derive(Debug, serde::Serialize)]
pub struct ImplicitRow {
    pub target_root: String,
    pub lane: String,
    pub introducer_root: String,
    pub depth: i64,
    pub level: String,
    pub introducer_vouches: i64,
}

/// A persona's implicit set, per-introducer rows in stable order. The one sanctioned read of
/// `implicit_edges` (tests/conventions.rs owns the SQL to this module).
pub async fn implicit_of(db: &Db) -> Result<Vec<ImplicitRow>> {
    type Row = (String, String, String, i64, String, i64);
    let rows: Vec<Row> = db
        .fetch_all(
            "SELECT target_root, lane, introducer_root, depth, level, introducer_vouches
             FROM implicit_edges ORDER BY lane, target_root, introducer_root",
            (),
        )
        .await
        .context("listing implicit edges")?;
    Ok(rows
        .into_iter()
        .map(
            |(target_root, lane, introducer_root, depth, level, introducer_vouches)| ImplicitRow {
                target_root,
                lane,
                introducer_root,
                depth,
                level,
                introducer_vouches,
            },
        )
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ladder_round_trips() {
        assert_eq!(band_word(0), "none");
        assert_eq!(band_word(3), "high");
        assert_eq!(band_word(4), "max");
        assert_eq!(band_word(99), "max", "out of range clamps rather than panics");
        assert_eq!(band_word(-5), "none");
    }
}
