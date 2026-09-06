/*
    Trust without interest keeps the identity (Curtis, 2026-09-05). Glue trusts Lurk but does
    not follow them: Lurk's posts stay out of Glue's feed, and yet Glue's node KNOWS Lurk -
    their name and face on the bell and in a thread, their page without the sealed posts
    Lurk does not open for Glue, and Lurk's reply to Glue's own post dressed with that post's
    title. Four surfaces that used to read "not followed" as "unknown".
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

(HOST_B ? describe : describe.skip)("trust without interest: known, not followed", function () {
    this.timeout(600000);

    let glue, glueRoot, lurk, lurkRoot, gluePost, lurkReply, lurkSealed, lurkOpen;

    before(async function () {
        glue = await makeUserFetch({ prefix: "glue" });
        glueRoot = (await (await glue("api/identity", { method: "POST" })).json()).root_pubkey;
        await glue(`api/identity/${glueRoot}/serve`, { method: "POST" });
        lurk = await makeUserFetch({ prefix: "lurk", host: HOST_B });
        lurkRoot = (await (await lurk("api/identity", { method: "POST" })).json()).root_pubkey;
        await lurk(`api/identity/${lurkRoot}/serve`, { method: "POST" });
        await j(lurk, `api/identity/${lurkRoot}/profile`, { field: "name", value: "Lurk Stuck" });
        // Glue posts; Lurk follows Glue (so Lurk's node holds the post) and replies.
        const d = await (await j(glue, `api/identity/${glueRoot}/docs`, { title: "a titled post of glue's", body: "glue's words", format: "plaintext" })).json();
        gluePost = JSON.parse(await (await j(glue, `api/identity/${glueRoot}/docs/${d.doc_id}/publish`, {})).text()).post_id;
        if ((await lurk(`api/id/${glueRoot}/profile?via=${await base58(glue)}`)).status !== 200) this.skip();
        await j(lurk, `api/identity/${lurkRoot}/private/kv/contact:${glueRoot}/interest`, { value: "high" }, "PUT");
        await pullAndFold(HOST_B, glueRoot);
        const r = await (await j(lurk, `api/identity/${lurkRoot}/docs`, { title: "", body: "lurk answers", format: "plaintext" })).json();
        const pub = await j(lurk, `api/identity/${lurkRoot}/docs/${r.doc_id}/publish`, { reply_to: { author: glueRoot, doc_id: gluePost } });
        assert.equal(pub.status, 200, await pub.text());
        lurkReply = JSON.parse(await (await lurk(`api/identity/${lurkRoot}/docs/${r.doc_id}`)).text()).fields?.published_as
            || (await (await lurk(`api/id/${lurkRoot}/posts`)).json()).posts[0].doc_id;
        // Lurk also says something sealed (not for Glue) and something open.
        const s = await (await j(lurk, `api/identity/${lurkRoot}/docs`, { title: "for lurk's people", body: "sealed words", format: "plaintext" })).json();
        lurkSealed = JSON.parse(await (await j(lurk, `api/identity/${lurkRoot}/docs/${s.doc_id}/publish`, { trusted_only: true })).text()).post_id;
        const o = await (await j(lurk, `api/identity/${lurkRoot}/docs`, { title: "for everyone", body: "open words", format: "plaintext" })).json();
        lurkOpen = JSON.parse(await (await j(lurk, `api/identity/${lurkRoot}/docs/${o.doc_id}/publish`, {})).text()).post_id;
        // The comment reaches Glue by envelope (Glue follows nobody).
        await beat(HOST_B, "outbox");
    });

    it("a trust dial, and nothing else, fetches the persona: their name is known on the bell, and they are no stranger", async () => {
        const dial = await j(glue, `api/identity/${glueRoot}/private/kv/contact:${lurkRoot}/trust`, { value: "high" }, "PUT");
        assert.equal(dial.status, 200, await dial.text());
        let row = null;
        for (let i = 0; i < 30 && !(row && row.author_name); i++) {
            await beat(HOST_B, "outbox");
            const page = await (await glue(`api/identity/${glueRoot}/notifications`)).json();
            row = (page.items || []).find((n) => n.kind === "comment" && n.author === lurkRoot);
            if (!(row && row.author_name)) await new Promise((res) => setTimeout(res, 400));
        }
        assert.ok(row, "the comment notice arrived");
        assert.equal(row.author_name, "Lurk Stuck", "the bell knows their name");
        assert.ok(!row.stranger, "and does not call them a stranger");
    });

    it("their page hides the sealed post they do not open for the viewer, and shows the open one", async () => {
        const prof = await (await glue(`api/id/${lurkRoot}/profile?as=${glueRoot}`)).json();
        const ids = (prof.posts || []).map((p) => p.doc_id);
        assert.ok(ids.includes(lurkOpen), "the open post shows");
        assert.ok(!ids.includes(lurkSealed), "the sealed post is not listed at all");
        const shelf = await (await glue(`api/id/${lurkRoot}/posts?as=${glueRoot}`)).json();
        assert.ok(!(shelf.posts || []).some((p) => p.doc_id === lurkSealed), "nor on the shelf page");
        const own = await (await lurk(`api/id/${lurkRoot}/profile?as=${lurkRoot}`)).json();
        assert.ok((own.posts || []).some((p) => p.doc_id === lurkSealed), "the author still sees their own");
    });

    it("their reply on their page is dressed with the parent's title - the viewer's own post, held here", async () => {
        const shelf = await (await glue(`api/id/${lurkRoot}/posts?as=${glueRoot}`)).json();
        const reply = (shelf.posts || []).find((p) => p.reply_to && p.reply_to.doc_id === gluePost);
        assert.ok(reply, "the reply is on their shelf");
        assert.equal(reply.reply_to.title, "a titled post of glue's", "the parent's card carries its title");
    });

    it("the thread under the viewer's post names the replier", async () => {
        let thread = {};
        for (let i = 0; i < 20 && !((thread.bylines || {})[lurkRoot] || {}).name; i++) {
            thread = await (await glue(`api/id/${glueRoot}/posts/${gluePost}/replies?refresh=1`)).json();
            if (!((thread.bylines || {})[lurkRoot] || {}).name) await new Promise((res) => setTimeout(res, 400));
        }
        assert.ok((thread.replies || []).some((r) => r.author === lurkRoot), "the trusted replier's reply is listed - known, not held for the nod");
        assert.equal(((thread.bylines || {})[lurkRoot] || {}).name, "Lurk Stuck", "the thread knows who answered");
    });
});
