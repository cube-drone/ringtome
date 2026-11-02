const assert = require('node:assert');

let moderationFor, reasonBytes, overruleKey;
before(async () => {
    ({ moderationFor, reasonBytes, overruleKey } = await import('../../../js/pure/moderation.js'));
});

describe('moderation lists, as a post meets them (2026-11-02)', () => {
    const said = (author, level, reason) => ({ author, level, reason, said_ms: 1 });
    const entry = (target, level, sources, overruled = false) => ({
        kind: 'persona',
        target,
        level,
        overruled,
        sources,
    });

    it("takes the strongest level, with its reason, and never judges the reader's own posts", () => {
        const taken = [
            entry('troll', 'block', [
                said('official', 'block', 'court order'),
                said('rache', 'warn', 'rude'),
            ]),
            entry('grump', 'warn', [said('rache', 'warn', 'grumpy about ponies')]),
        ];
        const ctx = { me: 'me', taken, factsByRoot: {} };
        assert.deepEqual(
            [moderationFor('troll', ctx).kind, moderationFor('troll', ctx).reason],
            ['block', 'court order'],
        );
        assert.equal(moderationFor('grump', ctx).kind, 'warn');
        assert.equal(moderationFor('grump', ctx).reason, 'grumpy about ponies');
        assert.equal(moderationFor('friend', ctx).kind, null);
        assert.equal(moderationFor('me', { ...ctx, taken: [entry('me', 'block', [])] }).kind, null);
    });

    it("an overrule silences an entry; the reader's own block needs no list", () => {
        const taken = [entry('troll', 'block', [said('official', 'block', 'spam')], true)];
        assert.equal(moderationFor('troll', { me: 'me', taken, factsByRoot: {} }).kind, null);
        const blocked = { troll: { blocked: 'yes' } };
        assert.equal(
            moderationFor('troll', { me: 'me', taken: [], factsByRoot: blocked }).kind,
            'block',
        );
    });

    it('a post the reader hid goes as their own block does, and only that post', () => {
        const ctx = { me: 'me', taken: [], factsByRoot: {}, hidden: ['troll:d1'] };
        assert.equal(moderationFor('troll', { ...ctx, doc: 'd1' }).kind, 'block');
        assert.equal(moderationFor('troll', { ...ctx, doc: 'd2' }).kind, null);
        assert.equal(moderationFor('troll', ctx).kind, null, 'no post, no hiding');
    });

    it('counts a reason in bytes, as the node does', () => {
        assert.equal(reasonBytes('horse'), 5);
        assert.equal(reasonBytes('说'), 3);
        assert.equal(reasonBytes('🐴'), 4);
        assert.equal(overruleKey('persona', 'aa'), 'persona:aa');
    });
});
