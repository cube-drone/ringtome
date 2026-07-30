// The client-side search matcher - pure logic over token-bag rows, no node, no browser.
const assert = require('node:assert');

let matchDocs, queryWords;
before(async () => {
    ({ matchDocs, queryWords } = await import('../../../js/search.js'));
});

const rows = [
    { doc_id: 'a', tokens: 'the quick brown fox jumped' },
    { doc_id: 'b', tokens: 'marzipan confectionery dessert' },
    { doc_id: 'c', tokens: 'the lazy dog sleeps' },
];

describe('search matcher', () => {
    it('an empty query matches nothing (the caller shows all instead)', () => {
        assert.equal(matchDocs('', rows).size, 0);
        assert.equal(matchDocs('   ', rows).size, 0);
        assert.deepEqual(queryWords(''), []);
    });

    it('matches on a whole word', () => {
        assert.deepEqual([...matchDocs('fox', rows)], ['a']);
        assert.deepEqual([...matchDocs('marzipan', rows)], ['b']);
    });

    it('prefix-matches for type-ahead', () => {
        // "jum" finds "jumped" mid-keystroke.
        assert.deepEqual([...matchDocs('jum', rows)], ['a']);
        assert.deepEqual([...matchDocs('conf', rows)], ['b']);
    });

    it('ANDs the query words - each must prefix some token', () => {
        assert.deepEqual([...matchDocs('quick fox', rows)], ['a']);
        // "the" is in both a and c, "lazy" only in c: the pair narrows to c.
        assert.deepEqual([...matchDocs('the lazy', rows)], ['c']);
        // no doc has both.
        assert.equal(matchDocs('fox dessert', rows).size, 0);
    });

    it('is case- and punctuation-insensitive, like the index', () => {
        assert.deepEqual([...matchDocs('FOX', rows)], ['a']);
        assert.deepEqual([...matchDocs('quick, brown!', rows)], ['a']);
        assert.deepEqual(queryWords('Quick-Brown FOX'), ['quick', 'brown', 'fox']);
    });

    it('a query word that prefixes nothing yields no match', () => {
        assert.equal(matchDocs('quickx', rows).size, 0);
        assert.equal(matchDocs('zzz', rows).size, 0);
    });
});
