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
    !name.is_empty()
        && name.len() <= MAX_NAME_BYTES
        && !name.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f)
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
        let key = |l: &Layer| {
            (l.t, l.z, l.opacity, l.hidden as i64, l.n, l.name.clone().unwrap_or_default())
        };
        key(self) > key(other)
    }
}

/// A text layer's text (DRAWING.md, "Text"): its words, font, size, colour, alignment and anchor.
/// One per layer, the later change winning whole - the browser's `asText` and `textWins`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Text {
    pub layer: String,
    pub t: i64,
    pub text: String,
    pub font: String,
    pub size: i64,
    pub color: String,
    pub align: &'static str,
    pub x: i64,
    pub y: i64,
}

impl Text {
    fn wins_over(&self, other: &Text) -> bool {
        // Numbers first, then the strings by UTF-8 bytes - what `String`'s order is.
        let key = |r: &Text| {
            (r.t, r.size, r.x, r.y, r.text.clone(), r.font.clone(), r.color.clone(), r.align)
        };
        key(self) > key(other)
    }
}

/// The longest a text can be, in UTF-8 bytes; the sizes it can be set at.
pub const MAX_TEXT_BYTES: usize = 4000;
pub const MIN_TEXT_SIZE: i64 = 4;
pub const MAX_TEXT_SIZE: i64 = 400;

/// Words a text can hold: at most MAX_TEXT_BYTES, no control characters but the line break.
fn is_text_content(text: &str) -> bool {
    text.len() <= MAX_TEXT_BYTES
        && !text.chars().any(|c| ((c as u32) < 0x20 && c != '\n') || c as u32 == 0x7f)
}

/// A font token's shape - the Marquee font list's (`sans`, `press-start`, ...), which is all the
/// page offers; the node checks only the shape, so the body need not change when the list does.
fn is_font_name(name: &str) -> bool {
    (1..=40).contains(&name.len())
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn as_text(v: &Value) -> Option<Text> {
    let o = v.as_object()?;
    let layer = o.get("layer")?.as_str().filter(|l| is_hex16(l) && *l != BASE_LAYER)?.to_string();
    let align = match o.get("align")?.as_str()? {
        "left" => "left",
        "center" => "center",
        "right" => "right",
        _ => return None,
    };
    Some(Text {
        layer,
        t: o.get("t").and_then(safe_int).filter(|t| *t >= 0)?,
        text: o.get("text")?.as_str().filter(|t| is_text_content(t))?.to_string(),
        font: o.get("font")?.as_str().filter(|f| is_font_name(f))?.to_string(),
        size: o
            .get("size")
            .and_then(safe_int)
            .filter(|s| (MIN_TEXT_SIZE..=MAX_TEXT_SIZE).contains(s))?,
        color: o.get("color")?.as_str().filter(|c| is_colour(c))?.to_string(),
        align,
        x: o.get("x").and_then(safe_int)?,
        y: o.get("y").and_then(safe_int)?,
    })
}

fn fold_texts<'a>(records: impl Iterator<Item = &'a Text>) -> Vec<Text> {
    let mut by_layer: std::collections::BTreeMap<String, Text> = std::collections::BTreeMap::new();
    for r in records {
        match by_layer.get(&r.layer) {
            Some(held) if !r.wins_over(held) => {}
            _ => {
                by_layer.insert(r.layer.clone(), r.clone());
            }
        }
    }
    by_layer.into_values().collect()
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
    /// Text layers' texts, one per layer (DRAWING.md, "Text"); written only when there are any.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub texts: Vec<Text>,
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
        texts: Vec::new(),
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
                reach: Some(
                    o.get("reach").and_then(safe_int).filter(|r| (0..=MAX_REACH).contains(r))?,
                ),
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
                size: Some(
                    o.get("size").and_then(safe_int).filter(|s| (1..=MAX_SIZE).contains(s))?,
                ),
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
            let side =
                |k: &str| o.get(k).and_then(safe_int).filter(|n| (1..=MAX_IMAGE_SIZE).contains(n));
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
        .filter(|p| {
            p.len() == points.len() / 2 && p.iter().all(|v| (0..=MAX_PRESSURE).contains(v))
        });
    Some(Stroke {
        id,
        t,
        layer,
        tool,
        color,
        size: Some(size),
        points: Some(points),
        pressure,
        reach: None,
        dx: None,
        dy: None,
        from: None,
        doc: None,
        w: None,
        h: None,
        m: None,
    })
}

