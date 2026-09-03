// The publish door and its modal: shared by the feed composer, the post page, and Writer's
// publish chip (PUBLISH.md slice 3). Moved out of postentry.js on 2026-09-03 because the
// editor needs it and postentry imports the editor.
import { h } from 'preact';
import htm from 'htm';

import { api } from '../net.js';
import { t } from '../i18n.js';

const html = htm.bind(h);

/**
 * Publish, riding out the media bake: POST until the answer is a post id, reporting the
 * modal's item list along the way. The server's 202 means "media still preparing" - private
 * embeds bake inline (never seen here), external ones download and crush in the background,
 * and re-POSTing is the idempotent "how's it going?" (a failed item stays failed until the
 * next attempt re-arms it, so the author sees the tombstone before the retry).
 *
 * `onBaking(items | null)` drives the modal: items while preparing, null when done or failed
 * out. Resolves to the response with `post_id`, or throws after a failed bake round.
 */
export async function publishWithBaking(root, privDocId, onBaking, extraBody) {
    for (;;) {
        // `extraBody` rides every round (a reply's `reply_to` - PROJECT_PLAN's Replies): the re-POST
        // is the idempotent "how's it going?", and the links must be there whichever
        // round finally lands the post.
        // The browser's timezone offset rides every publish (PUBLISH.md): the preferred date
        // is the author's LOCAL claim, and a bare day takes the publication's own hour.
        const resp = await api(`/api/identity/${root}/docs/${privDocId}/publish`, {
            method: 'POST',
            body: JSON.stringify({ tz_offset_min: new Date().getTimezoneOffset(), ...(extraBody || {}) }),
        });
        // A schedule is a terminal answer too (PUBLISH.md): nothing public yet, and nothing
        // to poll - the mirror row's plan is what the feed shows until the day.
        if (resp.scheduled_for) return resp;
        if (resp.post_id) {
            onBaking(null);
            return resp;
        }
        const items = resp.baking || [];
        onBaking(items);
        if (items.some((i) => i.status === 'failed')) {
            // The modal has shown the tombstones; the author edits or re-Posts to retry.
            const failed = items.filter((i) => i.status === 'failed').length;
            onBaking(null);
            throw new Error(
                failed === 1 ? "one media item couldn't be prepared" : `${failed} media items couldn't be prepared`
            );
        }
        await new Promise((r) => setTimeout(r, 900));
    }
}

/// The "preparing media for the network" modal: every media item a post embeds, with its bake
/// status - the upload progress view's shape, for potentially many files at once.
export const BakeModal = ({ items }) => {
    if (!items) return null;
    return html`
        <div class="bake-modal-backdrop">
            <div class="bake-modal">
                <p class="bake-modal-head">${t('postentry.preparing-media-for-the-network', 'preparing media for the network…')}</p>
                ${items.map(
                    (i) => html`<div class="bake-item" key=${i.source}>
                        <span class="bake-item-kind">${i.kind === 'external' ? t('postentry.fetching', 'fetching') : t('postentry.yours', 'yours')}</span>
                        <span class="bake-item-source" title=${i.source}>
                            ${i.source.replace(/^https?:\/\//, '').slice(0, 48)}
                        </span>
                        <span
                            class=${/* spelled out so the dead-CSS convention can see each */
                            i.status === 'failed'
                                ? 'bake-item-status bake-item-failed'
                                : i.status === 'ready'
                                  ? 'bake-item-status bake-item-ready'
                                  : 'bake-item-status bake-item-busy'}
                        >
                            ${i.status === 'ready'
                                ? t('postentry.ready', 'ready')
                                : i.status === t('postentry.failed', 'failed')
                                  ? i.error || t('postentry.failed-2', 'failed')
                                  : i.progress != null
                                    ? `processing ${i.progress}%`
                                    : i.status}
                        </span>
                    </div>`
                )}
            </div>
        </div>
    `;
};
