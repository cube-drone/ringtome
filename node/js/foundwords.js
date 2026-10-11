// What a search found, on a card (Curtis, 2026-10-10): its words marked where the search's words
// hit them, and the stretches of the post around those hits - a found book's from its pages, each
// naming its page. The rules are pure/found.js's; this draws them.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { postHref } from './links.js';
import { t } from './i18n.js';
import { excerptsOf, marked, plainOf } from './pure/found.js';

const html = htm.bind(h);

/// `text`, the words it was found by marked.
export const Marked = ({ text, words }) =>
    marked(text, words).map((run, i) =>
        run.hit ? html`<mark class="found-hit" key=${i}>${run.text}</mark>` : run.text,
    );

/// The excerpts a found post shows above its words: from its own words, or - a book - from the
/// pages the node says the search's words are on (its book door: idface.rs `id_book_excerpts`).
export const FoundExcerpts = ({ item, body, words, query }) => {
    const book = item.format === 'book';
    const [pages, setPages] = useState(null);
    useEffect(() => {
        if (!book || !words.length) return undefined;
        let live = true;
        api(`/api/id/${item.author}/posts/${item.doc_id}/excerpts?q=${encodeURIComponent(query)}`)
            .then((r) => live && setPages(r))
            .catch(() => live && setPages(null));
        return () => {
            live = false;
        };
    }, [book, item.author, item.doc_id, query, words.length]);
    if (!words.length) return null;
    if (!book) {
        const lines = excerptsOf(plainOf(body), words);
        if (!lines.length) return null;
        return html`<div class="found">
            ${lines.map((line, i) => html`<p class="found-line" key=${i}><${Marked} text=${line} words=${words} /></p>`)}
        </div>`;
    }
    if (!pages || !(pages.pages || []).length) return null;
    const more = (pages.found || 0) - pages.pages.length;
    return html`<div class="found">
        ${pages.pages.map(
            (p) => html`<div class="found-page" key=${p.post}>
                <a class="found-page-title" href=${postHref(item.author, item.doc_id, p.post)}
                    ><${Marked} text=${p.title} words=${words}
                /></a>
                ${excerptsOf(plainOf(p.body), words, { max: 2 }).map(
                    (line, i) =>
                        html`<p class="found-line" key=${i}><${Marked} text=${line} words=${words} /></p>`,
                )}
            </div>`,
        )}
        ${
            more > 0 &&
            html`<p class="found-more">
                ${more === 1 ? t('found.one-more-page', 'and 1 more page') : t('found.more-pages', 'and {n} more pages', { n: more })}
            </p>`
        }
    </div>`;
};
