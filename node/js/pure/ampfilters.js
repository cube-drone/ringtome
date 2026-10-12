// hrseAmp's filters (plans/AUDIO.md, section 3): the strip over the library - who it came from, its
// artist, its genre and its tags, each chip three-state as the feed's are (left alone, only, leave
// out) - and a filter, a saved set of those picks with the curiosity dial, whose tags count and
// the header's search words (Curtis, 2026-10-12),
// kept like a saved feed: one register each in the persona's private `amp_filters`, keyed by a
// random id, so it follows the person to every computer; a register emptied is one deleted.
//
// The library is all in the browser, so the strip narrows and counts here: each row counted over
// what the other rows' picks leave (as the node counts the feed's, search.rs facet_sets), so a value
// with nothing left under it drops out. Pure: the vectors are in integration/test/pure/ampfilters.cjs.

/// The private register collection the filters live in.
export const AMP_FILTERS = 'amp_filters';

/// The strip's rows, in its order, and where each keeps its left-out values.
export const FILTER_ROWS = ['from', 'artists', 'genres', 'mixtapes', 'tags'];
export const LEFT_OUT = {
    from: 'notFrom',
    artists: 'notArtists',
    genres: 'notGenres',
    mixtapes: 'notMixtapes',
    tags: 'notTags',
};

/// Whose tags count (ruling 12): everyone's you can see, or only the author's and yours.
export const TAG_SCOPES = ['all', 'ours'];

/// The ranges (Curtis, 2026-10-12): a year from and to, and a length from and to, in seconds - each
/// null when unset. A song with no year is outside any year range.
export const RANGES = ['yearMin', 'yearMax', 'lengthMin', 'lengthMax'];

export const NO_AMP_PICKS = {
    from: [],
    artists: [],
    genres: [],
    mixtapes: [],
    tags: [],
    notFrom: [],
    notArtists: [],
    notGenres: [],
    notMixtapes: [],
    notTags: [],
    yearMin: null,
    yearMax: null,
    lengthMin: null,
    lengthMax: null,
    dupes: null,
};

/// "Probable duplicates" is three-state, as a tag's chip is (Curtis, 2026-10-12): left alone (null),
/// 'only' the songs with a probable copy, or 'out' - one of each, every set of copies down to the one
/// that stays (`keeperOf`). A filter saved while it was a plain on is 'only'.
export function dupeMode(picks) {
    const d = picks && picks.dupes;
    return d === 'out' ? 'out' : d === 'only' || d === true ? 'only' : null;
}

/// One click on the chip: left alone -> only -> one of each -> left alone.
export function cycleDupes(picks) {
    const mode = dupeMode(picks);
    return { ...picks, dupes: mode === null ? 'only' : mode === 'only' ? 'out' : null };
}

/// Which copy stays when the duplicates go: your own over someone else's, then one that says its
/// artist, then the first in `songs`' order.
export function keeperOf(copies) {
    const rank = (s) => (s.own ? 0 : 2) + (s.artist ? 0 : 1);
    return copies.reduce((best, s) => (rank(s) < rank(best) ? s : best), copies[0]);
}

/// The keys of the songs `dupeMode` 'out' leaves: every song with no probable copy, and the keeper
/// of each set of copies among `songs`.
function oneOfEach(songs) {
    const groups = duplicateGroups(songs);
    const sets = new Map();
    for (const s of songs) {
        if (!groups.has(s.key)) continue;
        const g = groups.get(s.key);
        if (!sets.has(g)) sets.set(g, []);
        sets.get(g).push(s);
    }
    const keep = new Set(songs.filter((s) => !groups.has(s.key)).map((s) => s.key));
    for (const copies of sets.values()) keep.add(keeperOf(copies).key);
    return keep;
}

/// How far apart two copies of one song may run, in milliseconds (Curtis, 2026-10-12: three copies
/// of one track, "all within 5 seconds of one another").
export const DUPE_SLACK_MS = 5000;

