/*
    What documents DO after a repudiation - the composite suite.

    The unit tests pin each mechanism alone (the gate's sweeps, the DAG's dangling-parent
    tolerance, the resolver's keep-both). This file builds one COMPLEX world - many documents,
    interleaved authorship across two devices, buckets, tags, a taxonomy tree, a live
    divergence - and then strikes device B, asserting the whole surviving shape on BOTH nodes.
    It exists because a field test ("a complex history, then repudiated a device to the nub")
    left its author unable to say what SHOULD have survived. This is the answer, written down:

    Under the GENESIS cut ("it was never me"):
      - everything B signed vanishes: its documents, its versions, its bucket definitions and
        filings, its tags, its tree sections and placements;
      - everything A signed survives - including versions whose parents were B's (they dangle,
        tolerated), and B's words that A re-signed by saving over them;
      - a document B created but A improved survives AS A's improvement;
      - a document ONLY B ever touched vanishes entirely - that loss is CORRECT, and pinned
        here so nobody mistakes it for a bug;
      - no surviving document ever resolves to an empty or missing body;
      - a rebuild-from-journal reproduces the exact same surviving shape.

    Under the NOW cut ("it was me until now"): everything of B's that synced before the
    revocation survives untouched - the cut closes the future, not the past. (The raced
    unsynced-suffix case is a deterministic unit test - sync.rs's
    stored_rows_beyond_the_cut_are_evicted - because eager push makes it racy here.)
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { HOST_B, HOST_C, sql } = require("./fetch.cjs");
const { makeUserFetch, decodeCode } = require("./helpers.cjs");

// --- world-building helpers -----------------------------------------------------------------

async function bootPersona(prefix) {
    const a = await makeUserFetch({ prefix });
    const created = await (await a("api/identity", { method: "POST" })).json();
    const root = created.root_pubkey;

    const b = await makeUserFetch({ prefix: prefix + "b", host: HOST_B });
    const request = await (await b("api/identity/adopt/begin", { method: "POST" })).json();
    const leaf = decodeCode(request.code).leaf_pubkey;
    const grant = await (
        await a(`api/identity/${root}/nodes`, {
            method: "POST",
            body: JSON.stringify({ code: request.code }),
        })
    ).json();
    await b("api/identity/adopt/complete", {
        method: "POST",
        body: JSON.stringify({ code: grant.code }),
    });
    return { a, b, root, leaf };
}

const createDoc = async (fetch, root, title, body) => {
    const r = await (
        await fetch(`api/identity/${root}/docs`, {
            method: "POST",
            body: JSON.stringify({ title, body, format: "plaintext" }),
        })
    ).json();
    return { id: r.doc_id, v: r.version };
};

const saveDoc = async (fetch, root, id, body, parents) => {
    const res = await fetch(`api/identity/${root}/docs/${id}`, {
        method: "PUT",
        body: JSON.stringify({ title: "t", body, parents, format: "plaintext" }),
    });
    assert.equal(res.status, 200, `save ${body} succeeds`);
    return (await res.json()).version;
};

const getDoc = (fetch, root, id) => fetch(`api/identity/${root}/docs/${id}`);
const listIds = async (fetch, root) =>
    (await (await fetch(`api/identity/${root}/docs`)).json()).docs.map((d) => d.doc_id);

(HOST_B ? describe : describe.skip)("documents after a repudiation", function () {
    this.timeout(120000);

    describe("the genesis cut: everything B signed vanishes, everything A signed survives", () => {
        let a, b, root, leaf;
        // The cast of documents, each one behavior:
        let docA; //    A creates, A edits            -> untouched
        let docB; //    B creates, B edits, only B    -> vanishes entirely (correct loss)
        let docAB; //   A -> B -> A, linear           -> A's ends survive; B's middle dangles
        let docBA; //   B creates, A improves         -> survives AS A's improvement
        let docDiv; //  A and B diverge pre-strike    -> B's branch dies; divergence RESOLVES
        let sectA, sectB, treeRoot;

        const sync = async () => {
            const r = await (await a(`api/identity/${root}/sync`, { method: "POST" })).json();
            assert.ok(r.some((x) => x.ok), "nodes can talk");
        };

        before(async () => {
            ({ a, b, root, leaf } = await bootPersona("repgen"));

            // --- documents
            docA = await createDoc(a, root, "docA", "alpha-1");
            docA.v2 = await saveDoc(a, root, docA.id, "alpha-2", [docA.v]);

            docB = await createDoc(b, root, "docB", "bravo-1");
            docB.v2 = await saveDoc(b, root, docB.id, "bravo-2", [docB.v]);

            docAB = await createDoc(a, root, "docAB", "ab-1");
            await sync();
            docAB.v2 = await saveDoc(b, root, docAB.id, "ab-2", [docAB.v]);
            await sync();
            docAB.v3 = await saveDoc(a, root, docAB.id, "ab-3", [docAB.v2]);

            docBA = await createDoc(b, root, "docBA", "ba-1");
            await sync();
            docBA.v2 = await saveDoc(a, root, docBA.id, "ba-2-improved", [docBA.v]);

            docDiv = await createDoc(a, root, "docDiv", "div-1");
            await sync();
            // Both sides save from the same parent, no sync between: a real divergence.
            docDiv.va = await saveDoc(a, root, docDiv.id, "div-a", [docDiv.v]);
            docDiv.vb = await saveDoc(b, root, docDiv.id, "div-b", [docDiv.v]);
            await sync();

            // --- buckets: B defines one and files A's doc; A defines one and files B's doc.
            await b(`api/identity/${root}/buckets`, {
                method: "POST",
                body: JSON.stringify({ name: "b-bucket", app: "notes" }),
            });
            await b(`api/identity/${root}/docs/${docA.id}/buckets/b-bucket`, { method: "PUT" });
            await a(`api/identity/${root}/buckets`, {
                method: "POST",
                body: JSON.stringify({ name: "a-bucket", app: "notes" }),
            });
            await a(`api/identity/${root}/docs/${docB.id}/buckets/a-bucket`, { method: "PUT" });

            // --- tags: B tags A's doc, A tags B's doc.
            await b(`api/identity/${root}/docs/${docA.id}/annotations/tags/btag`, { method: "PUT" });
            await a(`api/identity/${root}/docs/${docB.id}/annotations/tags/atag`, { method: "PUT" });

            // --- the tree: A's root, one section from each device, one placement from each.
            treeRoot = (
                await (
                    await a(`api/identity/${root}/taxonomies`, {
                        method: "POST",
                        body: JSON.stringify({ title: "wiki:default" }),
                    })
                ).json()
            ).taxonomy_id;
            sectA = (
                await (
                    await a(`api/identity/${root}/taxonomies`, {
                        method: "POST",
                        body: JSON.stringify({ title: "a-sect" }),
                    })
                ).json()
            ).taxonomy_id;
            await a(`api/identity/${root}/taxonomies/${treeRoot}/members/${sectA}`, {
                method: "PUT",
                body: "{}",
            });
            await sync();
            sectB = (
                await (
                    await b(`api/identity/${root}/taxonomies`, {
                        method: "POST",
                        body: JSON.stringify({ title: "b-sect" }),
                    })
                ).json()
            ).taxonomy_id;
            await b(`api/identity/${root}/taxonomies/${treeRoot}/members/${sectB}`, {
                method: "PUT",
                body: "{}",
            });
            // B places A's doc; A places B's doc.
            await b(`api/identity/${root}/taxonomies/${sectA}/members/${docA.id}`, {
                method: "PUT",
                body: "{}",
            });
            await a(`api/identity/${root}/taxonomies/${sectA}/members/${docB.id}`, {
                method: "PUT",
                body: "{}",
            });
            await sync();

            // --- the world as built, before the strike (the "kept good track" this suite IS):
            const pre = await (await a(`api/identity/${root}/docs`)).json();
            assert.equal(pre.docs.length, 5, "five documents live before the strike");
            const preDiv = await (await getDoc(a, root, docDiv.id)).json();
            assert.equal(preDiv.diverged, true, "docDiv genuinely diverged before the strike");
            const preTags = pre.docs.find((d) => d.doc_id === docA.id).tags;
            assert.ok(preTags.includes("btag"), "B's tag on A's doc landed");

            // --- the strike: it was never B.
            await a(`api/identity/${root}/keys/${leaf}/revoke`, {
                method: "POST",
                body: JSON.stringify({ disposition: "repudiation", cut: "genesis" }),
            });
            await sync(); // B hears, and sweeps its own history
        });

        // Each behavior asserted on BOTH nodes: the striking one and the struck one.
        const eachNode = (name, fn) => {
            it(`${name} (on the striking node)`, async () => fn(() => a));
            it(`${name} (on the struck node, after it hears)`, async () => fn(() => b));
        };

        eachNode("a document only A touched is untouched", async (node) => {
            const d = await (await getDoc(node(), root, docA.id)).json();
            assert.equal(d.body, "alpha-2");
            assert.equal(d.resolution, "single");
        });

        eachNode("a document only B touched vanishes entirely - the correct loss", async (node) => {
            assert.ok(!(await listIds(node(), root)).includes(docB.id), "not listed");
            const res = await getDoc(node(), root, docB.id);
            assert.equal(res.status, 404, "and not fetchable");
        });

        eachNode("A -> B -> A: A's two ends survive as a conflict, B's middle dangles", async (node) => {
            const d = await (await getDoc(node(), root, docAB.id)).json();
            assert.equal(d.heads.length, 2, "ab-1 (unclaimed once ab-2 died) and ab-3");
            assert.ok(d.body && d.body.includes("ab-3"), "A's final words survive");
            assert.ok(d.body.includes("ab-1"), "A's first words survive");
            assert.ok(!d.body.includes("ab-2"), "B's middle is struck");
        });

        eachNode("a doc B created but A improved survives AS the improvement", async (node) => {
            const d = await (await getDoc(node(), root, docBA.id)).json();
            assert.equal(d.body, "ba-2-improved", "A's version is the whole surviving doc");
            assert.equal(d.heads.length, 1, "a single head - the dangling parent is tolerated");
            assert.ok((await listIds(node(), root)).includes(docBA.id), "still listed");
        });

        eachNode("a live divergence RESOLVES when the other branch was the impostor's", async (node) => {
            const d = await (await getDoc(node(), root, docDiv.id)).json();
            assert.equal(d.diverged, false, "the conflict evaporated with B's branch");
            assert.equal(d.body, "div-a", "A's branch is the document");
        });

        eachNode("B's bucket and filings vanish; A's bucket survives its dead member", async (node) => {
            const roster = (await (await node()(`api/identity/${root}/buckets`)).json()).buckets;
            const names = roster.map((x) => x.name);
            assert.ok(!names.includes("b-bucket"), "B's bucket definition died with B");
            assert.ok(names.includes("a-bucket"), "A's bucket stands");
            const rows = (await (await node()(`api/identity/${root}/docs`)).json()).docs;
            assert.deepEqual(
                rows.find((d) => d.doc_id === docA.id).buckets,
                [],
                "B's filing of A's doc is gone; the doc itself is fine"
            );
        });

        eachNode("B's tags vanish, A's survive (on whatever survives)", async (node) => {
            const rows = (await (await node()(`api/identity/${root}/docs`)).json()).docs;
            assert.deepEqual(rows.find((d) => d.doc_id === docA.id).tags, [], "btag is struck");
        });

        eachNode("the tree: A's section stands, B's section and placements vanish", async (node) => {
            const tree = await (
                await node()(`api/identity/${root}/taxonomies/${treeRoot}`)
            ).json();
            const memberIds = tree.members.map((m) => m.doc_id);
            assert.ok(memberIds.includes(sectA), "A's section stands");
            assert.ok(!memberIds.includes(sectB), "B's section is gone");
            const aSect = tree.members.find((m) => m.doc_id === sectA).taxonomy;
            const placed = aSect.members.map((m) => m.doc_id);
            assert.ok(!placed.includes(docA.id), "B's placement of A's doc is gone");
            // A's placement of B's doc: the membership (A's write) stands, but the document
            // behind it died with B - a dangling reference, representable and unrendered.
            const dangling = aSect.members.find((m) => m.doc_id === docB.id);
            assert.ok(dangling, "A's placement survives as a reference");
            assert.equal(dangling.doc, null, "pointing at a struck document");
        });

        eachNode("no surviving document resolves empty - the never-lose-words sweep", async (node) => {
            for (const id of await listIds(node(), root)) {
                const d = await (await getDoc(node(), root, id)).json();
                assert.ok(
                    typeof d.body === "string" && d.body.length > 0,
                    `${d.title} (${id}) resolves to real words, got ${JSON.stringify(d.body)}`
                );
            }
        });

        it("a rebuild-from-journal reproduces the exact surviving shape", async () => {
            const before = await (await a(`api/identity/${root}/docs`)).json();
            await a(`api/identity/${root}/rebuild`, { method: "POST" });
            const after = await (await a(`api/identity/${root}/docs`)).json();
            assert.deepEqual(
                after.docs.map((d) => [d.doc_id, d.head, d.heads, d.tags, d.buckets]).sort(),
                before.docs.map((d) => [d.doc_id, d.head, d.heads, d.tags, d.buckets]).sort(),
                "the views are derived state; replay lands on the same world"
            );
        });
    });

    describe("the now cut: the past survives whole, only the future closes", () => {
        it("everything of B's that synced before the strike is untouched", async () => {
            const { a, b, root, leaf } = await bootPersona("repnow");
            const sync = async () => {
                await (await a(`api/identity/${root}/sync`, { method: "POST" })).json();
            };

            const docB = await createDoc(b, root, "docB-now", "bravo-now");
            await b(`api/identity/${root}/buckets`, {
                method: "POST",
                body: JSON.stringify({ name: "b-now-bucket", app: "notes" }),
            });
            await b(`api/identity/${root}/docs/${docB.id}/buckets/b-now-bucket`, {
                method: "PUT",
            });
            await sync();

            await a(`api/identity/${root}/keys/${leaf}/revoke`, {
                method: "POST",
                body: JSON.stringify({ disposition: "repudiation" }), // cut defaults to "now"
            });
            await sync();

            for (const node of [a, b]) {
                const d = await (await getDoc(node, root, docB.id)).json();
                assert.equal(d.body, "bravo-now", "B's synced words stand");
                const roster = (await (await node(`api/identity/${root}/buckets`)).json())
                    .buckets;
                assert.ok(
                    roster.some((x) => x.name === "b-now-bucket"),
                    "B's synced bucket stands"
                );
            }
        });
    });
});

/*
    The strike's reach into DERIVED state on a third party: a follower's feed journal.

    The suite above proves the signed world heals - eviction deletes the disproven entries and
    the views refold. But feed_journal is a delivery memo, not a view over the log: it only
    ever upserts. Without an explicit retraction, a repudiated device's post that had already
    crossed into a follower's journal kept rendering there as live content - the delivery
    record laundering words the identity itself has disproven ("that device was never me").
*/
(HOST_B && HOST_C ? describe : describe.skip)("a repudiation reaches the feeds", function () {
    this.timeout(120000);

    const settle = async (fn, tries = 120) => {
        for (let i = 0; i < tries; i++) {
            const got = await fn();
            if (got) return got;
            await new Promise((r) => setTimeout(r, 250));
        }
        return null;
    };
    const feedTitles = async (reader, host) => {
        const { rows } = await sql(
            `SELECT title FROM feed_journal WHERE reader_root = '${reader}'`,
            host
        );
        return rows.map((r) => r.title).sort();
    };

    it("a repudiated device's posts are retracted from feeds - here and on a follower's node", async () => {
        const { a, b, root, leaf } = await bootPersona("retractfeed");
        const { toBase58 } = await import("../../js/speakable.js");
        const viaA = toBase58((await (await a("api/node")).json()).endpoint_id);

        // Bob, on a THIRD node, finds Alice and follows her - before anything is posted, so
        // every arrival below travels by push (the fanout suite's proven road).
        const bob = await makeUserFetch({ prefix: "retractbob", host: HOST_C });
        const bobRoot = (await (await bob("api/identity", { method: "POST" })).json()).root_pubkey;
        const seen = await bob(`api/id/${root}/profile?via=${viaA}`);
        assert.equal(seen.status, 200, await seen.text());
        await bob(`api/identity/${bobRoot}/private/kv/contact:${root}/interest`, {
            method: "PUT",
            body: JSON.stringify({ value: "high" }),
        });
        assert.ok(
            await settle(async () => {
                const { rows } = await sql(
                    `SELECT 1 FROM subscriptions WHERE local_root = '${bobRoot}'
                     AND foreign_root = '${root}'`,
                    HOST_C
                );
                return rows.length ? true : null;
            }),
            "the follow reached C's memo"
        );

        // The honest post from the senior device; the doomed one from the device that will
        // be repudiated. Both must actually arrive in Bob's journal before the strike, or
        // the retraction below would be vacuously "proven" by lag.
        const honest = await createDoc(a, root, "honest-post", "words that were always mine");
        await a(`api/identity/${root}/docs/${honest.id}/publish`, { method: "POST" });
        const doomed = await createDoc(b, root, "doomed-post", "words from the disowned device");
        const doomedPub = await b(`api/identity/${root}/docs/${doomed.id}/publish`, {
            method: "POST",
        });
        const doomedPost = JSON.parse(await doomedPub.text()).post_id;
        await b(`api/identity/${root}/sync`, { method: "POST" });

        const delivered = await settle(async () => {
            const t = await feedTitles(bobRoot, HOST_C);
            return t.includes("honest-post") && t.includes("doomed-post") ? t : null;
        });
        assert.ok(delivered, "both posts crossed into the follower's journal before the strike");
        assert.deepEqual(
            await settle(async () => {
                const t = await feedTitles(root);
                return t.length >= 2 ? t : null;
            }),
            ["doomed-post", "honest-post"],
            "and into Alice's own feed at home"
        );

        // The strike: it was never that device.
        await a(`api/identity/${root}/keys/${leaf}/revoke`, {
            method: "POST",
            body: JSON.stringify({ disposition: "repudiation", cut: "genesis" }),
        });

        // Alice's own node first: eviction refolds the views, and the retraction must sweep
        // the journal on the same edge.
        // Wait for the SETTLED state, not merely for the doomed title to be absent. Eviction
        // clears the document views whole-table and lets the watermarks refold them, so there
        // is a window where this query legitimately returns nothing at all - and `[]` is
        // truthy in JS, so a callback that returns `t` the moment "doomed" is missing latches
        // onto that window and reports an empty feed as the final answer. That window is
        // shorter than one 250ms poll on a fast machine and reliably sampled on a slow one,
        // which is precisely how this passed locally and failed twice on the CI runner.
        assert.deepEqual(
            await settle(async () => {
                const t = await feedTitles(root);
                return !t.includes("doomed-post") && t.includes("honest-post") ? t : null;
            }),
            ["honest-post"],
            "the disowned post left Alice's own feed; the honest one stands (null here means \
the honest post never came back, which is the collateral-damage bug, not the poll race)"
        );

        // Then the follower's node, which hears by push (Bob asked A once; A remembers).
        assert.deepEqual(
            await settle(async () => {
                const t = await feedTitles(bobRoot, HOST_C);
                return !t.includes("doomed-post") && t.includes("honest-post") ? t : null;
            }),
            ["honest-post"],
            "the follower's journal retracted it too - a delivery memo cannot launder disproven content"
        );

        // And the words themselves no longer resolve on the follower's node: the journal row
        // is gone AND the document under it is gone, on a node Alice never touched directly.
        const body = await bob(`id/${root}/docs/${doomedPost}/body`);
        assert.equal(body.status, 404, "the disproven document does not serve");
        const honestStill = await settle(async () => {
            const t = await feedTitles(bobRoot, HOST_C);
            return t.includes("honest-post") ? true : null;
        });
        assert.ok(honestStill, "and the honest post was never collateral");
    });
});
