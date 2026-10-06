// The tags and kinds whose meaning is fixed, and the icon each wears (Curtis, 2026-10-06: "there
// are certain tags that are implicit, so we could always display them with icons"). Values map to
// ROLES in icons.js, never to glyphs, so this stays a pure table and the drawing stays icons.js's.
// Read by the facet rows (facets.js) and the feed's label chips (postentry.js).
//
// The values are the node's own: the kinds a feed is narrowed by (search.rs `KINDS`), the implicit
// size and media tags it mints (documents.rs `IMPLICIT_TAGS`), the content warnings blurred by
// default (warnings.js `DEFAULT_BLUR`), and what a post was made with (made_with.rs).

/// A post's kind, as the "show" row names it.
export const KIND_ICON = {
    post: 'kindPost',
    reply: 'kindReply',
    rebroadcast: 'kindRebroadcast',
    book: 'kindBook',
    room: 'kindRoom',
};

/// What a post was made with: provenance only when its AUTHOR says so (made_with.rs) - anybody
/// else's "ai-agent" is a word.
export const MADE_WITH_TAGS = ['ai-agent', 'api-key'];

/// A tag's icon role, by the tag's value.
export const TAG_ICON = {
    micro: 'sizeMicro',
    short: 'sizeShort',
    medium: 'sizeMedium',
    long: 'sizeLong',
    audio: 'mediaAudio',
    image: 'mediaImage',
    video: 'mediaVideo',
    nsfw: 'warnExplicit',
    porn: 'warnExplicit',
    '18+': 'warnExplicit',
    assault: 'warnHarm',
    death: 'warnHarm',
    gore: 'warnHarm',
    'sexual assault': 'warnHarm',
    'ai-agent': 'aiAgent',
    'api-key': 'apiKey',
};

/// The icon role a tag wears, or null. `byAuthor`: whether the post's author is among those who
/// said it - a made-with tag wears its icon only then.
export const tagIconRole = (value, { byAuthor = true } = {}) => {
    const tag = String(value || '')
        .trim()
        .toLowerCase();
    if (MADE_WITH_TAGS.includes(tag) && !byAuthor) return null;
    return TAG_ICON[tag] || null;
};
