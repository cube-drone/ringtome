// The feed-selectivity slider's brain (PROJECT_PLAN: "Feed selectivity: one slider, two
// budgets", designed 2026-08-15; DISCOVERY slice 3) - pure: rows and dial facts in, a
// show/hide verdict out. The slider is ATTENTION only: everything here runs at read time
// over rows already journaled, moving it is network-silent in both directions, and nothing
// about it ever changes what syncs.
//
// Every row carries one EFFECTIVE interest with a defined provenance precedence: the
// reader's explicit dial on the AUTHOR; else their rebroadcast dial on the SHARER (asking
// for a sharer's taste is an explicit signal about the row); else the derived path score
// (`suggested_level`, the demand rollup's discounted band); else the floor pool that
// admitted it. The precedence doubles as the answer to "why am I seeing this?".

import { bandOrdinal } from './contact.js';

/// The six stops, widest first - the titles are Curtis's design, verbatim, worn by the
/// slider as it moves. The bottom pools light up as they land: today one speculative pool
/// exists (depth-2, DISCOVERY slices 1-2), so 'highly-speculative' and 'explorer' differ
/// from 'speculative' only by path strength until the deeper pools arrive.
export const SELECTIVITY_STOPS = [
    { key: 'explorer', label: 'Explorer' },
    { key: 'highly-speculative', label: 'highly speculative' },
    { key: 'speculative', label: 'speculative' },
    { key: 'interest', label: 'interest only' },
    { key: 'medium', label: 'medium interest only' },
    { key: 'high', label: 'high interest only' },
];

/// New users default to the widest floor: a new user's explicit-interest feed is empty by
/// definition, and defaulting wide is refusing to show them an empty room when the node
/// knows about furniture.
export const DEFAULT_STOP = 'explorer';

/// One row's effective interest: `{kind, band}`, the precedence above. `factsByRoot` maps a
/// root to the reader's dial facts for them (the contacts mirror's shape). An unset dial is
/// no opinion and falls through - silence and 'none' stay distinct (the 2026-08-08 lesson).
export function effectiveInterest(item, factsByRoot) {
    const dial = (root, key) => {
        const facts = (root && factsByRoot && factsByRoot[root]) || null;
        const band = facts && facts[key];
        return bandOrdinal(band) === null ? null : band;
    };
    const author = dial(item.author, 'interest');
    if (author !== null) return { kind: 'author-dial', band: author };
    const sharer = dial(item.via, 'interest_rebroadcasts');
    if (sharer !== null) return { kind: 'sharer-dial', band: sharer };
    if (item.suggested_via) return { kind: 'path', band: item.suggested_level || null };
    return { kind: 'floor', band: null };
}

/// Does this row clear the slider's current stop? The strict stops want an EXPLICIT dial at
/// height; 'interest' is every real row (a follow or a share is itself an explicit act);
/// the speculative stops admit marked rows by path strength; Explorer admits everything the
/// node can honestly surface.
export function visibleAt(stopKey, item, factsByRoot) {
    const eff = effectiveInterest(item, factsByRoot);
    const explicit = eff.kind === 'author-dial' || eff.kind === 'sharer-dial';
    const ord = bandOrdinal(eff.band);
    switch (stopKey) {
        case 'high':
            return explicit && ord !== null && ord >= 3;
        case 'medium':
            return explicit && ord !== null && ord >= 2;
        case 'interest':
            return !item.suggested_via;
        case 'speculative':
            return !item.suggested_via || (ord !== null && ord >= 3);
        case 'highly-speculative':
        case 'explorer':
        default:
            return true;
    }
}
