// A persona's last heartbeat is a UTC date (2026-09-29): days since it, as the card says them, and
// the People page's newest-first order with the never-seen last.
const assert = require('node:assert');

let daysSince, byRecentActivity;
before(async () => {
    ({ daysSince, byRecentActivity } = await import('../../../js/pure/heartbeat.js'));
});

const at = (iso) => Date.parse(iso);

describe('daysSince', () => {
    it('counts whole UTC days, whatever the hour', () => {
        assert.equal(daysSince('2026-09-29', at('2026-09-29T00:00:00Z')), 0);
        assert.equal(daysSince('2026-09-29', at('2026-09-29T23:59:59Z')), 0);
        assert.equal(daysSince('2026-09-29', at('2026-09-30T00:00:01Z')), 1);
        assert.equal(daysSince('2026-09-25', at('2026-09-29T12:00:00Z')), 4);
        assert.equal(daysSince('2025-09-29', at('2026-09-29T12:00:00Z')), 365);
    });
    it('a date ahead of now is today; no date, or a broken one, is nothing', () => {
        assert.equal(daysSince('2026-10-01', at('2026-09-29T12:00:00Z')), 0);
        assert.equal(daysSince(null, 0), null);
        assert.equal(daysSince('last tuesday', 0), null);
    });
});

describe('byRecentActivity', () => {
    it('newest first, the never-seen last', () => {
        const rows = ['2026-09-01', null, '2026-09-29', '2025-12-31', undefined];
        assert.deepEqual(rows.sort(byRecentActivity), ['2026-09-29', '2026-09-01', '2025-12-31', null, undefined]);
    });
});
