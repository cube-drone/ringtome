// Removal-flow facts, pure over the keys list `GET /keys` returns (rank_path arrays, in
// responsibility order). Authority is never derived here - the server sends each key's
// `removal` capability and the revoke route re-checks on POST; this module only SHOWS
// consequences, because the UI owes the user the blast radius before they press the button
// (PROJECT_PLAN, Groups: the invite tree, and what a repudiation blows up).

/// The keys that go down with a locked-out computer: its ACTIVE proper descendants - every
/// working key whose rank path extends the target's. A hostile key's grants can be backdated,
/// so the subtree goes down with the ship; having-it-leave (retirement) spares the subtree,
/// so callers only ask this for lock-outs. Already-revoked descendants aren't listed: they
/// were down before the ship was.
export function blastRadius(keys, rankPath) {
    return keys.filter(
        (k) =>
            k.status === 'active' &&
            k.rank_path.length > rankPath.length &&
            rankPath.every((r, i) => k.rank_path[i] === r)
    );
}
