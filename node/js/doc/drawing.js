// The drawing surface (DRAWING.md): one drawing open for drawing on, in the documents app's
// right-hand column - a tools column, then the canvas. The body is the drawing's strokes
// (pure/drawing.js holds the rules); loading, autosaving, the flush on leaving, and reloading when
// another computer changes it are the ordinary document session's (doc/session.js), because a
// drawing's body is a string like any other.
//
// Painting: the canvas holds the STROKES only, over a CSS background of the drawing's paper, so an
// eraser stroke (`destination-out`) cuts back to the paper rather than to a transparent hole. A
// picture of the drawing - a thumbnail, a copy, a publication - is `flatten`: the paper, then the
// strokes on top. The canvas is backed at twice the drawing's size so lines stay crisp on dense
// screens; points are always stored in the drawing's own units (800 x 600).
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
import { useColWidths, useColTucks, PaneHead, Rail } from '../panes.js';
import { Icons } from '../icons.js';
import { t } from '../i18n.js';
import { readBody, writeBody, addStroke, undo, strokeId, encodePoints, decodePoints, MAX_SIZE } from '../pure/drawing.js';
import { publishedState } from '../pure/feed.js';

const html = htm.bind(h);

/// The canvas's backing resolution, as a multiple of the drawing's own units.
const BACKING = 2;

/// The colours a click away; the picker beside them has all the rest.
export const SWATCHES = ['#1f1a17', '#8a4b1f', '#c9a36b', '#fffefb', '#7a1f6e', '#1f9e90', '#db6a63', '#f3e08c'];

// ---------------------------------------------------------------------------------------------
// Painting

function paintStroke(ctx, stroke, scale, points = decodePoints(stroke.points)) {
    ctx.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = ctx.fillStyle = stroke.tool === 'eraser' ? '#000' : stroke.color;
    ctx.lineWidth = stroke.size * scale;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (points.length === 1) {
        ctx.beginPath();
        ctx.arc(points[0][0] * scale, points[0][1] * scale, (stroke.size * scale) / 2, 0, Math.PI * 2);
        ctx.fill();
        return;
    }
    ctx.beginPath();
    ctx.moveTo(points[0][0] * scale, points[0][1] * scale);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0] * scale, points[i][1] * scale);
    ctx.stroke();
}

/// Every standing stroke, in order, onto a canvas that holds only strokes.
export function paintStrokes(canvas, drawing) {
    const ctx = canvas.getContext('2d');
    const scale = canvas.width / drawing.width;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const stroke of drawing.strokes) paintStroke(ctx, stroke, scale);
    ctx.restore();
}

