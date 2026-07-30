// The claimed-display-date helpers - pure ordering/format logic, no browser.
const assert = require('node:assert');

let claimedMs, hasClaimedDate, parseClaimed, formatClaimed, splitClaimed, joinClaimed, DISPLAY_DATE_FIELD;
before(async () => {
    ({
        claimedMs,
        hasClaimedDate,
        parseClaimed,
        formatClaimed,
        splitClaimed,
        joinClaimed,
        DISPLAY_DATE_FIELD,
    } = await import('../../../js/docdate.js'));
});

const withDate = (iso, updated_ms) => ({ fields: { [DISPLAY_DATE_FIELD]: iso }, updated_ms });

describe('claimed display date', () => {
    it('sorts by the claimed date when set, else the real updated stamp', () => {
        const typed2026 = 6_000_000_000_000; // ~2160, stands in for "typed recently"
        const backdated = withDate('2015-07-31', typed2026);
        // The claim wins over the real stamp: this doc sorts as 2015, not 2160.
        assert.ok(claimedMs(backdated) < typed2026, 'claimed date beats the update stamp');
        assert.equal(claimedMs({ updated_ms: 123 }), 123, 'no claim falls back to updated_ms');
        assert.equal(claimedMs({}), 0, 'nothing at all is 0, never NaN');
    });

    it('treats a date-only claim as local midnight (no timezone off-by-one)', () => {
        const ms = parseClaimed('2015-07-31');
        const d = new Date(ms);
        assert.equal(d.getFullYear(), 2015);
        assert.equal(d.getMonth(), 6); // July
        assert.equal(d.getDate(), 31);
    });

    it('parses a date+time claim in local time', () => {
        const d = new Date(parseClaimed('2015-07-31T15:35'));
        assert.equal(d.getFullYear(), 2015);
        assert.equal(d.getHours(), 15);
        assert.equal(d.getMinutes(), 35);
        // A time makes the doc sort AFTER the same day's midnight-only claim.
        assert.ok(parseClaimed('2015-07-31T15:35') > parseClaimed('2015-07-31'));
    });

    it('ignores an unparseable claim (falls back, never sorts to NaN)', () => {
        assert.equal(parseClaimed('not a date'), null);
        assert.equal(parseClaimed(''), null);
        assert.equal(parseClaimed(undefined), null);
        const bad = withDate('garbage', 999);
        assert.equal(claimedMs(bad), 999, 'garbage claim falls back to updated_ms');
        assert.equal(hasClaimedDate(bad), false);
    });

    it('recognizes a real claim', () => {
        assert.equal(hasClaimedDate(withDate('2015-07-31', 1)), true);
        assert.equal(hasClaimedDate({ updated_ms: 1 }), false);
    });

    it('formats a claim, showing time only when the claim carries one', () => {
        assert.match(formatClaimed('2015-07-31'), /2015/);
        assert.match(formatClaimed('2015-07-31'), /Jul/);
        assert.doesNotMatch(formatClaimed('2015-07-31'), /:/, 'no time on a date-only claim');
        assert.match(formatClaimed('2015-07-31T15:35'), /:/, 'time shown when present');
    });

    it('splits and rejoins the two controls, and a time needs a date', () => {
        assert.deepEqual(splitClaimed('2015-07-31'), { date: '2015-07-31', time: '' });
        assert.deepEqual(splitClaimed('2015-07-31T15:35'), { date: '2015-07-31', time: '15:35' });
        assert.deepEqual(splitClaimed('2015-07-31T15:35:00'), { date: '2015-07-31', time: '15:35' });
        assert.deepEqual(splitClaimed(''), { date: '', time: '' });

        assert.equal(joinClaimed('2015-07-31', ''), '2015-07-31');
        assert.equal(joinClaimed('2015-07-31', '15:35'), '2015-07-31T15:35');
        assert.equal(joinClaimed('', '15:35'), '', 'a time without a date clears');
        assert.equal(joinClaimed('', ''), '');
    });
});
