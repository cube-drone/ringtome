// Feed's publication state: a durable public fact, and a local editing gesture.
const assert = require('node:assert');

let FEED_STYLE, publishedState, openDraftOf;
before(async () => {
    ({ FEED_STYLE, publishedState, openDraftOf } = await import('../../../js/pure/feed.js'));
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
