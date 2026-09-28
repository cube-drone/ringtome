// The drawing surface (DRAWING.md): one drawing open for drawing on, in the documents app's
// right-hand column - a tools column, then the canvas. The body is the drawing's strokes
// (pure/drawing.js holds the rules); loading, autosaving, the flush on leaving, and reloading when
// another computer changes it are the ordinary document session's (doc/session.js), because a
// drawing's body is a string like any other.
//
// Painting: each layer on a canvas of its own, stacked (DRAWING.md, "Layers"). The white a drawing
// starts on is the BASE LAYER's own fill (the body's `background`), not paper under everything - so
// hiding the base layer, fading it, or erasing on it reveals the transparency floor: the grey
// checkerboard every image editor uses to mean "nothing is here" (Curtis, 2026-09-26). The floor is
// the stage's CSS, never pixels: a picture of the drawing - a thumbnail, a copy, a publication - is
// `flatten`, the layers alone, and where they leave nothing the picture is transparent. The canvas
// is backed at twice the drawing's size so lines stay crisp on dense screens; points are always
// stored in the drawing's own units (800 x 600).
//
// A stroke is pointer-down to pointer-up, drawn live straight onto the canvas as it goes, then added
// to the body - which repaints everything from the body, so what you see is exactly what is saved.
import { h } from 'preact';
import { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { useDocSession } from './session.js';
import { Chip, NavChips } from './chips.js';
import { Annotations } from './annotations.js';
import { cachedDoc, rememberDoc } from '../mirror/doccache.js';
import { api, xhrUpload, saveFile } from '../net.js';
import { CopyIntoModal } from '../copyinto.js';
import { ColourPicker } from './colourpicker.js';
import { useColWidths, useColTucks, PaneHead, Rail } from '../panes.js';
import { Icons } from '../icons.js';
import { t } from '../i18n.js';
import {
    readBody,
    writeBody,
    addStroke,
    undo,
    strokeId,
    encodeSamples,
    decodePoints,
    pressureWidth,
    MAX_SIZE,
    FIXED_COLOURS,
    recentColours,
    BASE_LAYER,
    layersOf,
    addLayer,
    setLayer,
    moveLayer,
    matricesOf,
    IDENTITY,
    toFixed,
    fromFixed,
    effectiveOps,
    deleteLayer,
    duplicateLayer,
    MAX_NAME_BYTES,
    MAX_REACH,
    addImage,
    imagesOf,
    shapeEntry,
    shapeBox,
    sizeOf,
    sizeAfter,
    cropEntry,
    dropIndex,
    pictureFileName,
    textOf,
    addTextLayer,
    setText,
    DEFAULT_FONT,
    MIN_TEXT_SIZE,
    MAX_TEXT_BYTES,
} from '../pure/drawing.js';
import { PublishBar } from './publishbar.js';
import { FONTS } from '@cube-drone/marquee-react-renderer';
import { wallsOf, pourField, pourRuns, runsOf, STEP } from '../pure/pour.js';
import { Navigator, viewOf } from './navigator.js';
import { ImagePickModal } from './imagepick.js';
import { frameOf, frameThrough, gripAt, gestureMatrix, paintedBox, dragBox, dragBoxAt, fitBox } from '../pure/transform.js';
import { clampZoom, fitSize, centreOf, scrollToCentre } from '../pure/viewport.js';
import { FILES_BUCKET } from '../pure/apps.js';
import { FLAT_FROM, FLAT_VERSION, flatVersion, findFlatCopy } from '../pure/flatcopy.js';
import { openMirror } from '../mirror.js';
import { cachedThumb, rememberThumb } from '../mirror/thumbcache.js';

const html = htm.bind(h);

/// The canvas's backing resolution, as a multiple of the drawing's own units.
const BACKING = 2;

// ---------------------------------------------------------------------------------------------
// Painting

/// Paint one stroke. `points` are absolute [x, y]; `pressure` (0..100 per point) makes a pen stroke's
/// width follow the pen - painted segment by segment, each as wide as the average of its two ends,
/// with round caps so the joins close. Without it, one path at one width.
function paintStroke(ctx, stroke, scale, points = decodePoints(stroke.points), pressure = stroke.pressure) {
    ctx.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = ctx.fillStyle = stroke.tool === 'eraser' ? '#000' : stroke.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const width = (i) => stroke.size * scale * (pressure ? pressureWidth(pressure[i]) : 1);
    if (points.length === 1) {
        ctx.beginPath();
        ctx.arc(points[0][0] * scale, points[0][1] * scale, width(0) / 2, 0, Math.PI * 2);
        ctx.fill();
        return;
    }
    if (!pressure) {
        ctx.lineWidth = width(0);
        ctx.beginPath();
        ctx.moveTo(points[0][0] * scale, points[0][1] * scale);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0] * scale, points[i][1] * scale);
        ctx.stroke();
        return;
    }
    for (let i = 1; i < points.length; i++) {
        ctx.lineWidth = (width(i - 1) + width(i)) / 2;
        ctx.beginPath();
        ctx.moveTo(points[i - 1][0] * scale, points[i - 1][1] * scale);
        ctx.lineTo(points[i][0] * scale, points[i][1] * scale);
        ctx.stroke();
    }
}

/// The pictures drawings refer to (DRAWING.md, "Images"), fetched once each and kept: `root/doc` ->
/// { img, ready, promise }. The pixels live in the picture's own document, served like any of the
/// person's media.
const pictures = new Map();
const NO_PICTURES = new Map();

function fetchPicture(root, doc) {
    const key = `${root}/${doc}`;
    let held = pictures.get(key);
    if (!held) {
        const img = new Image();
        held = { img, ready: false };
        held.promise = (async () => {
            img.src = `/api/identity/${root}/docs/${doc}/body`;
            await img.decode();
            held.ready = true;
        })().catch(() => {
            // Not here (deleted, or not yet synced to this computer): painted as nothing, and
            // forgotten, so the next look tries again.
            pictures.delete(key);
        });
        pictures.set(key, held);
    }
    return held;
}

/// Hold a picture already in hand - one this page just made - so it paints at once, before the
/// node has finished taking it in and could serve it.
function holdPicture(root, doc, img) {
    pictures.set(`${root}/${doc}`, { img, ready: true, promise: Promise.resolve() });
}

/// The flat copies this page has made, by `root/drawing/version` - found at once, before their
/// annotations have come back through the mirror.
const flatCopies = new Map();

/// Copy a drawing into another as a picture (Curtis, 2026-09-27: "it would copy them in as a single
/// flat layer"): the chosen drawing flattened, as it stands - its own pictures and fonts waited for -
/// and saved as a new picture in the person's media, titled for it; the returned picture is placed
/// like any other. A COPY, never a link: a drawing that painted other drawings live would repaint
/// whatever they had since become, and a chain of them could loop - a snapshot is one more picture,
/// merged like any. Returns `{ doc, width, height, title }` for `addImage` - and the copy is a
/// still picture, filed in "files" (an embed, doc/pickref.js, spells it as one).
export async function drawingAsPicture(root, sourceId) {
    const detail = await api(`/api/identity/${root}/docs/${sourceId}`);
    if (detail.body == null) throw new Error(t('doc.drawing.not-here-yet', 'that drawing has not reached this computer yet - try again in a moment'));
    const source = readBody(detail.body);
    const [width, height] = sizeOf(source);
    // Cut once per version (pure/flatcopy.js): an unchanged drawing hands back the copy it already
    // has - found through its annotations, or made moments ago on this page and not yet echoed back.
    const version = flatVersion(detail);
    const madeKey = `${root}/${sourceId}/${version}`;
    const held = findFlatCopy(await openMirror(root).docs.toArray(), sourceId, version);
    if (held) return { doc: held.doc_id, width, height, title: held.title || detail.title || '' };
    if (flatCopies.has(madeKey)) return { ...flatCopies.get(madeKey), width, height };
    const canvas = flatten(source, width, await loadPictures(root, source));
    const blob = await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not make a picture of the drawing'))), 'image/png')
    );
    const title = detail.title || t('doc.drawing.untitled', 'untitled');
    const made = await xhrUpload(`/api/identity/${root}/docs/binary?title=${encodeURIComponent(title)}`, blob);
    // Filed where every upload lives (pure/apps.js FILES_BUCKET), not left unfiled - and marked as
    // this drawing's copy at this version, so the next pick of it finds this one.
    await api(`/api/identity/${root}/docs/${made.doc_id}/buckets/${FILES_BUCKET}`, { method: 'PUT' });
    const note = (field, value) =>
        api(`/api/identity/${root}/docs/${made.doc_id}/annotations/fields/${field}`, { method: 'PUT', body: JSON.stringify({ value }) });
    await note(FLAT_FROM, sourceId);
    await note(FLAT_VERSION, version);
    flatCopies.set(madeKey, { doc: made.doc_id, title });
    const img = new Image();
    img.src = URL.createObjectURL(blob);
    await img.decode();
    holdPicture(root, made.doc_id, img);
    return { doc: made.doc_id, width, height, title };
}

/// The drawing's pictures that are ready now, by document id - what painting draws.
export function picturesNow(root, drawing) {
    const out = new Map();
    for (const doc of imagesOf(drawing)) {
        const held = pictures.get(`${root}/${doc}`);
        if (held && held.ready) out.set(doc, held.img);
    }
    return out;
}

/// Text (DRAWING.md, "Text"): the Marquee font list's faces. The four standard stacks need nothing;
/// the rest are served by the node and load lazily - a canvas that draws before a face has loaded
/// draws in the fallback, without a word - so a drawing asks for its faces (`fontsWanted`) and is
/// repainted when they come.
const GENERIC_FAMILIES = new Set(['sans-serif', 'serif', 'monospace']);
const familyOf = (token) => FONTS[token] || FONTS[DEFAULT_FONT];
const fontStack = (token) => {
    const family = familyOf(token);
    return GENERIC_FAMILIES.has(family) ? family : `"${family}", sans-serif`;
};
/// Lines of text sit this many sizes apart.
const LINE_HEIGHT = 1.25;

/// The faces a drawing's texts use that the page has not loaded yet.
function fontsWanted(drawing) {
    if (typeof document === 'undefined' || !document.fonts) return [];
    const faces = new Set((drawing.texts || []).map((r) => familyOf(r.font)).filter((f) => !GENERIC_FAMILIES.has(f)));
    return [...faces].filter((f) => !document.fonts.check(`16px "${f}"`));
}

