// The `@` trigger and the user card's source (2026-09-06). Pure, so the picker and its test
// share one rule: an `@` opens the people picker only at a WORD START - the start of a line
// or after whitespace - never inside a word, so an email address or a mid-token `@` stays
// text. The card itself is Marquee's leaf directive on its own line: the grammar makes a
// directive a block, so a card sits between paragraphs rather than inside a sentence.

export const CARD_DIRECTIVE = 'user';

/// The characters a name may run to while the picker is open: names have spaces, so the
/// query keeps going across them, but it stops at a line or another `@`.
const QUERY_MAX = 40;

/// The picker's match for the text before the caret: `{ from, query }` with `from` the
/// offset of the `@` within `before` and `query` the letters typed after it, or `null`
/// when no word-start `@` is open.
export function mentionQuery(before) {
    const re = new RegExp(`(^|\\s)@([^\\n@]{0,${QUERY_MAX}})$`);
    const m = re.exec(before || '');
    if (!m) return null;
    return { from: before.length - m[2].length - 1, query: m[2] };
}

/// The block card's source for one address - the /id path the page itself answers to.
export function userCardSource(address) {
    return `:::${CARD_DIRECTIVE} id=/id/${address}:::`;
}

/// The inline card's source - Marquee's span, the same name and attribute, with the
/// person's name inside it so a renderer that knows no `user` span still shows who was
/// meant (and so the live preview never sees an empty mark, which it cannot decorate).
export function userSpanSource(address, name) {
    return `[${CARD_DIRECTIVE} id=/id/${address}]${name || address}[/${CARD_DIRECTIVE}]`;
}

/// Which shape the picker fills (Curtis, 2026-09-06): a card on a line of its own when the
/// line holds nothing but the summons, a span in the line when there are words around it.
/// `before` is the line's text up to the `@`, `after` the rest of the line past the caret.
export function mentionShape(before, after) {
    return (before || '').trim() || (after || '').trim() ? 'span' : 'block';
}
