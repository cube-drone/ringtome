// The book reader (PROJECT_PLAN's Books, slice 4): Writer in read-only mode over a book's public tree.
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
import { parseBook, neighbours, bookTags, filterBook } from '../pure/books.js';
import { MarqueeBody, bareSource } from './marqueebody.js';
import { useTurbolinks } from './turbolinks.js';
import { groupPostHref, pathHref, postHref, siteSeg, useSlugOf } from '../links.js';
import { useArrowNav } from './docapp.js';
import { EpubButton } from './epubbutton.js';

const html = htm.bind(h);

/// A page's link: its web address when the book says one (plans/WEB_ADDRESSES.md) - what a hover, a
/// middle-click or a copy gets - while a plain click turns the page in place, by its id.
/// A book in a group (plans/GROUPS.md, books in groups) turns its pages under the group's post.
const bookHref = (root, book, page, group) =>
    group
        ? page
            ? `${groupPostHref(group, book)}/page/${page}`
            : groupPostHref(group, book)
        : postHref(root, book, page);
const pageLink = (root, book, p, slug, group) =>
    !group && p.path ? pathHref(root, p.path, slug) : bookHref(root, book, p.post, group);
const turnTo = (loc, root, book, p, group) => (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        return;
    e.preventDefault();
    loc.route(bookHref(root, book, p.post, group));
};

const Tree = ({
    section,
    root,
    book,
    page,
    depth,
    loc,
    slug,
    group,
}) => html`<ul class=${depth === 0 ? 'book-reader-list book-reader-list-top' : 'book-reader-list'}>
    ${section.pages.map(
        (
            p,
        ) => html`<li class=${p.post === page ? 'book-reader-page book-reader-page-current' : 'book-reader-page'} key=${p.post}>
            <a href=${pageLink(root, book, p, slug, group)} onClick=${turnTo(loc, root, book, p, group)}>${p.title || t('doc.bookreader.untitled-page', 'untitled page')}</a>
        </li>`,
    )}
    ${section.sections.map(
        (s, i) => html`<li class="book-reader-section" key=${`${depth}-${i}`}>
            <span class="book-reader-section-title"><${Icons.section} /> ${s.title || t('doc.bookreader.untitled-section', '(untitled section)')}</span>
            <${Tree} section=${s} root=${root} book=${book} page=${page} depth=${depth + 1} loc=${loc} slug=${slug} group=${group} />
        </li>`,
    )}
</ul>`;

