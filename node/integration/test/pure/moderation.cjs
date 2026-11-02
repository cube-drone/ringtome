const assert = require('node:assert');

let moderationFor, reasonBytes, overruleKey, pictureAddresses, pictureVerdictFor, stronger;
before(async () => {
    ({ moderationFor, reasonBytes, overruleKey, pictureAddresses, pictureVerdictFor, stronger } =
        await import('../../../js/pure/moderation.js'));
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

    it("asks about a post's own pictures, and takes the strongest verdict among them", () => {
        const root = 'z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH';
        const a = `/ringtome/user/${root}/doc/${'a'.repeat(32)}/body`;
        const b = `https://elsewhere.example/ringtome/user/${root}/doc/${'b'.repeat(32)}/body/x.avif`;
        const song = `/ringtome/user/${root}/doc/${'c'.repeat(32)}/body/song.m4a`;
        const body = `![one](${a}) words ![two](${b}) ![again](${a}) ![s](${song}) ![web](https://x.example/p.png)`;
        assert.deepEqual(
            pictureAddresses(body),
            [a, b],
            'our own pictures, once each - no songs, no web',
        );

        const verdicts = {
            [a]: { level: 'warn', reason: 'looks like it', near: true, sources: [] },
            [b]: { level: 'block', reason: 'not here', near: false, sources: [] },
        };
        const v = pictureVerdictFor([a, b], verdicts);
        assert.deepEqual([v.kind, v.reason, v.near], ['block', 'not here', false]);
        assert.equal(pictureVerdictFor([a], verdicts).near, true);
        assert.equal(pictureVerdictFor([], verdicts).kind, null);
        const author = { kind: 'warn', reason: 'grumpy', sources: [] };
        assert.equal(stronger(author, v), v, 'a blocked picture outranks a warned author');
        assert.equal(
            stronger(author, pictureVerdictFor([a], verdicts)),
            author,
            'a tie keeps the first',
        );
    });
});
