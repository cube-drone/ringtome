// Profile field limits - UI caps in characters, safely inside the wire's byte cap.
const assert = require('node:assert');

let WIRE_VALUE_MAX_BYTES, PROFILE_LIMITS, profileChars, overProfileLimit;
before(async () => {
    ({ WIRE_VALUE_MAX_BYTES, PROFILE_LIMITS, profileChars, overProfileLimit } = await import(
        '../../../js/pure/profile.js'
    ));
});

describe('profile field limits', () => {
    it('holds the cozy caps: 64 for a name, 512 for a bio', () => {
        assert.equal(PROFILE_LIMITS.name, 64);
        assert.equal(PROFILE_LIMITS.bio, 512);
    });

    it('counts characters the way a person does - one emoji is one', () => {
        assert.equal(profileChars('hello'), 5);
        assert.equal(profileChars('🦀🦀'), 2);
        assert.equal(profileChars(''), 0);
        assert.equal(profileChars(null), 0);
    });

    it('the boundary is exact: at the cap saves, one over refuses', () => {
        assert.equal(overProfileLimit('name', 'a'.repeat(64)), false);
        assert.equal(overProfileLimit('name', 'a'.repeat(65)), true);
        assert.equal(overProfileLimit('bio', 'a'.repeat(512)), false);
        assert.equal(overProfileLimit('bio', 'a'.repeat(513)), true);
        assert.equal(overProfileLimit('bio', '🦀'.repeat(512)), false, 'emoji count as one each');
    });

    it('an uncapped field defers to the wire', () => {
        assert.equal(overProfileLimit('someday-field', 'a'.repeat(100000)), false);
    });

    it('NO UI cap can ever reopen the invisible-400 hole (the wire-safety inequality)', () => {
        // Worst case: every character spends 4 bytes of UTF-8. If a future cap bump breaks
        // this, the UI would once again wave through values the wire refuses.
        for (const [field, cap] of Object.entries(PROFILE_LIMITS)) {
            assert.ok(
                cap * 4 <= WIRE_VALUE_MAX_BYTES,
                `${field}'s cap of ${cap} chars could exceed ${WIRE_VALUE_MAX_BYTES} wire bytes`
            );
        }
    });
});
