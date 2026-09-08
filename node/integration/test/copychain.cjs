/*
    Copy into private notes, and the copy chain (Curtis, 2026-09-08): a post copies into
    a private note - title, words, format, the author's own tags - carrying a PROVENANCE
    stack: the source's author and everyone the source descended from. Publishing restates
    it as one `provenance=<root>` statement per author, so A copied by B and posted, then
    copied by C and posted, credits both A and B on C's post.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch, makePng } = require("./helpers.cjs");
const { beat, pullAndFold } = require("./beat.cjs");
const { HOST, HOST_B, HOST_C } = require("./fetch.cjs");

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};
const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

(HOST_B && HOST_C ? describe : describe.skip)("the copy chain: a post copied, posted, copied and posted again credits every author", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, cal, calRoot, adaPost, beaNote, beaPost, calNote, calPost;

    const follow = async (who, root, them, viaHost) => {
        const r = await who(`api/id/${them}/profile?via=${await base58(viaHost)}`);
        if (r.status !== 200) return false;
        await j(who, `api/identity/${root}/private/kv/contact:${them}/interest`, { value: "high" }, "PUT");
        return true;
    };
    const bodyArrives = async (who, author, doc) => {
        for (let i = 0; i < 40; i++) {
            const r = await who(`id/${author}/docs/${doc}/body`);
            if (r.status === 200) return r.text();
            await wait(400);
        }
        return null;
    };
    // A note's private annotations: `{ fields, tags }` off the annotations door - `fields`
    // as pairs or a map, either way the provenance value is found the same.
    const noteLabels = async (who, root, doc) => {
        const a = await (await who(`api/identity/${root}/docs/${doc}/annotations`)).json();
        const fields = Array.isArray(a.fields) ? Object.fromEntries(a.fields) : a.fields || {};
        return { tags: a.tags || [], fields };
    };
    const provenanceOn = async (who, author, doc) =>
        ((await (await who(`api/id/${author}/posts/${doc}`)).json()).annotations || [])
            .filter((a) => a.key === "provenance" && a.annotator === author)
            .map((a) => a.value);

    before(async function () {
        ada = await makeUserFetch({ prefix: "chainada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        const d = await (await j(ada, `api/identity/${adaRoot}/docs`, { title: "Ada's loaf", body: "flour, water, salt, time", format: "marquee" })).json();
        await ada(`api/identity/${adaRoot}/docs/${d.doc_id}/annotations/tags/bread`, { method: "PUT" });
        const pub = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, {});
        const said = await pub.text();
        assert.equal(pub.status, 200, said);
        adaPost = JSON.parse(said).post_id;
        bea = await makeUserFetch({ prefix: "chainbea", host: HOST_B });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        cal = await makeUserFetch({ prefix: "chaincal", host: HOST_C });
        calRoot = (await (await cal("api/identity", { method: "POST" })).json()).root_pubkey;
        await cal(`api/identity/${calRoot}/serve`, { method: "POST" });
        if (!(await follow(bea, beaRoot, adaRoot, ada))) this.skip();
        await pullAndFold(HOST_B, adaRoot);
        assert.equal(await bodyArrives(bea, adaRoot, adaPost), "flour, water, salt, time", "ada's words reached bea's node");
    });

    it("bea copies ada's post into a new bucket: title, words, tag - and ada in the provenance", async () => {
        const r = await j(bea, `api/identity/${beaRoot}/docs/copy`, { author: adaRoot, doc_id: adaPost, bucket: "clippings", new: true });
        const said = await r.text();
        assert.equal(r.status, 200, said);
        beaNote = JSON.parse(said).doc_id;
        const note = await (await bea(`api/identity/${beaRoot}/docs/${beaNote}`)).json();
        assert.equal(note.title, "Ada's loaf");
        assert.equal(note.body, "flour, water, salt, time");
        const labels = await noteLabels(bea, beaRoot, beaNote);
        assert.ok(labels.tags.includes("bread"), `the author's tag came along: ${JSON.stringify(labels.tags)}`);
        assert.deepEqual(JSON.parse(labels.fields.provenance), [adaRoot], "ada is the provenance");
        const buckets = (await (await bea(`api/identity/${beaRoot}/docs`)).json()).docs || [];
        const mine = buckets.find((x) => x.doc_id === beaNote);
        assert.ok(mine && (mine.buckets || []).includes("clippings"), "filed in the new bucket");
    });

    it("bea posts the copy: the provenance becomes one public statement naming ada, and no chip-worthy label", async () => {
        const pub = await j(bea, `api/identity/${beaRoot}/docs/${beaNote}/publish`, {});
        const said = await pub.text();
        assert.equal(pub.status, 200, said);
        beaPost = JSON.parse(said).post_id;
        assert.deepEqual(await provenanceOn(bea, beaRoot, beaPost), [adaRoot]);
    });

    it("cal copies bea's post and posts it: ada AND bea stand in the copy chain, oldest first", async function () {
        if (!(await follow(cal, calRoot, beaRoot, bea))) this.skip();
        await pullAndFold(HOST_C, beaRoot);
        assert.equal(await bodyArrives(cal, beaRoot, beaPost), "flour, water, salt, time", "bea's copy reached cal's node");
        const r = await j(cal, `api/identity/${calRoot}/docs/copy`, { author: beaRoot, doc_id: beaPost, bucket: "clippings", new: true });
        const said = await r.text();
        assert.equal(r.status, 200, said);
        calNote = JSON.parse(said).doc_id;
        const labels = await noteLabels(cal, calRoot, calNote);
        assert.deepEqual(JSON.parse(labels.fields.provenance), [beaRoot, adaRoot], "the source's author, then whoever the source came from");
        const pub = await j(cal, `api/identity/${calRoot}/docs/${calNote}/publish`, {});
        const posted = await pub.text();
        assert.equal(pub.status, 200, posted);
        calPost = JSON.parse(posted).post_id;
        const chain = await provenanceOn(cal, calRoot, calPost);
        assert.deepEqual(chain.sort(), [adaRoot, beaRoot].sort(), "both authors credited on cal's post");
    });

    it("a picture in the post becomes the copier's own media document, with the same provenance, and the copy points at it", async () => {
        const media = await (await ada(`api/identity/${adaRoot}/docs/binary?title=plate`, { method: "POST", body: makePng(32, 32), file: true })).json();
        for (let i = 0; i < 100; i++) {
            if ((await ada(`api/identity/${adaRoot}/docs/${media.doc_id}/body`)).status === 200) break;
            await wait(400);
        }
        const d = await (await j(ada, `api/identity/${adaRoot}/docs`, { title: "with a plate", body: `look\n\n![p](/api/identity/${adaRoot}/docs/${media.doc_id}/body/p.avif)`, format: "marquee" })).json();
        let pictured = null;
        for (let i = 0; i < 60 && !pictured; i++) {
            const r = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, {});
            const tx = JSON.parse(await r.text());
            if (r.status === 200 && tx.post_id) pictured = tx.post_id;
            else await wait(500);
        }
        assert.ok(pictured, "the pictured post published");
        await pullAndFold(HOST_B, adaRoot);
        const words = await bodyArrives(bea, adaRoot, pictured);
        assert.ok(words && words.includes(`/id/${adaRoot}/docs/`), `the published body names ada's twin: ${words}`);
        const r = await j(bea, `api/identity/${beaRoot}/docs/copy`, { author: adaRoot, doc_id: pictured, bucket: "clippings" });
        const said = await r.text();
        assert.equal(r.status, 200, said);
        const copy = JSON.parse(said).doc_id;
        const note = await (await bea(`api/identity/${beaRoot}/docs/${copy}`)).json();
        const m = note.body.match(new RegExp(`/api/identity/${beaRoot}/docs/([0-9a-f]{32})/body/`));
        assert.ok(m, `the copy's words point at bea's own media: ${note.body}`);
        assert.ok(!note.body.includes(`/id/${adaRoot}/docs/`), "and no longer at ada's twin");
        let landed = false;
        for (let i = 0; i < 100 && !landed; i++) {
            landed = (await bea(`api/identity/${beaRoot}/docs/${m[1]}/body`)).status === 200;
            if (!landed) await wait(400);
        }
        assert.ok(landed, "the copied picture ingested on bea's node");
        const labels = await noteLabels(bea, beaRoot, m[1]);
        assert.deepEqual(JSON.parse(labels.fields.provenance), [adaRoot], "the picture carries the same provenance");
    });

    it("a sealed post copies for a trusted reader and refuses for anyone else - and the copy wishes to stay sealed", async () => {
        const d = await (await j(ada, `api/identity/${adaRoot}/docs`, { title: "secret loaf", body: "the starter's real name", format: "marquee" })).json();
        const pub = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, { trusted_only: true });
        const said = await pub.text();
        assert.equal(pub.status, 200, said);
        const sealedPost = JSON.parse(said).post_id;
        await pullAndFold(HOST_B, adaRoot);
        const refused = await j(bea, `api/identity/${beaRoot}/docs/copy`, { author: adaRoot, doc_id: sealedPost, bucket: "clippings" });
        assert.notEqual(refused.status, 200, "untrusted: the words are not readable, so nothing copies");
        await j(ada, `api/identity/${adaRoot}/private/kv/contact:${beaRoot}/trust`, { value: "high" }, "PUT");
        await beat(HOST, "mint", adaRoot);
        await pullAndFold(HOST_B, adaRoot);
        assert.equal(await bodyArrives(bea, adaRoot, sealedPost), "the starter's real name", "trusted: the key travelled and the words open");
        const r = await j(bea, `api/identity/${beaRoot}/docs/copy`, { author: adaRoot, doc_id: sealedPost, bucket: "clippings" });
        const copied = await r.text();
        assert.equal(r.status, 200, copied);
        const copy = JSON.parse(copied).doc_id;
        const note = await (await bea(`api/identity/${beaRoot}/docs/${copy}`)).json();
        assert.equal(note.body, "the starter's real name", "the copy is what bea could read");
        const labels = await noteLabels(bea, beaRoot, copy);
        assert.deepEqual(JSON.parse(labels.fields.provenance), [adaRoot]);
        assert.equal(labels.fields.seal, "yes", "the copy wishes to stay sealed");
        // A publish that names no wish keeps it sealed; a stranger to bea cannot see it.
        const posted = await j(bea, `api/identity/${beaRoot}/docs/${copy}/publish`, {});
        const text = await posted.text();
        assert.equal(posted.status, 200, text);
        const beaSealed = JSON.parse(text).post_id;
        const own = await (await bea(`api/id/${beaRoot}/posts/${beaSealed}?as=${beaRoot}`)).json();
        assert.equal(own.trusted_only, true, "sealed by the wish");
        const shelfForCal = await (await bea(`api/id/${beaRoot}/posts?as=${calRoot}`)).json();
        assert.ok(!(shelfForCal.posts || []).some((x) => x.doc_id === beaSealed), "and hidden from a viewer bea does not trust");
    });

    it("copying your own post adds nobody, and copying your own private note carries its chain", async () => {
        const own = await (await j(ada, `api/identity/${adaRoot}/docs/copy`, { author: adaRoot, doc_id: adaPost, bucket: "clippings", new: true })).json();
        const ownLabels = await noteLabels(ada, adaRoot, own.doc_id);
        assert.ok(!ownLabels.fields.provenance, "no provenance for your own words");
        const again = await (await j(cal, `api/identity/${calRoot}/docs/copy`, { author: calRoot, doc_id: calNote, bucket: "again", new: true, private: true })).json();
        const twice = await noteLabels(cal, calRoot, again.doc_id);
        assert.deepEqual(JSON.parse(twice.fields.provenance), [beaRoot, adaRoot], "a private copy of a copy keeps the chain");
    });
});
