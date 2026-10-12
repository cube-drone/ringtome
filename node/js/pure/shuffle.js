// hrseAmp's shuffle (plans/AUDIO.md, section 4; Curtis, 2026-10-11): "a little less random than we'd
// expect". Every song once a cycle; no two neighbours by the same artist or from the same album
// where the list allows it; at the seam between cycles, none of the last five again among the first
// five (unless the list is too small for that); and stable for a session - previous and next walk
// the same songs back and forth - though a reload starts a new one.
//
// Pure, with the random source passed in, so the vectors (integration/test/pure/shuffle.cjs) can
// hold it to its rules.

/// How many songs the seam keeps apart.
export const SEAM = 5;

/// A seeded random source, [0, 1) - mulberry32.
export function seededRandom(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function shuffled(items, random) {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

/// Group `items` by `keyOf`, in first-seen order; an empty key is a group of its own each time,
/// since "no artist" is no artist to keep apart.
function grouped(items, keyOf) {
    const groups = new Map();
    let loose = 0;
    for (const item of items) {
        const k = keyOf(item) || `\u0000${loose++}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(item);
    }
    return [...groups.values()];
}

/// Spread `groups` (arrays) through one list, each as evenly as its size allows: item i of a group
/// of n lands near (i + jitter) / n of the way along, and the list is read in that order.
function spread(groups, random) {
    const placed = [];
    for (const group of groups) {
        const n = group.length;
        group.forEach((item, i) => placed.push([(i + random()) / n, item]));
    }
    placed.sort((a, b) => a[0] - b[0]);
    return placed.map(([, item]) => item);
}

/// One cycle of `items`: every one once, no artist after itself wherever the list allows it, and
/// within an artist, albums spread through theirs. Built a song at a time: the next is drawn from
/// an artist other than the last one, weighted by how many songs they have left - except that an
/// artist holding more than half of what's left must go now, or they'd end up side by side. That
/// reaches a no-neighbours order whenever one exists; where one artist is most of the list, the
/// clashes left are as few as the counts allow. `artistOf` and `albumOf` say what an item is.
export function spreadOrder(items, { artistOf, albumOf, random }) {
    const groups = grouped(items, artistOf).map((songs) =>
        // Within an artist: each album shuffled, then the albums spread among themselves.
        spread(
            grouped(shuffled(songs, random), albumOf).map((album) => shuffled(album, random)),
            random,
        ),
    );
    let total = items.length;
    let last = -1;
    const order = [];
    while (total > 0) {
        const open = groups.map((g, i) => i).filter((i) => groups[i].length && i !== last);
        let pick;
        if (!open.length) {
            pick = last; // only the last artist is left: unavoidable
        } else {
            const forced = open.find((i) => 2 * groups[i].length > total);
            if (forced !== undefined) {
                pick = forced;
            } else {
                const weight = open.reduce((n, i) => n + groups[i].length, 0);
                let r = random() * weight;
                pick = open[open.length - 1];
                for (const i of open) {
                    r -= groups[i].length;
                    if (r < 0) {
                        pick = i;
                        break;
                    }
                }
            }
        }
        order.push(groups[pick].shift());
        last = pick;
        total -= 1;
    }
    return order;
}

/// Keep the last cycle's tail out of the next one's head: any of `tail` (keys) among the first
/// `SEAM` of `cycle` swaps with a song past them that isn't in the tail - one whose artist sits well
/// in both places where there is one, so the seam doesn't undo the spreading.
export function keepSeam(cycle, tail, { keyOf, artistOf }) {
    if (cycle.length <= 2 * SEAM) return cycle;
    const avoid = new Set(tail);
    const fits = (song, at, without) => {
        const artist = artistOf(song);
        if (!artist) return true;
        return [at - 1, at + 1].every(
            (k) => k < 0 || k >= cycle.length || k === without || artistOf(cycle[k]) !== artist,
        );
    };
    for (let i = 0; i < SEAM; i++) {
        if (!avoid.has(keyOf(cycle[i]))) continue;
        const candidates = cycle
            .map((song, k) => k)
            .filter((k) => k >= SEAM && !avoid.has(keyOf(cycle[k])));
        if (!candidates.length) break;
        const j =
            candidates.find((k) => fits(cycle[k], i, k) && fits(cycle[i], k, i)) ?? candidates[0];
        [cycle[i], cycle[j]] = [cycle[j], cycle[i]];
    }
    return cycle;
}

/// A shuffle being played: cycle after cycle of the list, walked forward and back.
export class ShuffleRun {
    /// `opts`: `keyOf`, `artistOf`, `albumOf`, `random`. `first`: a song to start with, if one was
    /// chosen.
    constructor(items, opts, first = null) {
        this.opts = opts;
        this.items = items;
        this.order = [];
        this.pos = -1;
        this.cycleStart = 0;
        this.extend(first);
    }

    extend(first = null) {
        const { keyOf } = this.opts;
        const tail = this.order.slice(-SEAM).map(keyOf);
        let cycle = keepSeam(spreadOrder(this.items, this.opts), tail, this.opts);
        if (first) {
            cycle = [first, ...cycle.filter((item) => keyOf(item) !== keyOf(first))];
        }
        this.cycleStart = this.order.length;
        this.order.push(...cycle);
    }

    current() {
        return this.pos >= 0 ? this.order[this.pos] : null;
    }

    next() {
        if (!this.items.length) return null;
        if (this.pos + 1 >= this.order.length) this.extend();
        this.pos += 1;
        return this.order[this.pos];
    }

    prev() {
        if (this.pos > 0) this.pos -= 1;
        return this.current();
    }

    /// The list changed while playing: what's been played this cycle stays, and the rest of the
    /// cycle is the new list's songs not yet played, shuffled afresh.
    replaceItems(items) {
        const { keyOf } = this.opts;
        const played = new Set(this.order.slice(this.cycleStart, this.pos + 1).map(keyOf));
        this.items = items;
        const rest = spreadOrder(
            items.filter((item) => !played.has(keyOf(item))),
            this.opts,
        );
        this.order = [...this.order.slice(0, this.pos + 1), ...rest];
    }
}
