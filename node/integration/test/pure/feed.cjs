// Feed's publication state: a durable public fact, and a local editing gesture.
const assert = require('node:assert');

let FEED_STYLE,
    publishedState,
    openDraftOf,
    overlayPosted,
    recentPosts,
    mergePosts,
    postCursor,
    isBackdated,
    docStatus,
    emphasisOf,
    leadOf,
    overrunOf,
    heldBack,
    mergeFeed,
    feedCursor,
    postScale,
    POST_SCALE_MIN,
    postImageCap,
    POST_IMAGE_MAX,
    POST_IMAGE_MIN,
    collapseReplyPairs,
    FEED_SORTS,
    isBestSort,
    isRankedSort,
    sortParams,
    mergeRanked,
    REPLY_SORTS,
    replySortParams;
before(async () => {
    ({
        FEED_STYLE,
        publishedState,
        openDraftOf,
        overlayPosted,
        recentPosts,
        mergePosts,
        isBackdated,
        docStatus,
        postCursor,
        emphasisOf,
        leadOf,
        overrunOf,
        heldBack,
        mergeFeed,
        feedCursor,
        postScale,
        POST_SCALE_MIN,
        postImageCap,
        POST_IMAGE_MAX,
        POST_IMAGE_MIN,
        collapseReplyPairs,
        FEED_SORTS,
        isBestSort,
        isRankedSort,
        sortParams,
        mergeRanked,
        REPLY_SORTS,
        replySortParams,
    } = await import('../../../js/pure/feed.js'));
});

const draft = { fields: {} };
const posted = { fields: { published_as: 'ab'.repeat(8) } };

describe('feed publication state', () => {
    it('names its one bucket', () => {
        assert.equal(FEED_STYLE, 'feed');
    });

    it('a draft says so', () => {
        const s = publishedState(draft);
        assert.equal(s.published, false);
        assert.equal(s.label, 'draft');
        assert.equal(s.postId, '');
    });

    it('a post says so, and wears no lock (2026-10-02: posts edit forever, at once)', () => {
        const s = publishedState(posted);
        assert.equal(s.published, true);
        assert.equal(s.label, 'posted');
        assert.equal(s.postId, 'ab'.repeat(8));
        assert.equal(s.locked, undefined, 'no seal, no unlock');
    });

    it('survives a row with no fields at all', () => {
        assert.equal(publishedState({}).published, false);
        assert.equal(publishedState().published, false);
    });
});

describe('the one open draft', () => {
    const doc = (id, post) => ({ doc_id: id, fields: post ? { published_as: post } : {} });

    it('is the newest unposted one (the list arrives newest first)', () => {
        const docs = [doc('c'), doc('b', 'p1'), doc('a')];
        assert.equal(openDraftOf(docs).doc_id, 'c');
    });

    it('never opens a SCHEDULED draft: a plan-bearing row is spoken for (2026-09-02)', () => {
        const docs = [
            { doc_id: 'sched', fields: { publish_plan: '{"at":1900000000000,"by":"x"}' } },
            { doc_id: 'fresh', fields: {} },
        ];
        assert.equal(openDraftOf(docs).doc_id, 'fresh');
        assert.equal(openDraftOf([docs[0]]), null);
    });

    it('skips posted items to find it', () => {
        const docs = [doc('c', 'p2'), doc('b', 'p1'), doc('a')];
        assert.equal(openDraftOf(docs).doc_id, 'a');
    });

    it('never mistakes uploaded media for the draft - the composer must not eat an image', () => {
        // A fresh upload is the NEWEST unpublished thing in the feed bucket; without the text
        // filter it becomes the open draft, the composer flips to it, and the upload's
        // reference swap fires into an unmounted session (field-found 2026-08-06).
        const image = { doc_id: 'img', format: 'avif', fields: {} };
        const text = { doc_id: 'words', format: 'marquee', fields: {} };
        assert.equal(openDraftOf([image, text]).doc_id, 'words');
        assert.equal(openDraftOf([image]), null, 'media alone is no draft at all');
    });

    it('is null when everything has been posted - which is what mints the next one', () => {
        assert.equal(openDraftOf([doc('a', 'p1')]), null);
        assert.equal(openDraftOf([]), null);
        assert.equal(openDraftOf(), null);
    });
});

