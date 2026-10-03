//! The feed's selectivity dial, on the node (2026-09-08): the same six stops and the same
//! rule as `js/pure/selectivity.js`, so the facets and the search can count and narrow
//! exactly what the dial lets the feed show (Curtis: turning the dial down shrank the
//! feed, and the bucket and tag lists kept counting the whole journal). The browser keeps
//! its copy for the page it has in hand; this one answers over the whole journal. The two
//! must agree, so the tests below are the pure suite's cases, transcribed.

use std::collections::BTreeMap;

/// The five bands, a rung each; anything else is no opinion.
const BANDS: [&str; 5] = ["none", "low", "medium", "high", "max"];

pub fn band_ordinal(value: Option<&str>) -> Option<usize> {
    value.and_then(|v| BANDS.iter().position(|b| *b == v))
}

/// What the rule looks at in one row: who said it, who passed it along, and the path a
/// suggestion came by with its strength.
pub struct RowView<'a> {
    pub author: &'a str,
    pub via: Option<&'a str>,
    pub suggested_via: Option<&'a str>,
    pub suggested_level: Option<&'a str>,
}

pub type Facts = BTreeMap<String, BTreeMap<String, String>>;

/// Precedence: the author dial leads, the sharer dial follows, the path score trails, the
/// floor is no opinion. `(explicit, band ordinal)`.
fn effective_interest(row: &RowView<'_>, facts: &Facts) -> (bool, Option<usize>) {
    let dial = |root: Option<&str>, key: &str| -> Option<usize> {
        let root = root?;
        band_ordinal(facts.get(root).and_then(|f| f.get(key)).map(String::as_str))
    };
    if let Some(b) = dial(Some(row.author), "interest") {
        return (true, Some(b));
    }
    if let Some(b) = dial(row.via, "interest_rebroadcasts") {
        return (true, Some(b));
    }
    if row.suggested_via.is_some() {
        return (false, band_ordinal(row.suggested_level));
    }
    (false, None)
}

/// Does the dial at `stop` show this row? An unknown stop reads as Explorer.
pub fn visible_at(stop: &str, row: &RowView<'_>, facts: &Facts) -> bool {
    let (explicit, ord) = effective_interest(row, facts);
    match stop {
        "high" => explicit && ord.is_some_and(|o| o >= 3),
        "medium" => explicit && ord.is_some_and(|o| o >= 2),
        "interest" => row.suggested_via.is_none(),
        "speculative" => row.suggested_via.is_none() || ord.is_some_and(|o| o >= 3),
        "highly-speculative" => row.suggested_via.is_none() || ord.is_some_and(|o| o >= 2),
        _ => true,
    }
}

/// The same rule, as SQL over one `feed_journal` row (2026-09-27, PROJECT_PLAN's Scores and sort
/// orders, *Shape*): the journal's readers filter in SQL on an index rather than take the newest
/// rows and ask [`visible_at`] of each. `None` when the stop shows everything.
///
/// Membership, not a join: the reader's dials live in their encrypted private store, so the node
/// hands them to the query as literal lists - `author_root IN (...)`, which the engine answers
/// from an index it builds over the list - rather than a table of dials joined row by row, which
/// is the shape that slows down exactly for the reader with ten thousand of them. The precedence
/// is [`effective_interest`]'s: an author dial decides; without one, a sharer's rebroadcast dial;
/// without either, a suggestion's path level (`levels`: author -> band word, the reader's
/// `speculative::levels_for`). The reader's own rows are the caller's to let through.
/// fanout.rs's tests hold it to [`visible_at`], case by case.
pub fn stop_rule(
    stop: &str,
    facts: &Facts,
    levels: &std::collections::HashMap<String, String>,
) -> Option<StopRule> {
    let dialled = |key: &str, min: usize| -> Vec<String> {
        facts
            .iter()
            .filter(|(root, f)| {
                is_root_hex(root)
                    && band_ordinal(f.get(key).map(String::as_str)).is_some_and(|o| o >= min)
            })
            .map(|(root, _)| root.clone())
            .collect()
    };
    let levelled = |min: usize| -> Vec<String> {
        levels
            .iter()
            .filter(|(root, band)| {
                is_root_hex(root) && band_ordinal(Some(band.as_str())).is_some_and(|o| o >= min)
            })
            .map(|(root, _)| root.clone())
            .collect()
    };
    let (kind, min) = match stop {
        "high" => (StopKind::Explicit, 3),
        "medium" => (StopKind::Explicit, 2),
        "interest" => (StopKind::NoSuggestions, 0),
        "speculative" => (StopKind::Path, 3),
        "highly-speculative" => (StopKind::Path, 2),
        _ => return None,
    };
    Some(StopRule {
        kind,
        // Any author dial at all is an opinion - "none" included - and the sharer's is then
        // never asked.
        author_dialled: dialled("interest", 0),
        author_at: dialled("interest", min),
        sharer_at: dialled("interest_rebroadcasts", min),
        path_at: levelled(min),
    })
}

