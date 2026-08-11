/*
    Mocha root hooks for the whole integration suite (wired in .mocharc.json's `require`).

    One job today: no test may leave a rig node unplugged. `test/unplug.cjs` makes a node refuse its
    peers, and its own `finally` handles the ordinary path - but the case that actually poisons a run
    is a spec that DIES mid-partition (a throw before the finally, a mocha timeout, an interrupt).
    Every later spec then fails on a network that isn't there, pointing the diagnosis at innocent
    files. This hook is the backstop that makes that unrepresentable.

    It lives OUTSIDE `test/` on purpose: `.mocharc.json`'s spec glob covers everything under
    `test/`, and a root hook plugin sitting in there would be loaded twice - once as a spec, once
    as a plugin.

    Free when unused: `replugTouched` returns immediately unless something in this process actually
    unplugged a node, so the ~600 tests that never touch the gate pay one function call each.
*/
const { replugTouched } = require("./test/unplug.cjs");

exports.mochaHooks = {
    async afterEach() {
        await replugTouched();
    },
    // The interrupt/bail path: afterEach doesn't run when mocha is killed between tests.
    async afterAll() {
        await replugTouched();
    },
};
