// hrseAmp's mixtapes (plans/AUDIO.md, section 5): a name and an order. Under the hood each is a
// taxonomy titled `mixtape:<name>` (as a notebook's tree is `wiki:<name>`), whose members are the
// songs in order - yours, or anyone's, since a taxonomy can hold any author's documents. Pure: what
// a mixtape is, which songs are in which, the table in a mixtape's order, and the index a drag
// lands at. The vectors are in integration/test/pure/mixtapes.cjs.

import { rowKey } from './amp.js';

/// The title a mixtape's taxonomy wears (amp.rs `MIXTAPE`).
export const MIXTAPE_PREFIX = 'mixtape:';

export const isMixtape = (title) => typeof title === 'string' && title.startsWith(MIXTAPE_PREFIX);
export const mixtapeName = (title) => (isMixtape(title) ? title.slice(MIXTAPE_PREFIX.length) : '');
export const mixtapeTitle = (name) => `${MIXTAPE_PREFIX}${name.trim()}`;

/// A mixtape from its taxonomy as `GET /taxonomies/{id}` answers it: its id, its name, and its
/// members' keys in order (a nested taxonomy isn't a song, and is passed over).
export function readMixtape(tree) {
    const members = (tree.members || [])
        .filter((m) => !m.taxonomy)
        .map((m) => rowKey(m.root, m.doc_id));
    return { id: tree.taxonomy_id, name: mixtapeName(tree.title), members };
}

/// Which mixtapes each song is in, by name: `Map(key -> [name])` - the filter strip's "mixtape" row.
export function mixtapesBySong(tapes) {
    const out = new Map();
    for (const tape of tapes) {
        for (const key of tape.members) {
            if (!out.has(key)) out.set(key, []);
            if (!out.get(key).includes(tape.name)) out.get(key).push(tape.name);
        }
    }
    return out;
}

/// `rows` in `tape`'s order: those of its songs among them, each once, where the mixtape puts it.
export function inMixtapeOrder(rows, tape) {
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const out = [];
    const seen = new Set();
    for (const key of tape.members) {
        if (seen.has(key) || !byKey.has(key)) continue;
        seen.add(key);
        out.push(byKey.get(key));
    }
    return out;
}

/// The songs among `rows` that aren't in `tape` yet - what "add to mixtape" adds, at the end, so a
/// song already in it keeps its place.
export const notYetIn = (tape, rows) => rows.filter((r) => !(tape && tape.members.includes(r.key)));

/// Where a dragged song lands (the member PUT's index, counted without the song itself): `dragged`
/// dropped before or after `target` (`after`), in `order` (the mixtape's keys). Null when it
/// wouldn't move.
export function dropIndex(order, dragged, target, after) {
    if (dragged === target) return null;
    const rest = order.filter((k) => k !== dragged);
    const at = rest.indexOf(target);
    if (at < 0) return null;
    const index = at + (after ? 1 : 0);
    return index === order.indexOf(dragged) ? null : index;
}
