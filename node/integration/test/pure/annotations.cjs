// The display register: whose labels render (ANNOTATIONS.md ruling 5).
const assert = require('node:assert');

let visibleAnnotations, DEFAULT_ANNOTATION_STOP, groupLabels, isEmojiTag;
before(async () => {
    ({ visibleAnnotations, DEFAULT_ANNOTATION_STOP, groupLabels, isEmojiTag } = await import('../../../js/pure/annotations.js'));
});

describe('the annotations display register', () => {
    const author = 'ada';
    const labels = [
        { annotator: 'ada', key: 'tag', value: 'saucy' },
        { annotator: 'bea', key: 'tag', value: 'goopy' },
        { annotator: 'cal', key: 'tag', value: 'rude' },
        { annotator: 'dan', key: 'tag', value: 'meh' },
    ];
    const facts = { bea: { interest: 'high' }, cal: { blocked: 'yes' }, dan: {} };

    it("defaults to everyone's labels - blocked excepted", () => {
        assert.equal(DEFAULT_ANNOTATION_STOP, 'everyone');
        const seen = visibleAnnotations(labels, { author, stop: DEFAULT_ANNOTATION_STOP, factsByRoot: facts });
        assert.deepEqual(seen.map((a) => a.annotator), ['ada', 'bea', 'dan']);
    });

    it("'followed' narrows to the author's plus people I follow", () => {
        const seen = visibleAnnotations(labels, { author, stop: 'followed', factsByRoot: facts });
        assert.deepEqual(seen.map((a) => a.annotator), ['ada', 'bea']);
    });

    it("'author' shows the author's alone", () => {
        const seen = visibleAnnotations(labels, { author, stop: 'author', factsByRoot: facts });
        assert.deepEqual(seen.map((a) => a.annotator), ['ada']);
    });

    it("'everyone' shows all - except a blocked annotator, whatever the stop", () => {
        const seen = visibleAnnotations(labels, { author, stop: 'everyone', factsByRoot: facts });
        assert.deepEqual(seen.map((a) => a.annotator), ['ada', 'bea', 'dan']);
    });

    it("the reader's own labels always show - nobody follows themselves", () => {
        // 2026-08-31: three tags said from the UI vanished on refresh, filtered out by the
        // reader's own register at the default stop.
        const mine = [...labels, { annotator: 'me', key: 'tag', value: 'said-by-me' }];
        const seen = visibleAnnotations(mine, { author, stop: 'author', factsByRoot: facts, me: 'me' });
        assert.deepEqual(seen.map((a) => a.annotator), ['ada', 'me']);
    });

    it("with no ledger at all (nobody signed in) it is the author's only", () => {
        const seen = visibleAnnotations(labels, { author, stop: 'everyone', factsByRoot: null });
        assert.deepEqual(seen.map((a) => a.annotator), ['ada']);
    });
});

// One chip per (key, value), however many people said it (Curtis, 2026-08-31: Jeff Dorp's
// "beef" and Darn Hot's "beef" collapse; most-agreed first; the author's copy leads its group).
describe('grouping identical labels', () => {
    it('collapses by (key, value) and orders most-agreed-first', () => {
        const grouped = groupLabels(
            [
                { annotator: 'ada', key: 'tag', value: 'saucy' },
                { annotator: 'jeff', key: 'tag', value: 'beef' },
                { annotator: 'darn', key: 'tag', value: 'beef' },
                { annotator: 'ada', key: 'tag', value: 'beef' },
            ],
            { author: 'ada' }
        );
        assert.deepEqual(
            grouped.map((g) => [g.value, g.contributors.length]),
            [['beef', 3], ['saucy', 1]]
        );
        // The post author's copy leads its group; the rest keep arrival order.
        assert.deepEqual(grouped[0].contributors.map((c) => c.annotator), ['ada', 'jeff', 'darn']);
    });
    it('a tie keeps arrival order, and the same person twice counts once', () => {
        const grouped = groupLabels(
            [
                { annotator: 'bea', key: 'tag', value: 'goopy' },
                { annotator: 'bea', key: 'tag', value: 'goopy' },
                { annotator: 'cal', key: 'tag', value: 'rude' },
            ],
            { author: 'ada' }
        );
        assert.deepEqual(
            grouped.map((g) => [g.value, g.contributors.length]),
            [['goopy', 1], ['rude', 1]]
        );
    });
});

// A tag that IS one emoji is a reaction (Curtis, 2026-08-31): one pictographic cluster,
// however it is composed - and nothing that merely contains one.
describe('recognising an emoji-only tag', () => {
    it('accepts one emoji, composed or plain', () => {
        for (const v of ['\u2764\uFE0F', '\u{1F44D}', '\u{1F44D}\u{1F3FD}', '\u{1FAC2}', '\u{1F469}\u200D\u{1F469}\u200D\u{1F466}', '\u{1F4A9}']) {
            assert.ok(isEmojiTag(v), `one emoji: ${v}`);
        }
    });
    it('refuses text, mixtures, digits, and crowds', () => {
        for (const v of ['beef', 'beef \u{1F914}', 'asshole 100', '100', '\u{1F525}\u{1F525}', '']) {
            assert.ok(!isEmojiTag(v), `not one emoji: ${v}`);
        }
    });
});
