// The Publish column (BOOKS.md slice 1): a notebook published as a book. One column beside
// tags, items, and tree - the switch, the hidden marks, the ledger against the last
// rollout, and the button. This slice is the private bookkeeping and the surface; the
// rollout itself (slice 2) is what the button will do.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from '../net.js';
import { openMirror, useLive } from '../mirror.js';
import { Icons } from '../icons.js';
import { PaneHead } from '../panes.js';
import { t } from '../i18n.js';
import { rootTitleFor } from '../pure/naming.js';
import { BOOKS_KV, HIDDEN_KV, bookModes, isBookBucket, hiddenSetOf, hiddenDocsOf, bookLedger } from '../pure/books.js';

const html = htm.bind(h);

/// The book facts for a persona: the switch per bucket and the hidden marks, off the
/// private kv, with the writes that move them. Not a live query - the kv has no mirror -
/// so every write re-reads.
export function useBookFacts(root) {
    const [modes, setModes] = useState({});
    const [hidden, setHidden] = useState(new Set());
    const [gen, setGen] = useState(0);
    useEffect(() => {
        if (!root) return undefined;
        let live = true;
        Promise.all([
            api(`/api/identity/${root}/private/kv/${BOOKS_KV}`).catch(() => ({ values: [] })),
            api(`/api/identity/${root}/private/kv/${HIDDEN_KV}`).catch(() => ({ values: [] })),
        ]).then(([b, h]) => {
            if (!live) return;
            setModes(bookModes(b && b.values));
            setHidden(hiddenSetOf(h && h.values));
        });
        return () => {
            live = false;
        };
    }, [root, gen]);
    const setBook = async (bucket, on) => {
        await api(`/api/identity/${root}/private/kv/${BOOKS_KV}/${encodeURIComponent(bucket)}`, {
            method: 'PUT',
            body: JSON.stringify({ value: on ? JSON.stringify({ mode: 'book' }) : '' }),
        });
        setGen((g) => g + 1);
    };
    const mark = async (key, on) => {
        await api(`/api/identity/${root}/private/kv/${HIDDEN_KV}/${encodeURIComponent(key)}`, {
            method: 'PUT',
            body: JSON.stringify({ value: on ? 'yes' : '' }),
        });
        setGen((g) => g + 1);
    };
    return { modes, hidden, setBook, mark };
}

/// The bucket's expanded tree off the node (sections carry the hidden marks; the tree is
/// what says which pages sit beneath a hidden section). Null while loading or when the
/// bucket has no tree yet.
export function useBookTree(root, bucket, reloadKey) {
    const taxRows = useLive(() => (root ? openMirror(root).taxonomies.toArray() : []), [root]);
    const rootRow = (taxRows || [])
        .filter((tx) => tx.title === rootTitleFor(bucket))
        .sort((a, b) => (a.taxonomy_id < b.taxonomy_id ? -1 : 1))[0];
    const rootId = rootRow && rootRow.taxonomy_id;
    const fingerprint = (taxRows || []).map((tx) => `${tx.taxonomy_id}:${tx.members}:${tx.title}`).join('|');
    const [tree, setTree] = useState(null);
    useEffect(() => {
        if (!rootId) {
            setTree(null);
            return undefined;
        }
        let live = true;
        api(`/api/identity/${root}/taxonomies/${rootId}`)
            .then((node) => live && setTree(node))
            .catch(() => live && setTree(null));
        return () => {
            live = false;
        };
    }, [root, rootId, fingerprint, reloadKey]);
    return tree;
}

/// Every section in the tree, depth-first, with its depth - for the hidden marks.
function sectionsOf(node, out = [], depth = 0, seen = new Set()) {
    if (!node || seen.has(node.taxonomy_id)) return out;
    seen.add(node.taxonomy_id);
    for (const m of node.members || []) {
        if (m.taxonomy && m.taxonomy.members) {
            out.push({ id: m.taxonomy.taxonomy_id, title: m.taxonomy.title, depth });
            sectionsOf(m.taxonomy, out, depth + 1, seen);
        }
    }
    return out;
}

