// How long ago something happened, as a unit and a count - never as a formatted string.
//
// The split matters: choosing the unit is a judgement (a thing 90 seconds old reads better as
// "a minute ago" than "90 seconds ago") and it is ours to make and test. Rendering that choice
// into words is the READER'S machine's business - `Intl.RelativeTimeFormat` knows their
// language and their idea of "yesterday", and we know neither. Same rule the date field
// settled on: locale-aware native formatting wins, and we supply only what it cannot know.

/// Below this, say "just now" rather than counting: a few seconds of precision is noise, and
/// something that happened seconds ago is, to a reader, happening.
export const JUST_NOW_MS = 45 * 1000;

/**
 * How long before `now` was `then`, as `Intl.RelativeTimeFormat` wants it: a NEGATIVE count
 * (the past) and the unit to count in. Null means "recently enough not to say a number".
 *
 * Units step at the point the smaller one stops being readable rather than at exact
 * boundaries - 90 minutes is "2 hours ago", not "90 minutes ago" - so the largest unit that
 * yields at least one whole wins.
 */
export function agoUnit(then, now) {
    if (!then) return null; // never, or not something this reader is told about
    // A NEGATIVE delta - their clock ahead of ours, which is ordinary across machines - falls
    // through the same door as a recent one and reads as "just now". That is the honest answer:
    // "in 3 minutes" for something that already happened is worse than declining to count.
    const delta = (now || 0) - then;
    if (delta < JUST_NOW_MS) return null;
    const seconds = delta / 1000;
    const steps = [
        ['day', 86400],
        ['hour', 3600],
        ['minute', 60],
        ['second', 1],
    ];
    for (const [unit, size] of steps) {
        if (seconds >= size) return { value: -Math.floor(seconds / size), unit };
    }
    return { value: -Math.floor(seconds), unit: 'second' };
}
