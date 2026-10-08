// The logo as its strokes (pure/logo.js), held to the files it was traced into (2026-10-08): the tab
// icon the node serves, and the branding master, carry the same strokes - so painting them in a
// colourway's colours paints the logo, not an older one.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let STROKES, logoSvg;
before(async () => {
    ({ STROKES, logoSvg } = await import('../../../js/pure/logo.js'));
});

describe('the logo', () => {
    it('is five strokes, each one path, the four closed ones with their holes', () => {
        assert.deepEqual(
            STROKES.map((s) => s.name),
            ['triangle', 'zigzag', 'ring', 'left-square', 'right-square'],
        );
        assert.deepEqual(
            STROKES.map((s) => (s.d.match(/M/g) || []).length),
            [2, 1, 2, 2, 2],
        );
    });

    it('paints in one colour, or one per stroke', () => {
        const one = logoSvg('#39ff14');
        assert.equal((one.match(/fill="#39ff14"/g) || []).length, 5);
        const five = logoSvg(['#a00', '#b00', '#c00', '#d00', '#e00']);
        for (const [i, c] of ['#a00', '#b00', '#c00', '#d00', '#e00'].entries()) {
            assert.ok(five.includes(`<path fill="${c}" fill-rule="evenodd" d="${STROKES[i].d}"/>`));
        }
    });

    it('is the strokes the served favicon and the branding master carry', () => {
        for (const file of ['../../../html/favicon.svg', '../../../../branding/hdt_logo_2.svg']) {
            const svg = fs.readFileSync(path.join(__dirname, file), 'utf8');
            for (const s of STROKES) assert.ok(svg.includes(`d="${s.d}"`), `${file}: ${s.name}`);
        }
    });
});
