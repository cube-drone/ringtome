// A post's first words, for surfaces that mention a post rather than show it (Curtis,
// 2026-09-05: an untitled post's mini-card "should try its best to extract some useful words
// from the post rather than just reading 'link' - the first 9 usable words from the text of
// the post, maybe, or the description if provided"). Pure: the mini-card fetches, this
// decides. Marquee and plaintext only; a book's body is a table, not words.

export const EXCERPT_WORDS = 9;

/// The author's own description annotation, if they wrote one - the one description.
export function descriptionOf(annotations, author) {
    const own = (annotations || []).find(
        (a) => a.key === 'description' && a.annotator === author && a.value && a.value.trim(),
    );
    return own ? own.value.trim() : '';
}

/// A word is usable when it says something: letters or digits in it, and not an address.
const usable = (w) =>
    /[\p{L}\p{N}]/u.test(w) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(w) && !/^www\./i.test(w);

/// The text a Marquee tree says (2026-10-20: a turbolink card showed a bio as
/// `:::center [color=#dd3062]Cyber[/color]GAMER Canada`): every text and code node, blocks a space
/// apart. Pictures and embeds go (their caption is a label, not the words), a turbolink's address
/// too; a link keeps its text, an emoji isn't a word. The parser's own tree, so a directive, a
/// span or any markup still to come sheds itself without a pattern here knowing it.
const BLOCKS = new Set([
    'document',
    'paragraph',
    'heading',
    'blockquote',
    'list',
    'list_item',
    'directive',
    'invalid_directive',
]);
function textOf(node, out) {
    if (!node) return out;
    if (node.type === 'text') out.push(node.value);
    else if (node.type === 'code_span' || node.type === 'code_block') out.push(node.text);
    else if (node.type === 'hard_break' || node.type === 'thematic_break') out.push(' ');
    for (const child of node.children || []) textOf(child, out);
    if (BLOCKS.has(node.type)) out.push(' ');
    return out;
}

/// Marquee as plain text: what a card, a preview or a page's description says of it. Its
/// whitespace folded; the body as it came when it doesn't parse. `parse` is the Marquee parser's
/// (@cube-drone/marquee-parser), handed in by the caller: a pure module imports no package.
export function plainText(body, parse) {
    let said;
    try {
        said = textOf(parse(body || ''), []).join('');
    } catch {
        said = body || '';
    }
    return said.split(/\s+/).filter(Boolean).join(' ');
}

/// The words of a body: Marquee through its parser when `parse` is handed in (`plainText`), by
/// pattern when it isn't; anything else split as it stands. Only the usable ones - letters or
/// digits in them, and not an address.
export function plainWords(body, format = 'marquee', parse = null) {
    if (format !== 'marquee') return (body || '').split(/\s+/).filter((w) => w && usable(w));
    if (!parse) return markupWords(body);
    try {
        return textOf(parse(body || ''), [])
            .join('')
            .split(/\s+/)
            .filter((w) => w && usable(w));
    } catch {
        return markupWords(body);
    }
}

/// The old way, with no parser or for a body it refuses: strip the markup's punctuation by pattern.
function markupWords(body) {
    let s = body || '';
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' '); // ![caption](target)
    s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // [text](target) -> text
    s = s.replace(/```[a-z0-9_-]*/gi, ' ');
    s = s.replace(/^[ \t]*(#{1,6}|>+|[-*+]|\d+[.)])[ \t]+/gm, ''); // headings, quotes, list markers
    s = s.replace(/[*_`~]+/g, '');
    return s.split(/\s+/).filter((w) => w && usable(w));
}

/// The first N usable words, with an ellipsis when there were more. Empty when the post
/// has no words to offer (a picture alone, a book, nothing).
export function excerpt(body, format, n = EXCERPT_WORDS, parse = null) {
    if (format === 'book') return '';
    // A room's words are its description: the excerpt is fine for those.
    const words = plainWords(body, format, parse);
    if (!words.length) return '';
    const head = words.slice(0, n).join(' ');
    return words.length > n ? `${head}\u2026` : head;
}
