/*
    Publication: the moment a note becomes a post (NOTES_APP, Publication).

    Copy, don't flip - publishing MINTS a new artifact on the public lane, so the post has a
    new doc_id, the note keeps its private history, and no bit anywhere could have been
    toggled instead. Re-publishing is another explicit act and lands as a further version of
    the same post. A diverged note is refused rather than shipped with its conflict.
*/
const assert = require("node:assert");
const { makeFetch, sql } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");
const { beat } = require("./beat.cjs");

const anon = makeFetch();

let owner, root, noteId, postId;

before(async () => {
    owner = await makeUserFetch({ prefix: "publish" });
    const made = await (await owner("api/identity", { method: "POST" })).json();
    root = made.root_pubkey;
    const note = await (
        await owner(`api/identity/${root}/docs`, {
            method: "POST",
            body: JSON.stringify({
                title: "On Boats",
                body: "boats are good, actually",
                format: "marquee",
            }),
        })
    ).json();
    noteId = note.doc_id;
});

describe("publication", () => {
    it("mints a NEW artifact - the post is not the note", async () => {
        const resp = await owner(`api/identity/${root}/docs/${noteId}/publish`, { method: "POST" });
        const text = await resp.text();
        assert.equal(resp.status, 200, text);
        postId = JSON.parse(text).post_id;
        assert.notEqual(postId, noteId, "copy, don't flip: a post is its own document");
    });

    it("puts the post on the public face, for anyone", async () => {
        const prof = await (await anon(`api/id/${root}/profile`)).json();
        const post = prof.posts.find((p) => p.doc_id === postId);
        assert.ok(post, "the post is listed publicly");
        assert.equal(post.title, "On Boats");
        assert.equal(post.format, "marquee");
    });

    it("serves the post's words to a stranger, at the identity-rooted path", async () => {
        const body = await anon(`id/${root}/docs/${postId}/body`);
        assert.equal(body.status, 200);
        assert.equal(await body.text(), "boats are good, actually");
    });

    it("leaves the NOTE private - the membrane held", async () => {
        // The note keeps its own id, stays in the workspace, and its body is not public.
        const list = await (await owner(`api/identity/${root}/docs`)).json();
        const docs = Array.isArray(list) ? list : list.docs || [];
        assert.ok(docs.some((d) => d.doc_id === noteId), "the note is still yours to edit");
        assert.ok(!docs.some((d) => d.doc_id === postId), "the post is not in the workspace");
        const leak = await anon(`id/${root}/docs/${noteId}/body`);
        assert.equal(leak.status, 404, "the note's own body stays behind the membrane");
    });

    it("re-publishing extends the same post rather than minting a stranger", async () => {
        const before = await (await owner(`api/identity/${root}/docs/${noteId}`)).json();
        await owner(`api/identity/${root}/docs/${noteId}`, {
            method: "PUT",
            body: JSON.stringify({
                title: "On Boats",
                body: "boats are good, actually - and canoes",
                format: "marquee",
                parents: before.save_parents,
            }),
        });
        const again = await owner(`api/identity/${root}/docs/${noteId}/publish`, { method: "POST" });
        const againText = await again.text();
        assert.equal(again.status, 200, againText);
        assert.equal(JSON.parse(againText).post_id, postId, "the same post, a further version");

        const prof = await (await anon(`api/id/${root}/profile`)).json();
        assert.equal(
            prof.posts.filter((p) => p.doc_id === postId).length,
            1,
            "one post, not two"
        );
        const body = await anon(`id/${root}/docs/${postId}/body`);
        assert.match(await body.text(), /canoes/, "the world sees the newer words");
    });

    it("serves edited words immediately - revalidation, never a year of immutable", async () => {
        // The body URL names the DOCUMENT, which edits; only the blob under it is content-
        // addressed. This route once sent `immutable, max-age=1y`, so a browser held every
        // edited post stale until a hard refresh. The contract now: no-cache + the blob hash
        // as ETag - unchanged bodies cost a 304, edited ones arrive at once.
        const first = await anon(`id/${root}/docs/${postId}/body`);
        assert.equal(first.status, 200);
        const cc = first.headers.get("cache-control") || "";
        assert.ok(!cc.includes("immutable"), `cache-control must not be immutable: ${cc}`);
        const etag = first.headers.get("etag");
        assert.ok(etag, "the blob hash rides as the ETag");
        const again = await anon(`id/${root}/docs/${postId}/body`, {
            headers: { "If-None-Match": etag },
        });
        assert.equal(again.status, 304, "an unchanged body costs nothing");
    });

    it("says nothing new when nothing changed - the chain does not grow", async () => {
        const before = await (await owner(`api/identity/${root}/entries?limit=500`)).json();
        const count = (e) => e.items.length;
        const resp = await owner(`api/identity/${root}/docs/${noteId}/publish`, { method: "POST" });
        const text = await resp.text();
        assert.equal(resp.status, 200, text);
        assert.equal(JSON.parse(text).post_id, postId, "still the same post");
        const after = await (await owner(`api/identity/${root}/entries?limit=500`)).json();
        assert.equal(count(after), count(before), "a re-post of identical words writes nothing");
    });

    it("dates a post by when it was FIRST said, and re-saying it doesn't move it", async () => {
        const owner3 = await makeUserFetch({ prefix: "dated" });
        const id = await (await owner3("api/identity", { method: "POST" })).json();
        const who = id.root_pubkey;
        const ids = [];
        for (const t of ["oldest", "middle", "newest"]) {
            const d = await (
                await owner3(`api/identity/${who}/docs`, {
                    method: "POST",
                    body: JSON.stringify({ title: t, body: t, format: "plaintext" }),
                })
            ).json();
            await owner3(`api/identity/${who}/docs/${d.doc_id}/publish`, { method: "POST" });
            ids.push(d.doc_id);
            await new Promise((r) => setTimeout(r, 1100)); // distinct claimed stamps
        }
        await beat(undefined, "fold", who); // the publish's fold, run to completion
        const before = await (await owner3(`api/id/${who}/profile`)).json();
        assert.deepEqual(
            before.posts.map((p) => p.title),
            ["newest", "middle", "oldest"],
            "newest first, by when each was said"
        );
        const oldestDate = before.posts[2].published_ms;

        // Now EDIT and re-publish the oldest one. It has new words; it is not a new post.
        const cur = await (await owner3(`api/identity/${who}/docs/${ids[0]}`)).json();
        await owner3(`api/identity/${who}/docs/${ids[0]}`, {
            method: "PUT",
            body: JSON.stringify({
                title: "oldest",
                body: "oldest, revised",
                format: "plaintext",
                parents: cur.save_parents,
            }),
        });
        const again = await owner3(`api/identity/${who}/docs/${ids[0]}/publish`, { method: "POST" });
        assert.equal(again.status, 200, await again.text());

        await beat(undefined, "fold", who);
        const after = await (await owner3(`api/id/${who}/profile`)).json();
        assert.deepEqual(
            after.posts.map((p) => p.title),
            ["newest", "middle", "oldest"],
            "editing did not jump it to the top"
        );
        const revised = after.posts.find((p) => p.title === "oldest");
        assert.equal(revised.published_ms, oldestDate, "and its date is still the day it was said");
        assert.ok(revised.updated_ms > revised.published_ms, "while its update stamp moved");
    });

    it("pages down the shelf with a keyset cursor, never repeating or skipping", async function () {
        // 23 sequential publish round-trips are not a 5s operation on CI hardware: this test
        // held the suite's default budget until 2026-08-23, when it became the only red in two
        // otherwise-green CI runs (7a7104c, 36a06cf) - 1.1s on a dev machine, past 5s on a
        // cold, busy runner whose rig beats compete for 4 vCPUs. A cap, not pacing.
        this.timeout(30000);
        // A shelf longer than one page: 23 posts, so page one is 20 and page two is the rest.
        const owner2 = await makeUserFetch({ prefix: "shelf" });
        const id = await (await owner2("api/identity", { method: "POST" })).json();
        const shelf = id.root_pubkey;
        for (let i = 0; i < 23; i++) {
            const d = await (
                await owner2(`api/identity/${shelf}/docs`, {
                    method: "POST",
                    body: JSON.stringify({ title: `post ${i}`, body: `words ${i}`, format: "plaintext" }),
                })
            ).json();
            const r = await owner2(`api/identity/${shelf}/docs/${d.doc_id}/publish`, { method: "POST" });
            assert.equal(r.status, 200, await r.text());
        }

        const firstResp = await owner2(`api/id/${shelf}/profile`);
        const firstText = await firstResp.text();
        assert.equal(firstResp.status, 200, firstText);
        const first = JSON.parse(firstText);
        assert.equal(first.posts.length, 20, "the profile carries one page, not the whole shelf");
        assert.equal(first.posts_more, true, "and says the shelf goes further back");

        const last = first.posts[first.posts.length - 1];
        const nextResp = await owner2(
            `api/id/${shelf}/posts?after_ms=${last.published_ms}&after_doc=${last.doc_id}`
        );
        const nextText = await nextResp.text();
        assert.equal(nextResp.status, 200, nextText);
        const next = JSON.parse(nextText);
        assert.equal(next.posts.length, 3, "the rest of the shelf");
        assert.equal(next.more, false, "and nothing behind it");

        // The two pages together are the whole shelf exactly once.
        const ids = [...first.posts, ...next.posts].map((p) => p.doc_id);
        assert.equal(new Set(ids).size, 23, "no post appears on both pages, and none is skipped");
    });

    it("calls a malformed cursor what it is, rather than blaming the persona", async () => {
        // The width of a document id is not obvious (16 bytes, not 32), and the first version
        // of this endpoint answered "no such persona here" to every real cursor it was handed.
        const resp = await owner(`api/id/${root}/posts?after_ms=1&after_doc=beef`);
        assert.equal(resp.status, 400, "a bad cursor is a bad request");
        assert.match(await resp.text(), /cursor/, "and the message points at the cursor");
    });

    it("refuses to page a persona this node doesn't carry", async () => {
        const nobody = "sway-broke-" + "11".repeat(32);
        assert.equal((await anon(`api/id/${nobody}/posts`)).status, 404);
    });

    it("bakes an embedded EXTERNAL image before the post can exist", async function () {
        this.timeout(60000);
        // "The open web": one PNG on loopback, allowed only under LOCAL_TEST.
        const http = require("node:http");
        const fs = require("node:fs");
        const png = fs.readFileSync(require("node:path").join(__dirname, "../../../sample_media/bowie_comic.png"));
        const web = http.createServer((req, res) => {
            res.writeHead(200, { "Content-Type": "image/png" });
            res.end(png);
        });
        await new Promise((r) => web.listen(8125, "127.0.0.1", r));
        try {
            const note = await (
                await owner(`api/identity/${root}/docs`, {
                    method: "POST",
                    body: JSON.stringify({
                        title: "Bakes",
                        body: "![pic](http://127.0.0.1:8125/x.png)",
                        format: "marquee",
                    }),
                })
            ).json();
            const first = await owner(`api/identity/${root}/docs/${note.doc_id}/publish`, {
                method: "POST",
            });
            const firstBody = JSON.parse(await first.text());
            assert.equal(first.status, 202, "the post does not exist until its media does");
            assert.equal(firstBody.baking[0].kind, "external");

            let postId = null;
            for (let i = 0; i < 100 && !postId; i++) {
                const r = await owner(`api/identity/${root}/docs/${note.doc_id}/publish`, {
                    method: "POST",
                });
                const b = JSON.parse(await r.text());
                if (r.status === 200) postId = b.post_id;
                assert.ok(
                    !(b.baking || []).some((x) => x.status === "failed"),
                    `bake failed: ${JSON.stringify(b.baking)}`
                );
                await new Promise((rr) => setTimeout(rr, 500));
            }
            assert.ok(postId, "the bake landed and the post minted");

            const body = await (await anon(`id/${root}/docs/${postId}/body`)).text();
            assert.ok(!body.includes("127.0.0.1:8125"), "the public body no longer leans on the web");
            const target = body.match(/\]\((\/ringtome\/user\/[^)]+)\)/)[1];
            const media = await anon(target.slice(1));
            assert.equal(media.status, 200, "the baked bytes serve to a stranger");
            assert.equal(media.headers.get("content-type"), "image/avif", "crushed like any upload");

            // The bake just minted a media DOCUMENT on the public lane - same lane as the
            // post. The shelf must list the post and not the ingredient: a media row in a
            // feed renders its bytes as text ("ftypavifmif1miaf..." - the field version).
            const mediaId = target.match(/\/doc\/([0-9a-f]+)\/body/)[1];
            const prof = await (await anon(`api/id/${root}/profile`)).json();
            assert.ok(
                prof.posts.some((p) => p.doc_id === postId),
                "the post is on the shelf"
            );
            assert.ok(
                !prof.posts.some((p) => p.doc_id === mediaId),
                "the media document is not - ingredients are linked, never listed"
            );
            for (const p of prof.posts)
                assert.ok(
                    p.format === "marquee" || p.format === "plaintext",
                    `only text formats are posts, got ${p.format}`
                );
        } finally {
            web.close();
        }
    });

    it("refuses to publish a diverged note - the conflict is nobody's intent", async () => {
        const forked = await (
            await owner(`api/identity/${root}/docs`, {
                method: "POST",
                body: JSON.stringify({ title: "Split", body: "one", format: "plaintext" }),
            })
        ).json();
        const first = await (await owner(`api/identity/${root}/docs/${forked.doc_id}`)).json();
        // Two saves claiming the SAME parent: a deliberate fork, the shape a second computer
        // makes by accident.
        for (const words of ["left words", "right words"]) {
            const r = await owner(`api/identity/${root}/docs/${forked.doc_id}`, {
                method: "PUT",
                body: JSON.stringify({
                    title: "Split",
                    body: words,
                    format: "plaintext",
                    parents: first.save_parents,
                }),
            });
            assert.equal(r.status, 200, "the fork's saves must land, or nothing is diverged");
        }
        const split = await (await owner(`api/identity/${root}/docs/${forked.doc_id}`)).json();
        assert.equal(split.diverged, true, "two heads, as arranged");
        const resp = await owner(`api/identity/${root}/docs/${forked.doc_id}/publish`, {
            method: "POST",
        });
        assert.equal(resp.status, 400);
        assert.match(await resp.text(), /diverged/, "and it says why");
    });
});

