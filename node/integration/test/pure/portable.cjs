// Portable references: pasted absolute self-URLs relativize so documents never bake in one
// server's address. The subtle cases: only THIS origin matches, only when followed by a
// slash (prose mentioning the bare origin survives), and every occurrence in one paste.
const assert = require('node:assert');

let stripSelfOrigin;
before(async () => {
    ({ stripSelfOrigin } = await import('../../../js/pure/portable.js'));
});

const O = 'http://localhost:5281';

describe('stripSelfOrigin', () => {
    it('relativizes a pasted self-URL, markup and all', () => {
        assert.equal(
            stripSelfOrigin(`![](${O}/api/identity/aa/docs/bb/body/pic.avif)`, O),
            '![](/api/identity/aa/docs/bb/body/pic.avif)'
        );
    });

    it('rewrites every occurrence, not just the first', () => {
        assert.equal(
            stripSelfOrigin(`${O}/api/x and ${O}/home/notes/y`, O),
            '/api/x and /home/notes/y'
        );
    });

    it('leaves other origins alone - only THIS node self-references', () => {
        const other = 'http://example.com/api/identity/aa/docs/bb/body';
        assert.equal(stripSelfOrigin(other, O), other);
        assert.equal(stripSelfOrigin(`${O}9/api/x`, O), `${O}9/api/x`, 'a longer host is not us');
    });

    it('spares prose that merely mentions the bare origin', () => {
        assert.equal(stripSelfOrigin(`my node is ${O}, neat`, O), `my node is ${O}, neat`);
    });

    it('is safe on empty text and unknown origin', () => {
        assert.equal(stripSelfOrigin('', O), '');
        assert.equal(stripSelfOrigin('hello', ''), 'hello');
        assert.equal(stripSelfOrigin(null, O), null);
    });
});
