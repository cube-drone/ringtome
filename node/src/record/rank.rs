//! Fractional ranks: the position values taxonomy members carry (PROJECT_PLAN, Taxonomies).
//!
//! A rank is a base-36 string (`0-9a-z`) compared lexicographically - SQL and Rust agree on
//! byte order, so `ORDER BY value` in a view and `sort_by` in a handle produce the same list.
//! `between` yields a string between its neighbors, so any insertion needs one write and moves
//! never renumber the rest of the list. This is a **client-of-the-store convention, never
//! protocol**: on the wire a rank is an opaque set-element value - which also means values
//! arriving by sync are *input*, not our output. The hard requirement on arbitrary input is
//! termination, never correctness of order: every rank is normalized to digit space at entry
//! (unknown bytes clamp monotonically onto the alphabet), so junk from a hostile member device
//! degrades to a misplaced-but-stable list entry, not a hung fold. Scrambling your own list's
//! order is self-harm, not an attack surface; hanging a reader would be.
//!
//! Two named properties, honestly bounded:
//!
//! - **Concurrent same-spot inserts may mint the same rank.** Two devices both appending after
//!   `"i"` both derive `"j"`; the reader breaks the tie deterministically on the element string
//!   (adjacent, arbitrary relative order - the accepted cost; PROJECT_PLAN, Taxonomies). The
//!   degenerate intervals real syncs can build (equal, inverted, or gapless neighbors like
//!   `"a" < x < "a0"`, which no base-36 string satisfies) degrade the same way: a duplicate
//!   rank, never an error and never a hang.
//! - **Ranks grow under repeated same-spot insertion** - ~one digit per 18 appends, ~one per
//!   middle-insert hit. Rebalancing - rewriting a list's ranks as a burst of ordinary LWW
//!   writes - is the named escape; deferred until a real list bloats (REFACTOR.md candidate,
//!   not machinery ahead of need).

/// The digit alphabet. Base 36 keeps ranks short and human-scannable in `inspect` output.
const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
const BASE: u32 = 36;

/// A byte's digit value, total over all inputs: alphabet bytes map exactly, anything else
/// clamps to the nearest digit at-or-below (monotone, so normalization never *reverses* two
/// inputs' order - it can only collapse them).
fn digit_value(b: u8) -> u32 {
    match DIGITS.binary_search(&b) {
        Ok(i) => i as u32,
        Err(0) => 0,
        Err(i) => (i - 1) as u32,
    }
}

/// A rank as the walk sees it: digit values, with `hi`-side trailing minimum-digits stripped
/// (`"a0"` bounds exactly like `"a"`, and the strip is what makes the walk provably terminate).
fn digits(rank: &str) -> Vec<u32> {
    rank.bytes().map(digit_value).collect()
}

fn emit(digits: &[u32]) -> String {
    digits.iter().map(|&d| DIGITS[d as usize] as char).collect()
}

/// Digit at position `i` under the expansions that make midpointing work: a rank is
/// conceptually followed by infinite `0`s (the minimum digit), and an absent upper bound reads
/// as `BASE` (one past the maximum digit) at every position.
fn digit_at(rank: Option<&[u32]>, i: usize, absent: u32) -> u32 {
    match rank {
        None => absent,
        Some(r) => r.get(i).copied().unwrap_or(0),
    }
}

/// A rank between `lo` and `hi` (`None` = unbounded on that side): strictly between whenever
/// such a string exists, a deliberate duplicate of the boundary when one doesn't (see the
/// module doc).
pub fn between(lo: Option<&str>, hi: Option<&str>) -> String {
    let lo = lo.map(digits);
    let hi = hi.map(|h| {
        let mut d = digits(h);
        while d.last() == Some(&0) {
            d.pop();
        }
        d
    });
    if let Some(h) = &hi {
        // The interval below "0" (or "", after stripping) contains no representable string.
        if h.is_empty() {
            return "0".to_string();
        }
        if lo.as_ref().is_some_and(|l| l >= h) {
            return emit(lo.as_ref().expect("just tested"));
        }
    }
    let (lo, hi) = (lo.as_deref(), hi.as_deref());
    let mut out = Vec::new();
    let mut i = 0;
    // Phase 1: walk while the bounds pin each digit (hi's digit is lo's or one above it); exit
    // at the first position with room in between. Terminates: hi ends in a non-minimum digit
    // (stripped above), so it cannot be exhausted while still pinning - that would make it a
    // zero-padded prefix of lo, i.e. lo >= hi in digit space, excluded by the guard.
    loop {
        let da = digit_at(lo, i, 0);
        let db = digit_at(hi, i, BASE);
        let mid = (da + db) / 2;
        if mid > da {
            out.push(mid);
            break;
        }
        out.push(da);
        i += 1;
        if db == da + 1 {
            // The prefix pushed so far is already strictly below `hi`; from here only lo's
            // (finite) tail bounds us, so the ceiling opens to BASE and a midpoint lands.
            loop {
                let da = digit_at(lo, i, 0);
                let mid = (da + BASE) / 2;
                if mid > da {
                    out.push(mid);
                    return emit(&out);
                }
                out.push(da);
                i += 1;
            }
        }
    }
    emit(&out)
}

