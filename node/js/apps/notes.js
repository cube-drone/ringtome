// The documents app: the surface every "documents" application wears (TurboNotes, Recipes), and
// the everything-app at full stretch - up to four columns, each tuckable. Left to right: the tag
// cloud, the document list (newest-claimed-date first, straight off the live mirror, so another
// computer's save re-sorts it within seconds and nothing fetches), the tree, and the open
// document. Which columns appear is the app registry's `features` (pure/apps.js); the document
// machinery underneath is shared (doc/), so a new app style is a registry line.
//
// Everything reusable has moved below this file: the routing/resume/nav spine is doc/docapp.js, the
// open document is doc/reader.js, the tree is doc/tree.js, the columns are panes.js. What is left
// here is this app's own arrangement of them - the filters, the list rows, the tag cloud - which is
// why the Wikibook can wear the same skeleton without importing a line of it.
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { api } from '../net.js';
import { openMirror, useLive } from '../mirror.js';
import { RightColumn } from '../doc/reader.js';
import { useDocApp, useDocNav } from '../doc/docapp.js';
import { useSearch, queryWords } from '../search.js';
import { hasClaimedDate, formatClaimed, DISPLAY_DATE_FIELD } from '../pure/docdate.js';
import { featuresOf, itemNoun, itemPlural, homeAppFor } from '../pure/apps.js';
import { orderDocs, tagCounts } from '../pure/doclist.js';
import { WikiTree, ensureTreeRoot } from '../doc/tree.js';
import { useColWidths, useColTucks, PaneHead, Rail } from '../panes.js';
import { startDocDrag } from '../doc/crosslink.js';
import { Icons, formatIcon } from '../icons.js';
import { t } from '../i18n.js';

const html = htm.bind(h);

const when = (ms) => new Date(ms).toLocaleString();

/// Left/right ARROW KEYS walk the prev/next order - but only while the keyboard is FREE: no
/// input, textarea, select, or editor focused, no modifier held. While typing, arrows move the
/// caret, never the page. With no document selected, right opens the order's first document and
/// left its last - the book falls open at either cover. Exported: the wiki walks the same way.
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

const Snippet = ({ root, docId, query }) => {
    const [body, setBody] = useState(() =>
        snippetBodyCache.has(docId) ? snippetBodyCache.get(docId) : null
    );
    useEffect(() => {
        if (snippetBodyCache.has(docId)) {
            setBody(snippetBodyCache.get(docId));
            return;
        }
        let alive = true;
        api(`/api/identity/${root}/docs/${docId}`)
            .then((d) => {
                const b = d && typeof d.body === 'string' ? d.body : '';
                snippetBodyCache.set(docId, b);
                if (alive) setBody(b);
            })
            .catch(() => alive && setBody(''));
        return () => {
            alive = false;
        };
    }, [root, docId]);

    if (body == null) return null; // still loading
    const words = queryWords(query);
    const lines = snippetLines(body, words, 3);
    if (!lines.length) return null;
    return html`<small class="note-row-snippet">
        ${lines.map(
            (line, i) => html`<span class="snippet-line" key=${i}>${highlight(line, words)}</span>`
        )}
    </small>`;
};


