/*
    The derived peer set: "the chain frontier is the peer list", finally honored.

    A adopts B, B adopts C - a ceremony CHAIN, so A and C never exchange codes and, before
    derivation, hold no row for each other. The tree (synced everywhere) enumerates the
    Active leaves; each leaf's serving record (published universally since the
    discoverability doctrine) resolves to an endpoint; the derive sweep writes the product
    into identity_peers, leaf-bound. Leaf-bound is the point: revocation can finally reach
    routing, and this suite pins both halves.
*/
const assert = require("node:assert");
const { sql, HOST_B, HOST_C } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");

const settle = async (fn, tries = 120) => {
    for (let i = 0; i < tries; i++) {
        const got = await fn();
        if (got) return got;
        await new Promise((r) => setTimeout(r, 250));
    }
    return null;
};

const adopt = async (haver, joiner, root) => {
    const request = await (await joiner("api/identity/adopt/begin", { method: "POST" })).json();
    const grant = await (
        await haver(`api/identity/${root}/nodes`, {
            method: "POST",
            body: JSON.stringify({ code: request.code }),
        })
    ).json();
    const done = await joiner("api/identity/adopt/complete", {
        method: "POST",
        body: JSON.stringify({ code: grant.code }),
    });
    assert.equal(done.status, 200, await done.text());
};

(HOST_B && HOST_C ? describe : describe.skip)("the derived peer set", function () {
    this.timeout(120000);

    it("a ceremony chain converges to a full mesh, leaf-bound - and revocation prunes it", async () => {
        const a = await makeUserFetch({ prefix: "derivea" });
        const root = (await (await a("api/identity", { method: "POST" })).json()).root_pubkey;
        const b = await makeUserFetch({ prefix: "deriveb", host: HOST_B });
        await adopt(a, b, root);
        const c = await makeUserFetch({ prefix: "derivec", host: HOST_C });
        await adopt(b, c, root);

        // A and C shared no ceremony; the derive sweep must teach each about the other,
        // and bind the rows to leaves (the serving record names the leaf that signed it).
        const meshed = await settle(async () => {
            const { rows } = await sql(
                `SELECT COUNT(*) AS n FROM identity_peers
                 WHERE root_pubkey = '${root}' AND leaf_pubkey IS NOT NULL`
            );
            return rows[0].n >= 2 ? true : null;
        });
        assert.ok(meshed, "A learned both siblings, leaf-bound, without meeting C");
        const cAlso = await settle(async () => {
            const { rows } = await sql(
                `SELECT COUNT(*) AS n FROM identity_peers
                 WHERE root_pubkey = '${root}' AND leaf_pubkey IS NOT NULL`,
                HOST_C
            );
            return rows[0].n >= 2 ? true : null;
        });
        assert.ok(cAlso, "and C learned A the same way");

        // Revocation reaches routing: repudiate C's leaf from A; the derive sweep must drop
        // the row - before this existed, NOTHING removed a repudiated device's row and the
        // eager loop kept dialing it forever.
        const { rows: leafRows } = await sql(
            `SELECT leaf_pubkey FROM identity_peers
             WHERE root_pubkey = '${root}' AND leaf_pubkey IS NOT NULL`
        );
        // Identify C's leaf as the one B granted last (the row set is {B's leaf, C's leaf});
        // ask B's node, which granted C and recorded its leaf at ceremony time.
        const { rows: cRow } = await sql(
            `SELECT leaf_pubkey FROM identity_peers
             WHERE root_pubkey = '${root}' AND leaf_pubkey IS NOT NULL
             ORDER BY added_at_ms DESC LIMIT 1`,
            HOST_B
        );
        const cLeaf = cRow[0].leaf_pubkey;
        assert.ok(leafRows.some((r) => r.leaf_pubkey === cLeaf), "A's mesh includes C's leaf");
        const struck = await a(`api/identity/${root}/keys/${cLeaf}/revoke`, {
            method: "POST",
            body: JSON.stringify({ disposition: "repudiation", cut: "genesis" }),
        });
        assert.equal(struck.status, 200, await struck.text());
        // The derive beat is recovery-paced (minutes) and its lag behind the strike is the
        // strike's DELIVERY window, so this probe rings the beat itself rather than waiting
        // out (or globally shortening, which races other strike tests) the real cadence.
        const derived = await a("test/derive", { method: "POST" });
        assert.equal(derived.status, 200, "the derive pass can be rung on demand");
        const pruned = await settle(async () => {
            const { rows } = await sql(
                `SELECT 1 FROM identity_peers
                 WHERE root_pubkey = '${root}' AND leaf_pubkey = '${cLeaf}'`
            );
            return rows.length === 0 ? true : null;
        });
        assert.ok(pruned, "the repudiated device left A's dial list on the next derive");
    });
});