// The local overlay: what this app knows about a publication before the stream says it back.
describe('overlayPosted', () => {
    it('dresses a row in a publication the mirror has not carried yet', () => {
        const row = overlayPosted({ doc_id: 'a', fields: {} }, 'post1');
        assert.equal(publishedState(row).published, true);
        assert.equal(publishedState(row).postId, 'post1');
    });

    it('keeps everything else about the row', () => {
        const row = overlayPosted({ doc_id: 'a', title: 'On Boats', fields: { tag: 'x' } }, 'p');
        assert.equal(row.title, 'On Boats');
        assert.equal(row.fields.tag, 'x');
    });

    it('does not mutate the row it was handed - the mirror is not ours to edit', () => {
        const original = { doc_id: 'a', fields: {} };
        overlayPosted(original, 'p');
        assert.deepEqual(original.fields, {});
    });

    it('YIELDS to the mirror once the mirror agrees - which is why it never needs clearing', () => {
        const carried = { doc_id: 'a', fields: { published_as: 'real' } };
        assert.equal(overlayPosted(carried, 'stale-guess'), carried, 'the row itself, untouched');
        assert.equal(publishedState(overlayPosted(carried, 'stale-guess')).postId, 'real');
    });

    it('is the identity with nothing to say', () => {
        const row = { doc_id: 'a', fields: {} };
        assert.equal(overlayPosted(row, null), row);
        assert.equal(overlayPosted(row, undefined), row);
    });
});

// Someone else's posts, ordered for reading. The list can arrive from a fetch across the
// network, so the order is established here rather than trusted.
describe('recentPosts', () => {
    const p = (id, ms) => ({ doc_id: id, published_ms: ms });

    it('reads newest first, whatever order it arrived in', () => {
        const got = recentPosts([p('old', 100), p('new', 300), p('mid', 200)]);
        assert.deepEqual(
            got.map((x) => x.doc_id),
            ['new', 'mid', 'old'],
        );
    });

    it("does not reorder the caller's array - the profile is not ours to shuffle", () => {
        const given = [p('old', 100), p('new', 300)];
        recentPosts(given);
        assert.deepEqual(
            given.map((x) => x.doc_id),
            ['old', 'new'],
        );
    });

    it('sorts a post with no timestamp LAST, not to the top', () => {
        const got = recentPosts([p('nostamp'), p('real', 5)]);
        assert.deepEqual(
            got.map((x) => x.doc_id),
            ['real', 'nostamp'],
        );
    });

    it('is empty for a persona with nothing said in public', () => {
        assert.deepEqual(recentPosts([]), []);
        assert.deepEqual(recentPosts(), []);
    });
});

