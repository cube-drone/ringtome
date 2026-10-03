// The lookout's judgment, as a pure function - because it has now been field-tested wrong
// twice, and a predicate that keeps earning bug reports earns a module mocha can interrogate
// without a browser.
//
// History of the signal (each clause a scar):
// - "did the display head move" alone was blind: the display head for a diverged doc is one
//   deterministic pick among the logical heads, so the device whose save happened to BE that
//   pick never noticed the fork (field report, 2026-07-25 morning).
// - head + head count + diverged flag was STILL blind to raced resolutions: two devices each
//   resolve the same fork, producing a fresh two-head fork whose display pick is one racer's
//   own save. That racer sees head ∈ parents, heads still 2, diverged still true - every
//   watched scalar identical to the tangle it just resolved - and sits oblivious while the
//   other browser shows the new conflict (field report, 2026-07-25 evening, matching debug
//   dumps from both nodes). The head SET rotated; no scalar did.
//
// The cure for the second scar: an editor that believes it is linear (exactly one parent -
// the fast-forwarded result of its own save) while the row says diverged has, definitionally,
// not yet presented that divergence - reload. After the reload, save_parents is every logical
// head (length ≥ 2), so the clause cannot re-fire: no loop.

// - the third scar ran the other way: reloading when nothing was new (field report, 2026-09-27,
//   a drawing flashing its last strokes off and on "during the save"). A save lands, the parents
//   become its version, and the lookout re-judges at once - while the mirror row still shows the
//   version the save REPLACED, because the stream has not caught up. That head is not in the
//   parents, so it reloaded; the doc cache served the older version (the stale row vouched for
//   it), and the stream's catch-up reloaded forward again. A row whose head is a version this
//   editor itself saved over, and whose shape is the one it loaded, is only behind - `replaced`.
//   Anything more (a second head, a fork, a head never seen) is still news.

/**
 * Should a clean editor reload from the node?
 *
 * @param row      this doc's live-mirror row: { head, heads, diverged }
 * @param parents  the save-machine's parents - what the editor will assert on its next save
 * @param seen     the row-shape at last load: { diverged, heads }
 * @param replaced every version this editor's own saves have replaced since that load
 */
export function needsReload(row, parents, seen, replaced = []) {
    const behind =
        replaced.includes(row.head) && row.heads === seen.heads && row.diverged === seen.diverged;
    if (behind) return false;
    return (
        !parents.includes(row.head) ||
        row.diverged !== seen.diverged ||
        row.heads !== seen.heads ||
        // The raced-resolution clause: linear-in-here, diverged-out-there means the fork
        // in the row is one this buffer has never presented.
        (parents.length === 1 && row.diverged)
    );
}
