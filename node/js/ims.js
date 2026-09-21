// Private chats (CHAT.md, ruling 12): a room sealed to exactly one other person. One chat
// per pair, whichever of the two opened it, so opening one asks the node for the chat that
// already exists before minting a second beside it. The minting lives here rather than in
// the Chat app because the button that starts a chat sits on a person's page.
import { api } from './net.js';
import { speakable } from './speakable.js';

/// The bucket a room's draft sits in - what makes it a chat rather than a note.
export const CHAT_STYLE = 'chat';

/// The room's words: a user card naming the other person. The card IS the audience the post
/// is sealed to (*Contact tags*, ruling 5 - "only the people mentioned"), so the words and
/// the door say the same thing, and the mint needs no second way to name a pair.
const cardFor = (root) => `:::user id=/id/${speakable(root)}:::`;

/// The private chat with this person, minted if there isn't one yet. Answers the room's
/// address, `{ author, doc_id }` - the author being whichever of the two opened it, which
/// is bookkeeping: the window is titled with the other person either way.
export async function openIm(root, other, name) {
    try {
        return await api(`/api/identity/${root}/ims/${encodeURIComponent(other)}`);
    } catch (e) {
        // No chat yet is the one refusal that means "mint one"; anything else is real.
        if (e.status !== 404) throw e;
    }
    const made = await api(`/api/identity/${root}/docs`, {
        method: 'POST',
        body: JSON.stringify({ title: name || '', body: cardFor(other), format: 'marquee' }),
    });
    await api(`/api/identity/${root}/docs/${made.doc_id}/buckets/${encodeURIComponent(CHAT_STYLE)}`, { method: 'PUT' });
    const posted = await api(`/api/identity/${root}/docs/${made.doc_id}/publish`, {
        method: 'POST',
        body: JSON.stringify({
            room: true,
            im: true,
            trusted_only: true,
            audience: '@mentioned',
            tz_offset_min: new Date().getTimezoneOffset(),
        }),
    });
    return { author: root, doc_id: posted.post_id };
}
