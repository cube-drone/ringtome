// What a chat line's media waits behind (CHAT.md; Curtis, 2026-09-19 and 2026-09-20).
//
// A picture from somebody this reader has not placed arrives unasked - "baddies might want to
// pop on to a chat channel and drop in nasty images or sounds" - so it waits behind a button
// that says whose it is, and is not drawn at all until that's clicked (Curtis, 2026-10-18):
// a room line may carry a picture from the open web, which loads from wherever its sender
// chose, and a picture drawn blurred has been fetched all the same. Behind the veil the
// words stand with no media in them (`withoutMedia`); the click is the consent to fetch.
//
// The rule has one subtlety, which is why it lives here with its vectors rather than inline
// in a component. The room's CREATOR is exempt in an ordinary room - they opened the door,
// and dimming the host of the room you chose to enter reads as nonsense - but in a chat for
// two the creator IS the other person, and opening a chat with somebody is not a relationship
// with them. So the exemption holds in a room and lifts in an IM.

/// Does this body draw anything from elsewhere? The spellings a chat line can carry: Marquee's
/// image shorthand, the media directive, a tiled background, and a web address on a line of its
/// own - a turbolink, which draws a picture's address as the picture and a page's as a card
/// with the page's own picture on it. Not a `/ringtome/` or `/@` address, whose card this node
/// draws. Deliberately a cheap text test - a line that merely says `![` in prose wears the
/// veil, which costs a click and never a picture.
export const embedsMedia = (words) =>
    /!\[|:::media\b|\btile:/.test(words || '') ||
    (words || '')
        .split('\n')
        .some(
            (line) => /^\s*https?:\/\/\S+\s*$/.test(line) && !/\/ringtome\/|\/@[^/\s]/.test(line),
        );

/// A Marquee profile that draws no media: every embed its placeholder, every turbolink its bare
/// address. What a veiled line renders with, so nothing behind the veil is fetched.
export const withoutMedia = (profile) => ({ ...profile, media: () => null, turbolink: () => null });

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
