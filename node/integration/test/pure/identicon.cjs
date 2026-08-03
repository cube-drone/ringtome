// The root-derived identicon - goldens shared with the Rust twin (src/identicon.rs).
// These exact strings are the contract: the anonymous static face and the console must draw
// the SAME picture for a persona, or the confusable-name defence it exists for is theatre.
const assert = require('node:assert');

let identiconSvg, identiconUri;
before(async () => {
    ({ identiconSvg, identiconUri } = await import('../../../js/pure/identicon.js'));
});

const GOLDENS = {
    "93ad0ddd9dd2022bf2ac21664b386965e0eeffecaff6e49b71039db5f1cf53f3": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 5 5\" shape-rendering=\"crispEdges\"><rect width=\"5\" height=\"5\" fill=\"hsl(213, 34%, 92%)\"/><rect x=\"0\" y=\"0\" width=\"1\" height=\"1\" fill=\"hsl(213, 62%, 42%)\"/><rect x=\"4\" y=\"0\" width=\"1\" height=\"1\" fill=\"hsl(213, 62%, 42%)\"/><rect x=\"0\" y=\"2\" width=\"1\" height=\"1\" fill=\"hsl(213, 62%, 42%)\"/><rect x=\"4\" y=\"2\" width=\"1\" height=\"1\" fill=\"hsl(213, 62%, 42%)\"/><rect x=\"0\" y=\"3\" width=\"1\" height=\"1\" fill=\"hsl(255, 68%, 58%)\"/><rect x=\"4\" y=\"3\" width=\"1\" height=\"1\" fill=\"hsl(255, 68%, 58%)\"/><rect x=\"0\" y=\"4\" width=\"1\" height=\"1\" fill=\"hsl(255, 68%, 58%)\"/><rect x=\"4\" y=\"4\" width=\"1\" height=\"1\" fill=\"hsl(255, 68%, 58%)\"/><rect x=\"1\" y=\"2\" width=\"1\" height=\"1\" fill=\"hsl(255, 68%, 58%)\"/><rect x=\"3\" y=\"2\" width=\"1\" height=\"1\" fill=\"hsl(255, 68%, 58%)\"/><rect x=\"1\" y=\"3\" width=\"1\" height=\"1\" fill=\"hsl(255, 68%, 58%)\"/><rect x=\"3\" y=\"3\" width=\"1\" height=\"1\" fill=\"hsl(255, 68%, 58%)\"/><rect x=\"1\" y=\"4\" width=\"1\" height=\"1\" fill=\"hsl(255, 68%, 58%)\"/><rect x=\"3\" y=\"4\" width=\"1\" height=\"1\" fill=\"hsl(255, 68%, 58%)\"/><rect x=\"2\" y=\"4\" width=\"1\" height=\"1\" fill=\"hsl(255, 68%, 58%)\"/></svg>",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 5 5\" shape-rendering=\"crispEdges\"><rect width=\"5\" height=\"5\" fill=\"hsl(330, 34%, 92%)\"/><rect x=\"0\" y=\"1\" width=\"1\" height=\"1\" fill=\"hsl(330, 62%, 42%)\"/><rect x=\"4\" y=\"1\" width=\"1\" height=\"1\" fill=\"hsl(330, 62%, 42%)\"/><rect x=\"0\" y=\"3\" width=\"1\" height=\"1\" fill=\"hsl(330, 62%, 42%)\"/><rect x=\"4\" y=\"3\" width=\"1\" height=\"1\" fill=\"hsl(330, 62%, 42%)\"/><rect x=\"1\" y=\"0\" width=\"1\" height=\"1\" fill=\"hsl(12, 68%, 58%)\"/><rect x=\"3\" y=\"0\" width=\"1\" height=\"1\" fill=\"hsl(12, 68%, 58%)\"/><rect x=\"1\" y=\"3\" width=\"1\" height=\"1\" fill=\"hsl(330, 62%, 42%)\"/><rect x=\"3\" y=\"3\" width=\"1\" height=\"1\" fill=\"hsl(330, 62%, 42%)\"/><rect x=\"2\" y=\"0\" width=\"1\" height=\"1\" fill=\"hsl(330, 62%, 42%)\"/><rect x=\"2\" y=\"2\" width=\"1\" height=\"1\" fill=\"hsl(12, 68%, 58%)\"/></svg>"
};

describe('the identicon', () => {
    it('draws the goldens exactly (drift here means two faces disagree)', () => {
        for (const [root, svg] of Object.entries(GOLDENS)) {
            assert.equal(identiconSvg(root), svg);
        }
    });

    it('is deterministic, and different keys draw different pictures', () => {
        const [a, b] = Object.keys(GOLDENS);
        assert.equal(identiconSvg(a), identiconSvg(a));
        assert.notEqual(identiconSvg(a), identiconSvg(b));
    });

    it('is left-right symmetric - what makes a small glyph memorable', () => {
        const svg = identiconSvg(Object.keys(GOLDENS)[0]);
        const cells = [...svg.matchAll(/x="(\d)" y="(\d)"/g)].map((m) => [+m[1], +m[2]]);
        for (const [x, y] of cells) {
            assert.ok(
                cells.some(([mx, my]) => mx === 4 - x && my === y),
                `cell ${x},${y} has no mirror`
            );
        }
    });

    it('never comes out blank or solid on a patterned key', () => {
        // 0xaa repeating would degenerate if every cell read the same bit.
        const cells = (identiconSvg('aa'.repeat(32)).match(/<rect x=/g) || []).length;
        assert.ok(cells > 0 && cells < 25, `patterned key drew ${cells} cells`);
    });

    it('wears the persona\'s own hue - the identicon and the ring are one object', () => {
        const root = Object.keys(GOLDENS)[0];
        assert.ok(identiconSvg(root).includes('hsl(213,'), 'ground and ink share the hue');
    });

    it('packs into a data URI for an <img>', () => {
        const uri = identiconUri(Object.keys(GOLDENS)[0]);
        assert.ok(uri.startsWith('data:image/svg+xml,'));
        assert.ok(decodeURIComponent(uri.slice('data:image/svg+xml,'.length)).startsWith('<svg'));
    });
});
