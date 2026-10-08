// The colours the editor offers (pure/markcolors.js): each must read on a light page AND a dark one.
const assert = require('node:assert');

let COLORS, contrast;
before(async () => {
    ({ COLORS, contrast } = await import('../../../js/pure/markcolors.js'));
});

describe('the colours the editor offers', () => {
    it('reads at 3.25:1 or better against white and against black, every one', () => {
        for (const [name, hex] of COLORS) {
            assert.ok(
                contrast(hex, '#ffffff') >= 3.25,
                `${name} on white: ${contrast(hex, '#ffffff')}`,
            );
            assert.ok(
                contrast(hex, '#000000') >= 3.25,
                `${name} on black: ${contrast(hex, '#000000')}`,
            );
        }
    });

    it('contrast is the WCAG ratio', () => {
        assert.equal(contrast('#000000', '#ffffff'), 21);
        assert.equal(contrast('#777777', '#777777'), 1);
    });

    it('a dozen-odd, no name twice', () => {
        assert.ok(COLORS.length >= 10);
        assert.equal(new Set(COLORS.map(([n]) => n)).size, COLORS.length);
    });
});
