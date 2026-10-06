// A chat line's lean (Curtis, 2026-09-28, "silly is how I operate"): 2.5% bigger for every positive
// reaction stacked on it and 2.5% smaller for every negative one - the reaction picker's rows
// (emoji.js POLE_ROWS). Held between half and double, so a pile-on can neither erase a line
// nor let it swallow the room.

/// How much bigger or smaller each positive or negative reaction makes a line.
export const LEAN_STEP = 0.025;
export const LEAN_MIN = 0.5;
export const LEAN_MAX = 2;

/// A line's size factor from its reactions' leans: `positive` and `negative` are how many of each.
export function leanScale(positive, negative) {
    const scale = 1 + LEAN_STEP * ((positive || 0) - (negative || 0));
    return Math.min(LEAN_MAX, Math.max(LEAN_MIN, Math.round(scale * 1000) / 1000));
}
