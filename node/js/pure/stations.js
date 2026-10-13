// hrseAmp's radio stations (plans/AUDIO.md, section 6; Curtis's favourite way to keep music, "and NO
// MUSIC APPS SUPPORT IT"): a station is a pie - slices, each a saved filter, a mixtape, everything,
// or another station, at a weight. Playing one picks each next song in two steps: a slice, by
// weight (a station's slice passes the pick down to its own); then a song from that slice's own
// shuffle, so a slice plays all its songs before it repeats one, however often it comes up - each
// slice looping on its own, a short list sooner and a huge one later. The weights are exact: a
// slice chosen always plays (Curtis, 2026-10-12: a short list at a high weight must not lose its
// turns to a huge one). A short memory of what just played only chooses WHICH of the slice's songs
// - not one heard through another slice a moment ago, not a recent artist, where the slice has
// another to offer.
//
// Stations are kept like saved filters: one register each in the persona's private
// `amp_stations`, keyed by a random id; a register emptied is one deleted. Pure, with the random
// source passed in: the vectors are in integration/test/pure/stations.cjs.

import { spreadOrder } from './shuffle.js';

/// The private register collection the stations live in.
export const AMP_STATIONS = 'amp_stations';

/// What a slice can be: one of your saved filters, a mixtape, everything you can hear, or another
/// station.
export const SLICE_KINDS = ['filter', 'mixtape', 'all', 'station'];

/// A slider's reach: a weight is a whole number from 0 (silent) to this.
export const MAX_WEIGHT = 100;

const weightOf = (w) => Math.max(0, Math.min(MAX_WEIGHT, Math.round(Number(w) || 0)));

/// A slice, in one shape.
export const slice = ({ kind, id = '', weight = 50 }) => ({
    kind: SLICE_KINDS.includes(kind) ? kind : 'all',
    id: kind === 'all' ? '' : String(id || ''),
    weight: weightOf(weight),
});

/// The stations out of the collection's registers (`{key, value}`), by name: what doesn't parse,
/// or was emptied (deleted), is left out.
export function readStations(values) {
    const out = [];
    for (const { key, value } of values || []) {
        if (!value || !value.trim()) continue;
        try {
            const v = JSON.parse(value);
            if (!v || typeof v.name !== 'string' || !v.name.trim()) continue;
            out.push({
                id: key,
                name: v.name.trim(),
                slices: (Array.isArray(v.slices) ? v.slices : []).map(slice),
            });
        } catch {
            /* not one of ours: passed over */
        }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/// A register's value for a station.
export const stationValue = (name, slices) =>
    JSON.stringify({ name: name.trim(), slices: slices.map(slice) });

/// Each slice's share of the pie, in whole percents that add up to 100 (largest remainders get the
/// odd points); all zero when every weight is.
export function shares(slices) {
    const total = slices.reduce((n, s) => n + weightOf(s.weight), 0);
    if (!total) return slices.map(() => 0);
    const exact = slices.map((s) => (100 * weightOf(s.weight)) / total);
    const out = exact.map(Math.floor);
    let left = 100 - out.reduce((a, b) => a + b, 0);
    const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]);
    for (const [, i] of order) {
        if (left <= 0) break;
        out[i] += 1;
        left -= 1;
    }
    return out;
}

/// Would putting station `adding` inside station `into` make a loop - `into` reaching itself,
/// directly or further down? (Refused when it's added, section 6.)
export function wouldLoop(stations, into, adding) {
    const byId = new Map(stations.map((s) => [s.id, s]));
    const seen = new Set();
    const reaches = (id) => {
        if (id === into) return true;
        if (seen.has(id)) return false;
        seen.add(id);
        const st = byId.get(id);
        return !!st && st.slices.some((s) => s.kind === 'station' && reaches(s.id));
    };
    return reaches(adding);
}

/// How long the memory is, for a station whose leaves hold `songs` songs by `artists` artists: a
/// song played in the last `songs` picks, or an artist in the last `artists`, is passed over where
/// another will do. Scaled down for a small station, so it still plays.
export function memoryFor(songs, artists) {
    return {
        songs: Math.max(0, Math.min(20, Math.floor(songs / 2))),
        artists: Math.max(0, Math.min(3, Math.floor(artists / 2))),
    };
}

/// A station being played. `opts`:
///   - `stations`: every station, for the slices that are stations;
///   - `songsOf(slice)`: the songs a leaf slice (filter, mixtape, all) holds now;
///   - `keyOf`, `artistOf`, `albumOf`, `random`: as the shuffle takes them.
/// `next()` and `prev()` walk the station's history; past its end, `next()` picks anew.
export class StationRun {
    constructor(station, opts) {
        this.station = station;
        this.opts = opts;
        this.history = [];
        this.pos = -1;
        this.bags = new Map(); // a leaf's path -> what's left of its cycle
        this.refresh();
    }

