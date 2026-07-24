/*
    Spare-key password reset - Flow A, scratch edition (PROJECT_PLAN, Recovery Flows:
    Passwords vs. Keys; identity::recover_password for the named simplifications).

    The load-bearing behaviors under test: the right seed resets the password (old word dead,
    new word works); every pre-existing session is purged; every unprovable failure - wrong
    seed, unknown username, malformed seed, account with no personas - is the same uniform
    "recovery failed" (no enumeration); and per-identity scoping holds: a valid spare key
    presented against a multi-persona account is REFUSED (the proven-only-account rule),
    because proof of one persona must not unlock its siblings.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeFetch, HOST_B } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");

const PW = "hunter2hunter2";
const NEW_PW = "correct-horse-battery";

async function recover(fetch, username, secret, newPassword) {
    return fetch("api/auth/recover", {
        method: "POST",
        body: JSON.stringify({
            username,
            recovery_secret: secret,
            new_password: newPassword,
        }),
    });
}

describe("spare-key password reset (Flow A, scratch)", function () {
    this.timeout(30000);

    it("the right seed resets the password and purges old sessions", async function () {
        const username = `rescue${Date.now().toString(36)}`;
        const user = await makeUserFetch({ prefix: "rescue", username, password: PW });
        const created = await (await user("api/identity", { method: "POST" })).json();
        const secret = created.recovery_secret;

        // A second session that should die with the reset.
        const anon = makeFetch();
        const oldSession = await anon("api/auth/login", {
            method: "POST",
            body: JSON.stringify({ username, password: PW }),
        });
        assert.equal(oldSession.status, 200);

        const res = await recover(anon, username, secret, NEW_PW);
        assert.equal(res.status, 200);
        assert.deepEqual(
            await res.json(),
            { ok: true, rehomed: false },
            "single-persona account: in-place reset, sign-in name kept"
        );

        // The old password is dead; the new one works.
        const fresh = makeFetch();
        const oldTry = await fresh("api/auth/login", {
            method: "POST",
            body: JSON.stringify({ username, password: PW }),
        });
        assert.equal(oldTry.status, 401, "old password no longer works");
        const newTry = await fresh("api/auth/login", {
            method: "POST",
            body: JSON.stringify({ username, password: NEW_PW }),
        });
        assert.equal(newTry.status, 200, "new password works");

        // Every session from before the reset is gone - including the identity-creating one.
        const stale = await user("api/auth/whoami");
        assert.equal(stale.status, 401, "pre-reset sessions are purged");
    });

    it("every unprovable failure is the same uniform refusal", async function () {
        const username = `uniform${Date.now().toString(36)}`;
        const user = await makeUserFetch({ prefix: "uniform", username, password: PW });
        await (await user("api/identity", { method: "POST" })).json();

        const anon = makeFetch();
        const wrongSeed = "ab".repeat(32);
        const cases = [
            [username, wrongSeed, "a valid-shaped but wrong seed"],
            [username, "not hex at all", "a malformed seed"],
            ["nobody-here-by-that-name", wrongSeed, "an unknown username"],
        ];
        for (const [name, secret, label] of cases) {
            const res = await recover(anon, name, secret, NEW_PW);
            assert.equal(res.status, 401, label);
            const body = await res.json();
            assert.equal(body.message, "recovery failed", `${label}: uniform message`);
        }

        // An account with no personas has nothing to prove against - same refusal.
        const emptyName = `empty${Date.now().toString(36)}`;
        await makeUserFetch({ prefix: "empty", username: emptyName, password: PW });
        const res = await recover(anon, emptyName, wrongSeed, NEW_PW);
        assert.equal(res.status, 401);
        assert.equal((await res.json()).message, "recovery failed");

        // And the password survived all of it.
        const still = await makeFetch()("api/auth/login", {
            method: "POST",
            body: JSON.stringify({ username, password: PW }),
        });
        assert.equal(still.status, 200);
    });

    it("re-homes a persona out of a multi-persona account, leaving the rest alone", async function () {
        const username = `multi${Date.now().toString(36)}`;
        const user = await makeUserFetch({ prefix: "multi", username, password: PW });
        const first = await (await user("api/identity", { method: "POST" })).json();
        const second = await (await user("api/identity", { method: "POST" })).json();

        // Without a new name: 409, the ask-for-a-name signal (post-proof only; no side
        // effects - the old password still works after it).
        const anon = makeFetch();
        const ask = await recover(anon, username, first.recovery_secret, NEW_PW);
        assert.equal(ask.status, 409);
        const askBody = await ask.json();
        assert.equal(askBody.needs_new_username, true);
        assert.match(askBody.message, /more than one persona/);

        // With a new name: the proven persona moves into a fresh account.
        const newName = `rehomed${Date.now().toString(36)}`;
        const move = await anon("api/auth/recover", {
            method: "POST",
            body: JSON.stringify({
                username,
                recovery_secret: first.recovery_secret,
                new_password: NEW_PW,
                new_username: newName,
            }),
        });
        assert.equal(move.status, 200);
        assert.deepEqual(await move.json(), { ok: true, rehomed: true });

        // The fresh account holds exactly the proven persona.
        const fresh = makeFetch();
        const login = await fresh("api/auth/login", {
            method: "POST",
            body: JSON.stringify({ username: newName, password: NEW_PW }),
        });
        assert.equal(login.status, 200);
        const moved = await (await fresh("api/identity")).json();
        assert.deepEqual(
            moved.map((i) => i.root_pubkey),
            [first.root_pubkey],
            "the fresh account holds the proven persona, nothing else"
        );

        // The old account is untouched: original password, surviving sessions, the sibling
        // still in place - if the spare key was stolen, the victim keeps everything but the
        // persona that key already owned outright.
        const still = await makeFetch()("api/auth/login", {
            method: "POST",
            body: JSON.stringify({ username, password: PW }),
        });
        assert.equal(still.status, 200, "old password untouched");
        assert.equal((await user("api/auth/whoami")).status, 200, "old sessions untouched");
        const remaining = await (await user("api/identity")).json();
        assert.deepEqual(
            remaining.map((i) => i.root_pubkey),
            [second.root_pubkey],
            "the sibling stays on the old account"
        );

        // A taken new name fails cleanly and moves nothing.
        const third = await (await user("api/identity", { method: "POST" })).json();
        const clash = await anon("api/auth/recover", {
            method: "POST",
            body: JSON.stringify({
                username,
                recovery_secret: third.recovery_secret,
                new_password: NEW_PW,
                new_username: newName,
            }),
        });
        assert.equal(clash.status, 400);
        assert.match((await clash.json()).message, /taken/);
    });
});

// The spare key is bound to the TREE, not a node - and the tree syncs everywhere (identity
// chains: always full, always first). So the one spare key minted at creation rescues the
// account on ANY node that agents the persona: sub nodes have the same recovery story as the
// founding node, with the same single artifact.
(HOST_B ? describe : describe.skip)("spare-key reset on an adopted node", function () {
    this.timeout(60000);

    it("the day-one spare key rescues the account on a node added later", async function () {
        // Persona born on A; its one and only spare key captured at creation.
        const alice = await makeUserFetch({ prefix: "rescueA" });
        const created = await (await alice("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        // A separate account on B adopts the persona (the standard ceremony).
        const usernameB = `rescueb${Date.now().toString(36)}`;
        const aliceOnB = await makeUserFetch({
            prefix: "rescueB",
            username: usernameB,
            password: PW,
            host: HOST_B,
        });
        const request = await (
            await aliceOnB("api/identity/adopt/begin", { method: "POST" })
        ).json();
        const grant = await (
            await alice(`api/identity/${root}/nodes`, {
                method: "POST",
                body: JSON.stringify({ code: request.code }),
            })
        ).json();
        await aliceOnB("api/identity/adopt/complete", {
            method: "POST",
            body: JSON.stringify({ code: grant.code }),
        });

        // Forget B's password. The spare key was minted on A, and B has never seen it - but
        // B holds the synced key tree, so it can verify the seed all the same.
        const anonB = makeFetch(HOST_B);
        const res = await anonB("api/auth/recover", {
            method: "POST",
            body: JSON.stringify({
                username: usernameB,
                recovery_secret: created.recovery_secret,
                new_password: NEW_PW,
            }),
        });
        assert.equal(res.status, 200, "the tree-level spare key works on the adopted node");
        assert.deepEqual(await res.json(), { ok: true, rehomed: false });

        const login = await makeFetch(HOST_B)("api/auth/login", {
            method: "POST",
            body: JSON.stringify({ username: usernameB, password: NEW_PW }),
        });
        assert.equal(login.status, 200, "and B's account opens with the new password");
    });
});
