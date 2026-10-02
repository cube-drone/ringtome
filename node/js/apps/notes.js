// The documents app: the surface Writer wears, and Lost & Found with it - up to four
// columns, each tuckable. Left to right: the tag
// cloud, the document list (newest-claimed-date first, straight off the live mirror, so another
// computer's save re-sorts it within seconds and nothing fetches), the tree, and the open
// document. Which columns appear is the app registry's `features` (pure/apps.js); the document
// machinery underneath is shared (doc/), so a new app style is a registry line.
//
// Everything reusable has moved below this file: the routing/resume/nav spine is doc/docapp.js, the
// open document is doc/reader.js, the tree is doc/tree.js, the columns are panes.js. What is left
// here is this app's own arrangement of them - the filters, the list rows, the tag cloud - which is
// what let Recipes and Wikibook wear the same skeleton before they were folded back into
// Writer (2026-08-08), and what lets Lost & Found wear it now without importing a line.
import { h } from 'preact';
import { useState, useEffect, useContext, useRef } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { api } from '../net.js';
import { cachedDoc, rememberDoc } from '../mirror/doccache.js';
import { RightColumn } from '../doc/reader.js';
import { useDocApp, useDocNav } from '../doc/docapp.js';
import { useSearch, queryWords } from '../search.js';
import { hasClaimedDate, formatClaimed, DISPLAY_DATE_FIELD } from '../pure/docdate.js';
import { featuresOf, itemNoun, itemPlural, bucketHolds, FILES_BUCKET } from '../pure/apps.js';
import { browseFiles, UNFILED } from '../pure/filebrowse.js';
import { orderDocs, tagCounts } from '../pure/doclist.js';
import { WikiTree, ensureTreeRoot } from '../doc/tree.js';
import { useColWidths, useColTucks, PaneHead, Rail, TagColumn } from '../panes.js';
import { LinksColumn } from '../doc/linkcol.js';
import { BucketShelf, BucketSwitcher } from '../buckets.js';
import { startDocDrag } from '../doc/crosslink.js';
import { Icons, formatIcon } from '../icons.js';
import { DrawingThumb } from '../doc/drawing.js';
import { blankDrawing, writeBody } from '../pure/drawing.js';
import { t } from '../i18n.js';
import { holdNewDoc } from '../mirror.js';
import { docStatus, isTextDoc } from '../pure/feed.js';
import { BookColumn, useBookFacts, useBookTree } from '../doc/bookcol.js';
import { isBookBucket, hiddenDocsOf, pageStanding } from '../pure/books.js';
import { docHref } from '../links.js';
import { FacetRow, narrowTitle } from '../facets.js';
import { formatWhen } from '../pure/when.js';

const html = htm.bind(h);

const when = (ms) => formatWhen(ms);