fn as_layer(v: &Value) -> Option<Layer> {
    let o = v.as_object()?;
    Some(Layer {
        id: o.get("id")?.as_str().filter(|s| is_hex16(s))?.to_string(),
        n: o.get("n").and_then(safe_int).filter(|n| *n >= 1)?,
        name: o
            .get("name")
            .and_then(Value::as_str)
            .filter(|n| is_layer_name(n))
            .map(str::to_string),
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
    let records: Vec<Text> = o
        .get("texts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(as_text)
        .collect();
    let texts = fold_texts(records.iter());
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
    let dimension = |key: &str, fallback: i64| {
        o.get(key).and_then(safe_int).filter(|n| *n > 0).unwrap_or(fallback)
    };
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
        texts,
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
    let texts = fold_texts(read.iter().flat_map(|b| b.texts.iter()));
    canonical(&Body {
        v: BODY_VERSION,
        width: canvas.width,
        height: canvas.height,
        background: canvas.background,
        layers,
        texts,
        strokes,
        undone: undone.into_iter().collect(),
    })
}

// ---------------------------------------------------------------------------------------------
// Geometry (2026-10-09): what the browser's painter asks of a body - the layers in stack order, each
// layer's steps, where each step stands after the grabs and transforms after it, the canvas after
// its crops - ported from `node/js/pure/drawing.js` so the node can paint a drawing itself
// (drawing_paint.rs). Each function is its namesake's, rule for rule.

/// The scale a transform's fixed-point matrix is written in (`MATRIX_ONE`).
pub const MATRIX_ONE: f64 = 1_000_000.0;

/// A matrix `[a, b, c, d, e, f]` as the canvas takes it: x' = a x + c y + e, y' = b x + d y + f.
pub type Matrix = [f64; 6];
pub const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// A then B: the matrix that does `b` first, then `a` (`compose`).
pub fn compose(a: &Matrix, b: &Matrix) -> Matrix {
    [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    ]
}

/// A point through a matrix (`apply`).
pub fn apply(m: &Matrix, (x, y): (f64, f64)) -> (f64, f64) {
    (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
}

/// How wide a stroke is at a pressure, as a share of its `size` (`pressureWidth`).
pub fn pressure_width(pressure: i64) -> f64 {
    0.15 + 0.85 * (pressure.clamp(0, MAX_PRESSURE) as f64 / MAX_PRESSURE as f64)
}

/// The stored, delta-coded points back to absolute ones (`decodePoints`). An odd trailing number
/// is ignored.
pub fn decode_points(encoded: &[i64]) -> Vec<(f64, f64)> {
    let (mut x, mut y) = (0i64, 0i64);
    encoded
        .as_chunks::<2>()
        .0
        .iter()
        .enumerate()
        .map(|(i, p)| {
            if i == 0 {
                (x, y) = (p[0], p[1]);
            } else {
                (x, y) = (x + p[0], y + p[1]);
            }
            (x as f64, y as f64)
        })
        .collect()
}

/// The box a shape's two corners make, in order: [left, top, right, bottom] (`shapeBox`).
pub fn shape_box(points: &[i64]) -> [f64; 4] {
    let p = |i: usize| points.get(i).copied().unwrap_or(0) as f64;
    let (x0, y0, x1, y1) = (p(0), p(1), p(2), p(3));
    [x0.min(x1), y0.min(y1), x0.max(x1), y0.max(y1)]
}

/// An ellipse's outline as points, from the circle's rational parametrisation - only adding,
/// multiplying and dividing, so every computer gets the same points (`ellipseOutline`). Closed.
pub fn ellipse_outline([l, top, r, bottom]: [f64; 4]) -> Vec<(f64, f64)> {
    const QUARTER: usize = 64;
    let (cx, cy) = ((l + r) / 2.0, (top + bottom) / 2.0);
    let (rx, ry) = ((r - l) / 2.0, (bottom - top) / 2.0);
    let quarter: Vec<(f64, f64)> = (0..QUARTER)
        .map(|i| {
            let u = i as f64 / QUARTER as f64;
            let d = 1.0 + u * u;
            ((1.0 - u * u) / d, (2.0 * u) / d)
        })
        .collect();
    let mut unit: Vec<(f64, f64)> = quarter.clone();
    unit.extend(quarter.iter().map(|&(c, s)| (-s, c)));
    unit.extend(quarter.iter().map(|&(c, s)| (-c, -s)));
    unit.extend(quarter.iter().map(|&(c, s)| (s, -c)));
    unit.push(unit[0]);
    unit.into_iter().map(|(c, s)| (cx + rx * c, cy + ry * s)).collect()
}

/// The layers a standing `delete` entry has thrown away (`deletedLayers`).
pub fn deleted_layers(body: &Body) -> HashSet<String> {
    body.strokes
        .iter()
        .filter(|s| s.tool == "delete")
        .map(|s| s.layer.clone().unwrap_or_else(|| BASE_LAYER.to_string()))
        .collect()
}

/// Every layer, bottom of the stack first (`layersOf`): the entries, the base layer, and any layer a
/// stroke is on that has no entry of its own, at its defaults - less the deleted.
pub fn layers_of(body: &Body) -> Vec<Layer> {
    let default = |id: &str| Layer {
        id: id.to_string(),
        n: 1,
        name: None,
        z: 0,
        opacity: MAX_OPACITY,
        hidden: false,
        t: 0,
    };
    let mut layers: Vec<Layer> = vec![default(BASE_LAYER)];
    for s in body.strokes.iter().filter(|s| s.tool != "crop") {
        let id = s.layer.as_deref().unwrap_or(BASE_LAYER);
        if !layers.iter().any(|l| l.id == id) {
            layers.push(default(id));
        }
    }
    for l in &body.layers {
        match layers.iter_mut().find(|have| have.id == l.id) {
            Some(have) => *have = l.clone(),
            None => layers.push(l.clone()),
        }
    }
    let deleted = deleted_layers(body);
    layers.retain(|l| !deleted.contains(&l.id));
    layers.sort_by(|a, b| a.z.cmp(&b.z).then_with(|| a.id.cmp(&b.id)));
    layers
}

/// A layer's text, or none when it is not a text layer or has been thrown away (`textOf`).
pub fn text_of<'a>(body: &'a Body, layer: &str) -> Option<&'a Text> {
    let record = body.texts.iter().find(|r| r.layer == layer)?;
    (!deleted_layers(body).contains(layer)).then_some(record)
}

/// One step a layer paints (`effectiveOps`): the base layer's fill, a text layer's words, or one of
/// its entries.
#[derive(Debug, Clone, Copy)]
pub enum Op<'a> {
    Fill,
    Text(&'a Text),
    Entry(&'a Stroke),
}

impl Op<'_> {
    pub fn tool(&self) -> &str {
        match self {
            Op::Fill => "fill",
            Op::Text(_) => "text",
            Op::Entry(s) => s.tool,
        }
    }
}

/// What a layer paints, in order (`effectiveOps`): the base layer's fill first, a text layer's
/// words, then its entries - each `copy` replaced by its source's steps from before it, and every
/// crop among them. `before` is the copy being expanded.
pub fn effective_ops<'a>(body: &'a Body, layer: &str, before: Option<&Stroke>) -> Vec<Op<'a>> {
    let mut out = Vec::new();
    if layer == BASE_LAYER {
        out.push(Op::Fill);
    }
    if before.is_none() {
        if let Some(text) = text_of(body, layer) {
            out.push(Op::Text(text));
        }
    }
    for op in body
        .strokes
        .iter()
        .filter(|s| s.tool == "crop" || s.layer.as_deref().unwrap_or(BASE_LAYER) == layer)
    {
        if before.is_some_and(|b| order(op, b) != std::cmp::Ordering::Less) {
            break;
        }
        match op.tool {
            "copy" => {
                if let Some(from) = op.from.as_deref() {
                    out.extend(effective_ops(body, from, Some(op)));
                }
            }
            "delete" => {}
            _ => out.push(Op::Entry(op)),
        }
    }
    out
}

