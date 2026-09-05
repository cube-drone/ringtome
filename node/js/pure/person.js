// What a person LOOKS like, as rules: the colour their root derives, and the order their
// three names line up in. Pure - the Person widget family (js/person.js) renders these; every
// surface that shows a human (People rows, the id page, your own persona home, the mini
// heptagons that will eventually stud posts and comments) goes through the same two answers,
// so a persona is the same colour and the same name wherever they appear.

import { bandOrdinal } from './contact.js';

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

/// A band dial on the five signal bars: the ordinal IS the level (none/low/medium/high/max
/// -> 0..4 bars). Silence and garbage both show no bars - the bars answer "how much", and
/// no opinion looks like none of it; the tooltip's words carry the difference.
export function signalLevel(value) {
    return bandOrdinal(value) ?? 0;
}

/// The smallest hex that still says WHOSE: the root's first four hex digits, the same
/// shortcode the persona home and the computers list wear. Provenance in a glance, never
/// an address - the speakable form is for addressing.
export const shortcode = (rootHex) => (rootHex || '').slice(0, 4);
