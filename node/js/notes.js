// The notes app, v0: two columns and honesty. Left: every document that exists, newest
// first, straight off the live mirror (so another computer's save re-sorts the list within
// seconds, no fetching). Right: the reader - read-only display of the resolved body, format
// dispatched (plaintext | marquee | media). The editor, taxonomies in the left column, tag
// filters, and the flexible cozy-OS window all come later; this is the skeleton they hang on.
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';
import { Marquee, parse } from '@cube-drone/marquee-react-renderer';

import { openMirror, useLive } from './cache.js';
import { Editor } from './editor.js';
import { useTurbolinks } from './turbolinks.js';
import { useSearch, queryWords } from './search.js';
import { claimedMs, hasClaimedDate, formatClaimed, DISPLAY_DATE_FIELD } from './docdate.js';
import { useLocation } from 'preact-iso';
import { DEFAULT_STYLE, featuresOf } from './apps.js';
import { WikiTree, ensureTreeRoot } from './tree.js';
import { useColWidths } from './panes.js';
import { Icons } from './icons.js';

const html = htm.bind(h);

// The last document open in each app, keyed by `${root}:${app.id}` - so opening an app returns
// you to where you were. In-memory (a session convenience), the same idea as the per-document
// cursor memory; forgotten on reload.
const lastDocMemory = new Map();

async function api(path, options = {}) {
    const res = await fetch(path, {
        credentials: 'same-origin',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        ...options,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(body.message || `request failed (${res.status})`);
    }
    return body;
}

const when = (ms) => new Date(ms).toLocaleString();

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
const Reader = ({ root, docId, onDeleted }) => {
    const [doc, setDoc] = useState(null);
    const [error, setError] = useState(null);
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
            setError(e.message);
        }
    };

    const remove = async () => {
        if (!confirm('Delete this document? It leaves the list right away.')) return;
        try {
            await api(`/api/identity/${root}/docs/${docId}`, { method: 'DELETE' });
            onDeleted && onDeleted();
        } catch (e) {
            setError(e.message);
        }
    };

    useEffect(() => {
        setDoc(null);
        setError(null);
        if (!docId) return;
        let timer = null;
        const fetchDoc = () =>
            api(`/api/identity/${root}/docs/${docId}`)
                .then((d) => {
                    setDoc(d);
                    // Bodies can trail their headers across computers; retry until they land.
                    if (d.body == null) timer = setTimeout(fetchDoc, 2000);
                })
                .catch((e) => setError(e.message));
        fetchDoc();
        return () => timer && clearTimeout(timer);
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
        <div class="reader">
            <header class="reader-head">
                <span class="reader-title">${doc.title || 'untitled'}</span>
                <span class="reader-chips">
                    ${doc.diverged &&
                    (doc.resolution === 'conflict'
                        ? html`<span class="chip chip-diverged" title="edited in the same place on two computers; every version is shown below">conflict</span>`
                        : html`<span class="chip chip-merged" title="changes from two computers, woven together cleanly">merged</span>`)}
                    <span class="chip">${doc.format}</span>
                    <span class="chip">read-only</span>
                    <button
                        class=${pinned ? 'chip chip-button chip-pinned' : 'chip chip-button'}
                        title=${pinned
                            ? 'unpin from the top of the list'
                            : 'pin to the top of the list'}
                        onClick=${togglePin}
                    >${pinned ? html`<${Icons.pin} /> pinned` : 'pin'}</button>
                    ${onDeleted &&
                    html`<button
                        class="chip chip-button chip-delete"
                        title="delete this document (it leaves every list; the history is kept)"
                        onClick=${remove}
                    >delete</button>`}
                </span>
            </header>
            ${body}
        </div>
    `;
};

// Text opens in the editor (the reader half lives inside it - a clean doc is just an editor
// you haven't typed in); media and unknown formats stay read-only in the Reader.
const RightColumn = ({ root, docId, docs, features, onDeleted }) => {
    if (!docId) return html`<${Reader} root=${root} docId=${null} />`;
    const row = (docs || []).find((d) => d.doc_id === docId);
    const format = row ? row.format : 'plaintext';
    if (format === 'plaintext' || format === 'marquee') {
        return html`<${Editor}
            root=${root}
            docId=${docId}
            key=${docId}
            features=${features}
            onDeleted=${onDeleted}
        />`;
    }
    return html`<${Reader} root=${root} docId=${docId} key=${docId} onDeleted=${onDeleted} />`;
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
    const selected = docId || null;
    const select = (id) => loc.route(id ? `/home/${app.id}/${id}` : `/home/${app.id}`);

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

    // Which columns are tucked away (minimized to a rail): per-app, in Dexie prefs like the
    // journal seals and tree folds - durable in this browser, live across tabs, never synced.
    // The main surface can't tuck; everything to its left can.
    const colRows = useLive(
        () => openMirror(root).prefs.where('key').startsWith(`col:${app.id}:`).toArray(),
        [root, app.id]
    );
    const tucked = new Set(
        (colRows || []).filter((r) => r.value === '1').map((r) => r.key.split(':')[2])
    );
    const toggleCol = (c) => {
        openMirror(root)
            .prefs.put({ key: `col:${app.id}:${c}`, value: tucked.has(c) ? '0' : '1' })
            .catch(() => {});
    };
    const paneHead = (label, col) => html`<div class="pane-head">
        <span class="pane-head-label">${label}</span>
        <button class="pane-min" title=${`tuck the ${label} column away`} onClick=${() => toggleCol(col)}>
            <${Icons.back} />
        </button>
    </div>`;

    // A deleted doc never touches the taxonomy roster, so the tree wouldn't notice on its own.
    const [treeReload, setTreeReload] = useState(0);

    // Column widths: each column left of the editor drags at its right edge (panes.js - the
    // shared resizer strips + `colw:` prefs + CSS-var plumbing).
    const { resizer, colStyle } = useColWidths(root, app.id, ['tags', 'list', 'tree']);

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
                    ? html`<${Rail} icon=${Icons.tag} label="tags" onClick=${() => toggleCol('tags')} />`
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
                    ? html`<${Rail} icon=${Icons.list} label="items" onClick=${() => toggleCol('list')} />`
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
                        >
                            <span class="note-row-title">
                                ${d.pinned && html`<span class="note-row-pin" title="pinned"><${Icons.pin} /></span> `}${d.title || 'untitled'}
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
                    ? html`<${Rail} icon=${Icons.tree} label="tree" onClick=${() => toggleCol('tree')} />`
                    : html`<${WikiTree}
                          root=${root}
                          bucket=${bucket}
                          selected=${selected}
                          onSelect=${select}
                          searchQuery=${searchQuery}
                          reloadKey=${treeReload}
                          showUnfiled=${false}
                          onMinimize=${() => toggleCol('tree')}
                      />${resizer('tree')}`)}
                <${RightColumn}
                    root=${root}
                    docId=${selected}
                    docs=${docs}
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
