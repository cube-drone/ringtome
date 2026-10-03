//! Scores (PROJECT_PLAN's *Scores and sort orders*, slice 1, 2026-09-27): what the people a
//! reader drew an edge to said about a post, weighed by the reader's own dials - the "best"
//! orders' key, and, itemised, the post's "history & popularity" readout.
//!
//! **The reader's, computed here.** A score is a reading of labels through one person's trust
//! and follow dials: nothing on the wire changes, nothing merges, and two readers of one post
//! hold two scores. That is also why the breakdown is served only to its reader - it is a
//! readout of their dials.
//!
//! **What counts.** Reaction tags from the picker's glad row (+1) and sour row (-1), each tag
//! counting, so a person may double-like or double-dislike (two tags to a person is the cap,
//! annotations.rs `bounded`). Weighed by the reader's dial on whoever said it: trust ramps
//! linearly (low 0.25 ... max 1), a follow without trust counts less, the reader themself counts
//! fully - and **everyone else counts nothing at all**: minting a labeller is free on this
//! network, so a stranger's influence is suspect whichever way it leans (Denunciations' rule,
//! applied to both signs). The reader's interest in the author scales the sum, mildly.
//!
//! Every number here is a starting value, tuned by feel.

use std::collections::HashMap;

use crate::selectivity::{band_ordinal, Facts};
use crate::AppState;

/// The picker's glad row (js/emoji.js `POLE_ROWS`, tone 'good'), bare of variation selectors.
/// tests/conventions.rs pins these to the client's rows.
pub const GLAD: [&str; 10] = [
    "\u{2764}",
    "\u{1F44D}",
    "\u{1F923}",
    "\u{1FAC2}",
    "\u{1F4AF}",
    "\u{1F434}",
    "\u{1F60D}",
    "\u{1F975}",
    "\u{1F60E}",
    "\u{1F446}",
];
/// ...and its sour row (tone 'bad').
pub const SOUR: [&str; 10] = [
    "\u{1F44E}",
    "\u{1F4A9}",
    "\u{1F644}",
    "\u{1F92E}",
    "\u{1F922}",
    "\u{1F92C}",
    "\u{1FAE0}",
    "\u{1F976}",
    "\u{1F910}",
    "\u{1F9CC}",
];

/// What one followed-but-untrusted person's reaction weighs: counted, but under the lowest trust.
pub const FOLLOW_WEIGHT: f64 = 0.1;

/// A reaction's lean: +1 glad, -1 sour, 0 for any other tag. Matched without the variation
/// selector, so a heart said as a bare U+2764 leans like the palette's.
pub fn tone(value: &str) -> i32 {
    let bare: String = value.chars().filter(|c| *c != '\u{FE0F}').collect();
    if GLAD.contains(&bare.as_str()) {
        1
    } else if SOUR.contains(&bare.as_str()) {
        -1
    } else {
        0
    }
}

/// Why one reaction weighs what it does, in the reader's dials.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Standing {
    /// The reader's own reaction.
    You,
    /// Someone the reader trusts, at this band.
    Trusted(String),
    /// Someone the reader follows (an interest band) without trusting.
    Followed,
    /// Someone the reader has blocked.
    Blocked,
    /// Anyone else: no edge the reader drew.
    Stranger,
}

/// One reaction, weighed.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Part {
    pub annotator: String,
    pub value: String,
    pub tone: i32,
    pub standing: Standing,
    pub weight: f64,
}

/// A post's score for one reader, and every step of it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Reckoning {
    pub parts: Vec<Part>,
    /// The reader's interest band in the author, when they set one.
    pub interest: Option<String>,
    pub interest_factor: f64,
    pub score: f64,
}

impl Reckoning {
    /// The score in thousandths - what an order and a cursor compare, so a page boundary is
    /// an exact integer rather than a float's last digit.
    pub fn milli(&self) -> i64 {
        (self.score * 1000.0).round() as i64
    }
}

