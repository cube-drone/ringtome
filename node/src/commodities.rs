//! hrseCommodities (plans/COMMODITIES.md; Curtis, 2026-10-06): hay, oats, carrots, apples,
//! horseshoes, bridles and saddles, bought and sold in hrseBank's Market behind Horse Financial.
//!
//! **A price is a walk, the same everywhere.** Each commodity's price wanders around a target
//! that compounds 0.4% a day from its starting price, pulled back toward it a little every day;
//! each day's step is a hash of the commodity and the day, so every computer derives the same
//! walk without asking anyone. No exchange, no network, no protocol.
//!
//! **Nudged by the network's weather, at most 5%.** Each commodity reads one signal off the
//! node's public feed - its posts, drawings, words, positive and negative reactions, chat, and follows of
//! its personas - as this week against the month. That part differs by node, and is capped so the
//! arbitrage between a player's own computers stays a bet, not free money (ruling 2: no markup).
//! The counts are taken once a day into `commodity_days` (this module owns it).
//!
//! **A purchase is a lot, like a hrseBond.** Lots and sales are entries in the persona's
//! `horse_instruments` register, each with the price it paid, so the ledger agrees on every
//! computer whatever its weather was (bank.rs folds them into lines). A lot sells two UTC days
//! after it was bought at the earliest. Every amount is a bigint.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};

use anyhow::Result;
use num_bigint::BigInt;
use num_traits::{FromPrimitive, Signed, Zero};
use serde_json::json;

use crate::db::Db;
use crate::record::store::Store;
use crate::AppState;

/// One commodity: its id (stable - lots name it), its starting price in whole HorseBucks, its
/// daily volatility, and the signal its weather reads.
pub struct Commodity {
    pub id: &'static str,
    pub start: i64,
    pub volatility: f64,
    pub signal: &'static str,
}

/// Every commodity, in the order the Market lists them (Curtis, 2026-10-06; prices and
/// volatilities proposed in the plan).
pub const COMMODITIES: [Commodity; 7] = [
    Commodity { id: "hay", start: 50, volatility: 0.03, signal: "drawings" },
    Commodity { id: "oats", start: 80, volatility: 0.04, signal: "words" },
    Commodity { id: "carrots", start: 120, volatility: 0.06, signal: "positive" },
    Commodity { id: "apples", start: 120, volatility: 0.06, signal: "negative" },
    Commodity { id: "bridles", start: 150, volatility: 0.05, signal: "chat" },
    Commodity { id: "horseshoes", start: 400, volatility: 0.08, signal: "follows" },
    Commodity { id: "saddles", start: 600, volatility: 0.07, signal: "posts" },
];

/// Day zero, the day the commodities opened: 2026-10-06, in days since 1970-01-01. The target's
/// drift counts from it.
const DAY_ZERO: i64 = 20_732;
/// Where the walk begins: a month before day zero, so the first day's chart has a past.
const WALK_FROM: i64 = DAY_ZERO - 30;
/// The target's drift a day (ruling 4): 0.4%, compounding.
const DRIFT: f64 = 0.004;
/// How far back toward the target the walk is pulled each day.
const REVERT: f64 = 0.05;
/// The weather's cap: the most the node-seen part can move a price, either way.
const CAP: f64 = 0.05;
/// Too few events in the month is no weather: the walk carries the market alone.
const DATA_FLOOR: i64 = 10;
/// The fewest horsepennies a commodity is ever worth: one HorseBuck.
const PRICE_FLOOR: f64 = 100.0;
/// A lot sells this many UTC days after the day it was bought, at the earliest.
pub const HOLD_DAYS: i64 = 2;

const DAY_MS: i64 = 86_400_000;

/// A moment's UTC day, in days since 1970-01-01.
pub fn day_of(ms: i64) -> i64 {
    ms.div_euclid(DAY_MS)
}

pub fn by_id(id: &str) -> Option<&'static Commodity> {
    COMMODITIES.iter().find(|c| c.id == id)
}

// ---- the walk ----

/// The walk's step on day `n`: a standard normal, near enough (twelve uniforms, less six), from a
/// hash of the commodity and the day - the same on every computer, forever.
fn shock(id: &str, n: i64) -> f64 {
    let hash = blake3::Hasher::new()
        .update(b"ringtome/commodity-walk/0\0")
        .update(id.as_bytes())
        .update(b"\0")
        .update(&n.to_le_bytes())
        .finalize();
    let b = hash.as_bytes();
    let sum: f64 =
        (0..12).map(|i| f64::from(u16::from_le_bytes([b[2 * i], b[2 * i + 1]])) / 65_536.0).sum();
    sum - 6.0
}