/*
    The other direction: taking a post down, and what that leaves the author holding.

    A tombstone is final for the POST's id - the recourse for a typo is delete-and-repost under
    a new one (PROJECT_PLAN, *Retraction, edits, and what a node must remember forever*). Which
    is only a recourse if the machinery agrees: `publish` reuses whatever id `published_as`
    names, so an unpublish that left the annotation standing made the canonical recovery path
    mint versions into the buried id - a 200 nobody would ever see. Found by reading on
    2026-08-13; became urgent the day the take-it-down button became reachable.
*/
describe("taking it down, and saying it again", () => {
    let note, post;

    before(async () => {
        const made = await (
            await owner(`api/identity/${root}/docs`, {
                method: "POST",
                body: JSON.stringify({
                    title: "Regrets",
                    body: "posted in haste",
                    format: "marquee",
                }),
            })
        ).json();
        note = made.doc_id;
        const pub = await owner(`api/identity/${root}/docs/${note}/publish`, { method: "POST" });
        const text = await pub.text();
        assert.equal(pub.status, 200, text);
        post = JSON.parse(text).post_id;
    });

    it("takes the post off the public face - the listing AND the direct URL", async () => {
        // The direct URL is the half a listing filter cannot cover: anyone who ever loaded
        // the post holds its address, and "off the shelf" that kept answering at the door
        // would be a takedown in name only. Both held the words until 2026-08-14 - the
        // takedown cleared every reader's feed on the network while the author's own node
        // kept listing AND serving it, because `public_docs` and `public_head` never
        // subtracted `public_retractions`. Found by this test's first run.
        const before = await anon(`id/${root}/docs/${post}/body`);
        assert.equal(before.status, 200, "precondition: the words were served to anyone");

        const down = await owner(`api/identity/${root}/posts/${post}`, { method: "DELETE" });
        assert.equal(down.status, 200, await down.text());

        const prof = await (await anon(`api/id/${root}/profile`)).json();
        assert.ok(
            !prof.posts.some((p) => p.doc_id === post),
            "the shelf no longer offers it"
        );
        const after = await anon(`id/${root}/docs/${post}/body`);
        assert.equal(after.status, 404, "and the direct URL answers absence, not the words");
    });

    it("releases the note, so posting again mints a NEW post - not versions into the grave", async () => {
        const doc = await (await owner(`api/identity/${root}/docs/${note}`)).json();
        const r = await owner(`api/identity/${root}/docs/${note}`, {
            method: "PUT",
            body: JSON.stringify({
                title: "Reconsidered",
                body: "posted at leisure",
                format: "marquee",
                parents: doc.save_parents,
            }),
        });
        assert.equal(r.status, 200, await r.text());

        const again = await owner(`api/identity/${root}/docs/${note}/publish`, { method: "POST" });
        const text = await again.text();
        assert.equal(again.status, 200, text);
        const reborn = JSON.parse(text).post_id;
        assert.notEqual(
            reborn,
            post,
            "a fresh id: the tombstone is final for the old one, and publish must not write into it"
        );

        const prof = await (await anon(`api/id/${root}/profile`)).json();
        assert.ok(
            prof.posts.some((p) => p.doc_id === reborn),
            "the new post is on the shelf"
        );
        assert.ok(
            !prof.posts.some((p) => p.doc_id === post),
            "and the buried one stayed buried"
        );
        const body = await anon(`id/${root}/docs/${reborn}/body`);
        assert.match(await body.text(), /leisure/, "with the reconsidered words");
    });
});

