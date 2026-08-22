/*
    The speculative pass at posts depth (DISCOVERY.md slice 1, 2026-08-21).

    The design under test: a reader's implicit edges (trust.cjs proves those) roll up into a
    node-level speculative-demand memo - top-K targets per reader, best introducer alongside -
    and a quiet acquisition pass pulls each admitted stranger's public chains THROUGH THE
    INTRODUCER's endpoints, never the stranger's own machinery when an introducer path exists.
    The mirror is quiet: no serving record, no directory row, no foreign_fetches row - it
    serves nobody but the node's own members, and freshness is our own slow beat.

    The choreography here: an author cora never dialed, on a node cora was never told about,
    UNSERVED (no serving record anywhere - the author's own machinery is unreachable-by-root,
    which is the "author goes dark" case built into the topology rather than staged). The
    friend follows and publicly vouches for the author; cora trusts the friend; the author's
    post must appear on cora's node with nobody at cora's end asking - and the author's node
    must never hear from cora's node at all: the mirror came through the friend.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeFetch, sql, HOST, HOST_B, HOST_C } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");

const settle = async (fn, tries = 240) => {
    for (let i = 0; i < tries; i++) {
        const got = await fn();
        if (got) return got;
        await new Promise((r) => setTimeout(r, 250));
    }
    return null;
};

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};

(HOST_B && HOST_C ? describe : describe.skip)("the speculative pass at posts depth", function () {
    this.timeout(1200000);

    let author, authorRoot, friend, friendRoot, cora, coraRoot;

    const dialOn = (who, root) => async (subject, register, value) =>
        who(`api/identity/${root}/private/kv/contact:${subject}/${register}`, {
            method: "PUT",
            body: JSON.stringify({ value }),
        });

    before(async function () {
        // The author: hosted on A, and deliberately NEVER served - no serving record exists
        // anywhere, so no ladder can resolve them by root. The only path to their chains is a
        // node that already mirrors them.
        author = await makeUserFetch({ prefix: "specauthor" });
        authorRoot = (await (await author("api/identity", { method: "POST" })).json()).root_pubkey;

        friend = await makeUserFetch({ prefix: "specfriend", host: HOST_B });
        friendRoot = (await (await friend("api/identity", { method: "POST" })).json()).root_pubkey;
        await friend(`api/identity/${friendRoot}/serve`, { method: "POST" });

        cora = await makeUserFetch({ prefix: "speccora", host: HOST_C });
        coraRoot = (await (await cora("api/identity", { method: "POST" })).json()).root_pubkey;
        await cora(`api/identity/${coraRoot}/serve`, { method: "POST" });
    });

    it("a vouched-for stranger's post arrives through the friend, quietly", async function () {
        // The author says something before anyone downstream has ever heard of them.
        const made = await (
            await author(`api/identity/${authorRoot}/docs`, {
                method: "POST",
                body: JSON.stringify({
                    title: "the-unasked-for-post",
                    body: "words nobody at cora's node asked for",
                    format: "plaintext",
                }),
            })
        ).json();
        const pub = await author(`api/identity/${authorRoot}/docs/${made.doc_id}/publish`, {
            method: "POST",
        });
        assert.equal(pub.status, 200, await pub.text());

        // The friend meets the author (explicit endpoint hint - the author is unresolvable
        // by root). No dials yet: the vouch waits until cora's node is an ASKER of the
        // friend's, so the mint's push reaches her node instead of a slow backstop - the
        // race lost by 300ms on 2026-08-21, when the vouch minted before her ask landed.
        const viaAuthor = await base58(author);
        if ((await friend(`api/id/${authorRoot}/profile?via=${viaAuthor}`)).status !== 200)
            this.skip();

        // Cora meets the friend and dials trust high - the friend becomes an introducer. She
        // never dials, names, or learns an address for the author.
        const viaFriend = await base58(friend);
        if ((await cora(`api/id/${friendRoot}/profile?via=${viaFriend}`)).status !== 200)
            this.skip();
        const coraDial = dialOn(cora, coraRoot);
        await coraDial(friendRoot, "trust", "high");
        await coraDial(friendRoot, "interest", "high");

        // NOW the friend follows and vouches publicly: trust=high mints a PublicEdge
        // statement on the follows-public chain (edges_public rests open), and the mint's
        // own push carries it to every node that asked - cora's included.
        const friendDial = dialOn(friend, friendRoot);
        await friendDial(authorRoot, "interest", "high");
        await friendDial(authorRoot, "trust", "high");

        // Stage 1, demand: the implicit row (cora's trust x the friend's published band)
        // rolls up into the node-level speculative-demand memo, best introducer alongside.
        const demand = await settle(async () => {
            const { rows } = await sql(
                `SELECT introducer_root, level FROM speculative_demand
                 WHERE reader_root = '${coraRoot}' AND target_root = '${authorRoot}'`,
                HOST_C
            );
            return rows.length ? rows[0] : null;
        });
        assert.ok(demand, "the speculative rollup admitted the vouched-for author");
        assert.equal(demand.introducer_root, friendRoot, "the best introducer rides the memo");

        // Stage 2, acquisition: the quiet pull through the introducer's endpoints. The post
        // appears on cora's node without cora following anyone.
        assert.ok(
            await settle(async () => {
                const { rows } = await sql(
                    `SELECT fetched_at_ms FROM speculative_fetches WHERE target_root = '${authorRoot}'`,
                    HOST_C
                );
                return rows.length ? true : null;
            }),
            "the acquisition pass minted a quiet mirror of the author"
        );

        // The post still serves - to cora, from her own node, with the author's machinery
        // unreachable (it always was: no serving record, no hint ever handed to this node).
        const profile = await settle(async () => {
            const res = await cora(`api/id/${authorRoot}/profile`);
            if (res.status !== 200) return null;
            const body = await res.json();
            const titles = (body.posts || []).map((p) => p.title);
            return titles.includes("the-unasked-for-post") ? body : null;
        });
        assert.ok(profile, "the mirrored post serves to the reader whose trust admitted it");

        // Quiet means quiet: the mirror is not in foreign_fetches (the member-visit registry
        // that opens the sync door and the directory) - speculative mirrors serve nobody.
        const { rows: loud } = await sql(
            `SELECT 1 AS present FROM foreign_fetches WHERE root_pubkey = '${authorRoot}'`,
            HOST_C
        );
        assert.equal(loud.length, 0, "the speculative mirror stays out of the served registries");

        // Disclosure stays in-relationship: the author's own node never heard from cora's.
        // The friend's node asked it (that is the friend's own follow at work); cora's node
        // must be absent from its demand ledger.
        const coraEndpoint = (await (await makeFetch(HOST_C)("api/node")).json()).endpoint_id;
        const { rows: asks } = await sql(
            `SELECT endpoint_id FROM identity_demand WHERE root_pubkey = '${authorRoot}'`,
            HOST
        );
        assert.ok(
            !asks.some((r) => r.endpoint_id === coraEndpoint),
            "the stranger's node never learned cora's node exists"
        );
    });

    it("a withdrawn vouch recedes from the demand memo (the mirror waits for slice 4)", async function () {
        // The friend takes the vouch back; the graph row sweeps (trust.cjs proves that leg),
        // and the rollup built on it must recede with its inputs. The mirror itself stays -
        // nothing today evicts a mirrored persona; that gap is DISCOVERY slice 4, on purpose.
        await dialOn(friend, friendRoot)(authorRoot, "trust", "");
        assert.ok(
            await settle(async () => {
                const { rows } = await sql(
                    `SELECT 1 AS present FROM speculative_demand
                     WHERE reader_root = '${coraRoot}' AND target_root = '${authorRoot}'`,
                    HOST_C
                );
                return rows.length === 0 ? true : null;
            }),
            "the demand row receded with the vouch that justified it"
        );
    });
});