/// The walk's deviation from its target, in log terms, for the `k + 1` days from the walk's start
/// (`WALK_FROM`): each day keeps 95% of the last and adds that day's shock, keyed by the day itself.
fn deviations(c: &Commodity, k: i64) -> Vec<f64> {
    let mut out = Vec::with_capacity(k.max(0) as usize + 1);
    let mut x = 0.0;
    out.push(x);
    for i in 1..=k {
        x = (1.0 - REVERT) * x + c.volatility * shock(c.id, WALK_FROM + i);
        out.push(x);
    }
    out
}

/// A price in horsepennies: the target `n` days after day zero (before it, `n` is negative), the
/// walk's deviation, and the weather.
/// Computed in floating point and rounded once - and recorded when traded, so a last-place
/// difference between two computers' arithmetic can never split a ledger.
fn price(c: &Commodity, n: i64, deviation: f64, nudge: f64) -> BigInt {
    let p =
        (c.start as f64) * 100.0 * (1.0 + DRIFT).powf(n as f64) * deviation.exp() * (1.0 + nudge);
    BigInt::from_f64(p.round().max(PRICE_FLOOR)).unwrap_or_else(|| BigInt::from(100))
}

/// A UTC day's place in the walk (never before its start).
fn walk_index(day: i64) -> i64 {
    (day - WALK_FROM).max(0)
}

// ---- the weather ----

/// The signals the weather counts off dated rows, every day of them at once.
const DATED: [&str; 6] = ["posts", "drawings", "words", "positive", "negative", "chat"];

/// The weather, once a day per node: each signal's nudge, in [-CAP, CAP].
/// Each signal's nudge, as one day's weather.
type Nudges = HashMap<&'static str, f64>;

static WEATHER: LazyLock<Mutex<Option<(i64, Nudges)>>> = LazyLock::new(|| Mutex::new(None));

/// Today's nudge for every signal, counting what's missing first. Cached for the day.
pub async fn weather(state: &AppState) -> Result<Nudges> {
    let today = day_of(crate::clock::now_ms());
    if let Some((day, w)) = WEATHER.lock().expect("weather poisoned").as_ref() {
        if *day == today {
            return Ok(w.clone());
        }
    }
    count_days(state, today).await?;
    let rows = days(&state.node_db, today - 31, today + 1).await?;
    let mut w = HashMap::new();
    for signal in DATED {
        let daily: Vec<i64> = (today - 30..today)
            .map(|d| rows.get(&(d, signal.to_string())).copied().unwrap_or(0))
            .collect();
        w.insert(signal, nudge_of(&daily));
    }
    // Follows are a snapshot a day: the growth between two days' snapshots is that day's new
    // follows, where both were taken.
    let follows: Vec<i64> = (today - 29..=today)
        .filter_map(|d| {
            let now = rows.get(&(d, "follows".to_string()))?;
            let before = rows.get(&(d - 1, "follows".to_string()))?;
            Some((now - before).max(0))
        })
        .collect();
    w.insert("follows", nudge_of(&follows));
    *WEATHER.lock().expect("weather poisoned") = Some((today, w.clone()));
    Ok(w)
}

/// A signal's nudge from its daily counts, oldest first: the last seven days' daily rate over the
/// whole run's, less one, clamped to ±1 and scaled to the cap. Too little data is no nudge.
fn nudge_of(daily: &[i64]) -> f64 {
    let total: i64 = daily.iter().sum();
    if total < DATA_FLOOR || daily.len() < 7 {
        return 0.0;
    }
    let week: i64 = daily[daily.len() - 7..].iter().sum();
    let ratio = (week as f64 / 7.0) / (total as f64 / daily.len() as f64) - 1.0;
    CAP * ratio.clamp(-1.0, 1.0)
}

/// The counted days in `[from, to)`: (day, signal) -> value.
async fn days(node_db: &Db, from: i64, to: i64) -> Result<HashMap<(i64, String), i64>> {
    let rows: Vec<(i64, String, i64)> = node_db
        .fetch_all(
            "SELECT day, signal, value FROM commodity_days WHERE day >= ?1 AND day < ?2",
            (from, to),
        )
        .await?;
    Ok(rows.into_iter().map(|(d, s, v)| ((d, s), v)).collect())
}

