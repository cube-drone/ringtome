//! The network's daily active users, as this node can best tell (HORSE_BASED_CURRENCIES.md,
//! 2026-09-29, Curtis: every node estimating "the active network DAU based on every node it has
//! communicated with recently" - no node reports to any centre).
//!
//! **A HyperLogLog sketch per UTC day.** 1,024 one-byte registers: each active persona's root is
//! hashed, the hash's top ten bits pick a register, and the register keeps the longest run of
//! leading zeros it has seen in the rest. From the registers alone comes an estimate of how many
//! distinct roots went in, within about 3%. Two sketches merge by taking each register's maximum -
//! commutative, idempotent, order-free - so a persona active on two computers counts once however
//! many nodes report them, and the registers name nobody.
//!
//! **What goes in:** the personas active on this node today (`heartbeat::note`), and any persona
//! whose heartbeat this node holds (`profiles::refresh`, off the byline cache's `last_active`).
//!
//! **How it spreads:** every few minutes the node swaps sketches with a few peers it has synced with
//! lately (`WantCensus` / `Census`): it sends its own, the peer merges them and answers with the
//! merged result, and this node merges that. What each node hands on includes what it was handed,
//! so a few hops carry the whole connected network. A peer that predates the question drops the
//! stream, and is left alone for a day.
//!
//! **What a node shows:** its own estimate - the larger of today-so-far and yesterday, so the front
//! page's counter never drops to nothing at midnight UTC - and the history of each day's estimate.
//! It counts personas, not people.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use anyhow::{Context, Result};
use ringtome_proto::fragment::{CENSUS_REGISTERS, MAX_CENSUS_DAYS};

use crate::AppState;

const DAY_MS: i64 = 86_400_000;
/// How often the gossip pass runs, and how many peers it asks each time.
const PEERS_PER_PASS: usize = 8;
/// How long a peer rests after being asked, and after refusing the question.
const ASK_EVERY_MS: i64 = 3 * 60 * 60 * 1000;
const REFUSED_REST_MS: i64 = DAY_MS;
/// "Communicated with recently": answered by, asked by, synced with or handed a fragment by, within
/// this long.
const RECENT_MS: i64 = 2 * DAY_MS;
/// Days kept whole (registers and all); older days keep only their estimate, for the graph.
const KEEP_REGISTERS_DAYS: u32 = 3;

/// The UTC day of a moment, as days since 1970-01-01 - what the wire and the table key on.
pub fn day_of(ms: i64) -> u32 {
    u32::try_from(ms.div_euclid(DAY_MS)).unwrap_or(0)
}

// ---------------------------------------------------------------------------------------------
// The sketch

fn hash(root_hex: &str) -> u64 {
    let mut h = blake3::Hasher::new();
    h.update(b"ringtome census v1\0");
    h.update(root_hex.as_bytes());
    u64::from_be_bytes(h.finalize().as_bytes()[..8].try_into().expect("eight bytes"))
}

/// Put one root into a sketch.
fn insert(registers: &mut [u8], root_hex: &str) {
    let h = hash(root_hex);
    let index = (h >> 54) as usize; // the top ten bits
    let rest = h << 10;
    let rank = if rest == 0 { 55 } else { rest.leading_zeros() as u8 + 1 };
    if registers[index] < rank {
        registers[index] = rank;
    }
}

/// Fold `other` into `into`, register by register.
fn merge_into(into: &mut [u8], other: &[u8]) {
    for (a, b) in into.iter_mut().zip(other) {
        if *b > *a {
            *a = *b;
        }
    }
}

/// How many distinct roots went in, estimated: HyperLogLog, with linear counting for the small
/// numbers a young network has (so three actives read as 3, not "about 3").
fn estimate(registers: &[u8]) -> u64 {
    let m = registers.len() as f64;
    let alpha = 0.7213 / (1.0 + 1.079 / m);
    let sum: f64 = registers.iter().map(|&r| 2f64.powi(-i32::from(r))).sum();
    let raw = alpha * m * m / sum;
    let zeros = registers.iter().filter(|&&r| r == 0).count();
    let e = if raw <= 2.5 * m && zeros > 0 { m * (m / zeros as f64).ln() } else { raw };
    e.round() as u64
}

// ---------------------------------------------------------------------------------------------
// The days, kept

/// Every census write is load, merge, store: one at a time.
static WRITES: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

