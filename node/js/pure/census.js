// The front page's hit counter (census.rs; Curtis, 2026-09-29: "Now with [0 0 0 0 0 0 3] active
// users!"): the digits an odometer shows, and the bars of the DAU-over-time graph behind it.

/// The odometer's digit wheels for a number: zero-padded to `width`, and wider when the number is.
export function odometerDigits(n, width = 7) {
    const s = String(Math.max(0, Math.floor(Number(n) || 0)));
    return s.padStart(width, '0').split('');
}

/// The graph's month (Curtis, 2026-09-29: "go back a month and treat every value it doesn't have
/// as 0"): one point per UTC day for the `days` ending today, oldest first, a day this node has no
/// estimate for counting 0. Each point carries its height as a fraction of the tallest day (0 when
/// every day is 0).
export function censusMonth(history, nowMs, days = 30) {
    const known = new Map((history || []).map((r) => [r.date, r.active || 0]));
    const today = Math.floor(nowMs / 86_400_000);
    const points = [];
    for (let back = days - 1; back >= 0; back--) {
        const date = new Date((today - back) * 86_400_000).toISOString().slice(0, 10);
        points.push({ date, active: known.get(date) || 0 });
    }
    const top = Math.max(0, ...points.map((p) => p.active));
    return points.map((p) => ({ ...p, height: top ? p.active / top : 0 }));
}
