// The sync page's judgements (pure/syncstatus.js; plans/SYNC_STATUS.md, piece 4).
const assert = require('node:assert');

let computerState, gapOf;
before(async () => {
    ({ computerState, gapOf } = await import('../../../js/pure/syncstatus.js'));
});

describe("a computer's sync state", () => {
    it('syncing now wins over everything, pulling over serving, with what moved', () => {
        const c = { endpoint: 'e', reached_ms: 5, error: 'old' };
        const running = [
            { peer: 'e', way: 'serve', moved: 0, since_ms: 20 },
            { peer: 'e', way: 'pull', moved: 7, since_ms: 10 },
            { peer: 'other', way: 'pull', moved: 99, since_ms: 1 },
        ];
        assert.deepEqual(computerState(c, running), { kind: 'pulling', moved: 7, since: 10 });
    });

    it('a failure newer than the last reach is failing; an older one is history', () => {
        assert.equal(
            computerState({ endpoint: 'e', error: 'no address', tried_ms: 9, reached_ms: 5 }).kind,
            'failing',
        );
        assert.equal(
            computerState({ endpoint: 'e', error: 'no address', tried_ms: 9 }).kind,
            'failing',
        );
        assert.equal(computerState({ endpoint: 'e', reached_ms: 9, moved: 3 }).kind, 'reached');
    });

    it('a computer this one has never reached says so; a sync before this run counts as reached', () => {
        assert.deepEqual(computerState({ endpoint: 'e' }), { kind: 'never' });
        assert.equal(computerState({ endpoint: 'e', last_synced_ms: 4 }).kind, 'reached');
    });
});

describe('how far apart two computers are', () => {
    it('says nothing when they match or nothing is known, both ways otherwise', () => {
        assert.equal(gapOf({}), null);
        assert.equal(gapOf({ theirs_ahead: 0, ours_ahead: 0 }), null);
        assert.deepEqual(gapOf({ theirs_ahead: 8560, ours_ahead: 0 }), { theirs: 8560, ours: 0 });
    });
});
