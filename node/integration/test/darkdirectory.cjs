/*
    A node with NO directory: `RINGTOME_DISCOVERY` unset, which is the default a shipped node
    boots with and therefore the state of every offline and LAN-only user.

    This file exists because that state had never been exercised. The rig's other three nodes all
    run `local:` discovery, `mainline-smoke` runs the real DHT, and so `POST /serve` was only ever
    tested somewhere it could actually publish. In the dark it returned a 500 - "something went
    wrong inside this node" - and it did so AFTER `record_served` had already committed, so the
    node believed the identity was served while the reader was told the act had failed. Found
    2026-08-08 by `just test-data` against a lone `just start`, whose every go-public failed.

    The rule these assertions encode: consent is durable and local, announcing is best-effort.
    A person with no internet can still say "yes, serve this" and be believed; the republish loop
    carries the record out the moment a directory exists.
*/
const assert = require("node:assert");
const { HOST_DARK, sql } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");

describe("a node in the dark (no discovery configured)", function () {
    // Skips rather than fails when the rig didn't boot the fourth node - the house pattern for
    // multi-node tests, so a single-node run of this suite stays green.
    before(function () {
        if (!HOST_DARK) this.skip();
    });

    let user, root;

    before(async () => {
        user = await makeUserFetch({ host: HOST_DARK, prefix: "darkserve" });
        root = (await (await user("api/identity", { method: "POST" })).json()).root_pubkey;
    });

    it("creates a persona at all - a dark directory must not fail a ceremony", () => {
        assert.ok(root, "an identity was created on a node with nowhere to announce it");
    });

    it("goes public without a directory to go public INTO", async () => {
        // Read the body ONCE: an `await resp.text()` inside an assertion message is evaluated
        // eagerly, even when the assertion holds, and the next `.json()` then finds it consumed.
        const resp = await user(`api/identity/${root}/serve`, { method: "POST" });
        const body = await resp.text();
        assert.equal(resp.status, 200, `serving in the dark must succeed, got ${resp.status}: ${body}`);
        assert.deepEqual(JSON.parse(body), { served: true });
    });

    it("is idempotent - the generator's go-public runs over and over", async () => {
        for (let i = 0; i < 3; i++) {
            const resp = await user(`api/identity/${root}/serve`, { method: "POST" });
            const body = await resp.text();
            assert.equal(resp.status, 200, `repeat ${i + 1} failed: ${body}`);
        }
    });

    it("actually recorded the consent, rather than reporting a success it did not keep", async () => {
        // The half that MUST be durable, read from the table rather than inferred from the 200 -
        // a success that left `served_at_ms` null would be the same split brain as before,
        // wearing the other face. (`served_at_ms` is not on the shelf response; the LOCAL_TEST
        // sql passthrough is how a test reaches node.db.)
        const { rows } = await sql(
            `SELECT served_at_ms FROM identities WHERE root_pubkey = '${root}'`,
            HOST_DARK
        );
        assert.equal(rows.length, 1, "the persona is still on this node");
        assert.ok(
            rows[0].served_at_ms,
            "consent is written locally even though nothing could be announced"
        );
    });

    it("still writes and publishes posts - the write path never touches the directory", async () => {
        const made = await user(`api/identity/${root}/docs`, {
            method: "POST",
            body: JSON.stringify({
                title: "a message in a bottle",
                body: "written on a node with no ocean to throw it into",
                format: "marquee",
            }),
        });
        const madeBody = await made.text();
        assert.equal(made.status, 200, `writing in the dark failed: ${madeBody}`);
        const { doc_id } = JSON.parse(madeBody);

        const published = await user(`api/identity/${root}/docs/${doc_id}/publish`, {
            method: "POST",
        });
        const publishedBody = await published.text();
        assert.equal(published.status, 200, `publishing in the dark failed: ${publishedBody}`);
    });
});
