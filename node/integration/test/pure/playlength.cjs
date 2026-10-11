// A sound's length as a player shows it (2026-10-11): whole seconds rounded down, minutes unpadded,
// hours only once there is one.
const assert = require('node:assert');

let playLength;
before(async () => {
    ({ playLength } = await import('../../../js/pure/mediakind.js'));
});

describe("a sound's length (2026-10-11)", () => {
    it('reads as a player reads it', () => {
        assert.equal(playLength(0), '0:00');
        assert.equal(playLength(2_999), '0:02', 'rounded down, as the player counts');
        assert.equal(playLength(252_000), '4:12');
        assert.equal(playLength(3_599_999), '59:59');
        assert.equal(playLength(3_600_000), '1:00:00');
        assert.equal(playLength(4_000_000), '1:06:40');
    });

    it('is nothing where there is no length', () => {
        assert.equal(playLength(null), null);
        assert.equal(playLength(undefined), null);
        assert.equal(playLength(-1), null);
    });
});