/// How much the reader's dial on `annotator` makes their reaction weigh.
fn standing_of(reader: &str, annotator: &str, facts: &Facts) -> (Standing, f64) {
    if annotator == reader {
        return (Standing::You, 1.0);
    }
    let dial = facts.get(annotator);
    let say = |key: &str| dial.and_then(|f| f.get(key)).map(String::as_str);
    if say("blocked") == Some("yes") {
        return (Standing::Blocked, 0.0);
    }
    match band_ordinal(say("trust")) {
        Some(n) if n >= 1 => {
            return (
                Standing::Trusted(say("trust").unwrap_or_default().to_string()),
                n as f64 / 4.0,
            )
        }
        _ => {}
    }
    match band_ordinal(say("interest")) {
        Some(n) if n >= 1 => (Standing::Followed, FOLLOW_WEIGHT),
        _ => (Standing::Stranger, 0.0),
    }
}

/// The reader's interest in the author, as the sum's scale: x0.9 at none up to x1.1 at max,
/// x1 unset - enough to break near-ties, never enough to lift a post nobody reacted to.
fn interest_factor(band: Option<usize>) -> f64 {
    band.map_or(1.0, |n| 0.9 + 0.05 * n as f64)
}

/// One post's score for `reader`, from the labels a reader's read already admitted and bounded
/// (annotations.rs `for_posts`).
pub fn reckon(
    reader: &str,
    author: &str,
    labels: &[crate::annotations::KnownAnnotation],
    facts: &Facts,
) -> Reckoning {
    let parts: Vec<Part> = labels
        .iter()
        .filter(|a| a.key == ringtome_proto::PublicAnnotation::TAG_KEY)
        .filter_map(|a| {
            let tone = tone(&a.value);
            (tone != 0).then(|| {
                let (standing, weight) = standing_of(reader, &a.annotator, facts);
                Part {
                    annotator: a.annotator.clone(),
                    value: a.value.clone(),
                    tone,
                    standing,
                    weight,
                }
            })
        })
        .collect();
    let interest = if author == reader {
        None
    } else {
        facts.get(author).and_then(|f| f.get("interest")).cloned()
    };
    let factor = interest_factor(band_ordinal(interest.as_deref()));
    let sum: f64 = parts.iter().map(|p| p.tone as f64 * p.weight).sum();
    Reckoning { parts, interest, interest_factor: factor, score: sum * factor }
}

/// Every one of these posts' scores for `reader`, from one labels read.
pub async fn scores(
    state: &AppState,
    reader: &str,
    facts: &Facts,
    posts: &[(String, String)],
) -> anyhow::Result<HashMap<(String, String), Reckoning>> {
    let known = crate::annotations::for_posts(state, posts, Some(reader)).await?;
    Ok(posts
        .iter()
        .map(|(a, d)| {
            let labels = known.get(&(a.clone(), d.clone())).map(Vec::as_slice).unwrap_or_default();
            ((a.clone(), d.clone()), reckon(reader, a, labels, facts))
        })
        .collect())
}

/// The "best" windows, as the feed's `window=` names them: how far back a post may be
/// published. A year is the longest (Curtis: no "best ever"), and anything else reads as a year.
pub fn window_ms(window: Option<&str>) -> i64 {
    const DAY: i64 = 24 * 60 * 60 * 1000;
    match window {
        Some("day") => DAY,
        Some("week") => 7 * DAY,
        Some("month") => 30 * DAY,
        _ => 365 * DAY,
    }
}

/// A place in a "best" order: score (thousandths) high first, then newest first, then the
/// document id, highest first - a total order, so a cursor names exactly one boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rank {
    pub milli: i64,
    pub published_ms: i64,
    pub doc_id: String,
}

impl Rank {
    /// Does `self` come before `other` in the order? Every key descending - the journal's time
    /// index walks one direction (node rung 0058).
    pub fn before(&self, other: &Rank) -> bool {
        (self.milli, self.published_ms, &self.doc_id)
            > (other.milli, other.published_ms, &other.doc_id)
    }