/// Count whatever the last thirty days lack, and today's follows snapshot. The dated signals of a
/// day are counted together, once the day is over; a node's first count fills the month in.
async fn count_days(state: &AppState, today: i64) -> Result<()> {
    let node_db = &state.node_db;
    let have = days(node_db, today - 30, today + 1).await?;
    let first_missing =
        (today - 30..today).find(|d| !have.contains_key(&(*d, "posts".to_string())));
    let now = crate::clock::now_ms();
    if let Some(from) = first_missing {
        let mut counts: HashMap<(i64, &str), i64> = HashMap::new();
        for (author, doc, format, published) in
            crate::nodeshelf::feed_between(node_db, from * DAY_MS, today * DAY_MS).await?
        {
            let d = day_of(published);
            *counts.entry((d, "posts")).or_default() += 1;
            if format.as_deref() == Some("drawing") {
                *counts.entry((d, "drawings")).or_default() += 1;
            }
            *counts.entry((d, "words")).or_default() +=
                crate::search::distinct_words(node_db, &author, &doc).await?;
        }
        let feed = crate::nodeshelf::feed_posts(node_db).await?;
        let on_feed: HashSet<(String, String)> =
            feed.iter().map(|(a, d, _)| (a.clone(), d.clone())).collect();
        for (author, doc, emoji, noted) in
            crate::annotations::emoji_noted_between(node_db, from * DAY_MS, today * DAY_MS).await?
        {
            if !on_feed.contains(&(author, doc)) {
                continue;
            }
            match crate::score::tone(&emoji) {
                1 => *counts.entry((day_of(noted), "positive")).or_default() += 1,
                -1 => *counts.entry((day_of(noted), "negative")).or_default() += 1,
                _ => {}
            }
        }
        for (author, doc, _) in feed.iter().filter(|(_, _, f)| f.as_deref() == Some("room")) {
            for said in
                crate::chat::said_between(node_db, author, doc, from * DAY_MS, today * DAY_MS)
                    .await?
            {
                *counts.entry((day_of(said), "chat")).or_default() += 1;
            }
        }
        for d in from..today {
            if have.contains_key(&(d, "posts".to_string())) {
                continue;
            }
            for signal in DATED {
                let value = counts.get(&(d, signal)).copied().unwrap_or(0);
                node_db
                    .execute(
                        "INSERT OR REPLACE INTO commodity_days (day, signal, value, updated_ms) VALUES (?1, ?2, ?3, ?4)",
                        (d, signal, value, now),
                    )
                    .await?;
            }
        }
    }
    if !have.contains_key(&(today, "follows".to_string())) {
        let mut follows = 0i64;
        for root in crate::nodeshelf::listed_roots(node_db).await? {
            follows += crate::edgegraph::edges_naming(node_db, &root).await?.len() as i64;
        }
        node_db
            .execute(
                "INSERT OR REPLACE INTO commodity_days (day, signal, value, updated_ms) VALUES (?1, 'follows', ?2, ?3)",
                (today, follows, now),
            )
            .await?;
    }
    Ok(())
}

// ---- prices ----

/// One commodity as the Market shows it today.
pub struct Quote {
    pub commodity: &'static Commodity,
    pub price: BigInt,
    pub nudge: f64,
    /// The walk's last thirty days, oldest first, weather left out - the shared part of the price.
    pub history: Vec<(i64, BigInt)>,
}

/// Every commodity's price today on this node.
pub async fn quotes(state: &AppState) -> Result<Vec<Quote>> {
    let today = day_of(crate::clock::now_ms());
    let weather = weather(state).await?;
    let k = walk_index(today);
    Ok(COMMODITIES
        .iter()
        .map(|c| {
            let walk = deviations(c, k);
            let nudge = weather.get(c.signal).copied().unwrap_or(0.0);
            let at =
                |i: i64, nudge: f64| price(c, WALK_FROM + i - DAY_ZERO, walk[i as usize], nudge);
            Quote {
                commodity: c,
                price: at(k, nudge),
                nudge,
                history: ((k - 29).max(0)..=k).map(|i| (WALK_FROM + i, at(i, 0.0))).collect(),
            }
        })
        .collect())
}

// ---- lots ----

/// A purchase: units of one commodity at the price it paid, a unit.
pub struct Lot {
    pub id: String,
    pub commodity: String,
    pub units: BigInt,
    pub price: BigInt,
    pub bought_ms: i64,
}

