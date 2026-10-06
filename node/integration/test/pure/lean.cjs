// A chat line's lean (2026-09-28): 2.5% a reaction, positive up and negative down, between half and double.
const assert = require('node:assert');

let leanScale, LEAN_MIN, LEAN_MAX;
before(async () => {
    ({ leanScale, LEAN_MIN, LEAN_MAX } = await import('../../../js/pure/lean.js'));
});

describe('a chat line leans with its reactions', () => {
    it('grows 2.5% for each positive reaction and shrinks 2.5% for each negative one', () => {
        assert.equal(leanScale(0, 0), 1);
        assert.equal(leanScale(4, 0), 1.1);
        assert.equal(leanScale(0, 4), 0.9);
        assert.equal(leanScale(3, 1), 1.05, 'they net out');
    });
    it('stays between half and double', () => {
        assert.equal(leanScale(0, 400), LEAN_MIN);
        assert.equal(leanScale(400, 0), LEAN_MAX);
        assert.equal(LEAN_MIN, 0.5);
        assert.equal(LEAN_MAX, 2);
    });
});