// One row in the list: title, and whatever this app has asked to show beneath it. Everything
// conditional here is a `features` flag or a piece of the document's own filing - a row with no
// description, no date and no tags is one line tall, which is what Recipes wants.
const NoteRow = ({ doc, root, bucket, selected, feat, searchQuery, hits, tagFilter, onSelect,
                   onToggleTag, everything, onFollowHome }) => html`<button
    class=${doc.doc_id === selected ? 'note-row selected' : 'note-row'}
    onClick=${() => onSelect(doc.doc_id)}
    draggable=${true}
    onDragStart=${(e) => startDocDrag(e, root, doc, bucket)}
>
    <span class="note-row-title">
        ${doc.pinned && html`<span class="note-row-pin" title=${t('apps.notes.pinned', 'pinned')}><${Icons.pin} /></span> `}
        ${doc.media && doc.media.has_thumb
            ? html`<img
                  class=${everything ? 'note-row-thumb note-row-thumb-big' : 'note-row-thumb'}
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
        ${everything &&
        html`<button
            class="note-row-home"
            title=${t('apps.notes.follow-me-home-open-this', 'follow me home — open this in its own app')}
            onClick=${(e) => {
                e.stopPropagation();
                onFollowHome(doc);
            }}
        ><${Icons.path} /></button>`}
    </span>
    ${everything &&
    html`<span class="note-row-buckets">
        ${(doc.buckets || []).length ? (doc.buckets || []).join(' · ') : t('apps.notes.unfiled', 'unfiled')}
    </span>`}
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
                class=${tagFilter.includes(t) ? 'note-row-tag active' : 'note-row-tag'}
                key=${t}
                role="button"
                onClick=${(e) => {
                    e.stopPropagation();
                    onToggleTag(t);
                }}
            >${t}</span>`
        )}
    </span>`}
</button>`;

// The tag cloud: every tag in view, most-used first, clicking one into (or out of) the filter the
// list reads. An optional column - only apps whose `features.tagColumn` asks for it.
const TagColumn = ({ cloud, active, onToggleTag, onTuck }) => html`<aside class="tag-column">
    <${PaneHead} label=${t('apps.notes.tags', 'tags')} onTuck=${onTuck} />
    ${cloud.map(
        ([tag, count]) => html`<button
            key=${tag}
            class=${active.includes(tag) ? 'tag-cloud-row active' : 'tag-cloud-row'}
            onClick=${() => onToggleTag(tag)}
        >
            <span class="tag-cloud-name">${tag}</span>
            <span class="tag-cloud-count">${count}</span>
        </button>`
    )}
    ${cloud.length === 0 && html`<p class="null-sub tag-column-empty">${t('apps.notes.no-tags-yet', 'no tags yet')}</p>`}
