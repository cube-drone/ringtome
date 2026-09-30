// Heartbeats (HORSE_BASED_CURRENCIES.md, Curtis 2026-09-29): a persona's last heartbeat is a UTC
// date, `2026-09-29`, never a time. How many whole days ago that was, from a moment - the card's
// "active today", "active yesterday", "active 4 days ago", and the People page's recent order.

const DAY_MS = 86_400_000;

/// Days since a heartbeat date, as of `nowMs`: 0 for today (UTC), 1 for yesterday. `null` for no
/// heartbeat, or one that doesn't read as a date. A date ahead of now (another computer's clock
/// running fast) counts as today.
export function daysSince(date, nowMs) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
    if (!m) return null;
    const then = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (Number.isNaN(then)) return null;
    const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
    return Math.max(0, Math.round((today - then) / DAY_MS));
}

/// Newest heartbeat first, the never-seen last - the People page's "recent activity" order. Dates
/// sort as strings, being `YYYY-MM-DD`.
export function byRecentActivity(a, b) {
    const x = a || '';
    const y = b || '';
    return x === y ? 0 : x > y ? -1 : 1;
}
