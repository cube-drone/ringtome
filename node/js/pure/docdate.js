// The document's display date - the user's own claimed date for a document, which is
// authoritative for ordering and display even though it's the least trustworthy clock in the
// system (PROJECT_PLAN, Displayed Time vs. Claimed Time). You might write up a July 31 2015
// interaction in 2026 and want it filed under 2015; this is how you say so.
//
// It's a conventional annotation field named `display_date` (an ISO string, date-granular in
// the UI), so it rides the same annotation machinery as description/tags and arrives on the
// docs mirror row inside `fields`. These are the pure read helpers the list uses; kept
// separate so the ordering rule is testable without a browser.

export const DISPLAY_DATE_FIELD = 'display_date';

/** The ms a document sorts and reads by: its claimed `display_date` if set and parseable,
 *  else its real last-updated stamp. This is what makes a backdated import file itself under
 *  the date the user claims rather than the day they typed it. */
export function claimedMs(doc) {
    const iso = doc && doc.fields && doc.fields[DISPLAY_DATE_FIELD];
    if (iso) {
        const ms = parseClaimed(iso);
        if (ms !== null) return ms;
    }
    return (doc && doc.updated_ms) || 0;
}

/** The ms a document sorts by when the question is when it BEGAN rather than when it was last
 *  touched - Feed's ordering, and anything else that shows a stream of things said. Editing
 *  something is not saying it again, and a stream that reshuffles when you fix a typo has
 *  stopped being a record of when things happened. Claimed date still wins where one is set
 *  (Displayed Time vs. Claimed Time applies to both questions); `created_ms` is the mirror
 *  row's genesis stamp - the earliest version's claim - and the last-updated stamp is only the
 *  fallback for a row too old or too partial to carry one. */
export function createdMs(doc) {
    const iso = doc && doc.fields && doc.fields[DISPLAY_DATE_FIELD];
    if (iso) {
        const ms = parseClaimed(iso);
        if (ms !== null) return ms;
    }
    return (doc && (doc.created_ms || doc.updated_ms)) || 0;
}

/** Does this doc carry a user-claimed date? */
export function hasClaimedDate(doc) {
    return !!(doc && doc.fields && doc.fields[DISPLAY_DATE_FIELD] && parseClaimed(doc.fields[DISPLAY_DATE_FIELD]) !== null);
}

/** Parse a claimed value - "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" - to ms in LOCAL time. A
 *  date-only string is taken as local midnight, not UTC, so "2015-07-31" never displays as
 *  the 30th in a western timezone; a date-time without a zone is already local per spec.
 *  Returns null for anything unparseable. */
export function parseClaimed(iso) {
    if (typeof iso !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
    if (m) {
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        return isNaN(d.getTime()) ? null : d.getTime();
    }
    const t = Date.parse(iso);
    return isNaN(t) ? null : t;
}

/** A claimed value as a short human label - "Jul 31, 2015" for a date, "Jul 31, 2015, 3:35 PM"
 *  when it carries a time. */
export function formatClaimed(iso) {
    const ms = parseClaimed(iso);
    if (ms === null) return iso;
    const opts = { year: 'numeric', month: 'short', day: 'numeric' };
    if (typeof iso === 'string' && iso.includes('T')) {
        opts.hour = 'numeric';
        opts.minute = '2-digit';
    }
    return new Date(ms).toLocaleString(undefined, opts);
}

/** Split a stored claimed value into the two form controls: { date: "YYYY-MM-DD", time:
 *  "HH:MM" } (time "" when the value is date-only). Seconds, if present, are dropped for the
 *  time input. */
export function splitClaimed(iso) {
    if (typeof iso !== 'string' || iso === '') return { date: '', time: '' };
    const [date, rest] = iso.split('T');
    const time = rest ? rest.slice(0, 5) : ''; // "HH:MM"
    return { date, time };
}

/** Recombine the two controls into a stored value: "" (clear) when there's no date, the date
 *  alone when there's no time, else "YYYY-MM-DDTHH:MM". A time without a date is meaningless
 *  and clears - a claim is anchored on its day. */
export function joinClaimed(date, time) {
    if (!date) return '';
    return time ? `${date}T${time}` : date;
}