/// Left/right ARROW KEYS walk the prev/next order - but only while the keyboard is FREE: no
/// input, textarea, select, or editor focused, no modifier held. While typing, arrows move the
/// caret, never the page. With no document selected, right opens the order's first document and
/// left its last - the book falls open at either cover. Exported: other surfaces walk the same way.
export function useArrowNav(nav, order, selected, select) {
    useEffect(() => {
        const onKey = (e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
            const t = e.target;
            const tag = t && t.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (t && t.closest && t.closest('.cm-editor, [contenteditable="true"]')) return;
            if (selected) {
                if (!nav) return;
                const to = e.key === 'ArrowLeft' ? nav.prev : nav.next;
                if (to) {
                    e.preventDefault();
                    nav.go(to);
                }
            } else if (order && order.length) {
                e.preventDefault();
                select(e.key === 'ArrowRight' ? order[0] : order[order.length - 1]);
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [nav, order, selected, select]);
}


// --- search snippets: the first few body lines that contain the query, with hits highlighted.
// The mirror only holds a token bag (no line structure), so the body is fetched per result and
// cached - once per doc, not per keystroke, so matching stays local and instant.
const snippetBodyCache = new Map(); // doc_id -> body text (string)

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The first `max` non-blank body lines that contain any query word (case-insensitive substring).
function snippetLines(body, words, max = 3) {
    if (!body || !words.length) return [];
    const out = [];
    for (const raw of body.split('\n')) {
        const line = raw.trim();
        if (line && words.some((w) => line.toLowerCase().includes(w))) {
            out.push(line);
            if (out.length >= max) break;
        }
    }
    return out;
}

// Split a line around the query words, wrapping each hit in <mark>.
function highlight(line, words) {
    if (!words.length) return line;
    const re = new RegExp('(' + words.map(escapeRegex).join('|') + ')', 'gi');
    return line
        .split(re)
        .map((part, i) => (i % 2 === 1 ? html`<mark class="snippet-hit" key=${i}>${part}</mark>` : part));
}

// A row reads its note only once it is on (or near) the screen, from the remembered copy when the
// mirror still vouches for one, and a row that leaves before the read lands calls it off. Every
// result used to read at once: a search over a 1500-note persona sent 128 note reads in one
// breath, each queued on the persona's one database connection, and the whole persona - every
// page, every poll - waited ten seconds behind them (2026-10-02).
const Snippet = ({ root, docId, query }) => {
    const [body, setBody] = useState(() =>
        snippetBodyCache.has(docId) ? snippetBodyCache.get(docId) : null
    );
    const [seen, setSeen] = useState(false);
    const spot = useRef(null);
    useEffect(() => {
        if (seen || body != null) return undefined;
        const el = spot.current;
        if (!el || typeof IntersectionObserver === 'undefined') {
            setSeen(true);
            return undefined;
        }
        const watch = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting)) {
                    setSeen(true);
                    watch.disconnect();
                }
            },
            { rootMargin: '200px' }
        );
        watch.observe(el);
        return () => watch.disconnect();
    }, [seen, body]);
    useEffect(() => {
        if (snippetBodyCache.has(docId)) {
            setBody(snippetBodyCache.get(docId));
            return undefined;
        }
        if (!seen) return undefined;
        let alive = true;
        const stop = new AbortController();
        const keep = (b) => {
            snippetBodyCache.set(docId, b);
            if (alive) setBody(b);
        };
        cachedDoc(root, docId)
            .then((hit) => {
                if (!alive) return undefined;
                if (hit) return keep(typeof hit.body === 'string' ? hit.body : '');
                return api(`/api/identity/${root}/docs/${docId}`, { signal: stop.signal }).then((d) => {
                    rememberDoc(root, docId, d);
                    keep(d && typeof d.body === 'string' ? d.body : '');
                });
            })
            .catch(() => alive && setBody(''));
        return () => {
            alive = false;
            stop.abort();
        };
    }, [root, docId, seen]);

    if (body == null) return html`<span ref=${spot} class="note-row-snippet-wait"></span>`; // not read yet
    const words = queryWords(query);
    const lines = snippetLines(body, words, 3);
    if (!lines.length) return null;
    return html`<small class="note-row-snippet">
        ${lines.map(
            (line, i) => html`<span class="snippet-line" key=${i}>${highlight(line, words)}</span>`
        )}
    </small>`;
};


