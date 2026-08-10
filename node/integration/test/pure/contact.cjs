// The contact ledger's dials - the five bands are Curtis's spec verbatim (2026-08-09,
// Bands Not Numbers), pinned: the same ladder for every dial in every system.
const assert = require('node:assert');

let BANDS, TRUST_STOPS, INTEREST_STOPS, contactCollection, bandOf, bandOrdinal;
before(async () => {
    ({ BANDS, TRUST_STOPS, INTEREST_STOPS, contactCollection, bandOf, bandOrdinal } = await import(
        '../../../js/pure/contact.js'
    ));
});

describe('the contact dials', () => {
    it('pins the ladder: none/low/medium/high/max, in that order', () => {
        assert.deepEqual(BANDS, ['none', 'low', 'medium', 'high', 'max']);
    });

    it('both dials climb the same ladder, wearing their own words', () => {
        assert.deepEqual(TRUST_STOPS.map((s) => s.value), BANDS);
        assert.deepEqual(INTEREST_STOPS.map((s) => s.value), BANDS);
        assert.ok(TRUST_STOPS.every((s) => s.label.length > 0));
        assert.equal(TRUST_STOPS[0].label, 'Never heard of them');
        assert.equal(
            TRUST_STOPS[4].label,
            "I've met them in person - they aren't being impersonated",
            'the max stop IS the vouch'
        );
        assert.equal(INTEREST_STOPS[0].label, "Don't show");
    });

    it('names the private-KV collection per contact', () => {
        assert.equal(contactCollection('ab'.repeat(32)), `contact:${'ab'.repeat(32)}`);
    });

    it('reads bands strictly: silence and garbage are null, never the bottom band', () => {
        assert.equal(bandOf('high'), 'high');
        assert.equal(bandOf(null), null, 'unset is no opinion');
        assert.equal(bandOf(''), null);
        assert.equal(bandOf('garbage'), null);
        assert.equal(bandOf('75'), null, 'the retired numeric scale reads as silence');
        assert.equal(bandOf(75), null);
    });

    it('ordinals are the rungs, 0-4', () => {
        assert.deepEqual(BANDS.map(bandOrdinal), [0, 1, 2, 3, 4]);
        assert.equal(bandOrdinal(undefined), null);
        assert.equal(bandOrdinal('nonsense'), null);
    });
});
