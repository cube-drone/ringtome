// Swatch Internet Time: the day cut into 1000 ".beats" on Biel Mean Time (UTC+1, no DST). One
// beat is 86.4 seconds; @000 is midnight in Biel. Silly, beloved, exactly right for a retro-web
// corner clock - the quickbar shows it to two decimals so it visibly ticks, with the real local
// time a hover away.
//
// Pure and its own module so it can be tested without a browser: the arithmetic is hand-rolled
// (there is no Intl shortcut for "1000ths of a day in a fixed +01:00 offset") and hand-rolled
// timezone arithmetic is exactly the kind that is quietly wrong for half the year.

/// The beat count for an instant: a float in [0, 1000). Takes a Date, reads only its epoch time,
/// so the caller's local zone is irrelevant - Biel is the only zone in play.
export function beats(date) {
    const bmt = new Date(date.getTime() + 3600000); // shift to UTC+1 (Biel)
    const secs =
        bmt.getUTCHours() * 3600 +
        bmt.getUTCMinutes() * 60 +
        bmt.getUTCSeconds() +
        bmt.getUTCMilliseconds() / 1000;
    return (secs / 86.4) % 1000;
}

/// The beat as the card shows it beside a local time (2026-09-17): `@891`, whole beats. In
/// integer milliseconds, not through the float above: one beat is exactly 86 400 ms, and the
/// division `43200 / 86.4` lands a hair under 500 in floating point - Biel noon read @499.
export function beatLabel(ms) {
    const inBiel = (((ms + 3_600_000) % 86_400_000) + 86_400_000) % 86_400_000;
    return `@${String(Math.floor(inBiel / 86_400)).padStart(3, '0')}`;
}
