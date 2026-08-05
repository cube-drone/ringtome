/*
    The public-frontier map (net::frontier): what this node holds of each persona's public lane,
    one fingerprint per (persona, service).

    Why it exists: per-user databases are separate files, so "which personas changed?" otherwise
    means opening every one of them. This is the scan behind fan-out - and the thing that will
    let a followed identity's movement be noticed at all.

    What is asserted here is what a hash can honestly promise: it MOVES when the public lane
    moves, it does NOT move when nothing did, and it never carries a private service. Whether one
    fingerprint is "ahead" of another is deliberately not asserted, because a hash cannot say.
*/
const assert = require("node:assert");
const { sql } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");

// The loop's cadence is 30s, but it is NUDGED by every local write, so a pass follows a write
// within a moment. Poll rather than sleep a fixed time.
const settle = async (fn, tries = 40) => {
    for (let i = 0; i < tries; i++) {
        const got = await fn();
        if (got) return got;
        await new Promise((r) => setTimeout(r, 250));
    }
    return null;
};

// held_at_ms is selected deliberately: it is what catches a pass that REWRITES rows to say
// "still the same". A sweep that touches every row every tick costs a node holding a thousand
// personas four thousand writes to record that nothing happened, and makes this column mean
// "when we last looked" instead of "when this changed".
const frontiers = async (root) => {
    const { rows } = await sql(
        `SELECT service, hex(held_fp) AS fp, chains, held_at_ms FROM persona_frontiers
         WHERE root_pubkey = '${root}' ORDER BY service`
    );
    return rows;
};

let owner, root;

before(async () => {
    owner = await makeUserFetch({ prefix: "frontier" });
    const made = await (await owner("api/identity", { method: "POST" })).json();
    root = made.root_pubkey;
});

describe("the public frontier map", () => {
    it("learns a persona without being asked", async () => {
        const rows = await settle(async () => {
            const r = await frontiers(root);
            return r.length ? r : null;
        });
        assert.ok(rows, "the sweep found the new persona on its own");
        // A brand-new persona has written its key tree (IDENTITY_PUBLIC = 0) and its profile
        // registers; every row is a PUBLIC service.
        for (const r of rows) {
            assert.ok([0, 2, 3, 4].includes(r.service), `service ${r.service} is public`);
            assert.ok(r.chains >= 1, "a row exists only when a chain does");
        }
        assert.ok(rows.some((r) => r.service === 0), "the key tree is a public chain");
    });

    it("never carries a private service - the cadence of private work is private", async () => {
        // Write a private document, which appends to DOCUMENTS_PRIVATE (6) and DOC_META (7).
        const d = await (
            await owner(`api/identity/${root}/docs`, {
                method: "POST",
                body: JSON.stringify({ title: "a secret", body: "shh", format: "plaintext" }),
            })
        ).json();
        assert.ok(d.doc_id);
        await new Promise((r) => setTimeout(r, 2000));
        const rows = await frontiers(root);
        for (const r of rows) {
            assert.ok(
                ![1, 5, 6, 7].includes(r.service),
                `private service ${r.service} must never appear in a shareable fingerprint`
            );
        }
    });

    it("does not move when nothing public happened", async () => {
        const before = await frontiers(root);
        // Another purely private write.
        await owner(`api/identity/${root}/docs`, {
            method: "POST",
            body: JSON.stringify({ title: "also secret", body: "shh", format: "plaintext" }),
        });
        await new Promise((r) => setTimeout(r, 2500));
        assert.deepEqual(
            await frontiers(root),
            before,
            "private work is invisible here - and the rows were not even rewritten"
        );
    });

    it("MOVES when the persona says something in public", async () => {
        const before = await frontiers(root);
        const postsBefore = before.find((r) => r.service === 3);

        const note = await (
            await owner(`api/identity/${root}/docs`, {
                method: "POST",
                body: JSON.stringify({ title: "Out loud", body: "hello world", format: "plaintext" }),
            })
        ).json();
        const pub = await owner(`api/identity/${root}/docs/${note.doc_id}/publish`, {
            method: "POST",
        });
        assert.equal(pub.status, 200, await pub.text());

        const after = await settle(async () => {
            const rows = await frontiers(root);
            const posts = rows.find((r) => r.service === 3);
            if (!posts) return null;
            if (postsBefore && posts.fp === postsBefore.fp) return null;
            return rows;
        });
        assert.ok(after, "the POSTS fingerprint moved after a publication");
        const posts = after.find((r) => r.service === 3);
        assert.equal(posts.chains, 1, "one computer has written this persona's posts");

        // And the OTHER services did not move: publishing is not renaming yourself.
        for (const svc of [0, 2]) {
            const b = before.find((r) => r.service === svc);
            const a = after.find((r) => r.service === svc);
            if (b && a) {
                assert.equal(a.fp, b.fp, `service ${svc} must not move when only posts did`);
            }
        }
    });
});

/*
    The peer half: two nodes carrying one persona, each recording what the other CLAIMS its
    public frontier is, and what came of chasing that claim.

    The claim is a hint, never a fact (PROJECT_PLAN) - which is exactly why the verdict is
    stored beside it. Without one, a node advertising a fingerprint it cannot back up is chased
    on every sweep forever: free for it, expensive for us.
*/
const { HOST_B, sql: sqlOn } = require("./fetch.cjs");