/// The rank for appending after `last` (`None` = empty list). Not a midpoint: appending is the
/// common case (every bulk import is one long append), so this walks the alphabet - bump the
/// final digit while it has headroom, extend with the mid-digit when it doesn't - and a
/// thousand-member list costs ~60 rank digits instead of ~170.
pub fn after(last: Option<&str>) -> String {
    let Some(last) = last else {
        return between(None, None);
    };
    let mut d = digits(last);
    match d.last().copied() {
        Some(v) if v < BASE - 1 => {
            let end = d.len() - 1;
            d[end] = v + 1;
        }
        _ => d.push(BASE / 2),
    }
    emit(&d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_rank_is_midalphabet() {
        assert_eq!(between(None, None), "i");
    }

    #[test]
    fn between_is_strictly_between() {
        let cases: &[(Option<&str>, Option<&str>)] = &[
            (None, Some("i")),
            (Some("i"), None),
            (Some("a"), Some("b")),
            (Some("a"), Some("a1")),
            (Some("az"), Some("b")),
            (Some("azz"), Some("b")),
            (Some("i"), Some("j")),
            (Some("0z"), Some("1")),
            (Some("abc"), Some("abd")),
            (Some("ab"), Some("ab1")),
            (Some("ab"), Some("ab001")),
        ];
        for &(lo, hi) in cases {
            let mid = between(lo, hi);
            if let Some(lo) = lo {
                assert!(mid.as_str() > lo, "{mid:?} > {lo:?}");
            }
            if let Some(hi) = hi {
                assert!(mid.as_str() < hi, "{mid:?} < {hi:?}");
            }
        }
    }

    #[test]
    fn degenerate_intervals_duplicate_instead_of_hanging() {
        // Equal bounds, inverted bounds, and the gapless interval ("a" < x < "a0" has no
        // solution). All must return promptly with a boundary duplicate for the reader's
        // element tiebreak - the hang here was a real bug caught in review, so these are
        // regression tests as much as contract statements.
        assert_eq!(between(Some("i"), Some("i")), "i");
        assert_eq!(between(Some("j"), Some("i")), "j");
        assert_eq!(between(Some("a"), Some("a0")), "a");
        assert_eq!(between(Some("a"), Some("a000")), "a");
        assert_eq!(between(None, Some("0")), "0");
        assert_eq!(between(None, Some("000")), "0");
    }

    #[test]
    fn hostile_bytes_terminate_and_stay_in_alphabet() {
        // Ranks from the wire can be any string; unknown bytes clamp onto the alphabet. The
        // both-bounds-unknown case ("!" vs "~") was a second review-caught hang: raw bytes
        // that collapse to the same digit pinned phase 1 forever before normalization.
        for (lo, hi) in [
            (Some("!"), Some("~")),
            (Some("~"), None),
            (None, Some("!")),
            (Some("a!b"), Some("a~c")),
            (Some("ЖЖ"), Some("ЖЖЖ")),
        ] {
            let out = between(lo, hi);
            assert!(!out.is_empty());
            assert!(
                out.bytes().all(|b| DIGITS.contains(&b)),
                "output stays in-alphabet: {out:?}"
            );
        }
        assert!(after(Some("~")).bytes().all(|b| DIGITS.contains(&b)));
        assert!(after(Some("")).as_str() > "");
    }

    #[test]
    fn repeated_head_insertion_stays_ordered_with_bounded_growth() {
        let mut front = between(None, None);
        for _ in 0..100 {
            let newer = between(None, Some(&front));
            assert!(newer < front);
            front = newer;
        }
        assert!(front.len() <= 30, "rank bloat is bounded: {}", front.len());
    }

    #[test]
    fn interleaved_inserts_converge_to_a_total_order() {
        // Build a list by repeatedly inserting into the middle; every rank stays unique and
        // sorted order equals insertion-intent order.
        let mut ranks = vec![between(None, None)];
        for _ in 0..50 {
            let at = ranks.len() / 2;
            let lo = at.checked_sub(1).map(|i| ranks[i].clone());
            let hi = ranks.get(at).cloned();
            let mid = between(lo.as_deref(), hi.as_deref());
            ranks.insert(at, mid);
        }
        let mut sorted = ranks.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(
            ranks, sorted,
            "insertion order IS sort order, no duplicates"
        );
    }

    #[test]
    fn appends_walk_the_alphabet_without_ballooning() {
        let mut last = after(None);
        for _ in 0..1000 {
            let next = after(Some(&last));
            assert!(next > last, "{next:?} > {last:?}");
            last = next;
        }
        assert!(
            last.len() <= 62,
            "1000 appends stay compact: {}",
            last.len()
        );
    }

    #[test]
    fn insert_between_appended_neighbors_works() {
        // The mixed case real lists hit: append a run, then insert into its middle.
        let a = after(None);
        let b = after(Some(&a));
        let c = after(Some(&b));
        let mid = between(Some(&a), Some(&b));
        assert!(a < mid && mid < b && b < c);
    }
}
