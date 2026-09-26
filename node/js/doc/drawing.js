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
import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { useDocSession } from './session.js';
import { Chip, NavChips } from './chips.js';
import { Annotations } from './annotations.js';
import { cachedDoc, rememberDoc } from '../mirror/doccache.js';
import { api, xhrUpload } from '../net.js';
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
    strokesOn,
    addLayer,
    setLayer,
    moveLayer,
    offsetsOf,
} from '../pure/drawing.js';
import { PublishBar } from './publishbar.js';

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

/// One layer's strokes, in order, onto a canvas of its own (DRAWING.md, "Layers"): transparent
/// wherever the layer has nothing, so an eraser stroke erases only the layer it is on. The base
/// layer starts filled with the drawing's `background` - the white a drawing begins on - so erasing
/// on it cuts through to transparency like any other layer.
export function paintLayer(canvas, drawing, layerId) {
    const ctx = canvas.getContext('2d');
    const scale = canvas.width / drawing.width;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // A grab (a `move` entry) shifts everything drawn on the layer before it: each entry is painted
    // offset by the moves after it, the base layer's fill by all of them - so a layer grabbed away
    // and back loses nothing at the edge (pure/drawing.js, `offsetsOf`).
    const ops = strokesOn(drawing, layerId);
    const { each, total } = offsetsOf(ops);
    if (layerId === BASE_LAYER) {
        ctx.fillStyle = drawing.background;
        ctx.fillRect(total[0] * scale, total[1] * scale, canvas.width, canvas.height);
    }
    ops.forEach((op, i) => {
        if (op.tool === 'move') return;
        ctx.save();
        ctx.translate(each[i][0] * scale, each[i][1] * scale);
        paintStroke(ctx, op, scale);
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
export function paintLayers(drawing, width) {
    const height = Math.round((width * drawing.height) / drawing.width);
    const canvases = new Map();
    for (const layer of layersOf(drawing)) {
        const canvas = blankCanvas(width, height);
        paintLayer(canvas, drawing, layer.id);
        canvases.set(layer.id, canvas);
    }
    return canvases;
}

/// Stack the layers onto `target`, bottom first, each at its opacity, the hidden ones left out, over
/// nothing - on the screen the floor shows through from the stage behind; in a picture, nothing
/// stays transparent. `shift` - `{ layer, dx, dy }`, in the drawing's units - draws one layer moved,
/// which is how a grab shows before it lets go.
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
        const x = moved ? (shift.dx * target.width) / drawing.width : 0;
        const y = moved ? (shift.dy * target.height) / drawing.height : 0;
        ctx.drawImage(canvas, x, y, target.width, target.height);
    }
    ctx.restore();
}

/// A picture of the drawing, `width` pixels wide: the visible layers, stacked. What a thumbnail, a
/// copy into a notebook and a publication are all made from - so a hidden layer is left out of all
/// three, as it is out of sight, and wherever the layers leave nothing the picture is transparent
/// (webp and png keep it, and so does the node's AVIF).
export function flatten(drawing, width = drawing.width) {
    const out = blankCanvas(width, Math.round((width * drawing.height) / drawing.width));
    composite(out, drawing, paintLayers(drawing, width));
    return out;
}

/// The drawing as an image file: webp where the browser can write one, png where it cannot (Safari,
/// and so the macOS app's webview). Either is only how it travels - the node keeps every picture as
/// AVIF (media/image.rs).
export function flattenToBlob(drawing) {
    const canvas = flatten(drawing);
    return new Promise((resolve, reject) =>
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('could not make a picture of the drawing'))), 'image/webp', 0.92)
    );
}

