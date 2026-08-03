// The rolodex's ordering rules.
const assert = require('node:assert');

let PEOPLE_SORTS, sortContacts, displayNames;
before(async () => {
    ({ PEOPLE_SORTS, sortContacts, displayNames } = await import('../../../js/pure/people.js'));
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

describe('the three names', () => {
    it('orders nickname, self-name, words - your word for them wins', () => {
        assert.deepEqual(
            displayNames({ nickname: 'Jerry', name: 'PhazerBean', words: 'point-cheer' }),
            ['Jerry', 'PhazerBean', 'point-cheer']
        );
    });

    it('absent names drop out; the words are always the floor', () => {
        assert.deepEqual(displayNames({ name: 'PhazerBean', words: 'point-cheer' }), ['PhazerBean', 'point-cheer']);
        assert.deepEqual(displayNames({ nickname: 'Jerry', words: 'point-cheer' }), ['Jerry', 'point-cheer']);
        assert.deepEqual(displayNames({ words: 'point-cheer' }), ['point-cheer']);
    });
});

describe('the signal bars', () => {
    let signalLevel;
    before(async () => {
        ({ signalLevel } = await import('../../../js/pure/people.js'));
    });

    it('maps interest stops exactly: 0/25/50/75/100 -> none..full', () => {
        assert.deepEqual([0, 25, 50, 75, 100].map(signalLevel), [0, 1, 2, 3, 4]);
    });

    it('maps trust stops honestly: 0,5 share none; 20/50/80/95 climb', () => {
        assert.deepEqual([0, 5, 20, 50, 80, 95].map(signalLevel), [0, 0, 1, 2, 3, 4]);
    });

    it('clamps and shrugs at garbage', () => {
        assert.equal(signalLevel('200'), 4);
        assert.equal(signalLevel(-5), 0);
        assert.equal(signalLevel('what'), 0);
    });
});
