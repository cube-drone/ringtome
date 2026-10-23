// Bulk actions, as values (plans/BULK.md): the selection - Shift-click, select-all, and what
// leaves it - and every decision an action makes before it writes: which documents it touches, the
// tags they carry between them, which notebooks a move offers, and what a move takes each document
// out of. doc/bulk.js runs the writes; these say what they are.
import { appTypeOf, bucketsForApp, RESERVED_BUCKETS, RESERVED_STYLE } from './apps.js';
import { docPlacement } from './naming.js';
import { fileKind } from './filebrowse.js';

// --- the selection ----------------------------------------------------------------------------

/// Shift-click: `id` joins the selection, or leaves it if it was in. The first Shift-click while a
/// document is open (`open`) takes the open one along, so "open one, Shift-click another" is two.
export function toggleSelection(picked, id, open = null) {
    if (picked.includes(id)) return picked.filter((x) => x !== id);
    if (!picked.length && open && open !== id) return [open, id];
    return [...picked, id];
}

/// "select all": what the list shows now, narrowed however it is narrowed, in its order.
export const selectAll = (listed) => listed.map((d) => d.doc_id);

/// The selection, less whatever has left the list (deleted, moved out of the notebook in view, or
/// narrowed away). The same array when nothing left, so a caller can skip a needless re-render.
export function pruneSelection(picked, listedIds) {
    const listed = new Set(listedIds);
    const kept = picked.filter((id) => listed.has(id));
    return kept.length === picked.length ? picked : kept;
}

// --- what an action touches ---------------------------------------------------------------------

/// The ones an action may write to: the app's own pictures and sounds (`builtin`) are nobody's to
/// delete, move or annotate - they can be selected, since select-all takes what's shown, and are
/// left alone.
export const actionable = (docs) => docs.filter((d) => d && !d.builtin);

/// The sounds among them: what the sound fields and the cover are set on.
export const soundsAmong = (docs) => actionable(docs).filter((d) => fileKind(d) === 'audio');

/// The sound fields bulk sets (Curtis, 2026-10-11): every one but the song's name (`track`) and
/// its number, which are each track's own. In media/audio.rs `TAG_FIELDS`'s order.
export const BULK_SOUND_FIELDS = ['artist', 'album', 'album artist', 'composer', 'genre', 'year'];

/// Every tag the documents carry between them, with how many carry it: the commonest first, then
/// by name. What "remove a tag from all" offers - so not the tags the node computes for a document
/// (its size and media, the row's `implicit`), which removing would leave exactly where they were
/// (Curtis, 2026-10-22). What it was made with is offered: a person may take that off.
export function combinedTags(docs) {
    const counts = new Map();
    for (const d of docs) {
        const computed = d.implicit || [];
        for (const tag of d.tags || []) {
            if (!computed.includes(tag)) counts.set(tag, (counts.get(tag) || 0) + 1);
        }
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/// How many words the documents are between them (Curtis, 2026-10-23: "when I select multiple
/// documents, I'd love to see a word count"), off each row's `words` - the node's count, which
/// only words have. `null` when none of them is words: a selection of drawings has no count to
/// show, rather than a count of nothing.
export function wordsAmong(docs) {
    const counted = docs.filter((d) => d && typeof d.words === 'number');
    return counted.length ? counted.reduce((sum, d) => sum + d.words, 0) : null;
}

/// The ones that carry `tag` - what removing it writes to.
export const carrying = (docs, tag) => docs.filter((d) => (d.tags || []).includes(tag));

/// The ones that don't carry `tag` yet - what adding it writes to.
export const lacking = (docs, tag) => docs.filter((d) => !(d.tags || []).includes(tag));

// --- moving -------------------------------------------------------------------------------------

/// The notebooks a move offers. In a notebook app, the app's others - the notebook in view is
/// where they already are. In hrseFiles (`everything`), every notebook there is but the reserved
/// ones (chat's, the uploads'), since the selection may hold any app's documents.
export function moveTargets(app, roster, inView) {
    if (app.everything) {
        return [...new Set((roster || []).map((b) => b.name).filter(Boolean))]
            .filter((n) => !RESERVED_BUCKETS.has(n))
            .sort((a, b) => a.localeCompare(b));
    }
    return bucketsForApp(app, roster).filter((n) => n !== inView);
}

/// What a move to `to` takes a document out of, or null when it only files it there.
///
/// The notebook it is left from is the one in view, when it's there (a notebook app), else the one
/// it opens in - its first (hrseFiles). It leaves that one only for a notebook of the same app: a
/// note moved to another writing notebook leaves the first, but a note filed in a drawing notebook
/// from hrseFiles is filed there and stays where it was - the single-note move's rule
/// (doc/annotations.js `NotebookMove`), applied to each. A reserved notebook (the uploads') is never
/// left: a file stays an upload wherever else it is filed.
///
/// `toType` is the destination's app, when the roster can't say it yet: a notebook made a moment
/// ago for this move isn't in it until the stream brings it.
export function moveOutOf(row, roster, to, { inView = null, toType = null } = {}) {
    const held = (row && row.buckets) || [];
    const from = inView && held.includes(inView) ? inView : docPlacement(row, roster).bucket;
    if (!from || from === to) return null;
    const fromType = appTypeOf(from, roster);
    if (fromType === RESERVED_STYLE || fromType !== (toType || appTypeOf(to, roster))) return null;
    return from;
}

/// A name typed for a new notebook to move into: trimmed, and refused when it is reserved for
/// another app (it would vanish from every switcher) - `{ name, refused }`.
export function newNotebookName(raw) {
    const name = String(raw || '').trim();
    if (!name) return { name, refused: 'empty' };
    if (RESERVED_BUCKETS.has(name)) return { name, refused: 'reserved' };
    return { name, refused: null };
}