function loadFonts(drawing) {
    return Promise.all(fontsWanted(drawing).map((f) => document.fonts.load(`16px "${f}"`).catch(() => null)));
}

/// Paint a text layer's words: each line at its size, in its face and colour, aligned about its
/// anchor, the first line's top at the anchor.
function paintText(ctx, text, scale) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = text.color;
    ctx.textAlign = text.align;
    ctx.textBaseline = 'top';
    ctx.font = `${text.size * scale}px ${fontStack(text.font)}`;
    text.text.split('\n').forEach((line, i) => ctx.fillText(line, text.x * scale, (text.y + i * text.size * LINE_HEIGHT) * scale));
}

/// Fetch every picture the drawing refers to, and resolve when each has arrived or failed: what a
/// picture OF the drawing (a thumbnail, a copy, a publication) waits for, so it is never made
/// without them.
export async function loadPictures(root, drawing) {
    // ...and every face its texts are set in: a picture made before they load would be in the wrong one.
    await Promise.all([...imagesOf(drawing).map((doc) => fetchPicture(root, doc).promise), loadFonts(drawing)]);
    return picturesNow(root, drawing);
}

/// What each pour covers (pure/pour.js), kept by the pour and everything painted before it on its
/// layer - entries never change under their ids, so the same ids are the same answer. A repaint
/// happens on every stroke; working each pour out again every time would not keep up.
const pourCache = new Map();
const POUR_CACHE_SIZE = 256;
function pourRunsCached(ops, index, drawing) {
    const steps = ops.slice(0, index + 1).map((o) => o.id || o.tool);
    // The canvas as the pour found it: a pour before a crop spread over the canvas before it.
    const [w, h] = sizeAfter(drawing, ops.slice(0, index));
    const key = [drawing.width, drawing.height, ...steps].join(',');
    let runs = pourCache.get(key);
    if (!runs) {
        runs = pourRuns(ops, index, w, h);
        if (pourCache.size >= POUR_CACHE_SIZE) pourCache.delete(pourCache.keys().next().value);
        pourCache.set(key, runs);
    }
    return { runs, size: [w, h] };
}

/// Paint covered cells (row runs, one cell per canvas unit, on a grid `size` = [width, height]) in
/// `colour`, `scale` pixels to a unit: drawn at the grid's own size and stretched smoothly, so a
/// fill's edge is soft, like a line's.
function paintRuns(ctx, runs, colour, [w, h], scale) {
    const cells = blankCanvas(w, h);
    const cctx = cells.getContext('2d');
    const image = cctx.createImageData(w, h);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16));
    for (let k = 0; k < runs.length; k += 3) {
        const row = runs[k] * w;
        for (let x = runs[k + 1]; x <= runs[k + 2]; x++) {
            const i = (row + x) * 4;
            image.data[i] = r;
            image.data[i + 1] = g;
            image.data[i + 2] = b;
            image.data[i + 3] = 255;
        }
    }
    cctx.putImageData(image, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(cells, 0, 0, w * scale, h * scale);
}

/// Paint a rectangle or an ellipse (Curtis, 2026-09-27): its box's outline, `size` wide - the
/// rectangle's corners mitred, sharp as it was asked for.
function paintShape(ctx, shape, scale) {
    const [l, top, r, bottom] = shapeBox(shape.points).map((n) => n * scale);
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = shape.color;
    ctx.lineWidth = shape.size * scale;
    ctx.beginPath();
    if (shape.tool === 'rect') {
        ctx.lineJoin = 'miter';
        ctx.rect(l, top, r - l, bottom - top);
    } else {
        ctx.ellipse((l + r) / 2, (top + bottom) / 2, (r - l) / 2, (bottom - top) / 2, 0, 0, Math.PI * 2);
    }
    ctx.stroke();
}

/// Paint whichever entry this is that makes marks - a stroke or a shape.
function paintMark(ctx, op, scale) {
    if (op.tool === 'rect' || op.tool === 'ellipse') paintShape(ctx, op, scale);
    else paintStroke(ctx, op, scale);
}

/// One layer onto a canvas of its own (DRAWING.md, "Layers"): transparent wherever the layer has
/// nothing, so an eraser stroke erases only the layer it is on. The base layer starts filled with
/// the drawing's `background` - the white a drawing begins on - so erasing on it cuts through to
/// transparency like any other layer.
export function paintLayer(canvas, drawing, layerId, images = NO_PICTURES) {
    const ctx = canvas.getContext('2d');
    const scale = canvas.width / sizeOf(drawing)[0];
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // What the layer paints (pure/drawing.js, `effectiveOps`): the base layer's fill first, a copy's
    // source as it stood, then its own strokes. A grab (a `move`) shifts everything before it, and a
    // transform turns, scales or slants it: each step is painted through the matrices after it
    // (`matricesOf`) - redrawn, never warped as a picture, so it stays sharp - and a layer grabbed
    // away and back loses nothing at the edge.
    const ops = effectiveOps(drawing, layerId);
    const { each } = matricesOf(ops);
    ops.forEach((op, i) => {
        if (op.tool === 'move' || op.tool === 'transform' || op.tool === 'crop') return;
        ctx.save();
        const m = each[i];
        ctx.transform(m[0], m[1], m[2], m[3], m[4] * scale, m[5] * scale);
        if (op.tool === 'fill') {
            // The canvas the drawing began as, wherever the crops since have left it.
            ctx.fillStyle = drawing.background;
            ctx.fillRect(0, 0, drawing.width * scale, drawing.height * scale);
        } else if (op.tool === 'image') {
            // A picture not here yet paints as nothing; the surface repaints when it arrives.
            const img = images.get(op.doc);
            if (img) {
                ctx.globalCompositeOperation = 'source-over';
                ctx.imageSmoothingEnabled = true;
                ctx.drawImage(img, op.points[0] * scale, op.points[1] * scale, op.w * scale, op.h * scale);
            }
        } else if (op.tool === 'rect' || op.tool === 'ellipse') {
            paintShape(ctx, op, scale);
        } else if (op.tool === 'text') {
            paintText(ctx, op, scale);
        } else if (op.tool === 'bucket') {
            const { runs, size } = pourRunsCached(ops, i, drawing);
            paintRuns(ctx, runs, op.color, size, scale);
        } else {
            paintStroke(ctx, op, scale);
        }
        ctx.restore();
    });
    ctx.restore();
}

function blankCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

/// Every layer painted onto a canvas of its own, `width` pixels wide: a Map of layer id to canvas.
export function paintLayers(drawing, width, images = NO_PICTURES) {
    const [w, h] = sizeOf(drawing);
    const height = Math.round((width * h) / w);
    const canvases = new Map();
    for (const layer of layersOf(drawing)) {
        const canvas = blankCanvas(width, height);
        paintLayer(canvas, drawing, layer.id, images);
        canvases.set(layer.id, canvas);
    }
    return canvases;
}

/// Stack the layers onto `target`, bottom first, each at its opacity, the hidden ones left out, over
/// nothing - on the screen the floor shows through from the stage behind; in a picture, nothing
/// stays transparent. `shift` - `{ layer, m }`, a matrix in the drawing's units - draws one layer
/// moved or transformed, which is how a grab or a transform shows before it lets go.
export function composite(target, drawing, canvases, shift = null) {
    const ctx = target.getContext('2d');
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, target.width, target.height);
    for (const layer of layersOf(drawing)) {
        const canvas = canvases.get(layer.id);
        if (layer.hidden || !canvas) continue;
        ctx.globalAlpha = layer.opacity / 100;
        const moved = shift && shift.layer === layer.id;
        const k = target.width / sizeOf(drawing)[0];
        const m = moved ? shift.m : IDENTITY;
        ctx.setTransform(m[0], m[1], m[2], m[3], m[4] * k, m[5] * k);
        ctx.drawImage(canvas, 0, 0, target.width, target.height);
    }
    ctx.restore();
}

/// A picture of the drawing, `width` pixels wide: the visible layers, stacked. What a thumbnail, a
/// copy into a notebook and a publication are all made from - so a hidden layer is left out of all
/// three, as it is out of sight, and wherever the layers leave nothing the picture is transparent
/// (webp and png keep it, and so does the node's AVIF).
export function flatten(drawing, width = sizeOf(drawing)[0], images = NO_PICTURES) {
    const [w, h] = sizeOf(drawing);
    const out = blankCanvas(width, Math.round((width * h) / w));
    composite(out, drawing, paintLayers(drawing, width, images));
    return out;
}

/// The drawing as an image file: webp where the browser can write one, png where it cannot (Safari,
/// and so the macOS app's webview). Either is only how it travels - the node keeps every picture as
/// AVIF (media/image.rs).
export async function flattenToBlob(root, drawing) {
    const canvas = flatten(drawing, sizeOf(drawing)[0], await loadPictures(root, drawing));
    return new Promise((resolve, reject) =>
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('could not make a picture of the drawing'))), 'image/webp', 0.92)
    );
}

/// Download the drawing as a PNG (Curtis, 2026-09-27): the visible layers, stacked - transparent
/// wherever they leave nothing, as every picture of it is - at the resolution the canvas is drawn
/// at, `BACKING` pixels to a unit, and named for its title. It waits for its pictures and faces, as a
/// publication does. Saved the way the spare key is (net.js `saveFile`).
export async function downloadPng(root, drawing, title) {
    const canvas = flatten(drawing, sizeOf(drawing)[0] * BACKING, await loadPictures(root, drawing));
    const blob = await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not make a picture of the drawing'))), 'image/png')
    );
    await saveFile(pictureFileName(title), blob);
}

/// Copy a drawing into a notebook as a PICTURE (DRAWING.md): flattened, uploaded through the ordinary
/// image door - the node keeps it as an AVIF image document - and filed into the notebook. Returns
/// the new image's id. A new notebook is defined first, as a Writer notebook.
export async function copyPictureInto(root, drawing, title, bucket, isNew) {
    if (isNew) {
        await api(`/api/identity/${root}/buckets`, { method: 'POST', body: JSON.stringify({ name: bucket, app: 'default' }) });
    }
    const picture = await flattenToBlob(root, drawing);
    const made = await xhrUpload(`/api/identity/${root}/docs/binary?title=${encodeURIComponent(title || 'drawing')}`, picture);
    await api(`/api/identity/${root}/docs/${made.doc_id}/buckets/${encodeURIComponent(bucket)}`, { method: 'PUT' });
    return made.doc_id;
}