/// A title as two copies of a song would share it: no case, no punctuation, no track number in
/// front ("03 - ", "3. "), no file extension behind.
export function dupeTitle(raw) {
    return String(raw || '')
        .toLowerCase()
        .replace(/\.(mp3|m4a|ogg|opus|flac|wav|aac|wma)$/, '')
        .replace(/^\s*\d{1,3}\s*[-.)_]?\s+/, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

const dupeArtist = (raw) =>
    String(raw || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();

/// Probable duplicates (Curtis, 2026-10-12): songs whose titles agree (`dupeTitle`), whose artists
/// agree where both say one - a song from the feed says none yet - and whose lengths are within
/// `DUPE_SLACK_MS` (where both are known). Answers `Map(key -> group)`, every song with at least one
/// probable copy, each group numbered in the order its first song comes in `songs`.
export function duplicateGroups(songs) {
    const byTitle = new Map();
    for (const song of songs) {
        const title = dupeTitle(song.title);
        if (!title) continue;
        if (!byTitle.has(title)) byTitle.set(title, []);
        byTitle.get(title).push(song);
    }
    const alike = (a, b) => {
        const [x, y] = [dupeArtist(a.artist), dupeArtist(b.artist)];
        if (x && y && x !== y) return false;
        if (a.lengthMs && b.lengthMs && Math.abs(a.lengthMs - b.lengthMs) > DUPE_SLACK_MS)
            return false;
        return true;
    };
    // Within a title, songs join a group through any one copy they're alike with.
    const parent = new Map();
    const find = (k) => {
        while (parent.get(k) !== k) k = parent.get(k);
        return k;
    };
    for (const same of byTitle.values()) {
        if (same.length < 2) continue;
        for (const s of same) if (!parent.has(s.key)) parent.set(s.key, s.key);
        for (let i = 0; i < same.length; i++) {
            for (let j = i + 1; j < same.length; j++) {
                if (alike(same[i], same[j])) parent.set(find(same[j].key), find(same[i].key));
            }
        }
    }
    const size = new Map();
    for (const k of parent.keys()) size.set(find(k), (size.get(find(k)) || 0) + 1);
    const out = new Map();
    const number = new Map();
    for (const song of songs) {
        if (!parent.has(song.key)) continue;
        const root = find(song.key);
        if (size.get(root) < 2) continue;
        if (!number.has(root)) number.set(root, number.size);
        out.set(song.key, number.get(root));
    }
    return out;
}

/// `songs` (in the table's order) with each group of probable copies together, where its first
/// copy stood.
export function byDuplicateGroup(songs, groups) {
    const at = (song) => (groups.has(song.key) ? groups.get(song.key) : Infinity);
    return [...songs].sort((a, b) => (at(a) === at(b) ? 0 : at(a) < at(b) ? -1 : 1));
}

const bound = (v) =>
    v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);

/// A song's year, from whatever its year field says: its first four digits in a row.
export function yearOf(raw) {
    const m = String(raw || '').match(/\d{4}/);
    return m ? Number(m[0]) : null;
}

/// A length as typed into the strip, in seconds: "3:30", "1:02:00", or a number of minutes ("4",
/// "2.5"). Null for nothing, or anything else.
export function readLength(text) {
    const s = String(text || '').trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 60);
    if (!/^\d+(:\d{1,2}){1,2}$/.test(s)) return null;
    return s.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
}

/// Picks in one canonical shape, every list sorted, so two filters that narrow alike compare equal.
export function canonicalAmpPicks(picks) {
    const p = picks || {};
    const out = {};
    for (const row of [...FILTER_ROWS, ...Object.values(LEFT_OUT)]) {
        out[row] = [...new Set(p[row] || [])].sort();
    }
    for (const r of RANGES) out[r] = bound(p[r]);
    out.dupes = dupeMode(p);
    return out;
}

export const anyRange = (picks) => !!picks && RANGES.some((r) => bound(picks[r]) !== null);

export const anyAmpPicks = (picks) =>
    !!picks &&
    (FILTER_ROWS.some((row) => (picks[row] || []).length || (picks[LEFT_OUT[row]] || []).length) ||
        anyRange(picks) ||
        dupeMode(picks) !== null);

/// Is `song` inside the year and length ranges?
function inRanges(song, picks) {
    const [y0, y1, l0, l1] = RANGES.map((r) => bound(picks && picks[r]));
    if (y0 !== null || y1 !== null) {
        const year = yearOf(song.year);
        if (year === null || (y0 !== null && year < y0) || (y1 !== null && year > y1)) return false;
    }
    if (l0 !== null || l1 !== null) {
        const secs = song.lengthMs ? song.lengthMs / 1000 : null;
        if (secs === null || (l0 !== null && secs < l0) || (l1 !== null && secs > l1)) return false;
    }
    return true;
}

/// Where one value of a row stands: 'only', 'out', or null for left alone.
export function ampPickState(picks, row, value) {
    if (((picks && picks[row]) || []).includes(value)) return 'only';
    if (((picks && picks[LEFT_OUT[row]]) || []).includes(value)) return 'out';
    return null;
}

/// One click on a chip: left alone -> only -> leave out -> left alone. The next picks.
export function cycleAmpPick(picks, row, value) {
    const p = { ...NO_AMP_PICKS, ...picks };
    const state = ampPickState(p, row, value);
    const only = p[row].filter((v) => v !== value);
    const out = p[LEFT_OUT[row]].filter((v) => v !== value);
    if (state === null) only.push(value);
    if (state === 'only') out.push(value);
    return { ...p, [row]: only, [LEFT_OUT[row]]: out };
}

