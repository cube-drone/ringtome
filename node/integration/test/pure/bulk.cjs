// Bulk actions as values (plans/BULK.md): the selection, and the decisions an action makes before
// it writes - above all, what a move takes each document out of, which is where a mistake would
// quietly strand a note in two notebooks or none.
const assert = require('node:assert');

let B, apps, normalTag;
before(async () => {
    B = await import('../../../js/pure/bulk.js');
    apps = await import('../../../js/pure/apps.js');
    ({ normalTag } = await import('../../../js/pure/annotations.js'));
});

// Writer's home notebook is `default`; `recipes` and `poems` are Writer's too; `sketches` is
// Drawing's (its home is `drawing`); `files` is the uploads', reserved.
const ROSTER = [
    { name: 'default', app: 'default' },
    { name: 'recipes', app: 'default' },
    { name: 'poems', app: 'default' },
    { name: 'drawing', app: 'drawing' },
    { name: 'sketches', app: 'drawing' },
    { name: 'files' },
    { name: 'chat' },
];
const doc = (id, buckets, extra = {}) => ({ doc_id: id, buckets, tags: [], ...extra });

describe('the selection', () => {
    it('adds on a Shift-click, and takes away on a second', () => {
        let s = B.toggleSelection([], 'a');
        s = B.toggleSelection(s, 'b');
        assert.deepEqual(s, ['a', 'b']);
        assert.deepEqual(B.toggleSelection(s, 'a'), ['b']);
    });

    it('takes the open document along with the first Shift-click', () => {
        assert.deepEqual(B.toggleSelection([], 'b', 'a'), ['a', 'b']);
        assert.deepEqual(
            B.toggleSelection([], 'a', 'a'),
            ['a'],
            'Shift-clicking the open one: one',
        );
        assert.deepEqual(B.toggleSelection(['c'], 'b', 'a'), ['c', 'b'], 'only the first click');
    });

    it('selects all of what the list shows, in its order', () => {
        assert.deepEqual(B.selectAll([doc('x', []), doc('y', [])]), ['x', 'y']);
    });

    it('lets go of what left the list, and hands back the same selection when nothing did', () => {
        const picked = ['a', 'b', 'c'];
        assert.deepEqual(B.pruneSelection(picked, ['a', 'c', 'z']), ['a', 'c']);
        assert.equal(B.pruneSelection(picked, ['c', 'b', 'a']), picked);
    });
});

describe('what an action touches', () => {
    it('leaves the app’s own pictures and sounds alone', () => {
        const docs = [doc('mine', []), doc('theirs', [], { builtin: true })];
        assert.deepEqual(
            B.actionable(docs).map((d) => d.doc_id),
            ['mine'],
        );
    });

    it('finds the sounds among a mixed selection, built-in ones left out', () => {
        const docs = [
            doc('song', [], { format: 'opus' }),
            doc('note', [], { format: 'marquee' }),
            doc('chime', [], { format: 'opus', builtin: true }),
        ];
        assert.deepEqual(
            B.soundsAmong(docs).map((d) => d.doc_id),
            ['song'],
        );
    });

    it('never offers the song’s name or its number for bulk', () => {
        assert.ok(!B.BULK_SOUND_FIELDS.includes('track'));
        assert.ok(!B.BULK_SOUND_FIELDS.includes('track number'));
    });

    it('offers no tag the node computes for a document: removing it would change nothing (2026-10-22)', () => {
        const docs = [
            doc('a', [], {
                tags: ['delta green', 'micro', 'image', 'ai-agent'],
                implicit: ['micro', 'image'],
            }),
            doc('b', [], { tags: ['delta green', 'long'], implicit: ['long'] }),
            // 'long' said by a person on this one, and not computed for it: theirs to remove.
            doc('c', [], { tags: ['long'] }),
        ];
        assert.deepEqual(B.combinedTags(docs), [
            ['delta green', 2],
            ['ai-agent', 1],
            ['long', 1],
        ]);
    });

    it('counts the words between them, and none for a selection with no words', () => {
        const docs = [
            doc('a', [], { words: 120 }),
            doc('b', [], { words: 0 }),
            doc('c', [], {}), // a drawing: no count of its own
            doc('d', [], { words: 1000 }),
        ];
        assert.equal(B.wordsAmong(docs), 1120);
        assert.equal(B.wordsAmong([docs[2]]), null);
        assert.equal(B.wordsAmong([]), null);
    });

    it('combines the tags, commonest first, then by name', () => {
        const docs = [
            doc('a', [], { tags: ['oats', 'hay'] }),
            doc('b', [], { tags: ['hay'] }),
            doc('c', [], { tags: ['apples'] }),
        ];
        assert.deepEqual(B.combinedTags(docs), [
            ['hay', 2],
            ['apples', 1],
            ['oats', 1],
        ]);
        assert.deepEqual(
            B.carrying(docs, 'hay').map((d) => d.doc_id),
            ['a', 'b'],
        );
        assert.deepEqual(
            B.lacking(docs, 'hay').map((d) => d.doc_id),
            ['c'],
        );
    });

    it('keeps tags the tag editor’s way: lowercased, cut at 32, no emoji on your own', () => {
        assert.deepEqual(normalTag('  Oats  '), { tag: 'oats', refused: null });
        assert.equal(normalTag('x'.repeat(40)).tag.length, 32);
        assert.equal(normalTag('🐴').refused, 'emoji');
        assert.equal(normalTag('   ').refused, 'empty');
    });
});

