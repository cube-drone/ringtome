// hrseAmp's pins (Curtis, 2026-10-18): a filter, a mixtape or a radio station pinned rides at the
// top of the Playlists column, and of the car's lists, for the ones played most. One register each
// in the persona's private `amp_pins`, so a pin follows the person to every computer, as the filters
// and stations it points at do: keyed `<kind>:<id>` (the car's list ids, AutoLibrary.kt), its value
// the moment it was pinned, so pins stack in the order they were made; a register emptied is an
// unpin. Pure: the vectors are in integration/test/pure/amppins.cjs.

/// The private register collection the pins live in.
export const AMP_PINS = 'amp_pins';

/// A pin's register key, and the car's id for the same list.
export const pinKey = (kind, id) => `${kind}:${id}`;

/// The registers, read: a Map of pin key to when it was pinned (ms), emptied registers left out.
export function readPins(values) {
    const out = new Map();
    for (const { key, value } of values || []) {
        const at = Number(value);
        if (value && Number.isFinite(at)) out.set(key, at);
    }
    return out;
}

/// What's pinned, oldest pin first: `{ kind, item }` for each pin whose list is still here.
export function pinnedLists(pins, { filters, tapes, stations }) {
    const lists = [
        ...filters.map((item) => ({ kind: 'filter', item })),
        ...tapes.map((item) => ({ kind: 'mixtape', item })),
        ...stations.map((item) => ({ kind: 'station', item })),
    ];
    return lists
        .filter((l) => pins.has(pinKey(l.kind, l.item.id)))
        .sort((a, b) => pins.get(pinKey(a.kind, a.item.id)) - pins.get(pinKey(b.kind, b.item.id)));
}

/// The car's lists with the pinned ones first, in pinning order; the rest keep theirs.
export function pinnedFirst(lists, pins) {
    const rank = (l) => (pins.has(l.id) ? pins.get(l.id) : Infinity);
    return lists
        .map((l, i) => ({ l, i }))
        .sort((a, b) => rank(a.l) - rank(b.l) || a.i - b.i)
        .map((x) => x.l);
}
