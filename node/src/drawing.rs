//! A drawing's body, as the node reads and merges it (DRAWING.md, "The model").
//!
//! A drawing is a versioned document whose body is JSON: its standing strokes and the ids of every
//! stroke undone. Two versions merge by putting both sets of strokes together, minus both sets of
//! undone, in the one order `(t, id)` - so there is never a conflict to present, and the merge runs
//! here at read time, in `record::documents::resolve`, exactly where text's three-way merge runs.
//! The editor opens the merged body and its next save lists every head as a parent, healing the
//! fork through an ordinary write.
//!
//! The browser WRITES bodies (`node/js/pure/drawing.js`, `writeBody`) and this module MERGES them,
//! so the two agree on the canonical form byte for byte - the same drawing is the same bytes - and
//! `spec/test-vectors/drawing-v1.json` holds both to it. The shape a body may take is deliberately
//! narrow (ids of 16 hex digits, colours of lowercase `#rrggbb`, whole numbers everywhere) so two
//! languages cannot disagree about escaping or number formatting. Every rule here mirrors a rule
//! there; change one, change both, and regenerate the vectors.

use std::collections::HashSet;

use serde::Serialize;
use serde_json::Value;

pub const BODY_VERSION: i64 = 1;
/// 800 because that is the most the node keeps of any picture (media/image.rs, `MAIN_BOUND`).
pub const CANVAS_WIDTH: i64 = 800;
pub const CANVAS_HEIGHT: i64 = 600;
pub const BACKGROUND: &str = "#fffefb";
/// The largest brush or eraser, in canvas units.
pub const MAX_SIZE: i64 = 200;
/// JavaScript's `Number.MAX_SAFE_INTEGER`: the largest whole number the browser writes exactly.
const MAX_SAFE: i64 = (1 << 53) - 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Stroke {
    pub id: String,
    pub t: i64,
    pub tool: &'static str,
    /// A brush's colour; an eraser has none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub size: i64,
    /// Delta-coded: the first point absolute, every later one the step from the one before.
    pub points: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Body {
    pub v: i64,
    pub width: i64,
    pub height: i64,
    pub background: String,
    pub strokes: Vec<Stroke>,
    pub undone: Vec<String>,
}

// ---------------------------------------------------------------------------------------------
// Reading

fn blank() -> Body {
    Body {
        v: BODY_VERSION,
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        background: BACKGROUND.to_string(),
        strokes: Vec::new(),
        undone: Vec::new(),
    }
}

/// A whole number the browser could have written exactly (`Number.isSafeInteger`): an integer, or
/// a float with no fraction (`5.0` parses as the integer 5 in JavaScript), within 2^53.
fn safe_int(v: &Value) -> Option<i64> {
    if let Some(i) = v.as_i64() {
        return (i.abs() <= MAX_SAFE).then_some(i);
    }
    let f = v.as_f64()?;
    (f.fract() == 0.0 && f.abs() <= MAX_SAFE as f64).then_some(f as i64)
}

fn is_lower_hex(b: u8) -> bool {
    b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
}

fn is_hex16(s: &str) -> bool {
    s.len() == 16 && s.bytes().all(is_lower_hex)
}

fn is_colour(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7 && b[0] == b'#' && b[1..].iter().copied().all(is_lower_hex)
}

fn as_stroke(v: &Value) -> Option<Stroke> {
    let o = v.as_object()?;
    let id = o.get("id")?.as_str().filter(|s| is_hex16(s))?.to_string();
    let t = o.get("t").and_then(safe_int).filter(|t| *t >= 0)?;
    let tool = match o.get("tool")?.as_str()? {
        "brush" => "brush",
        "eraser" => "eraser",
        _ => return None,
    };
    let size = o.get("size").and_then(safe_int).filter(|s| (1..=MAX_SIZE).contains(s))?;
    let points = o
        .get("points")?
        .as_array()?
        .iter()
        .map(safe_int)
        .collect::<Option<Vec<i64>>>()
        .filter(|p| p.len() >= 2)?;
    let color = if tool == "eraser" {
        None
    } else {
        Some(o.get("color")?.as_str().filter(|c| is_colour(c))?.to_string())
    };
    Some(Stroke { id, t, tool, color, size, points })
}

fn order(a: &Stroke, b: &Stroke) -> std::cmp::Ordering {
    a.t.cmp(&b.t).then_with(|| a.id.cmp(&b.id))
}

/// A body as stored, checked and tidied exactly as the browser's `readBody` does. Never fails: an
/// unreadable body is a blank drawing.
pub fn read(bytes: &[u8]) -> Body {
    let Ok(parsed) = serde_json::from_slice::<Value>(bytes) else { return blank() };
    let empty = serde_json::Map::new();
    let o = match &parsed {
        Value::Object(o) => o,
        // An array is an object to JavaScript's `typeof`, with none of these fields.
        Value::Array(_) => &empty,
        _ => return blank(),
    };
    let mut undone: Vec<String> = Vec::new();
    let mut gone: HashSet<String> = HashSet::new();
    for id in o.get("undone").and_then(Value::as_array).into_iter().flatten() {
        if let Some(id) = id.as_str().filter(|s| is_hex16(s)) {
            if gone.insert(id.to_string()) {
                undone.push(id.to_string());
            }
        }
    }
    let mut strokes: Vec<Stroke> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for s in o.get("strokes").and_then(Value::as_array).into_iter().flatten() {
        let Some(stroke) = as_stroke(s) else { continue };
        // The first stroke of an id wins; an undone one never stands.
        if gone.contains(&stroke.id) || !seen.insert(stroke.id.clone()) {
            continue;
        }
        strokes.push(stroke);
    }
    strokes.sort_by(order);
    let dimension = |key: &str, fallback: i64| o.get(key).and_then(safe_int).filter(|n| *n > 0).unwrap_or(fallback);
    Body {
        v: BODY_VERSION,
        width: dimension("width", CANVAS_WIDTH),
        height: dimension("height", CANVAS_HEIGHT),
        background: o
            .get("background")
            .and_then(Value::as_str)
            .filter(|c| is_colour(c))
            .unwrap_or(BACKGROUND)
            .to_string(),
        strokes,
        undone,
    }
}

// ---------------------------------------------------------------------------------------------
// Writing and merging

/// The canonical form: compact JSON, fields in a fixed order, strokes in `(t, id)` order, undone
/// sorted - the browser's `writeBody`, byte for byte.
pub fn canonical(body: &Body) -> String {
    let mut body = body.clone();
    body.strokes.sort_by(order);
    body.undone.sort();
    serde_json::to_string(&body).expect("a drawing body is plain JSON")
}

/// Merge any number of versions of one drawing, given in a deterministic order (the caller's is
/// `resolve`'s: oldest head first). Every stroke of any of them, minus every stroke any of them
/// undid; the canvas settings are the first's. Commutative and idempotent, so the order only
/// decides which copy of a duplicated id wins, and a stroke id is never reused.
pub fn merge(bodies: &[Vec<u8>]) -> String {
    let read: Vec<Body> = bodies.iter().map(|b| read(b)).collect();
    let Some(first) = read.first() else { return canonical(&blank()) };
    let undone: HashSet<String> = read.iter().flat_map(|b| b.undone.iter().cloned()).collect();
    let mut strokes: Vec<Stroke> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for stroke in read.iter().flat_map(|b| b.strokes.iter()) {
        if !undone.contains(&stroke.id) && seen.insert(stroke.id.as_str()) {
            strokes.push(stroke.clone());
        }
    }
    canonical(&Body { strokes, undone: undone.into_iter().collect(), ..first.clone() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vectors() -> Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../spec/test-vectors/drawing-v1.json");
        serde_json::from_str(&std::fs::read_to_string(path).expect("the drawing vectors")).expect("vectors are JSON")
    }

    /// The browser's canonical form, reproduced byte for byte from any input.
    #[test]
    fn reads_and_writes_exactly_as_the_browser_does() {
        let v = vectors();
        let cases = v["canonical"].as_array().expect("canonical cases");
        assert!(cases.len() >= 5);
        for case in cases {
            let input = serde_json::to_vec(&case["input"]).unwrap();
            assert_eq!(canonical(&read(&input)), case["written"].as_str().unwrap(), "{}", case["name"]);
        }
    }

    /// The merge the vectors were generated from, in any order the heads come in.
    #[test]
    fn merges_exactly_as_the_vectors_say_in_either_order() {
        let v = vectors();
        for case in v["merge"].as_array().expect("merge cases") {
            let bodies: Vec<Vec<u8>> = case["bodies"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b.as_str().unwrap().as_bytes().to_vec())
                .collect();
            let want = case["merged"].as_str().unwrap();
            assert_eq!(merge(&bodies), want, "{}", case["name"]);
            let mut reversed = bodies.clone();
            reversed.reverse();
            assert_eq!(merge(&reversed), want, "{} (reversed)", case["name"]);
        }
    }

    #[test]
    fn a_merge_is_idempotent_and_a_merged_body_is_already_canonical() {
        let a = br##"{"strokes":[{"id":"a000000000000001","t":3,"tool":"brush","color":"#112233","size":4,"points":[1,2]}],"undone":["b000000000000002"]}"##.to_vec();
        let once = merge(std::slice::from_ref(&a));
        assert_eq!(merge(&[once.clone().into_bytes(), once.clone().into_bytes()]), once);
        assert_eq!(canonical(&read(once.as_bytes())), once);
    }

    #[test]
    fn whole_numbers_are_whole_however_json_spells_them() {
        assert_eq!(safe_int(&serde_json::json!(5)), Some(5));
        assert_eq!(safe_int(&serde_json::json!(5.0)), Some(5), "JavaScript reads 5.0 as 5");
        assert_eq!(safe_int(&serde_json::json!(5.5)), None);
        assert_eq!(safe_int(&serde_json::json!(9007199254740992_i64)), None, "past 2^53 the browser cannot say it");
        assert!(is_colour("#a1b2c3") && !is_colour("#A1B2C3") && !is_colour("#a1b2c") && !is_colour("red"));
    }
}
