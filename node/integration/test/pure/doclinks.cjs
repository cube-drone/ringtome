const assert = require('node:assert');

let incomingTo, outgoingOf, linkLabel;
before(async () => {
    ({ incomingTo, outgoingOf, linkLabel } = await import('../../../js/pure/doclinks.js'));
});

describe("a note's links, both ways (2026-10-01)", () => {
    const rows = [
        { doc_id: 'a', links: [{ to: '/x/b', text: 'bee', doc: 'b' }, { to: 'https://example.com/', text: '' }] },
        { doc_id: 'b', links: [{ to: '/x/b', text: 'myself', doc: 'b' }] },
        { doc_id: 'c', links: [{ to: '/x/b', text: 'bee', doc: 'b' }, { to: '/x/b2', text: 'bee again', doc: 'b' }] },
        { doc_id: 'd' },
    ];

    it('incoming: every other document that links here, once each', () => {
        assert.deepEqual(incomingTo(rows, 'b'), ['a', 'c'], 'not b linking to itself, and c once');
        assert.deepEqual(incomingTo(rows, 'd'), []);
        assert.deepEqual(incomingTo(rows, null), []);
        assert.deepEqual(incomingTo(undefined, 'b'), [], 'before the mirror has any rows');
    });

    it("outgoing: the note's own links, in its order", () => {
        assert.deepEqual(outgoingOf(rows, 'a').map((l) => l.to), ['/x/b', 'https://example.com/']);
        assert.deepEqual(outgoingOf(rows, 'd'), [], 'a row without links');
        assert.deepEqual(outgoingOf(rows, 'zzz'), [], 'a note not indexed yet');
    });

    it('outgoing: each place once - a note however it was addressed, the web by address', () => {
        const dupes = [
            {
                doc_id: 'e',
                links: [
                    { to: '/ringtome/user/me/doc/b?bucket=x', text: 'first', doc: 'b' },
                    { to: 'https://example.com/a', text: 'web' },
                    { to: '/home/notes/b', text: 'again', doc: 'b' },
                    { to: 'https://example.com/a/', text: 'web again' },
                    { to: 'https://example.com/b', text: 'elsewhere' },
                ],
            },
        ];
        assert.deepEqual(outgoingOf(dupes, 'e').map((l) => l.text), ['first', 'web', 'elsewhere']);
    });

    it('a wordless link reads as where it goes', () => {
        assert.equal(linkLabel({ to: 'https://example.com/a/', text: '' }), 'example.com/a');
        assert.equal(linkLabel({ to: '/ringtome/user/x', text: '' }), '/ringtome/user/x');
        assert.equal(linkLabel({ to: 'https://example.com', text: 'words' }), 'words');
    });
});
