const assert = require('node:assert');

let mentionQuery, mentionShape, userCardSource, userSpanSource;
before(async () => {
    ({ mentionQuery, mentionShape, userCardSource, userSpanSource } = await import('../../../js/pure/mentions.js'));
});

describe('the @ picker opens at a word start and nowhere else (2026-09-06)', () => {
    it('opens on a bare @, and keeps the query across the spaces of a name', () => {
        assert.deepEqual(mentionQuery('@'), { from: 0, query: '' });
        assert.deepEqual(mentionQuery('hello @Butt Di'), { from: 6, query: 'Butt Di' });
        assert.deepEqual(mentionQuery('a line\n@bea'), { from: 7, query: 'bea' });
    });
    it('stays shut inside a word - an email address is not a summons', () => {
        assert.equal(mentionQuery('write to curtis@lassam.net'), null);
        assert.equal(mentionQuery('foo@'), null);
    });
    it('stops at another @ or a line break, and gives up on a query too long to be a name', () => {
        assert.deepEqual(mentionQuery('@one @'), { from: 5, query: '' }, 'the earlier @ is text; the new one opens fresh');
        assert.deepEqual(mentionQuery('@one\nand @two'), { from: 9, query: 'two' });
        assert.equal(mentionQuery('@' + 'x'.repeat(41)), null);
    });
    it("writes the card as the /id path's own spelling, and the span with the name inside", () => {
        assert.equal(userCardSource('bonk-nasty-2882'), ':::user id=/id/bonk-nasty-2882:::');
        assert.equal(userSpanSource('bonk-nasty-2882', 'Butt Diamonds'), '[user id=/id/bonk-nasty-2882]Butt Diamonds[/user]');
        assert.equal(userSpanSource('bonk-nasty-2882', ''), '[user id=/id/bonk-nasty-2882]bonk-nasty-2882[/user]', 'no name: the address stands in');
    });
    it('a line of its own takes the block; words around the summons take the span', () => {
        assert.equal(mentionShape('', ''), 'block');
        assert.equal(mentionShape('   ', ''), 'block');
        assert.equal(mentionShape('hello ', ''), 'span');
        assert.equal(mentionShape('', ' and friends'), 'span');
    });
});
