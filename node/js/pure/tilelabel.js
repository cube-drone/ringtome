// How big to draw an app tile's name, and when to finally give up and cut it.
//
// A heptagon is a hostile place for a word: the nameplate strip sits in the lower third, where the
// heptagon has already begun narrowing, and the label is uppercase and heavy, so it runs out of
// room fast. The old rule was a hard cut at 11 characters, which is how "Lost & Found" reached a
// user as "LOST & FOUN…" - a name truncated one character before the word that carries it.
//
// So the type SHRINKS before it truncates. Eleven characters is the measured capacity at full
// size (a 156px hex, Radio Canada 800, uppercase); past that the size falls in proportion, so the
// text keeps occupying the same strip rather than overflowing it. Truncation is the last resort,
// and it only happens once the type has hit a floor set where the word stops being readable at
// arm's length - about twenty characters. A persona named for a Russian novelist gets small, not
// clipped; one named by a cat walking on the keyboard still gets cut off, which is correct.
//
// The numbers are a CALIBRATION, not arithmetic: 11 was measured against the real tile, and if the
// hex, the face, or the font changes, it is measured again. Everything else follows from it.

/// Characters that fit across the nameplate at full size. Measured, not derived.
export const TILE_FULL_CHARS = 11;

/// The smallest the name is allowed to get, as a fraction of full size. Below this it reads as a
/// smudge, and cutting the word is the kinder failure.
export const TILE_MIN_SCALE = 0.55;

/// And so: the most characters that can be shown at all, at the floor. Derived, deliberately -
/// two constants and one division beats three constants that can drift apart.
export const TILE_MAX_CHARS = Math.round(TILE_FULL_CHARS / TILE_MIN_SCALE);

/**
 * The text to draw for `name` and the scale to draw it at.
 *
 * @returns `{ text, scale }` - `scale` is a multiplier on the nameplate's font size, always
 *          between TILE_MIN_SCALE and 1, and `text` is the name, ellipsised only if even the
 *          floor cannot hold it.
 */
export function tileLabel(name) {
    const label = String(name ?? '').trim();
    if (label.length <= TILE_FULL_CHARS) return { text: label, scale: 1 };
    if (label.length <= TILE_MAX_CHARS) {
        // Proportional: the line's total width is roughly length x size, so holding that product
        // at the capacity keeps the word inside the strip whatever its length.
        return { text: label, scale: round(TILE_FULL_CHARS / label.length) };
    }
    // The ellipsis costs a character, so the cut leaves room for it inside the same budget.
    return { text: label.slice(0, TILE_MAX_CHARS - 1) + '…', scale: TILE_MIN_SCALE };
}

/// Three decimals: enough to keep the sizes visually distinct, short enough that the style
/// attribute stays readable in a DOM inspector.
const round = (n) => Math.round(n * 1000) / 1000;