/// The matrix a step applies to what came before it (`matrixOf`).
fn matrix_of(op: &Op) -> Option<Matrix> {
    let Op::Entry(s) = op else { return None };
    match s.tool {
        "move" => Some([1.0, 0.0, 0.0, 1.0, s.dx.unwrap_or(0) as f64, s.dy.unwrap_or(0) as f64]),
        "crop" => {
            let p = s.points.as_deref().unwrap_or(&[]);
            let at = |i: usize| p.get(i).copied().unwrap_or(0) as f64;
            Some([1.0, 0.0, 0.0, 1.0, -at(0), -at(1)])
        }
        "transform" => {
            let m = s.m.as_deref().unwrap_or(&[]);
            (m.len() == 6).then(|| {
                let f = |i: usize| m[i] as f64 / MATRIX_ONE;
                [f(0), f(1), f(2), f(3), f(4), f(5)]
            })
        }
        _ => None,
    }
}

/// The matrix each step is painted through - every move, transform and crop after it, the
/// earliest applied first - and the layer's whole matrix (`matricesOf`).
pub fn matrices_of(ops: &[Op]) -> (Vec<Matrix>, Matrix) {
    let mut each = vec![IDENTITY; ops.len()];
    let mut m = IDENTITY;
    for i in (0..ops.len()).rev() {
        each[i] = m;
        if let Some(own) = matrix_of(&ops[i]) {
            m = compose(&m, &own);
        }
    }
    (each, m)
}