// Paging down someone's shelf: the cursor that asks for the next page, and joining it on.
describe('paging a public shelf', () => {
    const p = (id, ms) => ({ doc_id: id, published_ms: ms });

    it('takes its cursor from the LAST post shown, not a count', () => {
        assert.deepEqual(postCursor([p('new', 300), p('old', 100)]), {
            after_ms: 100,
            after_doc: 'old',
        });
    });

    it('has no cursor for an empty shelf', () => {
        assert.equal(postCursor([]), null);
        assert.equal(postCursor(), null);
    });

    it('survives an undated last post rather than sending undefined over the wire', () => {
        assert.deepEqual(postCursor([p('a')]), { after_ms: 0, after_doc: 'a' });
    });

    it('joins a page on, still newest first', () => {
        const got = mergePosts([p('c', 300), p('b', 200)], [p('a', 100)]);
        assert.deepEqual(
            got.map((x) => x.doc_id),
            ['c', 'b', 'a'],
        );
    });

    it('DEDUPES - a re-published post can arrive on two pages', () => {
        const got = mergePosts([p('c', 300), p('b', 200)], [p('b', 200), p('a', 100)]);
        assert.deepEqual(
            got.map((x) => x.doc_id),
            ['c', 'b', 'a'],
        );
    });

    it('keeps the first sighting, so what is on screen stays where the eye left it', () => {
        const got = mergePosts([p('b', 200)], [{ doc_id: 'b', published_ms: 200, title: 'later' }]);
        assert.equal(got.length, 1);
        assert.equal(got[0].title, undefined, 'the row already shown, not the one that followed');
    });

    it('takes an empty or missing page without complaint', () => {
        assert.deepEqual(
            mergePosts([p('a', 1)], []).map((x) => x.doc_id),
            ['a'],
        );
        assert.deepEqual(
            mergePosts([p('a', 1)]).map((x) => x.doc_id),
            ['a'],
        );
        assert.deepEqual(
            mergePosts(undefined, [p('a', 1)]).map((x) => x.doc_id),
            ['a'],
        );
    });
});

