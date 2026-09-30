/*
    The network's daily actives, estimated everywhere (census.rs; Curtis, 2026-09-29: every node
    estimating "the active network DAU based on every node it has communicated with recently",
    instead of reporting to a centre). Each node sketches the personas active on it today; nodes
    that talk swap sketches and merge them by per-register maximum; a few rounds in, every node in
    the connected ring shows the same number, and it covers more than any one node saw alone.

    The rig's nodes host every persona the suite has made so far, so the numbers here are compared
    with each other, never with a constant: the sketch's own arithmetic is pinned in census.rs.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { beat, pullAndFold } = require("./beat.cjs");
const { HOST, HOST_B, HOST_C, makeFetch, sql } = require("./fetch.cjs");

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};
const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });

(HOST_B && HOST_C ? describe : describe.skip)("the network census", function () {
    this.timeout(300000);

    const hosts = [HOST, HOST_B, HOST_C];
    const census = async (host) => (await makeFetch(host)("api/node/census")).json();

    before(async function () {
        // A ring of follows - bea follows ada, cal follows bea, ada follows cal - so each node has
        // lately talked to the next.
        const people = [];
        for (const [prefix, host] of [["censada", HOST], ["censbea", HOST_B], ["censcal", HOST_C]]) {
            const who = await makeUserFetch({ prefix, host });
            const root = (await (await who("api/identity", { method: "POST" })).json()).root_pubkey;
            await who(`api/identity/${root}/serve`, { method: "POST" });
            people.push({ who, root, host });
        }
        for (let i = 0; i < 3; i++) {
            const reader = people[(i + 1) % 3];
            const author = people[i];
            if ((await reader.who(`api/id/${author.root}/profile?via=${await base58(author.who)}`)).status !== 200) this.skip();
            await j(reader.who, `api/identity/${reader.root}/private/kv/contact:${author.root}/interest`, { value: "high" }, "PUT");
            await pullAndFold(reader.host, author.root);
        }
    });

    it("every node in the ring converges on one estimate, larger than any saw alone", async () => {
        const alone = [];
        for (const host of hosts) alone.push((await census(host)).today);
        assert.ok(alone.every((n) => n > 0), `each node counts its own actives first: ${alone}`);

        let seen = [];
        for (let round = 0; round < 5; round++) {
            for (const host of hosts) await beat(host, "census");
            seen = [];
            for (const host of hosts) seen.push((await census(host)).today);
            if (seen.every((n) => n === seen[0])) break;
        }
        assert.ok(seen.every((n) => n === seen[0]), `the ring agrees: ${seen}`);
        assert.ok(seen[0] >= Math.max(...alone), `and covers at least what any one node saw alone: ${seen[0]} vs ${alone}`);

        const view = await census(HOST);
        assert.equal(view.shown, Math.max(view.today, view.yesterday), "the counter shows the larger of today and yesterday");
        assert.ok(view.history.length >= 1 && view.history.at(-1).date === new Date().toISOString().slice(0, 10), "today closes the graph");
        const { rows } = await sql("SELECT length(registers) AS n FROM census_days ORDER BY day DESC LIMIT 1", HOST);
        assert.equal(rows[0].n, 1024, "today's sketch is its registers: names nobody");
    });
});