/// `group`: a book in that group, its pages and payload read through the group's own door.
export const BookReader = ({ root, book, page: asked, title, group = null }) => {
    const bodyOf = (doc) =>
        group ? `/api/groups/${group}/docs/${doc}/body` : `/id/${root}/docs/${doc}/body`;
    const loc = useLocation();
    const [payload, setPayload] = useState(undefined); // undefined loading, null unreadable
    const [words, setWords] = useState(undefined);
    // The book's tags under the table, a filter over it (Curtis, 2026-09-05): every
    // selected tag must be carried, Writer's own rule. Navigation walks the whole book.
    const [picked, setPicked] = useState(new Set());
    const toggleTag = (tag) =>
        setPicked((have) => {
            const next = new Set(have);
            if (next.has(tag)) next.delete(tag);
            else next.add(tag);
            return next;
        });
    // No page asked for opens the first page (Curtis, 2026-09-04: "just start at the first
    // page") - the tree beside it is the table of contents.
    const firstPost = payload ? (neighbours(payload, '').order[0] || {}).post || null : null;
    const page = asked || firstPost;
    useEffect(() => {
        if (!root || !book) return undefined;
        let live = true;
        apiText(bodyOf(book))
            .then((text) => live && setPayload(parseBook(text)))
            .catch(() => live && setPayload(null));
        return () => {
            live = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `bodyOf` is this root and group
    }, [root, book, group]);
    useEffect(() => {
        if (!root || !page) {
            setWords(undefined);
            return undefined;
        }
        let live = true;
        setWords(undefined);
        apiText(bodyOf(page))
            .then((text) => live && setWords(text))
            .catch(() => live && setWords(null));
        return () => {
            live = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `bodyOf` is this root and group
    }, [root, page, group]);
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
    // The arrow keys turn the pages too (Curtis, 2026-10-02), as the buttons do - and as Writer's
    // do (doc/docapp.js): only while the keyboard is free, and from the cover, right opens the
    // first page. Here, before the early returns: a hook runs on every render.
    const walk = payload
        ? page
            ? neighbours(payload, page)
            : { prev: null, next: null, order: neighbours(payload, '').order }
        : null;
    const go = (post) => loc.route(bookHref(root, book, post || null, group));
    useArrowNav(
        walk && { prev: walk.prev && walk.prev.post, next: walk.next && walk.next.post, go },
        walk ? walk.order.map((p) => p.post) : [],
        page || null,
        go,
    );
    // The open page's web address in the address bar (plans/WEB_ADDRESSES.md): the reader turns pages
    // by id, so the address it lands on is the long form - said as the page's path instead, the
    // shortest this node can vouch for, once the author's @name is known.
    const slug = useSlugOf(root);
    useEffect(() => {
        if (group || !walk || walk.index === undefined || walk.index < 0 || slug === undefined)
            return;
        const entry = walk.order[walk.index];
        if (!entry || !entry.path) return;
        // On the author's own domain (domainsite.js) the shortest is the path itself.
        const shortest = siteSeg() ? `/${entry.path}` : pathHref(root, entry.path, slug);
        const here = decodeURIComponent(window.location.pathname);
        const ours =
            here.includes(`/post/${book}`) ||
            here.includes(`/post/${entry.post}`) ||
            here.endsWith(`/${entry.path}`);
        if (here === shortest || !ours) return;
        try {
            history.replaceState(history.state, '', `${shortest}${window.location.search}`);
        } catch {
            /* an address the browser won't take: the longer one stands */
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [payload, page, slug]);
    if (payload === undefined)
        return html`<p class="postpage-loading">${t('doc.bookreader.opening-the-book', 'opening the book…')}</p>`;
    if (payload === null)
        return html`<p class="postpage-missing">${t('doc.bookreader.this-book-cannot-be-read', 'this book cannot be read here yet')}</p>`;
    const nav = page
        ? neighbours(payload, page)
        : { index: -1, prev: null, next: null, order: neighbours(payload, '').order };
    const here = nav.index >= 0 ? nav.order[nav.index] : null;
    const steps = html`<nav class="book-reader-nav">
        <button class="book-reader-step" disabled=${!nav.prev} title=${t('doc.bookreader.the-page-before', 'the page before')} onClick=${() => nav.prev && go(nav.prev.post)}>
            <${Icons.back} /> ${t('doc.bookreader.previous', 'previous')}
        </button>
        <button class="book-reader-step" disabled=${!nav.next} title=${t('doc.bookreader.the-page-after', 'the page after')} onClick=${() => nav.next && go(nav.next.post)}>
            ${t('doc.bookreader.next', 'next')} <${Icons.forward} />
        </button>
        ${here && html`<span class="book-reader-where">${nav.index + 1} / ${nav.order.length}</span>`}
    </nav>`;
    const tags = bookTags(payload);
    const shownBook = filterBook(payload, picked);
    return html`<section class="book-reader">
        <aside class="book-reader-tree">
            <p class="book-reader-book"><${Icons.book} /> ${title || payload.title || t('doc.bookreader.a-book', 'a book')}</p>
            ${/* The book as an .epub is its public form's (epub.rs): none for a group's. */ ''}
            ${
                !group &&
                html`<div class="book-reader-epub">
                    <${EpubButton} path=${`/ringtome/user/${root}/post/${book}/epub`} fallback="book.epub" className="book-reader-step" />
                </div>`
            }
            <${Tree} section=${{ pages: shownBook.pages, sections: shownBook.sections }} root=${root} book=${book} page=${page} depth=${0} loc=${loc} slug=${slug} group=${group} />
            ${
                picked.size > 0 &&
                shownBook.pages.length === 0 &&
                shownBook.sections.length === 0 &&
                html`<p class="book-reader-none">${t('doc.bookreader.no-page-carries-all-of', 'no page carries all of those tags')}</p>`
            }
            ${
                tags.length > 0 &&
                html`<div class="book-reader-tags">
                ${tags.map(
                    ({ tag, count }) => html`<button
                        key=${tag}
                        class=${picked.has(tag) ? 'book-reader-tag book-reader-tag-on' : 'book-reader-tag'}
                        title=${
                            picked.has(tag)
                                ? t(
                                      'doc.bookreader.selected---click-to-lift',
                                      'selected - click to lift it',
                                  )
                                : t(
                                      'doc.bookreader.n-pages-carry-this-tag',
                                      '{count} pages carry this tag - click to show only those',
                                      { count },
                                  )
                        }
                        onClick=${() => toggleTag(tag)}
                    >${tag} <span class="book-reader-tag-count">${count}</span></button>`,
                )}
            </div>`
            }
        </aside>
        <div class="book-reader-pane">
            ${steps}
            ${
                !page &&
                html`<p class="null-sub">${t('doc.bookreader.this-book-has-no-pages', 'this book has no pages yet')}</p>`
            }
            ${
                page &&
                html`<article class="book-reader-article" ref=${article}>
                ${here && here.trail.length > 0 && html`<p class="book-reader-trail">${here.trail.join(' › ')}</p>`}
                <h2 class="book-reader-title">${(here && here.title) || t('doc.bookreader.untitled-page', 'untitled page')}</h2>
                ${words === undefined && html`<p class="null-sub">…</p>`}
                ${words === null && html`<p class="null-sub">${t('doc.bookreader.these-words-havent-reached', "these words haven't reached this computer, or they are shared only with people the author trusts")}</p>`}
                ${!!words && html`<div class="feed-entry-body"><${MarqueeBody} source=${words} profile=${tlProfile} onUnparsable=${bareSource} /></div>`}
            </article>
            ${tall && steps}`
            }
        </div>
    </section>`;
};
