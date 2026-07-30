// The documents app: the surface every "documents" application wears (TurboNotes, Recipes), and
// the everything-app at full stretch - up to four columns, each tuckable. Left to right: the tag
// cloud, the document list (newest-claimed-date first, straight off the live mirror, so another
// computer's save re-sorts it within seconds and nothing fetches), the tree, and the open
// document. Which columns appear is the app registry's `features` (apps.js); the document
// machinery underneath is shared (doc/), so a new app style is a registry line.
//
// Everything reusable has moved below this file: the routing/resume/nav spine is doc/docapp.js, the
// open document is doc/reader.js, the tree is doc/tree.js, the columns are panes.js. What is left
// here is this app's own arrangement of them - the filters, the list rows, the tag cloud - which is
// why the Wikibook can wear the same skeleton without importing a line of it.
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';

import { api } from '../net.js';
import { RightColumn } from '../doc/reader.js';
import { useDocApp, useDocNav } from '../doc/docapp.js';
import { useSearch, queryWords } from '../search.js';
import { claimedMs, hasClaimedDate, formatClaimed, DISPLAY_DATE_FIELD } from '../docdate.js';
import { bucketHolds, featuresOf, itemNoun } from '../apps.js';
import { WikiTree, ensureTreeRoot } from '../doc/tree.js';
import { useColWidths, useColTucks } from '../panes.js';
import { startDocDrag } from '../doc/crosslink.js';
import { Icons, formatIcon } from '../icons.js';

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

// A tucked-away column: the slim rail left standing when a column is minimized - its icon and
// name run vertically, and a click brings the column back.
const Rail = ({ icon, label, onClick }) => html`<button
    class="pane-rail"
    title=${`show ${label}`}
    onClick=${onClick}
>
    <${icon} />
    <span class="pane-rail-label">${label}</span>
</button>`;

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


