// The drawing's image picker (Curtis, 2026-09-27): every picture in the person's own media, newest
// first, narrowed by a notebook, by tags and by words in the title. Value in, value out; the modal
// (doc/imagepick.js) shows what these return.
//
// The filters stack as the documents list's do (pure/doclist.js): the notebook, then the title
// words, then every picked tag - and the tag cloud is counted before the tags are applied, so it
// narrows with the search and the notebook but still shows every tag that could be added.
import { OWN_MEDIA_KINDS } from './mediakind.js';
import { createdMs } from './docdate.js';
import { tagCounts } from './doclist.js';

/// A picture that can go into a drawing: an image document (still or animated - an animation is
/// drawn as its first frame) whose size the node knows, since that is how it is placed.
export const isPicture = (doc) =>
    !!doc &&
    OWN_MEDIA_KINDS[doc.format] === 'image' &&
    !!doc.media &&
    doc.media.width > 0 &&
    doc.media.height > 0;

/// The words a title search looks for: lowercase, split on whitespace. Every word must appear.
const wordsOf = (query) => (query || '').toLocaleLowerCase().split(/\s+/).filter(Boolean);

/// Newest first, as they were ADDED - a picture's claimed date where it has one, else when it
/// began (`createdMs`): retitling or tagging an old picture does not bring it back to the top.
export const newestFirst = (a, b) => createdMs(b) - createdMs(a) || (a.doc_id < b.doc_id ? 1 : -1);

/// What can be picked: pictures, and - when asked (the profile's picture, Curtis 2026-09-27: make
/// your own rather than upload one) - drawings too.
const pickable = (drawings) => (d) => isPicture(d) || (drawings && !!d && d.format === 'drawing');

/// The pictures before the tags: pickable only, in `bucket` (null for every notebook), with
/// every word of `query` in the title.
function narrowed(docs, { query, bucket, drawings }) {
    const words = wordsOf(query);
    return (docs || [])
        .filter(pickable(drawings))
        .filter((d) => !bucket || (d.buckets || []).includes(bucket))
        .filter((d) => {
            const title = (d.title || '').toLocaleLowerCase();
            return words.every((w) => title.includes(w));
        });
}

/// The tag that makes a picture or a drawing a sticker (Curtis, 2026-09-28).
export const STICKER_TAG = 'sticker';

/// The drawing app's sticker shelf: every picture and drawing tagged `sticker`, newest first, the ones
/// carrying every tag in `tags`; and the tag cloud of the stickers' OTHER tags, counted before those
/// tags narrow it - `sticker` itself says nothing on a shelf where everything wears it.
export function stickersOf(docs, tags = []) {
    const all = (docs || [])
        .filter(pickable(true))
        .filter((d) => (d.tags || []).includes(STICKER_TAG));
    const stickers = all
        .filter((d) => tags.every((t) => (d.tags || []).includes(t)))
        .sort(newestFirst);
    return { stickers, tags: tagCounts(all).filter(([t]) => t !== STICKER_TAG) };
}

/// The longest side a sticker shows under the cursor, in screen pixels - what browsers allow a
/// cursor to be.
export const STICKER_MAX_PX = 128;

/// How big a sticker shows under the cursor, [w, h] in screen pixels: its own size at the canvas's
/// scale on screen (`scale` screen pixels per canvas unit), never past STICKER_MAX_PX on its
/// longer side, never nothing.
export function stickerCursorSize(width, height, scale) {
    const w = Math.max(1, (width || 1) * scale);
    const h = Math.max(1, (height || 1) * scale);
    const shrink = Math.min(1, STICKER_MAX_PX / Math.max(w, h));
    return [Math.max(1, w * shrink), Math.max(1, h * shrink)];
}

/// What the picker shows: `{ pictures, tags, buckets }` - the pictures passing every filter, newest
/// first; the tag cloud ([tag, count], most-used first) over the pictures before the tag filter;
/// and every notebook holding any picture at all, alphabetical, so the notebook menu never shrinks
/// out from under a search.
export function pickPictures(
    docs,
    { query = '', bucket = null, tags = [], drawings = false } = {},
) {
    const before = narrowed(docs, { query, bucket, drawings });
    const pictures = before
        .filter((d) => tags.every((t) => (d.tags || []).includes(t)))
        .sort(newestFirst);
    const buckets = [
        ...new Set((docs || []).filter(pickable(drawings)).flatMap((d) => d.buckets || [])),
    ].sort((a, b) => a.localeCompare(b));
    return { pictures, tags: tagCounts(before), buckets };
}