export const BookColumn = ({ bucket, docs, facts, tree, onTuck, onSelect }) => {
    const { modes, hidden, setBook, mark } = facts;
    const on = isBookBucket(modes, bucket);
    const hiddenDocs = hiddenDocsOf(tree, hidden);
    const ledger = bookLedger(docs, hiddenDocs, hidden);
    const sections = sectionsOf(tree);
    const rowsOf = (list, cls) =>
        list.map(
            (r) => html`<button class=${`book-page ${cls}`} key=${r.doc_id} onClick=${() => onSelect && onSelect(r.doc_id)}>
                ${r.title || t('doc.bookcol.untitled', 'untitled')}
            </button>`
        );
    return html`<aside class="book-column">
        <${PaneHead} label=${t('doc.bookcol.publish', 'publish')} onTuck=${onTuck} />
        <label class="book-switch" title=${t('doc.bookcol.a-book-publishes-as-one', 'a book publishes as one thing: the whole notebook and its tree, and later its changes as one update at a time - never a page on its own')}>
            <input type="checkbox" checked=${on} onChange=${(e) => setBook(bucket, e.currentTarget.checked)} />
            <${Icons.book} /> ${t('doc.bookcol.publish-this-entire-notebook', 'publish this entire notebook')}
        </label>
        ${on
            ? html`<p class="book-ledger-head">${t('doc.bookcol.since-the-last-rollout', 'since the last rollout')}</p>
                  <dl class="book-ledger">
                      <dt><${Icons.pageNew} /> ${t('doc.bookcol.new', 'new')}</dt>
                      <dd>${ledger.new.length}</dd>
                      <dt><${Icons.update} /> ${t('doc.bookcol.changed', 'changed')}</dt>
                      <dd>${ledger.changed.length}</dd>
                      <dt><${Icons.docPublic} /> ${t('doc.bookcol.current', 'current')}</dt>
                      <dd>${ledger.current.length}</dd>
                      <dt><${Icons.hidden} /> ${t('doc.bookcol.hidden', 'hidden')}</dt>
                      <dd>${ledger.hidden.length}</dd>
                  </dl>
                  ${(ledger.new.length > 0 || ledger.changed.length > 0) &&
                  html`<div class="book-pages">
                      ${rowsOf(ledger.new, 'book-page-new')}
                      ${rowsOf(ledger.changed, 'book-page-changed')}
                  </div>`}
                  ${sections.length > 0 &&
                  html`<p class="book-ledger-head">${t('doc.bookcol.sections', 'sections')}</p>
                      <div class="book-sections">
                          ${sections.map(
                              (s) => html`<label class="book-section" key=${s.id} style=${`padding-left: ${s.depth * 0.8}rem`}>
                                  <input
                                      type="checkbox"
                                      checked=${!hidden.has(`sec:${s.id}`)}
                                      title=${t('doc.bookcol.unticked-a-hidden-section', 'unticked: a hidden section - it and every page beneath it stay out of the book')}
                                      onChange=${(e) => mark(`sec:${s.id}`, !e.currentTarget.checked)}
                                  />
                                  ${s.title || t('doc.bookcol.untitled-section', '(untitled section)')}
                              </label>`
                          )}
                      </div>`}
                  <button
                      class="book-publish"
                      disabled=${true}
                      title=${t('doc.bookcol.the-rollout-lands-with-the', 'the rollout lands with the next slice - the bookkeeping here is what it will read')}
                  ><${Icons.docPublic} /> ${t('doc.bookcol.publish-the-book', 'publish the book')}</button>`
            : html`<p class="book-off">
                  ${t('doc.bookcol.this-notebook-publishes-page-by', 'this notebook publishes page by page; switched on, it publishes as one book - the tree and all - and afterwards its changes as updates')}
              </p>`}
    </aside>`;
};
