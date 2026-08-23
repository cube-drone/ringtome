/*
    A persona's own nodes, keeping each other whole: the cohort tests.

    The design conversation of 2026-08-15 (HISTORY: *feed convergence*): a persona's nodes are
    not part of each other's candidate walks, so a device that slept through an author's posts
    can NEVER catch up unless the author comes back - even while its own 24x7 sibling holds
    everything. FRONTIER GOSSIP is the fix's chain half: cohort sync sessions (which already
    exist, for the persona's own chains) exchange frontiers for the roots both follow, and
    serve the entries in the same session. Frontiers, never views: a relayed chain is evidence
    the receiving node's own sync gate validates, and no feed row ever crosses a wire.

    This file holds the SIMPLE diagnostic - plain follows, no rebroadcast machinery at all -
    beside which cascade.cjs's *the cohort is part of the tree* is the torturous full-stack
    proof (pointer + fragment + blobs). When something regresses, this one says whether the
    chain lane broke; that one says whether the share lane did.

    RED as of 2026-08-15, demonstrated live before being skipped; unskipped the same day as
    the cohort-as-candidate slice's first move. Green means the chain lane holds.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { sql, HOST, HOST_C, HOST_E } = require("./fetch.cjs");
const { makeFetch } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");
const { unplug, plugIn } = require("./unplug.cjs");

const settle = require("./helpers.cjs").settleWith(240);

const feedOf = async (reader, host) => {
    const { rows } = await sql(
        `SELECT author_root, doc_id, title FROM feed_journal WHERE reader_root = '${reader}'`,
        host
    );
    return rows;
};

// The anonymous body route on the reader's own node - the exact URL PostEntry fetches.
const servedBody = async (author, post, host) => {
    const res = await makeFetch(host)(`id/${author}/docs/${post}/body`);
    return res.status === 200 ? res.text() : null;
};

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};

(HOST_C && HOST_E ? describe : describe.skip)(
    "frontier gossip: the sibling that stayed up",
    function () {
        this.timeout(1200000);

        let author, authorRoot, cora, coraRoot;

        before(async function () {
            author = await makeUserFetch({ prefix: "gossauthor" });
            authorRoot = (
                await (await author("api/identity", { method: "POST" })).json()
            ).root_pubkey;
            await author(`api/identity/${authorRoot}/serve`, { method: "POST" });
            const viaAuthor = await base58(author);

            cora = await makeUserFetch({ prefix: "gosscora", host: HOST_C });
            coraRoot = (
                await (await cora("api/identity", { method: "POST" })).json()
            ).root_pubkey;
            await cora(`api/identity/${coraRoot}/serve`, { method: "POST" });

            // The one dial in the whole file: cora follows the author.
            if ((await cora(`api/id/${authorRoot}/profile?via=${viaAuthor}`)).status !== 200)
                this.skip();
            await cora(`api/identity/${coraRoot}/private/kv/contact:${authorRoot}/interest`, {
                method: "PUT",
                body: JSON.stringify({ value: "high" }),
            });

            // Cora's second node, by the real ceremony - and settled until echo's own
            // subscriptions memo knows the follow, proving the cohort input paths carry the
            // LEDGER before any darkness. What they do not yet carry is the followed world.
            const coraOnE = await makeUserFetch({ prefix: "gosscorae", host: HOST_E });
            const request = await (
                await coraOnE("api/identity/adopt/begin", { method: "POST" })
            ).json();
            const granted = await cora(`api/identity/${coraRoot}/nodes`, {
                method: "POST",
                body: JSON.stringify({ code: request.code }),
            });
            assert.equal(granted.status, 200, await granted.text());
            assert.ok(
                await settle(async () => {
                    const { rows } = await sql(
                        `SELECT 1 AS ok FROM subscriptions WHERE local_root = '${coraRoot}' AND foreign_root = '${authorRoot}'`,
                        HOST_E
                    );
                    return rows.length ? true : null;
                }),
                "the sibling learned the follow from the synced ledger"
            );
        });

        afterEach(async () => {
            await plugIn(HOST);
            await plugIn(HOST_E);
        });

        it("a post the author can no longer serve reaches the waking sibling", async () => {
            // The AM-node scenario, verbatim: the sibling sleeps through the morning...
            await unplug(HOST_E);

            const made = await (
                await author(`api/identity/${authorRoot}/docs`, {
                    method: "POST",
                    body: JSON.stringify({
                        title: "gossiped",
                        body: "gossiped: the words",
                        format: "plaintext",
                    }),
                })
            ).json();
            const pub = await author(`api/identity/${authorRoot}/docs/${made.doc_id}/publish`, {
                method: "POST",
            });
            const pubText = await pub.text();
            assert.equal(pub.status, 200, pubText);
            const post = JSON.parse(pubText).post_id;

            // ...while the 24x7 sibling hears everything.
            assert.ok(
                await settle(async () => {
                    const rows = await feedOf(coraRoot, HOST_C);
                    return rows.some((r) => r.doc_id === post) ? true : null;
                }),
                "the awake sibling journaled the post"
            );

            // The author leaves, forever. No sharer exists; no fragment machinery is in
            // play; the ONLY copy of this chain outside the departed is the sibling's.
            await unplug(HOST);

            // The sibling wakes.
            await plugIn(HOST_E);

            // THE PROPERTY (chain half): the feed row appears on the waking node - and the
            // only possible carrier is the cohort session, because the author answers nobody
            // and nothing else holds the chain. Today this settle times out: echo's sync
            // candidates for the author are the author's own dead endpoints.
            assert.ok(
                await settle(async () => {
                    const rows = await feedOf(coraRoot, HOST_E);
                    return rows.some((r) => r.doc_id === post) ? true : null;
                }, 160),
                "the sibling's frontier gossip carried the followed author's post"
            );

            // THE PROPERTY (blob half): the words serve from the waking node's own door,
            // which needs the body blob to have healed from the cohort too.
            assert.ok(
                await settle(async () => {
                    const body = await servedBody(authorRoot, post, HOST_E);
                    return body && body.includes("gossiped") ? true : null;
                }, 80),
                "and the words healed from the sibling that stayed up"
            );
        });
    }
);