// The three status icons (PUBLISH.md ruling 6), on every row.
const StatusMark = ({ doc, book }) => {
    // Inside a book, a page's standing against the last rollout replaces its own publish
    // status (PROJECT_PLAN's Books, ruling 6): hidden, new, changed, current. A picture filed in the
    // notebook is not a page; it wears nothing here.
    if (book && !isTextDoc(doc)) return null;
    if (book) {
        const standing = pageStanding(doc, book.hiddenDocs, book.hidden);
        const icon =
            standing === 'hidden' ? Icons.hidden : standing === 'new' ? Icons.pageNew : standing === 'changed' ? Icons.update : Icons.docPublic;
        const title =
            standing === 'hidden'
                ? t('apps.notes.hidden-from-the-book', 'hidden from the book')
                : standing === 'new'
                  ? t('apps.notes.new-since-the-last-rollout', 'new since the last rollout')
                  : standing === 'changed'
                    ? t('apps.notes.changed-since-the-last-rollout', 'changed since the last rollout')
                    : t('apps.notes.in-the-book-as-published', 'in the book as published');
        const cls =
            standing === 'hidden'
                ? 'note-row-status note-row-status-hidden'
                : standing === 'current'
                  ? 'note-row-status note-row-status-public'
                  : 'note-row-status note-row-status-pending';
        return html`<span class=${cls} title=${title}><${icon} /></span> `;
    }
    const status = docStatus(doc);
    const icon =
        status === 'scheduled' ? Icons.scheduled : status === 'public' ? Icons.docPublic : Icons.docPrivate;
    const title =
        status === 'scheduled'
            ? t('apps.notes.scheduled-to-publish', 'scheduled to publish')
            : status === 'public'
              ? t('apps.notes.published', 'published')
              : t('apps.notes.private', 'private');
    // Spelled out, so the dead-CSS convention can see each class.
    const cls =
        status === 'scheduled'
            ? 'note-row-status note-row-status-scheduled'
            : status === 'public'
              ? 'note-row-status note-row-status-public'
              : 'note-row-status note-row-status-private';
    return html`<span class=${cls} title=${title}><${icon} /></span> `;
};

// One row in the list: title, and whatever this app has asked to show beneath it. Everything
// conditional here is a `features` flag or a piece of the document's own filing - a row with no
// description, no date and no tags is one line tall.
const NoteRow = ({ doc, root, bucket, selected, feat, searchQuery, hits, tagFilter, onSelect,
                   onToggleTag, book }) => html`<button
    class=${doc.doc_id === selected ? 'note-row jag-line selected' : 'note-row jag-line'}
    data-settles
    onClick=${() => onSelect(doc.doc_id)}
    draggable=${true}
    onDragStart=${(e) => startDocDrag(e, root, doc, bucket)}
>
    <span class="note-row-title">
        ${/* The document's standing in public (PUBLISH.md ruling 6): detective for private,
            globe for public, clock for scheduled - each in its own colour. */ ''}
        <${StatusMark} doc=${doc} book=${book} />
        ${doc.pinned && html`<span class="note-row-pin" title=${t('apps.notes.pinned', 'pinned')}><${Icons.pin} /></span> `}
        ${doc.format === 'drawing'
            ? html`<${DrawingThumb} root=${root} doc=${doc} />`
            : doc.media && doc.media.has_thumb
            ? html`<img
                  class="note-row-thumb"
                  src="/api/identity/${root}/docs/${doc.doc_id}/thumb?v=${doc.head}"
                  alt=""
                  loading="lazy"
                  onError=${(e) => {
                      // has_thumb but the blob hasn't reached this node yet (404): hide
                      // rather than show the browser's broken-image glyph; the next mirror
                      // refresh re-renders and retries.
                      e.currentTarget.style.display = 'none';
                  }}
              /> `
            : formatIcon(doc.format) &&
              html`<span class="note-row-kind"><${formatIcon(doc.format)} /></span> `}
        <span class="note-row-title-text">${doc.title || t('apps.notes.untitled', 'untitled')}</span>
    </span>
    ${feat.description &&
    doc.fields &&
    doc.fields.description &&
    html`<small class="note-row-desc">${doc.fields.description}</small>`}
    ${hits !== null && html`<${Snippet} root=${root} docId=${doc.doc_id} query=${searchQuery} />`}
    ${(feat.date || doc.diverged) &&
    html`<span class="note-row-when">
        ${feat.date &&
        (hasClaimedDate(doc)
            ? html`<span
                  class="note-row-claimed"
                  title=${t('apps.notes.a-date-you-set-for', 'a date you set for this document (its real last edit was {p0})', { p0: when(doc.updated_ms) })}
              >${formatClaimed(doc.fields[DISPLAY_DATE_FIELD])}</span>`
            : when(doc.updated_ms))}${doc.diverged
            ? (feat.date ? ' · ' : '') + t('apps.notes.two-versions', 'two versions')
            : ''}
    </span>`}
    ${(doc.tags || []).length > 0 &&
    html`<span class="note-row-tags">
        ${doc.tags.map(
            (t) => html`<span
                class=${tagFilter.includes(t) ? 'note-row-tag jag-line active' : 'note-row-tag jag-line'}
                key=${t}
                role="button"
                data-stays
                onClick=${(e) => {
                    e.stopPropagation();
                    onToggleTag(t);
                }}
            >${t}</span>`
        )}
    </span>`}
</button>`;

