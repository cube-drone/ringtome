// Feed's publication state: a durable public fact, and a local editing gesture.
const assert = require('node:assert');

let FEED_STYLE, publishedState, openDraftOf, overlayPosted, recentPosts, mergePosts, postCursor;
before(async () => {
    ({ FEED_STYLE, publishedState, openDraftOf, overlayPosted, recentPosts, mergePosts,
        postCursor } = await import('../../../js/pure/feed.js'));
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

    it('skips posted items to find it', () => {
        const docs = [doc('c', 'p2'), doc('b', 'p1'), doc('a')];
        assert.equal(openDraftOf(docs).doc_id, 'a');
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
