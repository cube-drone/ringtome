// Where a post goes: one choice, as the feed's composer and the publish bar hold it, and the
// publish wishes it means.
const assert = require('node:assert');

let groupOfChoice, sealOfChoice, choiceOfDraft, publishWishes;
before(async () => {
    ({ groupOfChoice, sealOfChoice, choiceOfDraft, publishWishes } =
        await import('../../../js/pure/audience.js'));
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
});
