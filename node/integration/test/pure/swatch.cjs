// Swatch Internet Time. Hand-rolled timezone arithmetic in a corner of the UI nobody would think
// to check - the class of code that is quietly wrong for half the year and shrugged at because
// it's "just a clock". The fixed +01:00 (no DST, ever) is the whole point of Biel Mean Time, so
// the summer case below is the load-bearing one.
const assert = require('node:assert');

let beats;
before(async () => {
    ({ beats } = await import('../../../js/swatch.js'));
});

// A UTC instant, spelled out, so nothing here depends on the machine's own zone.
const at = (y, mo, d, h, mi = 0, s = 0, ms = 0) => new Date(Date.UTC(y, mo, d, h, mi, s, ms));

// A beat is 86.4 seconds, which is not representable in binary, so midday lands on
// 499.99999999999994 rather than 500. That is fine and permanent - the display rounds to two
// decimals - so beat comparisons are approximate by nature. Only @000 is exact.
const close = (actual, expected) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `expected ~${expected}, got ${actual}`);

describe('swatch beats', () => {
    it('is @000 at midnight in Biel (23:00 UTC the day before)', () => {
        assert.equal(beats(at(2026, 0, 1, 23)), 0);
    });

    it('is @500 at midday in Biel', () => {
        close(beats(at(2026, 0, 1, 11)), 500);
    });

    it('ignores DST - a July instant reads the same as a January one', () => {
        // Biel Mean Time is UTC+1 all year. If this ever used a real timezone it would drift by
        // ~41.67 beats for half the year, which is the bug this test exists to prevent.
        assert.equal(beats(at(2026, 6, 1, 23)), 0);
        close(beats(at(2026, 6, 1, 11)), 500);
    });

    it('ignores the caller s own timezone (it reads epoch time only)', () => {
        const instant = at(2026, 2, 14, 15, 9, 26, 500);
        assert.equal(beats(instant), beats(new Date(instant.getTime())));
    });

    it('stays inside [0, 1000) right up to the wrap', () => {
        const justBefore = beats(at(2026, 0, 1, 22, 59, 59, 999));
        assert.ok(justBefore < 1000, `expected < 1000, got ${justBefore}`);
        assert.ok(justBefore > 999.9, `expected close to the wrap, got ${justBefore}`);
        assert.equal(beats(at(2026, 0, 1, 23, 0, 0, 0)), 0); // and over it
    });

    it('advances one beat per 86.4 seconds', () => {
        const start = beats(at(2026, 0, 1, 23));
        const later = beats(at(2026, 0, 1, 23, 1, 26, 400)); // exactly 86.4s
        close(later - start, 1);
    });

    it('counts sub-beat time, so the display visibly ticks', () => {
        assert.notEqual(beats(at(2026, 0, 1, 23, 0, 0, 0)), beats(at(2026, 0, 1, 23, 0, 8, 640)));
    });
});