// The feed's rendering dials: interest shapes SIZE and CUT, never order.
describe('feed emphasis and truncation', () => {
    it('maps the bands to three weights, with normal for the unset', () => {
        assert.equal(emphasisOf('none'), 'low');
        assert.equal(emphasisOf('low'), 'low');
        assert.equal(emphasisOf('medium'), 'normal');
        assert.equal(emphasisOf('high'), 'high');
        assert.equal(emphasisOf('max'), 'high');
        assert.equal(emphasisOf(undefined), 'normal', 'your own posts carry no dial');
        assert.equal(
            emphasisOf('75'),
            'normal',
            'the retired numeric scale is silence, not a weight',
        );
    });

    it('cuts a low-interest multi-paragraph item to its first paragraph', () => {
        const { lead, cut } = leadOf('the lead.\n\nthe rest, at length.', 'low');
        assert.equal(lead, 'the lead.');
        assert.equal(cut, true);
    });

    it('draws a held-back card a little past its lead, for the fade to fall across (2026-10-02)', () => {
        const body =
            'the lead.\n\nthe second paragraph goes on for a while.\n\n![p](/a.avif)\n\nafter the picture.';
        const over = overrunOf(body, 'low');
        assert.ok(over.startsWith('the lead.\n\nthe second paragraph'), over);
        assert.ok(
            !over.includes('![p]') && !over.includes('after the picture'),
            'never into the next picture',
        );
        assert.ok(!over.endsWith('\u2026'), 'the fade says "more", not an ellipsis');
        assert.equal(overrunOf('brief.', 'low'), 'brief.', 'nothing held back: just the lead');
        const wall = 'word '.repeat(400).trim();
        const lead = leadOf(wall, 'low').lead.replace(/\u2026$/, '');
        const longer = overrunOf(wall, 'low');
        assert.ok(
            longer.startsWith(lead) && longer.length > lead.length && longer.length < wall.length,
            'a little past, not all',
        );
        assert.ok(/word$/.test(longer), 'and on a word boundary');
        const linked =
            'a'.repeat(10) + '\n\n' + 'see [a link with words](https://example.com/x) '.repeat(20);
        const cut = overrunOf(linked, 'low');
        assert.equal(
            (cut.match(/\[/g) || []).length,
            (cut.match(/\)/g) || []).length,
            `never inside a link: ${cut}`,
        );
    });

    it('says what a card holds back, by kind (2026-10-02)', () => {
        const body =
            'one two three.\n\n![a](/x/body/a.avif) ![b](https://e.com/b.png) ![s](/x/body/s.opus) ![v](/x/body/v-loop.webm) ![m](https://e.com/m.mp3)\n\nfour five.';
        assert.deepEqual(heldBack(body, 'one two three.'), {
            words: 2,
            images: 2,
            audio: 2,
            videos: 1,
        });
        assert.deepEqual(heldBack(body, body), { words: 0, images: 0, audio: 0, videos: 0 });
        assert.deepEqual(
            heldBack('short', 'short and longer than the body'),
            { words: 0, images: 0, audio: 0, videos: 0 },
            'never negative',
        );
    });

    it('leaves a short item whole whatever the interest', () => {
        assert.deepEqual(leadOf('brief.', 'low'), { lead: 'brief.', cut: false });
    });

    it('never cuts a high-interest source - that is its importance', () => {
        const long = 'x'.repeat(5000);
        assert.deepEqual(leadOf(long, 'high'), { lead: long, cut: false });
    });

    it('slices an unbroken low-interest wall at a word boundary', () => {
        const wall = 'word '.repeat(200).trim();
        const { lead, cut } = leadOf(wall, 'low');
        assert.ok(cut);
        assert.ok(lead.length < 300);
        assert.ok(lead.endsWith('\u2026'), 'and says it was cut');
    });

    // Curtis, 2026-09-27: a post of dozens of the same picture showed five and then half of the
    // sixth - `![Big Fat…` - because each embed's address ate the budget as if it were words.
    const pic = (n) =>
        `![Big Fat Horse ${n}](/api/identity/${'a'.repeat(64)}/docs/${'b'.repeat(32)}/body/big_fat_horse.avif)`;

    it('always cuts at a second picture, at any interest - even when the whole would fit', () => {
        const post = `${pic(1)}\ntext text text\n${pic(2)}\nmore`;
        for (const emphasis of ['low', 'normal', 'high']) {
            const { lead, cut } = leadOf(post, emphasis);
            assert.equal(cut, true, emphasis);
            assert.ok(
                lead.includes(pic(1)) && !lead.includes('Big Fat Horse 2'),
                `${emphasis}: the first picture, not the second`,
            );
        }
        assert.equal(
            leadOf(`${pic(1)}\ntext text text\n${pic(2)}`, 'normal').lead,
            `${pic(1)}\ntext text text`,
        );
        assert.deepEqual(
            leadOf(`words\n${pic(1)}\nwords`, 'normal'),
            { lead: `words\n${pic(1)}\nwords`, cut: false },
            'one picture is no cut',
        );
    });

    it('never cuts a picture or a link in half, and counts neither address as words', () => {
        // 880 characters of words, then a link whose text would carry the reading past 900: the
        // budget runs out INSIDE the link, which must end the lead before it rather than split it.
        const wall = `${pic(1)}\n${'word '.repeat(176)}[a link with some length to it](https://example.com/${'p'.repeat(80)}) ${'word '.repeat(30)}`;
        const { lead, cut } = leadOf(wall, 'normal');
        assert.ok(cut);
        assert.ok(
            lead.startsWith(pic(1)),
            'the picture whole: its address did not spend the budget',
        );
        const opens = (lead.match(/\[/g) || []).length;
        const closes = (lead.match(/\)/g) || []).length;
        assert.equal(opens, closes, `no markup left open: ${lead.slice(-80)}`);
        assert.ok(lead.endsWith('\u2026'));
        assert.ok(
            !lead.includes('[a link'),
            'the link, straddling the budget, is left for "see more" whole',
        );
    });
});

describe('the feed page merge', () => {
    const item = (author, doc, ms) => ({ author, doc_id: doc, published_ms: ms });

    it('keys by author AND doc - two authors may mint colliding ids', () => {
        const merged = mergeFeed([item('a', 'd1', 5)], [item('b', 'd1', 3)]);
        assert.equal(merged.length, 2, 'same doc id, different author, both stay');
    });

    it('stays strictly chronological across pages', () => {
        const merged = mergeFeed([item('a', 'x', 300)], [item('b', 'y', 500), item('a', 'z', 100)]);
        assert.deepEqual(
            merged.map((i) => i.doc_id),
            ['y', 'x', 'z'],
        );
    });

    it('cursors from the last item shown', () => {
        assert.deepEqual(feedCursor([item('a', 'x', 300), item('b', 'y', 100)]), {
            before_ms: 100,
            before_doc: 'y',
        });
        assert.equal(feedCursor([]), null);
    });
});

