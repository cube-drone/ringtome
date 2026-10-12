// hrseAmp's library, as values (plans/AUDIO.md): the rows of the table - your own sounds, from the
// mirror, and the sound in your feed, from the node - in one shape, with the folding (ruling 5:
// Title is the title tag, else the document's title; Artist is the album artist, else the artist),
// your own layer over another author's fields (ruling 6), the columns, and the sorts and the search.
// Pure: the vectors are in integration/test/pure/amp.cjs.

import { createdMs } from './docdate.js';
import { isEmojiTag } from './annotations.js';

/// The sound fields a file carries (media/audio.rs `TAG_FIELDS`), in that order.
export const SOUND_FIELDS = [
    'track',
    'artist',
    'album',
    'album artist',
    'composer',
    'genre',
    'year',
    'track number',
];

/// The table's columns (section 2, ruling 11; shown by default since 2026-10-12: title, artist,
/// album, length, tags, date added and score): each with whether it sorts, whether it shows before
/// anyone says otherwise, and its width to start with, in pixels.
export const COLUMNS = [
    { key: 'title', sortable: true, shown: true, width: 280 },
    { key: 'artist', sortable: true, shown: true, width: 180 },
    { key: 'album', sortable: true, shown: true, width: 180 },
    { key: 'number', sortable: false, shown: false, width: 48 },
    { key: 'year', sortable: true, shown: false, width: 64 },
    { key: 'genre', sortable: true, shown: false, width: 120 },
    { key: 'length', sortable: true, shown: true, width: 72 },
    { key: 'tags', sortable: false, shown: true, width: 160 },
    { key: 'notebook', sortable: true, shown: false, width: 130 },
    { key: 'by', sortable: true, shown: false, width: 130 },
    { key: 'from', sortable: true, shown: false, width: 130 },
    { key: 'date', sortable: true, shown: true, width: 110 },
    { key: 'score', sortable: true, shown: true, width: 120 },
];

export const COLUMN_MIN = 36;

/// The notebooks a sound simply lands in, which no column names.
const QUIET_NOTEBOOKS = new Set(['feed', 'files', 'default']);

/// A row's key in the table and the layer: whose, and which.
export const rowKey = (author, doc) => `${author}.${doc}`;

/// Your layer (ruling 6) from the private register's rows: `{ "<author>.<doc>": { field: value } }`.
/// A key is `<author>.<doc>.<field>`; an emptied value is no value.
export function readLayer(values) {
    const out = {};
    for (const { key, value } of values || []) {
        const first = key.indexOf('.');
        const second = key.indexOf('.', first + 1);
        if (first < 0 || second < 0 || !value) continue;
        const row = key.slice(0, second);
        (out[row] = out[row] || {})[key.slice(second + 1)] = value;
    }
    return out;
}

/// A layer register's key.
export const layerKey = (author, doc, field) => `${author}.${doc}.${field}`;

/// "3/12" or "03" as 3; anything else null.
export function trackNumber(raw) {
    const n = parseInt(String(raw || '').split('/')[0], 10);
    return Number.isFinite(n) ? n : null;
}

/// A reaction's weight on your own sound's score, in the node's thousandths (score.rs).
const REACTION_MILLI = { up: 1000, down: -1000 };
/// Your reaction to your own sound, as the emoji the Score column shows.
const REACTION_EMOJI = { up: '\u{1F44D}', down: '\u{1F44E}' };

