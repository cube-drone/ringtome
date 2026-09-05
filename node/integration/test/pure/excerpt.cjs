const assert = require('node:assert');

let excerpt, plainWords, descriptionOf;
before(async () => {
    ({ excerpt, plainWords, descriptionOf } = await import('../../../js/pure/excerpt.js'));
});

describe("an untitled post's first words (the mini-card, 2026-09-05)", () => {
    it('takes the first nine usable words and says there were more', () => {
        const body = 'one two three four five six seven eight nine ten eleven';
        assert.equal(excerpt(body, 'plaintext'), 'one two three four five six seven eight nine\u2026');
        assert.equal(excerpt('just a few words', 'marquee'), 'just a few words', 'no ellipsis when they all fit');
    });

    it('sheds the markup and keeps the words', () => {
        const body = '# A heading\n\n> quoted **bold** and _soft_ words\n\n- a `list` item\n1. another';
        assert.deepEqual(plainWords(body), ['A', 'heading', 'quoted', 'bold', 'and', 'soft', 'words', 'a', 'list', 'item', 'another']);
    });

    it('a picture is not a word, a link is its text, an address is nothing', () => {
        const body = '![cat](/id/r/docs/t/body/media.avif) look at [this thing](https://example.com/x) https://example.com/y www.example.com';
        assert.equal(excerpt(body, 'marquee'), 'look at this thing');
        assert.equal(excerpt('![only](a.avif)', 'marquee'), '', 'a picture alone offers no words');
    });

    it("a book's body is a table, not words; punctuation alone is not a word", () => {
        assert.equal(excerpt('{"title":"x","pages":[]}', 'book'), '');
        assert.equal(excerpt('--- *** ...', 'plaintext'), '');
        assert.equal(excerpt('', 'plaintext'), '');
    });

    it("the author's own description wins, never somebody else's", () => {
        const ann = [
            { key: 'description', value: 'a stranger says', annotator: 'bb' },
            { key: 'tag', value: 'cats', annotator: 'aa' },
            { key: 'description', value: '  the author says  ', annotator: 'aa' },
        ];
        assert.equal(descriptionOf(ann, 'aa'), 'the author says');
        assert.equal(descriptionOf(ann, 'cc'), '');
        assert.equal(descriptionOf(undefined, 'aa'), '');
    });
});