    /// The cursor's spelling: `milli:published_ms:doc_id`.
    pub fn token(&self) -> String {
        format!("{}:{}:{}", self.milli, self.published_ms, self.doc_id)
    }

    pub fn parse(token: &str) -> Option<Rank> {
        let mut it = token.splitn(3, ':');
        let milli = it.next()?.parse().ok()?;
        let published_ms = it.next()?.parse().ok()?;
        let doc_id = it.next()?.to_string();
        (!doc_id.is_empty()).then_some(Rank { milli, published_ms, doc_id })
    }
}

// ---------------------------------------------------------------------------------------------
// Stored, and kept incrementally (PROJECT_PLAN's Scores and sort orders, *Shape*). The reckoning
// above is the rule; these tables are its answers per reader, kept as reactions and dials move -
// so a "best" page reads an index instead of re-reckoning the window. Everything here derives
// from the label memo and the reader's dials, and `rebuild` derives it afresh.

/// What a person's reaction weighs, and their posts' interest factor, in thousandths - one row
/// of `score_dials`. The default (a stranger: 0, x1) is not kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Dial {
    pub weight_milli: i64,
    pub factor_milli: i64,
}

const NO_DIAL: Dial = Dial { weight_milli: 0, factor_milli: 1000 };

/// The reader's dials as the stored scores want them: every person with a weight or a factor
/// other than a stranger's, and the reader themself at full weight.
pub fn dials_of(reader: &str, facts: &Facts) -> HashMap<String, Dial> {
    let mut out: HashMap<String, Dial> = HashMap::new();
    for root in facts.keys().filter(|r| r.len() == 64 && r.bytes().all(|b| b.is_ascii_hexdigit())) {
        let (_, weight) = standing_of(reader, root, facts);
        let factor = interest_factor(band_ordinal(
            facts.get(root).and_then(|f| f.get("interest")).map(String::as_str),
        ));
        let dial = Dial {
            weight_milli: (weight * 1000.0).round() as i64,
            factor_milli: (factor * 1000.0).round() as i64,
        };
        if dial != NO_DIAL {
            out.insert(root.clone(), dial);
        }
    }
    out.insert(reader.to_string(), Dial { weight_milli: 1000, factor_milli: 1000 });
    out
}

/// A reaction's tones summed, times the sayer's weight - one `score_parts` row.
fn part_of(
    labels: &[crate::annotations::KnownAnnotation],
    annotator: &str,
    weight_milli: i64,
) -> i64 {
    let tones: i64 = labels
        .iter()
        .filter(|a| a.annotator == annotator && a.key == ringtome_proto::PublicAnnotation::TAG_KEY)
        .map(|a| tone(&a.value) as i64)
        .sum();
    tones * weight_milli
}

/// A post's score from its parts and its author's factor, in thousandths - the reckoning's
/// `milli()`, in integers.
fn total_of(parts_milli: i64, factor_milli: i64) -> i64 {
    ((parts_milli as f64) * (factor_milli as f64) / 1000.0).round() as i64
}

async fn stored_dials(db: &crate::db::Db, reader: &str) -> anyhow::Result<HashMap<String, Dial>> {
    let rows: Vec<(String, i64, i64)> = db
        .fetch_all(
            "SELECT root, weight_milli, factor_milli FROM score_dials WHERE reader_root = ?1",
            (reader,),
        )
        .await
        .map_err(|e| anyhow::anyhow!("reading the stored dials: {e}"))?;
    Ok(rows.into_iter().map(|(r, w, f)| (r, Dial { weight_milli: w, factor_milli: f })).collect())
}