</aside>`;

// The documents app - the shared surface every "documents" application (Notes, Recipes, ...)
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

    // The shared documents-app spine (doc/docapp.js): the live documents, the open document and how
    // to change it (it lives in the URL, so back/forward and deep links just work), the resume-where
    // -you-left-off jump, and the tree-reload bump a delete needs.
    const { docs, selected, select, treeReload, bumpTree } = useDocApp(root, app, docId, bucket);


    // The list: this app's scope, then the search hits, then every active tag, newest-claimed-date
    // first with pinned documents floating (pure/doclist.js holds the rules and their vectors).
    const hits = useSearch(root, searchQuery);
    const list = orderDocs(docs, { app, bucket, hits, tags: tagFilter, kind: searchKind });

    // The everything-view's follow-me-home: route to the document's OFFICIAL app (first
    // bucket's type, via the live roster; unbucketed stays home in All) - the deep-link
    // bucket correction picks the right notebook once there, because the doc knows its own.
    const loc = useLocation();
    const roster = useLive(() => (app.everything ? openMirror(root).buckets.toArray() : []), [root]);
    const followHome = (d) => loc.route(`/home/${homeAppFor(d, roster).id}/${d.doc_id}`);

    const toggleTag = (tag) =>
        setTagFilter((f) => (f.includes(tag) ? f.filter((t) => t !== tag) : [...f, tag]));

    // Counted over the SEARCH results (query + kind dial) rather than the tag-filtered list, so
    // the cloud narrows with a search but still shows every tag you could add.
    const tagCloud = feat.tagColumn
        ? tagCounts(orderDocs(docs, { app, bucket, hits, kind: searchKind }))
        : [];

    // Which columns are tucked away to a rail - column chrome, so panes.js owns it alongside the
    // widths. `startsTucked` is the app's own opening posture (TurboNotes begins as a plain list,
    // its tag column and tree waiting as rails); a stored preference always wins over it.
    const { tucked, toggleTuck } = useColTucks(root, app.id, app.startsTucked);

    // The tree's depth-first doc order (the "book order"), reported by the tree pane.
    const [treeOrder, setTreeOrder] = useState(null);

    // Column widths: each column left of the editor drags at its right edge (panes.js - the
    // shared resizer strips + `colw:` prefs + CSS-var plumbing).
    const { resizer, colStyle } = useColWidths(root, app.id, ['tags', 'list', 'tree']);

    // Which order prev/next walks depends on what's showing: with the tree column open they read
    // it as a book (depth-first, and the tree wins when both columns are open); with it tucked or
    // absent they walk the list's time order, where NEXT goes back in time (the list reads
    // newest-first, so next is simply "down the list" - Recipes always walks this way). A document
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
            // the format chip converts to plaintext for anyone who wants a plain page.
            const made = await api(`/api/identity/${root}/docs`, {
                method: 'POST',
                body: JSON.stringify({ title: 'untitled', body: '', format: 'marquee' }),
            });
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
            select(made.doc_id); // the mirror row follows within a second or two
        } finally {
            setBusy(false);
        }
    };

    return html`
        <div class="notes">
            <div class="notes-columns" style=${colStyle}>
                ${feat.tagColumn &&
                (tucked.has('tags')
                    ? html`<${Rail} icon=${Icons.tag} label="tags" onClick=${() => toggleTuck('tags')} />`
                    : html`<${TagColumn}
                          cloud=${tagCloud}
                          active=${tagFilter}
                          onToggleTag=${toggleTag}
                          onTuck=${() => toggleTuck('tags')}
                      />${resizer('tags')}`)}
                ${tucked.has('list')
                    ? html`<${Rail} icon=${Icons.list} label="items" onClick=${() => toggleTuck('list')} />`
                    : html`<aside class="notes-list">
                    <${PaneHead} label=${nouns} onTuck=${() => toggleTuck('list')} />
                    ${/* The everything-view is for finding, not making - new things are born
                        in their own apps, where they land in a real notebook. */ ''}
                    ${!app.everything &&
                    html`<button class="notes-new" disabled=${busy} onClick=${createNew}>
                        ${busy ? '…' : `+ new ${noun}`}
                    </button>`}
                    ${tagFilter.length > 0 &&
                    html`<div class="notes-tagfilter">
                        ${tagFilter.map(
                            (t) => html`<button
                                class="annot-tag annot-tag-active"
                                key=${t}
                                title="remove filter"
                                onClick=${() => toggleTag(t)}
                            >${t} ×</button>`
                        )}
                    </div>`}
                    ${list.map(
                        (d) => html`<${NoteRow}
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
                            everything=${!!app.everything}
                            onFollowHome=${followHome}
                        />`
                    )}
                    ${docs && list.length === 0 &&
                    html`<p class="null-sub notes-empty">
                        ${hits === null ? 'nothing here yet.' : 'nothing matches.'}
                    </p>`}
                </aside>${resizer('list')}`}
                ${feat.tree &&
                (tucked.has('tree')
                    ? html`<${Rail} icon=${Icons.tree} label="tree" onClick=${() => toggleTuck('tree')} />`
                    : html`<${WikiTree}
                          root=${root}
                          bucket=${bucket}
                          selected=${selected}
                          onSelect=${select}
                          searchQuery=${searchQuery}
                          searchKind=${searchKind}
                          reloadKey=${treeReload}
                          showUnfiled=${false}
                          onMinimize=${() => toggleTuck('tree')}
                          onOrder=${setTreeOrder}
                          itemNoun=${noun}
                      />${resizer('tree')}`)}
                <${RightColumn}
                    root=${root}
                    docId=${selected}
                    docs=${docs}
                    nav=${nav}
                    bucket=${bucket}
                    features=${feat}
                    onDeleted=${() => {
                        select(null);
                        bumpTree();
                    }}
                />
            </div>
        </div>
    `;
};