/// Publish a drawing as a picture (DRAWING.md): flattened here, laundered and posted by the node's
/// drawing door - the post is the picture, titled as the drawing is. Publishing again replaces it
/// within the post's day; after that the node says to take it down and post again. `extra` is the
/// publish bar's two wishes (turn off comments, trusted only); the timezone offset resolves a claimed
/// date the way Writer's publish does (PUBLISH.md ruling 7).
export async function publishDrawing(root, docId, drawing, extra = {}) {
    const picture = await flattenToBlob(root, drawing);
    const query = new URLSearchParams({ tz_offset_min: String(-new Date().getTimezoneOffset()) });
    if (extra.settled) query.set('settled', 'true');
    if (extra.trusted_only) query.set('trusted_only', 'true');
    return xhrUpload(`/api/identity/${root}/docs/${docId}/publish/drawing?${query}`, picture);
}

/// Duplicate a drawing (DRAWING.md): the node's own private copy door, strokes and tags and all, into
/// the Drawing app's bucket. Returns the new drawing's id.
export async function duplicateDrawing(root, docId) {
    const made = await api(`/api/identity/${root}/docs/copy`, {
        method: 'POST',
        body: JSON.stringify({ author: root, doc_id: docId, bucket: 'drawing', new: false, private: true }),
    });
    return made.doc_id;
}

// ---------------------------------------------------------------------------------------------
// The tools, remembered across drawings (not across page loads): switching drawings keeps your brush.

let rememberedTools = {
    tool: 'brush',
    brushSize: 12,
    eraserSize: 40,
    shapeSize: 6,
    pourSpeed: 5,
    color: '#1f1a17',
    font: DEFAULT_FONT,
    textSize: 48,
    align: 'left',
};

/// What a text layer takes (Curtis, 2026-09-27): its words, and moving it about - the rest of the
/// tools are greyed out while one is current. Crop cuts every layer, so it stays, and the framing
/// tools touch no layer at all.
const TEXT_LAYER_TOOLS = ['text', 'transform', 'grab', 'crop', 'profile', 'banner'];

/// The framing tools (Curtis, 2026-09-28): a crop whose shape is fixed, and whose button sets what
/// the box holds as your profile picture or your banner rather than cutting the canvas. Nothing is
/// recorded in the drawing - the box is flattened and sent to the persona's own door, as a picture
/// picked on the profile page is. `ratio` is width to height: a square for the picture (the
/// heptagon covers it), and the banner's own shape, the page's 800px by its 250px (person.css,
/// `.person-card-hero`).
const FRAMING_TOOLS = { profile: { ratio: 1, door: 'avatar' }, banner: { ratio: 800 / 250, door: 'banner' } };
/// The longest side sent: the box at the canvas's backing, never more (the node crushes it to its
/// own bound either way).
const FRAMED_MAX_SIDE = 1600;
/// The largest a text can be set from the slider (the body allows more).
const TEXT_SLIDER_MAX = 200;

/// The tools dragged out corner to corner (Curtis, 2026-09-27), sharing one line width.
const SHAPE_TOOLS = ['line', 'rect', 'ellipse'];
/// The tools that take a size, and those that take a colour (Curtis, 2026-09-27: "tool options
/// are contextual and live with their associated tool").
const SIZED_TOOLS = ['brush', 'eraser', ...SHAPE_TOOLS];
const COLOURED_TOOLS = ['brush', ...SHAPE_TOOLS, 'bucket', 'text'];

/// The paint bucket's pour speed (1..10) as canvas units a second: each step half again faster, from
/// a slow creep to a rush across the canvas in about a second.
const POUR_SPEEDS = 10;
const pourRate = (speed) => 20 * Math.pow(1.5, speed - 1);
/// The puddle a pour starts as, the moment it is dropped, in canvas units.
const DROP = 3;

/// How near a corner or an edge of the transform frame a press must be to take hold of it, in
/// screen pixels; and how big the corner handles are drawn.
const GRIP_PX = 8;
const HANDLE_PX = 9;

/// The rotate cursor (Curtis, 2026-09-27: the crosshair "doesn't feel too representative"): CSS has
/// no rotate cursor, so it is Phosphor's ArrowClockwise - the same icon set as everything else - bold
/// weight, black with a white rim so it reads on any paint, as a 24-pixel image with its hot spot in
/// the middle. A browser that cannot draw it falls back to the crosshair.
const ARROW_CLOCKWISE =
    'M244,56v48a12,12,0,0,1-12,12H184a12,12,0,1,1,0-24H201.1l-19-17.38c-.13-.12-.26-.24-.38-.37A76,76,0,1,0,127,204h1a75.53,75.53,0,0,0,52.15-20.72,12,12,0,0,1,16.49,17.45A99.45,99.45,0,0,1,128,228h-1.37A100,100,0,1,1,198.51,57.06L220,76.72V56a12,12,0,0,1,24,0Z';
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="-20 -20 296 296"><path d="${ARROW_CLOCKWISE}" fill="black" stroke="white" stroke-width="28" stroke-linejoin="round" paint-order="stroke"/></svg>`
)}") 12 12, crosshair`;

/// The pointer over the transform frame, by what a press there would take hold of.
const GRIP_CURSORS = {
    corner: ['nwse-resize', 'nesw-resize', 'nwse-resize', 'nesw-resize'],
    edge: ['ns-resize', 'ew-resize', 'ns-resize', 'ew-resize'],
};
const gripCursor = (grip) =>
    grip.kind === 'corner' || grip.kind === 'edge' ? GRIP_CURSORS[grip.kind][grip.i] : grip.kind === 'inside' ? 'move' : ROTATE_CURSOR;

/// The room left around the drawing when it fits the stage, in CSS pixels: its shadow shows.
const STAGE_GAP = 16;

function useTools() {
    const [tools, setTools] = useState(rememberedTools);
    const update = (change) =>
        setTools((current) => {
            rememberedTools = { ...current, ...change };
            return rememberedTools;
        });
    return [tools, update];
}

// ---------------------------------------------------------------------------------------------
// The list's thumbnails

const thumbCache = new Map(); // `${doc_id}:${head}` -> data URL
const THUMB_WIDTH = 120;

/// A drawing's thumbnail for its list row, drawn here from its strokes - the node keeps thumbnails
/// only for pictures that came through its image ingest, which a drawing never does (DRAWING.md).
/// Kept per head, so a drawing redraws its thumbnail exactly when it changes.
export const DrawingThumb = ({ root, doc, big }) => {
    const key = `${doc.doc_id}:${doc.head}`;
    const [src, setSrc] = useState(thumbCache.get(key) || null);
    // Kept? 'looking' until this browser's table has answered, then 'kept' or 'missing'.
    const [kept, setKept] = useState(thumbCache.has(key) ? 'kept' : 'looking');
    const [seen, setSeen] = useState(false);
    const holder = useRef(null);

    // 1. The kept thumbnail - this page's, else this browser's (mirror/thumbcache.js) - on screen
    //    or not: a lookup is cheap, and a reload repaints nothing unchanged.
    useEffect(() => {
        if (thumbCache.has(key)) {
            setSrc(thumbCache.get(key));
            setKept('kept');
            return undefined;
        }
        let live = true;
        setSrc(null);
        setKept('looking');
        cachedThumb(root, doc.doc_id, doc.head).then((url) => {
            if (!live) return;
            if (url) {
                thumbCache.set(key, url);
                setSrc(url);
            }
            setKept(url ? 'kept' : 'missing');
        });
        return () => {
            live = false;
        };
    }, [root, key]); // eslint-disable-line react-hooks/exhaustive-deps

    // 2. Painting waits for the row to come into view (Curtis, 2026-09-27): a list of thousands of
    //    drawings paints the handful on screen, and the rest as they are scrolled to.
    useEffect(() => {
        if (seen || src) return undefined;
        const el = holder.current;
        if (!el || typeof IntersectionObserver === 'undefined') {
            setSeen(true);
            return undefined;
        }
        const watch = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting)) {
                    setSeen(true);
                    watch.disconnect();
                }
            },
            { rootMargin: '200px' }
        );
        watch.observe(el);
        return () => watch.disconnect();
    }, [seen, src]);

    // 3. Paint - on screen, and not kept - from the drawing's body, then keep it.
    useEffect(() => {
        if (!seen || kept !== 'missing') return undefined;
        let live = true;
        (async () => {
            let detail = await cachedDoc(root, doc.doc_id);
            if (!detail) {
                detail = await api(`/api/identity/${root}/docs/${doc.doc_id}`);
                rememberDoc(root, doc.doc_id, detail);
            }
            if (detail.body == null) return;
            const body = readBody(detail.body);
            // WebP where the browser can write it (a few KB), PNG where it cannot.
            const url = flatten(body, THUMB_WIDTH, await loadPictures(root, body)).toDataURL('image/webp', 0.85);
            thumbCache.set(key, url);
            rememberThumb(root, doc.doc_id, doc.head, url);
            if (live) {
                setSrc(url);
                setKept('kept');
            }
        })().catch(() => {});
        return () => {
            live = false;
        };
    }, [seen, kept, root, key]); // eslint-disable-line react-hooks/exhaustive-deps

    return src
        ? html`<img class=${big ? 'note-row-thumb note-row-thumb-big drawing-thumb drawing-floor' : 'note-row-thumb drawing-thumb drawing-floor'} src=${src} alt="" />`
        : html`<span ref=${holder} class="note-row-thumb drawing-thumb drawing-thumb-empty"><${Icons.drawing} /></span>`;
};

// ---------------------------------------------------------------------------------------------
// The layers column's pieces: the field a name is typed into, and the thumbnails - each layer alone,
// drawn from its own canvas.

// The field a layer's name is typed into, in the name's place: focused and selected on arrival, kept
// on Enter or blur, dropped on Escape. `done` stops the blur that follows an Escape from keeping it.
const LayerNameField = ({ layer, onCommit, onCancel }) => {
    const ref = useRef(null);
    const done = useRef(false);
    useEffect(() => {
        ref.current.focus();
        ref.current.select();
    }, []);
    const finish = (keep) => {
        if (done.current) return;
        done.current = true;
        if (keep) onCommit(layer, ref.current.value);
        else onCancel();
    };
    return html`<input
        ref=${ref}
        class="drawing-layer-name-field"
        value=${layer.name || ''}
        placeholder=${t('doc.drawing.layer-n', 'layer {n}', { n: layer.n })}
        maxlength=${MAX_NAME_BYTES}
        aria-label=${t('doc.drawing.layer-name', 'layer name')}
        onClick=${(e) => e.stopPropagation()}
        onKeyDown=${(e) => {
            if (e.key === 'Enter') finish(true);
            else if (e.key === 'Escape') finish(false);
        }}
        onBlur=${() => finish(true)}
    />`;
};

