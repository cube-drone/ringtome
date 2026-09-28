/*
    Scores and sort orders, slice 1 (PROJECT_PLAN's Scores and sort orders, 2026-09-27): the feed's
    "best" orders rank the posts inside a window by the reader's own score - glad reactions up,
    sour ones down, each weighed by the reader's dial on whoever said it: trust ramps to 1, a
    follow counts a tenth, a stranger counts nothing at all. And the post's "history &
    popularity" shows the whole reckoning - to its reader, and to nobody else.

    One node, four people: ada reads; cal is someone she trusts fully, dee someone she follows,
    eve a stranger. They react to ada's own posts (an author may not react to their own).
*/
const assert = require("node:assert");

const { makeUserFetch } = require("./helpers.cjs");
const { beat } = require("./beat.cjs");
const { HOST, sql, makeFetch } = require("./fetch.cjs");

const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });

describe("scores: the best orders, and the reckoning behind them", function () {
    this.timeout(600000);

    let ada, adaRoot, cal, calRoot, dee, deeRoot, eve, eveRoot;
    let liked, followedLike, strangerLike, disliked, quiet, old;

    const persona = async (prefix) => {
        const who = await makeUserFetch({ prefix });
        const root = (await (await who("api/identity", { method: "POST" })).json()).root_pubkey;
        return [who, root];
    };
    const post = async (title) => {
        const d = await (await j(ada, `api/identity/${adaRoot}/docs`, { title, body: `${title}, in words`, format: "marquee" })).json();
        const pub = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, {});
        const said = await pub.text();
        assert.equal(pub.status, 200, said);
        return JSON.parse(said).post_id;
    };
    const react = async (who, root, doc, value) => {
        const r = await j(who, `api/identity/${root}/public-annotations/${adaRoot}/${doc}`, { key: "tag", value }, "PUT");
        assert.equal(r.status, 200, await r.text());
    };
    const feed = async (qs) => (await (await ada(`api/identity/${adaRoot}/feed?${qs}`)).json());
    const ids = (page) => (page.items || []).map((i) => i.doc_id);

    before(async () => {
        [ada, adaRoot] = await persona("scoreada");
        [cal, calRoot] = await persona("scorecal");
        [dee, deeRoot] = await persona("scoredee");
        [eve, eveRoot] = await persona("scoreeve");
        await j(ada, `api/identity/${adaRoot}/private/kv/contact:${calRoot}/trust`, { value: "max" }, "PUT");
        await j(ada, `api/identity/${adaRoot}/private/kv/contact:${deeRoot}/interest`, { value: "high" }, "PUT");

        // The follow's post is older than the unscored ones, so only its tenth can lift it.
        old = await post("an old favourite");
        followedLike = await post("liked by a follow");
        quiet = await post("nobody said a thing");
        disliked = await post("a hot take");
        strangerLike = await post("liked by a stranger");
        liked = await post("liked twice by a friend");

        await react(cal, calRoot, liked, "\u{1F44D}");
        await react(cal, calRoot, liked, "\u{1F4AF}"); // a double-like counts twice
        await react(dee, deeRoot, followedLike, "\u{1F44D}");
        await react(eve, eveRoot, strangerLike, "❤️");
        await react(eve, eveRoot, strangerLike, "\u{1F434}");
        await react(cal, calRoot, disliked, "\u{1F44E}");
        await react(cal, calRoot, old, "\u{1F4AF}");
        await react(cal, calRoot, old, "\u{1F434}");
        await react(cal, calRoot, quiet, "bread"); // a word leans nowhere
        // Published two years ago: inside "ever", outside every window.
        await sql(
            `UPDATE feed_journal SET published_ms = published_ms - ${2 * 365 * 24 * 3600 * 1000} WHERE doc_id = '${old}'`
        );
    });

    it("best ranks by the reader's score: trust counts fully, a follow a tenth, a stranger nothing - then newest first", async () => {
        const week = ids(await feed("sort=best&window=week"));
        assert.deepEqual(
            week,
            [liked, followedLike, strangerLike, quiet, disliked],
            "+2 from the trusted double-like, +0.1 from the follow, the stranger's two likes and the word at 0 (newest first), -1 last"
        );
        assert.deepEqual(
            ids(await feed("sort=best&window=week&q=liked")),
            [liked, followedLike, strangerLike],
            "a search inside best is ranked the same way"
        );
        const newest = ids(await feed(""));
        assert.deepEqual(
            newest,
            [liked, strangerLike, disliked, quiet, followedLike, old],
            "the default order is still newest first, every post in it"
        );
    });

    it("the window bounds the order - a year at the longest - and a cursor picks up across the runs", async () => {
        assert.ok(!ids(await feed("sort=best&window=year")).includes(old), "two years old is outside the year");
        assert.ok(!ids(await feed("sort=best")).includes(old), "and there is no best ever: no window is a year");
        const week = await feed("sort=best&window=week");
        const first = (week.items || [])[0];
        assert.equal(first.doc_id, liked);
        const token = `2000:${first.published_ms}:${first.doc_id}`;
        assert.deepEqual(
            ids(await feed(`sort=best&window=week&after=${encodeURIComponent(token)}`)),
            [followedLike, strangerLike, quiet, disliked],
            "after the top post: the rest of the scored run, the unscored run, the run below zero"
        );
        const zero = (week.items || []).find((i) => i.doc_id === strangerLike);
        const fromZero = `0:${zero.published_ms}:${zero.doc_id}`;
        assert.deepEqual(ids(await feed(`sort=best&window=week&after=${encodeURIComponent(fromZero)}`)), [quiet, disliked], "a cursor inside the unscored run");
    });

    it("the facet counts keep to the window - a year at the longest", async () => {
        const labels = async (qs) => (await (await ada(`api/identity/${adaRoot}/feed/labels?${qs}`)).json());
        const count = (f) => (f.kinds || []).reduce((n, k) => n + k.count, 0);
        assert.equal(count(await labels("")), 5, "no window is a year: the two-year-old post is not counted (2026-09-28)");
        assert.equal(count(await labels("window=year")), 5);
        assert.equal(count(await labels("window=week")), 5, "every other post is this week's");
    });

    it("the popularity door itemises the reckoning for its reader, and answers nobody else", async () => {
        const pop = await (await ada(`api/identity/${adaRoot}/popularity/${adaRoot}/${liked}`)).json();
        assert.deepEqual(
            pop.parts.map((p) => [p.annotator, p.tone, p.weight, p.standing]),
            [
                [calRoot, 1, 1, { trusted: "max" }],
                [calRoot, 1, 1, { trusted: "max" }],
            ]
        );
        assert.equal(pop.score, 2);
        const stranger = await (await ada(`api/identity/${adaRoot}/popularity/${adaRoot}/${strangerLike}`)).json();
        assert.deepEqual(stranger.parts.map((p) => [p.standing, p.weight]), [["stranger", 0], ["stranger", 0]], "listed, and weighed at nothing");
        assert.equal(stranger.score, 0);
        const follow = await (await ada(`api/identity/${adaRoot}/popularity/${adaRoot}/${followedLike}`)).json();
        assert.deepEqual(follow.parts.map((p) => [p.standing, p.weight]), [["followed", 0.1]]);
        // Somebody else asking for ada's reckoning: it is a readout of her dials.
        const nosy = await cal(`api/identity/${adaRoot}/popularity/${adaRoot}/${liked}`);
        assert.ok(nosy.status >= 400, `another account may not read ada's reckoning: ${nosy.status}`);
    });
    it("scores kept as reactions and dials move are exactly what a rebuild reckons", async () => {
        const check = async () => (await (await makeFetch(HOST)(`test/score-check?root=${adaRoot}`, { method: "POST" })).json());
        // A second author ada follows, so an interest factor has something to move.
        const [fay, fayRoot] = await persona("scorefay");
        await j(fay, `api/identity/${fayRoot}/serve`, {});
        await j(ada, `api/identity/${adaRoot}/private/kv/contact:${fayRoot}/interest`, { value: "max" }, "PUT");
        const d = await (await j(fay, `api/identity/${fayRoot}/docs`, { title: "fay's loaf", body: "a loaf", format: "marquee" })).json();
        const pub = await j(fay, `api/identity/${fayRoot}/docs/${d.doc_id}/publish`, {});
        const loaf = JSON.parse(await pub.text()).post_id;
        let arrived = false;
        for (let i = 0; i < 30 && !arrived; i++) {
            await beat(HOST, "journal-fill");
            arrived = ids(await feed("")).includes(loaf);
            if (!arrived) await new Promise((r) => setTimeout(r, 300));
        }
        assert.ok(arrived, "fay's post reached ada's feed");

        await feed("sort=best&window=week"); // the snapshot of ada's dials the keeping starts from
        // Reactions arriving and leaving, each through the real doors.
        await react(cal, calRoot, quiet, "\u{1F44D}");
        await react(cal, calRoot, loaf, "\u{1F4AF}");
        await react(dee, deeRoot, loaf, "\u{1F44E}");
        const gone = await dee(`api/identity/${deeRoot}/public-annotations/${adaRoot}/${followedLike}/tag/${encodeURIComponent("\u{1F44D}")}`, { method: "DELETE" });
        assert.equal(gone.status, 200, await gone.text());
        await react(eve, eveRoot, disliked, "\u{1F4A9}");
        // Compared before any dial moves: a dial change rescores its person, and would mend a
        // withdrawal the keeping had missed.
        let r = await check();
        assert.deepEqual(r.kept, r.rebuilt, "reactions said and withdrawn: kept equals rebuilt");
        // Dials moving: a follow dropped, a stranger trusted, an author's interest turned down.
        await j(ada, `api/identity/${adaRoot}/private/kv/contact:${deeRoot}/interest`, { value: "none" }, "PUT");
        await j(ada, `api/identity/${adaRoot}/private/kv/contact:${eveRoot}/trust`, { value: "low" }, "PUT");
        await j(ada, `api/identity/${adaRoot}/private/kv/contact:${fayRoot}/interest`, { value: "low" }, "PUT");
        r = await check();
        assert.ok(r.rebuilt.length > 0, "something is scored");
        assert.deepEqual(r.kept, r.rebuilt, "kept incrementally, rebuilt from scratch: the same");
        // A block, and more said after it.
        await j(ada, `api/identity/${adaRoot}/private/kv/contact:${calRoot}/blocked`, { value: "yes" }, "PUT");
        await react(cal, calRoot, strangerLike, "\u{1F44E}");
        await react(eve, eveRoot, quiet, "\u{1F923}");
        const week = ids(await feed("sort=best&window=week"));
        assert.notEqual(week[0], liked, "blocked, cal's double-like no longer lifts the post");
        r = await check();
        assert.deepEqual(r.kept, r.rebuilt, "and still the same after the block");
    });
});
