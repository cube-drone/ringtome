/*
    The Network page's rules (js/pure/machines.js, plans/NETWORK.md): how a machine stands, what
    it's called, its reliability as a reader reads it, and the "linked to you" filter.
*/
const assert = require('node:assert');

let m;
before(async () => {
    m = await import('../../../js/pure/machines.js');
});

describe('the machine table, as the page reads it', () => {
    const now = 1_000_000;

    it('says how a machine stands, dark first', () => {
        const { machineStatus } = m;
        assert.equal(machineStatus({ dark_until_ms: now + 1, last_ok_ms: 5 }, now), 'dark');
        assert.equal(
            machineStatus({ dark_until_ms: now - 1, last_fail_ms: 9, last_ok_ms: 5 }, now),
            'unanswered',
        );
        assert.equal(machineStatus({ last_ok_ms: 9, last_fail_ms: 5 }, now), 'answering');
        assert.equal(machineStatus({ last_ok_ms: 9 }, now), 'answering');
        assert.equal(machineStatus({ last_inbound_ms: 9 }, now), 'dials-in');
        assert.equal(machineStatus({}, now), 'unknown');
    });

    it('names a machine by what it said, else by its words', () => {
        assert.equal(
            m.machineLabel({ name: "curtis's mac mini", words: 'sway-broke-AwTy' }),
            "curtis's mac mini",
        );
        assert.equal(m.machineLabel({ name: null, words: 'sway-broke-AwTy' }), 'sway-broke-AwTy');
        assert.equal(m.machineLabel({ endpoint: 'abc' }), 'abc');
    });

    it('gives no percentage for a machine never dialed', () => {
        assert.equal(m.reliabilityPct({ tries: 0, reliability: 0.5 }), null);
        assert.equal(m.reliabilityPct({ tries: 3.2, reliability: 0.876 }), 88);
    });

    it('keeps only the linked machines when asked', () => {
        const rows = [
            { endpoint: 'a', links: [{ kind: 'own' }] },
            { endpoint: 'b', links: [] },
            { endpoint: 'c' },
        ];
        assert.deepEqual(
            m.machinesShown(rows, true).map((r) => r.endpoint),
            ['a'],
        );
        assert.equal(m.machinesShown(rows, false).length, 3);
    });
});