describe('moving', () => {
    it('offers a notebook app its other notebooks, never the one in view', () => {
        const writer = apps.appForStyle('default');
        const offered = B.moveTargets(writer, ROSTER, 'recipes');
        assert.ok(offered.includes('default') && offered.includes('poems'));
        assert.ok(!offered.includes('recipes'), 'not where they already are');
        assert.ok(!offered.includes('sketches'), "not another app's");
    });

    it('offers hrseFiles every notebook but the reserved ones', () => {
        const offered = B.moveTargets(apps.appById('lost-found'), ROSTER, '');
        assert.deepEqual(offered, ['default', 'drawing', 'poems', 'recipes', 'sketches']);
    });

    it('takes a document out of the notebook in view, in a notebook app', () => {
        const row = doc('n', ['default', 'recipes']);
        assert.equal(B.moveOutOf(row, ROSTER, 'poems', { inView: 'recipes' }), 'recipes');
    });

    it('takes a document out of the notebook it opens in, in hrseFiles - for the same app only', () => {
        const note = doc('n', ['recipes']);
        assert.equal(B.moveOutOf(note, ROSTER, 'poems'), 'recipes', 'Writer to Writer: a move');
        assert.equal(
            B.moveOutOf(note, ROSTER, 'sketches'),
            null,
            "Writer to Drawing: filed there, and it stays in Writer's",
        );
    });

    it('never takes an upload out of the uploads', () => {
        assert.equal(B.moveOutOf(doc('f', ['files']), ROSTER, 'recipes'), null);
    });

    it('only files a document that is in no notebook, or already where it is going', () => {
        assert.equal(B.moveOutOf(doc('stray', []), ROSTER, 'recipes'), null);
        assert.equal(B.moveOutOf(doc('n', ['recipes']), ROSTER, 'recipes'), null);
    });

    it('knows a notebook made a moment ago by the app it was made for, not the roster', () => {
        // `sketchbook` isn't in the roster yet: read from it, it would be Writer's, and a drawing
        // moved into it would never leave `sketches`.
        const drawing = doc('d', ['sketches']);
        assert.equal(B.moveOutOf(drawing, ROSTER, 'sketchbook', { inView: 'sketches' }), null);
        assert.equal(
            B.moveOutOf(drawing, ROSTER, 'sketchbook', { inView: 'sketches', toType: 'drawing' }),
            'sketches',
        );
    });

    it('never leaves a document in no notebook, however it moves', () => {
        // An invariant over every pair of notebooks: a move adds the destination before anything
        // is taken away, and what's taken away is never the destination itself.
        const names = ROSTER.map((b) => b.name);
        for (const held of names) {
            for (const to of names.filter((n) => !apps.RESERVED_BUCKETS.has(n))) {
                for (const inView of [null, held]) {
                    const out = B.moveOutOf(doc('n', [held]), ROSTER, to, { inView });
                    const after = [...new Set([held, to])].filter((b) => b !== out);
                    assert.ok(after.includes(to), `${held} -> ${to} ends in ${to}`);
                }
            }
        }
    });

    it('refuses a reserved name for a new notebook', () => {
        assert.equal(B.newNotebookName('files').refused, 'reserved');
        assert.equal(B.newNotebookName('  ').refused, 'empty');
        assert.deepEqual(B.newNotebookName(' horse facts '), {
            name: 'horse facts',
            refused: null,
        });
    });
});
