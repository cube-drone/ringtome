// A dozen-odd colours for `[color=…]` and a block's `color=` (Curtis, 2026-10-08: "a handful of
// useful colors... visible against both dark and light backgrounds - might as well nudge users in
// that direction"). Any lowercase name passes the renderer's colour gate and lands in CSS as is, so
// these are CSS's own names, picked for a relative luminance between about 0.1 and 0.3: at least
// 3.25:1 against white AND against black (the best any colour can do on both is 4.6:1). Round
// the hue wheel, the hex beside each, and a swatch in the picker (doc/completions.js, drawn by
// LiveMarquee). The contrast is tested (`contrast` below), so the list can't drift dim.
export const COLORS = [
    ['red', '#ff0000'],
    ['crimson', '#dc143c'],
    ['orangered', '#ff4500'],
    ['chocolate', '#d2691e'],
    ['darkgoldenrod', '#b8860b'],
    ['olive', '#808000'],
    ['forestgreen', '#228b22'],
    ['teal', '#008080'],
    ['steelblue', '#4682b4'],
    ['royalblue', '#4169e1'],
    ['mediumslateblue', '#7b68ee'],
    ['mediumorchid', '#ba55d3'],
    ['deeppink', '#ff1493'],
];

/// WCAG relative luminance of a `#rrggbb` colour.
export function luminance(hex) {
    const channel = (i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/// WCAG contrast ratio between two `#rrggbb` colours, 1 to 21.
export function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}