enum StopKind {
    /// An explicit dial at height: the author's, else the sharer's.
    Explicit,
    /// No suggested rows.
    NoSuggestions,
    /// Real rows, and suggestions whose effective level is at height.
    Path,
}

/// The dial's rule with the reader's dials in it, ready to render against a journal row.
pub struct StopRule {
    kind: StopKind,
    author_dialled: Vec<String>,
    author_at: Vec<String>,
    sharer_at: Vec<String>,
    path_at: Vec<String>,
}

impl StopRule {
    /// The predicate, over a journal row whose columns are spelled `{t}author_root` - `t` empty,
    /// or a table's alias and a dot.
    pub fn sql(&self, t: &str) -> String {
        let author = format!("{t}author_root");
        let no_author_dial = not_in(&author, &self.author_dialled);
        match self.kind {
            StopKind::Explicit => format!(
                "({} OR ({no_author_dial} AND {}))",
                is_in(&author, &self.author_at),
                is_in(&format!("{t}via_root"), &self.sharer_at)
            ),
            StopKind::NoSuggestions => format!("{t}suggested_via IS NULL"),
            StopKind::Path => format!(
                "({t}suggested_via IS NULL OR {} OR ({no_author_dial} AND {}))",
                is_in(&author, &self.author_at),
                is_in(&author, &self.path_at)
            ),
        }
    }
}

/// A root as the journal spells it - 64 hex characters - and so safe to write into SQL.
fn is_root_hex(root: &str) -> bool {
    root.len() == 64 && root.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_in(column: &str, roots: &[String]) -> String {
    if roots.is_empty() {
        return "0".to_string();
    }
    format!(
        "{column} IN ({})",
        roots.iter().map(|r| format!("'{r}'")).collect::<Vec<_>>().join(",")
    )
}

fn not_in(column: &str, roots: &[String]) -> String {
    if roots.is_empty() {
        return "1".to_string();
    }
    format!(
        "{column} NOT IN ({})",
        roots.iter().map(|r| format!("'{r}'")).collect::<Vec<_>>().join(",")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(root: &str, pairs: &[(&str, &str)]) -> Facts {
        let mut f = Facts::new();
        f.insert(
            root.to_string(),
            pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        );
        f
    }
    const A: &str = "a";
    const B: &str = "b";
    const C: &str = "c";
    fn real() -> RowView<'static> {
        RowView { author: A, via: None, suggested_via: None, suggested_level: None }
    }
    fn shared() -> RowView<'static> {
        RowView { author: A, via: Some(B), suggested_via: None, suggested_level: None }
    }
    fn suggested(level: Option<&'static str>) -> RowView<'static> {
        RowView { author: A, via: None, suggested_via: Some(C), suggested_level: level }
    }

    /// The pure suite's cases (integration/test/pure/selectivity.cjs), transcribed.
    #[test]
    fn precedence_author_then_sharer_then_path() {
        assert_eq!(
            effective_interest(&shared(), &facts(A, &[("interest", "medium")])),
            (true, Some(2))
        );
        assert_eq!(
            effective_interest(&shared(), &facts(B, &[("interest_rebroadcasts", "high")])),
            (true, Some(3))
        );
        assert_eq!(effective_interest(&suggested(Some("high")), &Facts::new()), (false, Some(3)));
        assert_eq!(effective_interest(&real(), &Facts::new()), (false, None));
        assert_eq!(
            effective_interest(&shared(), &facts(A, &[])),
            (false, None),
            "an unset dial is no opinion"
        );
    }

    #[test]
    fn the_strict_stops_want_explicit_dials_at_height() {
        assert!(visible_at("high", &real(), &facts(A, &[("interest", "high")])));
        assert!(!visible_at("high", &real(), &facts(A, &[("interest", "medium")])));
        assert!(visible_at("medium", &real(), &facts(A, &[("interest", "medium")])));
        assert!(!visible_at("medium", &real(), &Facts::new()));
        assert!(visible_at("high", &shared(), &facts(B, &[("interest_rebroadcasts", "high")])));
    }

    #[test]
    fn interest_only_and_the_speculative_gradient() {
        assert!(visible_at("interest", &real(), &Facts::new()));
        assert!(visible_at("interest", &shared(), &Facts::new()));
        assert!(!visible_at("interest", &suggested(Some("high")), &Facts::new()));
        assert!(visible_at("speculative", &suggested(Some("high")), &Facts::new()));
        assert!(!visible_at("speculative", &suggested(Some("medium")), &Facts::new()));
        assert!(visible_at("highly-speculative", &suggested(Some("medium")), &Facts::new()));
        assert!(!visible_at("highly-speculative", &suggested(Some("low")), &Facts::new()));
        assert!(visible_at("explorer", &suggested(Some("low")), &Facts::new()));
        assert!(
            visible_at("nonsense", &suggested(None), &Facts::new()),
            "an unknown stop reads as Explorer"
        );
    }
}
