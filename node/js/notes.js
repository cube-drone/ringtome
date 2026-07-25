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
const Reader = ({ root, docId }) => {
    const [doc, setDoc] = useState(null);
    const [error, setError] = useState(null);

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
                ? html`<div class="reader-marquee"><${Marquee} source=${doc.body} animate="visible" /></div>`
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
                </span>
            </header>
            ${body}
        </div>
    `;
};

// Text opens in the editor (the reader half lives inside it - a clean doc is just an editor
// you haven't typed in); media and unknown formats stay read-only in the Reader.
const RightColumn = ({ root, docId, docs }) => {
    if (!docId) return html`<${Reader} root=${root} docId=${null} />`;
    const row = (docs || []).find((d) => d.doc_id === docId);
    const format = row ? row.format : 'plaintext';
    if (format === 'plaintext' || format === 'marquee') {
        return html`<${Editor} root=${root} docId=${docId} key=${docId} />`;
    }
    return html`<${Reader} root=${root} docId=${docId} key=${docId} />`;
};

export const Notes = ({ current }) => {
    const root = current.root;
    const docs = useLive(() => openMirror(root).docs.toArray(), [root]);
    const [selected, setSelected] = useState(null);
    const [busy, setBusy] = useState(false);

    const list = (docs || [])
        .slice()
        .sort((a, b) => b.updated_ms - a.updated_ms || (a.doc_id < b.doc_id ? 1 : -1));

    const createNew = async () => {
        setBusy(true);
        try {
            // New items are Marquee by default - the interactive editor is the front door;
            // the format chip converts to plaintext for anyone who wants a plain page.
            const made = await api(`/api/identity/${root}/docs`, {
                method: 'POST',
                body: JSON.stringify({ title: 'untitled', body: '', format: 'marquee' }),
            });
            setSelected(made.doc_id); // the mirror row follows within a second or two
        } finally {
            setBusy(false);
        }
    };

    return html`
        <div class="notes">
            <header class="notes-bar">
                <span class="notes-title">notes</span>
                <span class="notes-count">
                    ${docs ? `${list.length} thing${list.length === 1 ? '' : 's'}` : '…'}
                </span>
            </header>
            <div class="notes-columns">
                <aside class="notes-list">
                    <button class="notes-new" disabled=${busy} onClick=${createNew}>
                        ${busy ? '…' : '+ new item'}
                    </button>
                    ${list.map(
                        (d) => html`<button
                            key=${d.doc_id}
                            class=${d.doc_id === selected ? 'note-row selected' : 'note-row'}
                            onClick=${() => setSelected(d.doc_id)}
                        >
                            <span class="note-row-title">${d.title || 'untitled'}</span>
                            <span class="note-row-when">
                                ${when(d.updated_ms)}${d.diverged ? ' · two versions' : ''}
                            </span>
                        </button>`
                    )}
                    ${docs && list.length === 0 &&
                    html`<p class="null-sub notes-empty">nothing here yet.</p>`}
                </aside>
                <${RightColumn} root=${root} docId=${selected} docs=${docs} />
            </div>
        </div>
    `;
};