async fn registers_of(node_db: &crate::db::Db, day: u32) -> Vec<u8> {
    node_db
        .fetch_optional::<(Vec<u8>,)>("SELECT registers FROM census_days WHERE day = ?1", (i64::from(day),))
        .await
        .ok()
        .flatten()
        .map(|(r,)| r)
        .filter(|r| r.len() == CENSUS_REGISTERS)
        .unwrap_or_else(|| vec![0u8; CENSUS_REGISTERS])
}

async fn store(node_db: &crate::db::Db, day: u32, registers: &[u8]) -> Result<()> {
    node_db
        .execute(
            "INSERT INTO census_days (day, registers, estimate, updated_ms) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (day) DO UPDATE SET registers = excluded.registers, estimate = excluded.estimate,
               updated_ms = excluded.updated_ms",
            (i64::from(day), registers.to_vec(), estimate(registers) as i64, crate::clock::now_ms()),
        )
        .await
        .context("keeping a census day")?;
    Ok(())
}

/// A persona was active on `day`: into that day's sketch. Days outside the recent few are ignored.
pub async fn saw(state: &AppState, root_hex: &str, day: u32) {
    let today = day_of(crate::clock::now_ms());
    if day > today || today - day >= KEEP_REGISTERS_DAYS {
        return;
    }
    let _w = WRITES.lock().await;
    let mut registers = registers_of(&state.node_db, day).await;
    let before = registers.clone();
    insert(&mut registers, root_hex);
    if registers != before {
        if let Err(e) = store(&state.node_db, day, &registers).await {
            tracing::debug!(error = ?e, "a census day wasn't kept");
        }
    }
}

/// Merge sketches handed over into ours, for the recent days only.
async fn merge(state: &AppState, sketches: &[(u32, Vec<u8>)]) {
    let today = day_of(crate::clock::now_ms());
    let _w = WRITES.lock().await;
    for (day, theirs) in sketches {
        if *day > today || today - day >= KEEP_REGISTERS_DAYS || theirs.len() != CENSUS_REGISTERS {
            continue;
        }
        let mut ours = registers_of(&state.node_db, *day).await;
        let before = ours.clone();
        merge_into(&mut ours, theirs);
        if ours != before {
            if let Err(e) = store(&state.node_db, *day, &ours).await {
                tracing::debug!(error = ?e, "a census merge wasn't kept");
            }
        }
    }
}

/// Our sketches for the recent days, today first.
async fn recent_sketches(state: &AppState) -> Vec<(u32, Vec<u8>)> {
    let today = day_of(crate::clock::now_ms());
    let mut out = Vec::new();
    for back in 0..(MAX_CENSUS_DAYS as u32).min(KEEP_REGISTERS_DAYS) {
        let Some(day) = today.checked_sub(back) else { break };
        out.push((day, registers_of(&state.node_db, day).await));
    }
    out
}

// ---------------------------------------------------------------------------------------------
// The gossip

/// The fragment lane's answer: merge what the asker brought, hand back the merged days it named.
pub async fn answer(state: &AppState, theirs: Vec<(u32, Vec<u8>)>) -> ringtome_proto::fragment::FragmentMessage {
    merge(state, &theirs).await;
    let mut out = Vec::new();
    for (day, _) in theirs.iter().take(MAX_CENSUS_DAYS) {
        out.push((*day, registers_of(&state.node_db, *day).await));
    }
    ringtome_proto::fragment::FragmentMessage::Census { sketches: out }
}

/// Each peer's last ask, and whether it refused the question.
static ASKED: LazyLock<Mutex<HashMap<String, (i64, bool)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// One pass: swap sketches with a few peers this node has talked to lately.
pub async fn pass(state: AppState) -> Result<()> {
    swap(state, true).await
}

/// The same pass with no rests - every recent peer, now (the test rig's beat).
pub async fn pass_now(state: AppState) -> Result<()> {
    swap(state, false).await
}

