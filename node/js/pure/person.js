// What a person LOOKS like, as rules: the colour their root derives, and the order their
// three names line up in. Pure - the Person widget family (js/person.js) renders these; every
// surface that shows a human (People rows, the id page, your own persona home, the mini
// hexagons that will eventually stud posts and comments) goes through the same two answers,
// so a persona is the same colour and the same name wherever they appear.

/// A deterministic hue from the root pubkey - the identicon's humble seed (the real
/// root-derived identicon is its own future feature; a persona should never render as bare
/// hex in the meantime). Stable everywhere: the static face computes the same number in Rust.
export function personaHue(rootHex) {
    const n = parseInt((rootHex || '').slice(0, 6), 16);
    return Number.isFinite(n) ? n % 360 : 0;
}

/// The three names a person wears, in the order your eye wants them: YOUR nickname first
/// (the word you chose - fully private, nobody else ever sees it), their self-configured
/// name second (their claim), the speakable words always last (the anchor that cannot lie).
/// Absent ones drop out; the first survivor is the primary.
export function displayNames({ nickname, name, words }) {
    return [nickname, name, words].filter(Boolean);
}

/// The widget sizes, smallest first - the chip's two, then the shapes that are their own
/// components (js/person.js). Named here so the demo page can enumerate them without
/// importing the DOM.
export const PERSON_SIZES = ['mini', 'small'];

/// A 0-100 dial squeezed onto the five signal bars (none/low/medium/high/full): quarters,
/// rounded - so interest's stops land exactly (0/25/50/75/100 -> 0..4) and trust's six
/// stops share honestly (0 and 5 both read "none"; 5 is barely-not-zero, and the tooltip
/// still says the words). Garbage reads as none.
export function signalLevel(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(4, Math.round(n / 25)));
}