// The quiet half of the interest dial: a source you care less about takes less ROOM, never a
// different place in the order. The edges that matter are the two ends of the ramp, the
// no-opinion case (which must not be the middle), and monotonicity - a tweak to the constants
// could silently invert it, and nobody would notice from a screenshot.
describe('postScale (how much room a post takes)', () => {
    const STOPS = ['none', 'low', 'medium', 'high', 'max'];

    it('runs the full range across the dial, top stop at full size', () => {
        assert.equal(postScale('max'), 1);
        assert.equal(postScale('none'), POST_SCALE_MIN);
    });

    it('is a 25% spread, evenly spaced across the five stops', () => {
        const scales = STOPS.map(postScale);
        assert.deepEqual(scales, [0.75, 0.8125, 0.875, 0.9375, 1]);
        const steps = scales.slice(1).map((v, i) => Math.round((v - scales[i]) * 10000) / 10000);
        assert.deepEqual(steps, [0.0625, 0.0625, 0.0625, 0.0625], 'even, so no stop is a cliff');
    });

    it('gives NO opinion full size, rather than the middle', () => {
        // An unset dial is not "medium interest" - the ramp carries an opinion you expressed,
        // and a feed of strangers must not render uniformly shrunken. Everything that is not
        // one of the five bands is no opinion, the retired numeric scale included.
        for (const nothing of [undefined, null, '', NaN, 'wat', 75, '75', -40]) {
            assert.equal(postScale(nothing), 1, `${String(nothing)} should not shrink anything`);
        }
    });

    it('climbs the ladder monotonically, inside the range', () => {
        let previous = 0;
        for (const band of STOPS) {
            const scale = postScale(band);
            assert.ok(scale > previous, `${band} did not climb`);
            assert.ok(scale >= POST_SCALE_MIN && scale <= 1, `${band} left the range`);
            previous = scale;
        }
    });
});

// The loud half of the dial. Its ceiling is not a free choice: 800 is where media/image.rs's
// transcode already lands, so top interest must be a no-op - a cap that GRANTED size would be
// asking the browser to upscale a picture nobody stored.
describe('postImageCap (how big a picture may draw)', () => {
    const STOPS = ['none', 'low', 'medium', 'high', 'max'];

    it('runs from a thumbnail to the transcode bound', () => {
        assert.equal(postImageCap('none'), POST_IMAGE_MIN);
        assert.equal(postImageCap('max'), POST_IMAGE_MAX);
        assert.equal(POST_IMAGE_MAX, 800, 'media/image.rs MAIN_BOUND - change both together');
    });

    it('slides evenly across the stops', () => {
        assert.deepEqual(STOPS.map(postImageCap), [50, 238, 425, 613, 800]);
    });

    it('never asks the browser to upscale past what was stored', () => {
        for (const band of STOPS) {
            assert.ok(postImageCap(band) <= POST_IMAGE_MAX, `${band} exceeded the transcode bound`);
        }
    });

    it('gives NO opinion the full bound - non-bands included', () => {
        for (const nothing of [undefined, null, '', NaN, 'wat', 75, '75', -40]) {
            assert.equal(postImageCap(nothing), POST_IMAGE_MAX);
        }
    });

    it('climbs the ladder monotonically', () => {
        let previous = 0;
        for (const band of STOPS) {
            const cap = postImageCap(band);
            assert.ok(cap > previous, `${band} did not climb`);
            previous = cap;
        }
    });
});