(HOST_B ? describe : describe.skip)("frontier claims between two nodes", function () {
    this.timeout(60000);

    it("records what the other node claims, and converges", async function () {
        const alice = await makeUserFetch({ prefix: "fpalice" });
        const created = await (await alice("api/identity", { method: "POST" })).json();
        const shared = created.root_pubkey;

        // Say something in public BEFORE the second computer exists, so there is a real
        // frontier for it to be behind.
        const note = await (
            await alice(`api/identity/${shared}/docs`, {
                method: "POST",
                body: JSON.stringify({ title: "Ahoy", body: "out loud", format: "plaintext" }),
            })
        ).json();
        await alice(`api/identity/${shared}/docs/${note.doc_id}/publish`, { method: "POST" });

        // The add-a-node ceremony.
        const aliceOnB = await makeUserFetch({ prefix: "fpaliceb", host: HOST_B });
        const request = await (
            await aliceOnB("api/identity/adopt/begin", { method: "POST" })
        ).json();
        const grant = await (
            await alice(`api/identity/${shared}/nodes`, {
                method: "POST",
                body: JSON.stringify({ code: request.code }),
            })
        ).json();
        const done = await aliceOnB("api/identity/adopt/complete", {
            method: "POST",
            body: JSON.stringify({ code: grant.code }),
        });
        assert.equal(done.status, 200, await done.text());

        // Both nodes now hold the persona. Wait until each has recorded the other's claim.
        const claims = async (host) => {
            const { rows } = await sqlOn(
                `SELECT hex(seen_fp) AS seen, hex(chased_fp) AS chased, verdict
                 FROM identity_peers WHERE root_pubkey = '${shared}'`,
                host
            );
            return rows.filter((r) => r.seen);
        };
        const seenOnA = await settle(async () => {
            const r = await claims(undefined);
            return r.length ? r : null;
        }, 80);
        assert.ok(seenOnA, "node A recorded what node B claims about their shared persona");

        // The claim is comparable with our own holdings by construction, so once the two have
        // exchanged, what B claims IS what A holds - the same digest over the same heads.
        const converged = await settle(async () => {
            const { rows } = await sqlOn(
                `SELECT hex(seen_fp) AS seen, verdict FROM identity_peers
                 WHERE root_pubkey = '${shared}' AND seen_fp IS NOT NULL`
            );
            const ours = await frontiers(shared);
            if (!rows.length || !ours.length) return null;
            // Not asserting WHICH verdict: which side was ahead depends on who dialled first,
            // and both 'ahead' and 'behind' are the system working. Only 'unresolvable' is a
            // fault, and it must not appear between two honest nodes.
            return rows.every((r) => r.verdict !== "unresolvable") ? rows : null;
        }, 80);
        assert.ok(converged, "no honest exchange ever reads as unresolvable");
    });
});

/*
    Stale-while-revalidate on a foreign persona's page.

    A visit is the demand signal the pull model runs on, so it always means "go and look" - but
    the reader must not wait on a stranger's node to find out. What is asserted: the first sight
    of a stranger blocks (there is nothing to serve stale), a later visit answers immediately and
    says a refresh is running, and the change made on the other node arrives without anyone
    dialing by hand.
*/
(HOST_B ? describe : describe.skip)("a foreign persona goes stale, then doesn't", function () {
    this.timeout(90000);

    it("serves what it holds and revalidates behind the answer", async function () {
        // Their persona lives on node B and is served, so A can find it.
        const them = await makeUserFetch({ prefix: "farwho", host: HOST_B });
        const made = await (await them("api/identity", { method: "POST" })).json();
        const far = made.root_pubkey;
        const setName = (value) =>
            them(`api/identity/${far}/profile`, {
                method: "POST",
                body: JSON.stringify({ field: "name", value }),
            });
        await setName("Before");
        // The hint their address would carry: the node that hosts them.
        const { toBase58 } = await import("../../js/speakable.js");
        const endpoint = (await (await them("api/node")).json()).endpoint_id;
        const via = `?via=${toBase58(endpoint)}`;

        // A member on node A looks them up. The FIRST sight has nothing to serve stale, so it
        // blocks - and comes back with their name.
        const us = await makeUserFetch({ prefix: "nearwho" });
        const first = await (await us(`api/id/${far}/profile${via}`)).json();
        const nameOf = (p) => (p.fields || []).find((f) => f.field === "name")?.value;
        assert.equal(nameOf(first), "Before", "the first visit fetched them");
        assert.equal(first.refreshing, false, "nothing left running - that visit did the work");

        // They change their name on their own node.
        await setName("After");

        // Past the anti-hammer floor, a visit answers from what we hold - possibly the OLD
        // name - and starts a refresh behind it.
        await new Promise((r) => setTimeout(r, 31000));
        const stale = await (await us(`api/id/${far}/profile${via}`)).json();
        assert.equal(stale.refreshing, true, "a revalidation is running behind this answer");

        // And asking again shortly gets the new name, with nobody dialing by hand.
        const fresh = await settle(async () => {
            const p = await (await us(`api/id/${far}/profile${via}`)).json();
            return nameOf(p) === "After" ? p : null;
        }, 60);
        assert.ok(fresh, "the change reached us because looking is what triggers looking");
    });
});
