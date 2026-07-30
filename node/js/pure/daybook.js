// The day book's shape: which entries the journal streams, in what order, and whether today's blank
// page is offered at the top. Named for what the journal calls itself - "a day book, not a note
// list" - which also keeps it from colliding with apps/journal.js.
import { claimedMs, hasClaimedDate } from './docdate.js';

/// The moment an entry files under: the user's CLAIMED date if one is set (backdating a memory to
/// the day it happened), else the entry's real CREATION - never its last update, because an entry
/// edited today is still about the day it was written. The day-LOCK machinery deliberately reads
/// something else: an entry seals when its real day ends, whatever day it claims to be about.
export const entryMs = (d) => (hasClaimedDate(d) ? claimedMs(d) : (d && d.created_ms) || 0);

/// The viewer's calendar day, as a grouping key - so "today" is the reader's today, not UTC's.
export const dayKey = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/// Is this entry editable? A local seal override wins if one exists ('open' | 'locked'); absent, the
/// entry follows the day - open while its own day is today, shut once that day ends.
export const isOpen = (entry, seals, todayKey) => {
    const override = seals && seals.get(entry.doc_id);
    return override !== undefined ? override === 'open' : dayKey(entry.created_ms) === todayKey;
};

/// An entry belongs to this journal when it is filed in the bucket AND holds text. The format test
/// is what keeps loose media records out of the stream: an embedded image files its record into
/// TurboNotes, but even one that lands in this bucket some other way is not an entry.
const isEntry = (d, bucket) =>
    (d.buckets || []).includes(bucket) && (d.format === 'plaintext' || d.format === 'marquee');

/**
 * The stream to render, newest first.
 *
 * The phantom - today's blank page, which does not exist as a document until you write in it - is
 * offered unless the TOP of the stream is already an unsealed entry, meaning the page you are
 * mid-writing. An unsealed entry buried in the past (unlocked for repairs, or backdated away by a
 * claimed date) must not suppress the prompt: the book's open spot is at the top, or it is nowhere.
 * And never while searching - "start today's page" is not a search result.
 *
 * @param hits  a Set of matching doc_ids, or null for "not searching"
 * @param seals a Map of doc_id -> 'open' | 'locked'; absent entries follow the day
 * @returns `{ entries, stack, searching }` - `entries` is every entry, unfiltered and sorted (two
 *          effects in the journal watch it and neither cares about the search); `stack` is what
 *          renders, and may begin with `{ phantom: true, created_ms }`
 */
export function journalStack(docs, { bucket, seals, now, hits } = {}) {
    const entries = (docs || [])
        .filter((d) => isEntry(d, bucket))
        .sort((a, b) => entryMs(b) - entryMs(a) || (a.doc_id < b.doc_id ? 1 : -1));
    const searching = !!hits;
    if (searching) {
        return { entries, stack: entries.filter((e) => hits.has(e.doc_id)), searching };
    }
    const topOpen = entries.length > 0 && isOpen(entries[0], seals, dayKey(now));
    return {
        entries,
        stack: topOpen ? entries : [{ phantom: true, created_ms: now }, ...entries],
        searching,
    };
}