/*
    A link to a private note, published (2026-09-28, PROJECT_PLAN's "`/ringtome/` replaces `/home`,
    `/in` and `/id`", slice 3). The published words carry no notebook name (`?bucket=` comes off) and
    no cozy path (an old `/home/<app>/<id>` crosslink becomes the note's address); the linked note
    answers "private" to a stranger until it is published, and then its address answers with its
    post - through the author's own `published_from` label, which nobody else can say for them.
*/
describe("a published link to a private note", () => {
    let linked, linking, linkedPost;
    const short = async () => (await import("../../js/speakable.js")).toBase58(root);
    const from = (doc) => anon(`api/id/${root}/from/${doc}`);

    before(async () => {
        linked = (await (await owner(`api/identity/${root}/docs`, {
            method: "POST",
            body: JSON.stringify({ title: "Soup", body: "a secret recipe", format: "marquee" }),
        })).json()).doc_id;
        const s = await short();
        linking = (await (await owner(`api/identity/${root}/docs`, {
            method: "POST",
            body: JSON.stringify({
                title: "Menu",
                body: `the [soup](/ringtome/user/${s}/doc/${linked}?bucket=family-recipes) and the [old soup](/home/notes/${linked})`,
                format: "marquee",
            }),
        })).json()).doc_id;
    });

    it("publishes with no notebook name and no cozy path", async () => {
        const resp = await owner(`api/identity/${root}/docs/${linking}/publish`, { method: "POST" });
        assert.equal(resp.status, 200, await resp.clone().text());
        const post = (await resp.json()).post_id;
        const words = await (await anon(`id/${root}/docs/${post}/body`)).text();
        const s = await short();
        assert.ok(!words.includes("bucket="), `no notebook name: ${words}`);
        assert.ok(!words.includes("/home/"), `no cozy path: ${words}`);
        assert.equal(words.split(`/ringtome/user/${s}/doc/${linked}`).length - 1, 2, `both links name the note: ${words}`);
    });

    it("the linked note is private until it is published, and then it is its post", async () => {
        assert.equal((await from(linked)).status, 404, "private, to anyone asking");
        assert.equal((await from("ee".repeat(16))).status, 404, "and exactly as private as one that never was");
        const resp = await owner(`api/identity/${root}/docs/${linked}/publish`, { method: "POST" });
        assert.equal(resp.status, 200, await resp.clone().text());
        linkedPost = (await resp.json()).post_id;
        const answer = await from(linked);
        assert.equal(answer.status, 200, "published: the address finds its post");
        assert.equal((await answer.json()).post, linkedPost);
        // The label is machinery on the post, readable like any other.
        const post = await (await anon(`api/id/${root}/posts/${linkedPost}`)).json();
        assert.ok(
            (post.annotations || []).some((a) => a.key === "published_from" && a.value === linked && a.annotator === root),
            "said by the author, about the post"
        );
    });

    it("only the author's own label names their post", async () => {
        // Someone else saying `published_from = <the menu note>` about the author's post does not
        // make the menu note's address find it.
        const other = await makeUserFetch({ prefix: "fromliar" });
        const otherRoot = (await (await other("api/identity", { method: "POST" })).json()).root_pubkey;
        const said = await other(`api/identity/${otherRoot}/public-annotations/${root}/${linkedPost}`, {
            method: "PUT",
            body: JSON.stringify({ key: "published_from", value: linking }),
        });
        assert.equal(said.status, 200, await said.clone().text());
        await beat(undefined, "mint", otherRoot);
        await beat(undefined, "fold", otherRoot);
        const held = await sql(
            `SELECT COUNT(*) AS n FROM doc_annotations WHERE annotator = '${otherRoot}' AND key = 'published_from' AND target_doc = '${linkedPost}'`
        );
        assert.equal(Number(held.rows[0].n), 1, "the stranger's word is held here, as any label is");
        const answer = await from(linking);
        const found = answer.status === 200 ? (await answer.json()).post : null;
        assert.notEqual(found, linkedPost, "and never counts as the author's");
    });
});

