// The caches the frontend audit added (2026-10-08): the same answers as before, every time asked.
const assert = require('node:assert');

let speakable, wordsFor, identiconUri, agoWords;
before(async () => {
    ({ speakable, wordsFor } = await import('../../../js/speakable.js'));
    ({ identiconUri } = await import('../../../js/pure/identicon.js'));
    ({ agoWords } = await import('../../../js/pure/ago.js'));
});

describe('kept answers', () => {
    const root = 'ab'.repeat(32);

    it("a root's name and words are the same the second time, and a caller can't spoil them", () => {
        const name = speakable(root);
        assert.equal(speakable(root), name);
        const words = wordsFor(root);
        assert.ok(name.startsWith(`${words[0]}-${words[1]}-`));
        words[0] = 'spoiled';
        assert.notEqual(wordsFor(root)[0], 'spoiled', 'a fresh copy each time');
    });

    it("a root's picture is the same the second time", () => {
        assert.equal(identiconUri(root), identiconUri(root));
        assert.match(identiconUri(root), /^data:image\/svg\+xml,/);
    });

    it('relative words come from one formatter, as a fresh one would say them', () => {
        const fresh = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
        assert.equal(agoWords(-3, 'minute'), fresh.format(-3, 'minute'));
        assert.equal(agoWords(-1, 'day'), fresh.format(-1, 'day'));
    });
});
