// The contact ledger's dials - the stops are Curtis's spec verbatim (2026-08-02), pinned.
const assert = require('node:assert');

let TRUST_STOPS, INTEREST_STOPS, contactCollection, nearestStop;
before(async () => {
    ({ TRUST_STOPS, INTEREST_STOPS, contactCollection, nearestStop } = await import(
        '../../../js/pure/contact.js'
    ));
});

describe('the contact dials', () => {
    it('pins the trust stops: 0/5/20/50/80/95', () => {
        assert.deepEqual(TRUST_STOPS.map((s) => s.value), [0, 5, 20, 50, 80, 95]);
        assert.ok(TRUST_STOPS.every((s) => s.label.length > 0 && s.value >= 0 && s.value <= 100));
        assert.equal(TRUST_STOPS[0].label, 'Never heard of them');
    });

    it('pins the interest stops: 0/25/50/75/100, shared by rebroadcasts', () => {
        assert.deepEqual(INTEREST_STOPS.map((s) => s.value), [0, 25, 50, 75, 100]);
        assert.equal(INTEREST_STOPS[0].label, "Don't show");
    });

    it('names the private-KV collection per contact', () => {
        assert.equal(contactCollection('ab'.repeat(32)), `contact:${'ab'.repeat(32)}`);
    });

    it('snaps stored numbers to the nearest stop (a finer future never breaks the select)', () => {
        assert.equal(nearestStop(TRUST_STOPS, '5'), 5, 'exact stops hold');
        assert.equal(nearestStop(TRUST_STOPS, 60), 50);
        assert.equal(nearestStop(TRUST_STOPS, 70), 80);
        assert.equal(nearestStop(INTEREST_STOPS, 12.5), 25, 'ties round up');
        assert.equal(nearestStop(TRUST_STOPS, 'garbage'), 0, 'unparseable falls to the floor');
    });
});
