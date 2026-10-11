// What a search found, shown (Curtis, 2026-10-10: "display excerpts of the post that contain
// matching search results, with the search results highlighted"): a post's words as plain text,
// the few stretches of it around the words searched for, and any text split into its marked and
// unmarked runs. A word is marked as the node's index matches it (search.rs `hits`): a token that
// begins with one of the query's words - "jum" marks "jumped" whole.

const TOKEN = /[\p{L}\p{N}]+/gu;

/// Marquee's words without its markup, on one line: a picture goes, a link keeps its words, a
/// span's tags and a directive's lines go, and so do the marks that begin a heading, a quote or a
/// list item. Rough on purpose - an excerpt is a glimpse, not a rendering.
export function plainOf(source) {
    return (source || '')
        .split('\n')
        .filter((line) => !/^\s*(:::|```)/.test(line))
        .map((line) => line.replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, ''))
        .join(' ')
        .replace(/!\[[^\]\n]*\]\([^)\s]*\)/g, ' ')
        .replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
        .replace(/\[\/?[a-z][\w-]*(?:[= ][^\]\n]*)?\]/gi, '')
        .replace(/\*\*|__|~~|`/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/// Where the words hit in `text`: each token beginning with one of them, as [from, to).
export function hitsIn(text, words) {
    const out = [];
    if (!text || !words.length) return out;
    for (const m of text.matchAll(TOKEN)) {
        const token = m[0].toLowerCase();
        if (words.some((w) => token.startsWith(w))) out.push([m.index, m.index + m[0].length]);
    }
    return out;
}

/// Up to `max` stretches of `text` around its hits, each reaching about `reach` characters either
/// side to the nearest space, overlapping ones joined - an ellipsis where a stretch is cut short.
export function excerptsOf(text, words, { max = 3, reach = 70 } = {}) {
    const hits = hitsIn(text, words);
    const spans = [];
    for (const [from, to] of hits) {
        let a = Math.max(0, from - reach);
        let b = Math.min(text.length, to + reach);
        if (a > 0 && text[a - 1] !== ' ') {
            const space = text.indexOf(' ', a);
            a = space >= 0 && space < from ? space + 1 : a;
        }
        if (b < text.length) {
            const space = text.lastIndexOf(' ', b);
            b = space > to ? space : b;
        }
        const last = spans[spans.length - 1];
        if (last && a <= last[1]) last[1] = Math.max(last[1], b);
        else if (spans.length < max) spans.push([a, b]);
        else break;
    }
    return spans.map(
        ([a, b]) => `${a > 0 ? '…' : ''}${text.slice(a, b)}${b < text.length ? '…' : ''}`,
    );
}

/// `text` as runs, `{ text, hit }`, the hits marked.
export function marked(text, words) {
    const out = [];
    let at = 0;
    for (const [from, to] of hitsIn(text || '', words)) {
        if (from > at) out.push({ text: text.slice(at, from), hit: false });
        out.push({ text: text.slice(from, to), hit: true });
        at = to;
    }
    if (at < (text || '').length) out.push({ text: text.slice(at), hit: false });
    return out;
}

/// Whether any of `text`'s tokens is hit - a tag the search's words name.
export function isHit(text, words) {
    return hitsIn(text || '', words).length > 0;
}