/// The canvas after the crops among `ops`, from the drawing's own (`sizeAfter`): [width, height].
pub fn size_after(body: &Body, ops: &[Op]) -> (i64, i64) {
    let mut size = (body.width, body.height);
    for op in ops {
        if let Op::Entry(s) = op {
            if s.tool == "crop" {
                let p = s.points.as_deref().unwrap_or(&[]);
                if p.len() == 4 {
                    size = (p[2] - p[0], p[3] - p[1]);
                }
            }
        }
    }
    size
}

/// The canvas as it stands (`sizeOf`).
pub fn size_of(body: &Body) -> (i64, i64) {
    let ops: Vec<Op> = body.strokes.iter().map(Op::Entry).collect();
    size_after(body, &ops)
}

/// The picture documents a drawing places, each once (`imagesOf`).
pub fn images_of(body: &Body) -> Vec<String> {
    let mut seen = Vec::new();
    for s in body.strokes.iter().filter(|s| s.tool == "image") {
        if let Some(doc) = &s.doc {
            if !seen.contains(doc) {
                seen.push(doc.clone());
            }
        }
    }
    seen
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vectors() -> Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../spec/test-vectors/drawing-v1.json");
        serde_json::from_str(&std::fs::read_to_string(path).expect("the drawing vectors"))
            .expect("vectors are JSON")
    }

    /// The browser's canonical form, reproduced byte for byte from any input.
    #[test]
    fn reads_and_writes_exactly_as_the_browser_does() {
        let v = vectors();
        let cases = v["canonical"].as_array().expect("canonical cases");
        assert!(cases.len() >= 5);
        for case in cases {
            let input = serde_json::to_vec(&case["input"]).unwrap();
            assert_eq!(
                canonical(&read(&input)),
                case["written"].as_str().unwrap(),
                "{}",
                case["name"]
            );
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
        assert_eq!(
            safe_int(&serde_json::json!(9007199254740992_i64)),
            None,
            "past 2^53 the browser cannot say it"
        );
        assert!(
            is_colour("#a1b2c3")
                && !is_colour("#A1B2C3")
                && !is_colour("#a1b2c")
                && !is_colour("red")
        );
    }
}
