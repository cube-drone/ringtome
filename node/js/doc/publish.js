// The publish door and its modal: shared by the feed composer, the post page, and Writer's
// publish chip (PUBLISH.md slice 3). Moved out of postentry.js on 2026-09-03 because the
// editor needs it and postentry imports the editor.
import { h } from 'preact';
import htm from 'htm';

import { api, xhrUpload } from '../net.js';
import { t } from '../i18n.js';
import { Icons } from '../icons.js';
import { rightsCheck } from '../rights.js';
import { publishRequest } from '../pure/audience.js';

const html = htm.bind(h);

/**
 * Publish, riding out the media bake: POST until the answer is a post id, reporting the
 * modal's item list along the way. The server's 202 means "media still preparing" - private
 * embeds bake inline (never seen here), external ones download and crush in the background,
 * and re-POSTing is the idempotent "how's it going?" (a failed item stays failed until the
 * next attempt re-arms it, so the author sees the tombstone before the retry).
 *
 * `onBaking(items | null)` drives the modal: items while preparing, null when done or failed
 * out. Resolves to the response with `post_id` (a group's door says `post`), or throws after a
 * failed bake round. `door`: where it posts - the public publish, or a group's (2026-10-18: a
 * group post's pictures from the web are saved as the author's own first, and the group's door
 * answers 202 while they are).
 */
export async function publishWithBaking(
    root,
    privDocId,
    onBaking,
    extraBody,
    door = `/api/identity/${root}/docs/${privDocId}/publish`,
) {
    // The sign (plans/AUDIO.md, section 8): a song that names its artist or album is asked about
    // first, every time - once, before the first round.
    const stopped = await rightsCheck(root, { docs: [privDocId] });
    if (stopped) throw new Error(stopped);
    for (;;) {
        // `extraBody` rides every round (a reply's `reply_to` - PROJECT_PLAN's Replies): the re-POST
        // is the idempotent "how's it going?", and the links must be there whichever
        // round finally lands the post.
        // The browser's timezone offset rides every publish (PUBLISH.md): the preferred date
        // is the author's LOCAL claim, and a bare day takes the publication's own hour.
        const resp = await api(door, {
            method: 'POST',
            body: JSON.stringify({
                tz_offset_min: new Date().getTimezoneOffset(),
                ...(extraBody || {}),
            }),
        });
        // A schedule is a terminal answer too (PUBLISH.md): nothing public yet, and nothing
        // to poll - the mirror row's plan is what the feed shows until the day.
        if (resp.scheduled_for) return resp;
        if (resp.post_id || resp.post) {
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
                failed === 1
                    ? "one media item couldn't be prepared"
                    : `${failed} media items couldn't be prepared`,
            );
        }
        await new Promise((r) => setTimeout(r, 900));
    }
}

/**
 * The one publish (plans/ONE_PUBLISH.md, slice 2): every surface's way out - Writer's bar, the
 * drawing's, the feed's composer, a reply box, a new room, a new IM - to whichever door `choice`
 * means (`pure/audience.js`'s `publishRequest`), so a choice means the same everywhere.
 *
 * `what` is the body, as the surface has it: `{ words: true }` for the draft's saved words, or
 * `{ picture }` for a drawing's flattened picture (a Blob). `choice` null publishes as the draft
 * stands. Words to the public or a group ride out the media bake (`onBaking`); every door's words are asked
 * the rights sign first. Resolves to the door's answer with `post_id` named alike for every door
 * (none when scheduled), and `group`, the group it went to, or null.
 */
export async function publishTo(
    root,
    docId,
    what,
    { choice = null, fields = null, settled, reply_to: replyTo, room, im, onBaking } = {},
) {
    const { group, body } = publishRequest(choice, fields, {
        settled,
        reply_to: replyTo,
        room,
        im,
    });
    const tz = new Date().getTimezoneOffset();
    const named = (made) => ({ ...made, post_id: made.post_id || made.post || null, group });
    if (what.picture) {
        // A drawing's door takes its wishes in the query; its body is the picture.
        const query = new URLSearchParams({ tz_offset_min: String(tz) });
        for (const [key, value] of Object.entries(body)) query.set(key, String(value));
        if (group) {
            query.set('doc', docId);
            return named(
                await xhrUpload(
                    `/api/identity/${root}/groups/${group}/publish/drawing?${query}`,
                    what.picture,
                ),
            );
        }
        return named(
            await xhrUpload(
                `/api/identity/${root}/docs/${docId}/publish/drawing?${query}`,
                what.picture,
            ),
        );
    }
    if (group) {
        return named(
            await publishWithBaking(
                root,
                docId,
                onBaking || (() => {}),
                { doc: docId, ...body },
                `/api/identity/${root}/groups/${group}/publish`,
            ),
        );
    }
    return named(await publishWithBaking(root, docId, onBaking || (() => {}), body));
}

/// The "preparing media for the network" modal: every media item a post embeds, with its bake
/// status - the upload progress view's shape, for potentially many files at once. A long publish
/// runs as a job on the node (publishing.rs, 2026-10-02) and answers with this same list as it
/// goes, so the bar fills a picture at a time; with every picture ready (or none to prepare) what
/// is left is the post itself.
export const BakeModal = ({ items }) => {
    if (!items) return null;
    const ready = items.filter((i) => i.status === 'ready').length;
    const minting = ready === items.length;
    return html`
        <div class="bake-modal-backdrop">
            <div class="bake-modal">
                <p class="bake-modal-head">
                    ${
                        /* With every item ready, what is left is the post itself - minted and folded, which
                        can take a moment: a spinner says it hasn't frozen (Curtis, 2026-10-02). */ ''
                    }
                    ${minting && html`<span class="status-spin"><${Icons.spinner} /></span> `}
                    ${
                        minting
                            ? t('postentry.publishing', 'publishing…')
                            : t(
                                  'postentry.preparing-media-for-the-network',
                                  'preparing media for the network…',
                              )
                    }
                </p>
                ${
                    items.length > 0 &&
                    html`<div class="upload-bar jag-line-2" title=${t('postentry.ready-of', '{ready} of {total} ready', { ready, total: items.length })}>
                    <div class="upload-bar-fill" style=${`width: ${Math.round((ready / items.length) * 100)}%`}></div>
                </div>`
                }
                ${items.map(
                    (i) => html`<div class="bake-item" key=${i.source}>
                        <span class="bake-item-kind">${i.kind === 'external' ? t('postentry.fetching', 'fetching') : t('postentry.yours', 'yours')}</span>
                        <span class="bake-item-source" title=${i.source}>
                            ${i.source.replace(/^https?:\/\//, '').slice(0, 48)}
                        </span>
                        <span
                            class=${
                                /* spelled out so the dead-CSS convention can see each */
                                i.status === 'failed'
                                    ? 'bake-item-status bake-item-failed'
                                    : i.status === 'ready'
                                      ? 'bake-item-status bake-item-ready'
                                      : 'bake-item-status bake-item-busy'
                            }
                        >
                            ${
                                i.status === 'ready'
                                    ? t('postentry.ready', 'ready')
                                    : i.status === t('postentry.failed', 'failed')
                                      ? i.error || t('postentry.failed-2', 'failed')
                                      : i.progress != null
                                        ? `processing ${i.progress}%`
                                        : i.status
                            }
                        </span>
                    </div>`,
                )}
            </div>
        </div>
    `;
};
