// The right-hand column of every documents app: one document, shown or edited.
//
// Text opens the Editor (the reader half lives inside it - a clean document is just an editor you
// haven't typed in); media and unknown formats stay read-only in the Reader below, so an uploaded
// image or video renders instead of landing in a text editor that cannot hold it.
//
// The Reader's own read-only-ness is about the BYTES. The record around them is still editable: the
// title (via the media-safe retitle route, a new version reusing the head's blobs) and the
// annotations (tags, date, description - version-independent by design).
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';
import { Marquee, parse } from '@cube-drone/marquee-react-renderer';

import { api } from '../net.js';
import { openMirror, useLive } from '../mirror.js';
import { useDocDetail } from './detail.js';
import { Editor } from './editor.js';
import { Annotations } from './annotations.js';
import { useTurbolinks } from './turbolinks.js';
import { slugPathFor } from './address.js';
import { Icons } from '../icons.js';

const html = htm.bind(h);

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