/*
    Somebody else's picture, posted (2026-09-28, Curtis: "reference when private, copy at
    publish"). In a private note it is a reference to their public picture; publishing copies it
    into the poster's own public picture - read from this node by key, never downloaded from the
    origin it was copied at - and the post's provenance names whose it was.
*/
describe("somebody else's picture, posted", function () {
    this.timeout(60000);
    const { makePng } = require("./helpers.cjs");
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let theirs, theirRoot, theirPicture;

    before(async () => {
        theirs = await makeUserFetch({ prefix: "picowner" });
        theirRoot = (await (await theirs("api/identity", { method: "POST" })).json()).root_pubkey;
        const pic = await (await theirs(`api/identity/${theirRoot}/docs/binary?title=horse`, { method: "POST", body: makePng(24, 24), file: true })).json();
        for (let i = 0; i < 60; i++) {
            if ((await theirs(`api/identity/${theirRoot}/docs/${pic.doc_id}/body`)).status === 200) break;
            await wait(300);
        }
        const note = (await (await theirs(`api/identity/${theirRoot}/docs`, {
            method: "POST",
            body: JSON.stringify({ title: "My Horse", body: `![horse](/api/identity/${theirRoot}/docs/${pic.doc_id}/body/horse.avif)`, format: "marquee" }),
        })).json()).doc_id;
        const pub = await theirs(`api/identity/${theirRoot}/docs/${note}/publish`, { method: "POST" });
        assert.equal(pub.status, 200, await pub.clone().text());
        const words = await (await anon(`id/${theirRoot}/docs/${(await pub.json()).post_id}/body`)).text();
        theirPicture = words.match(/\]\((\/ringtome\/user\/[^)]+)\)/)[1];
    });

    it("their post embeds its picture at its /ringtome/ address, served to anyone", async () => {
        assert.match(theirPicture, /^\/ringtome\/user\/[A-Za-z0-9]+\/doc\/[0-9a-f]{32}\/body\/media\.avif$/);
        const bytes = await anon(theirPicture.slice(1));
        assert.equal(bytes.status, 200);
        assert.equal(bytes.headers.get("content-type"), "image/avif");
    });

    it("posted by someone else, it becomes their own copy, credited", async () => {
        const note = (await (await owner(`api/identity/${root}/docs`, {
            method: "POST",
            // As pasted: the whole URL, at whatever origin it was copied from.
            body: JSON.stringify({ title: "Look", body: `![a horse](http://localhost:6305${theirPicture})`, format: "marquee" }),
        })).json()).doc_id;
        let post = null;
        let first = true;
        for (let i = 0; i < 100 && !post; i++) {
            const r = await owner(`api/identity/${root}/docs/${note}/publish`, { method: "POST" });
            const b = JSON.parse(await r.text());
            if (first && r.status === 202) {
                assert.equal(b.baking[0].kind, "copied", "a copy, not a download");
                first = false;
            }
            assert.ok(!(b.baking || []).some((x) => x.status === "failed"), `copy failed: ${JSON.stringify(b.baking)}`);
            if (r.status === 200) post = b.post_id;
            else await wait(500);
        }
        assert.ok(post, "the copy landed and the post minted");
        const words = await (await anon(`id/${root}/docs/${post}/body`)).text();
        const short = (await import("../../js/speakable.js")).toBase58(root);
        const mine = words.match(/\]\((\/ringtome\/user\/[^)]+)\)/);
        assert.ok(mine && mine[1].startsWith(`/ringtome/user/${short}/doc/`), `the post's picture is the poster's own: ${words}`);
        assert.ok(!words.includes("localhost:6305"), "and leans on no origin");
        assert.equal((await anon(mine[1].slice(1))).status, 200, "served to anyone");
        const said = await (await anon(`api/id/${root}/posts/${post}`)).json();
        assert.ok(
            (said.annotations || []).some((a) => a.key === "provenance" && a.value === theirRoot && a.annotator === root),
            `the post names whose picture it was: ${JSON.stringify(said.annotations)}`
        );
        // Re-minted, never re-encoded: the copy is the very same bytes.
        const [a, b] = await Promise.all([anon(theirPicture.slice(1)), anon(mine[1].slice(1))]);
        assert.deepEqual(Buffer.from(await b.arrayBuffer()), Buffer.from(await a.arrayBuffer()), "the same bytes, not a second lossy pass");
    });

    it("a sound and a silent-loop video copy the same way - as they are, the loop still a loop", async function () {
        this.timeout(180000);
        const fs = require("node:fs");
        const path = require("node:path");
        const sample = (f) => fs.readFileSync(path.join(__dirname, "..", "..", "..", "sample_media", f));
        const uploaded = async (title, bytes) => {
            const made = await (await theirs(`api/identity/${theirRoot}/docs/binary?title=${title}`, { method: "POST", body: bytes, file: true })).json();
            for (let i = 0; i < 240; i++) {
                if ((await theirs(`api/identity/${theirRoot}/docs/${made.doc_id}/body`)).status === 200) return made.doc_id;
                await wait(500);
            }
            throw new Error(`${title} never finished ingesting`);
        };
        const sound = await uploaded("buck", sample("buck-audio.ogg"));
        const loop = await uploaded("squirrel", sample("animated_color_squirrel_small.gif"));
        const theirNote = (await (await theirs(`api/identity/${theirRoot}/docs`, {
            method: "POST",
            body: JSON.stringify({
                title: "Noises",
                body: `![buck](/api/identity/${theirRoot}/docs/${sound}/body/buck.opus)\n\n![squirrel](/api/identity/${theirRoot}/docs/${loop}/body/squirrel-loop.webm)`,
                format: "marquee",
            }),
        })).json()).doc_id;
        const theirPub = await theirs(`api/identity/${theirRoot}/docs/${theirNote}/publish`, { method: "POST" });
        assert.equal(theirPub.status, 200, await theirPub.clone().text());
        const theirWords = await (await anon(`id/${theirRoot}/docs/${(await theirPub.json()).post_id}/body`)).text();
        const theirSound = theirWords.match(/\]\((\/ringtome\/user\/[^)]+\.opus)\)/)[1];
        const theirLoop = theirWords.match(/\]\((\/ringtome\/user\/[^)]+-loop\.webm)\)/)[1];

        const note = (await (await owner(`api/identity/${root}/docs`, {
            method: "POST",
            body: JSON.stringify({ title: "Heard", body: `![a buck](${theirSound})\n\n![a squirrel](${theirLoop})`, format: "marquee" }),
        })).json()).doc_id;
        let post = null;
        for (let i = 0; i < 200 && !post; i++) {
            const r = await owner(`api/identity/${root}/docs/${note}/publish`, { method: "POST" });
            const b = JSON.parse(await r.text());
            assert.ok(!(b.baking || []).some((x) => x.status === "failed"), `copy failed: ${JSON.stringify(b.baking)}`);
            if (r.status === 200) post = b.post_id;
            else await wait(500);
        }
        assert.ok(post, "both copied and the post minted");
        const words = await (await anon(`id/${root}/docs/${post}/body`)).text();
        const short = (await import("../../js/speakable.js")).toBase58(root);
        const mySound = (words.match(/\]\((\/ringtome\/user\/[^)]+\.opus)\)/) || [])[1];
        const myLoop = (words.match(/\]\((\/ringtome\/user\/[^)]+\.webm)\)/) || [])[1];
        assert.ok(mySound && mySound.startsWith(`/ringtome/user/${short}/doc/`), `the sound is the poster's own: ${words}`);
        assert.ok(myLoop && myLoop.startsWith(`/ringtome/user/${short}/doc/`) && myLoop.endsWith("-loop.webm"), `the video is the poster's own, and still a loop: ${words}`);
        for (const [theirs_, mine_] of [[theirSound, mySound], [theirLoop, myLoop]]) {
            const [a, b] = await Promise.all([anon(theirs_.slice(1)), anon(mine_.slice(1))]);
            assert.equal(b.status, 200, `${mine_} serves`);
            assert.deepEqual(Buffer.from(await b.arrayBuffer()), Buffer.from(await a.arrayBuffer()), `${mine_}: the same bytes`);
        }
    });
});

