// What a search found, shown (pure/found.js): excerpts around the words, and the words marked.
const assert = require('node:assert');

let plainOf, excerptsOf, marked, isHit;
before(async () => {
    ({ plainOf, excerptsOf, marked, isHit } = await import('../../../js/pure/found.js'));
});

describe('what a search found: the words marked, and excerpts around them', () => {
    it('reads Marquee as its words', () => {
        assert.equal(
            plainOf(
                '# A [rainbow]banana[/rainbow] day\n\n> said [the pony](https://p.example)\n:::center\n![x](/a.avif)\n- **ripe**',
            ),
            'A banana day said the pony ripe',
        );
    });

    it('marks every token a query word begins, whole', () => {
        assert.deepEqual(marked('Jumped over the fox', ['jum', 'fo']), [
            { text: 'Jumped', hit: true },
            { text: ' over the ', hit: false },
            { text: 'fox', hit: true },
        ]);
        assert.deepEqual(marked('no match', ['x']), [{ text: 'no match', hit: false }]);
    });

    it("an excerpt reaches round its hit to a space, and says where it's cut", () => {
        const text = `${'a '.repeat(100)}banana ${'b '.repeat(100)}`.trim();
        const [only] = excerptsOf(text, ['banana'], { reach: 10 });
        assert.equal(only, '…a a a a a banana b b b b b…');
    });

    it('hits close together share one excerpt, and there are at most three', () => {
        const near = excerptsOf('one banana two banana three', ['banana'], { reach: 10 });
        assert.equal(near.length, 1);
        const far = excerptsOf(`x ${'banana filler filler filler '.repeat(10)}`, ['banana'], {
            reach: 5,
        });
        assert.equal(far.length, 3);
    });

    it('a tag is a hit when a word begins it', () => {
        assert.ok(isHit('fruit-salad', ['sal']));
        assert.ok(!isHit('fruit', ['ban']));
    });
});