async fn dial_of(db: &crate::db::Db, reader: &str, root: &str) -> anyhow::Result<Dial> {
    let row: Option<(i64, i64)> = db
        .fetch_optional(
            "SELECT weight_milli, factor_milli FROM score_dials WHERE reader_root = ?1 AND root = ?2",
            (reader, root),
        )
        .await
        .map_err(|e| anyhow::anyhow!("reading a stored dial: {e}"))?;
    Ok(row.map_or(NO_DIAL, |(w, f)| Dial { weight_milli: w, factor_milli: f }))
}

/// Set one person's part in one post for one reader, from the post's labels as that reader may
/// see them.
async fn set_part(
    db: &crate::db::Db,
    reader: &str,
    (author, doc): (&str, &str),
    annotator: &str,
    labels: &[crate::annotations::KnownAnnotation],
) -> anyhow::Result<()> {
    let weight = dial_of(db, reader, annotator).await?.weight_milli;
    let part = part_of(labels, annotator, weight);
    let done = if part == 0 {
        db.execute(
            "DELETE FROM score_parts WHERE reader_root = ?1 AND author_root = ?2 AND doc_id = ?3 AND annotator = ?4",
            (reader, author, doc, annotator),
        )
        .await
    } else {
        db.execute(
            "INSERT INTO score_parts (reader_root, author_root, doc_id, annotator, part_milli) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (reader_root, author_root, doc_id, annotator) DO UPDATE SET part_milli = excluded.part_milli",
            (reader, author, doc, annotator, part),
        )
        .await
    };
    done.map_err(|e| anyhow::anyhow!("keeping a score part: {e}"))?;
    Ok(())
}

/// Sum a post's parts into its score for one reader.
async fn set_total(
    db: &crate::db::Db,
    reader: &str,
    (author, doc): (&str, &str),
) -> anyhow::Result<()> {
    let (sum,): (Option<i64>,) = db
        .fetch_one(
            "SELECT SUM(part_milli) FROM score_parts WHERE reader_root = ?1 AND author_root = ?2 AND doc_id = ?3",
            (reader, author, doc),
        )
        .await
        .map_err(|e| anyhow::anyhow!("summing a post's parts: {e}"))?;
    let milli = total_of(sum.unwrap_or(0), dial_of(db, reader, author).await?.factor_milli);
    let done = if milli == 0 {
        db.execute(
            "DELETE FROM post_scores WHERE reader_root = ?1 AND author_root = ?2 AND doc_id = ?3",
            (reader, author, doc),
        )
        .await
    } else {
        db.execute(
            "INSERT INTO post_scores (reader_root, author_root, doc_id, milli) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (reader_root, author_root, doc_id) DO UPDATE SET milli = excluded.milli",
            (reader, author, doc, milli),
        )
        .await
    };
    done.map_err(|e| anyhow::anyhow!("keeping a post's score: {e}"))?;
    Ok(())
}

/// Rescore these posts for one reader, each part of each named person: the labels read once for
/// all of them, as the reader may see them.
async fn rescore(
    state: &AppState,
    reader: &str,
    touched: &[(String, String, String)],
) -> anyhow::Result<()> {
    let mut posts: Vec<(String, String)> =
        touched.iter().map(|(a, d, _)| (a.clone(), d.clone())).collect();
    posts.sort();
    posts.dedup();
    for chunk in posts.chunks(400) {
        let known = crate::annotations::for_posts(state, chunk, Some(reader)).await?;
        for (a, d) in chunk {
            let labels = known.get(&(a.clone(), d.clone())).map(Vec::as_slice).unwrap_or_default();
            for (_, _, x) in touched.iter().filter(|(ta, td, _)| ta == a && td == d) {
                set_part(&state.node_db, reader, (a, d), x, labels).await?;
            }
            set_total(&state.node_db, reader, (a, d)).await?;
        }
    }
    Ok(())
}

