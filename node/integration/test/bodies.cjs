/*
    The body lane: headers ride entry sync, bodies ride iroh-blobs, and BOTH sides of an
    exchange must join them (2026-07-25). Before this, only the sync initiator fetched missing
    bodies - and eager push makes the WRITER the initiator, so the receiving node's documents
    sat bodiless (body: null) until its own anti-entropy pass. Field-tested to destruction:
    two editors on a diverged doc kept "clearing" - the null body was poured into the textarea
    as empty string, and saves resolved the fork with nothing.

    The load-bearing behaviors: a doc created on A becomes READABLE (body and all) on B within
    seconds, with B never initiating anything; and the exact reported scenario - divergent
    saves on both computers - converges to a conflict body containing BOTH texts on BOTH
    nodes, never a null, never an empty.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { HOST_B } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function adoptTo(joinerFetch, granterFetch, root) {
    const request = await (
        await joinerFetch("api/identity/adopt/begin", { method: "POST" })
    ).json();
    const grant = await (
        await granterFetch(`api/identity/${root}/nodes`, {
            method: "POST",
            body: JSON.stringify({ code: request.code }),
        })
    ).json();
    assert.equal(grant.delivered, true);
}

async function getDoc(fetch, root, docId) {
    return (await fetch(`api/identity/${root}/docs/${docId}`)).json();
}

async function pollDoc(fetch, root, docId, predicate, ms = 20000) {
    const deadline = Date.now() + ms;
    let doc = null;
    while (Date.now() < deadline) {
        doc = await getDoc(fetch, root, docId);
        if (predicate(doc)) return doc;
        await sleep(500);
    }
    return doc;
}

(HOST_B ? describe : describe.skip)("document bodies across nodes", function () {
    this.timeout(90000);

    it("a body written on A becomes readable on B without B asking", async function () {
        const alice = await makeUserFetch({ prefix: "bodya" });
        const created = await (await alice("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;
        const aliceOnB = await makeUserFetch({ prefix: "bodyb", host: HOST_B });
        await adoptTo(aliceOnB, alice, root);

        // Created AFTER adoption, so it reaches B by eager push - B is the RESPONDER, the
        // side that never fetched bodies before this fix.
        const made = await (
            await alice(`api/identity/${root}/docs`, {
                method: "POST",
                body: JSON.stringify({ title: "letter", body: "words that must travel" }),
            })
        ).json();

        const doc = await pollDoc(aliceOnB, root, made.doc_id, (d) => d.body != null);
        assert.equal(doc.body, "words that must travel", "the body followed its header to B");
    });

    it("the stale-tab scenario: divergent saves converge to BOTH texts on BOTH nodes", async function () {
        const alice = await makeUserFetch({ prefix: "forka" });
        const created = await (await alice("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;
        const aliceOnB = await makeUserFetch({ prefix: "forkb", host: HOST_B });
        await adoptTo(aliceOnB, alice, root);

        const made = await (
            await alice(`api/identity/${root}/docs`, {
                method: "POST",
                body: JSON.stringify({ title: "shared draft", body: "the common start" }),
            })
        ).json();
        const docId = made.doc_id;
        // Both computers see v1, body included.
        const onB = await pollDoc(aliceOnB, root, docId, (d) => d.body != null);
        const parents = onB.save_parents;
        const onA = await getDoc(alice, root, docId);
        assert.deepEqual(onA.save_parents, parents, "both start from the same head");

        // The report, verbatim: type on A, and before it syncs, type on B - both saves
        // asserting the SAME parent. A deliberate fork.
        await alice(`api/identity/${root}/docs/${docId}`, {
            method: "PUT",
            body: JSON.stringify({
                title: "shared draft",
                body: "the common start\nparagraphs typed on computer A",
                format: "plaintext",
                parents,
            }),
        });
        await aliceOnB(`api/identity/${root}/docs/${docId}`, {
            method: "PUT",
            body: JSON.stringify({
                title: "shared draft",
                body: "the common start\nparagraphs typed on computer B",
                format: "plaintext",
                parents,
            }),
        });

        // Both nodes must converge to a synthesized conflict containing BOTH texts - which
        // requires each node to hold the OTHER's body blob. Null or empty is the old bug.
        for (const [who, fetch] of [["A", alice], ["B", aliceOnB]]) {
            const doc = await pollDoc(
                fetch,
                root,
                docId,
                (d) =>
                    d.body != null &&
                    d.body.includes("computer A") &&
                    d.body.includes("computer B"),
                30000
            );
            assert.ok(doc.body, `node ${who} has a body`);
            assert.ok(
                doc.body.includes("paragraphs typed on computer A") &&
                    doc.body.includes("paragraphs typed on computer B"),
                `node ${who} shows both sides: ${doc.body}`
            );
            assert.equal(doc.diverged, true, `node ${who} knows it diverged`);
            assert.equal(doc.resolution, "conflict", `node ${who} presents the conflict`);
            // The sides are labeled by DEVICE NAME - "from alpha, ..." / "from bravo, ..." -
            // the NOTES_APP promise ("from your phone, yesterday 9pm"), finally kept.
            assert.ok(
                doc.body.includes("from alpha") && doc.body.includes("from bravo"),
                `node ${who} labels conflict sides by device name: ${doc.body}`
            );
        }
    });
});