/// The reactions a song has collected, `[[emoji, count]]`, the most said first (Curtis, 2026-10-12:
/// the Score column shows them). `counts` is how many people said each of its tags.
export function reactionsOf(counts) {
    return Object.entries(counts || {})
        .filter(([value, n]) => n > 0 && isEmojiTag(value))
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

/// A song's tags for the Tags column: the words, not the reactions, which the Score column shows.
export const wordTags = (tags) => (tags || []).filter((tag) => !isEmojiTag(tag));

/// One row, from the author's fields, your layer over them, and what the row is.
function row({ author, doc, own, docTitle, fields, layer, ...rest }) {
    const value = (f) => (layer && layer[f]) || (fields && fields[f]) || '';
    return {
        key: rowKey(author, doc),
        author,
        doc,
        own,
        title: value('track') || docTitle || '',
        docTitle: docTitle || '',
        artist: value('album artist') || value('artist'),
        album: value('album'),
        number: trackNumber(value('track number')),
        year: value('year'),
        genre: value('genre'),
        fields: fields || {},
        layer: layer || {},
        ...rest,
    };
}

/// Your own sound, from its mirror row (`format: 'opus'`).
export function ownRow(docRow, me, layer = {}) {
    const mine = layer[rowKey(me, docRow.doc_id)] || {};
    const notebook = (docRow.buckets || []).find((b) => !QUIET_NOTEBOOKS.has(b)) || '';
    return row({
        author: me,
        doc: docRow.doc_id,
        own: true,
        docTitle: docRow.title,
        fields: docRow.fields || {},
        layer: mine,
        post: null,
        from: me,
        lengthMs: (docRow.media && docRow.media.duration_ms) || null,
        tags: (docRow.tags || []).filter((t) => t !== 'audio'),
        // Your own sound's tags are all yours.
        ourTags: (docRow.tags || []).filter((t) => t !== 'audio'),
        notebook,
        dateMs: createdMs(docRow),
        score: REACTION_MILLI[mine.reaction] || 0,
        reactions: REACTION_EMOJI[mine.reaction] ? [[REACTION_EMOJI[mine.reaction], 1]] : [],
        thumb: !!(docRow.media && docRow.media.has_thumb),
    });
}

/// A sound from your feed, as `/amp/library` answers it.
export function feedRow(sound, layer = {}) {
    return row({
        author: sound.author,
        doc: sound.doc,
        own: false,
        docTitle: sound.title,
        fields: sound.fields || {},
        layer: layer[rowKey(sound.author, sound.doc)] || {},
        post: sound.post,
        from: sound.via || sound.author,
        lengthMs: sound.duration_ms || null,
        tags: sound.tags || [],
        ourTags: sound.our_tags || sound.tags || [],
        notebook: sound.notebook || '',
        dateMs: sound.arrived_ms || sound.published_ms || 0,
        score: sound.score || 0,
        reactions: reactionsOf(sound.tag_counts),
        thumb: !!sound.thumb,
    });
}

/// `m:ss`, or `h:mm:ss` from an hour.
export function clock(ms) {
    if (!ms && ms !== 0) return '';
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const text = (a, b) => {
    if (!a && b) return 1; // the empty last, whichever way
    if (a && !b) return -1;
    return collator.compare(a || '', b || '');
};

/// The comparator for a column, ascending; `names` gives a person's name for Posted by and Via (`by`, `from`). Ties fall
/// to the title, then the row's key, so an order is the same every time.
export function comparator(column, names = {}) {
    const tie = (a, b) => text(a.title, b.title) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const by = {
        title: (a, b) => text(a.title, b.title),
        artist: (a, b) =>
            text(a.artist, b.artist) || text(a.album, b.album) || (a.number || 0) - (b.number || 0),
        // An album in its own order (section 2).
        album: (a, b) => text(a.album, b.album) || (a.number || 0) - (b.number || 0),
        year: (a, b) => text(a.year, b.year),
        genre: (a, b) => text(a.genre, b.genre),
        length: (a, b) => (a.lengthMs || 0) - (b.lengthMs || 0),
        notebook: (a, b) => text(a.notebook, b.notebook),
        by: (a, b) => text(names[a.author] || a.author, names[b.author] || b.author),
        from: (a, b) => text(names[a.from] || a.from, names[b.from] || b.from),
        date: (a, b) => (a.dateMs || 0) - (b.dateMs || 0),
        score: (a, b) => (a.score || 0) - (b.score || 0),
    }[column];
    return (a, b) => (by ? by(a, b) : 0) || tie(a, b);
}

/// Rows sorted by `sort` (`{ column, down }`): a new array.
export function sorted(rows, sort, names = {}) {
    const cmp = comparator(sort.column, names);
    const out = [...rows].sort(cmp);
    // Numbers and dates read newest and biggest first when "down"; text reads A to Z when not.
    return sort.down ? out.reverse() : out;
}

/// The rows whose title, artist or album hold every word of `query`, in any case.
export function searched(rows, query) {
    const words = (query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return rows;
    return rows.filter((r) => {
        const hay = `${r.title} ${r.artist} ${r.album} ${r.docTitle}`.toLowerCase();
        return words.every((w) => hay.includes(w));
    });
}

/// The table's settings as this device keeps them, read back with every column accounted for.
export function readTableSettings(raw) {
    let saved = {};
    try {
        saved = raw ? JSON.parse(raw) : {};
    } catch {
        saved = {};
    }
    const hidden = Array.isArray(saved.hidden)
        ? saved.hidden
        : COLUMNS.filter((c) => !c.shown).map((c) => c.key);
    const widths = {};
    for (const c of COLUMNS) {
        const w = saved.widths && Number(saved.widths[c.key]);
        widths[c.key] = w && w >= COLUMN_MIN ? w : c.width;
    }
    const known = COLUMNS.find((c) => c.sortable && saved.sort && c.key === saved.sort.column);
    const sort = known
        ? { column: known.key, down: !!saved.sort.down }
        : { column: 'date', down: true };
    return { hidden, widths, sort };
}

/// A click on a row with the selection as it was (`picked`, a Set of keys), the row's key, the keys
/// in their shown order, the last plainly clicked key, and which keys were held: the next selection.
export function clickSelect(picked, key, ordered, anchor, { shift = false, toggle = false } = {}) {
    if (shift && anchor && ordered.includes(anchor)) {
        const a = ordered.indexOf(anchor);
        const b = ordered.indexOf(key);
        const [from, to] = a < b ? [a, b] : [b, a];
        return new Set(ordered.slice(from, to + 1));
    }
    if (toggle) {
        const next = new Set(picked);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
    }
    return new Set([key]);
}

/// What the player keeps of a song across a refresh: enough to play it and say what it is.
export const slimRow = (row) => ({
    key: row.key,
    author: row.author,
    doc: row.doc,
    own: !!row.own,
    title: row.title || '',
    artist: row.artist || '',
    album: row.album || '',
    lengthMs: row.lengthMs || null,
    thumb: !!row.thumb,
});

/// The player's state as kept (Curtis, 2026-10-12: the list, the song, the shuffle and where it
/// stands, durable across a refresh), read back: null for anything that isn't one.
export function readPlayerState(raw) {
    let v;
    try {
        v = JSON.parse(raw || 'null');
    } catch {
        return null;
    }
    if (!v || !Array.isArray(v.rows)) return null;
    const rows = v.rows.filter((r) => r && typeof r.key === 'string' && r.author && r.doc);
    if (!rows.length) return null;
    const current = rows.find((r) => r.key === v.current) || null;
    return {
        rows,
        current,
        shuffle: !!v.shuffle,
        run: v.run && Array.isArray(v.run.order) ? v.run : null,
    };
}
