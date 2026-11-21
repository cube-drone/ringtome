// Relationship stories (2026-11-21): the contact dials read as a named relationship. The table
// is Curtis's; the one departure (a plain follow sits a stop of interest above a quiet one,
// since his table gave both the same settings) is pinned here too.
const assert = require('node:assert');

let STORIES, CUSTOM, storyOf, storyWrites, storyOpacity;
before(async () => {
    ({ STORIES, CUSTOM, storyOf, storyWrites, storyOpacity } =
        await import('../../../js/pure/stories.js'));
});

const facts = (id) => Object.fromEntries(storyWrites(id, { edges_public: 'no' }));

describe('relationship stories', () => {
    it('offers the seven, most distant first', () => {
        assert.deepEqual(
            STORIES.map((s) => s.id),
            ['quiet-follow', 'follow', 'fan', 'acquaintance', 'friend', 'quiet-friend', 'family'],
        );
    });

    it('no two stories share a setting, so each reads back as itself', () => {
        for (const story of STORIES) {
            const picked = Object.fromEntries(storyWrites(story.id, {}));
            // A story that publishes writes nothing for visibility onto an untouched record:
            // published is the resting state.
            assert.equal('edges_public' in picked, !story.open, story.id);
            assert.equal(storyOf(picked), story.id);
        }
    });

    it("reads Curtis's table off the dials", () => {
        assert.equal(storyOf({ edges_public: 'no', interest: 'low' }), 'quiet-follow');
        assert.equal(storyOf({ edges_public: 'no', interest: 'medium' }), 'follow');
        assert.equal(
            storyOf({ trust: 'low', interest: 'medium', interest_rebroadcasts: 'medium' }),
            'fan',
        );
        assert.equal(
            storyOf({ trust: 'medium', interest: 'low', interest_rebroadcasts: 'low' }),
            'acquaintance',
        );
        assert.equal(
            storyOf({ trust: 'high', interest: 'medium', interest_rebroadcasts: 'medium' }),
            'friend',
        );
        assert.equal(storyOf({ trust: 'high', interest: 'low' }), 'quiet-friend');
        assert.equal(
            storyOf({
                edges_public: 'yes',
                trust: 'max',
                interest: 'high',
                interest_rebroadcasts: 'high',
            }),
            'family',
        );
    });

    it('an unset dial and one at its bottom stop read alike', () => {
        assert.equal(
            storyOf({ trust: 'high', interest: 'low', interest_rebroadcasts: 'none' }),
            'quiet-friend',
        );
        assert.equal(
            storyOf({ edges_public: 'no', trust: 'none', interest: 'low' }),
            'quiet-follow',
        );
    });

    it('anything else is custom - and visibility is part of the story', () => {
        assert.equal(storyOf({ interest: 'max' }), CUSTOM);
        // A friend kept private is no longer the story called friend.
        assert.equal(
            storyOf({
                edges_public: 'no',
                trust: 'high',
                interest: 'medium',
                interest_rebroadcasts: 'medium',
            }),
            CUSTOM,
        );
        // A quiet follow made public is not one either.
        assert.equal(storyOf({ interest: 'low' }), CUSTOM);
    });

    it('nothing dialled tells no story', () => {
        assert.equal(storyOf({}), null);
        assert.equal(storyOf(null), null);
        assert.equal(storyOf({ nickname: 'Bee', edges_public: 'no' }), null);
        assert.equal(
            storyOf({ trust: 'none', interest: 'none', interest_rebroadcasts: 'none' }),
            null,
        );
    });

    it('picking a story writes only the dials that move', () => {
        assert.deepEqual(facts('family'), {
            edges_public: 'yes',
            trust: 'max',
            interest: 'high',
            interest_rebroadcasts: 'high',
        });
        const friend = { trust: 'high', interest: 'medium', interest_rebroadcasts: 'medium' };
        assert.deepEqual(storyWrites('friend', friend), []);
        assert.deepEqual(storyWrites('quiet-friend', friend), [
            ['interest', 'low'],
            ['interest_rebroadcasts', 'none'],
        ]);
        assert.deepEqual(storyWrites('follow', friend), [
            ['edges_public', 'no'],
            ['trust', 'none'],
            ['interest_rebroadcasts', 'none'],
        ]);
        assert.deepEqual(storyWrites('nonsense', friend), []);
    });

    it('draws the icon 70% solid for the most distant, whole for the closest and for custom', () => {
        assert.deepEqual(
            STORIES.map((s) => storyOpacity(s.id)),
            [0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1],
        );
        assert.equal(storyOpacity(CUSTOM), 1);
    });
});
