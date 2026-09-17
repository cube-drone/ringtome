// Swatch Internet Time (Curtis, 2026-09-17): the day in a thousand .beats, counted from
// midnight in Biel (UTC+1, no daylight saving), the same number everywhere on Earth at once -
// which is the point of it beside a local clock reading. `@000` is Biel midnight.

const BEAT_MS = 86_400_000 / 1000;
const BIEL_OFFSET_MS = 3_600_000;

/// The .beat of a moment, 0..999.
export function beatOf(ms) {
    const inBiel = (((ms + BIEL_OFFSET_MS) % 86_400_000) + 86_400_000) % 86_400_000;
    return Math.floor(inBiel / BEAT_MS);
}

/// The moment as `@891`.
export function beats(ms) {
    return `@${String(beatOf(ms)).padStart(3, '0')}`;
}
