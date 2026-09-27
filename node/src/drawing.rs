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
/// The base layer's fill: the white every drawing starts on (DRAWING.md, "Layers").
pub const BACKGROUND: &str = "#ffffff";
/// The largest brush or eraser, in canvas units.
pub const MAX_SIZE: i64 = 200;
/// The farthest a pour can spread, in canvas units along the paint's path (pure/pour.js).
pub const MAX_REACH: i64 = 1_000_000;
/// A transform's six numbers are fixed point - each times MATRIX_ONE - and at most MAX_MATRIX
/// either way (pure/drawing.js).
pub const MAX_MATRIX: i64 = 1_000_000_000_000;
/// The largest a placed image can be, either way, in canvas units.
pub const MAX_IMAGE_SIZE: i64 = 20_000;
/// A pen's pressure at a point: a whole number from 0 (the lightest touch) to 100 (full).
pub const MAX_PRESSURE: i64 = 100;
/// A layer's opacity: a whole percent.
pub const MAX_OPACITY: i64 = 100;
/// The longest layer name, in UTF-8 bytes.
pub const MAX_NAME_BYTES: usize = 120;

/// Can this be kept as a layer's name? The browser's `isLayerName`: non-empty, at most
/// MAX_NAME_BYTES, no control characters. (An unpaired surrogate cannot reach a Rust `String` at all:
/// serde refuses the whole body, which the browser's rule keeps anyone from writing.)
fn is_layer_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= MAX_NAME_BYTES && !name.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f)
}
/// The layer every drawing starts with, and the one a stroke naming no layer is on.
pub const BASE_LAYER: &str = "0000000000000000";
/// JavaScript's `Number.MAX_SAFE_INTEGER`: the largest whole number the browser writes exactly.
const MAX_SAFE: i64 = (1 << 53) - 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Stroke {
    pub id: String,
    pub t: i64,
    /// Which layer it is on; absent for the base layer, which is how the base layer is written.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layer: Option<String>,
    pub tool: &'static str,
    /// A brush's colour; an eraser and a move have none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// A brush's or eraser's width at full pressure; a move has none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
    /// Delta-coded: the first point absolute, every later one the step from the one before. A move
    /// has none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub points: Option<Vec<i64>>,
    /// A pen stroke's pressure, one 0..=100 per point; absent for a mouse or a finger, whose stroke
    /// is one width throughout.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pressure: Option<Vec<i64>>,
    /// How far a pour spread (DRAWING.md, "Pouring"); only a pour has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reach: Option<i64>,
    /// A move's shift of its whole layer (DRAWING.md, "Grabbing"); only a move has these.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dx: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dy: Option<i64>,
    /// A copy's source layer (DRAWING.md, "Deleting and duplicating layers"); only a copy has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// An image's picture document (DRAWING.md, "Images"), and its size on the canvas; only an
    /// image has these. Its top-left is its one point.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub w: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub h: Option<i64>,
    /// A transform's matrix (DRAWING.md, "Transforming"), fixed point; only a transform has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub m: Option<Vec<i64>>,
}

/// A layer (DRAWING.md, "Layers"): its number, its place in the stack, its opacity, whether it is
/// hidden, and when it last changed - which is how a merge picks between two computers' versions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Layer {
    pub id: String,
    pub n: i64,
    /// A name the layer was given; absent, it is "layer n".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub z: i64,
    pub opacity: i64,
    pub hidden: bool,
    pub t: i64,
}