const LayerThumb = ({ source, painted }) => {
    const ref = useRef(null);
    useEffect(() => {
        const canvas = ref.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (source) ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    }, [source, painted]);
    // The canvas's own shape - a cropped drawing need not be 4:3 - held inside a small square.
    const height = source ? Math.max(1, Math.round((64 * source.height) / source.width)) : 48;
    return html`<canvas ref=${ref} class="drawing-layer-thumb drawing-floor" width="64" height=${height}></canvas>`;
};

// ---------------------------------------------------------------------------------------------
// The surface

export const DrawingSurface = ({ root, docId, nav, onDeleted }) => {
    const session = useDocSession(root, docId, { onDeleted });
    const loc = useLocation();
    const [copying, setCopying] = useState(false);
    const [actionError, setActionError] = useState(null);
    const [busy, setBusy] = useState(false);

    // The publish bar (doc/publishbar.js), shared with Writer: the drawing's door, and "does it
    // differ?" answered by the node's note of which version it last published (`published_head`) -
    // any stroke since moves the drawing's head past it.
    const publishThis = async (extra) => {
        await session.save(); // the node publishes the drawing's saved state as its draft
        return publishDrawing(root, docId, drawing, extra || {});
    };
    const row = session.row;
    const differs = !!(row && row.fields && row.fields.published_head && row.head !== row.fields.published_head);

    const duplicate = async () => {
        setBusy(true);
        setActionError(null);
        try {
            await session.save(); // the duplicate is of the drawing as it stands, unsaved strokes too
            const made = await duplicateDrawing(root, docId);
            loc.route(`/home/drawing/${made}`); // the copy opens, in the Drawing app
        } catch (e) {
            setActionError(e.message);
        } finally {
            setBusy(false);
        }
    };
    const drawing = useMemo(() => readBody(session.body), [session.body]);
    // The canvas as it stands (DRAWING.md, "Cropping"): the body's own size, cut by its crops.
    const [W, H] = useMemo(() => sizeOf(drawing), [drawing]);
    const [tools, setTools] = useTools();
    const [showMeta, setShowMeta] = useState(false);
    // The tags panel is Writer's dropdown, anchored to the title row (`.reader-head` is its
    // positioned parent) and dismissed the way Writer's is: a mousedown outside it and its chip.
    const metaChipRef = useRef(null);
    const metaPanelRef = useRef(null);
    useEffect(() => {
        if (!showMeta) return undefined;
        const onDown = (e) => {
            const inChip = metaChipRef.current && metaChipRef.current.contains(e.target);
            const inPanel = metaPanelRef.current && metaPanelRef.current.contains(e.target);
            if (!inChip && !inPanel) setShowMeta(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [showMeta]);
    const canvasRef = useRef(null);
    const cursorRef = useRef(null);
    const live = useRef(null); // the stroke being drawn: { stroke, pen, samples }
    const opened = session.status !== 'opening' && session.status !== 'waiting';
    // Once this drawing has opened it stays on screen through a reload (the lookout fetching the
    // node's newer version, doc/session.js), as Writer's editor does: a reload passes back through
    // 'opening', and taking the canvas away for it made the whole drawing flash blank (Curtis,
    // 2026-09-27: "every few seconds the whole drawing will flash"). `opened` still gates drawing -
    // a stroke begun mid-reload would land on a body about to be replaced.
    const shownFor = useRef(null);
    if (opened) shownFor.current = docId;
    const shown = opened || shownFor.current === docId;

    const { tucked, toggleTuck } = useColTucks(root, 'drawing', []);
    const { resizer, colStyle } = useColWidths(root, 'drawing', ['tools', 'layers'], { tools: 170, layers: 170 });

    // The layers (DRAWING.md, "Layers"): bottom of the stack first. The CURRENT layer is the one a
    // new stroke lands on and the opacity slider speaks for - the top one until another is picked,
    // and the top one again if the picked one stops existing (a merge can do that).
    const layers = useMemo(() => layersOf(drawing), [drawing]);
    const [currentId, setCurrentId] = useState(null);
    const [renaming, setRenaming] = useState(null); // the id of the layer whose name is being typed
    const [pickingImage, setPickingImage] = useState(false);
    // A picture from the person's media (DRAWING.md, "Images"), on a new layer at the top - which
    // becomes the current layer, so a grab moves the picture straight away.
    // A drawing chosen is copied in flat first (`drawingAsPicture`); by the time that lands the
    // drawing may have moved on, so the picture goes onto the body as it is THEN.
    const latest = useRef(drawing);
    latest.current = drawing;
    const placePicture = async (picture) => {
        setPickingImage(false);
        let placed = picture;
        if (picture.format === 'drawing') {
            setBusy(true);
            setActionError(null);
            try {
                placed = await drawingAsPicture(root, picture.doc);
            } catch (e) {
                setActionError(e.message);
                return;
            } finally {
                setBusy(false);
            }
        }
        const layerId = strokeId();
        changeLayers(addImage(latest.current, placed, layerId, strokeId(), Date.now()));
        setCurrentId(layerId);
    };
    const current = layers.find((l) => l.id === currentId) || layers[layers.length - 1];
    // A text layer (DRAWING.md, "Text"): its one text, and the tools it takes.
    const currentText = current ? textOf(drawing, current.id) : null;
    const toolAllowed = (tool) => !currentText || TEXT_LAYER_TOOLS.includes(tool);

    // Every layer on a canvas of its own, repainted from the body whenever it changes - every save,
    // undo, layer change and sync - and stacked onto the screen. A stroke being drawn paints onto
    // its own layer's canvas as it goes and restacks, so a layer above still covers it.
    const layerCanvases = useRef(new Map());
    const [picturesArrived, setPicturesArrived] = useState(0);
    const [painted, setPainted] = useState(0); // bumps when the layer canvases change: the thumbnails follow
    const restack = (shift = null) => {
        const canvas = canvasRef.current;
        if (canvas) composite(canvas, drawing, layerCanvases.current, shift);
    };
    const [grabbing, setGrabbing] = useState(false); // the grab tool's hand, open or closed
    // Painted before the browser shows the frame (a layout effect, not an effect): a canvas that
    // has just appeared - on opening, or the column brought back - is never seen empty.
    useLayoutEffect(() => {
        if (!shown) return;
        layerCanvases.current = paintLayers(drawing, W * BACKING, picturesNow(root, drawing));
        restack();
        setPainted((n) => n + 1);
    }, [drawing, shown, picturesArrived]); // eslint-disable-line react-hooks/exhaustive-deps
    // The pictures the drawing refers to (DRAWING.md, "Images"): fetched as the drawing asks for
    // them, and a repaint when any that was missing arrives.
    useEffect(() => {
        const missing = imagesOf(drawing).length !== picturesNow(root, drawing).size || fontsWanted(drawing).length > 0;
        if (!missing) return undefined;
        let live = true;
        loadPictures(root, drawing).then(() => live && setPicturesArrived((n) => n + 1));
        return () => {
            live = false;
        };
    }, [drawing, root]);

    // The view (DRAWING.md, "The navigator"): the stage scrolls, and the drawing on it is the size
    // that just fits, times the zoom. The fit follows the stage's size; a zoom keeps the point at
    // the stage's middle where it was. The view's alone - never saved, never synced.
    const stageRef = useRef(null);
    const paperRef = useRef(null);
    const [zoom, setZoomNow] = useState(1);
    const [fit, setFit] = useState(null);
    const keepCentre = useRef(null);
    useEffect(() => {
        const stage = stageRef.current;
        if (!stage) return undefined;
        const measure = () => setFit(fitSize(stage.clientWidth - STAGE_GAP, stage.clientHeight - STAGE_GAP, W, H));
        measure();
        const watch = new ResizeObserver(measure);
        watch.observe(stage);
        return () => watch.disconnect();
    }, [W, H]);
    const setZoom = (z) => {
        const view = viewOf(stageRef.current, paperRef.current);
        if (view) keepCentre.current = centreOf(view);
        setZoomNow(clampZoom(z));
    };
    useLayoutEffect(() => {
        const stage = stageRef.current;
        const view = viewOf(stage, paperRef.current);
        if (!keepCentre.current || !view) return;
        const to = scrollToCentre(view, keepCentre.current.fx, keepCentre.current.fy);
        keepCentre.current = null;
        stage.scrollLeft = to.left;
        stage.scrollTop = to.top;
    }, [zoom, fit]);
    const paperSize = fit
        ? `width: ${fit[0] * zoom}px; height: ${fit[1] * zoom}px; max-width: none; max-height: none`
        : `aspect-ratio: ${W} / ${H}`;

    const changeLayers = (next) => {
        session.setBody(writeBody(next));
        session.touched();
    };

    const pourTool = tools.tool === 'bucket';
    const transformTool = tools.tool === 'transform';
    const cropTool = tools.tool === 'crop';
    // The framing tools share the crop's box, held to their shape; `boxTool` is any of the three.
    const framing = FRAMING_TOOLS[tools.tool] || null;
    const boxTool = cropTool || !!framing;
    const textTool = tools.tool === 'text';
    const shapeTool = SHAPE_TOOLS.includes(tools.tool);
    const size = tools.tool === 'eraser' ? tools.eraserSize : shapeTool ? tools.shapeSize : tools.brushSize;

    /// A pointer position in the drawing's own units.
    const toDrawing = (e) => {
        const rect = canvasRef.current.getBoundingClientRect();
        return [((e.clientX - rect.left) * W) / rect.width, ((e.clientY - rect.top) * H) / rect.height];
    };

    // The size circle: follows the pointer, as big on screen as the tool is on the drawing.
    const moveCursor = (e) => {
        const cursor = cursorRef.current;
        const canvas = canvasRef.current;
        if (!cursor || !canvas) return;
        const r = canvas.getBoundingClientRect();
        const off = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
        if (!SIZED_TOOLS.includes(tools.tool) || off) {
            cursor.style.display = 'none'; // the grab tool's cursor is the hand, the bucket's a crosshair - not a size
            return;
        }
        const rect = canvas.getBoundingClientRect();
        const diameter = Math.max(4, (size * rect.width) / W);
        cursor.style.width = cursor.style.height = `${diameter}px`;
        cursor.style.transform = `translate(${e.clientX - rect.left - diameter / 2}px, ${e.clientY - rect.top - diameter / 2}px)`;
        cursor.style.display = 'block';
    };

    // A sample is [x, y] in the drawing's units, plus the pen's pressure (0..1) when a pen drew it -
    // the Pointer Events API carries it on every event; a mouse reports a flat 0.5 and a finger
    // whatever its screen says, so only a pen's is believed. A pen stroke's width follows it.
    const sampleOf = (e, pen) => (pen ? [...toDrawing(e), e.pressure] : toDrawing(e));
    const asPressure = (sample) => (sample.length > 2 ? Math.round(sample[2] * 100) : undefined);

    // The canvas a stroke paints onto as it is drawn: its own layer's.
    const layerContext = (layerId) => {
        const canvas = layerCanvases.current.get(layerId);
        return canvas ? canvas.getContext('2d') : null;
    };

    // The stage takes the presses (the transform's rotate begins outside the frame, which can be
    // outside the drawing); every tool but the transform takes only those on the drawing itself.
    const onPointerDown = (e) => {
        if (!opened || e.button > 0 || !current) return;
        if (!transformTool && !boxTool && e.target !== canvasRef.current) return;
        // Not a press on the stage's own scrollbars.
        const stage = stageRef.current;
        const sr = stage.getBoundingClientRect();
        if (e.clientX - sr.left >= stage.clientWidth || e.clientY - sr.top >= stage.clientHeight) return;
        // A hidden layer takes no strokes: they would land where nobody can see them. A text layer
        // takes only its own tools.
        if (current.hidden || !toolAllowed(tools.tool)) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        // The crop box (DRAWING.md, "Cropping"): a corner or an edge resizes it, inside moves it,
        // outside draws a fresh one. Nothing is recorded until the crop button.
        // Text: a click places a new text layer there, and its words are typed in the tools column.
        if (textTool) {
            const [x, y] = toDrawing(e);
            const id = strokeId();
            // It lands holding a word (Curtis, 2026-09-27: "a clearer visual indication where the text
            // has landed"), selected in the words field so the first keystroke replaces it.
            const text = t('doc.drawing.new-text', 'horse');
            const style = { x, y, font: tools.font, size: tools.textSize, color: tools.color, align: tools.align, text };
            changeLayers(addTextLayer(drawing, id, style, Date.now()));
            setCurrentId(id);
            focusWords.current = true;
            return;
        }
        if (boxTool) {
            if (!cropBox) return;
            const at = toDrawing(e);
            const reach = (GRIP_PX * W) / canvasRef.current.getBoundingClientRect().width;
            const grip = gripAt(frameOf(cropBox), at, reach);
            live.current = { crop: true, grip: grip.kind === 'outside' ? { kind: 'new' } : grip, from: at, box: cropBox };
            return;
        }
        // The transform (DRAWING.md, "Transforming"): what the press took hold of decides the drag
        // (pure/transform.js); letting go records one `transform` entry.
        if (transformTool) {
            if (!frame) return;
            const at = toDrawing(e);
            const reach = (GRIP_PX * W) / canvasRef.current.getBoundingClientRect().width;
            live.current = { transform: true, grip: gripAt(frame, at, reach), from: at, to: at, perfect: e.shiftKey, layer: current.id };
            return;
        }
        // The grab tool (DRAWING.md, "Grabbing"): the drag shows the layer moving, and letting go
        // records one `move` entry - merged and undone like a stroke.
        if (tools.tool === 'grab') {
            live.current = { grab: true, layer: current.id, start: toDrawing(e), dx: 0, dy: 0 };
            setGrabbing(true);
            return;
        }
        if (pourTool) {
            startPour(e);
            return;
        }
        if (shapeTool) {
            startShape(e);
            return;
        }
        const pen = e.pointerType === 'pen';
        const first = sampleOf(e, pen);
        const stroke = { id: strokeId(), t: Date.now(), tool: tools.tool, size: Math.round(size) };
        if (current.id !== BASE_LAYER) stroke.layer = current.id;
        if (tools.tool === 'brush') stroke.color = tools.color;
        live.current = { stroke, pen, samples: [first] };
        const ctx = layerContext(current.id);
        if (!ctx) return;
        paintStroke(ctx, stroke, BACKING, [first], pen ? [asPressure(first)] : undefined);
        restack();
    };

    // The paint bucket (DRAWING.md, "Pouring"): the press drops paint, and while it is held the paint
    // spreads - `pourRate` canvas units a second - stopping at the layer's lines. How far it could go
    // is worked out once, at the press (pure/pour.js); each frame shows the cells within the reach so
    // far, over the layer as it was. Letting go records one `bucket` entry: where, and how far.
    const startPour = (e) => {
        const [x, y] = toDrawing(e).map(Math.floor);
        const layerId = current.id;
        const ops = effectiveOps(drawing, layerId);
        const field = pourField(wallsOf(ops, ops.length, W, H), W, H, x, y);
        const canvas = layerCanvases.current.get(layerId);
        if (!canvas || field[y * W + x] < 0) return; // dropped on a line, or off the canvas
        const before = blankCanvas(canvas.width, canvas.height);
        before.getContext('2d').drawImage(canvas, 0, 0);
        const entry = { id: strokeId(), t: Date.now(), tool: 'bucket', color: tools.color, points: [x, y] };
        if (layerId !== BASE_LAYER) entry.layer = layerId;
        const pour = { pour: true, entry, field, canvas, before, rate: pourRate(tools.pourSpeed), began: performance.now(), reach: DROP, frame: 0 };
        live.current = pour;
        const show = () => {
            if (live.current !== pour) return;
            pour.reach = Math.min(MAX_REACH, DROP + (pour.rate * (performance.now() - pour.began)) / 1000);
            const ctx = canvas.getContext('2d');
            ctx.save();
            ctx.globalCompositeOperation = 'source-over';
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(before, 0, 0);
            paintRuns(ctx, runsOf(field, W, H, pour.reach * STEP), entry.color, [W, H], canvas.width / W);
            ctx.restore();
            restack();
            pour.frame = requestAnimationFrame(show);
        };
        show();
    };

    // The transform's frame: round what the current layer has painted when the tool is taken up, the
    // layer changes, or the drawing changes under it (an undo, a sync); after the tool's own drag,
    // the old frame through that drag - so a slanted frame stays slanted for the next one.
    const [frame, setFrame] = useState(null);
    const keptFrame = useRef(null); // { body, layer } the tool's own last drag left
    const frameRef = useRef(null);
    useEffect(() => {
        if (!transformTool || !current || !shown) {
            setFrame(null);
            return;
        }
        const kept = keptFrame.current;
        if (kept && kept.body === session.body && kept.layer === current.id) return;
        keptFrame.current = null;
        const canvas = layerCanvases.current.get(current.id);
        const box = canvas && paintedBox(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, BACKING);
        setFrame(frameOf(box || [0, 0, W, H]));
    }, [transformTool, current && current.id, drawing, shown, picturesArrived]); // eslint-disable-line react-hooks/exhaustive-deps
    // The pointer over the frame says what a press would do; set straight on the stage and the
    // drawing, since it changes with every move.
    const setGripCursor = (cursor) => {
        if (stageRef.current) stageRef.current.style.cursor = cursor;
        if (paperRef.current) paperRef.current.style.cursor = cursor;
    };
    useEffect(() => {
        if (!transformTool && !boxTool) setGripCursor('');
    }, [transformTool, boxTool]);
    // The frame's size on screen: handles a fixed number of pixels, whatever the zoom.
    const unitsPerPixel = fit ? W / (fit[0] * zoom) : 1;
    const handle = HANDLE_PX * unitsPerPixel;
    const framePoints = (f) => f.map((p) => p.join(',')).join(' ');
    // Mid-drag the frame follows the pointer without re-rendering the surface.
    const showFrame = (f) => {
        const svg = frameRef.current;
        if (!svg) return;
        svg.querySelector('polygon').setAttribute('points', framePoints(f));
        svg.querySelectorAll('rect').forEach((r, i) => {
            r.setAttribute('x', f[i][0] - handle / 2);
            r.setAttribute('y', f[i][1] - handle / 2);
        });
    };

    // The crop box (DRAWING.md, "Cropping"): in from the canvas's edges when the tool is taken up and
    // after every crop, so what is about to go is shaded from the start. The box is the tool's own -
    // nothing is recorded until the crop button, which records one `crop` entry.
    const [cropBox, setCropBox] = useState(null);
    // A framing tool's send: 'working', 'done', or an error's words - cleared when the tool or the
    // box changes.
    const [framed, setFramed] = useState(null);
    const cropRef = useRef(null);
    useEffect(() => {
        setCropBox(
            !shown ? null
            : framing ? fitBox(framing.ratio, [W, H])
            : cropTool ? [Math.round(W * 0.1), Math.round(H * 0.1), Math.round(W * 0.9), Math.round(H * 0.9)]
            : null
        );
        setFramed(null);
    }, [cropTool, framing, shown, W, H]);
    // A drag of the box, free for the crop, held to its shape for a framing tool.
    const boxAfter = (l) => (framing ? dragBoxAt(l.box, l.grip, l.from, l.to, [W, H], framing.ratio) : dragBox(l.box, l.grip, l.from, l.to, [W, H]));
    const cropPath = ([l, top, r, b]) => `M0 0H${W}V${H}H0Z M${l} ${top}V${b}H${r}V${top}Z`;
    const showCrop = (box) => {
        const svg = cropRef.current;
        if (!svg) return;
        const [l, top, r, b] = box;
        svg.querySelector('path').setAttribute('d', cropPath(box));
        const edge = svg.querySelector('.drawing-crop-edge');
        edge.setAttribute('x', l);
        edge.setAttribute('y', top);
        edge.setAttribute('width', r - l);
        edge.setAttribute('height', b - top);
        svg.querySelectorAll('.drawing-crop-handle').forEach((h, i) => {
            const [x, y] = frameOf(box)[i];
            h.setAttribute('x', x - handle / 2);
            h.setAttribute('y', y - handle / 2);
        });
    };
    const cropReady = cropBox && cropEntry(drawing, cropBox, { id: '', t: 0 });

    // Set as profile / banner: what the box holds, flattened as every picture of the drawing is (its
    // visible layers, its pictures and faces waited for), cut out, and sent to the door.
    const frameNow = async () => {
        if (!framing || !cropBox) return;
        const door = framing.door;
        setFramed('working');
        try {
            const flat = flatten(drawing, W * BACKING, await loadPictures(root, drawing));
            const [l, top, r, b] = cropBox.map((n) => n * BACKING);
            const scale = Math.min(1, FRAMED_MAX_SIDE / Math.max(r - l, b - top));
            const out = blankCanvas(Math.max(1, Math.round((r - l) * scale)), Math.max(1, Math.round((b - top) * scale)));
            out.getContext('2d').drawImage(flat, l, top, r - l, b - top, 0, 0, out.width, out.height);
            const blob = await new Promise((resolve, reject) =>
                out.toBlob((x) => (x ? resolve(x) : reject(new Error('could not make a picture of the drawing'))), 'image/png')
            );
            const form = new FormData();
            form.append('image', blob, `${door}.png`);
            await api(`/api/identity/${root}/${door}`, { method: 'POST', body: form });
            setFramed('done');
        } catch (err) {
            setFramed(err.message);
        }
    };
    const cropNow = () => {
        const entry = cropBox && cropEntry(drawing, cropBox, { id: strokeId(), t: Date.now() });
        if (!entry) return;
        session.setBody(writeBody(addStroke(drawing, entry)));
        session.touched();
    };

    // The text tool's options: the current text layer's own, or - with none current - what the next
    // text will be. A change goes to both: the text, and the tool's memory for the next one.
    const wordsRef = useRef(null);
    const focusWords = useRef(false);
    useEffect(() => {
        if (focusWords.current && wordsRef.current) {
            focusWords.current = false;
            wordsRef.current.focus();
            wordsRef.current.select();
        }
    });
    const textStyle = currentText || { font: tools.font, size: tools.textSize, align: tools.align, color: tools.color };
    const changeText = (change) => {
        const remembered = {};
        if (change.font) remembered.font = change.font;
        if (change.size) remembered.textSize = change.size;
        if (change.align) remembered.align = change.align;
        if (change.color) remembered.color = change.color;
        if (Object.keys(remembered).length) setTools(remembered);
        if (currentText) changeLayers(setText(drawing, current.id, change, Date.now()));
    };
    const alignButtons = [
        ['left', Icons.alignLeft, t('doc.drawing.align-left', 'align left')],
        ['center', Icons.alignCenter, t('doc.drawing.align-center', 'centre')],
        ['right', Icons.alignRight, t('doc.drawing.align-right', 'align right')],
    ];

    // The shapes (DRAWING.md, "Shapes"): the drag shows the shape from where it began to the
    // pointer, over the layer as it was; letting go records it - a line as a two-point brush
    // stroke, a rectangle or an ellipse as its box. A drag that went nowhere records nothing.
    const startShape = (e) => {
        const canvas = layerCanvases.current.get(current.id);
        if (!canvas) return;
        const before = blankCanvas(canvas.width, canvas.height);
        before.getContext('2d').drawImage(canvas, 0, 0);
        const start = toDrawing(e);
        const base = { id: strokeId(), t: Date.now(), layer: current.id, color: tools.color, size: Math.round(size) };
        live.current = { shape: tools.tool, start, end: start, base, canvas, before };
    };
    const showShape = (l) => {
        const ctx = l.canvas.getContext('2d');
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
        ctx.drawImage(l.before, 0, 0);
        const entry = shapeEntry(l.shape, l.start, l.end, l.base);
        if (entry) paintMark(ctx, entry, BACKING);
        ctx.restore();
        restack();
    };

    const onPointerMove = (e) => {
        moveCursor(e);
        const l = live.current;
        if (!l && transformTool && frame) {
            const reach = (GRIP_PX * W) / canvasRef.current.getBoundingClientRect().width;
            setGripCursor(gripCursor(gripAt(frame, toDrawing(e), reach)));
        }
        if (!l && boxTool && cropBox) {
            const reach = (GRIP_PX * W) / canvasRef.current.getBoundingClientRect().width;
            const grip = gripAt(frameOf(cropBox), toDrawing(e), reach);
            setGripCursor(grip.kind === 'outside' ? 'crosshair' : gripCursor(grip));
        }
        if (!l || l.pour) return; // a pour stays where it was dropped
        if (l.crop) {
            l.to = toDrawing(e);
            showCrop(boxAfter(l));
            return;
        }
        if (l.transform) {
            // Shift is read as the drag goes, so pressing it mid-drag makes the drag "perfect".
            l.to = toDrawing(e);
            l.perfect = e.shiftKey;
            const m = gestureMatrix(frame, l.grip, l.from, l.to, l.perfect);
            restack({ layer: l.layer, m });
            showFrame(frameThrough(m, frame));
            return;
        }
        if (l.shape) {
            l.end = toDrawing(e);
            showShape(l);
            return;
        }
        if (l.grab) {
            const [x, y] = toDrawing(e);
            l.dx = x - l.start[0];
            l.dy = y - l.start[1];
            restack({ layer: l.layer, m: [1, 0, 0, 1, l.dx, l.dy] });
            return;
        }
        const ctx = layerContext(l.stroke.layer || BASE_LAYER);
        if (!ctx) return;
        // Every sample the browser gathered since the last frame, not just the last one: a pen
        // reports far faster than the screen draws, and a fast curve drawn from frame-rate samples
        // comes out as straight lines.
        const events = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
        for (const ev of events.length ? events : [e]) {
            const next = sampleOf(ev, l.pen);
            const last = l.samples[l.samples.length - 1];
            if (Math.abs(next[0] - last[0]) < 0.5 && Math.abs(next[1] - last[1]) < 0.5) continue;
            l.samples.push(next);
            paintStroke(ctx, l.stroke, BACKING, [last, next], l.pen ? [asPressure(last), asPressure(next)] : undefined);
        }
        restack();
    };

    const finishStroke = () => {
        const l = live.current;
        live.current = null;
        if (!l) return;
        if (l.crop) {
            if (l.to) {
                setCropBox(boxAfter(l));
                setFramed(null);
            }
            return;
        }
        if (l.transform) {
            // Stored in fixed point; the frame follows what was stored, so it and the layer agree.
            const m = fromFixed(toFixed(gestureMatrix(frame, l.grip, l.from, l.to, l.perfect)));
            if (m.every((n, i) => Math.abs(n - IDENTITY[i]) < 1e-6)) {
                restack();
                showFrame(frame);
                return;
            }
            const entry = { id: strokeId(), t: Date.now(), tool: 'transform', m: toFixed(m) };
            if (l.layer !== BASE_LAYER) entry.layer = l.layer;
            const body = writeBody(addStroke(drawing, entry));
            keptFrame.current = { body, layer: l.layer };
            setFrame(frameThrough(m, frame));
            session.setBody(body);
            session.touched();
            return;
        }
        if (l.shape) {
            const entry = shapeEntry(l.shape, l.start, l.end, l.base);
            if (!entry) {
                showShape(l); // nothing dragged: the layer as it was
                return;
            }
            session.setBody(writeBody(addStroke(drawing, entry)));
            session.touched();
            return;
        }
        if (l.pour) {
            cancelAnimationFrame(l.frame);
            const pour = { ...l.entry, reach: Math.round(l.reach) };
            session.setBody(writeBody(addStroke(drawing, pour)));
            session.touched();
            return;
        }
        if (l.grab) {
            setGrabbing(false);
            const dx = Math.round(l.dx);
            const dy = Math.round(l.dy);
            if (!dx && !dy) {
                restack();
                return;
            }
            const move = { id: strokeId(), t: Date.now(), tool: 'move', dx, dy };
            if (l.layer !== BASE_LAYER) move.layer = l.layer;
            session.setBody(writeBody(addStroke(drawing, move)));
            session.touched();
            return;
        }
        const { points, pressure } = encodeSamples(l.samples);
        const stroke = { ...l.stroke, points, ...(pressure ? { pressure } : {}) };
        session.setBody(writeBody(addStroke(drawing, stroke)));
        session.touched();
    };

    const undoStroke = () => {
        if (!drawing.strokes.length) return;
        session.setBody(writeBody(undo(drawing)));
        session.touched();
    };

    // Cmd/Ctrl+Z undoes a stroke - unless you are typing somewhere, where it is that field's undo.
    useEffect(() => {
        const onKey = (e) => {
            if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.key.toLowerCase() !== 'z') return;
            const tag = (document.activeElement && document.activeElement.tagName) || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;
            e.preventDefault();
            undoStroke();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    // The tools, each an icon named in its tooltip - chosen out here, since inside the template a
    // tool's id would read to the strings cop as copy.
    const toolButtons = [
        ['brush', Icons.drawing, t('doc.drawing.brush', 'brush')],
        ['eraser', Icons.eraser, t('doc.drawing.eraser', 'eraser')],
        ['line', Icons.line, t('doc.drawing.line', 'line')],
        ['rect', Icons.rectangle, t('doc.drawing.rectangle', 'rectangle')],
        ['ellipse', Icons.ellipse, t('doc.drawing.ellipse', 'ellipse')],
        ['bucket', Icons.bucket, t('doc.drawing.bucket', 'paint bucket')],
        ['text', Icons.text, t('doc.drawing.text-tool', 'text')],
        ['transform', Icons.transform, t('doc.drawing.transform', 'transform')],
        ['grab', Icons.grab, t('doc.drawing.grab', 'grab')],
        // Last, away from the transform it resembles (Curtis, 2026-09-27).
        ['crop', Icons.crop, t('doc.drawing.crop-tool', 'crop')],
        // ...and the crop's two cousins, held to a shape (Curtis, 2026-09-28).
        ['profile', Icons.asProfile, t('doc.drawing.profile-tool', 'set as profile')],
        ['banner', Icons.asBanner, t('doc.drawing.banner-tool', 'set as banner')],
    ];
    const grabTool = tools.tool === 'grab';
    // The colours show only with a tool that uses one, and picking one keeps that tool in hand.
    const colourTool = tools.tool;
    // A colour picked with the text tool colours the current text too.
    const pickColour = (color) => {
        setTools({ color, tool: colourTool });
        if (textTool && currentText) changeLayers(setText(drawing, current.id, { color }, Date.now()));
    };
    // The size slider speaks for whichever tool is in hand: the shapes share a line width.
    const sizeKey = tools.tool === 'eraser' ? 'eraserSize' : shapeTool ? 'shapeSize' : 'brushSize';
    const sizeWords = () =>
        tools.tool === 'eraser'
            ? t('doc.drawing.eraser-size', 'eraser size')
            : shapeTool
              ? t('doc.drawing.line-width', 'line width')
              : t('doc.drawing.brush-size', 'brush size');
    const paperClass = grabTool
        ? grabbing
            ? 'drawing-paper drawing-floor grabbing'
            : 'drawing-paper drawing-floor grab'
        : pourTool || shapeTool
          ? 'drawing-paper drawing-floor aim'
          : textTool
            ? 'drawing-paper drawing-floor type'
            : 'drawing-paper drawing-floor';

    const toolsColumn = tucked.has('tools')
        ? html`<${Rail} icon=${Icons.drawing} label=${t('doc.drawing.tools', 'tools')} onClick=${() => toggleTuck('tools')} />`
        : html`<aside class="drawing-tools" style=${colStyle}>
              <${PaneHead} label=${t('doc.drawing.tools', 'tools')} onTuck=${() => toggleTuck('tools')} />
              ${/* The tools are icons, each named in its tooltip (Curtis, 2026-09-26). */ ''}
              <div class="drawing-toolset">
                  ${toolButtons.map(
                      ([tool, icon, name]) => html`<button
                          key=${tool}
                          class=${tools.tool === tool ? 'drawing-tool-icon active' : 'drawing-tool-icon'}
                          title=${name}
                          aria-label=${name}
                          disabled=${!toolAllowed(tool)}
                          onClick=${() => setTools({ tool })}
                      ><${icon} /></button>`
                  )}
                  ${/* With the tools: what works whatever the tool (Curtis, 2026-09-27). */ ''}
                  <button
                      class="drawing-tool-icon"
                      title=${t('doc.drawing.add-an-image', 'add an image')}
                      aria-label=${t('doc.drawing.add-an-image', 'add an image')}
                      disabled=${!opened}
                      onClick=${() => setPickingImage(true)}
                  ><${Icons.addImage} /></button>
                  <button
                      class="drawing-tool-icon"
                      title=${t('doc.drawing.undo', 'undo')}
                      aria-label=${t('doc.drawing.undo', 'undo')}
                      disabled=${!drawing.strokes.length}
                      onClick=${undoStroke}
                  ><${Icons.unpublish} /></button>
              </div>
              ${/* The tool in hand's own options, and only its own (Curtis, 2026-09-27: "tool options are
                  contextual and live with their associated tool"). */ ''}
              ${pourTool &&
              html`<label class="drawing-size">
                  <span>${t('doc.drawing.pour-speed', 'pour speed')} · ${tools.pourSpeed}</span>
                  <input
                      type="range"
                      min="1"
                      max=${POUR_SPEEDS}
                      value=${tools.pourSpeed}
                      onInput=${(e) => setTools({ pourSpeed: +e.currentTarget.value })}
                  />
              </label>`}
              ${SIZED_TOOLS.includes(tools.tool) &&
              html`<label class="drawing-size">
                  <span>${sizeWords()} · ${size}</span>
                  <input
                      type="range"
                      min="1"
                      max=${Math.min(80, MAX_SIZE)}
                      value=${size}
                      onInput=${(e) => setTools({ [sizeKey]: +e.currentTarget.value })}
                  />
              </label>`}
              ${textTool &&
              html`<div class="drawing-text-options">
                  ${currentText
                      ? html`<textarea
                            ref=${wordsRef}
                            class="drawing-text-words"
                            rows="4"
                            maxlength=${MAX_TEXT_BYTES}
                            value=${currentText.text}
                            placeholder=${t('doc.drawing.type-here', 'type here')}
                            aria-label=${t('doc.drawing.words', 'words')}
                            onInput=${(e) => changeText({ text: e.currentTarget.value })}
                        ></textarea>`
                      : html`<p class="null-sub">${t('doc.drawing.click-to-place-text', 'click the drawing to place text')}</p>`}
                  <label class="drawing-size">
                      <span>${t('doc.drawing.font', 'font')}</span>
                      <select value=${textStyle.font} onChange=${(e) => changeText({ font: e.currentTarget.value })}>
                          ${Object.entries(FONTS).map(
                              ([token, family]) => html`<option key=${token} value=${token} style=${`font-family: ${fontStack(token)}`}>${family}</option>`
                          )}
                      </select>
                  </label>
                  <label class="drawing-size">
                      <span>${t('doc.drawing.text-size', 'text size')} · ${textStyle.size}</span>
                      <input
                          type="range"
                          min=${MIN_TEXT_SIZE}
                          max=${TEXT_SLIDER_MAX}
                          value=${textStyle.size}
                          onInput=${(e) => changeText({ size: +e.currentTarget.value })}
                      />
                  </label>
                  <div class="drawing-toolset" role="group" aria-label=${t('doc.drawing.alignment', 'alignment')}>
                      ${alignButtons.map(
                          ([align, icon, name]) => html`<button
                              key=${align}
                              class=${textStyle.align === align ? 'drawing-tool-icon active' : 'drawing-tool-icon'}
                              title=${name}
                              aria-label=${name}
                              onClick=${() => changeText({ align })}
                          ><${icon} /></button>`
                      )}
                  </div>
              </div>`}
              ${cropTool &&
              html`<button class="drawing-tool drawing-crop-go" disabled=${!cropReady} onClick=${cropNow}>
                  <${Icons.crop} /> ${t('doc.drawing.crop', 'crop')}
              </button>`}
              ${framing &&
              html`<button class="drawing-tool drawing-crop-go" disabled=${!cropBox || framed === 'working'} onClick=${frameNow}>
                      ${tools.tool === 'profile'
                          ? html`<${Icons.asProfile} /> ${t('doc.drawing.set-as-profile', 'Set as Profile')}`
                          : html`<${Icons.asBanner} /> ${t('doc.drawing.set-as-banner', 'Set as Banner')}`}
                  </button>
                  ${framed &&
                  html`<p class=${framed === 'working' || framed === 'done' ? 'drawing-framed' : 'drawing-framed error'}>
                      ${framed === 'working'
                          ? t('doc.drawing.working-on-it', 'working on it…')
                          : framed === 'done'
                            ? tools.tool === 'profile'
                                ? t('doc.drawing.profile-is-set', 'your profile picture is set')
                                : t('doc.drawing.banner-is-set', 'your banner is set')
                            : framed}
                  </p>`}`}
              ${COLOURED_TOOLS.includes(tools.tool) &&
              html`<${ColourPicker} value=${textTool ? textStyle.color : tools.color} onChange=${pickColour} />
                  <div class="drawing-colours" aria-label=${t('doc.drawing.colour', 'colour')}>
                      ${/* A click away: white and black always, then the last ten colours this
                          drawing's strokes used (Curtis, 2026-09-26) - the picker above has the rest. */ ''}
                      ${[...FIXED_COLOURS, ...recentColours(drawing, 10)].map(
                          (c) => html`<button
                              key=${c}
                              class=${(textTool ? textStyle.color : tools.color) === c ? 'drawing-swatch active' : 'drawing-swatch'}
                              style=${`background: ${c}`}
                              title=${c}
                              onClick=${() => pickColour(c)}
                          ></button>`
                      )}
                  </div>`}
              <p class="drawing-count">
                  ${t('doc.drawing.strokes', '{count} strokes', { count: drawing.strokes.length })}
              </p>
          </aside>${resizer('tools')}`;

    // The layers column: the navigator, then a new layer, the current layer's opacity, and the stack
    // itself top-first - each row the layer alone beside its name, and under the name (Curtis,
    // 2026-09-26: "to give the name some room to breathe") what can be done to it: hide, rename,
    // duplicate, trash. Drag a row to move it, click it to draw on it, double-click its name to rename.
    const newLayer = () => {
        const id = strokeId();
        changeLayers(addLayer(drawing, id, Date.now()));
        setCurrentId(id);
    };
    // Per layer (Curtis, 2026-09-26): duplicate it just above, or throw it away - entries both, so
    // undo takes either back (pure/drawing.js).
    const copyLayer = (layerId) => {
        const id = strokeId();
        changeLayers(duplicateLayer(drawing, layerId, id, strokeId(), Date.now()));
        setCurrentId(id);
    };
    const trashLayer = (layerId) => changeLayers(deleteLayer(drawing, layerId, strokeId(), Date.now()));
    // A name (Curtis, 2026-09-26): typed in place of the name, kept on Enter or on leaving the field,
    // dropped on Escape. A blank name goes back to the number; one the drawing cannot keep - too long,
    // a control character - changes nothing (pure/drawing.js, `setLayer`).
    const commitName = (layer, typed) => {
        setRenaming(null);
        if (typed.trim() !== (layer.name || '')) changeLayers(setLayer(drawing, layer.id, { name: typed }, Date.now()));
    };
    // A text layer with no name of its own goes by its first line.
    const layerName = (layer) => {
        const words = (textOf(drawing, layer.id) || { text: '' }).text.split('\n')[0].trim();
        return layer.name || words || t('doc.drawing.layer-n', 'layer {n}', { n: layer.n });
    };
    // Dragging a row (Curtis, 2026-09-27): a line across the stack shows where it will land - above
    // the row under the pointer from its top half, below it from its bottom half - and no line where
    // a drop would change nothing (pure/drawing.js, `dropIndex`). The dragged id is kept here, since
    // a drag's data cannot be read until the drop.
    const draggingLayer = useRef(null);
    const [dropLine, setDropLine] = useState(null); // { id, above }
    const dropTarget = (e, layer) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const above = e.clientY < rect.top + rect.height / 2;
        const index = dropIndex(drawing, draggingLayer.current, layer.id, above);
        return index === null ? null : { id: layer.id, above, index };
    };
    const overRow = (e, layer) => {
        if (!draggingLayer.current) return;
        e.preventDefault();
        const target = dropTarget(e, layer);
        const same = target && dropLine && target.id === dropLine.id && target.above === dropLine.above;
        if (!same && (target || dropLine)) setDropLine(target && { id: target.id, above: target.above });
    };
    const dropOnRow = (e, layer) => {
        e.preventDefault();
        const target = draggingLayer.current && dropTarget(e, layer);
        if (target) changeLayers(moveLayer(drawing, draggingLayer.current, target.index, Date.now()));
        draggingLayer.current = null;
        setDropLine(null);
    };
    const endDrag = () => {
        draggingLayer.current = null;
        setDropLine(null);
    };
    // Spelled out, so the dead-CSS convention can see each class.
    const rowClass = (isCurrent, line) =>
        line
            ? line.above
                ? isCurrent
                    ? 'drawing-layer current drop-above'
                    : 'drawing-layer drop-above'
                : isCurrent
                  ? 'drawing-layer current drop-below'
                  : 'drawing-layer drop-below'
            : isCurrent
              ? 'drawing-layer current'
              : 'drawing-layer';
    const layersColumn = tucked.has('layers')
        ? html`<${Rail} icon=${Icons.layers} label=${t('doc.drawing.layers-and-map', 'layers & map')} onClick=${() => toggleTuck('layers')} />`
        : html`<aside class="drawing-layers" style=${colStyle}>
              <${PaneHead} label=${t('doc.drawing.layers-and-map', 'layers & map')} onTuck=${() => toggleTuck('layers')} />
              ${shown &&
              html`<${Navigator}
                  zoom=${zoom}
                  onZoom=${setZoom}
                  stageRef=${stageRef}
                  paperRef=${paperRef}
                  sourceRef=${canvasRef}
                  width=${W}
                  height=${H}
              />
              <hr class="drawing-nav-rule" />`}
              <button class="drawing-tool" disabled=${!opened} onClick=${newLayer}>
                  <${Icons.plus} /> ${t('doc.drawing.new-layer', 'new layer')}
              </button>
              ${current &&
              html`<label class="drawing-size">
                  <span>${t('doc.drawing.opacity', 'opacity')} · ${current.opacity}%</span>
                  <input
                      type="range"
                      min="0"
                      max="100"
                      value=${current.opacity}
                      disabled=${!opened}
                      onInput=${(e) => changeLayers(setLayer(drawing, current.id, { opacity: +e.currentTarget.value }, Date.now()))}
                  />
              </label>`}
              <ol
                  class="drawing-layer-list"
                  onDragLeave=${(e) => {
                      // Out of the stack altogether (not just from one row to the next): no line.
                      if (!e.currentTarget.contains(e.relatedTarget)) setDropLine(null);
                  }}
              >
                  ${[...layers].reverse().map((layer) => {
                      const isCurrent = current && layer.id === current.id;
                      const line = dropLine && dropLine.id === layer.id ? dropLine : null;
                      return html`<li
                          key=${layer.id}
                          class=${rowClass(isCurrent, line)}
                          draggable=${renaming !== layer.id}
                          onDragStart=${(e) => {
                              draggingLayer.current = layer.id;
                              e.dataTransfer.setData('text/x-drawing-layer', layer.id);
                              e.dataTransfer.effectAllowed = 'move';
                          }}
                          onDragOver=${(e) => overRow(e, layer)}
                          onDrop=${(e) => dropOnRow(e, layer)}
                          onDragEnd=${endDrag}
                          onClick=${() => setCurrentId(layer.id)}
                      >
                          <${LayerThumb} source=${layerCanvases.current.get(layer.id)} painted=${painted} />
                          ${renaming === layer.id
                              ? html`<${LayerNameField} layer=${layer} onCommit=${commitName} onCancel=${() => setRenaming(null)} />`
                              : html`<span
                                    class=${layer.hidden ? 'drawing-layer-name hidden' : 'drawing-layer-name'}
                                    title=${layerName(layer)}
                                    onDblClick=${(e) => {
                                        e.stopPropagation();
                                        if (opened) setRenaming(layer.id);
                                    }}
                                >${layerName(layer)}</span>`}
                          <span class="drawing-layer-acts">
                              <button
                                  class="drawing-layer-eye"
                                  title=${layer.hidden ? t('doc.drawing.show-layer', 'show this layer') : t('doc.drawing.hide-layer', 'hide this layer')}
                                  onClick=${(e) => {
                                      e.stopPropagation();
                                      changeLayers(setLayer(drawing, layer.id, { hidden: !layer.hidden }, Date.now()));
                                  }}
                              ><${layer.hidden ? Icons.eyeClosed : Icons.eye} /></button>
                              <button
                                  class="drawing-layer-eye"
                                  title=${t('doc.drawing.rename-layer', 'rename this layer')}
                                  disabled=${!opened}
                                  onClick=${(e) => {
                                      e.stopPropagation();
                                      setRenaming(layer.id);
                                  }}
                              ><${Icons.rename} /></button>
                              <button
                                  class="drawing-layer-eye"
                                  title=${t('doc.drawing.duplicate-layer', 'duplicate this layer')}
                                  onClick=${(e) => {
                                      e.stopPropagation();
                                      copyLayer(layer.id);
                                  }}
                              ><${Icons.copy} /></button>
                              <button
                                  class="drawing-layer-eye"
                                  title=${t('doc.drawing.trash-layer', 'throw this layer away (undo brings it back)')}
                                  onClick=${(e) => {
                                      e.stopPropagation();
                                      trashLayer(layer.id);
                                  }}
                              ><${Icons.trash} /></button>
                          </span>
                      </li>`;
                  })}
              </ol>
              ${current && current.hidden &&
              html`<p class="null-sub">${t('doc.drawing.this-layer-is-hidden', 'this layer is hidden - show it to draw on it')}</p>`}
              ${!layers.length &&
              html`<p class="null-sub">${t('doc.drawing.no-layers', 'no layers - make a new one to draw on')}</p>`}
          </aside>${resizer('layers')}`;

    // The save chip's state, read out here: inside the template a status word would read to the
    // strings cop as copy.
    const saved = session.status === 'clean';
    const saveFailed = session.status === 'error';
    const header = html`<header class="reader-head drawing-head">
        <input
            class="editor-title"
            value=${session.title}
            placeholder=${t('doc.drawing.untitled', 'untitled')}
            onInput=${(e) => {
                session.setTitle(e.currentTarget.value);
                session.touched();
            }}
            onBlur=${() => session.save()}
        />
        <span class="reader-chips">
            ${/* Trash is always the leftmost chip, on every row (Curtis, 2026-09-27). */ ''}
            ${onDeleted &&
            row &&
            !row.fields?.published_as &&
            html`<${Chip} icon=${Icons.trash} modifier="chip-delete" title=${t('doc.drawing.delete', 'delete')} onClick=${session.remove} />`}
            <${Chip}
                icon=${Icons.copy}
                title=${t('doc.drawing.copy-a-picture-into-a-notebook', 'copy a picture of this drawing into a notebook')}
                onClick=${() => opened && setCopying(true)}
            />
            ${copying &&
            html`<${CopyIntoModal}
                current=${{ root }}
                source=${{ author: root, doc_id: docId, private: true }}
                heading=${t('doc.drawing.copy-a-picture-of-it', 'copy a picture of this drawing into a notebook')}
                copyWith=${(bucket, isNew) => copyPictureInto(root, drawing, session.title, bucket, isNew)}
                onClose=${() => setCopying(false)}
            />`}
            <${Chip}
                icon=${Icons.download}
                title=${t('doc.drawing.download-png', 'download as a .png')}
                onClick=${() => opened && downloadPng(root, drawing, session.title).catch((e) => setActionError(e.message))}
            />
            <${Chip}
                icon=${Icons.pageNew}
                title=${busy ? t('doc.drawing.duplicating', 'duplicating…') : t('doc.drawing.duplicate-this-drawing', 'duplicate - a new drawing, strokes and all')}
                onClick=${() => opened && !busy && duplicate()}
            />
            <${Chip}
                modifier=${saveFailed ? 'chip-diverged' : null}
                title=${saved ? t('doc.drawing.saved', 'saved') : saveFailed ? session.error || t('doc.drawing.not-saved', 'not saved - it will try again') : t('doc.drawing.saving', 'saving…')}
            >
                ${saved ? html`<${Icons.saved} />` : saveFailed ? html`<${Icons.warn} />` : html`<span class="status-spin"><${Icons.spinner} /></span>`}
            </${Chip}>
            <span class="editor-meta-anchor" ref=${metaChipRef}>
                <${Chip}
                    icon=${Icons.tag}
                    on=${showMeta}
                    title=${t('doc.drawing.tags', 'tags, date & description')}
                    onClick=${() => setShowMeta((v) => !v)}
                />
            </span>
            <${NavChips} nav=${nav} />
        </span>
        ${showMeta && html`<div class="editor-meta" ref=${metaPanelRef}><${Annotations} root=${root} docId=${docId} /></div>`}
        ${session.error && html`<p class="form-error">${session.error}</p>`}
        ${actionError && html`<p class="form-error">${actionError}</p>`}
    </header>`;

    return html`${toolsColumn}
        ${layersColumn}
        <div class="drawing">
            ${header}
            ${pickingImage && html`<${ImagePickModal} root=${root} drawings=${true} DrawingThumb=${DrawingThumb} onPick=${placePicture} onClose=${() => setPickingImage(false)} />`}
            <${PublishBar} root=${root} docId=${docId} row=${row} publish=${publishThis} differs=${differs} diffHref=${null} />
            <div
                class="drawing-stage"
                ref=${stageRef}
                onPointerDown=${onPointerDown}
                onPointerMove=${onPointerMove}
                onPointerUp=${finishStroke}
                onPointerCancel=${finishStroke}
            >
                ${!shown
                    ? html`<p class="null-sub">${t('doc.drawing.opening', 'opening…')}</p>`
                    : html`<div
                          ref=${paperRef}
                          class=${paperClass}
                          style=${paperSize}
                          onPointerLeave=${() => cursorRef.current && (cursorRef.current.style.display = 'none')}
                      >
                          <canvas
                              ref=${canvasRef}
                              class="drawing-canvas"
                              width=${W * BACKING}
                              height=${H * BACKING}
                          ></canvas>
                          <span ref=${cursorRef} class=${tools.tool === 'eraser' ? 'drawing-cursor eraser' : 'drawing-cursor'}></span>
                          ${cropBox &&
                          html`<svg ref=${cropRef} class="drawing-crop" viewBox=${`0 0 ${W} ${H}`} preserveAspectRatio="none">
                              <path class="drawing-crop-shade" fill-rule="evenodd" d=${cropPath(cropBox)} />
                              <rect
                                  class="drawing-crop-edge"
                                  x=${cropBox[0]}
                                  y=${cropBox[1]}
                                  width=${cropBox[2] - cropBox[0]}
                                  height=${cropBox[3] - cropBox[1]}
                              />
                              ${frameOf(cropBox).map(
                                  (p, i) =>
                                      html`<rect key=${i} class="drawing-crop-handle" x=${p[0] - handle / 2} y=${p[1] - handle / 2} width=${handle} height=${handle} />`
                              )}
                          </svg>`}
                          ${frame &&
                          html`<svg
                              ref=${frameRef}
                              class="drawing-frame"
                              viewBox=${`0 0 ${W} ${H}`}
                              preserveAspectRatio="none"
                          >
                              <polygon points=${framePoints(frame)} />
                              ${frame.map(
                                  (p, i) => html`<rect key=${i} x=${p[0] - handle / 2} y=${p[1] - handle / 2} width=${handle} height=${handle} />`
                              )}
                          </svg>`}
                      </div>`}
            </div>
        </div>`;
};
