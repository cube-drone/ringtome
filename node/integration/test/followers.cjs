/*
    Who follows you (2026-09-28, Curtis: "how many users do I know (or think) are publicly
    subscribed to me"). Your own page says three things, to you alone: public follows from the
    chains this node holds (exact, and how many of them are people you know), follows that others
    told you about by notice (a stranger's unfollow never arrives, so it only climbs), and the
    computers that fetched you lately - a pill beside your picture. Anyone else's page says who
    among the people YOU know trusts them, then who follows them without trusting - small user
    widgets after your relationship, never a count of strangers.

    Ada is followed by bea (who she follows back) and by dee (a stranger on her own node), and -
    from another node, whose chain hers does not hold - by eve, whose follow arrives as a notice;
    eve's node reads ada's page, so a computer has fetched her. Cal, on ada's node, knows bea.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { beat } = require("./beat.cjs");
const { HOST, HOST_B } = require("./fetch.cjs");

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};
const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

(HOST_B ? describe : describe.skip)("who follows you: your counts, and the people you know", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, cal, calRoot, dee, deeRoot, eve, eveRoot;
    const persona = async (prefix, host) => {
        const who = await makeUserFetch({ prefix, host });
        const root = (await (await who("api/identity", { method: "POST" })).json()).root_pubkey;
        await who(`api/identity/${root}/serve`, { method: "POST" });
        return [who, root];
    };
    const dial = (who, root, them, key, value) => j(who, `api/identity/${root}/private/kv/contact:${them}/${key}`, { value }, "PUT");
    const counts = async () => (await (await ada(`api/identity/${adaRoot}/followers`)).json());

    before(async function () {
        [ada, adaRoot] = await persona("folada", HOST);
        [bea, beaRoot] = await persona("folbea", HOST);
        [cal, calRoot] = await persona("folcal", HOST);
        [dee, deeRoot] = await persona("foldee", HOST);
        [eve, eveRoot] = await persona("foleve", HOST_B);
        // Public follows of ada: bea and dee here, eve from afar - each a published edge (mint).
        await dial(bea, beaRoot, adaRoot, "interest", "high");
        await dial(dee, deeRoot, adaRoot, "interest", "medium");
        if ((await eve(`api/id/${adaRoot}/profile?via=${await base58(ada)}`)).status !== 200) this.skip();
        await dial(eve, eveRoot, adaRoot, "interest", "high");
        for (const root of [beaRoot, deeRoot]) {
            await beat(HOST, "mint", root);
            await beat(HOST, "fold", root);
        }
        await beat(HOST_B, "mint", eveRoot);
        await beat(HOST_B, "outbox");
        // Ada follows bea back; cal knows bea.
        await dial(ada, adaRoot, beaRoot, "interest", "high");
        await dial(cal, calRoot, beaRoot, "trust", "high");
    });

    it("your own page counts public follows exactly, the ones you were told of, and the computers reading you", async () => {
        let n = {};
        for (let i = 0; i < 30; i++) {
            n = await counts();
            if (n.follow_you >= 2 && n.told_you >= 1 && n.computers >= 1) break;
            await beat(HOST, "fold", beaRoot);
            await beat(HOST, "fold", deeRoot);
            await beat(HOST_B, "outbox");
            await wait(400);
        }
        assert.equal(n.follow_you, 2, `bea and dee, from chains this node holds: ${JSON.stringify(n)}`);
        assert.equal(n.you_know, 1, "bea, whom ada follows back; dee is a stranger");
        assert.equal(n.told_you, 1, "eve, by notice - her chain is not held here");
        assert.ok(n.computers >= 1, `eve's node fetched ada's page: ${JSON.stringify(n)}`);
    });

    it("an unfollow from a chain this node holds leaves the exact count", async () => {
        await dial(dee, deeRoot, adaRoot, "interest", "none");
        let n = {};
        for (let i = 0; i < 20; i++) {
            await beat(HOST, "mint", deeRoot);
            await beat(HOST, "fold", deeRoot);
            n = await counts();
            if (n.follow_you === 1) break;
            await wait(300);
        }
        assert.equal(n.follow_you, 1, `dee's follow withdrawn, only bea's stands: ${JSON.stringify(n)}`);
    });

    it("the counts are ada's alone", async () => {
        const nosy = await cal(`api/identity/${adaRoot}/followers`);
        assert.ok(nosy.status >= 400, `another account may not read ada's counts: ${nosy.status}`);
    });

    it("someone else's page names the people you know who trust them, then who follow without trusting - and no strangers", async () => {
        const known = async (who, root) => (await (await who(`api/identity/${root}/known-followers/${adaRoot}`)).json());
        let k = await known(cal, calRoot);
        assert.deepEqual(k.followed.people, [beaRoot], `cal knows bea, who follows ada; not dee or eve: ${JSON.stringify(k)}`);
        assert.equal(k.trusted.count, 0);
        // Bea trusts ada too: said once, under trust - the weightier claim.
        await dial(bea, beaRoot, adaRoot, "trust", "medium");
        for (let i = 0; i < 20; i++) {
            await beat(HOST, "mint", beaRoot);
            await beat(HOST, "fold", beaRoot);
            k = await known(cal, calRoot);
            if (k.trusted.count === 1) break;
            await wait(300);
        }
        assert.deepEqual(k.trusted.people, [beaRoot], `bea now trusts ada: ${JSON.stringify(k)}`);
        assert.equal(k.followed.count, 0, "and is not said again under follows");
        const none = await known(dee, deeRoot);
        assert.equal(none.trusted.count + none.followed.count, 0, "dee knows nobody who trusts or follows ada");
    });
});
