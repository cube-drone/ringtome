// The rolodex's ordering rules.
const assert = require('node:assert');

let PEOPLE_SORTS, PEOPLE_SHELF_SLICE, filterContacts, sortContacts;
before(async () => {
    ({ PEOPLE_SORTS, PEOPLE_SHELF_SLICE, filterContacts, sortContacts } = await import(
        '../../../js/pure/people.js'
    ));
});

const row = (root, facts) => ({ root, facts });

describe('the People shelf', () => {
    it('offers the two orderings: trust and interest', () => {
        assert.deepEqual(PEOPLE_SORTS.map((s) => s.key), ['trust', 'interest']);
    });

    it('orders by the chosen fact, descending', () => {
        const rows = [row('bb', { trust: '20' }), row('aa', { trust: '80' }), row('cc', { trust: '50' })];
        assert.deepEqual(sortContacts(rows, 'trust').map((r) => r.root), ['aa', 'cc', 'bb']);
        const byInterest = [row('aa', { interest: '25' }), row('bb', { interest: '100' })];
        assert.deepEqual(sortContacts(byInterest, 'interest').map((r) => r.root), ['bb', 'aa']);
    });

    it('missing or garbage facts score zero, and ties break by root - stable everywhere', () => {
        const rows = [row('cc', {}), row('aa', { trust: 'what' }), row('bb', { trust: '0' })];
        assert.deepEqual(sortContacts(rows, 'trust').map((r) => r.root), ['aa', 'bb', 'cc']);
    });

    it('blocked personas sink to the bottom regardless of score - visible, never outranking', () => {
        const rows = [
            row('aa', { trust: '95', blocked: 'yes' }),
            row('bb', { trust: '5' }),
        ];
        assert.deepEqual(sortContacts(rows, 'trust').map((r) => r.root), ['bb', 'aa']);
    });

    it('never mutates its input (the mirror hands out live arrays)', () => {
        const rows = [row('bb', { trust: '1' }), row('aa', { trust: '2' })];
        sortContacts(rows, 'trust');
        assert.deepEqual(rows.map((r) => r.root), ['bb', 'aa']);
    });
});

describe('the People filter (search-first: the filter finds, the slice bounds)', () => {
    const greg = {
        root: 'ab'.repeat(32),
        name: 'Gregory Itself',
        words: 'sway-broke',
        facts: { nickname: 'greg from work' },
    };
    const dave = { root: 'cd'.repeat(32), name: 'Dave', words: 'tidal-crumb', facts: {} };

    it('an empty query keeps everything', () => {
        assert.deepEqual(filterContacts([greg, dave], ''), [greg, dave]);
        assert.deepEqual(filterContacts([greg, dave], '   '), [greg, dave]);
    });

    it('matches every spelling a person is known by', () => {
        // your nickname for them
        assert.deepEqual(filterContacts([greg, dave], 'from work'), [greg]);
        // their self-claimed name, case-insensitively
        assert.deepEqual(filterContacts([greg, dave], 'gregORY'), [greg]);
        // their root hex, by prefix
        assert.deepEqual(filterContacts([greg, dave], 'cdcd'), [dave]);
        // the speakable words the caller derived (the spelling the identicon wears)
        assert.deepEqual(filterContacts([greg, dave], 'tidal'), [dave]);
    });

    it('rows without names, words, or facts filter without throwing', () => {
        const bare = { root: 'ef'.repeat(32) };
        assert.deepEqual(filterContacts([bare], 'zzzz-no-match-zzzz'), []);
        assert.deepEqual(filterContacts([bare], 'efef'), [bare]);
    });

    it('the shelf slice is a real bound', () => {
        assert.ok(Number.isInteger(PEOPLE_SHELF_SLICE) && PEOPLE_SHELF_SLICE > 0);
    });
});
