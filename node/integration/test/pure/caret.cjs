/*
    The caret through outside edits (node/js/pure/caret.js): an outside change goes into the editor
    as the smallest edit that makes it, and a caret left after an upload's placeholder is after the
    image once the placeholder becomes one.
*/
const assert = require('node:assert');

let c;
before(async () => {
    c = await import('../../../js/pure/caret.js');
});

const apply = (was, { from, to, insert }) => was.slice(0, from) + insert + was.slice(to);

describe('the caret through outside edits', () => {
    it('makes the smallest change, and makes the text it was asked for', () => {
        const was = 'one [uploading "a.png" x1] two';
        const now = 'one ![a](/api/x/body/a.png) two';
        const ch = c.smallestChange(was, now);
        assert.equal(apply(was, ch), now);
        assert.deepEqual([ch.from, was.slice(ch.to)], [4, ' two'], 'the shared start and end untouched');
        assert.deepEqual(c.smallestChange('same', 'same'), { from: 4, to: 4, insert: '' });
        assert.equal(apply('aaa', c.smallestChange('aaa', 'aaaa')), 'aaaa', 'a repeated letter still comes out right');
        assert.equal(apply('abc', c.smallestChange('abc', '')), '');
    });

    it('lands the caret after the image when it sat after the placeholder', () => {
        // "one " is 4 long; a placeholder of 22 at 4 becomes an image reference of 23.
        assert.equal(c.caretThroughSwap(26, 4, 22, 23), 27, 'just after: just after the image');
        assert.equal(c.caretThroughSwap(10, 4, 22, 23), 27, 'inside the placeholder: after the image');
        assert.equal(c.caretThroughSwap(30, 4, 22, 23), 31, 'further on: moved by the difference');
        assert.equal(c.caretThroughSwap(2, 4, 22, 23), 2, 'before: where it was');
        assert.equal(c.caretThroughSwap(4, 4, 22, 23), 4, 'at its start: where it was');
    });
});
