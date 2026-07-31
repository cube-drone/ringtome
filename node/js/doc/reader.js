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

import { api } from '../net.js';
import { openMirror, useLive } from '../mirror.js';
import { useDocDetail } from './detail.js';
import { Chip, NavChips } from './chips.js';
import { MarqueeBody } from './marqueebody.js';
import { decoratedBodyUrl } from './upload.js';
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
    // For a MEDIA document the useful link is the file itself: the decorated byte URL pastes
    // straight into `![](…)` and renders (the cozy document address never can - the embed
    // sniff needs the extension). Text documents keep the crosslink address.
    const isMedia = doc && doc.format !== 'marquee' && doc.format !== 'plaintext';
    const copyLink = async () => {
        const p = isMedia
            ? decoratedBodyUrl(root, docId, doc.format, doc.title)
            : await slugPathFor(root, docId, bucket);
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

    // The DECORATED byte URL, not the bare /body: right-click -> "copy image address" on the
    // rendered media must yield a URL that re-embeds when pasted into a document, and the
    // embed sniff reads the extension (upload.js, decoratedBodyUrl).
    const mediaUrl = decoratedBodyUrl(root, docId, doc.format, doc.title);
    let body;
    if (doc.format === 'plaintext') {
        body = html`<pre class="reader-plain">${doc.body ?? '(body not on this computer yet)'}</pre>`;
    } else if (doc.format === 'marquee') {
        body =
            doc.body == null
                ? html`<p class="null-sub">(body not on this computer yet)</p>`
                : html`<${MarqueeBody} source=${doc.body} profile=${tlProfile} />`;
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
                    html`<${Chip}
                        icon=${Icons.trash}
                        modifier="chip-delete"
                        title="Delete — removes this document from every list (its history is kept)"
                        onClick=${remove}
                    />`}
                    ${doc.diverged &&
                    (doc.resolution === 'conflict'
                        ? html`<${Chip} modifier="chip-diverged" title="edited in the same place on two computers; every version is shown below">conflict</${Chip}>`
                        : html`<${Chip} modifier="chip-merged" title="changes from two computers, woven together cleanly">merged</${Chip}>`)}
                    <${Chip}>${doc.format}</${Chip}>
                    <${Chip}>read-only</${Chip}>
                    <${Chip}
                        icon=${Icons.link}
                        on=${linkCopied}
                        title=${linkCopied
                            ? 'Copied!'
                            : isMedia
                            ? 'Copy the file’s address (paste it into a document as ![](…) to embed it)'
                            : 'Copy a link to this document (paste it into another document to crosslink)'}
                        onClick=${copyLink}
                    />
                    <${Chip}
                        icon=${Icons.tag}
                        on=${showMeta}
                        title="tags, date & description"
                        onClick=${() => setShowMeta((v) => !v)}
                    />
                    <${Chip}
                        icon=${Icons.pin}
                        modifier=${pinned ? 'chip-pinned' : null}
                        title=${pinned
                            ? 'Pinned — click to unpin it from the top of the list'
                            : 'Not pinned — click to pin it to the top of the list'}
                        onClick=${togglePin}
                    />
                    <${NavChips} nav=${nav} />
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
