/*
    The beat: deterministic sequencing for the integration suite (2026-08-25).

    Every background loop in the node is a one-pass function, and `/test/beat` rings one
    NOW, returning when it completes. A test that used to fire an action and then `settle()`
    against timers under load instead DRIVES the pipeline hop by hop:

        await share(sam, samRoot, avaRoot, post);          // the act
        await beat(HOST_C, "pull", samRoot);               // reader pulls the sharer's chain
        await beat(HOST_C, "fold", samRoot);               // folds + journaling, unconditionally
        const r = await feedRow(rex, rexRoot, post);       // ONE assert, no window
        assert.equal(r.via, samRoot);

    `settle()` remains only where TIMING IS THE PROPERTY UNDER TEST (eager-push latency,
    anti-entropy convergence) - a wait that exists to measure the machinery's own clock is a
    test of the clock; every other wait was a race, and three days of CI flakes were those
    races losing on slow runners.

    The vocabulary (see test_endpoints::beat): per-root - "pull" (the reader-driven fetch
    ladder), "fold" (frontier refresh + the whole post-arrival hook chain + the reader
    fold), "eager-push"; fleet-wide - "fragment-sweep", "bodies-sweep", "journal-fill",
    "follow-refresh", "speculative-acquire", "evict". Root is ignored by the fleet sweeps.
*/
const { makeFetch } = require("./fetch.cjs");

async function beat(host, pass, root) {
    const res = await makeFetch(host)("test/beat", {
        method: "POST",
        body: JSON.stringify(root ? { pass, root } : { pass }),
    });
    if (res.status !== 200) {
        throw new Error(`beat(${pass}) on ${host}: ${res.status} ${await res.text()}`);
    }
}

/// The common two-step: the reader's node pulls a chain and folds it. What most
/// "X reached Y" settles actually waited for.
async function pullAndFold(host, root) {
    await beat(host, "pull", root);
    await beat(host, "fold", root);
}

/// A SHARE's arrival at a reader's node, to the fragment: pull the sharer's chain, fold,
/// drain any want a failed first ask minted - then a full second round as a belt against
/// the still-open fold-race family (REFACTOR.md's stale fold-read): a round that starts
/// after the first completed reads what the detached arrival hooks committed. NB the CI
/// flakes that grew this helper turned out to be mostly the journal upsert's byline bug
/// (fanout.rs, fixed 2026-08-25) - the rung's drain covers the real first-ask misses.
async function shareArrives(host, sharerRoot, authorRoot) {
    await pullAndFold(host, sharerRoot);
    await beat(host, "fragment-sweep", authorRoot);
    await beat(host, "fold", sharerRoot);
    await beat(host, "fragment-sweep", authorRoot);
}

module.exports = { beat, pullAndFold, shareArrives };
