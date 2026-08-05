// How long ago, as a unit and a count. The judgement is ours (which unit reads best); turning
// it into words belongs to the reader's machine, so nothing here formats anything.
const assert = require('node:assert');

let agoUnit, JUST_NOW_MS;
before(async () => {
    ({ agoUnit, JUST_NOW_MS } = await import('../../../js/pure/ago.js'));
});

const NOW = 1_700_000_000_000;
const ago = (ms) => agoUnit(NOW - ms, NOW);

describe('agoUnit', () => {
    it('says nothing at all about something that just happened', () => {
        assert.equal(ago(0), null);
        assert.equal(ago(JUST_NOW_MS - 1), null, 'a few seconds of precision is noise');
    });

    it('counts in seconds once it is worth counting', () => {
        assert.deepEqual(ago(50 * 1000), { value: -50, unit: 'second' });
    });

    it('steps up when the smaller unit stops reading well', () => {
        assert.deepEqual(ago(60 * 1000), { value: -1, unit: 'minute' });
        assert.deepEqual(ago(90 * 60 * 1000), { value: -1, unit: 'hour' },
            '90 minutes is an hour ago, not 90 minutes ago');
        assert.deepEqual(ago(26 * 60 * 60 * 1000), { value: -1, unit: 'day' });
    });

    it('counts NEGATIVE - the past, as Intl.RelativeTimeFormat reads it', () => {
        const { value } = ago(5 * 60 * 1000);
        assert.ok(value < 0, 'a positive count would render as "in 5 minutes"');
    });

    it('has nothing to say about a time nobody gave it', () => {
        assert.equal(agoUnit(null, NOW), null);
        assert.equal(agoUnit(undefined, NOW), null);
        assert.equal(agoUnit(0, NOW), null);
    });

    it('refuses to run backwards when the clocks disagree', () => {
        // Their node's stamp can be ahead of ours; "in 3 minutes" for a past event is worse
        // than saying nothing.
        assert.equal(agoUnit(NOW + 3 * 60 * 1000, NOW), null);
    });
});