// hrseFiles™ laid out as the picture picker is (Curtis, 2026-09-29): the notebooks, then the tags,
// then every file as a square tile - a picture or a drawing as itself, words as their icon and
// title. The same chips as the picker, so the two read as one design.
const FileTile = ({ doc, root, bucket, selected, onSelect, onFollowHome }) => {
    const picture = doc.format === 'drawing' || (doc.media && doc.media.has_thumb);
    const Kind = formatIcon(doc.format) || Icons.page;
    return html`<li class="files-tile-slot">
        <button
            class=${doc.doc_id === selected ? 'files-tile selected' : 'files-tile'}
            title=${doc.title || ''}
            data-settles
            onClick=${() => onSelect(doc.doc_id)}
            draggable=${true}
            onDragStart=${(e) => startDocDrag(e, root, doc, bucket)}
        >
            <span class=${picture ? 'files-tile-face drawing-floor' : 'files-tile-face'}>
                ${doc.format === 'drawing'
                    ? html`<${DrawingThumb} root=${root} doc=${doc} big=${true} />`
                    : picture
                      ? html`<img
                            src="/api/identity/${root}/docs/${doc.doc_id}/thumb?v=${doc.head}"
                            alt=""
                            loading="lazy"
                            onError=${(e) => {
                                // has_thumb, but the blob is not on this node yet
                                e.currentTarget.style.display = 'none';
                            }}
                        />`
                      : html`<span class="files-tile-kind"><${Kind} /></span>`}
                ${doc.pinned && html`<span class="files-tile-pin" title=${t('apps.notes.pinned', 'pinned')}><${Icons.pin} /></span>`}
            </span>
            <span class="files-tile-title">
                <${StatusMark} doc=${doc} />
                <span class="files-tile-title-text">${doc.title || t('apps.notes.untitled', 'untitled')}</span>
            </span>
        </button>
        <button
            class="files-tile-home"
            data-settles
            title=${t('apps.notes.follow-me-home-open-this', 'follow me home — open this in its own app')}
            onClick=${() => onFollowHome(doc)}
        ><${Icons.path} /></button>
    </li>`;
};

