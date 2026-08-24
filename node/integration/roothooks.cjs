/*
    Mocha root hooks for the whole integration suite (wired in .mocharc.cjs's `require`).

    One job today: no test may leave a rig node unplugged. `test/unplug.cjs` makes a node refuse its
    peers, and its own `finally` handles the ordinary path - but the case that actually poisons a run
    is a spec that DIES mid-partition (a throw before the finally, a mocha timeout, an interrupt).
    Every later spec then fails on a network that isn't there, pointing the diagnosis at innocent
    files. This hook is the backstop that makes that unrepresentable.

    It lives OUTSIDE `test/` on purpose: `.mocharc.cjs`'s spec glob covers everything under
    `test/`, and a root hook plugin sitting in there would be loaded twice - once as a spec, once
    as a plugin.

    Free when unused: `replugTouched` returns immediately unless something in this process actually
    unplugged a node, so the ~600 tests that never touch the gate pay one function call each.
*/
const { replugTouched } = require("./test/unplug.cjs");
const { HOST, HOST_B, HOST_C, HOST_DARK, HOST_E } = require("./test/fetch.cjs");

// Second job (2026-08-24): stamp each test's title into every rig node's log (`/test/mark`)
// as it starts, so the logs carry the suite's clock. The residual-tail dig spent its longest
// stretches mis-assigning log windows to tests - fourteen share POSTs where "the test" made
// three, because a dozen NEIGHBORING tests' choreographies are indistinguishable in an
// unmarked stream. Fire-and-forget with a short fuse: a slow or dark node must cost the
// test nothing, and the unplug gate never blocks HTTP, so marks land even mid-partition.
const markAll = (note) => {
    const hosts = [HOST, HOST_B, HOST_C, HOST_DARK, HOST_E].filter(Boolean);
    return Promise.allSettled(
        hosts.map((h) =>
            fetch(`http://${h}/test/mark`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ note }),
                signal: AbortSignal.timeout(500),
            }).catch(() => {})
        )
    );
};

exports.mochaHooks = {
    async beforeEach() {
        await markAll(`START ${this.currentTest.fullTitle()}`);
    },
    async afterEach() {
        await markAll(
            `END(${this.currentTest.state || "unknown"}) ${this.currentTest.fullTitle()}`
        );
        await replugTouched();
    },
    // The interrupt/bail path: afterEach doesn't run when mocha is killed between tests.
    async afterAll() {
        await replugTouched();
    },
};
