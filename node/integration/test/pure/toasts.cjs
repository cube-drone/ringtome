// Toasts as values (plans/TOASTS.md): the stack's rules, and when an alert from the node becomes
// a toast - "one per room until you look" (Curtis, 2026-10-11) being the one with a memory.
const assert = require('node:assert');

let T;
before(async () => {
    T = await import('../../../js/pure/toasts.js');
});

const ROOM = '/ringtome/user/ada/room/0123abcd';
const OTHER_ROOM = '/ringtome/user/bea/room/4567ef01';
const BELL = '/ringtome/notifications';

describe('the toast stack', () => {
    it('adds a toast that fades after its kind’s time, an error after longer', () => {
        let s = T.addToast([], { text: 'moved to recipes' }, 1000, 1);
        s = T.addToast(s, { text: "couldn't rename it", kind: 'error' }, 1000, 2);
        assert.equal(s[0].expiresAt, 1000 + T.TOAST_MS.info);
        assert.equal(s[1].expiresAt, 1000 + T.TOAST_MS.error);
        assert.ok(T.TOAST_MS.error > T.TOAST_MS.info, 'errors stay longer');
        assert.deepEqual(
            T.liveToasts(s, 1000 + T.TOAST_MS.info).map((t) => t.id),
            [2],
            'the info has faded; the error has not',
        );
    });

    it('makes a repeat one toast, counted, with the newer words and a fresh countdown', () => {
        let s = T.addToast([], { text: 'a', key: 'room' }, 0, 1);
        s = T.addToast(s, { text: 'b', key: 'room' }, 3000, 2);
        assert.equal(s.length, 1);
        assert.equal(s[0].id, 1, 'the toast already up, not a second one');
        assert.equal(s[0].text, 'b');
        assert.equal(s[0].count, 2);
        assert.equal(s[0].expiresAt, 3000 + T.TOAST_MS.info);
    });

    it('keys an unkeyed toast by its words, so the same error twice is one error', () => {
        let s = T.addToast([], { text: 'nope', kind: 'error' }, 0, 1);
        s = T.addToast(s, { text: 'nope', kind: 'error' }, 0, 2);
        s = T.addToast(s, { text: 'nope' }, 0, 3);
        assert.deepEqual(
            s.map((t) => [t.kind, t.count]),
            [
                ['error', 2],
                ['info', 1],
            ],
            'same words, different kind: two toasts',
        );
    });

    it('holds a toast under the pointer, and restarts it in full when the pointer leaves', () => {
        let s = T.addToast([], { text: 'a' }, 0, 1);
        s = T.pauseToast(s, 1);
        assert.equal(T.liveToasts(s, 10 ** 9).length, 1, 'paused never fades');
        assert.equal(T.nextExpiry(s), null, 'and nothing to wake for');
        s = T.resumeToast(s, 1, 50000);
        assert.equal(s[0].expiresAt, 50000 + T.TOAST_MS.info);
        assert.equal(T.nextExpiry(s), 50000 + T.TOAST_MS.info);
    });

    it('wakes for the soonest countdown', () => {
        let s = T.addToast([], { text: 'e', kind: 'error' }, 0, 1);
        s = T.addToast(s, { text: 'i' }, 0, 2);
        assert.equal(T.nextExpiry(s), T.TOAST_MS.info);
        assert.equal(T.nextExpiry([]), null);
    });

    it('dismisses one and leaves the rest', () => {
        let s = T.addToast([], { text: 'a' }, 0, 1);
        s = T.addToast(s, { text: 'b' }, 0, 2);
        assert.deepEqual(
            T.dismissToast(s, 1).map((t) => t.id),
            [2],
        );
    });

    it('never holds more than the cap, nor two toasts with one key, whatever arrives', () => {
        // An invariant over many random sequences, not an example: the cap pushes out the oldest,
        // and a repeat merges, in any order.
        let seed = 7;
        const rand = (n) => {
            seed = (seed * 1103515245 + 12345) % 2 ** 31;
            return seed % n;
        };
        for (let run = 0; run < 200; run++) {
            let s = [];
            for (let step = 0; step < 30; step++) {
                s = T.addToast(
                    s,
                    { text: `t${rand(6)}`, kind: rand(2) ? 'info' : 'error' },
                    step * 100,
                    run * 100 + step,
                );
                assert.ok(s.length <= T.MAX_TOASTS, `at most ${T.MAX_TOASTS}`);
                const keys = s.map((t) => t.key);
                assert.equal(new Set(keys).size, keys.length, 'one toast per key');
            }
        }
    });

    it('pushes out the oldest past the cap', () => {
        let s = [];
        for (let i = 1; i <= T.MAX_TOASTS + 1; i++) s = T.addToast(s, { text: `t${i}` }, 0, i);
        assert.deepEqual(
            s.map((t) => t.id),
            [2, 3, 4],
        );
    });
});

describe('alerts from the node: when a toast is raised', () => {
    const decide = (
        route,
        { path = '/ringtome/notes', hidden = false, quiet = new Set(), upKeys = [] } = {},
    ) => T.alertDecision({ route, path, hidden, quiet, upKeys });

    it('raises nothing while the page is hidden - the badge and the OS have it', () => {
        assert.equal(decide(ROOM, { hidden: true }).show, false);
        assert.equal(decide(BELL, { hidden: true }).show, false);
    });

    it('raises nothing where you already are: the room, a line in it, or the bell', () => {
        assert.equal(decide(ROOM, { path: ROOM }).show, false);
        assert.equal(decide(ROOM, { path: `${ROOM}/line/12` }).show, false);
        assert.equal(decide(BELL, { path: BELL }).show, false);
        assert.equal(decide(ROOM, { path: OTHER_ROOM }).show, true, 'another room is elsewhere');
    });

    it('lets a room speak once until you look, and updates its toast while it is up', () => {
        let quiet = new Set();
        let d = decide(ROOM, { quiet });
        assert.equal(d.show, true, 'the first line');
        quiet = d.quiet;
        d = decide(ROOM, { quiet, upKeys: [ROOM] });
        assert.equal(d.show, true, 'the second, while its toast is up: an update');
        d = decide(ROOM, { quiet, upKeys: [] });
        assert.equal(d.show, false, 'the third, after its toast has gone: quiet');
        assert.equal(decide(OTHER_ROOM, { quiet }).show, true, 'one per room, not one in all');
        quiet = T.visitedRoute(quiet, `${ROOM}/line/3`);
        assert.equal(decide(ROOM, { quiet }).show, true, 'you were in it: it may speak again');
    });

    it('never quietens the bell - its rows are separate events', () => {
        let quiet = new Set();
        for (let i = 0; i < 3; i++) {
            const d = decide(BELL, { quiet });
            assert.equal(d.show, true);
            quiet = d.quiet;
        }
        assert.equal(quiet.size, 0);
    });

    it('knows a room address from the bell’s, as attention.rs words them', () => {
        assert.ok(T.isRoomRoute(ROOM));
        assert.ok(!T.isRoomRoute(BELL));
        assert.ok(!T.isRoomRoute(`${ROOM}/line/3`));
    });

    it('leaves the quiet set alone when the visit is elsewhere', () => {
        const quiet = new Set([ROOM]);
        assert.equal(T.visitedRoute(quiet, '/ringtome/notes'), quiet, 'the same set, unchanged');
    });
});
