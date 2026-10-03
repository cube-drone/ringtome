// hrseBank's ledger grouped: a run of one kind on one day is one row with its total; words and
// strokes stay within a document; reactions gather emoji, follows people; publications and days of
// use stand alone.
const assert = require('node:assert');

let groupLedger;
before(async () => {
    ({ groupLedger } = await import('../../../js/pure/ledger.js'));
});

const at = (iso) => Date.parse(iso);
const line = (kind, when, pennies, detail = {}, source = Math.random().toString(16)) => ({
    kind,
    source,
    pennies: String(pennies),
    at_ms: at(when),
    detail,
});

describe('groupLedger', () => {
    it('slams a run together, summing its pennies and counts', () => {
        const rows = groupLedger([
            line('words', '2026-09-28T12:00:00Z', 75, { title: 'untitled', count: 3 }),
            line('words', '2026-09-28T11:00:00Z', 125, { title: 'untitled', count: 5 }),
            line('words', '2026-09-28T10:00:00Z', 150, { title: 'untitled', count: 6 }),
        ]);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].count, 3);
        assert.equal(rows[0].pennies, '350');
        assert.equal(rows[0].n, 14, 'fourteen new words across three edits');
    });

    it('breaks a run at a new document, a new day, or a new kind', () => {
        const rows = groupLedger([
            line('words', '2026-09-28T12:00:00Z', 75, { title: 'a', count: 3 }),
            line('words', '2026-09-28T11:00:00Z', 75, { title: 'b', count: 3 }),
            line('words', '2026-09-27T11:00:00Z', 75, { title: 'b', count: 3 }),
            line('chat', '2026-09-27T10:00:00Z', 500),
        ]);
        assert.deepEqual(
            rows.map((r) => r.count),
            [1, 1, 1, 1],
        );
    });

    it('gathers emoji and people', () => {
        const rows = groupLedger([
            line('post_reaction', '2026-09-27T12:00:00Z', 100, { emoji: '🧌' }),
            line('post_reaction', '2026-09-27T11:00:00Z', 100, { emoji: '🐴' }),
            line('post_reaction', '2026-09-27T10:00:00Z', 100, { emoji: '🐴' }),
            line('followed', '2026-09-27T09:00:00Z', 50000, { by: 'aa' }),
            line('followed', '2026-09-27T08:00:00Z', 50000, { by: 'bb' }),
        ]);
        assert.deepEqual(rows[0].emoji, ['🧌', '🐴', '🐴'], 'every reaction shows');
        assert.equal(rows[0].pennies, '300');
        assert.deepEqual(rows[1].people, ['aa', 'bb']);
    });

    it('a publication and a day of use stand alone', () => {
        const rows = groupLedger([
            line('publication', '2026-09-27T12:00:00Z', 1000, { title: 'one' }),
            line('publication', '2026-09-27T11:00:00Z', 1000, { title: 'two' }),
            line('heartbeat', '2026-09-27T00:00:00Z', 1000, {}, '2026-09-27'),
        ]);
        assert.equal(rows.length, 3);
    });
});
