// The Storage page's arithmetic (storagepage.js): how wide a figure's bar is against the whole,
// which kinds of thing the place's total and a persona's files are shown as, and how many of the people followed are
// listed before "show everyone". The node does the measuring (node/src/storage.rs); this only
// lays out what it answered.

/// The kinds a place's total is split into, in the order the page lists them.
export const PLACE_KINDS = ['files', 'chains', 'backups', 'other'];

/// The kinds a persona's files are split into, in the order the page lists them.
export const FILE_KINDS = ['pictures', 'video', 'audio', 'writing', 'other'];

/// A persona's files by kind (`FILE_KINDS`), leaving out a kind with nothing in it. Nothing at
/// all for a persona not yet split.
export function kindParts(kinds) {
    if (!kinds) return [];
    return FILE_KINDS.map((kind) => ({ kind, bytes: kinds[kind] || 0 })).filter(
        (part) => part.bytes > 0,
    );
}

/// The viewer's own files as two lanes, each by kind (`FILE_KINDS`, empty kinds left out): the
/// public ones, which everyone following them keeps a copy of, and the private ones. A lane with
/// nothing in it is still a lane - it says so.
export function laneParts(persona) {
    const lane = (name) => {
        const parts = kindParts(persona && persona[`${name}_kinds`]);
        return { lane: name, bytes: parts.reduce((n, part) => n + part.bytes, 0), parts };
    };
    return [lane('public'), lane('private')];
}

/// What one person followed takes, biggest first: their records and each kind of file they have
/// - so "is it their videos or their music?" is the first line read. Ties keep `FILE_KINDS` order,
/// records leading. Before their files are split, the records alone.
export function personParts(person) {
    if (!person) return [];
    return [{ kind: 'records', bytes: person.chains_bytes || 0 }, ...kindParts(person.kinds)]
        .filter((part) => part.bytes > 0)
        .sort((a, b) => b.bytes - a.bytes);
}

/// How many people are listed before the rest wait behind "show everyone".
export const PEOPLE_SHOWN = 25;

/// A figure's share of a whole, as a bar's width in percent: nothing for nothing, the whole bar
/// at most, and never so thin that something reads as nothing.
export function shareOf(bytes, whole) {
    if (!(bytes > 0) || !(whole > 0)) return 0;
    return Math.min(100, Math.max(1, (bytes / whole) * 100));
}

/// The place's total by kind, largest question first (`PLACE_KINDS`), leaving out a kind with
/// nothing in it - a server with no backups has no backups row.
export function placeParts(place) {
    return PLACE_KINDS.map((kind) => ({
        kind,
        bytes: (place && place[`${kind}_bytes`]) || 0,
    })).filter((part) => part.bytes > 0);
}

/// The people to list: the biggest first, ties by name so the order holds still, and only the
/// first `PEOPLE_SHOWN` unless everyone was asked for. `rest` is how many wait.
export function peopleShown(people, everyone = false) {
    const sorted = [...(people || [])].sort(
        (a, b) => b.bytes - a.bytes || String(a.root).localeCompare(String(b.root)),
    );
    const shown = everyone ? sorted : sorted.slice(0, PEOPLE_SHOWN);
    return { shown, rest: sorted.length - shown.length };
}
