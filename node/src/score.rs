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
    "\u{2764}", "\u{1F44D}", "\u{1F923}", "\u{1FAC2}", "\u{1F4AF}", "\u{1F434}", "\u{1F60D}", "\u{1F975}", "\u{1F60E}", "\u{1F446}",
];
/// ...and its sour row (tone 'bad').
pub const SOUR: [&str; 10] = [
    "\u{1F44E}", "\u{1F4A9}", "\u{1F644}", "\u{1F92E}", "\u{1F922}", "\u{1F92C}", "\u{1FAE0}", "\u{1F976}", "\u{1F910}", "\u{1F9CC}",
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
        Some(n) if n >= 1 => return (Standing::Trusted(say("trust").unwrap_or_default().to_string()), n as f64 / 4.0),
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
pub fn reckon(reader: &str, author: &str, labels: &[crate::annotations::KnownAnnotation], facts: &Facts) -> Reckoning {
    let parts: Vec<Part> = labels
        .iter()
        .filter(|a| a.key == ringtome_proto::PublicAnnotation::TAG_KEY)
        .filter_map(|a| {
            let tone = tone(&a.value);
            (tone != 0).then(|| {
                let (standing, weight) = standing_of(reader, &a.annotator, facts);
                Part { annotator: a.annotator.clone(), value: a.value.clone(), tone, standing, weight }
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
/// published. `None` for ever (or anything unknown).
pub fn window_ms(window: Option<&str>) -> Option<i64> {
    const DAY: i64 = 24 * 60 * 60 * 1000;
    match window {
        Some("day") => Some(DAY),
        Some("week") => Some(7 * DAY),
        Some("month") => Some(30 * DAY),
        Some("year") => Some(365 * DAY),
        _ => None,
    }
}

/// A place in a "best" order: score (thousandths) high first, then newest first, then the
/// document id - a total order, so a cursor names exactly one boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rank {
    pub milli: i64,
    pub published_ms: i64,
    pub doc_id: String,
}

impl Rank {
    /// Does `self` come before `other` in the order?
    pub fn before(&self, other: &Rank) -> bool {
        (std::cmp::Reverse(self.milli), std::cmp::Reverse(self.published_ms), &self.doc_id)
            < (std::cmp::Reverse(other.milli), std::cmp::Reverse(other.published_ms), &other.doc_id)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::annotations::KnownAnnotation;

    fn tag(annotator: &str, value: &str) -> KnownAnnotation {
        KnownAnnotation { annotator: annotator.into(), key: "tag".into(), value: value.into() }
    }

    fn facts(rows: &[(&str, &[(&str, &str)])]) -> Facts {
        rows.iter()
            .map(|(root, kv)| (root.to_string(), kv.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()))
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
        let weights: Vec<(&str, f64)> = r.parts.iter().map(|p| (p.annotator.as_str(), p.weight)).collect();
        assert_eq!(
            weights,
            [("max", 1.0), ("max", 1.0), ("low", 0.25), ("fol", 0.1), ("nop", 0.0), ("blk", 0.0), ("stranger", 0.0), ("me", 1.0)],
            "one part per reaction, words left out"
        );
        assert_eq!(r.parts[4].standing, Standing::Stranger, "trust 'none' and no follow is no edge");
        // (1 + 1 - 0.25 + 0.1 + 1) x 1.1
        assert!((r.score - 2.85 * 1.1).abs() < 1e-9, "score {}", r.score);
        assert_eq!(r.milli(), 3135);
        assert_eq!(r.interest.as_deref(), Some("max"));
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
        assert!(a.before(&b) && b.before(&c) && c.before(&d), "score, then newest, then id");
        assert!(!d.before(&c) && !c.before(&c));
        assert_eq!(Rank::parse(&c.token()), Some(c));
        assert_eq!(Rank::parse("-250:12:abcd").map(|r| r.milli), Some(-250));
        assert_eq!(Rank::parse("nonsense"), None);
    }
}
