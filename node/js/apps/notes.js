// The documents app: the surface every "documents" application wears (TurboNotes, Recipes), and
// the everything-app at full stretch - up to four columns, each tuckable. Left to right: the tag
// cloud, the document list (newest-claimed-date first, straight off the live mirror, so another
// computer's save re-sorts it within seconds and nothing fetches), the tree, and the open
// document. Which columns appear is the app registry's `features` (apps.js); the document
// machinery underneath is shared (doc/), so a new app style is a registry line.
//
// This file also holds two things the wiki borrows - `RightColumn` (text opens the editor, media
// the reader) and `useArrowNav` - which is why apps/wiki.js imports sideways from here. That is a
// known wart, queued as REFACTOR_UI B2.
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';
import { Marquee, parse } from '@cube-drone/marquee-react-renderer';

import { api } from '../net.js';
import { openMirror, useLive } from '../mirror.js';
import { useDocDetail } from '../doc/detail.js';
import { Editor } from '../doc/editor.js';
import { Annotations } from '../doc/annotations.js';
import { useTurbolinks } from '../doc/turbolinks.js';
import { useSearch, queryWords } from '../search.js';
import { claimedMs, hasClaimedDate, formatClaimed, DISPLAY_DATE_FIELD } from '../docdate.js';
import { useLocation } from 'preact-iso';
import { DEFAULT_STYLE, featuresOf } from '../apps.js';
import { WikiTree, ensureTreeRoot } from '../doc/tree.js';
import { useColWidths, useColTucks } from '../panes.js';
import { useSlugDocId, useCozyAddress, slugPathFor } from '../doc/address.js';
import { startDocDrag } from '../doc/crosslink.js';
import { Icons, formatIcon } from '../icons.js';

const html = htm.bind(h);

// The last document open in each app, keyed by `${root}:${app.id}` - so opening an app returns
// you to where you were. In-memory (a session convenience), the same idea as the per-document
// cursor memory; forgotten on reload.
const lastDocMemory = new Map();

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

