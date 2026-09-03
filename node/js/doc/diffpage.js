// The diff page (PUBLISH.md slice 3; Curtis, 2026-09-03: "diff is complicated enough that
// it probably deserves its own UI page entirely"): the private words of a published
// document against its public version, a line at a time, with the one act that resolves
// the difference - making the changes public - and the way back to the note.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { api, apiText } from '../net.js';
import { openMirror, useLive } from '../mirror.js';
import { Icons } from '../icons.js';
import { t } from '../i18n.js';
import { publishedState } from '../pure/feed.js';
import { lineDiff, sameWords } from '../pure/wordsdiff.js';
import { publishWithBaking, BakeModal } from './publish.js';

const html = htm.bind(h);

export const DiffPage = ({ app, doc, current }) => {
    const loc = useLocation();
    const root = current && current.root;
    const row = useLive(() => (root ? openMirror(root).docs.get(doc) : null), [root, doc]);
    const postId = row ? publishedState(row).postId : '';
    const [words, setWords] = useState(null); // { privateTitle, privateBody, publicTitle, publicBody }
    const [error, setError] = useState(null);
    const [publishing, setPublishing] = useState(false);
    const [baking, setBaking] = useState(null);
    const [note, setNote] = useState(null);
    const back = () => loc.route(`/home/${app}/${doc}`);
    useEffect(() => {
        if (!root || !doc || !postId) return undefined;
        let live = true;
        Promise.all([
            api(`/api/identity/${root}/docs/${doc}`),
            api(`/api/id/${root}/posts/${postId}`).catch(() => null),
            apiText(`/id/${root}/docs/${postId}/body`).catch(() => null),
        ])
            .then(([priv, head, publicBody]) => {
                if (!live) return;
                const shown = (priv.heads || []).find((h) => typeof h.body === 'string') || (priv.heads || [])[0] || {};
                setWords({
                    privateTitle: priv.title || shown.title || '',
                    privateBody: shown.body || '',
                    publicTitle: head ? head.title : null,
                    publicBody,
                });
            })
            .catch((e) => live && setError(e.message));
        return () => {
            live = false;
        };
    }, [root, doc, postId, note]);
    const update = async () => {
        setPublishing(true);
        setError(null);
        try {
            await publishWithBaking(root, doc, setBaking);
            setNote(t('doc.diffpage.your-changes-are-public', 'your changes are public'));
        } catch (e) {
            setError(e.message);
        } finally {
            setPublishing(false);
        }
    };
    if (!row) return html`<p class="null-sub">…</p>`;
    if (!postId) {
        return html`<section class="diff-page">
            <p>${t('doc.diffpage.this-document-has-no-public', 'this document has no public version to compare against')}</p>
            <button class="publish-bar-view" onClick=${back}>${t('doc.diffpage.back-to-the-note', 'back to the note')}</button>
        </section>`;
    }
    if (!words) return html`<p class="null-sub">…</p>`;
    const same =
        words.publicBody !== null &&
        sameWords(words.privateBody, words.publicBody) &&
        (words.publicTitle === null || words.publicTitle === words.privateTitle);
    const lines = lineDiff(words.publicBody || '', words.privateBody || '');
    return html`<section class="diff-page">
        <header class="diff-page-head">
            <h2 class="diff-page-title">${row.title || t('doc.diffpage.untitled', 'untitled')}</h2>
            <p class="diff-page-sub">
                ${t('doc.diffpage.the-private-words-against-the', 'the private words against the public version - what an update would change')}
            </p>
            <span class="diff-page-acts">
                <button class="publish-bar-view" onClick=${back}><${Icons.back} /> ${t('doc.diffpage.back-to-the-note', 'back to the note')}</button>
                <a class="publish-bar-view" href=${`/id/${root}/post/${postId}`}><${Icons.docPublic} /> ${t('doc.diffpage.view-public', 'view public')}</a>
                ${!same &&
                html`<button class="publish-bar-update" disabled=${publishing} onClick=${update}>
                    <${Icons.update} /> ${publishing ? t('doc.diffpage.publishing', 'publishing…') : t('doc.diffpage.make-your-changes-public', 'make your changes public')}
                </button>`}
            </span>
            ${note && html`<p class="diff-page-note">${note}</p>`}
            ${error && html`<p class="form-error">${error}</p>`}
        </header>
        ${same
            ? html`<p class="diff-page-same">${t('doc.diffpage.the-public-version-says-exactly', 'the public version says exactly this - nothing to update')}</p>`
            : html`${words.publicTitle !== null &&
                  words.publicTitle !== words.privateTitle &&
                  html`<p class="words-diff-title">
                      <span class="words-diff-del">${words.publicTitle}</span>
                      <span class="words-diff-add">${words.privateTitle}</span>
                  </p>`}
                  <p class="diff-page-legend">
                      <span class="words-diff-del">${t('doc.diffpage.public-only', 'public only')}</span>
                      <span class="words-diff-add">${t('doc.diffpage.private-only', 'private only')}</span>
                  </p>
                  <pre class="words-diff">${lines.map(
                      (l, i) => html`<span
                          key=${i}
                          class=${l.kind === '-' ? 'words-diff-del' : l.kind === '+' ? 'words-diff-add' : 'words-diff-same'}
                      >${l.kind} ${l.text}\n</span>`
                  )}</pre>`}
        <${BakeModal} items=${baking} />
    </section>`;
};