/// Labels moved (the memo's fold, a fragment's proofs, sealed labels opening): rescore each
/// `(author, doc, annotator)` for every reader here who weighs that annotator. Readers who weigh
/// nobody involved do no work; a stranger's reaction touches no score at all.
pub async fn labels_moved(state: &AppState, touched: &[(String, String, String)]) {
    if let Err(e) = labels_moved_inner(state, touched).await {
        tracing::debug!(error = ?e, "rescoring moved labels failed");
    }
}

async fn labels_moved_inner(
    state: &AppState,
    touched: &[(String, String, String)],
) -> anyhow::Result<()> {
    let mut by_reader: HashMap<String, Vec<(String, String, String)>> = HashMap::new();
    let mut annotators: Vec<&str> = touched.iter().map(|(_, _, x)| x.as_str()).collect();
    annotators.sort_unstable();
    annotators.dedup();
    for x in annotators {
        let readers: Vec<(String,)> = state
            .node_db
            .fetch_all(
                "SELECT reader_root FROM score_dials WHERE root = ?1 AND weight_milli <> 0",
                (x,),
            )
            .await
            .map_err(|e| anyhow::anyhow!("finding who weighs a labeller: {e}"))?;
        for (reader,) in readers {
            by_reader
                .entry(reader)
                .or_default()
                .extend(touched.iter().filter(|(_, _, t)| t == x).cloned());
        }
    }
    for (reader, t) in by_reader {
        rescore(state, &reader, &t).await?;
    }
    Ok(())
}

/// Bring one reader's stored scores up to their dials as they are now: diff against the dials
/// the scores were kept with, rescore only what moved - every post a re-weighed person reacted
/// to, every post by an author whose interest moved - and keep the new dials. Called before a
/// "best" page is read, so a dial moved on any device, a block included, is in that page.
pub async fn refresh_dials(state: &AppState, reader: &str, facts: &Facts) -> anyhow::Result<()> {
    let db = &state.node_db;
    let now = dials_of(reader, facts);
    let before = stored_dials(db, reader).await?;
    let mut reweighed: Vec<&str> = Vec::new();
    let mut refactored: Vec<&str> = Vec::new();
    for root in now.keys().chain(before.keys()) {
        let (n, b) = (
            now.get(root).copied().unwrap_or(NO_DIAL),
            before.get(root).copied().unwrap_or(NO_DIAL),
        );
        if n.weight_milli != b.weight_milli && !reweighed.contains(&root.as_str()) {
            reweighed.push(root);
        }
        if n.factor_milli != b.factor_milli && !refactored.contains(&root.as_str()) {
            refactored.push(root);
        }
    }
    if reweighed.is_empty() && refactored.is_empty() {
        return Ok(());
    }
    // The dials first: a part is weighed by the stored dial.
    for root in reweighed.iter().chain(refactored.iter()) {
        let done = match now.get(*root) {
            Some(d) => {
                db.execute(
                    "INSERT INTO score_dials (reader_root, root, weight_milli, factor_milli) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT (reader_root, root) DO UPDATE SET weight_milli = excluded.weight_milli, factor_milli = excluded.factor_milli",
                    (reader, *root, d.weight_milli, d.factor_milli),
                )
                .await
            }
            None => db.execute("DELETE FROM score_dials WHERE reader_root = ?1 AND root = ?2", (reader, *root)).await,
        };
        done.map_err(|e| anyhow::anyhow!("keeping a dial: {e}"))?;
    }
    let mut touched: Vec<(String, String, String)> = Vec::new();
    for x in &reweighed {
        // What they reacted to, and what they are still counted in - a part left from a label
        // since gone from the memo goes with the rescore.
        for (a, d) in crate::annotations::targets_of(db, x).await? {
            touched.push((a, d, x.to_string()));
        }
        let kept: Vec<(String, String)> = db
            .fetch_all(
                "SELECT author_root, doc_id FROM score_parts WHERE reader_root = ?1 AND annotator = ?2",
                (reader, *x),
            )
            .await
            .map_err(|e| anyhow::anyhow!("reading a person's parts: {e}"))?;
        touched.extend(kept.into_iter().map(|(a, d)| (a, d, x.to_string())));
    }
    touched.sort();
    touched.dedup();
    rescore(state, reader, &touched).await?;
    for author in &refactored {
        let posts: Vec<(String,)> = db
            .fetch_all(
                "SELECT DISTINCT doc_id FROM score_parts WHERE reader_root = ?1 AND author_root = ?2",
                (reader, *author),
            )
            .await
            .map_err(|e| anyhow::anyhow!("reading an author's scored posts: {e}"))?;
        for (doc,) in posts {
            set_total(db, reader, (author, &doc)).await?;
        }
    }
    Ok(())
}

