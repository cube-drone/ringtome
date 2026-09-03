// The display register: whose labels render (ANNOTATIONS.md ruling 5).
const assert = require('node:assert');

let visibleAnnotations, groupLabels, isEmojiTag;
before(async () => {
    ({ visibleAnnotations, groupLabels, isEmojiTag } = await import('../../../js/pure/annotations.js'));
});

describe('whose labels show', () => {
    // The dial is gone (Curtis, 2026-08-31: "too conservative and fussy") - everyone's
    // labels, always; the block is the one filter left standing.
    const author = 'ada';
    const labels = [
        { annotator: 'ada', key: 'tag', value: 'saucy' },
        { annotator: 'bea', key: 'tag', value: 'goopy' },
        { annotator: 'cal', key: 'tag', value: 'rude' },
        { annotator: 'dan', key: 'tag', value: 'meh' },
    ];
    it("shows everyone's labels, blocked excepted", () => {
        const facts = { bea: { interest: 'high' }, cal: { blocked: 'yes' }, dan: {} };
        const seen = visibleAnnotations(labels, { author, factsByRoot: facts });
        assert.deepEqual(seen.map((a) => a.annotator), ['ada', 'bea', 'dan']);
    });
    it('with no ledger at all, everything shows - an anonymous visitor sees the post as it is', () => {
        const seen = visibleAnnotations(labels, { author, factsByRoot: null });
        assert.deepEqual(seen.map((a) => a.annotator), ['ada', 'bea', 'cal', 'dan']);
    });
    it("the reader's own labels always show, even if their ledger somehow marks them", () => {
        const seen = visibleAnnotations(labels, { author, factsByRoot: { cal: { blocked: 'yes' } }, me: 'cal' });
        assert.ok(seen.some((a) => a.annotator === 'cal'));
    });
});

// One chip per (key, value), however many people said it (Curtis, 2026-08-31: Jeff Dorp's
// "beef" and Darn Hot's "beef" collapse; most-agreed first; the author's copy leads its group).
describe('the claimed date is never a chip', () => {
    it('drops display_date labels no matter who said them (Curtis, 2026-09-02)', () => {
        const seen = visibleAnnotations(
            [
                { annotator: 'a', key: 'display_date', value: '2015-07-31' },
                { annotator: 'a', key: 'tag', value: 'beef' },
            ],
            { author: 'a', factsByRoot: {}, me: 'a' }
        );
        assert.deepEqual(seen.map((l) => l.key), ['tag']);
    });
});

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
