// Dragging a document INTO a document: the crosslink drag, and the swap registry that finishes it.
//
// The editing surfaces (CodeMirror, textareas) natively insert a drag's text/plain at the POINTER
// on drop - precision for free - so the drag itself carries the link markup. Media docs carry their
// byte-URL embed (`![title](…/body/name.ext)` - the extension the renderer's kind sniff needs; a
// cozy /home path serves the app, not bytes, so an embed can't use it). Ordinary docs carry an
// id-form link (valid immediately), and the cozy form computes in flight - the receiving editor
// swaps id-form for cozy when it lands.
//
// Split out of the addressing rules (it only lived there because it needs a path): this is a wire
// protocol between two surfaces - the MIME types below are the whole vocabulary - and the swap
// registry is mutable module state, which the rules deliberately have none of.
import { slugPathFor } from './address.js';
import { MEDIA_EXT, slugify } from './naming.js';

/// The drag's own MIME types: what a payload IS, so a receiving surface can decide before it reads.
/// A section is marked so an editor drop can refuse it - a section isn't insertable text.
export const DOC_DRAG = 'application/x-ringtome-doc';
export const SECTION_DRAG = 'application/x-ringtome-section';

const dragSwaps = new Map(); // inserted id-form text -> Promise<cozy-form text>

/// Begin dragging a document row (list or tree). Writes the drag payload; registers the cozy swap
/// for non-media docs. `doc` needs doc_id/title/format; `bucket` is the notebook in view.
export function startDocDrag(e, root, doc, bucket) {
    const label = (doc.title || 'untitled').replace(/[[\]()]/g, '') || 'untitled';
    e.dataTransfer.setData(DOC_DRAG, doc.doc_id);
    e.dataTransfer.effectAllowed = 'copyMove';
    const ext = MEDIA_EXT[doc.format];
    if (ext) {
        const slug = slugify(label).replace(/-/g, '_') || 'file';
        e.dataTransfer.setData(
            'text/plain',
            `![${label}](/api/identity/${root}/docs/${doc.doc_id}/body/${slug}.${ext})`
        );
        return; // the byte URL is already final - nothing to swap
    }
    const idText = `[${label}](/home/${slugify(bucket)}/${doc.doc_id})`;
    e.dataTransfer.setData('text/plain', idText);
    dragSwaps.set(
        idText,
        slugPathFor(root, doc.doc_id, bucket).then((cozy) => (cozy ? `[${label}](${cozy})` : idText))
    );
    setTimeout(() => dragSwaps.delete(idText), 60_000); // an abandoned drag doesn't leak
}

/// The receiving editor claims a dropped doc-drag's cozy swap (by the exact inserted text).
export function takeDocDropSwap(idText) {
    const p = dragSwaps.get(idText) || null;
    dragSwaps.delete(idText);
    return p;
}
