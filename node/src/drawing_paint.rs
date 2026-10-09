//! A drawing as a picture, painted on the node (2026-10-09: an ePub needs one, and an export, and
//! "it'll probably come up more often" - Curtis). The browser paints drawings onto canvases
//! (`node/js/doc/drawing.js`, `flatten`); this is that painter in Rust, step for step, so the node
//! can make the same picture with no browser in sight.
//!
//! Two halves:
//!
//! - **The pour** (`pure/pour.js`, ported exactly): what a paint bucket covers is worked out again
//!   from the body, by plain arithmetic on the drawing's own grid, so it must come out the same
//!   cells on every computer - and here too. Same walls, same 3-and-4 field, same runs; the tests
//!   hold it to the browser's own cases.
//! - **The painter** (`flatten`): each layer onto a pixmap of its own - the base layer's fill, the
//!   strokes with their pressure and round ends, the eraser cutting through (`destination-out`), the
//!   shapes, the pours, the placed pictures, a text layer's words - every step through the
//!   grabs, transforms and crops after it; then the visible layers stacked at their opacities over
//!   nothing. On `tiny-skia`, Skia's own CPU rasteriser, so a line's ends and joins, a rectangle's
//!   mitred corners and a picture's smoothing are the canvas's. Antialiasing can't match a browser
//!   pixel for pixel - nothing can - but every mark lands where it does there.
//!
//! **Text** is set in the Marquee faces the node already carries (ui.rs, woff2, unpacked here once
//! each): a glyph's outline drawn as a path. The four standard stacks - sans, serif, mono, comic -
//! are whatever a reader's system has in a browser; here they are Radio Canada, Zilla Slab,
//! JetBrains Mono and Comic Neue.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use ab_glyph::{Font, FontArc, OutlineCurve};
use tiny_skia::{
    BlendMode, Color, FillRule, FilterQuality, LineCap, LineJoin, Paint, PathBuilder, Pixmap,
    PixmapPaint, Rect, Stroke as Pen, Transform,
};

use crate::drawing::{
    apply, decode_points, effective_ops, ellipse_outline, layers_of, matrices_of, pressure_width,
    shape_box, size_after, size_of, Body, Matrix, Op, Text,
};

// ---------------------------------------------------------------------------------------------
// The pour (pure/pour.js)

/// The field's units per canvas unit: a straight step, and a diagonal one.
pub const STEP: i32 = 3;
pub const DIAGONAL: i32 = 4;

/// How much of a line's width holds paint back: its core, never thinner than this.
const MIN_WALL_RADIUS: f64 = 0.75;

#[allow(clippy::too_many_arguments)]
fn stamp_segment(
    walls: &mut [u8],
    width: i64,
    height: i64,
    (ax, ay): (f64, f64),
    (bx, by): (f64, f64),
    radius: f64,
    value: u8,
) {
    let r = (radius - 0.5).max(MIN_WALL_RADIUS);
    let r2 = r * r;
    let x0 = 0f64.max((ax.min(bx) - r).floor()) as i64;
    let x1 = ((width - 1) as f64).min((ax.max(bx) + r).ceil()) as i64;
    let y0 = 0f64.max((ay.min(by) - r).floor()) as i64;
    let y1 = ((height - 1) as f64).min((ay.max(by) + r).ceil()) as i64;
    let (dx, dy) = (bx - ax, by - ay);
    let len2 = dx * dx + dy * dy;
    for y in y0..=y1 {
        for x in x0..=x1 {
            let px = x as f64 + 0.5 - ax;
            let py = y as f64 + 0.5 - ay;
            let k = if len2 == 0.0 { 0.0 } else { ((px * dx + py * dy) / len2).clamp(0.0, 1.0) };
            let ex = px - k * dx;
            let ey = py - k * dy;
            if ex * ex + ey * ey <= r2 {
                walls[(y * width + x) as usize] = value;
            }
        }
    }
}

