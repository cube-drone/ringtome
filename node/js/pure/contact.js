// The contact ledger's dials, as data: what one persona privately records about another.
// These are EDGE INPUTS to the trust layer (PROJECT_PLAN, Trust) - my direct assessment,
// stored on my private chain; the Advogato joint-flow computation consumes them later and
// nothing here pretends to be that math. Wording rule carried from doctrine: trust is
// "do I believe they're real", never "do I like them" - Interest is the liking dial.
//
// The stops are labeled points on a 0-100 scale, not an enum: the stored value is the
// NUMBER, so the scale can grow stops (or the flow engine can read finer values) without a
// migration. The 95 stop is vouch-shaped ("met in person") - when Tier 5's vouch payload
// arrives it will ride that stop as its own separate statement, fork-in-the-UI, never a
// coupling in the data.

export const TRUST_STOPS = [
    { value: 0, label: 'Never heard of them' },
    { value: 5, label: 'They might be who they say they are?' },
    { value: 20, label: 'Not very confident' },
    { value: 50, label: 'Pretty confident' },
    { value: 80, label: 'Very confident' },
    { value: 95, label: "I've met them in person - they aren't being impersonated" },
];

export const INTEREST_STOPS = [
    { value: 0, label: "Don't show" },
    { value: 25, label: 'Low priority' },
    { value: 50, label: 'Medium priority' },
    { value: 75, label: 'High priority' },
    { value: 100, label: 'Top priority' },
];

/// The private-KV collection carrying everything I record about one contact. Keys inside:
/// `trust`, `trust_public`, `interest`, `interest_rebroadcasts`, `blocked`.
export const contactCollection = (root) => `contact:${root}`;

/// A stored value snapped to its nearest stop, for rendering a select over a number that
/// may have been written by a finer-grained future (or a raw API call). Ties round up.
export function nearestStop(stops, value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return stops[0].value;
    let best = stops[0];
    for (const stop of stops) {
        if (Math.abs(stop.value - n) < Math.abs(best.value - n) ||
            (Math.abs(stop.value - n) === Math.abs(best.value - n) && stop.value > best.value)) {
            best = stop;
        }
    }
    return best.value;
}
