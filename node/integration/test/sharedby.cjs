/*
    "Sam and two others passed this along": one document, many sharers, one row.

    A viral post arrives over and over - Sam shares it, then Sid, then Sky, each a separate pointer
    on a separate chain. The reader's feed must not become three copies of the same post, and the
    row it does keep must be able to say who else thought it was worth passing on.

        ava (alpha)          writes and publishes one post.
        sam, sid, sky (bravo) each follow ava, and each share that post.
        rex (charlie)        follows all three for REBROADCASTS only, and has never heard of ava.

    Three properties, and the last two are the reason this file exists:

      1. ONE row, keyed (reader, author, doc) - three shares, one entry in the feed - never three
         copies of the same post walking down a reader's river.

      2. The byline is a claim in the PRESENT tense. It leads with the longest-standing sharer
         among the people still sharing it, which is usually the introducer and stops being them
         the moment they withdraw. `feed_journal.via_root` keeps the historical answer ("who
         brought this row") and is deliberately not what gets rendered.

      3. The crowd is filtered against the reader's own subscriptions AT READ TIME. So unfollowing
         a sharer removes them from the count with no cleanup pass anywhere - the stored row simply
         stops counting - while a WITHDRAWAL, which is a fact about the world rather than about one
         reader, is a real delete in `feed_shares`. The last two tests are those two paths.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { HOST_B, HOST_C } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");
const { beat, pullAndFold, shareArrives } = require("./beat.cjs");

// One reader-side share arrival on charlie - beat.cjs's two-round rung.
const arriveOnC = (sharerRoot, authorRoot) => shareArrives(HOST_C, sharerRoot, authorRoot);


const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};

const dial = (fetcher, mine, theirs, key, value) =>
    fetcher(`api/identity/${mine}/private/kv/contact:${theirs}/${key}`, {
        method: "PUT",
        body: JSON.stringify({ value }),
    });

// One persona's feed row for a document, straight off the API - `via_others` and `via_count` are
// shaped there and nowhere else, so this reads the surface a client actually gets.
const feedRow = async (reader, readerRoot, docId) => {
    const { items } = await (await reader(`api/identity/${readerRoot}/feed`)).json();
    return (items || []).find((i) => i.doc_id === docId) || null;
};

const share = (fetcher, mine, author, docId) =>
    fetcher(`api/identity/${mine}/rebroadcasts`, {
        method: "POST",
        body: JSON.stringify({ author, doc_id: docId }),
    });

const unshare = (fetcher, mine, author, docId) =>
    fetcher(`api/identity/${mine}/rebroadcasts`, {
        method: "POST",
        body: JSON.stringify({ author, doc_id: docId, retract: true }),
    });

(HOST_B && HOST_C ? describe : describe.skip)("one document, many sharers", function () {
    this.timeout(300000);

    let ava, avaRoot, sam, samRoot, sid, sidRoot, sky, skyRoot, rex, rexRoot;

    before(async function () {
        ava = await makeUserFetch({ prefix: "sbava" });
        avaRoot = (await (await ava("api/identity", { method: "POST" })).json()).root_pubkey;
        await ava(`api/identity/${avaRoot}/serve`, { method: "POST" });
        const viaAva = await base58(ava);

        // The three sharers share a node, which is incidental - what matters is that they are
        // three separate personas with three separate chains, so three separate pointers arrive.
        const sharers = [];
        for (const prefix of ["sbsam", "sbsid", "sbsky"]) {
            const who = await makeUserFetch({ prefix, host: HOST_B });
            const root = (await (await who("api/identity", { method: "POST" })).json()).root_pubkey;
            await who(`api/identity/${root}/serve`, { method: "POST" });
            if ((await who(`api/id/${avaRoot}/profile?via=${viaAva}`)).status !== 200) this.skip();
            await dial(who, root, avaRoot, "interest", "high");
            sharers.push({ who, root });
        }
        [{ who: sam, root: samRoot }, { who: sid, root: sidRoot }, { who: sky, root: skyRoot }] =
            sharers;
        const viaSharers = await base58(sam);

        rex = await makeUserFetch({ prefix: "sbrex", host: HOST_C });
        rexRoot = (await (await rex("api/identity", { method: "POST" })).json()).root_pubkey;
        for (const root of [samRoot, sidRoot, skyRoot]) {
            if ((await rex(`api/id/${root}/profile?via=${viaSharers}`)).status !== 200) this.skip();
            await dial(rex, rexRoot, root, "interest_rebroadcasts", "high");
        }

        // Every reader's dial must be IN the subscriptions memo before anything publishes,
        // or the fold fires into a shorter follower list (fanout.cjs's documented barrier;
        // the dial's own nudged sweep is asynchronous and a slow runner let a publish
        // outrun sky's memo - the one CI red of 2026-08-25's shake).
        for (const { root } of sharers) {
            await beat(HOST_B, "fold", root);
        }
        await beat(HOST_C, "fold", rexRoot);
    });

    /// A fresh post, passed along by all three in a KNOWN order - sam first and alone, so "the
    /// introducer" is a fact each test established rather than whichever pointer won a race.
    ///
    /// Its own document per test, deliberately: every assertion below mutates the crowd (a
    /// withdrawal, an unfollow), and a shared post would let one test decide another's outcome -
    /// the lesson cascade.cjs's header records from the first version of its own scenarios.
    async function seedThreeShares(title) {
        const made = await (
            await ava(`api/identity/${avaRoot}/docs`, {
                method: "POST",
                body: JSON.stringify({ title, body: `${title}: worth passing on`, format: "plaintext" }),
            })
        ).json();
        const published = await ava(`api/identity/${avaRoot}/docs/${made.doc_id}/publish`, {
            method: "POST",
        });
        const body = await published.text();
        assert.equal(published.status, 200, body);
        const post = JSON.parse(body).post_id;

        // Beat-driven (2026-08-25, the settle switchover): the sharers' node pulls ava's
        // chain and folds ONCE - all three live there - then each feed is asserted plainly.
        await pullAndFold(HOST_B, avaRoot);
        for (const [label, who, root] of [
            ["sam", sam, samRoot],
            ["sid", sid, sidRoot],
            ["sky", sky, skyRoot],
        ]) {
            const { items } = await (await who(`api/identity/${root}/feed`)).json();
            assert.ok(
                (items || []).some((i) => i.doc_id === post),
                `seed(${title}): the post reached ${label}, who follows ava`
            );
        }

        assert.equal((await share(sam, samRoot, avaRoot, post)).status, 200);
        await arriveOnC(samRoot, avaRoot);
        const first = await feedRow(rex, rexRoot, post);
        assert.ok(
            first && first.via === samRoot,
            `seed(${title}): sam's share reached rex, who has never heard of ava`
        );
        assert.equal((await share(sid, sidRoot, avaRoot, post)).status, 200);
        assert.equal((await share(sky, skyRoot, avaRoot, post)).status, 200);
        await arriveOnC(sidRoot, avaRoot);
        await arriveOnC(skyRoot, avaRoot);
        const crowd = await feedRow(rex, rexRoot, post);
        assert.ok(
            crowd && crowd.via_count === 3,
            `seed(${title}): all three shares reached rex`
        );
        return post;
    }

    it("three shares of one post make one row, bylined with whoever brought it first", async () => {
        const post = await seedThreeShares("shared-thrice");
        const row = await feedRow(rex, rexRoot, post);

        assert.ok(row, "the shared post reached a reader who follows only the sharers");
        assert.equal(row.author, avaRoot, "credited to its author, not to any of them");
        assert.equal(row.via, samRoot, "and bylined with the one who brought it first");
        assert.equal(row.via_count, 3, "the feed knows all three passed it along");
        assert.deepEqual(
            (row.via_others || []).map((o) => o.root).sort(),
            [sidRoot, skyRoot].sort(),
            "the others are named, and the lead is not repeated among them"
        );

        // The headline property: one row, not three.
        const { items } = await (await rex(`api/identity/${rexRoot}/feed`)).json();
        assert.equal(
            items.filter((i) => i.doc_id === post).length,
            1,
            "a document shared three times appears once"
        );
    });

    it("when the introducer withdraws, the line is led by whoever still stands behind it", async () => {
        // A byline is a claim in the PRESENT tense. `feed_journal` remembers that sam brought this
        // row and always will, but crediting sam after sam withdrew would credit a recommendation
        // nobody is making - so the lead is the longest-standing sharer among those still sharing.
        const post = await seedThreeShares("introducer-leaves");
        assert.equal((await unshare(sam, samRoot, avaRoot, post)).status, 200);

        await arriveOnC(samRoot, avaRoot); // sam's chain moved: the retraction
        const row = await feedRow(rex, rexRoot, post);
        assert.ok(row && row.via === sidRoot, "the lead moved to the earliest sharer still standing behind it");
        assert.equal(row.via_count, 2, "and the crowd is the two who remain");
        assert.deepEqual(
            (row.via_others || []).map((o) => o.root),
            [skyRoot],
            "sky is the only other one left"
        );

        // Sharing it again does NOT hand the lead back: sam's standing behind this post now dates
        // from the re-share, and it is the longest-standing sharer who leads. Worth pinning, because
        // the alternative rule - "whoever brought it, ever" - is what the journal's own column does
        // and is exactly the claim this test says a byline must not make.
        assert.equal((await share(sam, samRoot, avaRoot, post)).status, 200);
        await arriveOnC(samRoot, avaRoot);
        const back = await feedRow(rex, rexRoot, post);
        assert.equal(back.via_count, 3, "sam's re-share rejoined the crowd");
        assert.equal(back.via, sidRoot, "sid has stood behind it longest, so sid still leads");
        assert.deepEqual(
            (back.via_others || []).map((o) => o.root),
            [skyRoot, samRoot],
            "and sam rejoins at the back of the line"
        );
    });

    it("unfollowing a sharer drops them from the crowd, and leaves the post standing", async () => {
        // Nothing rewrites a stored list when this happens - the count is filtered against the
        // reader's live subscriptions at read time, which is what makes an unfollow correct with
        // no cleanup pass at all.
        const post = await seedThreeShares("unfollowed-sharer");
        await dial(rex, rexRoot, skyRoot, "interest_rebroadcasts", "none");
        try {
            await beat(HOST_C, "fold", rexRoot); // the reader's own memo, refolded
            const row = await feedRow(rex, rexRoot, post);
            assert.ok(row && row.via_count === 2, "the count follows the reader's own dials");
            assert.deepEqual(
                (row.via_others || []).map((o) => o.root),
                [sidRoot],
                "sky is not somebody this reader follows, so sky is not in their crowd"
            );
            assert.equal(row.via, samRoot, "the post is still here, still bylined via sam");
        } finally {
            // Put the dial back: the next test's crowd is nobody else's business.
            await dial(rex, rexRoot, skyRoot, "interest_rebroadcasts", "high");
        }
    });

    it("withdrawals shrink the crowd back to a single name", async () => {
        const post = await seedThreeShares("down-to-one");
        assert.equal((await unshare(sid, sidRoot, avaRoot, post)).status, 200);
        assert.equal((await unshare(sky, skyRoot, avaRoot, post)).status, 200);

        await arriveOnC(sidRoot, avaRoot);
        await arriveOnC(skyRoot, avaRoot);
        const row = await feedRow(rex, rexRoot, post);
        assert.ok(row && row.via_count === undefined, "back to one sharer, and back to saying nothing about a crowd");
        assert.deepEqual(row.via_others || [], [], "nobody else is named");
        assert.equal(row.via, samRoot, "sam introduced it and sam is still sharing it");
        assert.equal(row.title, "down-to-one", "the words are untouched throughout");
    });
});
