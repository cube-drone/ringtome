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

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(root: &str, pairs: &[(&str, &str)]) -> Facts {
        let mut f = Facts::new();
        f.insert(root.to_string(), pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect());
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
        assert_eq!(effective_interest(&shared(), &facts(A, &[("interest", "medium")])), (true, Some(2)));
        assert_eq!(effective_interest(&shared(), &facts(B, &[("interest_rebroadcasts", "high")])), (true, Some(3)));
        assert_eq!(effective_interest(&suggested(Some("high")), &Facts::new()), (false, Some(3)));
        assert_eq!(effective_interest(&real(), &Facts::new()), (false, None));
        assert_eq!(effective_interest(&shared(), &facts(A, &[])), (false, None), "an unset dial is no opinion");
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
        assert!(visible_at("nonsense", &suggested(None), &Facts::new()), "an unknown stop reads as Explorer");
    }
}
