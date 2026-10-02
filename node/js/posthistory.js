// A post's history (Curtis, 2026-10-02): posts edit forever, an edited one says "edited {date}", and
// that mark opens here - every version the post has been, newest first, each with what it changed
// from the one before (the first, whole). The words come from the author's chain where this node
// holds it (`/api/id/{seg}/posts/{doc}/versions`); a version whose words this node no longer has
// says so - superseded words were reaped a day after a post's genesis until posts stopped freezing.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { parseSpeakable } from './speakable.js';
import { lineDiff } from './pure/wordsdiff.js';
import { postHref } from './links.js';
import { Icons } from './icons.js';
import { t } from './i18n.js';

const html = htm.bind(h);

/// One version's change from the one before it, as the diff page draws a change.
const Changes = ({ before, after }) => html`<pre class="words-diff">${lineDiff(before, after)
    .filter((l, i, all) => l.kind !== ' ' || all.length < 40)
    .map(
        (l, i) => html`<span
            key=${i}
            class=${l.kind === '-' ? 'words-diff-del' : l.kind === '+' ? 'words-diff-add' : 'words-diff-same'}
        >${l.kind} ${l.text}\n</span>`
    )}</pre>`;

export const PostHistory = ({ seg, doc }) => {
    const parsed = parseSpeakable(seg);
    const root = parsed && parsed.ok ? parsed.root : null;
    const [versions, setVersions] = useState(null);
    const [error, setError] = useState(null);
    useEffect(() => {
        let live = true;
        setVersions(null);
        setError(null);
        api(`/api/id/${seg}/posts/${doc}/versions`)
            .then((r) => live && setVersions(r.versions || []))
            .catch((e) => live && setError(e.message || String(e)));
        return () => {
            live = false;
        };
    }, [seg, doc]);

    const newest = versions && versions[0];
    return html`<section class="diff-page post-history">
        <header class="diff-page-head">
            <h2 class="diff-page-title">${(newest && newest.title) || t('posthistory.untitled', 'untitled')}</h2>
            <p class="diff-page-sub">${t('posthistory.every-version', 'every version of this post, newest first')}</p>
            ${root &&
            html`<span class="diff-page-acts">
                <a class="publish-bar-view jag-line" href=${postHref(root, doc)}><${Icons.back} /> ${t('posthistory.back-to-the-post', 'back to the post')}</a>
            </span>`}
        </header>
        ${error && html`<p class="form-error">${error}</p>`}
        ${!versions && !error && html`<p class="null-sub">${t('posthistory.looking', 'looking…')}</p>`}
        ${versions &&
        versions.map((v, i) => {
            const older = versions[i + 1];
            const when = new Date(v.at_ms).toLocaleString();
            return html`<article class="post-history-version" key=${v.version}>
                <h3 class="post-history-when">
                    ${i === 0 ? t('posthistory.now', 'now - {when}', { when }) : when}
                    ${!older && html` <span class="post-history-first">${t('posthistory.first-published', 'first published')}</span>`}
                </h3>
                ${older &&
                older.title !== v.title &&
                html`<p class="words-diff-title">
                    <span class="words-diff-del">${older.title}</span>
                    <span class="words-diff-add">${v.title}</span>
                </p>`}
                ${!v.held
                    ? html`<p class="null-sub">${t('posthistory.not-held', 'this computer no longer has these words')}</p>`
                    : older && older.held
                      ? html`<${Changes} before=${older.words} after=${v.words} />`
                      : html`<pre class="words-diff">${v.words}</pre>`}
            </article>`;
        })}
    </section>`;
};
