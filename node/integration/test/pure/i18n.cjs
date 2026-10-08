// The lookup's fast path (2026-10-08): a template without holes comes back as it is, and one with
// holes fills them as it always did - a hole with no value left standing.
const assert = require('node:assert');

let t;
before(async () => {
    ({ t } = await import('../../../js/i18n.js'));
});

describe('t()', () => {
    it('a sentence with no holes is itself', () => {
        assert.equal(t('test.no-holes', 'just words'), 'just words');
        assert.equal(t('test.no-holes', 'just words', { n: 3 }), 'just words');
    });

    it('holes fill, and an unfilled one stands', () => {
        assert.equal(t('test.holes', '{n} of {m}', { n: 1, m: 2 }), '1 of 2');
        assert.equal(t('test.holes', '{n} of {m}', { n: 1 }), '1 of {m}');
    });
});
