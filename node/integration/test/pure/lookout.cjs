// The editor's lookout predicate - pure logic, no nodes to boot. Each scenario here is a
// field report reproduced (STYLE.md: bugs become tests before they become fixes); the raced-
// resolution case carries the exact shape from the 2026-07-25 debug dumps.
const assert = require('node:assert');

let needsReload;
before(async () => {
    ({ needsReload } = await import('../../../js/lookout.js'));
});

describe('editor lookout', () => {
    it('sits still when nothing changed', () => {
        assert.equal(
            needsReload({ head: 'v1', heads: 1, diverged: false }, ['v1'], {
                diverged: false,
                heads: 1,
            }),
            false
        );
    });

    it('reloads on a fast-forward (someone else saved, head moved)', () => {
        assert.equal(
            needsReload({ head: 'v2', heads: 1, diverged: false }, ['v1'], {
                diverged: false,
                heads: 1,
            }),
            true
        );
    });

    it('reloads when a fork appears even if our save is the display pick', () => {
        // First field report: the device whose save IS the deterministic pick still needs
        // to hear that a second head exists.
        assert.equal(
            needsReload({ head: 'mine', heads: 2, diverged: true }, ['mine'], {
                diverged: false,
                heads: 1,
            }),
            true
        );
    });

    it('reloads on a raced resolution (the 2026-07-25 dumps)', () => {
        // Both devices resolved the 810de/0afd fork; second-brain's save 11d72b won the
        // display pick of the NEW fork. Its editor: parents = [own save], row = own save +
        // 2 heads + diverged, seen = the tangle it loaded (diverged, 2 heads). Every scalar
        // matches what it already saw - only "I think I'm linear, the row says diverged"
        // catches it.
        assert.equal(
            needsReload({ head: '11d72b', heads: 2, diverged: true }, ['11d72b'], {
                diverged: true,
                heads: 2,
            }),
            true
        );
    });

    it('does not loop after presenting the raced conflict', () => {
        // After the reload, save_parents is every logical head - the editor now KNOWS it is
        // diverged, and the same row must not re-trigger.
        assert.equal(
            needsReload(
                { head: '11d72b', heads: 2, diverged: true },
                ['11d72b', '37e284'],
                { diverged: true, heads: 2 }
            ),
            false
        );
    });

    it('stays out of the way while a presented tangle awaits its human', () => {
        // Loaded a diverged doc (parents = both heads, seen diverged) - no reload churn
        // while the user reads it.
        assert.equal(
            needsReload({ head: 'a', heads: 2, diverged: true }, ['a', 'b'], {
                diverged: true,
                heads: 2,
            }),
            false
        );
    });
});