const FileBrowser = ({ root, bucket, browse, notebook, onNotebook, tags, onToggleTag, selected, onSelect, onFollowHome, empty }) => html`<div
    class="files-browser"
>
    <div class="imagepick-buckets" role="group" aria-label=${t('doc.imagepick.notebook', 'notebook')}>
        <button class=${notebook ? 'imagepick-bucket' : 'imagepick-bucket active'} onClick=${() => onNotebook('')}>
            <${Icons.notebook} /> ${t('doc.imagepick.every-notebook', 'every notebook')}
        </button>
        ${browse.notebooks.map(
            (b) => html`<button
                key=${b}
                class=${notebook === b ? 'imagepick-bucket active' : 'imagepick-bucket'}
                onClick=${() => onNotebook(notebook === b ? '' : b)}
            ><${b === FILES_BUCKET ? Icons.filesBucket : Icons.notebook} /> ${b}</button>`
        )}
        ${browse.unfiled &&
        html`<button
            class=${notebook === UNFILED ? 'imagepick-bucket active' : 'imagepick-bucket'}
            onClick=${() => onNotebook(notebook === UNFILED ? '' : UNFILED)}
        ><${Icons.lostFound} /> ${t('apps.notes.unfiled', 'unfiled')}</button>`}
    </div>
    ${/* The feed's facet row (Curtis, 2026-10-02: every tag at once took the whole browser once an
        import brought some 250): one line of the commonest, then "more" - in place for a few
        lines' worth, a search box past that. These tags only narrow, so a chip is on or off. */ ''}
    ${browse.cloud.length > 0 &&
    html`<${FacetRow}
        label=${t('apps.notes.tagged', 'tagged')}
        items=${browse.cloud.map(([value, count]) => ({ value, count }))}
        picked=${tags}
        out=${[]}
        onToggle=${onToggleTag}
        titleOf=${narrowTitle}
    />`}
    ${browse.files.length > 0
        ? html`<ul class="files-grid">
              ${browse.files.map(
                  (d) => html`<${FileTile}
                      key=${d.doc_id}
                      doc=${d}
                      root=${root}
                      bucket=${bucket}
                      selected=${selected}
                      onSelect=${onSelect}
                      onFollowHome=${onFollowHome}
                  />`
              )}
          </ul>`
        : html`<p class="null-sub notes-empty">${empty}</p>`}
</div>`;

