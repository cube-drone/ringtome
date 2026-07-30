// The keepalive body-size guard - pure logic, the lesson from the 600KB "never saved" bug.
const assert = require('node:assert');

let keepaliveOk, KEEPALIVE_MAX_BYTES;
before(async () => {
    ({ keepaliveOk, KEEPALIVE_MAX_BYTES } = await import('../../../js/keepalive.js'));
});

describe('save keepalive guard', () => {
    it('a normal save never sets keepalive, whatever its size', () => {
        assert.equal(keepaliveOk(false, 10), false);
        assert.equal(keepaliveOk(false, 5_000_000), false);
    });

    it('an unload flush sets keepalive for a small body', () => {
        assert.equal(keepaliveOk(true, 10), true);
        assert.equal(keepaliveOk(true, KEEPALIVE_MAX_BYTES), true);
    });

    it('an unload flush does NOT set keepalive past the cap (the bug)', () => {
        // A 600KB paste flushed on unload must fall back to a plain fetch, not a
        // client-rejected keepalive request.
        assert.equal(keepaliveOk(true, KEEPALIVE_MAX_BYTES + 1), false);
        assert.equal(keepaliveOk(true, 600_000), false);
    });

    it('the cap sits under the 64 KiB spec limit with headroom', () => {
        assert.ok(KEEPALIVE_MAX_BYTES < 64 * 1024, 'below the spec cap');
    });
});