describe("a post with many pictures publishes as a job, never against the clock", function () {
    // An importer's old blog posts died at the CDN's 60 s timeout around fifteen pictures
    // (2026-10-02): the publish now runs on its own task, the POST hands back a 202 with each
    // picture's standing once it has waited a while, and every re-POST asks after the SAME job.
    // The wait is set to nothing here, so six pictures are enough to watch the poll road.
    const { makePng } = require("./helpers.cjs");
    const inline = (ms) => anon("test/publish-inline", { method: "POST", body: JSON.stringify({ ms }) });
    after(() => inline(-1));

    it("answers 202 with every picture listed, then the post - minted once", async function () {
        this.timeout(60000);
        const pics = [];
        for (let i = 0; i < 6; i++) {
            const up = await owner(`api/identity/${root}/docs/binary?title=plate-${i}`, { method: "POST", body: makePng(20 + i, 20), file: true });
            pics.push((await up.json()).doc_id);
        }
        for (const pic of pics) {
            for (let i = 0; i < 60; i++) {
                if ((await owner(`api/identity/${root}/docs/${pic}/body`)).status === 200) break;
                await new Promise((r) => setTimeout(r, 300));
            }
        }
        const body = pics.map((p, i) => `![plate ${i}](/api/identity/${root}/docs/${p}/body/plate-${i}.png)`).join("\n\n");
        const note = await (
            await owner(`api/identity/${root}/docs`, { method: "POST", body: JSON.stringify({ title: "Many plates", body, format: "marquee" }) })
        ).json();
        await inline(0);
        const publish = () => owner(`api/identity/${root}/docs/${note.doc_id}/publish`, { method: "POST" });

        const first = await publish();
        const firstBody = await first.json();
        assert.equal(first.status, 202, JSON.stringify(firstBody));
        assert.equal(firstBody.publishing, true, "a running job, not media still ingesting");

        // Until the job has read the note it knows no pictures; once it does, it lists them all.
        let posted = null;
        for (let i = 0; i < 200 && !posted; i++) {
            const r = await publish();
            const b = await r.json();
            if (r.status === 200) posted = b;
            else {
                assert.equal(r.status, 202, JSON.stringify(b));
                assert.ok([0, 6].includes(b.baking.length), `the whole list or none: ${JSON.stringify(b.baking)}`);
                await new Promise((res) => setTimeout(res, 50));
            }
        }
        assert.ok(posted && posted.post_id, "the job's answer reaches a later ask");
        await inline(-1);

        const words = await (await anon(`id/${root}/docs/${posted.post_id}/body`)).text();
        assert.equal(words.split("/ringtome/").length - 1, 6, `every picture public in the post: ${words}`);
        const prof = await (await anon(`api/id/${root}/profile`)).json();
        assert.equal(prof.posts.filter((p) => p.title === "Many plates").length, 1, "the polls started no second publish");
    });
});
