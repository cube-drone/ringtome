// The kept answers' one judgement (mirror/keep.js): whether a stranger's kept profile is fresh
// enough to stand without asking the node again. Pure, so its edges are tested.

/// How long a stranger's kept profile stands unasked. A name, a face or a banner changes rarely
/// (Curtis, 2026-11-22: "these details change, but rarely" - an hour until then); the heartbeat's
/// "active today" is a date, and six hours' lag can say yesterday's for part of a day.
export const PROFILE_FRESH_MS = 6 * 60 * 60 * 1000;

/// Is this kept profile (`{ at }`, from keptStranger) still fresh at `now`? A clock that has gone
/// backwards since it was kept says no - asked again rather than trusted for longer.
export const profileFresh = (kept, now) =>
    !!kept && typeof kept.at === 'number' && kept.at <= now && now - kept.at < PROFILE_FRESH_MS;
