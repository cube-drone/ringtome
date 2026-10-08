// What the sync page says about each of a persona's other computers (plans/SYNC_STATUS.md, piece
// 4), decided from the node's sync ledger (`GET /api/identity/{root}/sync/status`). Pure, so the
// cases are tested: the words themselves are the page's.

/// One computer's state, in the order a person asks about it: is it stuck, is it syncing now, did
/// the last try reach it, did it fail, or has this computer never reached it at all. Stuck comes
/// first (piece 7): a stuck pair is usually busy - exchanging, and getting nowhere - and "syncing
/// now" would hide exactly what the person needs to know.
/// `computer`: the status route's row (`stuck`, `exchanges`, `reached_ms`, `tried_ms`, `error`,
/// `last_synced_ms`);
/// `running`: the route's running exchanges with this computer.
export function computerState(computer, running = []) {
    if (computer.stuck) return { kind: 'stuck', tries: (computer.exchanges || []).length };
    const mine = running.filter((r) => r.peer === computer.endpoint);
    if (mine.length) {
        const pulling = mine.some((r) => r.way === 'pull');
        return {
            kind: pulling ? 'pulling' : 'serving',
            moved: mine.reduce((n, r) => n + (r.moved || 0), 0),
            since: Math.min(...mine.map((r) => r.since_ms)),
        };
    }
    const reached = computer.reached_ms || computer.last_synced_ms || null;
    if (
        computer.error &&
        (!computer.reached_ms || (computer.tried_ms || 0) > computer.reached_ms)
    ) {
        return { kind: 'failing', error: computer.error, reached };
    }
    if (reached) return { kind: 'reached', reached, moved: computer.moved || 0 };
    return { kind: 'never' };
}

/// How far apart this computer and that one were at the last whole exchange, when either side had
/// anything the other didn't: `{ theirs, ours }`, or null when they matched (or nothing's known).
export function gapOf(computer) {
    const theirs = computer.theirs_ahead;
    const ours = computer.ours_ahead;
    if (typeof theirs !== 'number' || typeof ours !== 'number') return null;
    if (theirs === 0 && ours === 0) return null;
    return { theirs, ours };
}
