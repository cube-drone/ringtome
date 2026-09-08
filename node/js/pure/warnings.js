// Content warnings by tag (2026-09-07): a persona keeps two lists. Tags on the BLUR list
// leave a post's front matter - byline, title, labels - in view and blur the rest until
// clicked through; tags on the HIDE list keep the post off the page. A tag counts when it
// was said by the post's author, by the reader, or by anyone the reader trusts - the same
// people whose word the reader already takes. Pure: the judgment has a test.

export const DEFAULT_BLUR = ['nsfw', 'porn', 'assault', 'death', 'gore', 'sexual assault', '18+'];
export const DEFAULT_HIDE = [];

/// One tag's spelling for comparison: trimmed, lowercased, inner runs of space collapsed.
export const normalizeTag = (tag) => String(tag || '').trim().toLowerCase().replace(/\s+/g, ' ');

/// A stored list (a JSON array in a private register) back to tags; absent or unreadable
/// means the fallback stands.
export function parseTagList(value, fallback) {
    if (value == null || value === '') return [...fallback];
    try {
        const list = JSON.parse(value);
        return Array.isArray(list) ? list.map(normalizeTag).filter(Boolean) : [...fallback];
    } catch {
        return [...fallback];
    }
}

export const serializeTagList = (list) =>
    JSON.stringify([...new Set((list || []).map(normalizeTag).filter(Boolean))]);

/// Is this annotator's word taken? The author's, the reader's own, or a trusted person's.
const spoken = (annotator, { author, me, factsByRoot }) => {
    if (annotator === author || (me && annotator === me)) return true;
    const trust = factsByRoot && factsByRoot[annotator] && factsByRoot[annotator].trust;
    return !!trust && trust !== 'none';
};

/// The verdict for one post: `{ kind: 'hide' | 'blur' | null, tags: [...] }` - the tags that
/// decided it. Hide outranks blur.
export function warningFor(annotations, { author, me, factsByRoot, blur, hide }) {
    const said = new Set();
    for (const a of annotations || []) {
        if (a.key !== 'tag' || !spoken(a.annotator, { author, me, factsByRoot })) continue;
        said.add(normalizeTag(a.value));
    }
    const hits = (list) => (list || []).map(normalizeTag).filter((tag) => said.has(tag));
    const hidden = hits(hide);
    if (hidden.length) return { kind: 'hide', tags: hidden };
    const blurred = hits(blur);
    if (blurred.length) return { kind: 'blur', tags: blurred };
    return { kind: null, tags: [] };
}
