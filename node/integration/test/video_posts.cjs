/*
    Video in public posts (2026-09-03): a video the ingest already crushed - here an opaque
    animated gif, which the video lane turns into silent AV1-in-WebM with a poster - bakes a
    public twin like a picture does, and under a trusted-only post the twin's body and its
    poster seal under the post key: the author and the trusted reader get video/webm, a
    stranger gets the door. The external video URL is a different road and stays refused.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");
const fs = require("node:fs");
const path = require("node:path");

const { makeUserFetch } = require("./helpers.cjs");
const { beat } = require("./beat.cjs");

const SQUIRREL = path.join(__dirname, "..", "..", "..", "sample_media", "animated_color_squirrel.gif");

describe("video posts: an already-crushed video bakes a public twin", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, dana, media, post, twin;

    before(async () => {
        ada = await makeUserFetch({ prefix: "vidada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        bea = await makeUserFetch({ prefix: "vidbea" });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        dana = await makeUserFetch({ prefix: "viddana" });
        // ada trusts bea, published - the sealed twin opens for her.
        await ada(`api/identity/${adaRoot}/private/kv/contact:${beaRoot}/trust`, {
            method: "PUT",
            body: JSON.stringify({ value: "high" }),
        });
        await beat(undefined, "mint", adaRoot);
    });

    it("the ingest turns an opaque animation into a WebM with a poster", async () => {
        const gif = fs.readFileSync(SQUIRREL);
        const queued = await (
            await ada(`api/identity/${adaRoot}/docs/binary?title=squirrel`, { method: "POST", body: gif, file: true })
        ).json();
        media = queued.doc_id;
        let body = null;
        for (let i = 0; i < 450 && !body; i++) {
            const r = await ada(`api/identity/${adaRoot}/docs/${media}/body`);
            if (r.status === 200) body = r;
            else await new Promise((res) => setTimeout(res, 400));
        }
        assert.ok(body, "the video crushed within the wait");
        assert.equal(body.headers.get("content-type"), "video/webm");
        const thumb = await ada(`api/identity/${adaRoot}/docs/${media}/thumb`);
        assert.equal(thumb.status, 200, "the video has its poster");
    });

    it("a trusted-only post embedding it publishes, and the header names a video twin", async () => {
        const made = await (
            await ada(`api/identity/${adaRoot}/docs`, {
                method: "POST",
                body: JSON.stringify({
                    title: "squirrel post",
                    body: `look at it go\n\n![squirrel](/api/identity/${adaRoot}/docs/${media}/body/squirrel.webm)`,
                    format: "marquee",
                }),
            })
        ).json();
        for (let i = 0; i < 60 && !post; i++) {
            const r = await ada(`api/identity/${adaRoot}/docs/${made.doc_id}/publish`, {
                method: "POST",
                body: JSON.stringify({ trusted_only: true }),
            });
            const t = JSON.parse(await r.text());
            assert.ok(!(t.baking || []).some((x) => x.status === "failed"), `bake failed: ${JSON.stringify(t.baking)}`);
            if (r.status === 200 && t.post_id) post = t.post_id;
            else await new Promise((res) => setTimeout(res, 500));
        }
        assert.ok(post, "the video post published");
        const head = await (await ada(`api/id/${adaRoot}/posts/${post}`)).json();
        twin = (head.refs || [])[0];
        assert.ok(twin, "the header names its twin");
        const words = await (await ada(`id/${adaRoot}/docs/${post}/body`)).text();
        assert.ok(words.includes(`/docs/${twin}/body/media.webm`), `the body names the twin as a video: ${words}`);
    });

    it("the twin is video/webm for the author and the trusted, sealed to a stranger - poster too", async () => {
        const own = await ada(`id/${adaRoot}/docs/${twin}/body`);
        assert.equal(own.status, 200, await own.clone().text());
        assert.equal(own.headers.get("content-type"), "video/webm");
        const beaBody = await bea(`id/${adaRoot}/docs/${twin}/body`);
        assert.equal(beaBody.status, 200, await beaBody.clone().text());
        assert.equal(beaBody.headers.get("content-type"), "video/webm");
        assert.equal((await bea(`id/${adaRoot}/docs/${twin}/thumb`)).status, 200, "the poster opens for the trusted");
        assert.equal((await dana(`id/${adaRoot}/docs/${twin}/body`)).status, 403, "sealed to a stranger");
        assert.equal((await dana(`id/${adaRoot}/docs/${twin}/thumb`)).status, 403, "and so is the poster");
    });

    it("an open post embedding the same video bakes a plaintext twin, served to anyone", async () => {
        const made = await (
            await ada(`api/identity/${adaRoot}/docs`, {
                method: "POST",
                body: JSON.stringify({
                    title: "squirrel, for everyone",
                    body: `![squirrel](/api/identity/${adaRoot}/docs/${media}/body/squirrel.webm)`,
                    format: "marquee",
                }),
            })
        ).json();
        let open = null;
        for (let i = 0; i < 60 && !open; i++) {
            const r = await ada(`api/identity/${adaRoot}/docs/${made.doc_id}/publish`, { method: "POST" });
            const t = JSON.parse(await r.text());
            if (r.status === 200 && t.post_id) open = t.post_id;
            else await new Promise((res) => setTimeout(res, 500));
        }
        assert.ok(open, "the open video post published");
        const head = await (await dana(`api/id/${adaRoot}/posts/${open}`)).json();
        const openTwin = (head.refs || [])[0];
        assert.ok(openTwin && openTwin !== twin, "an open post never reuses a sealed twin");
        const anyone = await dana(`id/${adaRoot}/docs/${openTwin}/body`);
        assert.equal(anyone.status, 200, await anyone.clone().text());
        assert.equal(anyone.headers.get("content-type"), "video/webm");
    });
});
