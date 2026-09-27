// The editor's lookout predicate - pure logic, no nodes to boot. Each scenario here is a
// field report reproduced (STYLE.md: bugs become tests before they become fixes); the raced-
// resolution case carries the exact shape from the 2026-07-25 debug dumps.
const assert = require('node:assert');

let needsReload;
before(async () => {
    ({ needsReload } = await import('../../../js/pure/lookout.js'));
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

    // Third field report (2026-09-27, Curtis, drawing: "a few seconds later, during the save, it'll
    // flash those actions briefly off and then on again"). The save lands - parents become the new
    // version - and the lookout re-judges at once, while the mirror row still shows the version
    // the save REPLACED: it reloaded, the doc cache served that older version (its row vouched
    // for it), and when the stream caught up it reloaded forward again. The row was only behind.
    it('sits still while the row still shows the version our own save replaced', () => {
        assert.equal(
            needsReload({ head: 'v1', heads: 1, diverged: false }, ['v2'], { diverged: false, heads: 1 }, ['v1']),
            false
        );
        // Two saves before the stream caught up: either replaced version is only the row lagging.
        assert.equal(
            needsReload({ head: 'v2', heads: 1, diverged: false }, ['v3'], { diverged: false, heads: 1 }, ['v1', 'v2']),
            false
        );
    });

    it('sits still after resolving a fork, while the row still shows the tangle', () => {
        assert.equal(
            needsReload({ head: 'a', heads: 2, diverged: true }, ['r'], { diverged: true, heads: 2 }, ['a', 'b']),
            false
        );
    });

    it('still reloads when something new arrives on top of a replaced version', () => {
        assert.equal(
            needsReload({ head: 'v1', heads: 2, diverged: true }, ['v2'], { diverged: false, heads: 1 }, ['v1']),
            true,
            'another computer saved on v1 too: the row is not behind, it is forked'
        );
        assert.equal(
            needsReload({ head: 'v9', heads: 1, diverged: false }, ['v2'], { diverged: false, heads: 1 }, ['v1']),
            true,
            'a head we never saw is news'
        );
    });
});

