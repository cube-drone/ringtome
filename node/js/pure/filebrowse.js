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

const inNotebook = (d, notebook) =>
    !notebook ? true : notebook === UNFILED ? !(d.buckets || []).length : (d.buckets || []).includes(notebook);

/// `docs`: the list as the app already ordered and searched it. Returns the tiles to show, the
/// notebooks to offer (every one the docs are in, by name), whether any file is unfiled, and the
/// tag cloud over the chosen notebook.
export function browseFiles(docs, { notebook = '', tags = [] } = {}) {
    const all = docs || [];
    const here = all.filter((d) => inNotebook(d, notebook));
    return {
        files: here.filter((d) => tags.every((t) => (d.tags || []).includes(t))),
        notebooks: [...new Set(all.flatMap((d) => d.buckets || []))].sort((a, b) => a.localeCompare(b)),
        unfiled: all.some((d) => !(d.buckets || []).length),
        cloud: tagCounts(here),
    };
}