/// Copy a drawing into a notebook as a PICTURE (DRAWING.md): flattened, uploaded through the ordinary
/// image door - the node keeps it as an AVIF image document - and filed into the notebook. Returns
/// the new image's id. A new notebook is defined first, as a Writer notebook.
export async function copyPictureInto(root, drawing, title, bucket, isNew) {
    if (isNew) {
        await api(`/api/identity/${root}/buckets`, { method: 'POST', body: JSON.stringify({ name: bucket, app: 'default' }) });
    }
    const picture = await flattenToBlob(drawing);
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
    const picture = await flattenToBlob(drawing);
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

let rememberedTools = { tool: 'brush', brushSize: 12, eraserSize: 40, color: '#1f1a17' };

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
    useEffect(() => {
        if (thumbCache.has(key)) {
            setSrc(thumbCache.get(key));
            return undefined;
        }
        let live = true;
        (async () => {
            let detail = await cachedDoc(root, doc.doc_id);
            if (!detail) {
                detail = await api(`/api/identity/${root}/docs/${doc.doc_id}`);
                rememberDoc(root, doc.doc_id, detail);
            }
            if (detail.body == null) return;
            const url = flatten(readBody(detail.body), THUMB_WIDTH).toDataURL('image/png');
            thumbCache.set(key, url);
            if (live) setSrc(url);
        })().catch(() => {});
        return () => {
            live = false;
        };
    }, [root, key]); // eslint-disable-line react-hooks/exhaustive-deps
    return src
        ? html`<img class=${big ? 'note-row-thumb note-row-thumb-big drawing-thumb drawing-floor' : 'note-row-thumb drawing-thumb drawing-floor'} src=${src} alt="" />`
        : html`<span class="note-row-thumb drawing-thumb drawing-thumb-empty"><${Icons.drawing} /></span>`;
};

// ---------------------------------------------------------------------------------------------
// The layers column's thumbnails: each layer alone, drawn from its own canvas.

