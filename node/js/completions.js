// Contextual pop-up helpers while typing (CodeMirror autocompletion sources): type the tag's
// first character and a searchable picker hovers at the caret - pick to fill the whole tag, or
// just keep typing and it steps aside (Escape also dismisses; it never blocks the keys).
//
// The planned trio: `:` emoji (this file, phase one), `[` a link picker over the bucket's
// documents, `!` a media picker over the bucket's files - each a source in this module, handed
// to LiveMarquee by the hosting editor.
import { nameToEmoji } from 'gemoji';

// Built once: every gemoji as a completion - the label is the marquee source form (`:smile:`,
// what filling inserts; marquee renders it via the profile's emoji table), the detail shows
// the glyph itself so picking is visual.
const EMOJI_OPTIONS = Object.entries(nameToEmoji).map(([name, ch]) => ({
    label: `:${name}:`,
    detail: ch,
    boost: 0,
}));

/// The `:` picker. Matches a partial `:slug` behind the caret; CodeMirror filters the option
/// list as the slug grows. A completed `:slug:` stops matching, so the picker folds away the
/// moment an emoji is whole.
export function emojiCompletions(context) {
    const word = context.matchBefore(/:[\w+-]*$/);
    if (!word) return null;
    // Bare `:` only pops explicitly-adjacent to typing (it always is, when live), but never
    // fires on a colon inside a completed pair - the trailing-`:` case above.
    return {
        from: word.from,
        options: EMOJI_OPTIONS,
        validFor: /^:[\w+-]*$/,
    };
}