/// A picture of the drawing, `width` pixels wide: the paper, then the strokes. What a thumbnail, a
/// copy into a notebook and a publication are all made from.
export function flatten(drawing, width = drawing.width) {
    const height = Math.round((width * drawing.height) / drawing.width);
    const strokes = document.createElement('canvas');
    strokes.width = width;
    strokes.height = height;
    paintStrokes(strokes, drawing);
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = drawing.background;
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(strokes, 0, 0);
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
/// within the post's day; after that the node says to take it down and post again.
export async function publishDrawing(root, docId, drawing) {
    const picture = await flattenToBlob(drawing);
    return xhrUpload(`/api/identity/${root}/docs/${docId}/publish/drawing`, picture);
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
        ? html`<img class=${big ? 'note-row-thumb note-row-thumb-big drawing-thumb' : 'note-row-thumb drawing-thumb'} src=${src} alt="" />`
        : html`<span class="note-row-thumb drawing-thumb drawing-thumb-empty"><${Icons.drawing} /></span>`;
};

// ---------------------------------------------------------------------------------------------
// The surface

export const DrawingSurface = ({ root, docId, nav, onDeleted }) => {
    const session = useDocSession(root, docId, { onDeleted });
    const loc = useLocation();
    const [copying, setCopying] = useState(false);
    const [actionError, setActionError] = useState(null);
    const [busy, setBusy] = useState(false);

    const { postId, published } = publishedState(session.row);
    const publish = async () => {
        setBusy(true);
        setActionError(null);
        try {
            await session.save(); // the node publishes the drawing's saved state as its draft
            await publishDrawing(root, docId, drawing);
        } catch (e) {
            setActionError(e.message);
        } finally {
            setBusy(false);
        }
    };
    const unpublish = async () => {
        if (!confirm(t('doc.drawing.unpublish-confirm', 'Take this drawing down? The post leaves your page, and the people who have it are told it is gone.'))) return;
        setBusy(true);
        setActionError(null);
        try {
            await api(`/api/identity/${root}/posts/${postId}`, { method: 'DELETE' });
        } catch (e) {
            setActionError(e.message);
        } finally {
            setBusy(false);
        }
    };

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
    const canvasRef = useRef(null);
    const cursorRef = useRef(null);
    const live = useRef(null); // the stroke being drawn: { stroke, points }
    const opened = session.status !== 'opening' && session.status !== 'waiting';

    const { tucked, toggleTuck } = useColTucks(root, 'drawing', []);
    const { resizer, colStyle } = useColWidths(root, 'drawing', ['tools'], { tools: 170 });

    // Whatever the body says is what the canvas shows: every save, undo and sync repaints from it.
    useEffect(() => {
        const canvas = canvasRef.current;
        if (canvas && opened) paintStrokes(canvas, drawing);
    }, [drawing, opened]);

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
        const rect = canvas.getBoundingClientRect();
        const diameter = Math.max(4, (size * rect.width) / drawing.width);
        cursor.style.width = cursor.style.height = `${diameter}px`;
        cursor.style.transform = `translate(${e.clientX - rect.left - diameter / 2}px, ${e.clientY - rect.top - diameter / 2}px)`;
        cursor.style.display = 'block';
    };

    const onPointerDown = (e) => {
        if (!opened || e.button > 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const first = toDrawing(e);
        const stroke = { id: strokeId(), t: Date.now(), tool: tools.tool, size: Math.round(size) };
        if (tools.tool === 'brush') stroke.color = tools.color;
        live.current = { stroke, points: [first] };
        const ctx = canvasRef.current.getContext('2d');
        paintStroke(ctx, stroke, BACKING, [first]);
    };

    const onPointerMove = (e) => {
        moveCursor(e);
        const l = live.current;
        if (!l) return;
        const next = toDrawing(e);
        const last = l.points[l.points.length - 1];
        if (Math.abs(next[0] - last[0]) < 0.5 && Math.abs(next[1] - last[1]) < 0.5) return;
        l.points.push(next);
        const ctx = canvasRef.current.getContext('2d');
        paintStroke(ctx, l.stroke, BACKING, [last, next]);
    };

    const finishStroke = () => {
        const l = live.current;
        live.current = null;
        if (!l) return;
        const stroke = { ...l.stroke, points: encodePoints(l.points) };
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

    const toolsColumn = tucked.has('tools')
        ? html`<${Rail} icon=${Icons.drawing} label=${t('doc.drawing.tools', 'tools')} onClick=${() => toggleTuck('tools')} />`
        : html`<aside class="drawing-tools" style=${colStyle}>
              <${PaneHead} label=${t('doc.drawing.tools', 'tools')} onTuck=${() => toggleTuck('tools')} />
              <div class="drawing-toolset">
                  <button
                      class=${tools.tool === 'brush' ? 'drawing-tool active' : 'drawing-tool'}
                      onClick=${() => setTools({ tool: 'brush' })}
                  ><${Icons.drawing} /> ${t('doc.drawing.brush', 'brush')}</button>
                  <button
                      class=${tools.tool === 'eraser' ? 'drawing-tool active' : 'drawing-tool'}
                      onClick=${() => setTools({ tool: 'eraser' })}
                  ><${Icons.eraser} /> ${t('doc.drawing.eraser', 'eraser')}</button>
              </div>
              <label class="drawing-size">
                  <span>${tools.tool === 'eraser' ? t('doc.drawing.eraser-size', 'eraser size') : t('doc.drawing.brush-size', 'brush size')} · ${size}</span>
                  <input
                      type="range"
                      min="1"
                      max=${Math.min(80, MAX_SIZE)}
                      value=${size}
                      onInput=${(e) =>
                          setTools(tools.tool === 'eraser' ? { eraserSize: +e.currentTarget.value } : { brushSize: +e.currentTarget.value })}
                  />
              </label>
              <div class="drawing-colours" aria-label=${t('doc.drawing.colour', 'colour')}>
                  ${SWATCHES.map(
                      (c) => html`<button
                          key=${c}
                          class=${tools.color === c ? 'drawing-swatch active' : 'drawing-swatch'}
                          style=${`background: ${c}`}
                          title=${c}
                          onClick=${() => setTools({ color: c, tool: 'brush' })}
                      ></button>`
                  )}
                  <input
                      class="drawing-picker"
                      type="color"
                      value=${tools.color}
                      title=${t('doc.drawing.any-colour', 'any colour')}
                      onInput=${(e) => setTools({ color: e.currentTarget.value.toLowerCase(), tool: 'brush' })}
                  />
              </div>
              <button class="drawing-tool" disabled=${!drawing.strokes.length} onClick=${undoStroke}>
                  <${Icons.unpublish} /> ${t('doc.drawing.undo', 'undo')}
              </button>
              <p class="drawing-count">
                  ${t('doc.drawing.strokes', '{count} strokes', { count: drawing.strokes.length })}
              </p>
              <div class="drawing-actions">
                  <button class="drawing-tool" disabled=${busy || !opened} onClick=${duplicate}>
                      <${Icons.copy} /> ${t('doc.drawing.duplicate', 'duplicate')}
                  </button>
                  <button class="drawing-tool" disabled=${busy || !opened} onClick=${() => setCopying(true)}>
                      <${Icons.fileImage} /> ${t('doc.drawing.copy-into-a-notebook', 'copy into a notebook')}
                  </button>
              </div>
              <div class=${published ? 'drawing-actions drawing-published' : 'drawing-actions'}>
                  ${published
                      ? html`<p class="drawing-standing"><${Icons.docPublic} /> ${t('doc.drawing.published', 'published')}</p>
                            <a class="drawing-tool" href=${`/id/${root}/post/${postId}`}>
                                <${Icons.link} /> ${t('doc.drawing.view', 'view the post')}
                            </a>
                            <button class="drawing-tool" disabled=${busy || !opened} onClick=${publish}>
                                <${Icons.update} /> ${t('doc.drawing.publish-again', 'publish it again, as it is now')}
                            </button>
                            <button class="drawing-tool" disabled=${busy} onClick=${unpublish}>
                                <${Icons.unpublish} /> ${t('doc.drawing.unpublish', 'unpublish')}
                            </button>`
                      : html`<button class="drawing-tool" disabled=${busy || !opened} onClick=${publish}>
                            <${Icons.docPublic} /> ${t('doc.drawing.publish', 'publish')}
                        </button>`}
              </div>
              ${actionError && html`<p class="form-error">${actionError}</p>`}
              ${copying &&
              html`<${CopyIntoModal}
                  current=${{ root }}
                  source=${{ author: root, doc_id: docId, private: true }}
                  heading=${t('doc.drawing.copy-a-picture-of-it', 'copy a picture of this drawing into a notebook')}
                  copyWith=${(bucket, isNew) => copyPictureInto(root, drawing, session.title, bucket, isNew)}
                  onClose=${() => setCopying(false)}
              />`}
          </aside>${resizer('tools')}`;

    const header = html`<header class="drawing-head">
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
            ${session.status === 'saving' && html`<${Chip}>${t('doc.drawing.saving', 'saving…')}</${Chip}>`}
            ${onDeleted &&
            html`<${Chip} icon=${Icons.trash} modifier="chip-delete" title=${t('doc.drawing.delete', 'delete')} onClick=${session.remove} />`}
            <${Chip}
                icon=${Icons.tag}
                on=${showMeta}
                title=${t('doc.drawing.tags', 'tags, date & description')}
                onClick=${() => setShowMeta((v) => !v)}
            />
            <${NavChips} nav=${nav} />
        </span>
        ${showMeta && html`<div class="editor-meta"><${Annotations} root=${root} docId=${docId} /></div>`}
        ${session.error && html`<p class="form-error">${session.error}</p>`}
    </header>`;

    return html`${toolsColumn}
        <div class="drawing">
            ${header}
            <div class="drawing-stage">
                ${!opened
                    ? html`<p class="null-sub">${t('doc.drawing.opening', 'opening…')}</p>`
                    : html`<div
                          class="drawing-paper"
                          style=${`background: ${drawing.background}; aspect-ratio: ${drawing.width} / ${drawing.height}`}
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
