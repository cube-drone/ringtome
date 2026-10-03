// Dates as a reader wants them (Curtis, 2026-10-02: "if they are on the same day as today, we don't
// need to display the date - just the time. If they're NOT in the same year as today, we definitely
// have to display the year"). One rule for every date the app shows: today, the time alone; this
// year, the day without the year; another year, the year too. The words are the reader's locale's
// (Intl), and "today" is the reader's own day - the same local calendar the words are written in.
//
// A stamp that is a DAY rather than a moment (`time: false` - a ledger line, a claimed date with no
// time) never shows a time it doesn't have: it is the day, with the year when it isn't this one.
// Hover titles that exist to give the exact moment keep the whole of it, and don't come here.

const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

/// The `Intl.DateTimeFormat` options for showing `ms` to a reader whose now is `now`.
export function whenOptions(ms, now = Date.now(), { time = true } = {}) {
    const then = new Date(ms);
    const today = new Date(now);
    const clock = time ? { hour: 'numeric', minute: '2-digit' } : {};
    if (time && sameDay(then, today)) return clock;
    const day = { month: 'short', day: 'numeric' };
    if (then.getFullYear() !== today.getFullYear()) day.year = 'numeric';
    return { ...day, ...clock };
}

/// `ms` in the reader's words, by the rule above.
export function formatWhen(ms, now = Date.now(), opts = {}) {
    return new Date(ms).toLocaleString(undefined, whenOptions(ms, now, opts));
}
