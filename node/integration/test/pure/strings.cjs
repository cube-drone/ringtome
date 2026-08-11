// The string tool's scanners, on fixtures - the cop for the cop.
//
// `tools/strings.mjs` is the mechanism that makes it impossible to add user-facing words
// silently, so a hole in ITS scanner is worse than an ordinary bug: nothing downstream notices,
// and the phrase ships unlocalizable while `strings-check` reports green. That has now happened
// twice, both times to the same class of message and for the same underlying reason - a pattern
// that stopped matching where the source wrapped.
//
//   round one: a pattern anchored without the trailing comma rustfmt leaves behind, which "silently
//              skips exactly the longest and most user-visible messages" (its own comment).
//   round two: `\bmsg!\(..."..."...\)` without the `s` flag, so a literal continued across two
//              lines with a trailing backslash never matched. Six real phrases were missing from
//              the catalog when this test was written, and nobody had noticed.
//
// Both rounds share a shape: long messages get wrapped, wrapped messages stop matching, and the
// failure is invisible because the extractor's job is to find things and finding nothing looks
// exactly like there being nothing. So the fixtures below are all WRAPPED forms.
const assert = require('node:assert');
const path = require('node:path');

const TOOL = path.join(__dirname, '..', '..', '..', 'tools', 'strings.mjs');

// The tool guards its own entry point, so importing it runs no side effects. That guard is part
// of what this file tests: if it regresses, loading the module here rewrites the real catalog.
const tool = () => import(TOOL);

describe('the string tool finds messages however the source wrapped them', function () {
    it('reads a literal continued across lines, the way Rust reads it', async () => {
        const { rustMessages } = await tool();
        // Exactly the shape that shipped unlocalizable: a long sentence wrapped with a trailing
        // backslash, which Rust joins by eating the newline AND the next line's indentation.
        const src = [
            'crate::msg!(',
            '    "record.bake.over-budget",',
            '    "this post\'s media adds up to {total} - one post may carry {cap}. Split it across \\',
            '     several posts.",',
            '    total = a, cap = b',
            ')',
        ].join('\n');

        const found = rustMessages(src);
        assert.equal(found.length, 1, 'a wrapped message is still a message');
        assert.equal(found[0].key, 'record.bake.over-budget');
        assert.equal(
            found[0].english,
            "this post's media adds up to {total} - one post may carry {cap}. Split it across several posts.",
            'the continuation joins with ONE space - the newline and the indent both go',
        );
    });

    it('still reads the ordinary one-line form', async () => {
        const { rustMessages } = await tool();
        const found = rustMessages('crate::msg!("a.key", "plain words")');
        assert.deepEqual(
            found.map((m) => [m.key, m.english]),
            [['a.key', 'plain words']],
        );
    });

    it('reports a span that rewrites the seed it actually matched', async () => {
        const { rustMessages } = await tool();
        // `syncSeeds` rewrites source in place using these offsets, so a span that drifts would
        // corrupt files rather than merely miss a phrase - the worse failure of the two.
        const src = 'msg!("k", "wrapped \\\n    words")';
        const [m] = rustMessages(src);
        assert.equal(
            src.slice(m.seedStart, m.seedEnd),
            '"wrapped \\\n    words"',
            'the span covers the literal, quotes included',
        );
    });

    it('unescapes quotes and backslashes without eating the continuation rule', async () => {
        const { unescapeRust } = await tool();
        assert.equal(unescapeRust('say \\"hi\\"'), 'say "hi"');
        assert.equal(unescapeRust('a \\\\ b'), 'a \\ b');
        assert.equal(unescapeRust('one \\\n        two'), 'one two');
        assert.equal(
            unescapeRust('trailing space kept \\\n   after'),
            'trailing space kept after',
            'the space before the backslash is the author\'s, and survives',
        );
    });

    it('gives one phrase used twice a single catalog entry', async () => {
        const { collect, renderEnglish } = await tool();
        // Two call sites, same words, same file: one phrase with one translation, which is the
        // whole point of a key. Emitting it per call site produced a duplicate object literal
        // key - an esbuild warning and an eslint error - and neither said what to do about it.
        const entries = [
            { file: 'a.js', line: 1, key: 'a.someone', english: 'someone' },
            { file: 'a.js', line: 9, key: 'a.someone', english: 'someone' },
            { file: 'a.js', line: 12, key: 'a.other', english: 'other' },
        ];
        const rendered = renderEnglish(entries, {});
        const hits = rendered.split('\n').filter((l) => l.includes("'a.someone'"));
        assert.equal(hits.length, 1, 'one key, one line');
        assert.ok(rendered.includes('2 phrases'), 'and the count is of keys, not call sites');
        assert.ok(collect, 'collect is exported for the check path');
    });

    it('finds every message in a file that mixes both forms', async () => {
        const { rustMessages } = await tool();
        const src = [
            'msg!("a.one", "first")',
            'msg!(',
            '    "a.two",',
            '    "second, at some length, wrapped \\',
            '     over a line"',
            ')',
            'msg!("a.three", "third")',
        ].join('\n');
        assert.deepEqual(
            rustMessages(src).map((m) => m.key),
            ['a.one', 'a.two', 'a.three'],
            'a wrapped message in the middle must not swallow its neighbours',
        );
    });
});