/// A row's values on one song: who it came from, its folded artist, its genre, and its tags as
/// `scope` counts them.
function valuesOf(song, row, scope) {
    switch (row) {
        case 'from':
            return song.from ? [song.from] : [];
        case 'artists':
            return song.artist ? [song.artist] : [];
        case 'genres':
            return song.genre ? [song.genre] : [];
        // The mixtapes it's in, by name (section 5: a mixtape's name behaves as a tag).
        case 'mixtapes':
            return song.mixtapes || [];
        case 'tags':
            return (scope === 'ours' ? song.ourTags : song.tags) || [];
        default:
            return [];
    }
}

/// Does `song` pass every row's picks but `except`'s? A row with "only" picks needs one of them; a
/// left-out value anywhere on it leaves it out. `dupes`, when "probable duplicates" is picked: the keys
/// it lets through - every song with a probable copy, or one of each.
function passes(song, picks, scope, except = null, dupes = null) {
    if (dupes && !dupes.has(song.key)) return false;
    if (!inRanges(song, picks)) return false;
    for (const row of FILTER_ROWS) {
        if (row === except) continue;
        const only = (picks && picks[row]) || [];
        const out = (picks && picks[LEFT_OUT[row]]) || [];
        if (!only.length && !out.length) continue;
        const values = valuesOf(song, row, scope);
        if (only.length && !values.some((v) => only.includes(v))) return false;
        if (values.some((v) => out.includes(v))) return false;
    }
    return true;
}

/// The songs the picks leave.
export function narrowedSongs(songs, picks, scope = 'all') {
    if (!anyAmpPicks(picks)) return songs;
    const mode = dupeMode(picks);
    if (mode === 'out') {
        // One of each among what the other picks leave, so a copy they hide never costs the keeper.
        const rest = songs.filter((s) => passes(s, picks, scope));
        const keep = oneOfEach(rest);
        return rest.filter((s) => keep.has(s.key));
    }
    const dupes = mode === 'only' ? duplicateGroups(songs) : null;
    return songs.filter((s) => passes(s, picks, scope, null, dupes));
}

/// Each row's chips, `{ row: [{ value, count }] }`, the most common first: each counted over what
/// the OTHER rows' picks leave, so picking an artist thins the genres to theirs while every other
/// artist stays on the artist row to pick instead.
export function songFacets(songs, picks, scope = 'all') {
    const out = {};
    const mode = dupeMode(picks);
    const dupes =
        mode === 'only' ? duplicateGroups(songs) : mode === 'out' ? oneOfEach(songs) : null;
    for (const row of FILTER_ROWS) {
        const counts = new Map();
        for (const song of songs) {
            if (!passes(song, picks, scope, row, dupes)) continue;
            for (const v of new Set(valuesOf(song, row, scope))) {
                counts.set(v, (counts.get(v) || 0) + 1);
            }
        }
        out[row] = [...counts]
            .map(([value, count]) => ({ value, count }))
            .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    }
    return out;
}

/// What a filter holds, from the strip and the search box as they stand.
export const filterSettings = (picks, stop, scope, q = null) => ({
    picks: canonicalAmpPicks(picks),
    stop: stop || null,
    scope: scope === 'ours' ? 'ours' : 'all',
    q: (q && q.trim()) || null,
});

/// Is the strip on screen `saved`? Picks, curiosity, whose tags and search words alike.
export const sameFilter = (saved, now) =>
    !!saved &&
    !!now &&
    JSON.stringify(canonicalAmpPicks(saved.picks)) ===
        JSON.stringify(canonicalAmpPicks(now.picks)) &&
    (saved.stop || null) === (now.stop || null) &&
    (saved.scope || 'all') === (now.scope || 'all') &&
    ((saved.q && saved.q.trim()) || null) === ((now.q && now.q.trim()) || null);

/// The filters out of the collection's registers (`{key, value}`), by name: what doesn't parse, or
/// was emptied (deleted), is left out.
export function readFilters(values) {
    const out = [];
    for (const { key, value } of values || []) {
        if (!value || !value.trim()) continue;
        try {
            const v = JSON.parse(value);
            if (!v || typeof v.name !== 'string' || !v.name.trim()) continue;
            out.push({
                id: key,
                name: v.name.trim(),
                ...filterSettings(v.picks, v.stop, v.scope, v.q),
            });
        } catch {
            /* not one of ours: passed over */
        }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/// A register's value for a filter saved as `name`.
export const filterValue = (name, settings) => JSON.stringify({ name: name.trim(), ...settings });