// The reader: read-only display of one document's resolved current state. `body` arrives
// synthesized by the node (single head, clean merge, or the conflict presented inline - the
// editor-is-the-merge-tool doctrine means a reader just... shows it).
const Reader = ({ root, docId, onDeleted, nav, bucket }) => {
    // The shared read-only loader (doc/detail.js). Write failures below get their own state; the
    // header shows whichever error is live.
    const { doc, error: loadError } = useDocDetail(root, docId);
    const [writeError, setWriteError] = useState(null);
    const error = loadError || writeError;
    // The record around a read-only BODY is still editable: the title (via the media-safe
    // retitle route - a new version reusing the head's blobs) and the annotations (tags, date,
    // description - version-independent by design). "Read-only" is about the bytes, not the
    // filing.
    const [title, setTitle] = useState('');
    const hydrated = useRef(false); // the body-retry loop refetches; hydrate the input ONCE
    const [showMeta, setShowMeta] = useState(false);
    const [linkCopied, setLinkCopied] = useState(false);
    const copyLink = async () => {
        const p = await slugPathFor(root, docId, bucket);
        if (!p) return;
        try {
            await navigator.clipboard.writeText(p);
        } catch {
            return;
        }
        setLinkCopied(true);
        setTimeout(() => setLinkCopied(false), 1600);
    };
    const saveTitle = async () => {
        if (!doc || title === (doc.title || '')) return;
        try {
            await api(`/api/identity/${root}/docs/${docId}/title`, {
                method: 'PATCH',
                body: JSON.stringify({ title }),
            });
        } catch (e) {
            setWriteError(e.message);
        }
    };
    useEffect(() => {
        if (doc && !hydrated.current) {
            hydrated.current = true;
            setTitle(doc.title || '');
        }
    }, [doc]);
    const tlProfile = useTurbolinks(doc?.body ?? '', doc?.format);
    // Pin state rides the mirror row (not the doc detail), so read it live from there.
    const row = useLive(() => (docId ? openMirror(root).docs.get(docId) : null), [root, docId]);
    const pinned = !!(row && row.pinned);

    const togglePin = async () => {
        try {
            await api(`/api/identity/${root}/docs/${docId}/pin`, {
                method: pinned ? 'DELETE' : 'PUT',
            });
        } catch (e) {
            setWriteError(e.message);
        }
    };

    const remove = async () => {
        if (!confirm('Delete this document? It leaves the list right away.')) return;
        try {
            await api(`/api/identity/${root}/docs/${docId}`, { method: 'DELETE' });
            onDeleted && onDeleted();
        } catch (e) {
            setWriteError(e.message);
        }
    };

    // A fresh document: re-hydrate the title input from the new detail and close the meta panel.
    useEffect(() => {
        hydrated.current = false;
        setTitle('');
        setShowMeta(false);
        setWriteError(null);
    }, [root, docId]);

    if (!docId) {
        return html`<div class="reader reader-empty">
            <p class="null-sub">pick something on the left, or make something new.</p>
        </div>`;
    }
    if (error) return html`<div class="reader"><p class="form-error">${error}</p></div>`;
    if (!doc) return html`<div class="reader"><p class="null-sub">opening…</p></div>`;

    const mediaUrl = `/api/identity/${root}/docs/${docId}/body`;
    let body;
    if (doc.format === 'plaintext') {
        body = html`<pre class="reader-plain">${doc.body ?? '(body not on this computer yet)'}</pre>`;
    } else if (doc.format === 'marquee') {
        if (doc.body == null) {
            body = html`<p class="null-sub">(body not on this computer yet)</p>`;
        } else {
            // A conflict hunk can split a block element and fail the strict parse (the
            // accepted cost of per-hunk marquee conflicts). Degrade to source, honestly.
            let parses = true;
            try {
                parse(doc.body);
            } catch {
                parses = false;
            }
            body = parses
                ? html`<div class="reader-marquee"><${Marquee} source=${doc.body} animate="visible" profile=${tlProfile} /></div>`
                : html`<div>
                      <p class="null-sub">
                          this marquee doesn't parse right now (likely a conflict split a
                          block) - showing the source; edit to tidy it.
                      </p>
                      <pre class="reader-plain">${doc.body}</pre>
                  </div>`;
        }
    } else if (doc.format === 'avif' || doc.format === 'apng') {
        body = html`<img class="reader-media" src=${mediaUrl} alt=${doc.title} />`;
    } else if (doc.format === 'webm') {
        body = html`<video class="reader-media" controls src=${mediaUrl}></video>`;
    } else if (doc.format === 'opus') {
        body = html`<audio controls src=${mediaUrl}></audio>`;
    } else {
        body = html`<p class="null-sub">(a ${doc.format} document - no reader for it yet)</p>`;
    }

    return html`
        <div class="reader reader-file">
            <header class="reader-head">
                <input
                    class="editor-title"
                    value=${title}
                    placeholder="untitled"
                    onInput=${(e) => setTitle(e.currentTarget.value)}
                    onBlur=${saveTitle}
                />
                <span class="reader-chips">
                    ${onDeleted &&
                    html`<button
                        class="chip chip-button chip-delete"
                        title="Delete — removes this document from every list (its history is kept)"
                        onClick=${remove}
                    ><${Icons.trash} /></button>`}
                    ${doc.diverged &&
                    (doc.resolution === 'conflict'
                        ? html`<span class="chip chip-diverged" title="edited in the same place on two computers; every version is shown below">conflict</span>`
                        : html`<span class="chip chip-merged" title="changes from two computers, woven together cleanly">merged</span>`)}
                    <span class="chip">${doc.format}</span>
                    <span class="chip">read-only</span>
                    <button
                        class=${linkCopied ? 'chip chip-button chip-open' : 'chip chip-button'}
                        title=${linkCopied
                            ? 'Copied!'
                            : 'Copy a link to this document (paste it into another document to crosslink)'}
                        onClick=${copyLink}
                    ><${Icons.link} /></button>
                    <button
                        class=${showMeta ? 'chip chip-button chip-open' : 'chip chip-button'}
                        title="tags, date & description"
                        onClick=${() => setShowMeta((v) => !v)}
                    ><${Icons.tag} /></button>
                    <button
                        class=${pinned ? 'chip chip-button chip-pinned' : 'chip chip-button'}
                        title=${pinned
                            ? 'Pinned — click to unpin it from the top of the list'
                            : 'Not pinned — click to pin it to the top of the list'}
                        onClick=${togglePin}
                    ><${Icons.pin} /></button>
                    ${nav &&
                    html`<button
                            class="chip chip-button"
                            title=${nav.prevTip || 'the previous document'}
                            disabled=${!nav.prev}
                            onClick=${() => nav.prev && nav.go(nav.prev)}
                        ><${Icons.navPrev} /></button>
                        <button
                            class="chip chip-button"
                            title=${nav.nextTip || 'the next document'}
                            disabled=${!nav.next}
                            onClick=${() => nav.next && nav.go(nav.next)}
                        ><${Icons.navNext} /></button>`}
                </span>
                ${showMeta &&
                html`<div class="editor-meta">
                    <${Annotations} root=${root} docId=${docId} />
                </div>`}
            </header>
            <div class="reader-scroll">${body}</div>
        </div>
    `;
};

