/*
    The comments arc, slice 1 (COMMENTS.md): a reply is rebroadcast plus your own words.

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

const { sql, HOST, HOST_B, HOST_C } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");
const { beat, shareArrives } = require("./beat.cjs");

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};

(HOST_B && HOST_C ? describe : describe.skip)("a reply is rebroadcast plus your own words", function () {
    this.timeout(1200000);

    let ada, adaRoot, bea, beaRoot, cal, calRoot, rio, rioRoot;
    let op, reply;

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
        assert.ok(
            !(bell.items || []).some((i) => i.author === beaRoot && i.kind === "comment"),
            "a deleted reply stops being a conversation in the bell"
        );
    });
});
