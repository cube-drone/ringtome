const assert = require('node:assert');

// Dates by the reader's day (2026-10-02): today the time, this year no year, another year the year.
let whenOptions;
before(async () => {
    ({ whenOptions } = await import('../../../js/pure/when.js'));
});

describe('a date shows what the reader needs of it (2026-10-02)', () => {
    // Local times, so "today" is the machine's own day whatever zone the suite runs in.
    const now = new Date(2026, 9, 2, 15, 30).getTime();
    const clock = { hour: 'numeric', minute: '2-digit' };
    it('today: the time alone', () => {
        assert.deepEqual(whenOptions(new Date(2026, 9, 2, 0, 5).getTime(), now), clock);
        assert.deepEqual(
            whenOptions(new Date(2026, 9, 2, 23, 59).getTime(), now),
            clock,
            'later today too (a schedule)',
        );
    });
    it('this year, another day: the day without the year', () => {
        assert.deepEqual(
            whenOptions(new Date(2026, 9, 1, 23, 59).getTime(), now),
            { month: 'short', day: 'numeric', ...clock },
            'yesterday is not today',
        );
        assert.deepEqual(whenOptions(new Date(2026, 0, 1, 9).getTime(), now), {
            month: 'short',
            day: 'numeric',
            ...clock,
        });
    });
    it('another year: the year, always', () => {
        assert.deepEqual(
            whenOptions(new Date(2021, 9, 2, 15, 30).getTime(), now),
            { month: 'short', day: 'numeric', year: 'numeric', ...clock },
            'the same date five years ago',
        );
        assert.deepEqual(
            whenOptions(new Date(2027, 0, 1).getTime(), now).year,
            'numeric',
            'and next year',
        );
    });
    it('a day, not a moment, never grows a time', () => {
        assert.deepEqual(whenOptions(new Date(2026, 9, 2).getTime(), now, { time: false }), {
            month: 'short',
            day: 'numeric',
        });
        assert.deepEqual(whenOptions(new Date(2019, 4, 4).getTime(), now, { time: false }), {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
        });
    });
});
