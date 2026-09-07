/*
    Search (2026-09-07): the feed's and a person's page's `?q=` answer over the WHOLE
    journal and the WHOLE held shelf (search.rs) - every term a prefix of some word in the
    title or the body, bodies indexed as the node meets them. A sealed post is found only
    by a viewer the author trusts; a post whose body has not arrived matches on its title.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { beat, pullAndFold } = require("./beat.cjs");
const { HOST_B } = require("./fetch.cjs");

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};
const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

(HOST_B ? describe : describe.skip)("search: the whole journal and the whole shelf, by their words", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, bread, ride, sealed;

    const post = async (title, body, flags = {}) => {
        const d = await (await j(ada, `api/identity/${adaRoot}/docs`, { title, body, format: "marquee" })).json();
        const pub = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, flags);
        const said = await pub.text();
        assert.equal(pub.status, 200, said);
        return JSON.parse(said).post_id;
    };
    const ids = (page) => (page.items || page.posts || []).map((p) => p.doc_id);

    before(async function () {
        ada = await makeUserFetch({ prefix: "searchada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        bread = await post("Bread Day", "the sourdough rose overnight and the crust sang");
        ride = await post("", "a quiet bicycle ride along the canal at dusk");
        sealed = await post("Pudding", "the sealed pudding recipe, for friends only", { trusted_only: true });
        bea = await makeUserFetch({ prefix: "searchbea", host: HOST_B });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        if ((await bea(`api/id/${adaRoot}/profile?via=${await base58(ada)}`)).status !== 200) this.skip();
        await j(bea, `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`, { value: "high" }, "PUT");
        await pullAndFold(HOST_B, adaRoot);
        // The words follow the headers on the bodies sweep: wait for them on bea's node.
        for (let i = 0; i < 40; i++) {
            const r = await bea(`id/${adaRoot}/docs/${ride}/body`);
            if (r.status === 200) break;
            await wait(400);
        }
    });

    it("the author's own feed finds a post by a word in its body, by a prefix, and by two terms - and not by a word nobody said", async () => {
        assert.deepEqual(ids(await (await ada(`api/identity/${adaRoot}/feed?q=sourdough`)).json()), [bread]);
        assert.deepEqual(ids(await (await ada(`api/identity/${adaRoot}/feed?q=bicy`)).json()), [ride], "a prefix");
        assert.deepEqual(ids(await (await ada(`api/identity/${adaRoot}/feed?q=quiet%20canal`)).json()), [ride], "every term");
        assert.deepEqual(ids(await (await ada(`api/identity/${adaRoot}/feed?q=cake`)).json()), []);
        assert.deepEqual(ids(await (await ada(`api/identity/${adaRoot}/feed?q=pudding`)).json()), [sealed], "the author sees their own sealed post");
    });

    it("a follower's feed on another node finds the words once they have arrived, and never the sealed post", async () => {
        let found = [];
        for (let i = 0; i < 20 && found.length === 0; i++) {
            found = ids(await (await bea(`api/identity/${beaRoot}/feed?q=crust`)).json());
            if (found.length === 0) await wait(400);
        }
        assert.deepEqual(found, [bread], "the body's word, over the journal");
        assert.deepEqual(ids(await (await bea(`api/identity/${beaRoot}/feed?q=pudding`)).json()), [], "sealed: not in bea's feed");
    });

    it("a person's page finds their words over the whole held shelf, and hides the sealed post from a viewer they do not trust", async () => {
        assert.deepEqual(ids(await (await bea(`api/id/${adaRoot}/posts?q=canal&as=${beaRoot}`)).json()), [ride]);
        assert.deepEqual(ids(await (await bea(`api/id/${adaRoot}/posts?q=pudding&as=${beaRoot}`)).json()), [], "sealed, and bea is not trusted");
        assert.deepEqual(ids(await (await ada(`api/id/${adaRoot}/posts?q=pudding&as=${adaRoot}`)).json()), [sealed], "the author finds their own");
        const page = await (await ada(`api/id/${adaRoot}/posts?q=the&as=${adaRoot}`)).json();
        assert.equal(page.more, false, "a search is one deep page, no cursor");
        // 'the' is in every body, but a sealed post's words are sealed at rest - the index
        // knows only its title - so two of the three answer.
        assert.deepEqual(ids(page).sort(), [bread, ride].sort(), "'the' is in every open body; the sealed one indexes by title alone");
    });

    it("the title stands in for words that have not arrived, and the index beat walks the backlog", async () => {
        const titled = await post("Marmalade Morning", "oranges, boiled");
        // Before any pull, bea's node has no such post; after the pull the header is here
        // and the title matches before the body does.
        await pullAndFold(HOST_B, adaRoot);
        let found = [];
        for (let i = 0; i < 20 && found.length === 0; i++) {
            found = ids(await (await bea(`api/identity/${beaRoot}/feed?q=marmalade`)).json());
            if (found.length === 0) await wait(400);
        }
        assert.deepEqual(found, [titled], "the title matched");
        await beat(HOST_B, "search-index");
    });
});
