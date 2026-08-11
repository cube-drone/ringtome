/*
    The transport gate, from the test side: make a node unreachable to its peers without killing it.

    The rig's four nodes are shared by every spec in this suite, so a test that wants "A and B are
    unreachable" cannot stop them - the next forty files need them up. `/test/unplug` (mounted only
    in local-test mode; see node/src/net/p2p.rs for the design and the safety argument) makes a node
    refuse iroh connections while its HTTP surface stays perfectly healthy, so a partition is a
    fetch call and a `finally` rather than a process lifecycle.

    Use `withUnplugged`, essentially always:

        await withUnplugged([HOST_B, HOST_C], async () => {
            // B and C are dead to the network here, and to each other
            assert.ok(await stillReadableOnA());
        });                                        // ...and plugged back in, even if that threw

    The direct pair is there for tests that need the partition to outlive one block:

        await unplug(HOST_B);                      // everything, both directions
        await unplug(HOST_B, { alpns: ["blob"] }); // just body transfer; sync still runs
        await unplug(HOST_B, { direction: "inbound" });  // an ASYMMETRIC partition, on purpose
        await plugIn(HOST_B);

    WHY THE BOOKKEEPING BELOW. The failure mode worth engineering against is not a test that forgets
    to plug a node back in - it is a test that DIES while a node is unplugged (a throw, a timeout, a
    Ctrl-C). Everything after it then fails for a reason that has nothing to do with what it was
    testing, and the diagnosis points at the wrong file. So: this module remembers every host it has
    touched, and `../roothooks.cjs` re-plugs them after every test. Belt (the `finally` inside
    `withUnplugged`) and braces (the root hook), because the braces are what survive a hang.
*/
const { makeFetch } = require("./fetch.cjs");

// Hosts this process has unplugged and not yet demonstrably re-plugged. The root hook drains it;
// it stays empty for the whole suite except while a partition test is actually running, which is
// what keeps the hook free for the other 600 tests.
const touched = new Set();

/*
    Refuse connections on `host`.

    Options (all optional; the bare call is "unplug this node entirely"):
      alpns     - array of protocol names to refuse: sync, blob, adopt, deliver, fragment.
                  Omitted means all of them. An unknown name is a 400, deliberately - a typo that
                  silently refused nothing would make a test pass while proving nothing.
      direction - "both" (default), "inbound", or "outbound". One direction is an asymmetric
                  partition: worth testing, and never what you want by accident.

    Returns what the node is now refusing, `{ inbound: [...], outbound: [...] }` - assert on it if
    the partition is load-bearing enough to be worth pinning.
*/
async function unplug(host, opts = {}) {
    const body = {};
    if (opts.alpns) body.alpns = opts.alpns;
    if (opts.direction) body.direction = opts.direction;

    const resp = await makeFetch(host)("test/unplug", {
        method: "POST",
        body: JSON.stringify(body),
    });
    if (resp.status !== 200) {
        throw new Error(
            `unplug(${host}) returned ${resp.status}: ${await resp.text()} ` +
                `(is the node armed with RINGTOME_LOCAL_TEST?)`
        );
    }
    // Recorded BEFORE anything else can throw, so a node is never unplugged unremembered.
    touched.add(host);
    return resp.json();
}

// Plug `host` back in: refuse nothing. Idempotent, and fine on a node that was never unplugged.
async function plugIn(host) {
    const resp = await makeFetch(host)("test/plug-in", { method: "POST" });
    if (resp.status !== 200) {
        throw new Error(`plugIn(${host}) returned ${resp.status}: ${await resp.text()}`);
    }
    touched.delete(host);
    return resp.json();
}

// What `host` is refusing right now, without changing it.
async function refusals(host) {
    const resp = await makeFetch(host)("test/unplug");
    if (resp.status !== 200) {
        throw new Error(`refusals(${host}) returned ${resp.status}: ${await resp.text()}`);
    }
    return resp.json();
}

/*
    Run `fn` with every host in `hosts` unplugged, and plug them all back in afterwards - including
    when `fn` throws, which is the entire point of the shape. Returns whatever `fn` returns.

    `opts` is passed to `unplug` for every host, so a whole partition can be one protocol wide.
*/
async function withUnplugged(hosts, fn, opts = {}) {
    const list = (Array.isArray(hosts) ? hosts : [hosts]).filter(Boolean);
    for (const host of list) await unplug(host, opts);
    try {
        return await fn();
    } finally {
        // Every host gets its own attempt: one node refusing to re-plug must not leave the rest
        // unplugged behind it. The root hook is still holding the receipts either way.
        for (const host of list) {
            try {
                await plugIn(host);
            } catch (e) {
                console.error(`withUnplugged: could not re-plug ${host}: ${e.message}`);
            }
        }
    }
}

/*
    Re-plug every host this process unplugged. Called by the root hook after each test, and cheap to
    the point of free when nothing was unplugged - which is the normal state of the suite.

    Never throws: it runs in an afterEach, where throwing would replace a real failure with this
    one. A host that cannot be re-plugged stays on the list so the next hook tries again, and says
    so on stderr, because a rig stuck unplugged needs to be loud.
*/
async function replugTouched() {
    if (touched.size === 0) return;
    for (const host of [...touched]) {
        try {
            await plugIn(host);
        } catch (e) {
            console.error(`replugTouched: ${host} is still unplugged: ${e.message}`);
        }
    }
}

module.exports = { unplug, plugIn, refusals, withUnplugged, replugTouched };