/// A sale of some of a lot's units, at the price it was sold for, a unit.
pub struct Sale {
    pub id: String,
    pub lot: String,
    pub units: BigInt,
    pub price: BigInt,
    pub sold_ms: i64,
}

/// Every lot and sale the persona's instruments register holds, oldest first.
pub async fn holdings(data: &Store) -> Result<(Vec<Lot>, Vec<Sale>)> {
    let (registers, _) = data
        .private_registers(crate::bank::INSTRUMENTS)
        .all()
        .await
        .map_err(|e| anyhow::anyhow!("reading instruments: {e}"))?;
    let (mut lots, mut sales) = (Vec::new(), Vec::new());
    for r in registers {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&r.value) else { continue };
        let big = |k: &str| v[k].as_str().and_then(|s| s.parse::<BigInt>().ok());
        match v["kind"].as_str() {
            Some("commodity") => {
                let (Some(commodity), Some(units), Some(price), Some(bought_ms)) =
                    (v["commodity"].as_str(), big("units"), big("price"), v["bought_ms"].as_i64())
                else {
                    continue;
                };
                lots.push(Lot {
                    id: r.key,
                    commodity: commodity.to_string(),
                    units,
                    price,
                    bought_ms,
                });
            }
            Some("commodity_sale") => {
                let (Some(lot), Some(units), Some(price), Some(sold_ms)) =
                    (v["lot"].as_str(), big("units"), big("price"), v["sold_ms"].as_i64())
                else {
                    continue;
                };
                sales.push(Sale { id: r.key, lot: lot.to_string(), units, price, sold_ms });
            }
            _ => {}
        }
    }
    lots.sort_by_key(|l| (l.bought_ms, l.id.clone()));
    sales.sort_by_key(|s| (s.sold_ms, s.id.clone()));
    Ok((lots, sales))
}

/// A lot's units not yet sold.
fn held(lot: &Lot, sales: &[Sale]) -> BigInt {
    let sold: BigInt = sales.iter().filter(|s| s.lot == lot.id).map(|s| &s.units).sum();
    &lot.units - sold
}

/// When a lot bought at `bought_ms` may first be sold: the start of the UTC day two days after.
pub fn sellable_from(bought_ms: i64) -> i64 {
    (day_of(bought_ms) + HOLD_DAYS) * DAY_MS
}

fn new_id() -> String {
    use rand::RngCore;
    let mut b = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut b);
    hex::encode(b)
}

/// A whole number of units, at least one, from its decimal string.
fn units_of(text: &str) -> Option<BigInt> {
    text.trim().parse::<BigInt>().ok().filter(|u| u.is_positive())
}

// ---- the doors ----

/// GET `/api/identity/{root}/bank/commodities` - today's quotes, with their weather and the walk's
/// month, and the persona's lots with what each holds, cost, and would sell for today.
pub async fn quotes_handler(
    session: crate::auth::Session,
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Path(root): axum::extract::Path<String>,
) -> Result<axum::Json<serde_json::Value>, crate::error::AppError> {
    use crate::error::AppError;
    let data = crate::record::store::open(&state, &session.account.id, &root).await?;
    let quotes = quotes(&state).await.map_err(AppError::Internal)?;
    let (lots, sales) = holdings(&data).await.map_err(AppError::Internal)?;
    let now = crate::clock::now_ms();
    let today_price =
        |id: &str| quotes.iter().find(|q| q.commodity.id == id).map(|q| q.price.clone());
    let commodities: Vec<serde_json::Value> = quotes
        .iter()
        .map(|q| {
            json!({
                "id": q.commodity.id,
                "signal": q.commodity.signal,
                "price": q.price.to_string(),
                "nudge_permille": (q.nudge * 1000.0).round() as i64,
                "history": q.history.iter().map(|(d, p)| json!({ "day": d, "price": p.to_string() })).collect::<Vec<_>>(),
            })
        })
        .collect();
    let held_lots: Vec<serde_json::Value> = lots
        .iter()
        .rev()
        .filter_map(|l| {
            let units = held(l, &sales);
            if units.is_zero() {
                return None;
            }
            let worth = today_price(&l.commodity).map(|p| (&units * p).to_string());
            Some(json!({
                "id": l.id,
                "commodity": l.commodity,
                "units": units.to_string(),
                "bought_units": l.units.to_string(),
                "price": l.price.to_string(),
                "bought_ms": l.bought_ms,
                "sellable_from_ms": sellable_from(l.bought_ms),
                "sellable": now >= sellable_from(l.bought_ms),
                "worth": worth,
            }))
        })
        .collect();
    Ok(axum::Json(json!({ "commodities": commodities, "lots": held_lots })))
}

