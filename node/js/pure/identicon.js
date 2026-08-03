// The root-derived identicon: the picture a persona wears when they haven't chosen one.
//
// Canon gives it a job (PROJECT_PLAN, Naming): "confusable-name attacks are further caught
// by the root-derived identicon - the name may collide; the image will not." That job only
// works if the image is the SAME everywhere the persona appears, so this is a twinned pure
// function (src/identicon.rs is the other half, held to the same goldens) rather than a
// library: no image crate can be reproduced bit-for-bit by a browser, and two faces that
// disagree defeat the whole point.
//
// No hash, deliberately. A root pubkey is already 32 uniformly-random bytes, so the picture
// reads the key's own bytes - which keeps this module dependency-free (the pure zone admits
// no imports) and makes the derivation obvious to anyone auditing it.
//
// The shape: a 5x5 grid, mirrored left-to-right (columns 0..2 are drawn, 3..4 reflect), so
// the figure is symmetric and reads as a face-ish glyph at 22px as well as 72px. Symmetry is
// what makes small identicons memorable, and mirroring means the hexagon's clipped corners
// take away the same thing on both sides.
import { personaHue } from './person.js';

const CELLS = 15; // 3 drawn columns x 5 rows; the other two columns mirror

/// The identicon as an SVG string, `viewBox`-scaled so one string serves every size.
/// Deterministic: same root, same bytes, same picture, in both languages.
export function identiconSvg(rootHex) {
    const hex = (rootHex || '').toLowerCase();
    const byte = (i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
    const hue = personaHue(hex);
    // Three tones from the persona's own hue: the ring's colour is the ink, a shifted
    // sibling adds character, and a pale wash of the same family is the ground - so the
    // identicon and the hexagon's ring always read as one object.
    const ink = `hsl(${hue}, 62%, 42%)`;
    const accent = `hsl(${(hue + 42) % 360}, 68%, 58%)`;
    const ground = `hsl(${hue}, 34%, 92%)`;

    let cells = '';
    for (let i = 0; i < CELLS; i++) {
        const b = byte(i);
        // A DIFFERENT bit per cell, not always the low one: a key whose bytes share a
        // pattern (0xaa repeating, say) would otherwise draw the same answer fifteen times
        // and come out blank or solid. Half the cells fill, on average, either way.
        if (!((b >> (i % 7)) & 1)) continue;
        const col = Math.floor(i / 5);
        const row = i % 5;
        const fill = (b >> ((i + 3) % 7)) & 1 ? accent : ink; // another bit picks the tone
        cells += `<rect x="${col}" y="${row}" width="1" height="1" fill="${fill}"/>`;
        if (col < 2) {
            cells += `<rect x="${4 - col}" y="${row}" width="1" height="1" fill="${fill}"/>`;
        }
    }
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5" shape-rendering="crispEdges">` +
        `<rect width="5" height="5" fill="${ground}"/>${cells}</svg>`
    );
}

/// The same picture as a data URI, for an `<img src>`. (The anonymous static face inlines
/// the SVG element instead - its CSP allows no data: images, and inlining needs no
/// permission at all.)
export function identiconUri(rootHex) {
    return `data:image/svg+xml,${encodeURIComponent(identiconSvg(rootHex))}`;
}