describe('the share/reply pair, collapsed at render', () => {
    const parent = { author: 'ada', doc_id: 'p1', via: 'bea' };
    const reply = { author: 'bea', doc_id: 'r1', reply_to: { author: 'ada', doc_id: 'p1' } };

    it("drops the pinned parent when its sharer's reply is on screen", () => {
        assert.deepEqual(collapseReplyPairs([reply, parent]), [reply]);
    });

    it('keeps a via-less parent - a direct follow is a first-class row', () => {
        const followed = { author: 'ada', doc_id: 'p1' };
        assert.deepEqual(collapseReplyPairs([reply, followed]), [reply, followed]);
    });

    it('keeps a share whose sharer is NOT the replier on screen', () => {
        const otherShare = { author: 'ada', doc_id: 'p1', via: 'cal' };
        assert.deepEqual(collapseReplyPairs([reply, otherShare]), [reply, otherShare]);
    });

    it('keeps your own rows no matter what', () => {
        const mine = { author: 'ada', doc_id: 'p1', via: 'bea', mine: true };
        assert.deepEqual(collapseReplyPairs([reply, mine]), [reply, mine]);
    });

    it('collapses nothing when the reply is not loaded - both rows honestly render', () => {
        assert.deepEqual(collapseReplyPairs([parent]), [parent]);
    });

    it('keys on the LEAD sharer only - a replier in the supporting crowd never hides the row', () => {
        // The lead carries the byline; the crowd behind it ("and four others") includes
        // bea, but the row is on screen AS cal's recommendation, and cal did not reply.
        // Collapsing it would erase cal's claim to make room for bea's - audited and
        // pinned as deliberate (PROJECT_PLAN's Replies slice 5).
        const crowd = {
            author: 'ada',
            doc_id: 'p1',
            via: 'cal',
            via_others: [{ root: 'bea' }],
        };
        assert.deepEqual(collapseReplyPairs([reply, crowd]), [reply, crowd]);
    });
});

describe('a fresh post holds the top, and a backdated one wears its date (2026-09-02)', () => {
    it('mergeFeed keeps a fresh item first whatever its date, and files it on the next load', async () => {
        const { mergeFeed } = await import('../../../js/pure/feed.js');
        const old = { author: 'a', doc_id: 'old', published_ms: 1_000_000 };
        const fresh = { author: 'a', doc_id: 'back', published_ms: 5, fresh: true };
        assert.deepEqual(
            mergeFeed([fresh], [old]).map((i) => i.doc_id),
            ['back', 'old'],
        );
        // Without the flag (a later page load), the date rules.
        assert.deepEqual(
            mergeFeed([{ ...fresh, fresh: false }], [old]).map((i) => i.doc_id),
            ['old', 'back'],
        );
    });

    it('isBackdated: a claim more than a minute before the mint, and nothing else', () => {
        const m = 10_000_000;
        assert.equal(isBackdated({ dated_ms: m - 86_400_000, minted_ms: m }), true);
        assert.equal(
            isBackdated({ dated_ms: m - 30_000, minted_ms: m }),
            false,
            'a bare "today" lands at the publish hour',
        );
        assert.equal(
            isBackdated({ dated_ms: m, minted_ms: m + 5_000 }),
            false,
            'a scheduled post mints on its claim',
        );
        assert.equal(isBackdated({ minted_ms: m }), false, 'no claim');
        assert.equal(
            isBackdated({ dated_ms: m - 86_400_000 }),
            false,
            'a fragment row knows no mint',
        );
        assert.equal(isBackdated(null), false);
    });
});

describe('docStatus: the three icons (PUBLISH.md ruling 6)', () => {
    it('private, public, scheduled - and a plan outranks a publication', () => {
        assert.equal(docStatus({ fields: {} }), 'private');
        assert.equal(docStatus({}), 'private');
        assert.equal(docStatus({ fields: { published_as: 'abc' } }), 'public');
        assert.equal(docStatus({ fields: { publish_plan: '{"at":1,"by":"x"}' } }), 'scheduled');
        assert.equal(
            docStatus({ fields: { published_as: 'abc', publish_plan: '{"at":1,"by":"x"}' } }),
            'scheduled',
        );
    });
});