#[derive(serde::Deserialize)]
pub struct BuyRequest {
    commodity: String,
    /// Whole units, as a decimal string.
    units: String,
}

/// POST `/api/identity/{root}/bank/commodities` - buy units of a commodity at today's price on this
/// node, if the balance pays for them (the bonds' no-overdraft rule).
pub async fn buy_handler(
    session: crate::auth::Session,
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Path(root): axum::extract::Path<String>,
    axum::Json(req): axum::Json<BuyRequest>,
) -> Result<axum::Json<serde_json::Value>, crate::error::AppError> {
    use crate::error::AppError;
    let Some(c) = by_id(&req.commodity) else {
        return Err(AppError::BadRequest(crate::msg!(
            "commodities.no-such-commodity",
            "no such commodity"
        )));
    };
    let Some(units) = units_of(&req.units) else {
        return Err(AppError::BadRequest(crate::msg!(
            "commodities.a-whole-number-of-units",
            "buy a whole number of units, one or more"
        )));
    };
    let data = crate::record::store::open(&state, &session.account.id, &root).await?;
    let price = quotes(&state)
        .await
        .map_err(AppError::Internal)?
        .into_iter()
        .find(|q| q.commodity.id == c.id)
        .map(|q| q.price)
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("a commodity without a quote")))?;
    let cost = &units * &price;
    crate::bank::catch_up(&state, &data, &root).await.map_err(AppError::Internal)?;
    if crate::bank::balance(&data).await.map_err(AppError::Internal)? < cost {
        return Err(AppError::BadRequest(crate::msg!(
            "commodities.you-cant-afford-that",
            "you can't afford that"
        )));
    }
    let id = new_id();
    let value = json!({ "kind": "commodity", "commodity": c.id, "units": units.to_string(), "price": price.to_string(), "bought_ms": crate::clock::now_ms() }).to_string();
    data.private_registers(crate::bank::INSTRUMENTS).set(&id, &value).await?;
    crate::bank::catch_up(&state, &data, &root).await.map_err(AppError::Internal)?;
    Ok(axum::Json(json!({ "id": id, "price": price.to_string(), "cost": cost.to_string() })))
}

#[derive(serde::Deserialize)]
pub struct SellRequest {
    /// Whole units, as a decimal string.
    units: String,
}

/// POST `/api/identity/{root}/bank/commodities/{lot}/sell` - sell some or all of a lot's units at
/// today's price on this node, two UTC days after it was bought at the earliest.
pub async fn sell_handler(
    session: crate::auth::Session,
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Path((root, lot_id)): axum::extract::Path<(String, String)>,
    axum::Json(req): axum::Json<SellRequest>,
) -> Result<axum::Json<serde_json::Value>, crate::error::AppError> {
    use crate::error::AppError;
    let Some(units) = units_of(&req.units) else {
        return Err(AppError::BadRequest(crate::msg!(
            "commodities.a-whole-number-of-units-2",
            "sell a whole number of units, one or more"
        )));
    };
    let data = crate::record::store::open(&state, &session.account.id, &root).await?;
    let (lots, sales) = holdings(&data).await.map_err(AppError::Internal)?;
    let Some(lot) = lots.iter().find(|l| l.id == lot_id) else {
        return Err(AppError::NotFound(crate::msg!("commodities.no-such-lot", "no such lot")));
    };
    if crate::clock::now_ms() < sellable_from(lot.bought_ms) {
        return Err(AppError::BadRequest(crate::msg!(
            "commodities.held-two-days",
            "a lot sells two days after it was bought, at the earliest"
        )));
    }
    if held(lot, &sales) < units {
        return Err(AppError::BadRequest(crate::msg!(
            "commodities.not-that-many",
            "that lot doesn't hold that many"
        )));
    }
    let price = quotes(&state)
        .await
        .map_err(AppError::Internal)?
        .into_iter()
        .find(|q| q.commodity.id == lot.commodity)
        .map(|q| q.price)
        .ok_or_else(|| {
            AppError::Internal(anyhow::anyhow!("a lot of a commodity without a quote"))
        })?;
    let id = new_id();
    let value = json!({ "kind": "commodity_sale", "lot": lot.id, "units": units.to_string(), "price": price.to_string(), "sold_ms": crate::clock::now_ms() }).to_string();
    data.private_registers(crate::bank::INSTRUMENTS).set(&id, &value).await?;
    crate::bank::catch_up(&state, &data, &root).await.map_err(AppError::Internal)?;
    Ok(axum::Json(
        json!({ "id": id, "price": price.to_string(), "paid": (&units * &price).to_string() }),
    ))
}

