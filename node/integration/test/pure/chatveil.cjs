/*
    The veil over a chat line's media (Curtis, 2026-09-19, and again 2026-09-20 for private
    chats): a picture from somebody this reader has not placed waits behind a click. The rule
    has one case that a future edit could quietly get wrong - the room's creator is exempt in
    a room, because you chose to enter their room, and NOT exempt in a chat for two, because
    there the creator is the other person and opening a chat with you is not a relationship.
    And behind the veil nothing is drawn at all (2026-10-18): a line may carry a picture from the
    open web, and a picture drawn blurred has been fetched from wherever its sender chose.
*/
const assert = require('node:assert');

let veilsMedia, embedsMedia, withoutMedia;
before(async () => {
    ({ veilsMedia, embedsMedia, withoutMedia } = await import('../../../js/pure/chatveil.js'));
});

const ME = 'me';
const THEM = 'them';

describe("the veil over a chat line's media", () => {
    it('knows a line that embeds something from one that only talks about it', () => {
        assert.equal(embedsMedia('![a picture](/id/r/docs/d/body/p.avif)'), true);
        assert.equal(embedsMedia(':::media target=/id/r/docs/d/body/v.webm:::'), true);
        assert.equal(embedsMedia('just words'), false);
        assert.equal(embedsMedia(''), false);
        assert.equal(embedsMedia(null), false);
    });

    it('knows everything a line can draw from elsewhere', () => {
        assert.equal(embedsMedia('![](https://example.com/horse.png)'), true, 'a web picture');
        assert.equal(
            embedsMedia('https://example.com/horse.png'),
            true,
            'its address alone, a turbolink',
        );
        assert.equal(
            embedsMedia('look:\n  https://example.com/page  '),
            true,
            "a card with its page's picture",
        );
        assert.equal(
            embedsMedia(':::panel background=tile:https://example.com/t.png\nhi\n:::'),
            true,
            'a tile',
        );
        assert.equal(
            embedsMedia(':::turbolink target=https://example.com/horse.png level=full:::'),
            true,
            'the turbolink spelled out',
        );
        assert.equal(
            embedsMedia('see https://example.com/page for more'),
            false,
            'a link inside words is only a link',
        );
        assert.equal(
            embedsMedia('https://example.com/ringtome/user/x/post/y'),
            false,
            "a /ringtome/ card is this node's",
        );
        assert.equal(embedsMedia('https://example.com/@ada'), false, 'and so is an /@ one');
    });

    it('draws a veiled line with nothing fetched', () => {
        const profile = {
            media: () => ({ kind: 'image', url: 'https://example.com/horse.png' }),
            turbolink: () => '<img>',
            emoji: () => 'x',
        };
        const bare = withoutMedia(profile);
        assert.equal(bare.media('https://example.com/horse.png'), null);
        assert.equal(bare.turbolink('https://example.com/horse.png', 'full'), null);
        assert.equal(bare.emoji('smile'), 'x', 'the rest of the profile stands');
    });

    it("veils a stranger's picture and nobody else's", () => {
        const line = { words: '![](/id/r/docs/d/body/p.avif)', me: ME, author: 'host', im: false };
        assert.equal(
            veilsMedia({ ...line, speaker: THEM, trusted: false }),
            true,
            'a stranger in a room',
        );
        assert.equal(
            veilsMedia({ ...line, speaker: THEM, trusted: true }),
            false,
            'somebody placed',
        );
        assert.equal(veilsMedia({ ...line, speaker: ME, trusted: false }), false, "one's own");
        assert.equal(
            veilsMedia({ ...line, speaker: 'host', trusted: false }),
            false,
            "the room's creator, whose room this is",
        );
        assert.equal(
            veilsMedia({ ...line, words: 'just words', speaker: THEM, trusted: false }),
            false,
            'nothing to veil',
        );
        assert.equal(
            veilsMedia({ ...line, words: null, speaker: THEM, trusted: false }),
            false,
            'words this computer cannot open',
        );
    });

    it("lifts the creator's exemption in a chat for two - there the creator is the other person", () => {
        const line = { words: '![](/id/r/docs/d/body/p.avif)', me: ME, author: THEM, im: true };
        assert.equal(
            veilsMedia({ ...line, speaker: THEM, trusted: false }),
            true,
            'they opened the chat; that is not trust',
        );
        assert.equal(
            veilsMedia({ ...line, speaker: THEM, trusted: true }),
            false,
            'trust placed, veil lifted',
        );
        assert.equal(
            veilsMedia({ ...line, speaker: ME, trusted: false }),
            false,
            "one's own, in one's own chat",
        );
        // The same line in the room the same person hosts reads the other way.
        assert.equal(
            veilsMedia({ ...line, im: false, speaker: THEM, trusted: false }),
            false,
            'a room is a place you chose to enter',
        );
    });
});
