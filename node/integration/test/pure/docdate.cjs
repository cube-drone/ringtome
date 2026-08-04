// The claimed-display-date helpers - pure ordering/format logic, no browser.
const assert = require('node:assert');

let claimedMs, createdMs, hasClaimedDate, parseClaimed, formatClaimed, splitClaimed, joinClaimed,
    DISPLAY_DATE_FIELD;
before(async () => {
    ({
        claimedMs,
        createdMs,
        hasClaimedDate,
        parseClaimed,
        formatClaimed,
        splitClaimed,
        joinClaimed,
        DISPLAY_DATE_FIELD,
    } = await import('../../../js/pure/docdate.js'));
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

// The other question a stream can ask about a document: not when it last changed, but when it
// began. Feed orders by this, so that fixing a typo doesn't republish your week.
describe('createdMs', () => {
    it('reads the genesis stamp, not the last-updated one', () => {
        assert.equal(createdMs({ created_ms: 1000, updated_ms: 9000 }), 1000);
    });

    it('does not move when a document is edited', () => {
        const written = { created_ms: 1000, updated_ms: 1000 };
        const edited = { created_ms: 1000, updated_ms: 9000 };
        assert.equal(createdMs(written), createdMs(edited), 'the same day it was written');
    });

    it('orders a stream by when things were said', () => {
        const stream = [
            { doc_id: 'a', created_ms: 100, updated_ms: 9000 }, // said first, edited last
            { doc_id: 'b', created_ms: 200, updated_ms: 200 },
        ];
        const newestFirst = stream.slice().sort((x, y) => createdMs(y) - createdMs(x));
        assert.deepEqual(newestFirst.map((d) => d.doc_id), ['b', 'a'],
            'the edit did not jump a to the top');
    });

    it('still lets a CLAIMED date win - the author outranks both clocks', () => {
        const now = Date.parse('2026-08-04T00:00:00Z');
        const backdated = {
            created_ms: now,
            updated_ms: now,
            fields: { [DISPLAY_DATE_FIELD]: '2015-07-31' },
        };
        assert.equal(
            createdMs(backdated),
            parseClaimed('2015-07-31'),
            'filed under the year the author claims, not the day the row was made'
        );
    });

    it('falls back to the update stamp for a row carrying no genesis', () => {
        assert.equal(createdMs({ updated_ms: 4200 }), 4200);
        assert.equal(createdMs({}), 0);
        assert.equal(createdMs(), 0);
    });
});