fn stamp_rect(
    walls: &mut [u8],
    width: i64,
    height: i64,
    [l, top, r, bottom]: [f64; 4],
    radius: f64,
) {
    let c = (radius - 0.5).max(MIN_WALL_RADIUS);
    let x0 = 0f64.max((l - c).floor()) as i64;
    let x1 = ((width - 1) as f64).min((r + c).ceil()) as i64;
    let y0 = 0f64.max((top - c).floor()) as i64;
    let y1 = ((height - 1) as f64).min((bottom + c).ceil()) as i64;
    for y in y0..=y1 {
        let py = y as f64 + 0.5;
        if py < top - c || py > bottom + c {
            continue;
        }
        for x in x0..=x1 {
            let px = x as f64 + 0.5;
            if px < l - c || px > r + c {
                continue;
            }
            let inside = px > l + c && px < r - c && py > top + c && py < bottom - c;
            if !inside {
                walls[(y * width + x) as usize] = 1;
            }
        }
    }
}

/// The walls a pour at `ops[upto]` meets (`wallsOf`): a cell per canvas unit, 1 where a line is.
pub fn walls_of(ops: &[Op], upto: usize, width: i64, height: i64) -> Vec<u8> {
    let mut walls = vec![0u8; (width.max(0) * height.max(0)) as usize];
    let (each, _) = matrices_of(&ops[..upto]);
    for (j, op) in ops[..upto].iter().enumerate() {
        let Op::Entry(s) = op else { continue };
        if !matches!(s.tool, "brush" | "eraser" | "rect" | "ellipse") {
            continue;
        }
        let m = &each[j];
        let shifted = m[0] == 1.0 && m[1] == 0.0 && m[2] == 0.0 && m[3] == 1.0;
        let stretch = if shifted { 1.0 } else { (m[0] * m[3] - m[1] * m[2]).abs().sqrt() };
        let size = s.size.unwrap_or(0) as f64;
        if s.tool == "rect" || s.tool == "ellipse" {
            let [l, top, r, bottom] = shape_box(s.points.as_deref().unwrap_or(&[]));
            if s.tool == "rect" && shifted {
                stamp_rect(
                    &mut walls,
                    width,
                    height,
                    [l + m[4], top + m[5], r + m[4], bottom + m[5]],
                    size / 2.0,
                );
                continue;
            }
            let outline: Vec<(f64, f64)> = if s.tool == "rect" {
                vec![(l, top), (r, top), (r, bottom), (l, bottom), (l, top)]
            } else {
                ellipse_outline([l, top, r, bottom])
            };
            let at: Vec<(f64, f64)> = outline.into_iter().map(|p| apply(m, p)).collect();
            for w in at.windows(2) {
                stamp_segment(&mut walls, width, height, w[0], w[1], (size / 2.0) * stretch, 1);
            }
            continue;
        }
        let points: Vec<(f64, f64)> = decode_points(s.points.as_deref().unwrap_or(&[]))
            .into_iter()
            .map(|p| apply(m, p))
            .collect();
        let pressure = s.pressure.as_deref();
        let radius = |i: usize| {
            let p = pressure.map_or(1.0, |p| pressure_width(p.get(i).copied().unwrap_or(0)));
            (size * p) / 2.0 * stretch
        };
        let value = if s.tool == "brush" { 1 } else { 0 };
        if points.len() == 1 {
            stamp_segment(&mut walls, width, height, points[0], points[0], radius(0), value);
            continue;
        }
        for i in 1..points.len() {
            let r = (radius(i - 1) + radius(i)) / 2.0;
            stamp_segment(&mut walls, width, height, points[i - 1], points[i], r, value);
        }
    }
    walls
}

