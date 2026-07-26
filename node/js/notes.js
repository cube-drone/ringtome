// The notes app, v0: two columns and honesty. Left: every document that exists, newest
// first, straight off the live mirror (so another computer's save re-sorts the list within
// seconds, no fetching). Right: the reader - read-only display of the resolved body, format
// dispatched (plaintext | marquee | media). The editor, taxonomies in the left column, tag
// filters, and the flexible cozy-OS window all come later; this is the skeleton they hang on.
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';
import { Marquee, parse } from '@cube-drone/marquee-react-renderer';

import { openMirror, useLive } from './cache.js';
import { Editor } from './editor.js';
import { useTurbolinks } from './turbolinks.js';
import { useSearch } from './search.js';
import { claimedMs, hasClaimedDate, formatClaimed, DISPLAY_DATE_FIELD } from './docdate.js';
import { useLocation } from 'preact-iso';
import { DEFAULT_STYLE, appTypeOf, featuresOf } from './apps.js';
import { Icons } from './icons.js';

const html = htm.bind(h);

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
export const DocsApp = ({ app, current, docId }) => {
    const root = current.root;
    const feat = featuresOf(app);
    const loc = useLocation();
    const docs = useLive(() => openMirror(root).docs.toArray(), [root]);
    const [busy, setBusy] = useState(false);
    const [query, setQuery] = useState('');
    const [tagFilter, setTagFilter] = useState([]); // active tag filters, stacked (AND)

    // The selected document lives in the URL (`/home/<app>/<doc_id>`), not local state - so
    // back/forward and deep links just work. Selecting navigates; the route param is the source.
    const selected = docId || null;
    const select = (id) => loc.route(id ? `/home/${app.id}/${id}` : `/home/${app.id}`);

    // This app shows only its own documents. A doc's app-type is its bucket's type (a bucket
    // named like an app-type IS that type; user buckets resolve via the streamed registry);
    // an unbucketed doc belongs to the default app, which is the catch-all. So a doc shows here
    // when any of its buckets resolves to this app's style - the per-notebook scoping the whole
    // console rests on, and why searching in the recipe app never turns up a journal entry.
    const roster = useLive(() => openMirror(root).buckets.toArray(), [root]);
    const inThisApp = (d) => {
        const names = d.buckets || [];
        const types = names.length ? names.map((n) => appTypeOf(n, roster)) : [DEFAULT_STYLE];
        return types.includes(app.style);
    };

    // Filters stack: this app's scope, THEN search hits, THEN every active tag. Search stays a
    // filter over the current view (Curtis's preference) rather than a separate ranked screen.
    const hits = useSearch(root, query);
    // Newest first by the CLAIMED date - a doc's own display_date if it set one, else its real
    // last-updated stamp. So a note backdated to 2015 files itself under 2015, not the day you
    // typed it (the user's date is authoritative, per Curtis's ask).
    // Pinned documents float to the top (a doc-meta flag), then newest-claimed-date first.
    const list = (docs || [])
        .filter(inThisApp)
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
                  .filter(inThisApp)
                  .filter((d) => hits === null || hits.has(d.doc_id))
                  .reduce((counts, d) => {
                      for (const t of d.tags || []) counts[t] = (counts[t] || 0) + 1;
                      return counts;
                  }, {})
          ).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        : [];

    const createNew = async () => {
        setBusy(true);
        try {
            // New items are Marquee by default - the interactive editor is the front door;
            // the format chip converts to plaintext for anyone who wants a plain page.
            const made = await api(`/api/identity/${root}/docs`, {
                method: 'POST',
                body: JSON.stringify({ title: 'untitled', body: '', format: 'marquee' }),
            });
            // File it into this app's eponymous bucket (the bucket named for the app's style,
            // implicitly of that type), so it belongs here and not just to the catch-all.
            await api(
                `/api/identity/${root}/docs/${made.doc_id}/buckets/${encodeURIComponent(app.style)}`,
                { method: 'PUT' }
            );
            select(made.doc_id); // the mirror row follows within a second or two
        } finally {
            setBusy(false);
        }
    };

    return html`
        <div class="notes">
            <header class="notes-bar">
                <span class="notes-title"><${app.icon} /> ${app.name}</span>
                <span class="notes-count">
                    ${docs ? `${list.length} thing${list.length === 1 ? '' : 's'}` : '…'}
                </span>
            </header>
            <div class="notes-columns">
                ${feat.tagColumn &&
                html`<aside class="tag-column">
                    <div class="tag-column-title">tags</div>
                    ${tagCloud.map(
                        ([tag, count]) => html`<button
                            key=${tag}
                            class=${tagFilter.includes(tag) ? 'tag-cloud-row active' : 'tag-cloud-row'}
                            onClick=${() => toggleTag(tag)}
                        >
                            <span class="tag-cloud-name">${tag}</span>
                            <span class="tag-cloud-count">${count}</span>
                        </button>`
                    )}
                    ${tagCloud.length === 0 &&
                    html`<p class="null-sub tag-column-empty">no tags yet</p>`}
                </aside>`}
                <aside class="notes-list">
                    <button class="notes-new" disabled=${busy} onClick=${createNew}>
                        ${busy ? '…' : '+ new item'}
                    </button>
                    <input
                        class="notes-search"
                        type="search"
                        placeholder="search…"
                        value=${query}
                        onInput=${(e) => setQuery(e.currentTarget.value)}
                    />
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
                </aside>
                <${RightColumn}
                    root=${root}
                    docId=${selected}
                    docs=${docs}
                    features=${feat}
                    onDeleted=${() => select(null)}
                />
            </div>
        </div>
    `;
};
