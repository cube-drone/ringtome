// hrseFiles™ as the picture picker lays out (Curtis, 2026-09-29: "the design of the picture-chooser
// is much closer to how the whole files app should look"): the notebooks, then the tags, then every
// file as a tile. This is the narrowing, pure; notes.js draws it.
//
// The notebook is a pick of one: every notebook (''), one by name, or the unfiled - the strays this
// app exists to keep findable. The tag cloud counts what the chosen notebook holds, so it only ever
// offers a tag that would find something; the tags then AND, as they do everywhere.

import { tagCounts } from './doclist.js';

/// The "not in any notebook" pick - a name no notebook can have (bucket names are trimmed words).
export const UNFILED = '\u0000unfiled';

/// The kind row's kinds, in its order (Curtis, 2026-10-02: "just get me images"): the words a
/// person writes, drawings, then the media - a silent loop is a moving picture, so an image, as
/// the node's own media tags have it (`documents::media_tag`).
export const FILE_KINDS = ['post', 'drawing', 'image', 'audio', 'video'];

/// Which of `FILE_KINDS` a file is, or null for a format none of them names.
export function fileKind(d) {
    const format = d && d.format;
    if (!format || format === 'marquee' || format === 'plaintext' || format === 'book')
        return 'post';
    if (format === 'drawing') return 'drawing';
    if (format === 'avif' || format === 'apng') return 'image';
    if (format === 'webm') return d.media && d.media.animation ? 'image' : 'video';
    if (format === 'opus') return 'audio';
    return null;
}

const inNotebook = (d, notebook) =>
    !notebook
        ? true
        : notebook === UNFILED
          ? !(d.buckets || []).length
          : (d.buckets || []).includes(notebook);

/// `docs`: the list as the app already ordered and searched it. Returns the tiles to show, the
/// notebooks to offer (every one the docs are in, by name), whether any file is unfiled, the tag
/// cloud over the chosen notebook and kinds, and the kind row over the chosen notebook and tags -
/// `{ value, count }` in `FILE_KINDS` order, every kind present plus any picked. Kinds picked
/// are either-or, as the feed's kind row is; the tags AND.
export function browseFiles(docs, { notebook = '', tags = [], kinds = [] } = {}) {
    const all = docs || [];
    const here = all.filter((d) => inNotebook(d, notebook));
    const ofKind = (d) => !kinds.length || kinds.includes(fileKind(d));
    const tagged = (d) => tags.every((t) => (d.tags || []).includes(t));
    const counted = here.filter(tagged);
    return {
        files: here.filter((d) => ofKind(d) && tagged(d)),
        notebooks: [...new Set(all.flatMap((d) => d.buckets || []))].sort((a, b) =>
            a.localeCompare(b),
        ),
        unfiled: all.some((d) => !(d.buckets || []).length),
        cloud: tagCounts(here.filter(ofKind)),
        kinds: FILE_KINDS.map((value) => ({
            value,
            count: counted.filter((d) => fileKind(d) === value).length,
        })).filter((k) => k.count > 0 || kinds.includes(k.value)),
    };
}
