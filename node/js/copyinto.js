// Copy into private notes (Curtis, 2026-09-08): any post - yours, anyone's, public, or one
// of your own private notes - becomes a fresh private note in a bucket you pick, or a new
// one. The node does the copying (`POST .../docs/copy`): title, words, format, the
// author's own tags, and the copy chain's provenance; this is the door. One modal for
// every surface - the card's copy button, the editor's and the reader's chips. A copy filed
// in "feed" opens the feed itself (Curtis, 2026-09-08): the feed's drafts have no page of
// their own.
import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { t } from './i18n.js';
import { Icons } from './icons.js';
import { Modal } from './modal.js';
import { openMirror, useLive } from './mirror.js';
import { slugify } from './pure/naming.js';

const html = htm.bind(h);

/// The modal: the bucket list, "+ new bucket", and the outcome. `source` is
/// `{ author, doc_id, private }`; `onDone(doc_id, bucket)` after a copy lands.
export const CopyIntoModal = ({ current, source, onClose, onDone }) => {
    const root = current.root;
    const roster = useLive(() => openMirror(root).buckets.toArray(), [root]);
    const [fresh, setFresh] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [done, setDone] = useState(null); // { doc_id, bucket }
    const names = [...new Set((roster || []).map((b) => b.name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    // A book copies whole into a FRESH notebook (Curtis, 2026-09-08): no existing bucket
    // is offered, only a name for the new one.
    const book = source.format === 'book';
    const copy = async (bucket, isNew) => {
        const name = (bucket || '').trim();
        if (!name || busy) return;
        setBusy(true);
        setError(null);
        try {
            const r = await api(`/api/identity/${root}/docs/copy`, {
                method: 'POST',
                body: JSON.stringify({ author: source.author, doc_id: source.doc_id, bucket: name, new: !!isNew, private: !!source.private }),
            });
            setDone({ doc_id: r.doc_id, bucket: name });
            if (onDone) onDone(r.doc_id, name);
        } catch (e) {
            setError(e.message || String(e));
        }
        setBusy(false);
    };
    return html`<${Modal} title=${t('copyinto.copy-into-private-notes', 'copy into private notes')} onClose=${onClose}>
        ${done
            ? html`<p class="copy-done">
                  ${t('copyinto.copied-into', 'copied into {bucket}', { bucket: done.bucket })}
                  ${' '}<a href=${book ? `/home/${slugify(done.bucket)}` : slugify(done.bucket) === 'feed' ? '/home/feed' : `/home/${slugify(done.bucket)}/${done.doc_id}`}>${t('copyinto.open-the-copy', 'open the copy')}</a>
              </p>`
            : html`<div class="copy-buckets">
                  ${book && html`<p class="null-sub">${t('copyinto.a-book-copies-whole-into', 'a book copies whole into a fresh notebook')}</p>`}
                  ${!book &&
                  names.map(
                      (name) => html`<button key=${name} class="copy-bucket" disabled=${busy} onClick=${() => copy(name, false)}>
                          ${name}
                      </button>`
                  )}
                  <form
                      class="copy-new-bucket"
                      onSubmit=${(e) => {
                          e.preventDefault();
                          copy(fresh, book || !names.includes(fresh.trim()));
                      }}
                  >
                      <input
                          class="copy-new-input"
                          value=${fresh}
                          placeholder=${t('copyinto.plus-new-bucket', '+ new bucket')}
                          onInput=${(e) => setFresh(e.currentTarget.value)}
                      />
                      <button class="copy-bucket" disabled=${busy || !fresh.trim()}>${t('copyinto.copy', 'copy')}</button>
                  </form>
                  ${error && html`<p class="form-error">${error}</p>`}
              </div>`}
    <//>`;
};

/// The card's button: the copy icon, opening the modal for this post.
export const CopyButton = ({ item, current }) => {
    const [open, setOpen] = useState(false);
    return html`<button
            class="feed-copy"
            title=${t('copyinto.copy-this-into-your-private', 'copy this into your private notes')}
            onClick=${() => setOpen(true)}
        ><${Icons.copy} /></button>
        ${open &&
        html`<${CopyIntoModal}
            current=${current}
            source=${{ author: item.author, doc_id: item.doc_id, private: !!item.private_doc, format: item.format }}
            onClose=${() => setOpen(false)}
        />`}`;
};