/// How far paint dropped at (x, y) travels to each cell, in field units, -1 where it cannot reach;
/// nothing beyond `limit` (`pourField`, Dial's algorithm in the same order).
pub fn pour_field(walls: &[u8], width: i64, height: i64, x: i64, y: i64, limit: i64) -> Vec<i32> {
    let mut dist = vec![-1i32; (width.max(0) * height.max(0)) as usize];
    if x < 0 || y < 0 || x >= width || y >= height {
        return dist;
    }
    let start = (y * width + x) as usize;
    if walls[start] != 0 {
        return dist;
    }
    let open = |cx: i64, cy: i64| {
        cx >= 0 && cy >= 0 && cx < width && cy < height && walls[(cy * width + cx) as usize] == 0
    };
    let mut queue: Vec<Option<Vec<usize>>> = vec![Some(vec![start])];
    dist[start] = 0;
    let mut d = 0usize;
    while d < queue.len() {
        let Some(here) = queue[d].take() else {
            d += 1;
            continue;
        };
        for cell in here {
            if dist[cell] != d as i32 {
                continue;
            }
            let cx = cell as i64 % width;
            let cy = cell as i64 / width;
            for ny in -1..=1i64 {
                for nx in -1..=1i64 {
                    if nx == 0 && ny == 0 {
                        continue;
                    }
                    if !open(cx + nx, cy + ny) {
                        continue;
                    }
                    let diagonal = nx != 0 && ny != 0;
                    if diagonal && !(open(cx + nx, cy) && open(cx, cy + ny)) {
                        continue;
                    }
                    let nd = d as i64 + if diagonal { DIAGONAL } else { STEP } as i64;
                    if nd > limit {
                        continue;
                    }
                    let n = ((cy + ny) * width + cx + nx) as usize;
                    if dist[n] != -1 && dist[n] as i64 <= nd {
                        continue;
                    }
                    dist[n] = nd as i32;
                    let nd = nd as usize;
                    if queue.len() <= nd {
                        queue.resize(nd + 1, None);
                    }
                    queue[nd].get_or_insert_with(Vec::new).push(n);
                }
            }
        }
        d += 1;
    }
    dist
}

/// A field's covered cells as runs along each row (`runsOf`): `[y, from, to (inclusive), ...]`.
pub fn runs_of(dist: &[i32], width: i64, height: i64) -> Vec<i64> {
    let mut runs = Vec::new();
    for y in 0..height {
        let mut from = -1i64;
        for x in 0..=width {
            let d = if x < width { dist[(y * width + x) as usize] } else { -1 };
            let covered = d >= 0;
            if covered && from < 0 {
                from = x;
            } else if !covered && from >= 0 {
                runs.extend([y, from, x - 1]);
                from = -1;
            }
        }
    }
    runs
}

/// The cells the pour at `ops[index]` covers, as row runs (`pourRuns`).
pub fn pour_runs(ops: &[Op], index: usize, width: i64, height: i64) -> Vec<i64> {
    let Op::Entry(pour) = ops[index] else { return Vec::new() };
    let p = pour.points.as_deref().unwrap_or(&[]);
    let (x, y) = (p.first().copied().unwrap_or(-1), p.get(1).copied().unwrap_or(-1));
    let walls = walls_of(ops, index, width, height);
    let limit = pour.reach.unwrap_or(0).saturating_mul(STEP as i64);
    let dist = pour_field(&walls, width, height, x, y, limit);
    runs_of(&dist, width, height)
}

// ---------------------------------------------------------------------------------------------
// The painter (doc/drawing.js)

/// The pictures a drawing places, decoded, by their document's id (hex). One that isn't here
/// paints as nothing, as it does in a browser before it arrives.
pub type Pictures = HashMap<String, Pixmap>;

/// A picture of the drawing, `width` pixels wide: the visible layers, stacked at their opacities
/// over nothing - transparent wherever they leave nothing (`flatten`).
pub fn flatten(body: &Body, width: u32, pictures: &Pictures) -> Option<Pixmap> {
    let (w, h) = size_of(body);
    if w <= 0 || h <= 0 || width == 0 {
        return None;
    }
    let height = ((width as f64 * h as f64) / w as f64).round().max(1.0) as u32;
    let scale = width as f32 / w as f32;
    let mut out = Pixmap::new(width, height)?;
    for layer in layers_of(body) {
        if layer.hidden {
            continue;
        }
        let Some(painted) = paint_layer(body, &layer.id, width, height, scale, pictures) else {
            continue;
        };
        let paint = PixmapPaint {
            opacity: layer.opacity as f32 / 100.0,
            blend_mode: BlendMode::SourceOver,
            quality: FilterQuality::Nearest,
        };
        out.draw_pixmap(0, 0, painted.as_ref(), &paint, Transform::identity(), None);
    }
    Some(out)
}

/// The canvas transform for a step painted through `m` at `scale` pixels to a canvas unit.
fn transform(m: &Matrix, scale: f32) -> Transform {
    Transform::from_row(
        m[0] as f32,
        m[1] as f32,
        m[2] as f32,
        m[3] as f32,
        m[4] as f32,
        m[5] as f32,
    )
    .post_scale(scale, scale)
}

fn colour(hex: &str) -> Color {
    let byte = |i: usize| u8::from_str_radix(hex.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0);
    Color::from_rgba8(byte(1), byte(3), byte(5), 255)
}