// The documents app - the shared surface every "documents" application (Notes, Recipes, ...)
// currently renders. `app` is its registry entry (id, name, icon, style); the document
// machinery is the same, so a new app style is a registry line plus, later, its own layout.
// `searchQuery`, not `query` - preact-iso's Router injects its OWN `query` prop (parsed URL search
// params, an object), which would shadow a prop of that name and break the string search.
export const DocsApp = ({ app, current, docId, searchQuery, bucket }) => {
    const root = current.root;
    const feat = featuresOf(app);
    const noun = itemNoun(app); // what this app calls one of its things
    const [busy, setBusy] = useState(false);
    const [tagFilter, setTagFilter] = useState([]); // active tag filters, stacked (AND)

    // The shared documents-app spine (doc/docapp.js): the live documents, the open document and how
    // to change it (it lives in the URL, so back/forward and deep links just work), the resume-where
    // -you-left-off jump, and the tree-reload bump a delete needs.
    const { docs, selected, select, treeReload, bumpTree } = useDocApp(root, app, docId, bucket);

    // This app shows ONE bucket at a time - the header's switcher picks which, and the pick arrives
    // as the `bucket` prop. `bucketHolds` is the shared rule (apps.js): membership, plus the
    // default app's home gathering the unbucketed. Per-notebook scoping is why searching a recipe
    // book never turns up a journal entry.
    const inThisBucket = (d) => bucketHolds(d, app, bucket);

    // Filters stack: this app's scope, THEN search hits, THEN every active tag. Search stays a
    // filter over the current view (Curtis's preference) rather than a separate ranked screen.
    const hits = useSearch(root, searchQuery);
    // Newest first by the CLAIMED date - a doc's own display_date if it set one, else its real
    // last-updated stamp. So a note backdated to 2015 files itself under 2015, not the day you
    // typed it (the user's date is authoritative, per Curtis's ask).
    // Pinned documents float to the top (a doc-meta flag), then newest-claimed-date first.
    const list = (docs || [])
        .filter(inThisBucket)
        .filter((d) => hits === null || hits.has(d.doc_id))
        .filter((d) => tagFilter.every((t) => (d.tags || []).includes(t)))
        .sort(
            (a, b) =>
                (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
                claimedMs(b) - claimedMs(a) ||
                (a.doc_id < b.doc_id ? 1 : -1)
        );

    const toggleTag = (tag) =>
        setTagFilter((f) => (f.includes(tag) ? f.filter((t) => t !== tag) : [...f, tag]));

    // The tag cloud (an optional sidebar): every tag across this app's documents that match the
    // current search, most-used first. Counted over the search results (not the tag filter), so
    // it narrows with a query but still shows every tag you could add; clicking one toggles it
    // into the same tag filter the list uses.
    const tagCloud = feat.tagColumn
        ? Object.entries(
              (docs || [])
                  .filter(inThisBucket)
                  .filter((d) => hits === null || hits.has(d.doc_id))
                  .reduce((counts, d) => {
                      for (const t of d.tags || []) counts[t] = (counts[t] || 0) + 1;
                      return counts;
                  }, {})
          ).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        : [];

    // Which columns are tucked away to a rail - column chrome, so panes.js owns it alongside the
    // widths.
    const { tucked, toggleTuck } = useColTucks(root, app.id);
    const paneHead = (label, col) => html`<div class="pane-head">
        <span class="pane-head-label">${label}</span>
        <button class="pane-min" title=${`tuck the ${label} column away`} onClick=${() => toggleTuck(col)}>
            <${Icons.back} />
        </button>
    </div>`;

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
                    : html`<aside class="tag-column">
                          ${paneHead('tags', 'tags')}
                          ${tagCloud.map(
                              ([tag, count]) => html`<button
                                  key=${tag}
                                  class=${tagFilter.includes(tag)
                                      ? 'tag-cloud-row active'
                                      : 'tag-cloud-row'}
                                  onClick=${() => toggleTag(tag)}
                              >
                                  <span class="tag-cloud-name">${tag}</span>
                                  <span class="tag-cloud-count">${count}</span>
                              </button>`
                          )}
                          ${tagCloud.length === 0 &&
                          html`<p class="null-sub tag-column-empty">no tags yet</p>`}
                      </aside>${resizer('tags')}`)}
                ${tucked.has('list')
                    ? html`<${Rail} icon=${Icons.list} label="items" onClick=${() => toggleTuck('list')} />`
                    : html`<aside class="notes-list">
                    ${paneHead('items', 'list')}
                    <button class="notes-new" disabled=${busy} onClick=${createNew}>
                        ${busy ? '…' : `+ new ${noun}`}
                    </button>
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
                        (d) => html`<button
                            key=${d.doc_id}
                            class=${d.doc_id === selected ? 'note-row selected' : 'note-row'}
                            onClick=${() => select(d.doc_id)}
                            draggable=${true}
                            onDragStart=${(e) => startDocDrag(e, root, d, bucket)}
                        >
                            <span class="note-row-title">
                                ${d.pinned && html`<span class="note-row-pin" title="pinned"><${Icons.pin} /></span> `}${formatIcon(d.format) &&
                                html`<span class="note-row-kind"><${formatIcon(d.format)} /></span> `}${d.title || 'untitled'}
                            </span>
                            ${feat.description &&
                            d.fields &&
                            d.fields.description &&
                            html`<small class="note-row-desc">${d.fields.description}</small>`}
                            ${hits !== null &&
                            html`<${Snippet}
                                root=${root}
                                docId=${d.doc_id}
                                query=${searchQuery}
                            />`}
                            ${(feat.date || d.diverged) &&
                            html`<span class="note-row-when">
                                ${feat.date &&
                                (hasClaimedDate(d)
                                    ? html`<span
                                          class="note-row-claimed"
                                          title="a date you set for this document (its real last edit was ${when(d.updated_ms)})"
                                      >${formatClaimed(d.fields[DISPLAY_DATE_FIELD])}</span>`
                                    : when(d.updated_ms))}${d.diverged
                                    ? (feat.date ? ' · ' : '') + 'two versions'
                                    : ''}
                            </span>`}
                            ${(d.tags || []).length > 0 &&
                            html`<span class="note-row-tags">
                                ${d.tags.map(
                                    (t) => html`<span
                                        class=${tagFilter.includes(t)
                                            ? 'note-row-tag active'
                                            : 'note-row-tag'}
                                        key=${t}
                                        role="button"
                                        onClick=${(e) => {
                                            e.stopPropagation();
                                            toggleTag(t);
                                        }}
                                    >${t}</span>`
                                )}
                            </span>`}
                        </button>`
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
