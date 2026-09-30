// HorseBucks in the broken-number notation: exact to the penny under a million, then a few digits
// and a named magnitude - the short scale to centillion, and a word-list jillion past it.
const assert = require('node:assert');

let formatHorseBucks, magnitudeName;
before(async () => {
    ({ formatHorseBucks, magnitudeName } = await import('../../../js/pure/horsebucks.js'));
});

describe('magnitudeName', () => {
    it('names the short scale, then the jillions', () => {
        assert.equal(magnitudeName(1), 'million');
        assert.equal(magnitudeName(3), 'trillion');
        assert.equal(magnitudeName(10), 'decillion');
        assert.equal(magnitudeName(14), 'quattuordecillion');
        assert.equal(magnitudeName(20), 'vigintillion');
        assert.equal(magnitudeName(99), 'novemnonagintillion');
        assert.equal(magnitudeName(100), 'centillion');
        assert.equal(magnitudeName(101), 'acidjillion', '10^306, the first past centillion');
        assert.equal(magnitudeName(102), 'poutjillion');
        assert.equal(magnitudeName(107), 'salsajillion');
    });
    it('every jillion in the list gets its own word', () => {
        const names = new Set();
        for (let n = 101; n < 101 + 1296; n++) names.add(magnitudeName(n));
        assert.equal(names.size, 1296);
    });
});

describe('formatHorseBucks', () => {
    it('is exact to the penny under a million', () => {
        assert.equal(formatHorseBucks('0'), 'H$ 0.00');
        assert.equal(formatHorseBucks('12345'), 'H$ 123.45');
        assert.equal(formatHorseBucks('99999999'), 'H$ 999,999.99');
    });
    it('names the magnitude past a million, debt keeping its sign', () => {
        assert.equal(formatHorseBucks('183928000000'), 'H$ 1.83 billion');
        assert.equal(formatHorseBucks('100000000'), 'H$ 1.00 million');
        assert.equal(formatHorseBucks('-4250000000'), '-H$ 42.50 million');
        assert.equal(formatHorseBucks(`293${'0'.repeat(324)}00`), 'H$ 293.00 salsajillion', '293 x 10^324');
    });
    it('reads nonsense as nothing', () => {
        assert.equal(formatHorseBucks('horse'), 'H$ 0.00');
        assert.equal(formatHorseBucks(undefined), 'H$ 0.00');
    });
});