/// Every stored score for one reader, forgotten and reckoned afresh from the memo and the dials -
/// what the incremental keeping must always equal (the tests hold it to that), and what a change
/// of weights would run.
pub async fn rebuild(state: &AppState, reader: &str, facts: &Facts) -> anyhow::Result<()> {
    for table in ["score_dials", "score_parts", "post_scores"] {
        state
            .node_db
            .execute(&format!("DELETE FROM {table} WHERE reader_root = ?1"), (reader,))
            .await
            .map_err(|e| anyhow::anyhow!("clearing {table}: {e}"))?;
    }
    refresh_dials(state, reader, facts).await
}

/// One reader's stored scores, `(author, doc) -> thousandths`, for these posts - what a "best"
/// order narrowed by a search or the picks sorts by.
pub async fn stored_for(
    db: &crate::db::Db,
    reader: &str,
    posts: &[(String, String)],
) -> anyhow::Result<HashMap<(String, String), i64>> {
    let docs: Vec<String> = posts
        .iter()
        .map(|(_, d)| d)
        .filter(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(|d| format!("'{d}'"))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    if docs.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, String, i64)> = db
        .fetch_all(
            &format!(
                "SELECT author_root, doc_id, milli FROM post_scores WHERE reader_root = ?1 AND doc_id IN ({})",
                docs.join(",")
            ),
            (reader,),
        )
        .await
        .map_err(|e| anyhow::anyhow!("reading stored scores: {e}"))?;
    Ok(rows.into_iter().map(|(a, d, m)| ((a, d), m)).collect())
}

/// Every stored score for one reader - the test door's comparison of kept against rebuilt.
pub async fn all_stored(
    db: &crate::db::Db,
    reader: &str,
) -> anyhow::Result<Vec<(String, String, i64)>> {
    db.fetch_all(
        "SELECT author_root, doc_id, milli FROM post_scores WHERE reader_root = ?1 ORDER BY author_root, doc_id",
        (reader,),
    )
    .await
    .map_err(|e| anyhow::anyhow!("reading stored scores: {e}"))
}

// ---------------------------------------------------------------------------------------------
// Hot (PROJECT_PLAN's Scores and sort orders, slice 2): time plus score, linear - one max-trust
// like is worth an hour of recency (Curtis), a dislike the same hour backwards. A post's hot key is
// `published + score x 1h`: it moves with the score, never with the clock, so a page boundary holds.

/// The recency one thousandth of a score buys: an hour a whole like, so 3.6 s a thousandth.
pub const HOT_MS_PER_MILLI: i64 = 3_600;

/// A post whose score reaches this (two full likes) is "lifted" in hot: given the card's top
/// emphasis - a flag on the row, never the number.
pub const LIFT_MILLI: i64 = 2_000;

/// A post's hot key.
pub fn hot_of(published_ms: i64, milli: i64) -> i64 {
    published_ms.saturating_add(milli.saturating_mul(HOT_MS_PER_MILLI))
}

/// A place in the hot order: the hot key high first, then the document id, highest first - a
/// total order, so a cursor names one boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HotRank {
    pub hot_ms: i64,
    pub doc_id: String,
}

impl HotRank {
    /// Does `self` come before `other`?
    pub fn before(&self, other: &HotRank) -> bool {
        (self.hot_ms, &self.doc_id) > (other.hot_ms, &other.doc_id)
    }

