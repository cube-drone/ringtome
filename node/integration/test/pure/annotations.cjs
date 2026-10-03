// The display register: whose labels render (PROJECT_PLAN's Public annotations, ruling 5).
const assert = require('node:assert');

let visibleAnnotations, groupLabels, isEmojiTag, boundedTags, mayTag, tagsLeft;
before(async () => {
    ({ visibleAnnotations, groupLabels, isEmojiTag, boundedTags, mayTag, tagsLeft } =
        await import('../../../js/pure/annotations.js'));
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
        assert.deepEqual(
            seen.map((a) => a.annotator),
            ['ada', 'bea', 'dan'],
        );
    });
    it('with no ledger at all, everything shows - an anonymous visitor sees the post as it is', () => {
        const seen = visibleAnnotations(labels, { author, factsByRoot: null });
        assert.deepEqual(
            seen.map((a) => a.annotator),
            ['ada', 'bea', 'cal', 'dan'],
        );
    });
    it("the reader's own labels always show, even if their ledger somehow marks them", () => {
        const seen = visibleAnnotations(labels, {
            author,
            factsByRoot: { cal: { blocked: 'yes' } },
            me: 'cal',
        });
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
            { author: 'a', factsByRoot: {}, me: 'a' },
        );
        assert.deepEqual(
            seen.map((l) => l.key),
            ['tag'],
        );
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
            { author: 'ada' },
        );
        assert.deepEqual(
            grouped.map((g) => [g.value, g.contributors.length]),
            [
                ['beef', 3],
                ['saucy', 1],
            ],
        );
        // The post author's copy leads its group; the rest keep arrival order.
        assert.deepEqual(
            grouped[0].contributors.map((c) => c.annotator),
            ['ada', 'jeff', 'darn'],
        );
    });
    it('a tie keeps arrival order, and the same person twice counts once', () => {
        const grouped = groupLabels(
            [
                { annotator: 'bea', key: 'tag', value: 'goopy' },
                { annotator: 'bea', key: 'tag', value: 'goopy' },
                { annotator: 'cal', key: 'tag', value: 'rude' },
            ],
            { author: 'ada' },
        );
        assert.deepEqual(
            grouped.map((g) => [g.value, g.contributors.length]),
            [
                ['goopy', 1],
                ['rude', 1],
            ],
        );
    });
});

// A tag that IS one emoji is a reaction (Curtis, 2026-08-31): one pictographic cluster,
// however it is composed - and nothing that merely contains one.
describe('recognising an emoji-only tag', () => {
    it('accepts one emoji, composed or plain', () => {
        for (const v of [
            '\u2764\uFE0F',
            '\u{1F44D}',
            '\u{1F44D}\u{1F3FD}',
            '\u{1FAC2}',
            '\u{1F469}\u200D\u{1F469}\u200D\u{1F466}',
            '\u{1F4A9}',
        ]) {
            assert.ok(isEmojiTag(v), `one emoji: ${v}`);
        }
    });
    it('refuses text, mixtures, digits, and crowds', () => {
        for (const v of [
            'beef',
            'beef \u{1F914}',
            'asshole 100',
            '100',
            '\u{1F525}\u{1F525}',
            '',
        ]) {
            assert.ok(!isEmojiTag(v), `not one emoji: ${v}`);
        }
    });
});

// Two tags to a person on somebody else's post, and no reaction to your own (Curtis,
// 2026-09-27) - the node's rule (annotations.rs `bounded`), kept here for what the client
// holds, and the card's door in front of it.
describe('the tag rules', () => {
    const tag = (annotator, value) => ({ annotator, key: 'tag', value });
    it("keeps two tags to a person, the first in code-point order, and none of the author's reactions", () => {
        const labels = [
            tag('a', '\u{1F4AF}'),
            tag('a', 'mighty'),
            tag('a', 'saucy'),
            tag('a', 'third'),
            tag('b', '\u{1F434}'),
            tag('b', 'zebra'),
            tag('b', 'alpha'),
            { annotator: 'b', key: 'description', value: 'words' },
            // UTF-16 order would put this emoji before U+FF21 (a surrogate is below it); the
            // node's byte order puts it after, and the client must agree.
            tag('c', '\u{1F434}'),
            tag('c', '\uFF21'),
            tag('c', 'z'),
        ];
        const kept = boundedTags(labels, { author: 'a' });
        const by = (who) => kept.filter((l) => l.annotator === who).map((l) => l.value);
        assert.deepEqual(by('a'), ['mighty', 'saucy', 'third']);
        assert.deepEqual(by('b'), ['zebra', 'alpha', 'words']);
        assert.deepEqual(by('c'), ['\uFF21', 'z']);
    });
    it('visibleAnnotations reads through the same rule', () => {
        const labels = [tag('a', '\u{1F4AF}'), tag('b', 'x'), tag('b', 'y'), tag('b', 'z')];
        const shown = visibleAnnotations(labels, { author: 'a', factsByRoot: {}, me: 'b' });
        assert.deepEqual(
            shown.map((l) => l.value),
            ['x', 'y'],
        );
    });
    it('the card lets you say two, again, and no reaction on your own post', () => {
        const labels = [tag('b', 'x')];
        assert.equal(tagsLeft(labels, { author: 'a', me: 'b' }), 1);
        assert.ok(mayTag(labels, { author: 'a', me: 'b', value: 'y' }));
        const two = [...labels, tag('b', 'y')];
        assert.equal(tagsLeft(two, { author: 'a', me: 'b' }), 0);
        assert.ok(!mayTag(two, { author: 'a', me: 'b', value: 'z' }), 'no third');
        assert.ok(mayTag(two, { author: 'a', me: 'b', value: 'x' }), 'saying one again is fine');
        assert.equal(
            tagsLeft(two, { author: 'a', me: 'a' }),
            Infinity,
            'your own post is uncapped',
        );
        assert.ok(
            !mayTag([], { author: 'a', me: 'a', value: '\u{1F44D}' }),
            'no reaction to your own post',
        );
        assert.ok(mayTag([], { author: 'a', me: 'a', value: 'mighty' }));
        assert.ok(
            !mayTag([], { author: 'a', me: null, value: 'x' }),
            'nobody signed in says nothing',
        );
    });
});
