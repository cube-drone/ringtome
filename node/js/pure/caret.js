// Keeping the caret where it belongs while the text changes from outside the editor (Curtis,
// 2026-09-27: after an image goes in, the caret lands right after it). Value in, value out.

/// The smallest change taking `was` to `now`: the stretch between what they share at the start and
/// at the end, as `{ from, to, insert }` against `was` - how an outside edit goes into an editor
/// that keeps its caret, scroll and undo through changes (doc/livemarquee.js).
export function smallestChange(was, now) {
    let from = 0;
    while (from < was.length && from < now.length && was[from] === now[from]) from++;
    let end = 0;
    while (
        end < was.length - from &&
        end < now.length - from &&
        was[was.length - 1 - end] === now[now.length - 1 - end]
    )
        end++;
    return { from, to: was.length - end, insert: now.slice(from, now.length - end) };
}

/// Where a caret goes when the stretch at `at`, `oldLength` long, becomes `newLength` long (an
/// upload's placeholder swapped for its image): before it, it stays; inside or just after it, it
/// goes to just after the new text; further on, it moves by the difference.
export function caretThroughSwap(caret, at, oldLength, newLength) {
    if (caret <= at) return caret;
    if (caret <= at + oldLength) return at + newLength;
    return caret + newLength - oldLength;
}