impl Layer {
    /// Of two entries for one layer, does `self` win? The later change; on a tie, the larger of
    /// (z, opacity, hidden, n) - the browser's `layerWins`, exactly.
    fn wins_over(&self, other: &Layer) -> bool {
        // Names compare by UTF-8 bytes - what `String`'s order is, and what the browser's
        // `compareUtf8` reproduces, since JavaScript's own `<` compares UTF-16 code units.
        let key = |l: &Layer| (l.t, l.z, l.opacity, l.hidden as i64, l.n, l.name.clone().unwrap_or_default());
        key(self) > key(other)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Body {
    pub v: i64,
    pub width: i64,
    pub height: i64,
    pub background: String,
    /// Written only when there are any: a drawing with no layer entries is the bytes it always was.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub layers: Vec<Layer>,
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
        layers: Vec::new(),
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

/// A document id: 16 bytes, lowercase hex.
fn is_doc_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(is_lower_hex)
}

fn is_colour(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7 && b[0] == b'#' && b[1..].iter().copied().all(is_lower_hex)
}

fn as_stroke(v: &Value) -> Option<Stroke> {
    let o = v.as_object()?;
    let id = o.get("id")?.as_str().filter(|s| is_hex16(s))?.to_string();
    let t = o.get("t").and_then(safe_int).filter(|t| *t >= 0)?;
    let layer = o
        .get("layer")
        .and_then(Value::as_str)
        .filter(|l| is_hex16(l) && *l != BASE_LAYER)
        .map(str::to_string);
    let tool = match o.get("tool")?.as_str()? {
        "brush" => "brush",
        "eraser" => "eraser",
        // A grab, a layer thrown away, a layer begun as a copy: entries in the history, merged and
        // undone as a stroke is - each with only its own fields.
        "move" | "delete" | "copy" => {
            let kind = o.get("tool")?.as_str()?;
            let mut entry = Stroke {
                id,
                t,
                layer,
                tool: "move",
                color: None,
                size: None,
                points: None,
                pressure: None,
                reach: None,
                dx: None,
                dy: None,
                from: None,
                doc: None,
                w: None,
                h: None,
                m: None,
            };
            match kind {
                "move" => {
                    entry.dx = Some(o.get("dx").and_then(safe_int)?);
                    entry.dy = Some(o.get("dy").and_then(safe_int)?);
                }
                "delete" => entry.tool = "delete",
                _ => {
                    entry.tool = "copy";
                    entry.from = Some(o.get("from")?.as_str().filter(|f| is_hex16(f))?.to_string());
                }
            }
            return Some(entry);
        }
        // A pour (the paint bucket): a colour, the one point it was dropped at, and how far it
        // spread. What it covers is the page's to work out (pure/pour.js); the node keeps the entry.
        "bucket" => {
            let points = o
                .get("points")?
                .as_array()?
                .iter()
                .map(safe_int)
                .collect::<Option<Vec<i64>>>()
                .filter(|p| p.len() == 2)?;
            return Some(Stroke {
                id,
                t,
                layer,
                tool: "bucket",
                color: Some(o.get("color")?.as_str().filter(|c| is_colour(c))?.to_string()),
                size: None,
                points: Some(points),
                pressure: None,
                reach: Some(o.get("reach").and_then(safe_int).filter(|r| (0..=MAX_REACH).contains(r))?),
                dx: None,
                dy: None,
                from: None,
                doc: None,
                w: None,
                h: None,
                m: None,
            });
        }
        // A crop: the canvas cut to the box `points` = [left, top, right, bottom] - on no layer, since
        // it cuts every one (a `layer` it arrives with is dropped). Its box must enclose something.
        "crop" => {
            let points = o
                .get("points")?
                .as_array()?
                .iter()
                .map(safe_int)
                .collect::<Option<Vec<i64>>>()
                .filter(|p| p.len() == 4 && p[0] < p[2] && p[1] < p[3])?;
            return Some(Stroke {
                id,
                t,
                layer: None,
                tool: "crop",
                color: None,
                size: None,
                points: Some(points),
                pressure: None,
                reach: None,
                dx: None,
                dy: None,
                from: None,
                doc: None,
                w: None,
                h: None,
                m: None,
            });
        }
        // A transform: everything before it on its layer through the affine matrix `m`, six fixed-point
        // whole numbers. The node keeps it; painting it is the page's.
        "transform" => {
            let m = o
                .get("m")?
                .as_array()?
                .iter()
                .map(safe_int)
                .collect::<Option<Vec<i64>>>()
                .filter(|m| m.len() == 6 && m.iter().all(|n| n.abs() <= MAX_MATRIX))?;
            return Some(Stroke {
                id,
                t,
                layer,
                tool: "transform",
                color: None,
                size: None,
                points: None,
                pressure: None,
                reach: None,
                dx: None,
                dy: None,
                from: None,
                doc: None,
                w: None,
                h: None,
                m: Some(m),
            });
        }
        // A rectangle or an ellipse: the box it was dragged out in (two corners, absolute), outlined
        // `size` wide in `color`. A drawn line is a brush stroke; it needs no entry of its own.
        "rect" | "ellipse" => {
            let kind = if o.get("tool")?.as_str()? == "rect" { "rect" } else { "ellipse" };
            let points = o
                .get("points")?
                .as_array()?
                .iter()
                .map(safe_int)
                .collect::<Option<Vec<i64>>>()
                .filter(|p| p.len() == 4)?;
            return Some(Stroke {
                id,
                t,
                layer,
                tool: kind,
                color: Some(o.get("color")?.as_str().filter(|c| is_colour(c))?.to_string()),
                size: Some(o.get("size").and_then(safe_int).filter(|s| (1..=MAX_SIZE).contains(s))?),
                points: Some(points),
                pressure: None,
                reach: None,
                dx: None,
                dy: None,
                from: None,
                doc: None,
                w: None,
                h: None,
                m: None,
            });
        }
        // An image: the picture's document id, its top-left, its size. The pixels stay in the
        // picture's own document; the page fetches them to paint.
        "image" => {
            let points = o
                .get("points")?
                .as_array()?
                .iter()
                .map(safe_int)
                .collect::<Option<Vec<i64>>>()
                .filter(|p| p.len() == 2)?;
            let side = |k: &str| o.get(k).and_then(safe_int).filter(|n| (1..=MAX_IMAGE_SIZE).contains(n));
            return Some(Stroke {
                id,
                t,
                layer,
                tool: "image",
                color: None,
                size: None,
                points: Some(points),
                pressure: None,
                reach: None,
                dx: None,
                dy: None,
                from: None,
                doc: Some(o.get("doc")?.as_str().filter(|d| is_doc_id(d))?.to_string()),
                w: Some(side("w")?),
                h: Some(side("h")?),
                m: None,
            });
        }
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
    // A pressure list that does not fit its points is dropped, not the stroke (pure/drawing.js).
    let pressure = o
        .get("pressure")
        .and_then(Value::as_array)
        .and_then(|list| list.iter().map(safe_int).collect::<Option<Vec<i64>>>())
        .filter(|p| p.len() == points.len() / 2 && p.iter().all(|v| (0..=MAX_PRESSURE).contains(v)));
    Some(Stroke { id, t, layer, tool, color, size: Some(size), points: Some(points), pressure, reach: None, dx: None, dy: None, from: None, doc: None, w: None, h: None, m: None })
}

fn as_layer(v: &Value) -> Option<Layer> {
    let o = v.as_object()?;
    Some(Layer {
        id: o.get("id")?.as_str().filter(|s| is_hex16(s))?.to_string(),
        n: o.get("n").and_then(safe_int).filter(|n| *n >= 1)?,
        name: o.get("name").and_then(Value::as_str).filter(|n| is_layer_name(n)).map(str::to_string),
        z: o.get("z").and_then(safe_int)?,
        opacity: o.get("opacity").and_then(safe_int).filter(|p| (0..=MAX_OPACITY).contains(p))?,
        hidden: o.get("hidden")?.as_bool()?,
        t: o.get("t").and_then(safe_int).filter(|t| *t >= 0)?,
    })
}

/// Fold layer entries into one per id, the winner of each, in id order.
fn fold_layers<'a>(entries: impl Iterator<Item = &'a Layer>) -> Vec<Layer> {
    let mut by_id: std::collections::BTreeMap<String, Layer> = std::collections::BTreeMap::new();
    for layer in entries {
        match by_id.get(&layer.id) {
            Some(held) if !layer.wins_over(held) => {}
            _ => {
                by_id.insert(layer.id.clone(), layer.clone());
            }
        }
    }
    by_id.into_values().collect()
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
    let entries: Vec<Layer> = o
        .get("layers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(as_layer)
        .collect();
    let layers = fold_layers(entries.iter());
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
        layers,
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

/// Merge any number of versions of one drawing. Every stroke of any of them, minus every stroke any
/// of them undid; every layer, the later change to each winning; the canvas settings chosen by a
/// fixed order among the readable versions. Commutative and idempotent - the order the heads come
/// in decides only which copy of a duplicated stroke id wins, and a stroke id is never reused.
pub fn merge(bodies: &[Vec<u8>]) -> String {
    let read: Vec<Body> = bodies.iter().map(|b| read(b)).collect();
    if read.is_empty() {
        return canonical(&blank());
    }
    // The canvas settings: only versions that parsed have a say, and among them the least of
    // (width, height, background), so the order the heads come in cannot matter - the browser's
    // `mergedCanvas` exactly (found 2026-09-26: taking the first version's made a merge with an
    // unreadable head order-dependent).
    let canvas = bodies
        .iter()
        .filter(|b| matches!(serde_json::from_slice::<Value>(b), Ok(Value::Object(_))))
        .map(|b| self::read(b))
        .min_by(|a, b| (a.width, a.height, &a.background).cmp(&(b.width, b.height, &b.background)))
        .unwrap_or_else(blank);
    let undone: HashSet<String> = read.iter().flat_map(|b| b.undone.iter().cloned()).collect();
    let mut strokes: Vec<Stroke> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for stroke in read.iter().flat_map(|b| b.strokes.iter()) {
        if !undone.contains(&stroke.id) && seen.insert(stroke.id.as_str()) {
            strokes.push(stroke.clone());
        }
    }
    let layers = fold_layers(read.iter().flat_map(|b| b.layers.iter()));
    canonical(&Body {
        v: BODY_VERSION,
        width: canvas.width,
        height: canvas.height,
        background: canvas.background,
        layers,
        strokes,
        undone: undone.into_iter().collect(),
    })
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
