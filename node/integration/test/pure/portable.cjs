// Portable references: pasted absolute self-URLs relativize so documents never bake in one
// server's address. The subtle cases: only THIS origin matches, only when followed by a
// slash (prose mentioning the bare origin survives), and every occurrence in one paste.
const assert = require('node:assert');

let stripSelfOrigin, identityAddress, viaHints;
before(async () => {
    ({ stripSelfOrigin, identityAddress, viaHints } = await import('../../../js/pure/portable.js'));
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

describe('identityAddress (the minting half)', () => {
    const ROOT = 'ab'.repeat(32);

    it('mints origin + /id/<root> + via when the operator declared a public URL', () => {
        assert.equal(
            identityAddress({ publicUrl: 'https://my-node.ca', root: ROOT, via: ['k1', 'k2'] }),
            `https://my-node.ca/id/${ROOT}?via=k1,k2`
        );
    });

    it('mints the origin-free path form when no public URL is declared', () => {
        assert.equal(
            identityAddress({ publicUrl: null, root: ROOT, via: ['k1'] }),
            `/id/${ROOT}?via=k1`
        );
        assert.equal(identityAddress({ root: ROOT }), `/id/${ROOT}`, 'no via: no query at all');
    });

    it('normalizes the declared URL (trailing slashes, stray whitespace)', () => {
        assert.equal(
            identityAddress({ publicUrl: ' https://my-node.ca/ ', root: ROOT }),
            `https://my-node.ca/id/${ROOT}`
        );
    });

    it('drops empty via entries rather than minting ?via= with holes', () => {
        assert.equal(
            identityAddress({ publicUrl: '', root: ROOT, via: ['', null, 'k'] }),
            `/id/${ROOT}?via=k`
        );
    });
});

describe('viaHints (the cap and the order)', () => {
    it('puts this node first - the one provably alive', () => {
        assert.deepEqual(viaHints('me', ['a', 'b']), ['me', 'a', 'b']);
    });

    it('caps at three total, however lively the peer list', () => {
        assert.deepEqual(viaHints('me', ['a', 'b', 'c', 'd', 'e']), ['me', 'a', 'b']);
    });

    it('dedupes - a peer row for ourselves never doubles the hint', () => {
        assert.deepEqual(viaHints('me', ['me', 'a']), ['me', 'a']);
    });

    it('drops holes and survives no peers at all', () => {
        assert.deepEqual(viaHints('me', ['', null, 'a']), ['me', 'a']);
        assert.deepEqual(viaHints('me'), ['me']);
        assert.deepEqual(viaHints('me', []), ['me']);
    });
});