async fn swap(state: AppState, paced: bool) -> Result<()> {
    let now = crate::clock::now_ms();
    let ours_ep = state.endpoint.id().to_string();
    // Everyone this node has talked to lately, however: synced with, answered by, asked by, or
    // handed a fragment by.
    let since = now - RECENT_MS;
    let mut peers: Vec<String> = Vec::new();
    for ep in crate::idface::recent_answerers(&state, since)
        .await
        .into_iter()
        .chain(crate::net::demand::recent_askers(&state.node_db, since).await.unwrap_or_default())
        .chain(crate::net::sync::recently_synced_endpoints(&state.node_db, since).await.unwrap_or_default())
        .chain(crate::fragments::recent_deliverers(&state.node_db, since).await.unwrap_or_default())
    {
        if !peers.contains(&ep) {
            peers.push(ep);
        }
    }
    let due: Vec<String> = {
        let asked = ASKED.lock().expect("census asks poisoned");
        peers
            .into_iter()
            .filter(|ep| *ep != ours_ep)
            .filter(|ep| {
                !paced
                    || match asked.get(ep) {
                        Some((at, refused)) => now - at > if *refused { REFUSED_REST_MS } else { ASK_EVERY_MS },
                        None => true,
                    }
            })
            .take(if paced { PEERS_PER_PASS } else { usize::MAX })
            .collect()
    };
    for endpoint in due {
        let sketches = recent_sketches(&state).await;
        let answered = crate::net::fragment::fetch_census(&state, &endpoint, sketches).await;
        let refused = answered.is_err();
        if let Ok(theirs) = answered {
            merge(&state, &theirs).await;
        }
        ASKED.lock().expect("census asks poisoned").insert(endpoint, (now, refused));
    }
    // Old days keep their estimate for the graph, and drop their registers.
    let cutoff = i64::from(day_of(now).saturating_sub(KEEP_REGISTERS_DAYS));
    let _ = state
        .node_db
        .execute("UPDATE census_days SET registers = x'' WHERE day < ?1 AND length(registers) > 0", (cutoff,))
        .await;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// The front page's counter

/// GET `/api/node/census` - this node's estimate of the network's daily actives: the number to
/// show (the larger of today-so-far and yesterday), both days, and every day's estimate for the
/// graph, oldest first. Public: it names nobody.
pub async fn census_handler(axum::extract::State(state): axum::extract::State<AppState>) -> axum::Json<serde_json::Value> {
    let today = day_of(crate::clock::now_ms());
    let rows: Vec<(i64, i64)> = state
        .node_db
        .fetch_all("SELECT day, estimate FROM census_days ORDER BY day DESC LIMIT 366", ())
        .await
        .unwrap_or_default();
    let on = |d: u32| rows.iter().find(|(day, _)| *day == i64::from(d)).map_or(0, |(_, e)| *e);
    let (now, before) = (on(today), today.checked_sub(1).map_or(0, on));
    let history: Vec<serde_json::Value> = rows
        .iter()
        .rev()
        .map(|(day, e)| serde_json::json!({ "date": crate::heartbeat::utc_date(day * DAY_MS), "active": e }))
        .collect();
    axum::Json(serde_json::json!({ "shown": now.max(before), "today": now, "yesterday": before, "history": history }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Small counts are exact, a thousand is within a few percent, a repeat counts once, and
    /// merging is commutative and idempotent - so a persona reported by two nodes counts once.
    #[test]
    fn the_sketch_counts_distinct_roots_and_merges_by_maximum() {
        let root = |i: usize| format!("{i:064x}");
        let mut a = vec![0u8; CENSUS_REGISTERS];
        for i in 0..3 {
            insert(&mut a, &root(i));
            insert(&mut a, &root(i)); // the same persona again
        }
        assert_eq!(estimate(&a), 3, "three personas, however often seen");

        let mut big = vec![0u8; CENSUS_REGISTERS];
        for i in 0..1000 {
            insert(&mut big, &root(i));
        }
        let e = estimate(&big) as f64;
        assert!((e - 1000.0).abs() / 1000.0 < 0.08, "a thousand, near enough: {e}");

        let mut b = vec![0u8; CENSUS_REGISTERS];
        for i in 2..6 {
            insert(&mut b, &root(i)); // overlaps a at 2
        }
        let (mut ab, mut ba) = (a.clone(), b.clone());
        merge_into(&mut ab, &b);
        merge_into(&mut ba, &a);
        assert_eq!(ab, ba, "commutative");
        assert_eq!(estimate(&ab), 6, "0-5: the overlap counted once");
        let again = ab.clone();
        merge_into(&mut ab, &again);
        assert_eq!(ab, again, "idempotent");
    }

    #[test]
    fn a_moment_is_its_day() {
        assert_eq!(day_of(0), 0);
        assert_eq!(day_of(DAY_MS - 1), 0);
        assert_eq!(day_of(1_790_726_400_000), 20_726);
        assert_eq!(crate::heartbeat::utc_date(20_726 * DAY_MS), "2026-09-30");
    }
}
