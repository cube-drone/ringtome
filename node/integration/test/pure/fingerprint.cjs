// The read-your-cache freshness stamps. These two functions ARE the contract: a cached doc body
// or expanded tree is served only while its stamp still matches the streamed rows that vouch for
// it, so a stamp that fails to move means serving something stale, and a stamp that moves when
// nothing changed means a pointless refetch. Both are one-liners, which is precisely why nobody
// looked at them closely - the roster collision below survived until these vectors were written.
const assert = require('node:assert');

let docFingerprint, rosterFingerprint;
before(async () => {
    ({ docFingerprint, rosterFingerprint } = await import('../../../js/mirror/doccache.js'));
});

describe('doc fingerprint', () => {
    const row = { head: 'v7', heads: 1, diverged: false };

    it('is stable for an unchanged row', () => {
        assert.equal(docFingerprint(row), docFingerprint({ ...row }));
    });

    it('moves when the display head moves', () => {
        assert.notEqual(docFingerprint(row), docFingerprint({ ...row, head: 'v8' }));
    });

    it('moves when the head COUNT changes though the display head does not', () => {
        // The divergence case the lookout was twice blind to: same display pick, new fork.
        assert.notEqual(docFingerprint(row), docFingerprint({ ...row, heads: 2 }));
    });

    it('moves when the diverged flag flips', () => {
        assert.notEqual(docFingerprint(row), docFingerprint({ ...row, diverged: true }));
    });

    it('is null for no row at all (nothing vouches, so nothing is served)', () => {
        assert.equal(docFingerprint(null), null);
        assert.equal(docFingerprint(undefined), null);
    });
});

describe('roster fingerprint', () => {
    const roster = [
        { taxonomy_id: 't1', title: 'Recipes', members: 3 },
        { taxonomy_id: 't2', title: 'Desserts', members: 0 },
    ];

    it('is stable for an unchanged roster', () => {
        assert.equal(rosterFingerprint(roster), rosterFingerprint(roster.map((t) => ({ ...t }))));
    });

    it('moves on a member count, a title, an id, an addition, or a removal', () => {
        const base = rosterFingerprint(roster);
        assert.notEqual(base, rosterFingerprint([{ ...roster[0], members: 4 }, roster[1]]));
        assert.notEqual(base, rosterFingerprint([{ ...roster[0], title: 'Recipes!' }, roster[1]]));
        assert.notEqual(base, rosterFingerprint([{ ...roster[0], taxonomy_id: 't9' }, roster[1]]));
        assert.notEqual(base, rosterFingerprint([...roster, { taxonomy_id: 't3', title: 'x', members: 1 }]));
        assert.notEqual(base, rosterFingerprint([roster[0]]));
    });

    it('is order-sensitive (the stream delivers a stable order; a reorder is a change)', () => {
        assert.notEqual(rosterFingerprint(roster), rosterFingerprint([roster[1], roster[0]]));
    });

    it('is empty-safe', () => {
        assert.equal(rosterFingerprint([]), rosterFingerprint([]));
        assert.equal(rosterFingerprint(undefined), rosterFingerprint([]));
    });

    // The regression that prompted this file (2026-07-29). The stamp used to be
    // `id:title:members` joined on ',' - both separators legal inside a user-chosen TITLE - so a
    // section could be named such that one roster's stamp was byte-identical to another's, and a
    // cached tree got served as fresh while the real roster had moved underneath it.
    it('cannot be forged by a title containing its separators', () => {
        const forged = [{ taxonomy_id: 't1', title: 'notes:2,t2:more', members: 0 }];
        const real = [
            { taxonomy_id: 't1', title: 'notes', members: 2 },
            { taxonomy_id: 't2', title: 'more', members: 0 },
        ];
        assert.notEqual(rosterFingerprint(forged), rosterFingerprint(real));
    });

    it('survives quotes and backslashes in a title', () => {
        const a = [{ taxonomy_id: 't1', title: 'say "hi"', members: 1 }];
        const b = [{ taxonomy_id: 't1', title: 'say \\"hi\\"', members: 1 }];
        assert.notEqual(rosterFingerprint(a), rosterFingerprint(b));
    });
});
