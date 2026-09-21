// What a chat line's media waits behind (CHAT.md; Curtis, 2026-09-19 and 2026-09-20).
//
// A picture from somebody this reader has not placed arrives unasked - "baddies might want to
// pop on to a chat channel and drop in nasty images or sounds" - so it renders blurred behind
// a button that says whose it is, and nothing is fetched differently: the veil is about
// consent to look, not about bytes.
//
// The rule has one subtlety, which is why it lives here with its vectors rather than inline
// in a component. The room's CREATOR is exempt in an ordinary room - they opened the door,
// and dimming the host of the room you chose to enter reads as nonsense - but in a chat for
// two the creator IS the other person, and opening a chat with somebody is not a relationship
// with them. So the exemption holds in a room and lifts in an IM.

/// Does this body embed media at all? The two spellings a chat line can carry: Marquee's
/// image shorthand and the media directive. Deliberately a cheap text test - a line that
/// merely says `![` in prose wears the veil, which costs a click and never a picture.
export const embedsMedia = (words) => /!\[|:::media\b/.test(words || '');

/**
 * Should this line's media wait behind the veil?
 *
 * @param words     the line's words, or null when this computer cannot open them
 * @param speaker   who said it, root hex
 * @param me        the reading persona's root hex
 * @param author    the room's creator, root hex
 * @param im        is this room a chat for two (CHAT.md, ruling 12)
 * @param trusted   has this reader placed trust in the speaker
 */
export const veilsMedia = ({ words, speaker, me, author, im, trusted }) => {
    if (words === null || words === undefined || !embedsMedia(words)) return false;
    if (speaker === me || trusted) return false;
    return im ? true : speaker !== author;
};
