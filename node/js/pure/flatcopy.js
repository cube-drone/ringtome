// A drawing's flat copy, reused (Curtis, 2026-09-27: "wasteful to keep cutting the same image out
// of the same drawing ad infinitum"). A drawing picked into a note, a chat line or another drawing
// is copied in as a picture (doc/drawing.js drawingAsPicture); the copy carries two private
// annotations saying what it is a copy OF - the drawing, and the version of it - so the next pick
// of an unchanged drawing finds the copy it already has rather than cutting another. A changed
// drawing is a different version and gets a fresh copy; the old one stays, still used where it was
// used. Annotations, not edits: the copy only carries a note of its source.

/// The annotation fields a flat copy carries.
export const FLAT_FROM = 'flattened_from';
export const FLAT_VERSION = 'flattened_version';

/// A drawing's version, as its flat copy remembers it: every head it had when read, in order - the
/// same heads are the same merged drawing, and so the same picture.
export function flatVersion(detail) {
    return [...((detail && (detail.save_parents || detail.heads)) || [])].map(String).sort().join(',');
}

/// The flat copy already made of drawing `sourceId` at `version`, among `docs` (the mirror's rows),
/// or null. A deleted copy is not in the rows, so a deleted one is never handed back.
export function findFlatCopy(docs, sourceId, version) {
    if (!version) return null;
    return (docs || []).find((d) => d && d.fields && d.fields[FLAT_FROM] === sourceId && d.fields[FLAT_VERSION] === version) || null;
}
