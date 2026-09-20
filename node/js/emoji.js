// The emoji palette (Curtis, 2026-08-31): the nine in pole position, then the whole gemoji
// table - the same table the marquee editor's `:` completions draw from - deduped (gemoji
// aliases share characters). Shared by the post card's label strip and the room's reaction
// picker (CHAT.md, slice 9); a reaction travels as the shortcode, `:name:`, and is drawn
// back as its glyph here. Not under pure/: it leans on the gemoji package.
import { nameToEmoji } from 'gemoji';

export const POLE_EMOJI = [
    ['heart', '\u2764\uFE0F'],
    ['thumbs up', '\u{1F44D}'],
    ['thumbs down', '\u{1F44E}'],
    ['rofl', '\u{1F923}'],
    ['crying', '\u{1F622}'],
    ['rolling eyes', '\u{1F644}'],
    ['thinking', '\u{1F914}'],
    ['partying', '\u{1F973}'],
    ['people hugging', '\u{1FAC2}'],
    ['poop', '\u{1F4A9}'],
];

export const EMOJI_PALETTE = (() => {
    const seen = new Set(POLE_EMOJI.map(([, ch]) => ch));
    const rest = [];
    for (const [name, ch] of Object.entries(nameToEmoji)) {
        if (seen.has(ch)) continue;
        seen.add(ch);
        rest.push([name, ch]);
    }
    return rest;
})();

// The gemoji name for a glyph (the pole names are labels, not gemoji names).
const NAME_OF = (() => {
    const m = new Map();
    for (const [name, ch] of Object.entries(nameToEmoji)) if (!m.has(ch)) m.set(ch, name);
    return m;
})();

/// `:name:` for a glyph, or null when gemoji has no name for it.
export const shortcodeOf = (glyph) => {
    const name = NAME_OF.get(glyph);
    return name ? `:${name}:` : null;
};

/// The glyph for `:name:`, or the code itself when unknown.
export const glyphOf = (code) => {
    const m = /^:([a-z0-9_+-]+):$/.exec(code || '');
    return (m && nameToEmoji[m[1]]) || code;
};
