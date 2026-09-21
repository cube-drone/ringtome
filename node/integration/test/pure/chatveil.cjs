/*
    The veil over a chat line's media (Curtis, 2026-09-19, and again 2026-09-20 for private
    chats): a picture from somebody this reader has not placed waits behind a click. The rule
    has one case that a future edit could quietly get wrong - the room's creator is exempt in
    a room, because you chose to enter their room, and NOT exempt in a chat for two, because
    there the creator is the other person and opening a chat with you is not a relationship.
*/
const assert = require('node:assert');

let veilsMedia, embedsMedia;
before(async () => {
    ({ veilsMedia, embedsMedia } = await import('../../../js/pure/chatveil.js'));
});

const ME = 'me';
const THEM = 'them';

describe('the veil over a chat line\'s media', () => {
    it('knows a line that embeds something from one that only talks about it', () => {
        assert.equal(embedsMedia('![a picture](/id/r/docs/d/body/p.avif)'), true);
        assert.equal(embedsMedia(':::media target=/id/r/docs/d/body/v.webm:::'), true);
        assert.equal(embedsMedia('just words'), false);
        assert.equal(embedsMedia(''), false);
        assert.equal(embedsMedia(null), false);
    });

    it('veils a stranger\'s picture and nobody else\'s', () => {
        const line = { words: '![](/id/r/docs/d/body/p.avif)', me: ME, author: 'host', im: false };
        assert.equal(veilsMedia({ ...line, speaker: THEM, trusted: false }), true, 'a stranger in a room');
        assert.equal(veilsMedia({ ...line, speaker: THEM, trusted: true }), false, 'somebody placed');
        assert.equal(veilsMedia({ ...line, speaker: ME, trusted: false }), false, "one's own");
        assert.equal(veilsMedia({ ...line, speaker: 'host', trusted: false }), false, 'the room\'s creator, whose room this is');
        assert.equal(veilsMedia({ ...line, words: 'just words', speaker: THEM, trusted: false }), false, 'nothing to veil');
        assert.equal(veilsMedia({ ...line, words: null, speaker: THEM, trusted: false }), false, 'words this computer cannot open');
    });

    it('lifts the creator\'s exemption in a chat for two - there the creator is the other person', () => {
        const line = { words: '![](/id/r/docs/d/body/p.avif)', me: ME, author: THEM, im: true };
        assert.equal(veilsMedia({ ...line, speaker: THEM, trusted: false }), true, 'they opened the chat; that is not trust');
        assert.equal(veilsMedia({ ...line, speaker: THEM, trusted: true }), false, 'trust placed, veil lifted');
        assert.equal(veilsMedia({ ...line, speaker: ME, trusted: false }), false, "one's own, in one's own chat");
        // The same line in the room the same person hosts reads the other way.
        assert.equal(
            veilsMedia({ ...line, im: false, speaker: THEM, trusted: false }),
            false,
            'a room is a place you chose to enter'
        );
    });
});
