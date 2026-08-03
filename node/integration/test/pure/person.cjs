// How a person renders, as rules: their colour, and the order of their three names.
const assert = require('node:assert');

let personaHue, displayNames, PERSON_SIZES;
before(async () => {
    ({ personaHue, displayNames, PERSON_SIZES } = await import('../../../js/pure/person.js'));
});

describe('a person, rendered', () => {
    it('derives a stable hue from the root - same persona, same colour, everywhere', () => {
        const root = '93ad0ddd9dd2022bf2ac21664b386965e0eeffecaff6e49b71039db5f1cf53f3';
        assert.equal(personaHue(root), parseInt('93ad0d', 16) % 360);
        assert.equal(personaHue(root), personaHue(root), 'deterministic');
        assert.ok(personaHue(root) >= 0 && personaHue(root) < 360, 'a real hue');
    });

    it('never renders NaN, whatever it is handed', () => {
        assert.equal(personaHue(''), 0);
        assert.equal(personaHue(undefined), 0);
        assert.equal(personaHue('zzzzzz'), 0);
    });

    it('orders nickname, self-name, words - your word for them wins', () => {
        assert.deepEqual(
            displayNames({ nickname: 'Jerry', name: 'PhazerBean', words: 'point-cheer' }),
            ['Jerry', 'PhazerBean', 'point-cheer']
        );
    });

    it('absent names drop out; the words are always the floor', () => {
        assert.deepEqual(displayNames({ name: 'PhazerBean', words: 'point-cheer' }), [
            'PhazerBean',
            'point-cheer',
        ]);
        assert.deepEqual(displayNames({ nickname: 'Jerry', words: 'point-cheer' }), [
            'Jerry',
            'point-cheer',
        ]);
        assert.deepEqual(displayNames({ words: 'point-cheer' }), ['point-cheer']);
    });

    it('names the chip sizes, smallest first', () => {
        assert.deepEqual(PERSON_SIZES, ['mini', 'small']);
    });
});

describe('the signal bars', () => {
    let signalLevel;
    before(async () => {
        ({ signalLevel } = await import('../../../js/pure/person.js'));
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