const LayerThumb = ({ source, painted }) => {
    const ref = useRef(null);
    useEffect(() => {
        const canvas = ref.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (source) ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    }, [source, painted]);
    return html`<canvas ref=${ref} class="drawing-layer-thumb drawing-floor" width="64" height="48"></canvas>`;
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

    const { tucked, toggleTuck } = useColTucks(root, 'drawing', []);
    const { resizer, colStyle } = useColWidths(root, 'drawing', ['tools', 'layers'], { tools: 170, layers: 170 });

    // The layers (DRAWING.md, "Layers"): bottom of the stack first. The CURRENT layer is the one a
    // new stroke lands on and the opacity slider speaks for - the top one until another is picked,
    // and the top one again if the picked one stops existing (a merge can do that).
    const layers = useMemo(() => layersOf(drawing), [drawing]);
    const [currentId, setCurrentId] = useState(null);
    const current = layers.find((l) => l.id === currentId) || layers[layers.length - 1];

    // Every layer on a canvas of its own, repainted from the body whenever it changes - every save,
    // undo, layer change and sync - and stacked onto the screen. A stroke being drawn paints onto
    // its own layer's canvas as it goes and restacks, so a layer above still covers it.
    const layerCanvases = useRef(new Map());
    const [painted, setPainted] = useState(0); // bumps when the layer canvases change: the thumbnails follow
    const restack = (shift = null) => {
        const canvas = canvasRef.current;
        if (canvas) composite(canvas, drawing, layerCanvases.current, shift);
    };
    const [grabbing, setGrabbing] = useState(false); // the grab tool's hand, open or closed
    useEffect(() => {
        if (!opened) return;
        layerCanvases.current = paintLayers(drawing, drawing.width * BACKING);
        restack();
        setPainted((n) => n + 1);
    }, [drawing, opened]); // eslint-disable-line react-hooks/exhaustive-deps

    const changeLayers = (next) => {
        session.setBody(writeBody(next));
        session.touched();
    };

    const size = tools.tool === 'eraser' ? tools.eraserSize : tools.brushSize;

    /// A pointer position in the drawing's own units.
    const toDrawing = (e) => {
        const rect = canvasRef.current.getBoundingClientRect();
        return [((e.clientX - rect.left) * drawing.width) / rect.width, ((e.clientY - rect.top) * drawing.height) / rect.height];
    };

    // The size circle: follows the pointer, as big on screen as the tool is on the drawing.
    const moveCursor = (e) => {
        const cursor = cursorRef.current;
        const canvas = canvasRef.current;
        if (!cursor || !canvas) return;
        if (tools.tool === 'grab') {
            cursor.style.display = 'none'; // the grab tool's cursor is the hand, not a size
            return;
        }
        const rect = canvas.getBoundingClientRect();
        const diameter = Math.max(4, (size * rect.width) / drawing.width);
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

    const onPointerDown = (e) => {
        if (!opened || e.button > 0 || !current) return;
        // A hidden layer takes no strokes: they would land where nobody can see them.
        if (current.hidden) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        // The grab tool (DRAWING.md, "Grabbing"): the drag shows the layer moving, and letting go
        // records one `move` entry - merged and undone like a stroke.
        if (tools.tool === 'grab') {
            live.current = { grab: true, layer: current.id, start: toDrawing(e), dx: 0, dy: 0 };
            setGrabbing(true);
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

    const onPointerMove = (e) => {
        moveCursor(e);
        const l = live.current;
        if (!l) return;
        if (l.grab) {
            const [x, y] = toDrawing(e);
            l.dx = x - l.start[0];
            l.dy = y - l.start[1];
            restack({ layer: l.layer, dx: l.dx, dy: l.dy });
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
        ['grab', Icons.grab, t('doc.drawing.grab', 'grab - move the whole layer')],
    ];
    const grabTool = tools.tool === 'grab';
    const paperClass = grabTool
        ? grabbing
            ? 'drawing-paper drawing-floor grabbing'
            : 'drawing-paper drawing-floor grab'
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
                          onClick=${() => setTools({ tool })}
                      ><${icon} /></button>`
                  )}
              </div>
              ${!grabTool &&
              html`<label class="drawing-size">
                  <span>${tools.tool === 'eraser' ? t('doc.drawing.eraser-size', 'eraser size') : t('doc.drawing.brush-size', 'brush size')} · ${size}</span>
                  <input
                      type="range"
                      min="1"
                      max=${Math.min(80, MAX_SIZE)}
                      value=${size}
                      onInput=${(e) =>
                          setTools(tools.tool === 'eraser' ? { eraserSize: +e.currentTarget.value } : { brushSize: +e.currentTarget.value })}
                  />
              </label>`}
              <${ColourPicker} value=${tools.color} onChange=${(color) => setTools({ color, tool: 'brush' })} />
              <div class="drawing-colours" aria-label=${t('doc.drawing.colour', 'colour')}>
                  ${/* A click away: white and black always, then the last ten colours this
                      drawing's strokes used (Curtis, 2026-09-26) - the picker above has the rest. */ ''}
                  ${[...FIXED_COLOURS, ...recentColours(drawing, 10)].map(
                      (c) => html`<button
                          key=${c}
                          class=${tools.color === c ? 'drawing-swatch active' : 'drawing-swatch'}
                          style=${`background: ${c}`}
                          title=${c}
                          onClick=${() => setTools({ color: c, tool: 'brush' })}
                      ></button>`
                  )}
              </div>
              <button class="drawing-tool" disabled=${!drawing.strokes.length} onClick=${undoStroke}>
                  <${Icons.unpublish} /> ${t('doc.drawing.undo', 'undo')}
              </button>
              <p class="drawing-count">
                  ${t('doc.drawing.strokes', '{count} strokes', { count: drawing.strokes.length })}
              </p>
          </aside>${resizer('tools')}`;

    // The layers column: the current layer's opacity on top of the stack, a new layer, and the stack
    // itself top-first - each row the layer alone, its name, its eye; drag a row to move it, click it
    // to draw on it.
    const newLayer = () => {
        const id = strokeId();
        changeLayers(addLayer(drawing, id, Date.now()));
        setCurrentId(id);
    };
    const dropOnto = (e, stackIndex) => {
        e.preventDefault();
        const id = e.dataTransfer.getData('text/x-drawing-layer');
        if (id) changeLayers(moveLayer(drawing, id, stackIndex, Date.now()));
    };
    const layersColumn = tucked.has('layers')
        ? html`<${Rail} icon=${Icons.layers} label=${t('doc.drawing.layers', 'layers')} onClick=${() => toggleTuck('layers')} />`
        : html`<aside class="drawing-layers" style=${colStyle}>
              <${PaneHead} label=${t('doc.drawing.layers', 'layers')} onTuck=${() => toggleTuck('layers')} />
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
              <button class="drawing-tool" disabled=${!opened} onClick=${newLayer}>
                  <${Icons.plus} /> ${t('doc.drawing.new-layer', 'new layer')}
              </button>
              <ol class="drawing-layer-list">
                  ${[...layers].reverse().map((layer, row) => {
                      const stackIndex = layers.length - 1 - row;
                      const isCurrent = current && layer.id === current.id;
                      return html`<li
                          key=${layer.id}
                          class=${isCurrent ? 'drawing-layer current' : 'drawing-layer'}
                          draggable=${true}
                          onDragStart=${(e) => {
                              e.dataTransfer.setData('text/x-drawing-layer', layer.id);
                              e.dataTransfer.effectAllowed = 'move';
                          }}
                          onDragOver=${(e) => e.preventDefault()}
                          onDrop=${(e) => dropOnto(e, stackIndex)}
                          onClick=${() => setCurrentId(layer.id)}
                      >
                          <${LayerThumb} source=${layerCanvases.current.get(layer.id)} painted=${painted} />
                          <span class=${layer.hidden ? 'drawing-layer-name hidden' : 'drawing-layer-name'}>
                              ${t('doc.drawing.layer-n', 'layer {n}', { n: layer.n })}
                          </span>
                          <button
                              class="drawing-layer-eye"
                              title=${layer.hidden ? t('doc.drawing.show-layer', 'show this layer') : t('doc.drawing.hide-layer', 'hide this layer')}
                              onClick=${(e) => {
                                  e.stopPropagation();
                                  changeLayers(setLayer(drawing, layer.id, { hidden: !layer.hidden }, Date.now()));
                              }}
                          ><${layer.hidden ? Icons.eyeClosed : Icons.eye} /></button>
                      </li>`;
                  })}
              </ol>
              ${current && current.hidden &&
              html`<p class="null-sub">${t('doc.drawing.this-layer-is-hidden', 'this layer is hidden - show it to draw on it')}</p>`}
          </aside>${resizer('layers')}`;

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
                icon=${Icons.pageNew}
                title=${busy ? t('doc.drawing.duplicating', 'duplicating…') : t('doc.drawing.duplicate-this-drawing', 'duplicate - a new drawing, strokes and all')}
                onClick=${() => opened && !busy && duplicate()}
            />
            ${onDeleted &&
            row &&
            !row.fields?.published_as &&
            html`<${Chip} icon=${Icons.trash} modifier="chip-delete" title=${t('doc.drawing.delete', 'delete')} onClick=${session.remove} />`}
            <${Chip}
                modifier=${session.status === 'error' ? 'chip-diverged' : null}
                title=${session.status === 'clean'
                    ? t('doc.drawing.saved', 'saved')
                    : session.status === 'error'
                    ? session.error || t('doc.drawing.not-saved', 'not saved - it will try again')
                    : t('doc.drawing.saving', 'saving…')}
            >
                ${session.status === 'clean'
                    ? html`<${Icons.saved} />`
                    : session.status === 'error'
                    ? html`<${Icons.warn} />`
                    : html`<span class="status-spin"><${Icons.spinner} /></span>`}
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
            <${PublishBar} root=${root} docId=${docId} row=${row} publish=${publishThis} differs=${differs} diffHref=${null} />
            <div class="drawing-stage">
                ${!opened
                    ? html`<p class="null-sub">${t('doc.drawing.opening', 'opening…')}</p>`
                    : html`<div
                          class=${paperClass}
                          style=${`aspect-ratio: ${drawing.width} / ${drawing.height}`}
                          onPointerLeave=${() => cursorRef.current && (cursorRef.current.style.display = 'none')}
                      >
                          <canvas
                              ref=${canvasRef}
                              class="drawing-canvas"
                              width=${drawing.width * BACKING}
                              height=${drawing.height * BACKING}
                              onPointerDown=${onPointerDown}
                              onPointerMove=${onPointerMove}
                              onPointerUp=${finishStroke}
                              onPointerCancel=${finishStroke}
                          ></canvas>
                          <span ref=${cursorRef} class=${tools.tool === 'eraser' ? 'drawing-cursor eraser' : 'drawing-cursor'}></span>
                      </div>`}
            </div>
        </div>`;
};
