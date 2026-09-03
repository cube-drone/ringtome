// Feed's publication state: a durable public fact, and a local editing gesture.
const assert = require('node:assert');

let FEED_STYLE, publishedState, openDraftOf, overlayPosted, recentPosts, mergePosts, postCursor, isBackdated,
    emphasisOf, leadOf, mergeFeed, feedCursor, postScale, POST_SCALE_MIN,
    postImageCap, POST_IMAGE_MAX, POST_IMAGE_MIN, collapseReplyPairs;
before(async () => {
    ({ FEED_STYLE, publishedState, openDraftOf, overlayPosted, recentPosts, mergePosts, isBackdated,
        postCursor, emphasisOf, leadOf, mergeFeed, feedCursor, postScale, POST_SCALE_MIN,
        postImageCap, POST_IMAGE_MAX, POST_IMAGE_MIN, collapseReplyPairs } = await import(
        '../../../js/pure/feed.js'
    ));
});

const draft = { fields: {} };
const posted = { fields: { published_as: 'ab'.repeat(8) } };

describe('feed publication state', () => {
    it('names its one bucket', () => {
        assert.equal(FEED_STYLE, 'feed');
    });

    it('a draft is open and says so', () => {
        const s = publishedState(draft);
        assert.equal(s.published, false);
        assert.equal(s.locked, false);
        assert.equal(s.label, 'draft');
        assert.equal(s.postId, '');
    });

    it('posting seals it by default - editing the past costs a moment', () => {
        const s = publishedState(posted);
        assert.equal(s.published, true);
        assert.equal(s.locked, true);
        assert.equal(s.label, 'posted');
        assert.equal(s.postId, 'ab'.repeat(8));
    });

    it('the unlock is a LOCAL override that beats the default, both ways', () => {
        assert.equal(publishedState(posted, 'open').locked, false, 'unlocked for repairs');
        assert.equal(publishedState(posted, 'open').label, 'posted - editing');
        assert.equal(publishedState(draft, 'locked').locked, true, 'a draft you consider done');
        // And publication itself never stops being true, whatever the local gesture says.
        assert.equal(publishedState(posted, 'open').published, true);
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
        assert.deepEqual(got.map((x) => x.doc_id), ['new', 'mid', 'old']);
    });

    it('does not reorder the caller\'s array - the profile is not ours to shuffle', () => {
        const given = [p('old', 100), p('new', 300)];
        recentPosts(given);
        assert.deepEqual(given.map((x) => x.doc_id), ['old', 'new']);
    });

    it('sorts a post with no timestamp LAST, not to the top', () => {
        const got = recentPosts([p('nostamp'), p('real', 5)]);
        assert.deepEqual(got.map((x) => x.doc_id), ['real', 'nostamp']);
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
        assert.deepEqual(got.map((x) => x.doc_id), ['c', 'b', 'a']);
    });

    it('DEDUPES - a re-published post can arrive on two pages', () => {
        const got = mergePosts([p('c', 300), p('b', 200)], [p('b', 200), p('a', 100)]);
        assert.deepEqual(got.map((x) => x.doc_id), ['c', 'b', 'a']);
    });

    it('keeps the first sighting, so what is on screen stays where the eye left it', () => {
        const got = mergePosts([p('b', 200)], [{ doc_id: 'b', published_ms: 200, title: 'later' }]);
        assert.equal(got.length, 1);
        assert.equal(got[0].title, undefined, 'the row already shown, not the one that followed');
    });

    it('takes an empty or missing page without complaint', () => {
        assert.deepEqual(mergePosts([p('a', 1)], []).map((x) => x.doc_id), ['a']);
        assert.deepEqual(mergePosts([p('a', 1)]).map((x) => x.doc_id), ['a']);
        assert.deepEqual(mergePosts(undefined, [p('a', 1)]).map((x) => x.doc_id), ['a']);
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
        assert.equal(emphasisOf('75'), 'normal', 'the retired numeric scale is silence, not a weight');
    });

    it('cuts a low-interest multi-paragraph item to its first paragraph', () => {
        const { lead, cut } = leadOf('the lead.\n\nthe rest, at length.', 'low');
        assert.equal(lead, 'the lead.');
        assert.equal(cut, true);
    });

    it('leaves a short item whole whatever the interest', () => {
        assert.deepEqual(leadOf('brief.', 'low'), { lead: 'brief.', cut: false });
    });

    it('never cuts a high-interest source - that is its importance', () => {
        const long = 'x'.repeat(5000);
        assert.deepEqual(leadOf(long, 'high'), { lead: long, cut: false });
    });

    it('slices an unbroken low-interest wall at a word boundary', () => {
        const wall = ('word '.repeat(200)).trim();
        const { lead, cut } = leadOf(wall, 'low');
        assert.ok(cut);
        assert.ok(lead.length < 300);
        assert.ok(lead.endsWith('\u2026'), 'and says it was cut');
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
        assert.deepEqual(merged.map((i) => i.doc_id), ['y', 'x', 'z']);
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

    it('drops the pinned parent when its sharer\'s reply is on screen', () => {
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
        assert.deepEqual(mergeFeed([fresh], [old]).map((i) => i.doc_id), ['back', 'old']);
        // Without the flag (a later page load), the date rules.
        assert.deepEqual(mergeFeed([{ ...fresh, fresh: false }], [old]).map((i) => i.doc_id), ['old', 'back']);
    });

    it('isBackdated: a claim more than a minute before the mint, and nothing else', () => {
        const m = 10_000_000;
        assert.equal(isBackdated({ dated_ms: m - 86_400_000, minted_ms: m }), true);
        assert.equal(isBackdated({ dated_ms: m - 30_000, minted_ms: m }), false, 'a bare "today" lands at the publish hour');
        assert.equal(isBackdated({ dated_ms: m, minted_ms: m + 5_000 }), false, 'a scheduled post mints on its claim');
        assert.equal(isBackdated({ minted_ms: m }), false, 'no claim');
        assert.equal(isBackdated({ dated_ms: m - 86_400_000 }), false, 'a fragment row knows no mint');
        assert.equal(isBackdated(null), false);
    });
});
