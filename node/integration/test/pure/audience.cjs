// Where a post goes: one choice, as the feed's composer and the publish bar hold it, and the
// publish wishes it means.
const assert = require('node:assert');

let groupOfChoice, asGroupOfChoice, sealOfChoice, choiceOfDraft, publishWishes, publishRequest;
before(async () => {
    ({
        groupOfChoice,
        asGroupOfChoice,
        sealOfChoice,
        choiceOfDraft,
        publishWishes,
        publishRequest,
    } = await import('../../../js/pure/audience.js'));
});

describe('where a post goes', () => {
    it('reads a group as a place and every list as a seal', () => {
        assert.equal(groupOfChoice('group:ab'), 'ab');
        assert.equal(groupOfChoice('tag:family'), null);
        assert.equal(sealOfChoice(''), null);
        assert.equal(sealOfChoice('group:ab'), null);
        assert.deepEqual(sealOfChoice('trusted'), { trusted_only: true });
        assert.deepEqual(sealOfChoice('onward'), { trusted_only: true, audience: '@onward' });
        assert.deepEqual(sealOfChoice('mentioned'), { trusted_only: true, audience: '@mentioned' });
        assert.deepEqual(sealOfChoice('tag:family'), { trusted_only: true, audience: 'family' });
    });

    it("starts a draft at the list its last publish named, or a copy's seal", () => {
        assert.equal(choiceOfDraft(null), '');
        assert.equal(choiceOfDraft({ audience: 'family' }), 'tag:family');
        assert.equal(choiceOfDraft({ audience: '@onward' }), 'onward');
        assert.equal(choiceOfDraft({ audience: '@mentioned' }), 'mentioned');
        assert.equal(choiceOfDraft({ seal: 'yes' }), 'trusted');
        assert.equal(choiceOfDraft({ audience: ' ', seal: 'no' }), '');
    });

    it('asks for a seal outright, and says so when going open over a sealed draft', () => {
        assert.deepEqual(publishWishes('tag:family', {}), {
            trusted_only: true,
            audience: 'family',
        });
        assert.deepEqual(
            publishWishes('trusted', { audience: 'family' }),
            { trusted_only: true, audience: '' },
            'trust alone clears a standing list',
        );
        assert.deepEqual(publishWishes('', {}), {}, 'an open post sends nothing new');
        assert.deepEqual(publishWishes('', { seal: 'yes' }), { trusted_only: false, audience: '' });
        assert.deepEqual(publishWishes('group:ab', { seal: 'yes' }), {}, "a group's door decides");
    });

    it('posts in public as a public group: an open post, named for the group', () => {
        assert.equal(asGroupOfChoice('as-group:ab'), 'ab');
        assert.equal(asGroupOfChoice('group:ab'), null, 'members-only is another choice');
        assert.equal(groupOfChoice('as-group:ab'), null);
        assert.equal(sealOfChoice('as-group:ab'), null, 'never sealed');
        assert.deepEqual(publishWishes('as-group:ab', {}), { as_group: 'ab' });
        assert.deepEqual(
            publishWishes('as-group:ab', { seal: 'yes' }),
            { as_group: 'ab', trusted_only: false, audience: '' },
            'open, over a sealed draft',
        );
    });

    it('sends one publish where its choice says, with what it is beside (plans/ONE_PUBLISH.md)', () => {
        const parent = { author: 'aa', doc_id: 'bb' };
        assert.deepEqual(publishRequest('group:g1', {}, { settled: true, reply_to: parent }), {
            group: 'g1',
            body: { settled: true, reply_to: parent },
        });
        assert.deepEqual(
            publishRequest('group:g1', { audience: 'family' }, { room: true, im: true }),
            { group: 'g1', body: { room: true } },
            'a group takes no seal and no IM',
        );
        assert.deepEqual(publishRequest('mentioned', {}, { room: true, im: true }), {
            group: null,
            body: { room: true, im: true, trusted_only: true, audience: '@mentioned' },
        });
        assert.deepEqual(
            publishRequest('as-group:g2', {}, { room: true }),
            {
                group: null,
                body: { room: true, as_group: 'g2' },
            },
            'a room as the group is asked, so the door can refuse it in words',
        );
        assert.deepEqual(
            publishRequest(null, { audience: 'family' }, { settled: true }),
            { group: null, body: { settled: true } },
            'as it stands: an update keeps its wishes',
        );
        assert.deepEqual(publishRequest('', { seal: 'yes' }), {
            group: null,
            body: { trusted_only: false, audience: '' },
        });
    });
});
