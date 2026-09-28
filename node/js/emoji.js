// The emoji palette (Curtis, 2026-08-31): the pole rows first, then the whole gemoji
// table - the same table the marquee editor's `:` completions draw from - deduped (gemoji
// aliases share characters). Shared by the post card's label strip and the room's reaction
// picker (CHAT.md, slice 9); a reaction travels as the shortcode, `:name:`, and is drawn
// back as its glyph here. Not under pure/: it leans on the gemoji package.
import { h } from 'preact';
import htm from 'htm';
import { nameToEmoji } from 'gemoji';

const html = htm.bind(h);

// The pole, in three rows (Curtis, 2026-09-27): the glad answers on green, the sour ones on
// red, and a row of the merely useful - so which way a reaction leans is seen before it is read.
export const POLE_ROWS = [
    {
        tone: 'good',
        className: 'label-emoji-row-good',
        emoji: [
            ['heart', '\u2764\uFE0F'],
            ['thumbs up', '\u{1F44D}'],
            ['rofl', '\u{1F923}'],
            ['people hugging', '\u{1FAC2}'],
            ['100', '\u{1F4AF}'],
            ['horse', '\u{1F434}'],
            ['heart eyes', '\u{1F60D}'],
            ['hot face', '\u{1F975}'],
            ['sunglasses', '\u{1F60E}'],
            ['point up', '\u{1F446}'],
        ],
    },
    {
        tone: 'bad',
        className: 'label-emoji-row-bad',
        emoji: [
            ['thumbs down', '\u{1F44E}'],
            ['poop', '\u{1F4A9}'],
            ['rolling eyes', '\u{1F644}'],
            ['vomiting', '\u{1F92E}'],
            ['nauseated', '\u{1F922}'],
            ['cursing', '\u{1F92C}'],
            ['melting', '\u{1FAE0}'],
            ['cold face', '\u{1F976}'],
            ['zipper mouth', '\u{1F910}'],
            ['troll', '\u{1F9CC}'],
        ],
    },
    {
        tone: 'plain',
        className: 'label-emoji-row-plain',
        emoji: [
            ['thinking', '\u{1F914}'],
            ['eyes', '\u{1F440}'],
            ['surprised', '\u{1F62E}'],
            ['crying', '\u{1F622}'],
            ['partying', '\u{1F973}'],
            ['question', '\u2753'],
            ['ear', '\u{1F442}'],
            ['full moon face', '\u{1F31D}'],
            ['grimacing', '\u{1F62C}'],
            ['blush', '\u{1F60A}'],
        ],
    },
];

export const POLE_EMOJI = POLE_ROWS.flatMap((row) => row.emoji);

// A glyph's lean, from the pole rows (Curtis, 2026-09-27: a reaction on a post wears its
// row's colour) - 'good', 'bad', or null for everything else. Matched without the variation
// selector, so a heart said as a bare U+2764 leans the same way as the palette's.
const bare = (glyph) => String(glyph || '').replace(/\uFE0F/g, '');
const TONE_OF = new Map(
    POLE_ROWS.filter((row) => row.tone !== 'plain').flatMap((row) => row.emoji.map(([, ch]) => [bare(ch), row.tone]))
);
export const toneOf = (glyph) => TONE_OF.get(bare(glyph)) || null;

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

/// The picker's strip: the pole rows, each on its tone, then the whole table - every part
/// narrowed by `hit([name, glyph])`, an emptied row left out. `chip` draws one emoji.
export const EmojiStrip = ({ hit, chip, className = '' }) => {
    const rows = POLE_ROWS.map((row) => ({ ...row, emoji: row.emoji.filter(hit) })).filter((row) => row.emoji.length);
    const rest = EMOJI_PALETTE.filter(hit);
    if (!rows.length && !rest.length) return '';
    return html`<span class=${`label-emoji-strip ${className}`}>
        ${rows.map(
            (row) => html`<span class=${`label-emoji-row ${row.className}`} key=${row.tone}>${row.emoji.map(chip)}</span>`
        )}
        ${rows.length > 0 && rest.length > 0 && html`<span class="label-emoji-pole-break"></span>`}
        ${rest.map(chip)}
    </span>`;
};