fn solid(hex: &str, blend: BlendMode) -> Paint<'static> {
    let mut paint = Paint::default();
    paint.set_color(colour(hex));
    paint.anti_alias = true;
    paint.blend_mode = blend;
    paint
}

/// One layer onto a pixmap of its own (`paintLayer`): transparent wherever it has nothing, so an
/// eraser on it erases only it.
fn paint_layer(
    body: &Body,
    layer: &str,
    width: u32,
    height: u32,
    scale: f32,
    pictures: &Pictures,
) -> Option<Pixmap> {
    let mut canvas = Pixmap::new(width, height)?;
    let ops = effective_ops(body, layer, None);
    let (each, _) = matrices_of(&ops);
    for (i, op) in ops.iter().enumerate() {
        let t = transform(&each[i], scale);
        match op {
            Op::Fill => {
                if let Some(rect) = Rect::from_xywh(0.0, 0.0, body.width as f32, body.height as f32)
                {
                    canvas.fill_rect(
                        rect,
                        &solid(&body.background, BlendMode::SourceOver),
                        t,
                        None,
                    );
                }
            }
            Op::Text(text) => paint_text(&mut canvas, text, t),
            Op::Entry(s) => match s.tool {
                "move" | "transform" | "crop" => {}
                "image" => {
                    let picture = s.doc.as_deref().and_then(|d| pictures.get(d));
                    let p = s.points.as_deref().unwrap_or(&[]);
                    if let (Some(img), [x, y, ..]) = (picture, p) {
                        let (w, h) = (s.w.unwrap_or(0) as f32, s.h.unwrap_or(0) as f32);
                        let fit = Transform::from_translate(*x as f32, *y as f32)
                            .pre_scale(w / img.width() as f32, h / img.height() as f32);
                        let paint = PixmapPaint {
                            quality: FilterQuality::Bilinear,
                            ..PixmapPaint::default()
                        };
                        canvas.draw_pixmap(0, 0, img.as_ref(), &paint, t.pre_concat(fit), None);
                    }
                }
                "rect" | "ellipse" => paint_shape(&mut canvas, s, t),
                "bucket" => {
                    let (w, h) = size_after(body, &ops[..i]);
                    let runs = pour_runs(&ops, i, w, h);
                    paint_runs(
                        &mut canvas,
                        &runs,
                        s.color.as_deref().unwrap_or("#000000"),
                        (w, h),
                        t,
                    );
                }
                _ => paint_stroke(&mut canvas, s, t),
            },
        }
    }
    Some(canvas)
}

/// One stroke (`paintStroke`): a dab is a disc; without pressure, one path at one width; with it,
/// segment by segment, each as wide as the average of its ends, with round ends so the joins close.
fn paint_stroke(canvas: &mut Pixmap, s: &crate::drawing::Stroke, t: Transform) {
    let eraser = s.tool == "eraser";
    let paint = if eraser {
        solid("#000000", BlendMode::DestinationOut)
    } else {
        solid(s.color.as_deref().unwrap_or("#000000"), BlendMode::SourceOver)
    };
    let points = decode_points(s.points.as_deref().unwrap_or(&[]));
    let size = s.size.unwrap_or(0) as f64;
    let pressure = s.pressure.as_deref();
    let width =
        |i: usize| size * pressure.map_or(1.0, |p| pressure_width(p.get(i).copied().unwrap_or(0)));
    let pen = |w: f64| Pen {
        width: w as f32,
        line_cap: LineCap::Round,
        line_join: LineJoin::Round,
        ..Pen::default()
    };
    match points.len() {
        0 => {}
        1 => {
            let (x, y) = points[0];
            if let Some(dot) = PathBuilder::from_circle(x as f32, y as f32, (width(0) / 2.0) as f32)
            {
                canvas.fill_path(&dot, &paint, FillRule::Winding, t, None);
            }
        }
        _ if pressure.is_none() => {
            let mut pb = PathBuilder::new();
            pb.move_to(points[0].0 as f32, points[0].1 as f32);
            for &(x, y) in &points[1..] {
                pb.line_to(x as f32, y as f32);
            }
            if let Some(path) = pb.finish() {
                canvas.stroke_path(&path, &paint, &pen(width(0)), t, None);
            }
        }
        _ => {
            for i in 1..points.len() {
                let mut pb = PathBuilder::new();
                pb.move_to(points[i - 1].0 as f32, points[i - 1].1 as f32);
                pb.line_to(points[i].0 as f32, points[i].1 as f32);
                if let Some(path) = pb.finish() {
                    canvas.stroke_path(
                        &path,
                        &paint,
                        &pen((width(i - 1) + width(i)) / 2.0),
                        t,
                        None,
                    );
                }
            }
        }
    }
}