// Text opens in the editor (the reader half lives inside it - a clean doc is just an editor
// you haven't typed in); media and unknown formats stay read-only in the Reader.
// Exported: the wiki mounts this too, so a media page there opens the Reader, not a text editor.
export const RightColumn = ({ root, docId, docs, features, onDeleted, nav, bucket }) => {
    if (!docId) return html`<${Reader} root=${root} docId=${null} />`;
    const row = (docs || []).find((d) => d.doc_id === docId);
    const format = row ? row.format : 'plaintext';
    if (format === 'plaintext' || format === 'marquee') {
        return html`<${Editor}
            root=${root}
            docId=${docId}
            key=${docId}
            nav=${nav}
            bucket=${bucket}
            features=${features}
            onDeleted=${onDeleted}
        />`;
    }
    return html`<${Reader}
        root=${root}
        docId=${docId}
        key=${docId}
        nav=${nav}
        bucket=${bucket}
        onDeleted=${onDeleted}
    />`;
};

// The documents app - the shared surface every "documents" application (Notes, Recipes, ...)
// currently renders. `app` is its registry entry (id, name, icon, style); the document
// machinery is the same, so a new app style is a registry line plus, later, its own layout.
// `searchQuery`, not `query` - preact-iso's Router injects its OWN `query` prop (parsed URL search
// params, an object), which would shadow a prop of that name and break the string search.
export const DocsApp = ({ app, current, docId, searchQuery, bucket }) => {
    const root = current.root;
    const feat = featuresOf(app);
    const loc = useLocation();
    const docs = useLive(() => openMirror(root).docs.toArray(), [root]);
    const [busy, setBusy] = useState(false);
    const [tagFilter, setTagFilter] = useState([]); // active tag filters, stacked (AND)

    // The selected document lives in the URL (`/home/<app>/<doc_id>`), not local state - so
    // back/forward and deep links just work. Selecting navigates; the route param is the source.
    // A non-hex :docId is a cozy slug - resolved to the effective id in place, no redirect
    // (cozy URLs REST); and a hex URL dresses itself in the doc's cozy address (doc/address.js).
    const selected = useSlugDocId(root, app.id, docId);
    const select = (id) => loc.route(id ? `/home/${app.id}/${id}` : `/home/${app.id}`);
    useCozyAddress(root, selected, bucket);

    // This app shows ONE bucket at a time - the header's bucket switcher picks which, and the
    // pick arrives as the `bucket` prop (the app's home bucket when nothing's picked). A doc is
    // in view when it's a member of that bucket; the home bucket of the DEFAULT app additionally
    // gathers unbucketed documents (they resolve to the default type, and home is the catch-all).
    // Per-notebook scoping is why searching a recipe book never turns up a journal entry.
    const inThisBucket = (d) => {
        const names = d.buckets || [];
        if (names.includes(bucket)) return true;
        return bucket === app.style && app.style === DEFAULT_STYLE && names.length === 0;
    };

    // Resume where you left off. Remember the document you have open as this app's most-recent,
    // and - when you ENTER the app with nothing selected - return to it. The `restored` guard
    // makes it a one-time, on-open jump: deliberately going back to the list later (header back)
    // never bounces you into the document again. The redirect REPLACES history, so Back still
    // exits to the launcher rather than looping through the list.
    const restored = useRef(false);
    useEffect(() => {
        if (selected) lastDocMemory.set(`${root}:${app.id}`, selected);
    }, [selected, root, app.id]);
    useEffect(() => {
        if (restored.current || !docs) return; // wait for the mirror, then decide exactly once
        restored.current = true;
        if (selected) return; // already on a document - nothing to restore
        const last = lastDocMemory.get(`${root}:${app.id}`);
        if (last && docs.some((d) => d.doc_id === last && inThisBucket(d))) {
            loc.route(`/home/${app.id}/${last}`, true);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [docs, selected]);

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

    // A deleted doc never touches the taxonomy roster, so the tree wouldn't notice on its own.
    const [treeReload, setTreeReload] = useState(0);
    // The tree's depth-first doc order (the "book order"), reported by the tree pane.
    const [treeOrder, setTreeOrder] = useState(null);

    // Column widths: each column left of the editor drags at its right edge (panes.js - the
    // shared resizer strips + `colw:` prefs + CSS-var plumbing).
    const { resizer, colStyle } = useColWidths(root, app.id, ['tags', 'list', 'tree']);

    // Prev/next in the doc menu. Which order they walk depends on what's showing: with the
    // tree column open, they read the tree as a book (down/up, depth-first - and the tree wins
    // when both columns are open); with it tucked or absent, they walk the list's time order,
    // where NEXT goes back in time (the list reads newest-first, so next is simply "down the
    // list" - Recipes always walks this way). A doc missing from the tree (unfiled) falls back
    // to the list order rather than stranding the arrows.
    const listOrder = list.map((d) => d.doc_id);
    const treeShowing = feat.tree && !tucked.has('tree');
    const bookish = treeShowing && treeOrder && selected && treeOrder.includes(selected);
    const navOrder = bookish ? treeOrder : listOrder;
    const navAt = selected ? navOrder.indexOf(selected) : -1;
    const nav =
        navAt !== -1 && navOrder.length > 1
            ? {
                  prev: navAt > 0 ? navOrder[navAt - 1] : null,
                  next: navAt < navOrder.length - 1 ? navOrder[navAt + 1] : null,
                  go: select,
                  prevTip: bookish ? 'Previous — back up the tree' : 'Previous — newer',
                  nextTip: bookish ? 'Next — down the tree' : 'Next — older',
              }
            : null;
    // The arrow keys walk the same order the chips do.
    useArrowNav(nav, navOrder, selected, select);

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
            // When the tree column exists, a new item also takes its place in the tree - the
            // last child of the root (append), where it's visible and draggable into shape,
            // rather than invisibly unfiled.
            if (feat.tree) {
                const rootTax = await ensureTreeRoot(root, bucket);
                await api(`/api/identity/${root}/taxonomies/${rootTax}/members/${made.doc_id}`, {
                    method: 'PUT',
                    body: JSON.stringify({}),
                });
                setTreeReload((k) => k + 1); // don't wait for the roster tick
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
                        ${busy ? '…' : '+ new item'}
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
                        setTreeReload((k) => k + 1);
                    }}
                />
            </div>
        </div>
    `;
};
