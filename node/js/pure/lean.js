// A chat line's lean (Curtis, 2026-09-28, "silly is how I operate"): 2.5% bigger for every glad
// reaction stacked on it and 2.5% smaller for every sour one - the reaction picker's rows
// (emoji.js POLE_ROWS). Held between half and double, so a pile-on can neither erase a line
// nor let it swallow the room.

/// How much bigger or smaller each glad or sour reaction makes a line.
export const LEAN_STEP = 0.025;
export const LEAN_MIN = 0.5;
export const LEAN_MAX = 2;

/// A line's size factor from its reactions' leans: `glad` and `sour` are how many of each.
export function leanScale(glad, sour) {
    const scale = 1 + LEAN_STEP * ((glad || 0) - (sour || 0));
    return Math.min(LEAN_MAX, Math.max(LEAN_MIN, Math.round(scale * 1000) / 1000));
}
