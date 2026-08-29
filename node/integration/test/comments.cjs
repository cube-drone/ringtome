/*
    The comments arc, slice 1 (PROJECT_PLAN's Replies): a reply is rebroadcast plus your own words.

    The wire and the mint, end to end: publishing with `reply_to` stamps the thread links
    onto the SIGNED header (parent, and the root copied from the parent's own claim -
    parent-plus-root, never the ancestor path), and mints ordinary rebroadcast pointers for
    both - because a reply IS a recommendation (Curtis's ruling): commenting on a thing
    spreads it into your network, crowd counts and all. The pin lives and dies with the
    comment: deleting the reply retracts the pointers it minted.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { sql, HOST, HOST_B, HOST_C, HOST_E } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");
const { beat, pullAndFold, shareArrives } = require("./beat.cjs");
const { makeFetch } = require("./fetch.cjs");
const settle = require("./helpers.cjs").settleWith(240);

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};

(HOST_B && HOST_C ? describe : describe.skip)("a reply is rebroadcast plus your own words", function () {
    this.timeout(1200000);

    let ada, adaRoot, bea, beaRoot, cal, calRoot, rio, rioRoot;
    let op, reply, rioReply, eve, selfReply;

    const publish = async (who, root, title, replyTo) => {
        const made = await (
            await who(`api/identity/${root}/docs`, {
                method: "POST",
                body: JSON.stringify({ title, body: `${title}: the words`, format: "plaintext" }),
            })
        ).json();
        const pub = await who(`api/identity/${root}/docs/${made.doc_id}/publish`, {
            method: "POST",
            ...(replyTo ? { body: JSON.stringify({ reply_to: replyTo }) } : {}),
        });
        const text = await pub.text();
        return { status: pub.status, text, post: pub.status === 200 ? JSON.parse(text).post_id : null };
    };

    const sharesOf = async (who, root) =>
        (await (await who(`api/identity/${root}/rebroadcasts`)).json()).items || [];

    before(async function () {
        ada = await makeUserFetch({ prefix: "cmtada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });

        bea = await makeUserFetch({ prefix: "cmtbea", host: HOST_B });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });

        cal = await makeUserFetch({ prefix: "cmtcal", host: HOST_C });
        calRoot = (await (await cal("api/identity", { method: "POST" })).json()).root_pubkey;
        await cal(`api/identity/${calRoot}/serve`, { method: "POST" });

        rio = await makeUserFetch({ prefix: "cmtrio", host: HOST_C });
        rioRoot = (await (await rio("api/identity", { method: "POST" })).json()).root_pubkey;

        // The original post, and everyone who will speak about it holding it first: a
        // reply needs the parent's header in hand (root-copy and pin both), and the
        // publish refuses a blind reply with words.
        ({ post: op } = await publish(ada, adaRoot, "the-op"));
        assert.ok(op, "the original published");
        const viaAda = await base58(ada);
        if ((await bea(`api/id/${adaRoot}/profile?via=${viaAda}`)).status !== 200) this.skip();
        if ((await cal(`api/id/${adaRoot}/profile?via=${viaAda}`)).status !== 200) this.skip();

        // rio follows bea's taste: the recommendation semantics' witness.
        const viaBea = await base58(bea);
        if ((await rio(`api/id/${beaRoot}/profile?via=${viaBea}`)).status !== 200) this.skip();
        await rio(`api/identity/${rioRoot}/private/kv/contact:${beaRoot}/interest_rebroadcasts`, {
            method: "PUT",
            body: JSON.stringify({ value: "high" }),
        });
        await beat(HOST_C, "fold", rioRoot);
    });

    it("a reply stamps the thread links onto the signed header", async () => {
        const out = await publish(bea, beaRoot, "the-reply", { author: adaRoot, doc_id: op });
        assert.equal(out.status, 200, out.text);
        reply = out.post;
        const p = await (await bea(`api/id/${beaRoot}/posts/${reply}`)).json();
        assert.deepEqual(
            p.reply_to,
            { author: adaRoot, doc_id: op },
            "the parent, the author's own signed claim"
        );
        assert.deepEqual(
            p.thread_root,
            { author: adaRoot, doc_id: op },
            "a depth-one reply's root IS its parent"
        );
    });

    it("the reply pinned the parent - an ordinary share, recommendation included", async () => {
        const shares = await sharesOf(bea, beaRoot);
        assert.ok(
            shares.some((s) => s.author === adaRoot && s.doc_id === op),
            "the pin is a real rebroadcast pointer on bea's chain"
        );
        // And it recommends: rio, who follows bea's taste and never met ada, receives
        // the parent - crowd machinery, bylines and all (the sharedby suite's claims).
        await shareArrives(HOST_C, beaRoot, adaRoot);
        const { rows } = await sql(
            `SELECT via_root FROM feed_journal WHERE reader_root = '${rioRoot}' AND doc_id = '${op}'`,
            HOST_C
        );
        assert.ok(rows.length, "the parent reached the taste-follower's feed");
        assert.equal(rows[0].via_root, beaRoot, "bylined via the replier - a reply IS a share");
    });

    it("a nested reply copies the ROOT from its parent's claim, and pins both", async function () {
        // cal replies to bea's REPLY: parent is the reply, root must be ada's original -
        // copied from bea's header, never re-derived, never the ancestor path.
        const viaBea = await base58(bea);
        if ((await cal(`api/id/${beaRoot}/profile?via=${viaBea}`)).status !== 200) this.skip();
        const out = await publish(cal, calRoot, "the-nested-reply", {
            author: beaRoot,
            doc_id: reply,
        });
        assert.equal(out.status, 200, out.text);
        const p = await (await cal(`api/id/${calRoot}/posts/${out.post}`)).json();
        assert.deepEqual(p.reply_to, { author: beaRoot, doc_id: reply }, "parent: the reply");
        assert.deepEqual(
            p.thread_root,
            { author: adaRoot, doc_id: op },
            "root: the original, copied from the parent's own claim"
        );
        const shares = await sharesOf(cal, calRoot);
        assert.ok(
            shares.some((s) => s.author === beaRoot && s.doc_id === reply),
            "the parent is pinned"
        );
        assert.ok(
            shares.some((s) => s.author === adaRoot && s.doc_id === op),
            "and the root - parent-plus-root, a depth-N leaf owes exactly two"
        );
    });

    it("a blind reply refuses with words", async () => {
        const out = await publish(bea, beaRoot, "reply-to-nothing", {
            author: adaRoot,
            doc_id: "ff".repeat(16),
        });
        assert.equal(out.status, 400, "can't reply to a post this computer doesn't hold");
        assert.match(out.text, /doesn't hold/);
    });

    it("the feed dresses a reply with its parent - the quote-card's payload (slice 3)", async () => {
        // Bea follows herself by hosting, so her own reply is a feed row on HOST_B - and
        // the handler joins the replies memo to say what it answers. The card carries the
        // link always; the title only when the reader's journal met the parent (bea never
        // followed ada, so hers degrades to the bare link - the mini-card's honest case).
        await beat(HOST_B, "fold", beaRoot);
        const page = await (await bea(`api/identity/${beaRoot}/feed`)).json();
        const row = (page.items || []).find((i) => i.doc_id === reply);
        assert.ok(row, "the reply is a feed row of her own");
        assert.deepEqual(
            { author: row.reply_to.author, doc_id: row.reply_to.doc_id },
            { author: adaRoot, doc_id: op },
            "the quote-card names the parent from the memo"
        );
        const plain = (page.items || []).find((i) => i.doc_id === op);
        assert.ok(!plain || !plain.reply_to, "a non-reply row carries no card");
        assert.ok(!row.thread_root, "a depth-one reply carries one card, not the root twice");
        // Deeper than depth one, the ROOT rides too (Curtis, 2026-08-28): cal's nested
        // reply, in cal's own feed, names bea's reply as parent and ada's op as root.
        const calsPage = await (await cal(`api/identity/${calRoot}/feed`)).json();
        const nested = (calsPage.items || []).find(
            (i) => i.author === calRoot && i.reply_to && i.reply_to.author === beaRoot
        );
        if (nested) {
            assert.deepEqual(
                { author: nested.thread_root.author, doc_id: nested.thread_root.doc_id },
                { author: adaRoot, doc_id: op },
                "the thread's root, one more hop up"
            );
        }
    });

    it("the replies memo knows the thread where the chains are held (slice 2)", async () => {
        // HOST_C holds bea's chain (rio's rebroadcast-follow syncs it) and cal's own -
        // so ITS memo knows both links; ada's node, which holds neither replier's chain,
        // honestly knows nothing yet (slice 6's door is how it learns). Assembly is
        // honest-partial, and this asserts both halves.
        await beat(HOST_C, "fold", beaRoot);
        await beat(HOST_C, "fold", calRoot);
        const onC = await (
            await cal(`api/id/${adaRoot}/posts/${op}/replies`)
        ).json();
        assert.equal(onC.replies.length, 1, "one direct reply known to C");
        assert.equal(onC.replies[0].author, beaRoot);
        assert.equal(onC.more, false);
        // The next level: the nested reply hangs off bea's reply, not off the root.
        const level2 = await (
            await cal(`api/id/${beaRoot}/posts/${reply}/replies`)
        ).json();
        assert.equal(level2.replies.length, 1, "the nested reply, one level down");
        assert.equal(level2.replies[0].author, calRoot);
    });

    it("a comment notice reaches the parent's author - first-class, by envelope (slice 4)", async () => {
        // ada does not follow bea, so the news arrives at her door: kind comment, tiered to
        // the STRANGER pool (conversation, never a murmur), naming HER post - the thread's
        // address, dressed with its title for the bell's mini-card. And the parent pin is
        // QUIET: bea's share of op must not ALSO murmur "shared your post" - the comment is
        // the same act said properly.
        await beat(HOST_B, "outbox");
        const bell = await (await ada(`api/identity/${adaRoot}/notifications`)).json();
        const fromBea = (bell.items || []).filter((i) => i.author === beaRoot);
        const comment = fromBea.find((i) => i.kind === "comment");
        assert.ok(comment, "the comment notice landed");
        assert.equal(comment.stranger, true, "ada does not follow bea: the stranger pool");
        assert.equal(comment.doc_id, op, "the row names the PARENT - the reader's own post");
        assert.equal(comment.doc_title, "the-op", "dressed for the mini-card");
        assert.ok(
            !fromBea.some((i) => i.kind === "rebroadcast"),
            "the parent pin stays quiet - one act, one notice"
        );
    });

    it("a nested reply: comment to the parent's author, ordinary share murmur to the root's", async function () {
        // cal answered BEA, so bea hears conversation; ada's post got passed along by the
        // ROOT pin, so ada hears exactly what that is - a share.
        const bea2 = await (await bea(`api/id/${beaRoot}/posts/${reply}`)).json();
        if (!bea2 || !reply) this.skip();
        await beat(HOST_C, "outbox");
        const bell = await (await bea(`api/identity/${beaRoot}/notifications`)).json();
        const comment = (bell.items || []).find(
            (i) => i.author === calRoot && i.kind === "comment"
        );
        assert.ok(comment, "the nested reply's comment notice reached bea");
        assert.equal(comment.doc_id, reply, "naming bea's reply - the parent, not the root");
        const adasBell = await (await ada(`api/identity/${adaRoot}/notifications`)).json();
        const fromCal = (adasBell.items || []).filter((i) => i.author === calRoot);
        assert.ok(
            fromCal.some((i) => i.kind === "rebroadcast"),
            "the root pin announces as the share it is"
        );
        assert.ok(
            !fromCal.some((i) => i.kind === "comment"),
            "no comment claim on the root - cal answered bea, not ada"
        );
    });

    it("a followed replier's comment derives locally - and the delivered copy yields (slice 4)", async function () {
        // ada follows bea: the visit first (the suite's own idiom - the via hint is how
        // her node learns the route), then the dial. Her node then pulls the chain the
        // reply lives on, the fold derives the comment row (not a stranger - a byline),
        // and the follow-edge rule hides the envelope's copy. One conversation, one row.
        const viaBea = await base58(bea);
        if ((await ada(`api/id/${beaRoot}/profile?via=${viaBea}`)).status !== 200) this.skip();
        await ada(`api/identity/${adaRoot}/private/kv/contact:${beaRoot}/interest`, {
            method: "PUT",
            body: JSON.stringify({ value: "high" }),
        });
        await beat(HOST, "fold", adaRoot);
        await beat(HOST, "pull", adaRoot);
        await beat(HOST, "fold", beaRoot);
        const bell = await (await ada(`api/identity/${adaRoot}/notifications`)).json();
        const comments = (bell.items || []).filter(
            (i) => i.author === beaRoot && i.kind === "comment"
        );
        assert.equal(comments.length, 1, "one conversation, one row - the roads dedupe");
        assert.ok(!comments[0].stranger, "derived from a followed chain, not a stranger");
        assert.equal(comments[0].doc_id, op);
    });

    // ------------------------------------------------------------------------------------
    // The author's thread door (slice 6). ada's node is the best-informed about op's
    // thread - bea's reply reached it by envelope-then-sync, rio's by envelope alone - and
    // serves the index to anyone who asks, curated by ada's own bit.

    it("a stranger's reply is held for the nod - known to the author, served to nobody (slice 6)", async function () {
        // rio answers op. rio and ada have no relationship: the reply reaches ada's node
        // as a COMMENT envelope whose evidence is kept and noted - so ada SEES it (her
        // own session view, pending), but her node does not SPEAK it (the public read,
        // and the door, hold it back until she nods).
        const out = await publish(rio, rioRoot, "the-strangers-reply", {
            author: adaRoot,
            doc_id: op,
        });
        assert.equal(out.status, 200, out.text);
        rioReply = out.post;
        await beat(HOST_C, "outbox");
        const own = await (
            await ada(`api/identity/${adaRoot}/posts/${op}/replies`)
        ).json();
        const held = (own.replies || []).find((r) => r.author === rioRoot);
        assert.ok(held, "the author's own view knows the stranger's reply");
        assert.equal(held.served, false, "held for the nod, not yet spoken");
        const pub = await (await ada(`api/id/${adaRoot}/posts/${op}/replies`)).json();
        assert.ok(
            !(pub.replies || []).some((r) => r.author === rioRoot),
            "the public read holds it back - curation is the same bit as display"
        );
        assert.ok(
            (pub.replies || []).some((r) => r.author === beaRoot),
            "the followed replier speaks automatically - the trusted default"
        );
    });

    it("the author's own reply is authoring, not commenting - never held for the nod", async () => {
        // Nobody follows themselves, so the trusted default once put a self-reply in the
        // stranger pool (Curtis, 2026-08-28). The author's words on their own post bypass
        // curation whole: served at once, and the held list never names them.
        const out = await publish(ada, adaRoot, "my-own-follow-up", { author: adaRoot, doc_id: op });
        assert.equal(out.status, 200, out.text);
        selfReply = out.post;
        await beat(HOST, "fold", adaRoot);
        const pub = await (await ada(`api/id/${adaRoot}/posts/${op}/replies`)).json();
        assert.ok(
            (pub.replies || []).some((r) => r.author === adaRoot && r.doc_id === out.post),
            "the author's own reply speaks immediately"
        );
        const own = await (await ada(`api/identity/${adaRoot}/posts/${op}/replies`)).json();
        const mine = (own.replies || []).find((r) => r.doc_id === out.post);
        assert.ok(mine && mine.served === true, "and is never held");
        // Not even the no-comments switch silences the author on their own post.
        await ada(`api/identity/${adaRoot}/private/kv/comments/default`, {
            method: "PUT",
            body: JSON.stringify({ value: "none" }),
        });
        const muted = await (await ada(`api/id/${adaRoot}/posts/${op}/replies`)).json();
        assert.ok(
            (muted.replies || []).some((r) => r.author === adaRoot),
            "suppress-all is about other people's words"
        );
        await ada(`api/identity/${adaRoot}/private/kv/comments/default`, {
            method: "PUT",
            body: JSON.stringify({ value: "" }),
        });
    });

    it("answering a reply in its author's own thread rings them once - replied, not shared", async function () {
        // bea answers ada's self-reply: parent AND root are ada's, so the reply pins both -
        // and used to ring ada twice, "replied" for the parent and "shared" for the root,
        // for one act (Curtis, 2026-08-29). The root pin is quiet when the parent's author
        // owns the root, on both roads; ada follows bea, so this is the derived one.
        if (!selfReply) this.skip();
        const out = await publish(bea, beaRoot, "answering-your-follow-up", {
            author: adaRoot,
            doc_id: selfReply,
        });
        assert.equal(out.status, 200, out.text);
        await beat(HOST, "pull", adaRoot);
        await beat(HOST, "fold", beaRoot);
        const bell = await (await ada(`api/identity/${adaRoot}/notifications`)).json();
        const fromBea = (bell.items || []).filter((i) => i.author === beaRoot);
        assert.ok(
            fromBea.some((i) => i.kind === "comment" && i.doc_id === selfReply),
            "the comment on the self-reply rings"
        );
        assert.ok(
            !fromBea.some((i) => i.kind === "rebroadcast"),
            "and the root pin stays quiet - one act, one notice, even two levels down"
        );
    });

    it("a blank node learns the thread from the author's door (slice 6)", async function () {
        if (!HOST_E) this.skip();
        // eve's node holds nothing of this thread. Visiting the permalink IS the demand:
        // the first read answers what it has (nothing) and says it is seeking; the door's
        // page arrives behind it, claims first, words fetched through ordinary machinery.
        eve = await makeUserFetch({ prefix: "cmteve", host: HOST_E });
        const eveRoot = (await (await eve("api/identity", { method: "POST" })).json()).root_pubkey;
        const viaAda = await base58(ada);
        if ((await eve(`api/id/${adaRoot}/profile?via=${viaAda}`)).status !== 200) this.skip();
        const first = await (await eve(`api/id/${adaRoot}/posts/${op}/replies`)).json();
        assert.equal(first.seeking, true, "the visit kicked the ask, and said so");
        // SWR: timing IS the property here - the ask is behind the render by design.
        let listed = [];
        for (let i = 0; i < 40 && !listed.some((r) => r.author === beaRoot); i++) {
            await new Promise((r) => setTimeout(r, 300));
            listed = (await (await eve(`api/id/${adaRoot}/posts/${op}/replies`)).json()).replies || [];
        }
        assert.ok(
            listed.some((r) => r.author === beaRoot),
            "the followed replier's claim arrived through the door"
        );
        assert.ok(
            !listed.some((r) => r.author === rioRoot),
            "the held stranger stayed unserved - a door withholds what the bit says"
        );
    });

    it("the nod opens the door - approve, and the reply joins the conversation (slice 6)", async function () {
        if (!eve) this.skip();
        // The nod is one private register - persona-owned, synced with her - and the 200
        // means the memo agrees (the kv PUT drains the fold for the comments collection).
        await ada(`api/identity/${adaRoot}/private/kv/comments/${rioRoot}:${rioReply}`, {
            method: "PUT",
            body: JSON.stringify({ value: "approved" }),
        });
        const pub = await (await ada(`api/id/${adaRoot}/posts/${op}/replies`)).json();
        assert.ok(
            (pub.replies || []).some((r) => r.author === rioRoot),
            "approved: the author's node now speaks it"
        );
        // And the door serves it to the blank node on the deliberate re-ask.
        await eve(`api/id/${adaRoot}/posts/${op}/replies?refresh=1`);
        let listed = [];
        for (let i = 0; i < 40 && !listed.some((r) => r.author === rioRoot); i++) {
            await new Promise((r) => setTimeout(r, 300));
            listed = (await (await eve(`api/id/${adaRoot}/posts/${op}/replies`)).json()).replies || [];
        }
        assert.ok(
            listed.some((r) => r.author === rioRoot),
            "the refresh re-asked the door and the approved reply came through"
        );
    });

    it("suppress-all is the no-comments switch - and only mutes the author's amplification (slice 6)", async () => {
        await ada(`api/identity/${adaRoot}/private/kv/comments/default`, {
            method: "PUT",
            body: JSON.stringify({ value: "none" }),
        });
        const pub = await (await ada(`api/id/${adaRoot}/posts/${op}/replies`)).json();
        assert.ok(
            !(pub.replies || []).some((r) => r.author !== adaRoot),
            "mode none: the author's node speaks nobody else's words (their own still stand)"
        );
        // The honest limit: bea's reply still stands on HER chain and HER node's memo -
        // suppression never reaches the reply's existence.
        const onB = await (await bea(`api/id/${adaRoot}/posts/${op}/replies`)).json();
        assert.ok(
            (onB.replies || []).some((r) => r.author === beaRoot),
            "the reply's existence is not the author's to erase"
        );
        // Back to the default so the claims below read the ordinary world.
        await ada(`api/identity/${adaRoot}/private/kv/comments/default`, {
            method: "PUT",
            body: JSON.stringify({ value: "" }),
        });
    });

    it("deleting the reply retracts the pin - it lives and dies with the comment", async () => {
        const down = await bea(`api/identity/${beaRoot}/posts/${reply}`, { method: "DELETE" });
        assert.equal(down.status, 200, await down.text());
        const shares = await sharesOf(bea, beaRoot);
        assert.ok(
            !shares.some((s) => s.author === adaRoot && s.doc_id === op),
            "the deleted reply's pointer is withdrawn"
        );
        // And the memo recedes with the shelf (slice 2): bea's own node folds her chain,
        // sees the reply's header gone, and the row goes with it.
        await beat(HOST_B, "fold", beaRoot);
        const onB = await (
            await bea(`api/id/${adaRoot}/posts/${op}/replies`)
        ).json();
        assert.ok(
            !onB.replies.some((r) => r.author === beaRoot),
            "a deleted reply leaves the thread on the fold that noticed"
        );
        // And the derived comment row recedes on ada's node: her next pull sees bea's
        // shelf without the reply, and the fold's diff takes the bell row with it.
        await beat(HOST, "pull", adaRoot);
        await beat(HOST, "fold", beaRoot);
        const bell = await (await ada(`api/identity/${adaRoot}/notifications`)).json();
        // Precisely the deleted reply's row - bea's OTHER conversation with ada (her answer
        // to the self-reply, a claim above) rightly stands.
        assert.ok(
            !(bell.items || []).some(
                (i) => i.author === beaRoot && i.kind === "comment" && i.doc_id === op
            ),
            "a deleted reply stops being a conversation in the bell"
        );
    });

    // ------------------------------------------------------------------------------------
    // Slice 5: the named edges, proven.

    it("deleting a nested reply retracts BOTH its pins - parent and root, at depth (slice 5)", async function () {
        // cal's nested reply owed two pointers (parent-plus-root). Its death owes two
        // retractions - even now that its PARENT (bea's reply) is itself already dead:
        // the links were read off cal's own held copy, not resolved through the parent.
        if (!reply) this.skip();
        const nested = (await sharesOf(cal, calRoot)).filter(
            (s) =>
                (s.author === beaRoot && s.doc_id === reply) ||
                (s.author === adaRoot && s.doc_id === op)
        );
        if (nested.length !== 2) this.skip(); // the nested-reply test skipped upstream
        const calsReply = (
            await (await cal(`api/id/${beaRoot}/posts/${reply}/replies`)).json()
        ).replies.find((r) => r.author === calRoot);
        assert.ok(calsReply, "precondition: the nested reply is known");
        const down = await cal(`api/identity/${calRoot}/posts/${calsReply.doc_id}`, {
            method: "DELETE",
        });
        assert.equal(down.status, 200, await down.text());
        const after = await sharesOf(cal, calRoot);
        assert.ok(
            !after.some((s) => s.author === beaRoot && s.doc_id === reply),
            "the parent pin is withdrawn"
        );
        assert.ok(
            !after.some((s) => s.author === adaRoot && s.doc_id === op),
            "and the root pin - a depth-N death owes exactly what its mint owed"
        );
    });

    it("the pin recommends the parent whole - words, image, and all (slice 5)", async function () {
        this.timeout(1200000);
        // Ruling 7's mechanics ARE the share's mechanics: a pin is `share_one`, the exact
        // act cascade.cjs proves end to end ("the image rides the share": the fragment,
        // the covered media twin, the refcount, the release on death). What THIS suite
        // pins is the reply path composing with it on this suite's own topology - where
        // rio's node happens to hold ada's MIRROR (cal visited her), so the share fold
        // journals off the mirror and mints no fragment, deliberately: the node can
        // already answer for the post. The claims that hold on EVERY topology: the pin
        // journals the parent to the taste-follower, and their node serves the parent's
        // image bytes to their browser.
        const fs = require("node:fs");
        const path = require("node:path");
        const webp = fs.readFileSync(
            path.join(__dirname, "..", "..", "..", "sample_media", "its_webp.webp")
        );
        const up = await ada(`api/identity/${adaRoot}/docs/binary?title=cat&parents=`, {
            method: "POST",
            body: webp,
        });
        const upText = await up.text();
        assert.ok(up.status === 200 || up.status === 202, upText);
        const mediaId = JSON.parse(upText).doc_id;
        assert.ok(
            await settle(async () => {
                const r = await ada(`api/identity/${adaRoot}/docs/${mediaId}`);
                return r.status === 200 ? true : null;
            }),
            "the upload transcoded"
        );
        const made = await (
            await ada(`api/identity/${adaRoot}/docs`, {
                method: "POST",
                body: JSON.stringify({
                    title: "cat post",
                    body: `behold:\n\n![cat](/api/identity/${adaRoot}/docs/${mediaId}/body/cat.webp)\n`,
                    format: "marquee",
                }),
            })
        ).json();
        const pub = await ada(`api/identity/${adaRoot}/docs/${made.doc_id}/publish`, {
            method: "POST",
        });
        const pubText = await pub.text();
        assert.equal(pub.status, 200, pubText);
        const mpost = JSON.parse(pubText).post_id;

        // bea sees it and replies; the pin recommends it to rio.
        await pullAndFold(HOST_B, adaRoot);
        const out = await publish(bea, beaRoot, "nice-cat", { author: adaRoot, doc_id: mpost });
        assert.equal(out.status, 200, out.text);
        let row = null;
        for (let i = 0; i < 30 && !row; i++) {
            await shareArrives(HOST_C, beaRoot, adaRoot);
            const { rows } = await sql(
                `SELECT via_root FROM feed_journal WHERE reader_root = '${rioRoot}' AND doc_id = '${mpost}'`,
                HOST_C
            );
            row = rows.length ? rows[0] : null;
        }
        assert.ok(row, "the parent reached the taste-follower's feed through the pin");
        assert.equal(row.via_root, beaRoot, "bylined via the replier");

        // The image: the served body names the baked twin, and the twin's bytes serve
        // from rio's own node - whichever shelf (mirror here, fragment on a node that
        // holds nothing else of ada's) backs the answer.
        await beat(HOST_C, "body-heal", adaRoot);
        await beat(HOST_C, "bodies-sweep");
        const servedRes = await makeFetch(HOST_C)(`id/${adaRoot}/docs/${mpost}/body`);
        assert.equal(servedRes.status, 200, "the parent's words serve on rio's node");
        const served = await servedRes.text();
        const twin = (served.match(/\/docs\/([0-9a-f]{32})\/body/) || [])[1];
        assert.ok(twin, `the served body names the baked twin: ${served.slice(0, 200)}`);
        let imageOk = false;
        for (let i = 0; i < 30 && !imageOk; i++) {
            await beat(HOST_C, "body-heal", adaRoot);
            await beat(HOST_C, "bodies-sweep");
            imageOk = (await makeFetch(HOST_C)(`id/${adaRoot}/docs/${twin}/body`)).status === 200;
        }
        assert.ok(imageOk, "the parent's image bytes serve from the taste-follower's node");
    });

    it("a reply can be rich - marquee, media embed, the bake, the links (slice 3 grown)", async function () {
        this.timeout(1200000);
        // The reply box now runs the full authoring surface, so the reply path must carry
        // everything an ordinary post does: bea answers with marquee words embedding her
        // OWN image - the bake mints the public twin inline, the publish stamps the
        // thread links on the SAME header, and her twin serves. One act, whole post.
        const fs = require("node:fs");
        const path = require("node:path");
        const webp = fs.readFileSync(
            path.join(__dirname, "..", "..", "..", "sample_media", "its_webp.webp")
        );
        const up = await bea(`api/identity/${beaRoot}/docs/binary?title=mine&parents=`, {
            method: "POST",
            body: webp,
        });
        const upText = await up.text();
        assert.ok(up.status === 200 || up.status === 202, upText);
        const mediaId = JSON.parse(upText).doc_id;
        assert.ok(
            await settle(async () => {
                const r = await bea(`api/identity/${beaRoot}/docs/${mediaId}`);
                return r.status === 200 ? true : null;
            }),
            "bea's upload transcoded"
        );
        const made = await (
            await bea(`api/identity/${beaRoot}/docs`, {
                method: "POST",
                body: JSON.stringify({
                    title: "look at this",
                    body: `see:\n\n![mine](/api/identity/${beaRoot}/docs/${mediaId}/body/mine.webp)\n`,
                    format: "marquee",
                }),
            })
        ).json();
        // The UI's own flow: POST publish with reply_to until the answer is a post id
        // (private embeds bake inline, so the first answer is it - but the loop is the
        // contract publishWithBaking rides, body repeated every round).
        let richReply = null;
        for (let i = 0; i < 40 && !richReply; i++) {
            const pub = await bea(`api/identity/${beaRoot}/docs/${made.doc_id}/publish`, {
                method: "POST",
                body: JSON.stringify({ reply_to: { author: adaRoot, doc_id: op } }),
            });
            const body = JSON.parse(await pub.text());
            if (body.post_id) richReply = body.post_id;
            else await new Promise((r) => setTimeout(r, 300));
        }
        assert.ok(richReply, "the rich reply published");
        const head = await (await bea(`api/id/${beaRoot}/posts/${richReply}`)).json();
        assert.deepEqual(
            head.reply_to,
            { author: adaRoot, doc_id: op },
            "the thread links rode the same signed header as the media"
        );
        // Her post's served body names the baked twin, and the twin's bytes serve.
        const served = await (await bea(`id/${beaRoot}/docs/${richReply}/body`)).text();
        const twin = (served.match(/\/docs\/([0-9a-f]{32})\/body/) || [])[1];
        assert.ok(twin, `the served body names the baked twin: ${served.slice(0, 200)}`);
        assert.equal(
            (await bea(`id/${beaRoot}/docs/${twin}/body`)).status,
            200,
            "the reply's own image serves - a reply is an ordinary post, media and all"
        );
    });

    it("a post says how many replies this node thinks exist (the foot line's number)", async () => {
        // Honest-partial by construction: the count is the memo's TREE for a top-level
        // post (root-keyed - nested replies count, which is why it can exceed the direct
        // listing: on bea's node op's tree holds her rich reply AND cal's old nested one,
        // remembered from its COMMENT envelope though cal since deleted it - a named
        // residual, the evidence has no deletion road until cal's chain is met). The foot
        // and the memo are one source: the number IS the root-keyed row count, verbatim.
        const head = await (await bea(`api/id/${adaRoot}/posts/${op}`)).json();
        const { rows } = await sql(
            `SELECT COUNT(*) AS n FROM post_replies WHERE root_author = '${adaRoot}' AND root_doc = '${op}'`,
            HOST_B
        );
        assert.ok(rows[0].n >= 1, "precondition: bea's node knows the thread");
        assert.equal(
            head.replies,
            rows[0].n,
            "the foot's number IS the memo's tree - one source, no contradiction"
        );
        const direct = await (await bea(`api/id/${adaRoot}/posts/${op}/replies`)).json();
        assert.ok(
            head.replies >= direct.replies.length,
            "and never fewer than the direct children on screen"
        );
    });
});
