// A post's first words, for surfaces that mention a post rather than show it (Curtis,
// 2026-09-05: an untitled post's mini-card "should try its best to extract some useful words
// from the post rather than just reading 'link' - the first 9 usable words from the text of
// the post, maybe, or the description if provided"). Pure: the mini-card fetches, this
// decides. Marquee and plaintext only; a book's body is a table, not words.

export const EXCERPT_WORDS = 9;

/// The author's own description annotation, if they wrote one - the one description.
export function descriptionOf(annotations, author) {
    const own = (annotations || []).find(
        (a) => a.key === 'description' && a.annotator === author && a.value && a.value.trim()
    );
    return own ? own.value.trim() : '';
}

/// A word is usable when it says something: letters or digits in it, and not an address.
const usable = (w) => /[\p{L}\p{N}]/u.test(w) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(w) && !/^www\./i.test(w);

/// Strip the markup down to its words: pictures and embeds go (their caption is a label,
/// not the post's words), a link keeps its text, code fences and inline code keep their
/// content, headings/emphasis/list markers/quotes shed their punctuation.
export function plainWords(body) {
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
export function excerpt(body, format, n = EXCERPT_WORDS) {
    if (format === 'book') return '';
    const words = plainWords(body);
    if (!words.length) return '';
    const head = words.slice(0, n).join(' ');
    return words.length > n ? `${head}\u2026` : head;
}
