// Kept answers (pure/keep.js, 2026-10-07): when a stranger's kept profile stands without asking.
const assert = require('node:assert');

let profileFresh, PROFILE_FRESH_MS;
before(async () => {
    ({ profileFresh, PROFILE_FRESH_MS } = await import('../../../js/pure/keep.js'));
});

describe("a stranger's kept profile", () => {
    it('stands for an hour, and not a moment past it', () => {
        const at = 1_000_000;
        assert.equal(profileFresh({ at }, at), true);
        assert.equal(profileFresh({ at }, at + PROFILE_FRESH_MS - 1), true);
        assert.equal(profileFresh({ at }, at + PROFILE_FRESH_MS), false);
    });

    it('nothing kept, or a stamp from the future, is asked again', () => {
        assert.equal(profileFresh(null, 5), false);
        assert.equal(profileFresh({}, 5), false);
        assert.equal(profileFresh({ at: 10 }, 5), false, 'a clock gone backwards');
    });
});