/// Move a lot's purchase back `days` days, for the test rig only (`/test/age-lot`): nobody waits
/// two days for a test.
pub async fn age_lot_for_test(data: &Store, lot_id: &str, days: i64) -> Result<bool> {
    let (lots, _) = holdings(data).await?;
    let Some(lot) = lots.iter().find(|l| l.id == lot_id) else { return Ok(false) };
    let value = json!({ "kind": "commodity", "commodity": lot.commodity, "units": lot.units.to_string(), "price": lot.price.to_string(), "bought_ms": lot.bought_ms - days * DAY_MS }).to_string();
    data.private_registers(crate::bank::INSTRUMENTS).set(&lot.id, &value).await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The walk is the same on every call - it's a function of the commodity and the day, and
    /// nothing else.
    #[test]
    fn the_walk_is_the_same_every_time() {
        for c in &COMMODITIES {
            assert_eq!(deviations(c, 400), deviations(c, 400));
            assert_eq!(
                price(c, 400, deviations(c, 400)[400], 0.0),
                price(c, 400, deviations(c, 400)[400], 0.0)
            );
        }
        assert_ne!(
            deviations(&COMMODITIES[0], 50),
            deviations(&COMMODITIES[1], 50),
            "each its own"
        );
    }

    /// The walk wanders but stays near its target: over years, never more than a few volatilities
    /// away - and the target itself climbs 0.4% a day.
    #[test]
    fn the_walk_reverts_to_a_rising_target() {
        for c in &COMMODITIES {
            let walk = deviations(c, 3_000);
            let worst = walk.iter().fold(0.0f64, |m, x| m.max(x.abs()));
            assert!(worst < c.volatility * 25.0, "{} strayed {worst}", c.id);
            let mean: f64 = walk.iter().sum::<f64>() / walk.len() as f64;
            assert!(mean.abs() < c.volatility * 5.0, "{} drifted off its target {mean}", c.id);
        }
        let c = &COMMODITIES[0];
        let year = price(c, 365, 0.0, 0.0);
        assert_eq!(year, BigInt::from(((50.0 * 100.0) * 1.004f64.powf(365.0)).round() as i64));
    }

    /// The shocks look like a standard normal: mean near zero, spread near one.
    #[test]
    fn the_shocks_are_roughly_standard() {
        let xs: Vec<f64> = (0..20_000).map(|n| shock("hay", n)).collect();
        let mean = xs.iter().sum::<f64>() / xs.len() as f64;
        let var = xs.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / xs.len() as f64;
        assert!(mean.abs() < 0.03, "mean {mean}");
        assert!((var - 1.0).abs() < 0.05, "variance {var}");
    }

    /// The weather: this week against the month, capped, and nothing at all on too little data.
    #[test]
    fn the_weather_is_a_capped_ratio_and_quiet_on_little_data() {
        assert_eq!(nudge_of(&[0; 30]), 0.0);
        assert_eq!(nudge_of(&[1; 5]), 0.0, "too few days");
        let mut busy = vec![1; 23];
        busy.extend([3; 7]);
        let n = nudge_of(&busy); // week rate 3, month rate 44/30: ratio 2.05 - 1, clamped to 1
        assert!((n - CAP).abs() < 1e-9, "{n}");
        let mut dead = vec![2; 23];
        dead.extend([0; 7]);
        assert!((nudge_of(&dead) + CAP).abs() < 1e-9, "a dead week is the cap down");
        assert_eq!(nudge_of(&[2; 30]), 0.0, "a steady month is no weather");
    }

    /// A price never falls below a HorseBuck, however far the walk strays.
    #[test]
    fn a_price_has_a_floor() {
        assert_eq!(price(&COMMODITIES[0], 0, -50.0, -CAP), BigInt::from(100));
    }

    /// The hold: a lot bought any time on day D sells from the first moment of D+2.
    #[test]
    fn a_lot_is_held_two_days() {
        let d = 20_800 * DAY_MS;
        assert_eq!(sellable_from(d), d + 2 * DAY_MS);
        assert_eq!(sellable_from(d + DAY_MS - 1), d + 2 * DAY_MS);
    }
}
