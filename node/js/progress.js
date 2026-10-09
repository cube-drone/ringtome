// How far a long job has got (2026-10-09: an export of a large account, an ePub of a long book): a
// bar, the share done, and how many of how many. A job that doesn't know its total yet says what
// it is doing instead.
import { h } from 'preact';
import htm from 'htm';

import { t } from './i18n.js';

const html = htm.bind(h);

/// `done` of `total` steps; `doing`, the words while `total` is unknown.
export const Progress = ({ done, total, doing }) => {
    if (!total) return html`<p class="null-sub">${doing}</p>`;
    const share = Math.max(0, Math.min(1, (done || 0) / total));
    const percent = Math.floor(share * 100);
    return html`<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax=${total} aria-valuenow=${done || 0}>
        <div class="progress-track"><div class="progress-fill" style=${`width: ${share * 100}%`}></div></div>
        <span class="progress-words">${t('progress.share', '{percent}% - {done} of {total}', {
            percent,
            done: Number(done || 0).toLocaleString(),
            total: Number(total).toLocaleString(),
        })}</span>
    </div>`;
};
