// A notebook's recently opened documents (js/pure/recentopens.js): the stored list is newest first,
// an opening moves a document to the front rather than listing it twice, the oldest fall off past
// the cap, and what the notebook no longer holds never shows.
const assert = require('node:assert');

let noteOpened, recentlyOpened, RECENT_OPENS_KEPT;
before(async () => {
    ({ noteOpened, recentlyOpened, RECENT_OPENS_KEPT } =
        await import('../../../js/pure/recentopens.js'));
});

const id = (n) => String(n).padStart(2, '0').repeat(16);
const doc = (n) => ({ doc_id: id(n), title: `note ${n}` });

describe('recently opened documents', () => {
    it('starts a list from nothing', () => {
        assert.strictEqual(noteOpened(undefined, id(1)), id(1));
        assert.strictEqual(noteOpened('', id(1)), id(1));
    });

    it('puts the newest first, and moves a reopened one to the front instead of listing it twice', () => {
        let stored = noteOpened('', id(1));
        stored = noteOpened(stored, id(2));
        stored = noteOpened(stored, id(3));
        assert.strictEqual(stored, [id(3), id(2), id(1)].join(' '));
        stored = noteOpened(stored, id(1));
        assert.strictEqual(stored, [id(1), id(3), id(2)].join(' '));
    });

    it('lets the oldest go past the cap', () => {
        let stored = '';
        for (let n = 1; n <= RECENT_OPENS_KEPT + 5; n++) stored = noteOpened(stored, id(n));
        const ids = stored.split(' ');
        assert.strictEqual(ids.length, RECENT_OPENS_KEPT);
        assert.strictEqual(ids[0], id(RECENT_OPENS_KEPT + 5));
        assert.ok(!ids.includes(id(5)), 'the five oldest are gone');
        assert.ok(ids.includes(id(6)));
    });

    it('orders the documents by their last opening, newest first', () => {
        const stored = [id(2), id(3), id(1)].join(' ');
        const shown = recentlyOpened(stored, [doc(1), doc(2), doc(3)]).map((d) => d.doc_id);
        assert.deepStrictEqual(shown, [id(2), id(3), id(1)]);
    });

    it('shows only what the notebook holds now, and nothing never opened', () => {
        // 9 was opened and has since gone (deleted, moved, or filtered away); 4 was never opened.
        const stored = [id(9), id(2), id(1)].join(' ');
        const shown = recentlyOpened(stored, [doc(1), doc(2), doc(4)]).map((d) => d.doc_id);
        assert.deepStrictEqual(shown, [id(2), id(1)]);
    });

    it('shows nothing before anything is opened, or before the documents arrive', () => {
        assert.deepStrictEqual(recentlyOpened(undefined, [doc(1)]), []);
        assert.deepStrictEqual(recentlyOpened(id(1), null), []);
    });
});