    /// The leaves under the station, with each one's chance: `[{ path, slice, chance }]`, a nested
    /// station's leaves scaled by its own share. A loop (which the editor refuses, but two devices
    /// could still make) is cut where it closes.
    leaves() {
        const byId = new Map((this.opts.stations || []).map((s) => [s.id, s]));
        const out = [];
        const walk = (station, chance, path, seen) => {
            const total = station.slices.reduce((n, s) => n + weightOf(s.weight), 0);
            if (!total) return;
            station.slices.forEach((s, i) => {
                const share = (chance * weightOf(s.weight)) / total;
                if (!share) return;
                const at = `${path}/${i}`;
                if (s.kind === 'station') {
                    const inner = byId.get(s.id);
                    if (inner && !seen.has(inner.id))
                        walk(inner, share, at, new Set([...seen, inner.id]));
                } else {
                    out.push({ path: at, slice: s, chance: share });
                }
            });
        };
        walk(this.station, 1, this.station.id, new Set([this.station.id]));
        return out;
    }

    /// The station's songs as they stand now - after the library or a filter changed underneath.
    refresh() {
        const { keyOf, artistOf } = this.opts;
        this.leafSongs = new Map();
        const keys = new Set();
        const artists = new Set();
        for (const leaf of this.leaves()) {
            const songs = this.opts.songsOf(leaf.slice) || [];
            this.leafSongs.set(leaf.path, songs);
            for (const s of songs) {
                keys.add(keyOf(s));
                if (artistOf(s)) artists.add(artistOf(s));
            }
        }
        this.memory = memoryFor(keys.size, artists.size);
    }

    current() {
        return this.pos >= 0 ? this.history[this.pos] : null;
    }

    /// Pick ahead until `n` songs wait past the one playing - for a player that plays on without the
    /// page (Android's, plans/AUDIO.md section 10). `next()` then walks them, as it walks back.
    ahead(n) {
        while (this.history.length - 1 - this.pos < n) {
            const song = this.pick();
            if (!song) break;
            this.history.push(song);
        }
        return this.history.slice(this.pos + 1);
    }

    prev() {
        if (this.pos > 0) this.pos -= 1;
        return this.current();
    }

    next() {
        if (this.pos + 1 < this.history.length) {
            this.pos += 1;
            return this.current();
        }
        const song = this.pick();
        if (!song) return null;
        this.history.push(song);
        this.pos = this.history.length - 1;
        return song;
    }

    /// One new song: a leaf by chance, and it plays - the memory decides only which of its songs.
    /// Its bag's first song with neither a recent song nor a recent artist; else the first that
    /// isn't a recent song; else its first. A leaf never hands its turn to another (the first
    /// version did, and a short heavy list lost most of its turns to the memory - Curtis,
    /// 2026-10-12).
    pick() {
        const leaves = this.leaves().filter((l) => (this.leafSongs.get(l.path) || []).length);
        if (!leaves.length) return null;
        const leaf = this.chooseLeaf(leaves);
        return this.fromBag(leaf, 2) || this.fromBag(leaf, 1) || this.fromBag(leaf, 0);
    }

    chooseLeaf(open) {
        const total = open.reduce((n, l) => n + l.chance, 0);
        let r = this.opts.random() * total;
        for (const l of open) {
            r -= l.chance;
            if (r < 0) return l;
        }
        return open[open.length - 1];
    }

    /// The first song in the leaf's bag that `strict` allows (2: neither a recent song nor a recent
    /// artist; 1: not a recent song; 0: anything but the song that just played, where the bag has
    /// another), taken out of the bag. An empty bag is refilled with a fresh cycle of the leaf's
    /// songs.
    fromBag(leaf, strict) {
        const { keyOf, artistOf, albumOf, random } = this.opts;
        const songs = this.leafSongs.get(leaf.path) || [];
        let bag = this.bags.get(leaf.path);
        const known = new Set(songs.map(keyOf));
        bag = (bag || []).filter((s) => known.has(keyOf(s)));
        if (!bag.length) bag = spreadOrder(songs, { artistOf, albumOf, random });
        // The last n of the history (`slice(-0)` would be all of it).
        const last = (n) => (n > 0 ? this.history.slice(-n) : []);
        const recent = last(this.memory.songs).map(keyOf);
        const recentArtists = last(this.memory.artists).map(artistOf).filter(Boolean);
        const lastKey = this.history.length ? keyOf(this.history[this.history.length - 1]) : null;
        const allowed = (s) =>
            strict === 0 ||
            (!recent.includes(keyOf(s)) &&
                (strict === 1 || !artistOf(s) || !recentArtists.includes(artistOf(s))));
        let at = bag.findIndex(allowed);
        // The loosest pick still won't play one song twice running when the bag holds another.
        if (strict === 0 && at === 0 && keyOf(bag[0]) === lastKey && bag.length > 1) at = 1;
        if (at < 0) {
            this.bags.set(leaf.path, bag);
            return null;
        }
        const [song] = bag.splice(at, 1);
        this.bags.set(leaf.path, bag);
        return song;
    }
}