/// A rectangle or an ellipse (`paintShape`): its box's outline, `size` wide, a rectangle's corners
/// mitred and its ends square, as the canvas's defaults draw them.
fn paint_shape(canvas: &mut Pixmap, s: &crate::drawing::Stroke, t: Transform) {
    let [l, top, r, bottom] = shape_box(s.points.as_deref().unwrap_or(&[]));
    let Some(rect) = Rect::from_ltrb(l as f32, top as f32, r as f32, bottom as f32) else {
        return;
    };
    let path = if s.tool == "rect" {
        Some(PathBuilder::from_rect(rect))
    } else {
        PathBuilder::from_oval(rect)
    };
    let Some(path) = path else { return };
    let pen =
        Pen { width: s.size.unwrap_or(0) as f32, line_join: LineJoin::Miter, ..Pen::default() };
    let paint = solid(s.color.as_deref().unwrap_or("#000000"), BlendMode::SourceOver);
    canvas.stroke_path(&path, &paint, &pen, t, None);
}

/// A pour's covered cells (`paintRuns`): drawn one cell per canvas unit and stretched smoothly, so
/// its edge is soft like a line's.
fn paint_runs(canvas: &mut Pixmap, runs: &[i64], hex: &str, (w, h): (i64, i64), t: Transform) {
    let (Ok(w32), Ok(h32)) = (u32::try_from(w), u32::try_from(h)) else { return };
    let Some(mut cells) = Pixmap::new(w32, h32) else { return };
    let c = colour(hex).to_color_u8().premultiply();
    let data = cells.pixels_mut();
    for run in runs.as_chunks::<3>().0 {
        let row = run[0] * w;
        for x in run[1]..=run[2] {
            if let Some(px) = data.get_mut((row + x) as usize) {
                *px = c;
            }
        }
    }
    let paint = PixmapPaint { quality: FilterQuality::Bilinear, ..PixmapPaint::default() };
    canvas.draw_pixmap(0, 0, cells.as_ref(), &paint, t, None);
}

// ---------------------------------------------------------------------------------------------
// Text

/// Lines of text sit this many sizes apart (`LINE_HEIGHT`).
const LINE_HEIGHT: f32 = 1.25;

/// The face a font token is set in: its own Marquee file, or a stand-in for the four standard
/// stacks a browser fills from the reader's system; an unknown token, as in the browser, is sans.
fn face_file(token: &str) -> &'static str {
    match token {
        "serif" => "zilla-slab.woff2",
        "mono" => "jetbrains-mono.woff2",
        "comic" => "comic-neue.woff2",
        _ => crate::ui::EMBEDDED_FONTS
            .iter()
            .map(|(name, _)| *name)
            .find(|name| name.strip_suffix(".woff2") == Some(token))
            .unwrap_or("radio-canada.woff2"),
    }
}

/// A face, unpacked from its woff2 once and kept for the node's life.
fn face(token: &str) -> Option<FontArc> {
    static FACES: OnceLock<Mutex<HashMap<&'static str, Option<FontArc>>>> = OnceLock::new();
    let file = face_file(token);
    let mut faces = FACES.get_or_init(Default::default).lock().ok()?;
    faces
        .entry(file)
        .or_insert_with(|| {
            let bytes = crate::ui::EMBEDDED_FONTS.iter().find(|(name, _)| *name == file)?.1;
            let ttf = woff2_patched::convert_woff2_to_ttf(&mut &bytes[..]).ok()?;
            FontArc::try_from_vec(ttf).ok()
        })
        .clone()
}

