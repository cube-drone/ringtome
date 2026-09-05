// The book reader (BOOKS.md slice 4): Writer in read-only mode over a book's public tree.
// The tree on the left, the reading pane on the right, prev / up / next along the top -
// over public documents, at the book's permalink. A page's own permalink lands here too,
// with that page open, because a page is a place in a book before it is a post.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { apiText } from '../net.js';
import { Icons } from '../icons.js';
import { t } from '../i18n.js';
import { parseBook, neighbours } from '../pure/books.js';
import { MarqueeBody, bareSource } from './marqueebody.js';
import { useTurbolinks } from './turbolinks.js';

const html = htm.bind(h);

/// In-place navigation for the reader's own links (Curtis, 2026-09-04: links reloaded the
/// page while the buttons did not): the shell's LocationProvider intercepts only `/home`
/// anchors, by design, so `/id/…` anchors route here by hand. A modifier-click or a
/// middle-click keeps the browser's own behaviour.
const soft = (loc) => (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    loc.route(e.currentTarget.getAttribute('href'));
};

const Tree = ({ section, root, book, page, depth, loc }) => html`<ul class=${depth === 0 ? 'book-reader-list book-reader-list-top' : 'book-reader-list'}>
    ${section.pages.map(
        (p) => html`<li class=${p.post === page ? 'book-reader-page book-reader-page-current' : 'book-reader-page'} key=${p.post}>
            <a href=${`/id/${root}/post/${book}/${p.post}`} onClick=${soft(loc)}>${p.title || t('doc.bookreader.untitled-page', 'untitled page')}</a>
        </li>`
    )}
    ${section.sections.map(
        (s, i) => html`<li class="book-reader-section" key=${`${depth}-${i}`}>
            <span class="book-reader-section-title"><${Icons.section} /> ${s.title || t('doc.bookreader.untitled-section', '(untitled section)')}</span>
            <${Tree} section=${s} root=${root} book=${book} page=${page} depth=${depth + 1} loc=${loc} />
        </li>`
    )}
</ul>`;

export const BookReader = ({ root, book, page: asked, title }) => {
    const loc = useLocation();
    const [payload, setPayload] = useState(undefined); // undefined loading, null unreadable
    const [words, setWords] = useState(undefined);
    // No page asked for opens the first page (Curtis, 2026-09-04: "just start at the first
    // page") - the tree beside it is the table of contents.
    const firstPost = payload ? (neighbours(payload, '').order[0] || {}).post || null : null;
    const page = asked || firstPost;
    useEffect(() => {
        if (!root || !book) return undefined;
        let live = true;
        apiText(`/id/${root}/docs/${book}/body`)
            .then((text) => live && setPayload(parseBook(text)))
            .catch(() => live && setPayload(null));
        return () => {
            live = false;
        };
    }, [root, book]);
    useEffect(() => {
        if (!root || !page) {
            setWords(undefined);
            return undefined;
        }
        let live = true;
        setWords(undefined);
        apiText(`/id/${root}/docs/${page}/body`)
            .then((text) => live && setWords(text))
            .catch(() => live && setWords(null));
        return () => {
            live = false;
        };
    }, [root, page]);
    const tlProfile = useTurbolinks(words || '', 'marquee');
    // A tall page gets the buttons again at its foot (Curtis, 2026-09-04): measured, not
    // guessed, so a short page keeps one row and a long one is not a scroll back up.
    const TALL = 800;
    const article = useRef(null);
    const [tall, setTall] = useState(false);
    useEffect(() => {
        const el = article.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const judge = () => setTall(el.offsetHeight > TALL);
        judge();
        const ro = new ResizeObserver(judge);
        ro.observe(el);
        return () => ro.disconnect();
    }, [page, words]);
    if (payload === undefined) return html`<p class="postpage-loading">${t('doc.bookreader.opening-the-book', 'opening the book…')}</p>`;
    if (payload === null) return html`<p class="postpage-missing">${t('doc.bookreader.this-book-cannot-be-read', 'this book cannot be read here yet')}</p>`;
    const nav = page ? neighbours(payload, page) : { index: -1, prev: null, next: null, order: neighbours(payload, '').order };
    const here = nav.index >= 0 ? nav.order[nav.index] : null;
    const go = (post) => loc.route(post ? `/id/${root}/post/${book}/${post}` : `/id/${root}/post/${book}`);
    const steps = html`<nav class="book-reader-nav">
        <button class="book-reader-step" disabled=${!nav.prev} title=${t('doc.bookreader.the-page-before', 'the page before')} onClick=${() => nav.prev && go(nav.prev.post)}>
            <${Icons.back} /> ${t('doc.bookreader.previous', 'previous')}
        </button>
        <button class="book-reader-step" disabled=${!nav.next} title=${t('doc.bookreader.the-page-after', 'the page after')} onClick=${() => nav.next && go(nav.next.post)}>
            ${t('doc.bookreader.next', 'next')} <${Icons.forward} />
        </button>
        ${here && html`<span class="book-reader-where">${nav.index + 1} / ${nav.order.length}</span>`}
    </nav>`;
    return html`<section class="book-reader">
        <aside class="book-reader-tree">
            <p class="book-reader-book"><${Icons.book} /> ${title || payload.title || t('doc.bookreader.a-book', 'a book')}</p>
            <${Tree} section=${{ pages: payload.pages, sections: payload.sections }} root=${root} book=${book} page=${page} depth=${0} loc=${loc} />
        </aside>
        <div class="book-reader-pane">
            ${steps}
            ${!page &&
            html`<p class="null-sub">${t('doc.bookreader.this-book-has-no-pages', 'this book has no pages yet')}</p>`}
            ${page &&
            html`<article class="book-reader-article" ref=${article}>
                ${here && here.trail.length > 0 && html`<p class="book-reader-trail">${here.trail.join(' › ')}</p>`}
                <h2 class="book-reader-title">${(here && here.title) || t('doc.bookreader.untitled-page', 'untitled page')}</h2>
                ${words === undefined && html`<p class="null-sub">…</p>`}
                ${words === null && html`<p class="null-sub">${t('doc.bookreader.these-words-havent-reached', "these words haven't reached this computer, or they are shared only with people the author trusts")}</p>`}
                ${!!words && html`<div class="feed-entry-body"><${MarqueeBody} source=${words} profile=${tlProfile} onUnparsable=${bareSource} /></div>`}
            </article>
            ${tall && steps}`}
        </div>
    </section>`;
};