// The feed's orders (PROJECT_PLAN's Scores and sort orders, slice 1): newest, or best over a
// window, spelled for the node's feed door.
describe('the feed orders', () => {
    it('words each order for the door: nothing for newest, best and its window - a year at the longest', () => {
        assert.deepEqual(FEED_SORTS, ['new', 'hot', 'day', 'week', 'month', 'year']);
        assert.equal(sortParams('new'), '');
        assert.equal(sortParams('hot'), 'sort=hot', 'hot has no window');
        assert.ok(
            isRankedSort('hot') && isRankedSort('week') && !isRankedSort('new'),
            'hot and best are ranked by the node',
        );
        assert.ok(!isBestSort('hot'), 'hot is not a best window');
        assert.equal(sortParams('week'), 'sort=best&window=week');
        assert.equal(
            sortParams('ever'),
            '',
            'no best ever: an old remembered choice reads as newest',
        );
        assert.equal(sortParams('nonsense'), '', 'an unknown order is newest');
        assert.ok(isBestSort('day') && !isBestSort('new') && !isBestSort(undefined));
    });
    it("keeps a ranked page in the node's order, deduplicating a post a moved score brought round twice", () => {
        const item = (doc, ms) => ({ author: 'a', doc_id: doc, published_ms: ms });
        const first = mergeRanked([], [item('old', 1), item('new', 9)]);
        assert.deepEqual(
            first.map((i) => i.doc_id),
            ['old', 'new'],
            'not re-sorted by date',
        );
        const more = mergeRanked(first, [item('new', 9), item('mid', 5)]);
        assert.deepEqual(
            more.map((i) => i.doc_id),
            ['old', 'new', 'mid'],
        );
        assert.deepEqual(
            mergeFeed([], [item('old', 1), item('new', 9)]).map((i) => i.doc_id),
            ['new', 'old'],
            'where mergeFeed would have',
        );
    });
});

// A thread's orders (slice 3): each level's replies sorted among themselves, asked as the viewer.
describe('the thread orders', () => {
    it('words each order for the replies door, as the viewer, and asks nothing of oldest first', () => {
        assert.deepEqual(REPLY_SORTS, ['old', 'hot', 'best']);
        assert.equal(replySortParams('old', 'me'), '');
        assert.equal(replySortParams('best', 'me'), 'sort=best&as=me');
        assert.equal(replySortParams('hot', 'me'), 'sort=hot&as=me');
        assert.equal(replySortParams('best', null), '', 'nobody signed in: nobody to score for');
        assert.equal(replySortParams('nonsense', 'me'), '');
    });
});

describe('the publish bar states its rows ahead of the stream (2026-10-01)', () => {
    let f;
    before(async () => {
        f = await import('../../../js/pure/feed.js');
    });
    const row = { doc_id: 'd', head: 'h2', fields: { description: 'x' } };
    it('published: the post, and this head as its public version - settled only when the server says both', () => {
        const p = f.withPublished(row, 'post1');
        assert.deepEqual(p.fields, {
            description: 'x',
            published_as: 'post1',
            published_head: 'h2',
        });
        assert.equal(f.docStatus(p), 'public');
        const settled = f.publishedSettled('post1');
        assert.equal(settled(row), false);
        assert.equal(
            settled({ ...row, fields: { published_as: 'post1', published_head: 'h1' } }),
            false,
            'an older public version',
        );
        assert.equal(settled(p), true);
    });
    it('scheduled, taken down, unscheduled - and no row, nothing to wear it', () => {
        assert.equal(f.docStatus(f.withScheduled(row, 123)), 'scheduled');
        const down = f.withoutPublication(f.withPublished(row, 'post1'));
        assert.deepEqual(down.fields, { description: 'x' });
        assert.equal(f.unpublishedSettled(down), true);
        assert.equal(f.unscheduledSettled(f.withoutSchedule(f.withScheduled(row, 5))), true);
        assert.equal(f.withPublished(undefined, 'p'), undefined);
    });
});