/// A text layer's words (`paintText`): each line at its size, in its face and colour, aligned about
/// its anchor, the first line's top at the anchor.
fn paint_text(canvas: &mut Pixmap, text: &Text, t: Transform) {
    let Some(font) = face(&text.font) else { return };
    let Some(units) = font.units_per_em() else { return };
    let size = text.size as f32;
    let k = size / units;
    let paint = solid(&text.color, BlendMode::SourceOver);
    // The em box's top is the line's top: the baseline sits the face's ascent below it.
    let ascent = font.ascent_unscaled() * k;
    for (i, line) in text.text.split('\n').enumerate() {
        let glyphs: Vec<ab_glyph::GlyphId> = line.chars().map(|c| font.glyph_id(c)).collect();
        let mut advance = 0.0f32;
        let mut xs = Vec::with_capacity(glyphs.len());
        for (j, g) in glyphs.iter().enumerate() {
            if j > 0 {
                advance += font.kern_unscaled(glyphs[j - 1], *g) * k;
            }
            xs.push(advance);
            advance += font.h_advance_unscaled(*g) * k;
        }
        let start = match text.align {
            "center" => text.x as f32 - advance / 2.0,
            "right" => text.x as f32 - advance,
            _ => text.x as f32,
        };
        let baseline = text.y as f32 + i as f32 * size * LINE_HEIGHT + ascent;
        let mut pb = PathBuilder::new();
        for (g, x) in glyphs.iter().zip(xs) {
            let Some(outline) = font.outline(*g) else { continue };
            let at = |p: ab_glyph::Point| (start + x + p.x * k, baseline - p.y * k);
            let mut last: Option<(f32, f32)> = None;
            for curve in &outline.curves {
                let (from, to) = match curve {
                    OutlineCurve::Line(a, b)
                    | OutlineCurve::Quad(a, _, b)
                    | OutlineCurve::Cubic(a, _, _, b) => (at(*a), at(*b)),
                };
                if last != Some(from) {
                    pb.move_to(from.0, from.1);
                }
                match curve {
                    OutlineCurve::Line(..) => pb.line_to(to.0, to.1),
                    OutlineCurve::Quad(_, c, _) => {
                        let c = at(*c);
                        pb.quad_to(c.0, c.1, to.0, to.1)
                    }
                    OutlineCurve::Cubic(_, c1, c2, _) => {
                        let (c1, c2) = (at(*c1), at(*c2));
                        pb.cubic_to(c1.0, c1.1, c2.0, c2.1, to.0, to.1)
                    }
                }
                last = Some(to);
            }
        }
        if let Some(path) = pb.finish() {
            canvas.fill_path(&path, &paint, FillRule::Winding, t, None);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Pictures, and the picture of a drawing

/// The pictures a drawing places, read from the persona's own documents and decoded: AVIF (every
/// still picture) through the node's own decoder, an animation's first frame through `image`.
pub async fn pictures_for(data: &crate::record::store::Store, body: &Body) -> Pictures {
    let mut out = Pictures::new();
    for doc in crate::drawing::images_of(body) {
        let Some(id) = hex::decode(&doc).ok().and_then(|b| <[u8; 16]>::try_from(b).ok()) else {
            continue;
        };
        let Ok(Some(head)) = data.documents().head(&id).await else { continue };
        let Ok(Some(bytes)) = data.documents().blob(head.file_hash).await else { continue };
        let decoded = tokio::task::spawn_blocking(move || decode_picture(&bytes)).await;
        if let Ok(Some(pixmap)) = decoded {
            out.insert(doc, pixmap);
        }
    }
    out
}

fn decode_picture(bytes: &[u8]) -> Option<Pixmap> {
    let img = crate::media::image::decode_avif(bytes)
        .ok()
        .or_else(|| image::load_from_memory(bytes).ok())?
        .to_rgba8();
    let (w, h) = img.dimensions();
    let mut pixmap = Pixmap::new(w, h)?;
    for (px, rgba) in pixmap.pixels_mut().iter_mut().zip(img.pixels()) {
        *px = tiny_skia::ColorU8::from_rgba(rgba[0], rgba[1], rgba[2], rgba[3]).premultiply();
    }
    Some(pixmap)
}

/// A drawing's picture as a PNG, `width` pixels wide (its own size when `None`), its placed
/// pictures read from the persona that holds it.
pub async fn png(
    data: &crate::record::store::Store,
    body_bytes: &[u8],
    width: Option<u32>,
) -> Option<Vec<u8>> {
    let body = crate::drawing::read(body_bytes);
    let pictures = Arc::new(pictures_for(data, &body).await);
    let width = width.unwrap_or_else(|| size_of(&body).0.max(1) as u32);
    tokio::task::spawn_blocking(move || flatten(&body, width, &pictures)?.encode_png().ok())
        .await
        .ok()
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drawing::{read, BASE_LAYER};

    /// The pours as the browser's own `pour.js` works them out (spec/test-vectors/pour-v1.json):
    /// every case's canvas and every covered cell, exactly.
    #[test]
    fn every_pour_covers_what_the_browser_says() {
        let vectors: serde_json::Value =
            serde_json::from_str(include_str!("../../spec/test-vectors/pour-v1.json")).unwrap();
        let cases = vectors["cases"].as_array().unwrap();
        assert!(cases.len() >= 10);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let body = read(case["body"].as_str().unwrap().as_bytes());
            let layer = case["layer"].as_str().unwrap();
            let ops = effective_ops(&body, layer, None);
            let index = ops
                .iter()
                .position(|o| matches!(o, Op::Entry(s) if s.id == case["pour"].as_str().unwrap()))
                .unwrap_or_else(|| panic!("{name}: the pour is among its layer's steps"));
            let (w, h) = size_after(&body, &ops[..index]);
            assert_eq!(
                [w, h],
                [case["size"][0].as_i64().unwrap(), case["size"][1].as_i64().unwrap()],
                "{name}: the canvas"
            );
            let want: Vec<i64> =
                case["runs"].as_array().unwrap().iter().map(|v| v.as_i64().unwrap()).collect();
            assert_eq!(pour_runs(&ops, index, w, h), want, "{name}");
        }
    }

    fn drawing(strokes: &str, extra: &str) -> Body {
        read(
            format!(
                r##"{{"v":1,"width":100,"height":80,"background":"#ffffff"{extra},"strokes":[{strokes}],"undone":[]}}"##
            )
            .as_bytes(),
        )
    }

    fn pixel(p: &Pixmap, x: u32, y: u32) -> [u8; 4] {
        let c = p.pixel(x, y).unwrap().demultiply();
        [c.red(), c.green(), c.blue(), c.alpha()]
    }

    #[test]
    fn a_blank_drawing_is_its_white() {
        let p = flatten(&drawing("", ""), 100, &Pictures::new()).unwrap();
        assert_eq!((p.width(), p.height()), (100, 80));
        assert_eq!(pixel(&p, 50, 40), [255, 255, 255, 255]);
        let p = flatten(&drawing("", ""), 200, &Pictures::new()).unwrap();
        assert_eq!((p.width(), p.height()), (200, 160), "wider keeps the shape");
    }

    #[test]
    fn a_line_lands_where_it_was_drawn_and_an_eraser_cuts_through() {
        let body = drawing(
            r##"{"id":"0000000000000001","t":1,"tool":"brush","color":"#000000","size":6,"points":[10,40,80,0]},
               {"id":"0000000000000002","t":2,"tool":"eraser","size":10,"points":[50,10,0,60]}"##,
            "",
        );
        let p = flatten(&body, 100, &Pictures::new()).unwrap();
        assert_eq!(pixel(&p, 20, 40), [0, 0, 0, 255], "on the line");
        assert_eq!(pixel(&p, 20, 20), [255, 255, 255, 255], "off it");
        assert_eq!(pixel(&p, 50, 40)[3], 0, "the eraser cut through to nothing");
    }

    #[test]
    fn a_pour_fills_inside_its_walls() {
        let body = drawing(
            r##"{"id":"0000000000000001","t":1,"tool":"rect","color":"#000000","size":2,"points":[20,20,80,60]},
               {"id":"0000000000000002","t":2,"tool":"bucket","color":"#ff0000","points":[50,40],"reach":1000}"##,
            "",
        );
        let p = flatten(&body, 100, &Pictures::new()).unwrap();
        assert_eq!(pixel(&p, 50, 40), [255, 0, 0, 255], "inside: red");
        assert_eq!(pixel(&p, 5, 5), [255, 255, 255, 255], "outside: white");
        assert_eq!(pixel(&p, 20, 40)[0..3], [0, 0, 0], "the wall itself");
    }

    #[test]
    fn layers_stack_at_their_opacities_and_hidden_ones_stay_out() {
        let layers = r#","layers":[{"id":"00000000000000aa","n":2,"z":1,"opacity":50,"hidden":false,"t":1},{"id":"00000000000000bb","n":3,"z":2,"opacity":100,"hidden":true,"t":1}]"#;
        let body = drawing(
            r##"{"id":"0000000000000001","t":1,"layer":"00000000000000aa","tool":"brush","color":"#000000","size":20,"points":[30,40,0,0]},
               {"id":"0000000000000002","t":2,"layer":"00000000000000bb","tool":"brush","color":"#0000ff","size":20,"points":[70,40,0,0]}"##,
            layers,
        );
        let p = flatten(&body, 100, &Pictures::new()).unwrap();
        let half = pixel(&p, 30, 40);
        assert!((120..=135).contains(&half[0]), "half-strength black over white: {half:?}");
        assert_eq!(pixel(&p, 70, 40), [255, 255, 255, 255], "the hidden layer is out");
    }

    #[test]
    fn a_grab_moves_and_a_crop_cuts() {
        let body = drawing(
            r##"{"id":"0000000000000001","t":1,"tool":"brush","color":"#000000","size":10,"points":[20,20,0,0]},
               {"id":"0000000000000002","t":2,"tool":"move","dx":30,"dy":10},
               {"id":"0000000000000003","t":3,"tool":"crop","points":[10,10,90,70]}"##,
            "",
        );
        let p = flatten(&body, 80, &Pictures::new()).unwrap();
        assert_eq!((p.width(), p.height()), (80, 60), "the canvas as cropped");
        assert_eq!(pixel(&p, 40, 20)[0..3], [0, 0, 0], "moved by (30, 10), less the crop's corner");
        // Not where it was drawn - and nothing there at all: a grab on the base layer moves its
        // white with everything else before it, as it does in the browser.
        assert_eq!(pixel(&p, 10, 10)[3], 0, "not where it was drawn, and the white moved too");
    }

    #[test]
    fn a_picture_is_placed_where_its_entry_says() {
        let mut red = Pixmap::new(4, 4).unwrap();
        red.fill(Color::from_rgba8(255, 0, 0, 255));
        let doc = "0123456789abcdef0123456789abcdef";
        let mut pictures = Pictures::new();
        pictures.insert(doc.to_string(), red);
        let body = drawing(
            &format!(
                r##"{{"id":"0000000000000001","t":1,"tool":"image","doc":"{doc}","points":[10,10],"w":30,"h":20}}"##
            ),
            "",
        );
        let p = flatten(&body, 100, &pictures).unwrap();
        assert_eq!(pixel(&p, 25, 20), [255, 0, 0, 255], "inside its box");
        assert_eq!(pixel(&p, 60, 50), [255, 255, 255, 255], "outside it");
    }

    #[test]
    fn a_text_layer_sets_its_words_from_its_anchor() {
        let layer = "00000000000000cc";
        let body = drawing(
            "",
            &format!(
                r##","layers":[{{"id":"{layer}","n":2,"z":1,"opacity":100,"hidden":false,"t":1}}],"texts":[{{"layer":"{layer}","t":1,"text":"HH","font":"press-start","size":20,"color":"#000000","align":"left","x":10,"y":10}}]"##
            ),
        );
        assert!(body.texts.len() == 1, "the text reads");
        let p = flatten(&body, 100, &Pictures::new()).unwrap();
        let dark = |x0, y0, x1, y1| {
            (y0..y1)
                .flat_map(|y| (x0..x1).map(move |x| (x, y)))
                .filter(|&(x, y)| pixel(&p, x, y)[0] < 128)
                .count()
        };
        assert!(dark(10, 10, 50, 32) > 40, "ink right of and below the anchor");
        assert_eq!(dark(0, 40, 100, 80), 0, "none below the line");
        assert_eq!(dark(60, 0, 100, 40), 0, "none past two letters");
        assert_eq!(BASE_LAYER.len(), 16);
    }

    #[test]
    fn every_marquee_face_unpacks() {
        for (file, _) in crate::ui::EMBEDDED_FONTS {
            let token = file.strip_suffix(".woff2").unwrap();
            assert!(face(token).is_some(), "{file} reads");
        }
        assert!(face("sans").is_some() && face("serif").is_some() && face("nonesuch").is_some());
    }
}