    /// The cursor's spelling: `hot_ms:doc_id`.
    pub fn token(&self) -> String {
        format!("{}:{}", self.hot_ms, self.doc_id)
    }

    pub fn parse(token: &str) -> Option<HotRank> {
        let (ms, doc) = token.split_once(':')?;
        (!doc.is_empty())
            .then(|| Some(HotRank { hot_ms: ms.parse().ok()?, doc_id: doc.to_string() }))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::annotations::KnownAnnotation;

    fn tag(annotator: &str, value: &str) -> KnownAnnotation {
        KnownAnnotation { annotator: annotator.into(), key: "tag".into(), value: value.into() }
    }

    fn facts(rows: &[(&str, &[(&str, &str)])]) -> Facts {
        rows.iter()
            .map(|(root, kv)| {
                (root.to_string(), kv.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect())
            })
            .collect()
    }

    #[test]
    fn tones_read_the_rows_and_ignore_the_variation_selector() {
        assert_eq!(tone("\u{2764}\u{FE0F}"), 1);
        assert_eq!(tone("\u{2764}"), 1);
        assert_eq!(tone("\u{1F4A9}"), -1);
        assert_eq!(tone("\u{1F914}"), 0, "the plain row leans nowhere");
        assert_eq!(tone("beef"), 0);
    }

    /// Curtis's numbers: a linear trust ramp, follows at a tenth, the reader at one, strangers
    /// and the blocked at nothing - double-likes counting twice - scaled by interest.
    #[test]
    fn the_reckoning_weighs_each_reaction_by_the_readers_dial_on_its_sayer() {
        let f = facts(&[
            ("max", &[("trust", "max")]),
            ("low", &[("trust", "low")]),
            ("fol", &[("interest", "medium")]),
            ("nop", &[("trust", "none")]),
            ("blk", &[("trust", "max"), ("blocked", "yes")]),
            ("author", &[("interest", "max")]),
        ]);
        let labels = [
            tag("max", "\u{1F44D}"),
            tag("max", "\u{1F4AF}"),
            tag("low", "\u{1F4A9}"),
            tag("fol", "\u{1F44D}"),
            tag("nop", "\u{1F44D}"),
            tag("blk", "\u{1F44D}"),
            tag("stranger", "\u{1F44D}"),
            tag("me", "\u{2764}\u{FE0F}"),
            tag("max", "beef"),
        ];
        let r = reckon("me", "author", &labels, &f);
        let weights: Vec<(&str, f64)> =
            r.parts.iter().map(|p| (p.annotator.as_str(), p.weight)).collect();
        assert_eq!(
            weights,
            [
                ("max", 1.0),
                ("max", 1.0),
                ("low", 0.25),
                ("fol", 0.1),
                ("nop", 0.0),
                ("blk", 0.0),
                ("stranger", 0.0),
                ("me", 1.0)
            ],
            "one part per reaction, words left out"
        );
        assert_eq!(
            r.parts[4].standing,
            Standing::Stranger,
            "trust 'none' and no follow is no edge"
        );
        // (1 + 1 - 0.25 + 0.1 + 1) x 1.1
        assert!((r.score - 2.85 * 1.1).abs() < 1e-9, "score {}", r.score);
        assert_eq!(r.milli(), 3135);
        assert_eq!(r.interest.as_deref(), Some("max"));
    }

    /// The stored keeping's integers against the reckoning's floats: dials in thousandths, a part
    /// per person, the total with its author's factor - the same thousandths as `milli()`, so the
    /// order the feed reads and the reckoning the dossier shows agree.
    #[test]
    fn stored_thousandths_agree_with_the_reckoning() {
        let hex = |c: char| c.to_string().repeat(64);
        let (me, max, low, fol, blk, author) =
            (hex('e'), hex('a'), hex('b'), hex('c'), hex('d'), hex('f'));
        let f = facts(&[
            (max.as_str(), &[("trust", "max")]),
            (low.as_str(), &[("trust", "low")]),
            (fol.as_str(), &[("interest", "medium")]),
            (blk.as_str(), &[("trust", "max"), ("blocked", "yes")]),
            (author.as_str(), &[("interest", "high")]),
        ]);
        let dials = dials_of(&me, &f);
        assert_eq!(dials[&max], Dial { weight_milli: 1000, factor_milli: 1000 });
        assert_eq!(dials[&low].weight_milli, 250);
        assert_eq!(dials[&fol], Dial { weight_milli: 100, factor_milli: 1000 });
        assert!(!dials.contains_key(&blk), "blocked, and no other dial: a stranger's, not kept");
        assert_eq!(
            dials[&author],
            Dial { weight_milli: 100, factor_milli: 1050 },
            "an author followed: a follow's weight, and a factor"
        );
        assert_eq!(dials[&me].weight_milli, 1000, "the reader, at full weight");
        let labels = [
            tag(&max, "\u{1F44D}"),
            tag(&max, "\u{1F4AF}"),
            tag(&low, "\u{1F4A9}"),
            tag(&fol, "\u{1F44D}"),
            tag(&blk, "\u{1F44D}"),
            tag(&me, "\u{1F434}"),
        ];
        let parts: i64 = [&max, &low, &fol, &blk, &me]
            .iter()
            .map(|x| part_of(&labels, x, dials.get(*x).map_or(0, |d| d.weight_milli)))
            .sum();
        let stored = total_of(parts, dials[&author].factor_milli);
        assert_eq!(stored, reckon(&me, &author, &labels, &f).milli());
        assert_eq!(
            stored, 2993,
            "(2 - 0.25 + 0.1 + 1) x 1.05 = 2.9925, a half-thousandth rounded away from zero"
        );
    }

    #[test]
    fn hot_is_time_plus_an_hour_a_like_and_its_cursor_round_trips() {
        assert_eq!(hot_of(10_000_000, 1000), 10_000_000 + 3_600_000, "a whole like is an hour");
        assert_eq!(
            hot_of(10_000_000, -500),
            10_000_000 - 1_800_000,
            "half a dislike, half an hour back"
        );
        let a = HotRank { hot_ms: 9, doc_id: "a".into() };
        let b = HotRank { hot_ms: 5, doc_id: "b".into() };
        let c = HotRank { hot_ms: 5, doc_id: "a".into() };
        assert!(a.before(&b) && b.before(&c) && !c.before(&b));
        assert_eq!(HotRank::parse(&c.token()), Some(c));
        assert_eq!(HotRank::parse("-40:ab").map(|r| r.hot_ms), Some(-40));
        assert_eq!(HotRank::parse("nonsense"), None);
    }

    #[test]
    fn nobody_reacted_is_zero_whatever_the_interest() {
        let f = facts(&[("author", &[("interest", "max")])]);
        assert_eq!(reckon("me", "author", &[], &f).score, 0.0);
    }

    #[test]
    fn the_order_is_total_and_the_cursor_round_trips() {
        let a = Rank { milli: 2000, published_ms: 5, doc_id: "a".into() };
        let b = Rank { milli: 1000, published_ms: 9, doc_id: "a".into() };
        let c = Rank { milli: 1000, published_ms: 7, doc_id: "a".into() };
        let d = Rank { milli: 1000, published_ms: 7, doc_id: "b".into() };
        assert!(
            a.before(&b) && b.before(&c) && d.before(&c),
            "score, then newest, then the higher id"
        );
        assert!(!c.before(&d) && !c.before(&c));
        assert_eq!(Rank::parse(&c.token()), Some(c));
        assert_eq!(Rank::parse("-250:12:abcd").map(|r| r.milli), Some(-250));
        assert_eq!(Rank::parse("nonsense"), None);
    }
}
