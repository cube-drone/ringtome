// The front page's hit counter: seven zero-padded wheels that grow for bigger numbers, and graph
// bars scaled to the tallest day.
const assert = require('node:assert');

let odometerDigits, censusMonth;
before(async () => {
    ({ odometerDigits, censusMonth } = await import('../../../js/pure/census.js'));
});

describe('odometerDigits', () => {
    it('pads to seven wheels, grows past them, and reads nonsense as nothing', () => {
        assert.deepEqual(odometerDigits(3), ['0', '0', '0', '0', '0', '0', '3']);
        assert.deepEqual(odometerDigits(12345678).join(''), '12345678');
        assert.deepEqual(odometerDigits(undefined).join(''), '0000000');
        assert.deepEqual(odometerDigits(-4).join(''), '0000000');
    });
});

describe('censusMonth', () => {
    it('is the thirty days ending today, oldest first, a missing day counting 0', () => {
        const now = Date.parse('2026-09-29T15:00:00Z');
        const month = censusMonth([{ date: '2026-09-28', active: 2 }, { date: '2026-09-29', active: 8 }, { date: '2026-01-01', active: 99 }], now);
        assert.equal(month.length, 30);
        assert.equal(month[0].date, '2026-08-31');
        assert.equal(month.at(-1).date, '2026-09-29');
        assert.deepEqual(month.slice(-3).map((p) => p.active), [0, 2, 8], 'a day it never heard of is 0');
        assert.deepEqual(month.slice(-2).map((p) => p.height), [0.25, 1], 'scaled to the tallest day in view');
        assert.ok(!month.some((p) => p.active === 99), 'a day outside the month stays out');
    });
    it('an empty history is a flat month', () => {
        const month = censusMonth(null, Date.parse('2026-09-29T00:00:00Z'));
        assert.equal(month.length, 30);
        assert.ok(month.every((p) => p.active === 0 && p.height === 0));
    });
});