// The documents app - the shared surface a "documents" application (Writer, Lost & Found)
// currently renders. `app` is its registry entry (id, name, icon, style); the document
// machinery is the same, so a new app style is a registry line plus, later, its own layout.
// `searchQuery`, not `query` - preact-iso's Router injects its OWN `query` prop (parsed URL search
// params, an object), which would shadow a prop of that name and break the string search.
export const DocsApp = ({ app, current, docId, searchQuery, searchKind, bucket }) => {
    const root = current.root;
    const feat = featuresOf(app);
    const noun = itemNoun(app); // what this app calls one of its things, and many of them
    const nouns = itemPlural(app);
    const [busy, setBusy] = useState(false);
    const [tagFilter, setTagFilter] = useState([]); // active tag filters, stacked (AND)
    const [notebook, setNotebook] = useState(''); // hrseFiles's notebook pick: '' is every one

    // The shared documents-app spine (doc/docapp.js): the live documents, the open document and how
    // to change it (it lives in the URL, so back/forward and deep links just work), the resume-where
    // -you-left-off jump, and the tree-reload bump a delete needs.
    const { docs, selected, select, forget, treeReload, bumpTree } = useDocApp(root, app, docId, bucket);
    // The notebook switcher heads the list column (2026-09-30; it was in the app header). A switcher
    // over one notebook offers a choice that isn't one.
    const shelf = useContext(BucketShelf);
    const switcher =
        shelf && app.style && !app.soleBucket
            ? html`<${BucketSwitcher} root=${root} app=${app} roster=${shelf.roster} bucket=${bucket} onSwitch=${shelf.onSwitch} />`
            : null;


    // The list: this app's scope, then the search hits, then every active tag, newest-claimed-date
    // first with pinned documents floating (pure/doclist.js holds the rules and their vectors).
    const hits = useSearch(root, searchQuery);
    // hrseFiles browses as the picture picker does (2026-09-29): its notebook pick and tags narrow
    // after the search, and the tiles are the list prev/next walks.
    const ordered = orderDocs(docs, { app, bucket, hits, tags: app.everything ? [] : tagFilter, kind: searchKind });
    const browse = app.everything ? browseFiles(ordered, { notebook, tags: tagFilter }) : null;
    const list = browse ? browse.files : ordered;

    // Lost & Found's follow-me-home: the document's own address, which opens it in its first
    // notebook's app (pure/naming.js `docPlacement`; the unbucketed stay here).
    const loc = useLocation();
    const followHome = (d) => loc.route(docHref(root, d.doc_id));

    const toggleTag = (tag) =>
        setTagFilter((f) => (f.includes(tag) ? f.filter((t) => t !== tag) : [...f, tag]));

    // Counted over the SEARCH results (query + kind dial) rather than the tag-filtered list, so
    // the cloud narrows with a search but still shows every tag you could add.
    const tagCloud = feat.tagColumn
        ? tagCounts(orderDocs(docs, { app, bucket, hits, kind: searchKind }))
        : [];

    // Which columns are tucked away to a rail - column chrome, so panes.js owns it alongside the
    // widths. `startsTucked` is the app's own opening posture (Writer begins as a plain list,
    // its tag column and tree waiting as rails); a stored preference always wins over it.
    // In a narrow window (panes.js) the list is the tab it opens on while no note is chosen, and
    // choosing one closes the tab to show it.
    const { tucked, toggleTuck, settle, tab } = useColTucks(root, app.id, app.startsTucked, { lead: selected ? null : 'list' });
    useEffect(() => {
        if (selected) settle();
    }, [selected, settle]);
    const tagsTucked = tucked.has('tags');
    const treeTucked = tucked.has('tree');
    const publishTucked = tucked.has('publish');
    const linksTucked = tucked.has('links');

    // The tree's depth-first doc order (the "book order"), reported by the tree pane.
    const [treeOrder, setTreeOrder] = useState(null);

    // Column widths: each column left of the editor drags at its right edge (panes.js - the
    // shared resizer strips + `colw:` prefs + CSS-var plumbing).
    // The leftmost column has no ceiling in hrseFiles (Curtis, 2026-09-29): a grid of tiles earns
    // whatever room it is given.
    const { resizer, colStyle } = useColWidths(root, app.id, ['tags', 'list', 'tree', 'publish', 'links'], {}, app.everything ? ['list'] : []);
    // A notebook published as a book (PROJECT_PLAN's Books): the switch and the hidden marks, and the
    // tree that says which pages sit beneath a hidden section - read once here, worn by
    // the rows, the editor's bar, and the Publish column alike.
    const bookFacts = useBookFacts(root);
    const bookTree = useBookTree(root, bucket, treeReload);
    const bookOn = feat.bookColumn && isBookBucket(bookFacts.modes, bucket);
    const book = bookOn
        ? {
              bucket,
              hidden: bookFacts.hidden,
              hiddenDocs: hiddenDocsOf(bookTree, bookFacts.hidden),
              mark: bookFacts.mark,
          }
        : null;

    // Which order prev/next walks depends on what's showing: with the tree column open they read
    // it as a book (depth-first, and the tree wins when both columns are open); with it tucked or
    // absent they walk the list's time order, where NEXT goes back in time (the list reads
    // newest-first, so next is simply "down the list" - a tucked tree always walks this way). A document
    // missing from the tree (unfiled) falls back to the list rather than stranding the arrows.
    const listOrder = list.map((d) => d.doc_id);
    const treeShowing = feat.tree && !tucked.has('tree');
    const bookish = treeShowing && treeOrder && selected && treeOrder.includes(selected);
    const nav = useDocNav(bookish ? treeOrder : listOrder, selected, select, {
        prev: bookish ? 'Previous — back up the tree' : 'Previous — newer',
        next: bookish ? 'Next — down the tree' : 'Next — older',
    });

    const createNew = async () => {
        setBusy(true);
        try {
            // New items are Marquee by default - the interactive editor is the front door;
            // the format chip converts to plaintext for anyone who wants a plain page. An app
            // with its own format says so (`newFormat`): the Drawing app makes a blank drawing.
            const format = app.newFormat || 'marquee';
            const made = await api(`/api/identity/${root}/docs`, {
                method: 'POST',
                body: JSON.stringify({ title: 'untitled', body: format === 'drawing' ? writeBody(blankDrawing()) : '', format }),
            });
            // Open it now (2026-10-01: "that isn't here" until the stream brought the row): the
            // row is stated ahead of the stream, filed where it's going, and the filing follows.
            await holdNewDoc(root, made, { title: 'untitled', format, bucket });
            select(made.doc_id);
            // File it into the CURRENT bucket - the notebook you're looking at is the notebook
            // a new page lands in.
            await api(
                `/api/identity/${root}/docs/${made.doc_id}/buckets/${encodeURIComponent(bucket)}`,
                { method: 'PUT' }
            );
            // When the tree column exists, a new document also takes its place in the tree - the
            // last child of the root (append), where it's visible and draggable into shape,
            // rather than invisibly unfiled.
            if (feat.tree) {
                const rootTax = await ensureTreeRoot(root, bucket);
                await api(`/api/identity/${root}/taxonomies/${rootTax}/members/${made.doc_id}`, {
                    method: 'PUT',
                    body: JSON.stringify({}),
                });
                bumpTree(); // don't wait for the roster tick
            }
        } catch (e) {
            alert(t('apps.notes.couldnt-make-a-new-one', "couldn't make a new one: {message}", { message: e.message }));
        } finally {
            setBusy(false);
        }
    };

    return html`
        <div class="notes">
            <div class="notes-columns panes" style=${colStyle}>
                ${feat.tagColumn &&
                (tagsTucked
                    ? html`<${Rail} icon=${Icons.tag} label=${t('apps.notes.tags', 'tags')} onClick=${() => toggleTuck('tags')} />`
                    : html`${tab('tags', Icons.tag, t('apps.notes.tags', 'tags'))}<${TagColumn}
                          cloud=${tagCloud}
                          active=${tagFilter}
                          onToggleTag=${toggleTag}
                          onTuck=${() => toggleTuck('tags')}
                      />${resizer('tags')}`)}
                ${tucked.has('list')
                    ? html`<${Rail} icon=${Icons.list} label=${nouns} onClick=${() => toggleTuck('list')} />`
                    : app.everything
                    ? html`${tab('list', Icons.list, nouns)}<aside class="notes-list notes-list-browser">
                    <${PaneHead} icon=${Icons.list} label=${nouns} onTuck=${() => toggleTuck('list')} />
                    ${switcher}
                    <${FileBrowser}
                        root=${root}
                        bucket=${bucket}
                        browse=${browse}
                        notebook=${notebook}
                        onNotebook=${setNotebook}
                        tags=${tagFilter}
                        onToggleTag=${toggleTag}
                        selected=${selected}
                        onSelect=${select}
                        onFollowHome=${followHome}
                        empty=${!docs ? '' : hits === null ? t('apps.notes.nothing-here-yet', 'nothing here yet.') : t('apps.notes.nothing-matches', 'nothing matches.')}
                    />
                </aside>${resizer('list')}`
                    : html`${tab('list', Icons.list, nouns)}<aside class="notes-list">
                    <${PaneHead} icon=${Icons.list} label=${nouns} onTuck=${() => toggleTuck('list')} />
                    ${switcher}
                    ${/* The everything-view is for finding, not making - new things are born
                        in their own apps, where they land in a real notebook. */ ''}
                    ${!app.everything &&
                    html`<button class="notes-new" data-settles disabled=${busy} onClick=${createNew}>
                        ${busy ? '…' : `+ new ${noun}`}
                    </button>`}
                    ${tagFilter.length > 0 &&
                    html`<div class="notes-tagfilter">
                        ${/* `tag`, never `t`: a parameter named `t` shadows the i18n t(), and the
                            title below then called a TAG STRING as a function - the first chip
                            threw, the render died, and every tag click looked like nothing
                            (2026-10-02; doc/annotations.js carries the same scar from 2026-08-29). */ ''}
                        ${tagFilter.map(
                            (tag) => html`<button
                                class="annot-tag annot-tag-active jag-line"
                                key=${tag}
                                title=${t('apps.notes.remove-filter', 'remove filter')}
                                onClick=${() => toggleTag(tag)}
                            >${tag} ×</button>`
                        )}
                    </div>`}
                    ${list.map(
                        (d) => html`<${NoteRow}
                                  book=${book}
                            key=${d.doc_id}
                            doc=${d}
                            root=${root}
                            bucket=${bucket}
                            selected=${selected}
                            feat=${feat}
                            searchQuery=${searchQuery}
                            hits=${hits}
                            tagFilter=${tagFilter}
                            onSelect=${select}
                            onToggleTag=${toggleTag}
                        />`
                    )}
                    ${docs && list.length === 0 &&
                    html`<p class="null-sub notes-empty">
                        ${hits === null ? t('apps.notes.nothing-here-yet', 'nothing here yet.') : t('apps.notes.nothing-matches', 'nothing matches.')}
                    </p>`}
                </aside>${resizer('list')}`}
                ${feat.tree &&
                (treeTucked
                    ? html`<${Rail} icon=${Icons.tree} label=${t('apps.notes.tree', 'tree')} onClick=${() => toggleTuck('tree')} />`
                    : html`${tab('tree', Icons.tree, t('apps.notes.tree', 'tree'))}${/* The unfiled bin shows (Curtis,
                          2026-09-30: a note copied in "doesn't join that bucket's taxonomy… it's forever
                          lost"): the list lists every note but can't file one, so a note that reached
                          the notebook any way but "+ new" - a copy, a move, the tree minted after
                          the notes - waits in the bin, and drags from there into place. The bin
                          shows only while something's in it. */ ''}<${WikiTree}
                          root=${root}
                          bucket=${bucket}
                          selected=${selected}
                          onSelect=${select}
                          searchQuery=${searchQuery}
                          searchKind=${searchKind}
                          reloadKey=${treeReload}
                          showUnfiled=${true}
                          book=${book}
                          onMinimize=${() => toggleTuck('tree')}
                          onOrder=${setTreeOrder}
                          itemNoun=${noun}
                      />${resizer('tree')}`)}
                ${feat.bookColumn &&
                (publishTucked
                    ? html`<${Rail} icon=${Icons.book} label=${t('apps.notes.publish', 'publish')} onClick=${() => toggleTuck('publish')} />`
                    : html`${tab('publish', Icons.book, t('apps.notes.publish', 'publish'))}<${BookColumn}
                          root=${root}
                          bucket=${bucket}
                          docs=${(docs || []).filter((d) => bucketHolds(d, app, bucket))}
                          facts=${bookFacts}
                          tree=${bookTree}
                          onTuck=${() => toggleTuck('publish')}
                          onSelect=${select}
                      />${resizer('publish')}`)}
                ${/* What links to the open note, and what it links to (2026-09-30). */ ''}
                ${feat.linkColumn &&
                (linksTucked
                    ? html`<${Rail} icon=${Icons.link} label=${t('apps.notes.links', 'links')} onClick=${() => toggleTuck('links')} />`
                    : html`${tab('links', Icons.link, t('apps.notes.links', 'links'))}<${LinksColumn} root=${root} docId=${selected} docs=${docs} onTuck=${() => toggleTuck('links')} />${resizer('links')}`)}
                <${RightColumn}
                    root=${root}
                    docId=${selected}
                    dropper=${!!app.everything}
                    docs=${docs}
                    nav=${nav}
                    bucket=${bucket}
                    book=${book}
                    features=${feat}
                    onDeleted=${() => {
                        forget(selected);
                        select(null);
                        bumpTree();
                    }}
                />
            </div>
        </div>
    `;
};
