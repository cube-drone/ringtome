// One post, anywhere a post is shown - and editable wherever it turns out to be yours.
//
// The feed's stream and the persona page's post list rendered two different cards until
// 2026-08-06, which is how the edit affordance vanished: it lived on the card the feed rework
// retired, and the "editing is the persona page's business now" comment pointed at a page with
// no editor. One component ends that class of loss: PostEntry is the card BOTH surfaces render
// (the banner riding on every one - redundant on a persona's own page, and accepted), and the
// editing machinery is a hook either surface can wear.
//
// Editing a published post crosses the membrane deliberately: a feed item names the PUBLIC
// document, but editing means opening the PRIVATE note it was minted from. The `published_as`
// annotation is the thread between them (pure/feed.js publishedState), so `useOwnPostEditing`
// resolves public doc -> your private twin off your own mirror, and the unlock ceremony (the
// Journal's fifteen-second lock, same CSS, same promise) guards the door exactly as it did
// when the affordance lived on the old stack card.
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';

import { api, apiText } from './net.js';
import { openMirror, useLive } from './mirror.js';
import { usePrefMap, setPref, sealKey, SEAL_PREFIX } from './mirror/prefs.js';
import { Icons } from './icons.js';
import { speakable } from './speakable.js';
import {
    FEED_STYLE,
    publishedState,
    emphasisOf,
    leadOf,
    postScale,
    postImageCap,
    POST_IMAGE_MAX,
} from './pure/feed.js';
import { appById, featuresOf } from './pure/apps.js';
import { Editor } from './doc/editor.js';
import { useDocDetail } from './doc/detail.js';
import { MarqueeBody, bareSource } from './doc/marqueebody.js';
import { useTurbolinks } from './doc/turbolinks.js';
import { PersonBanner, PersonChip } from './person.js';
import { useShared, markShared } from './shares.js';
import { t } from './i18n.js';

const html = htm.bind(h);

export const StatusDot = ({ status }) =>
    html`<span class=${`status-dot status-${status}`} title=${status}></span>`;

// The unlock: a click starts a fifteen-second fill, and the item opens when it completes.
// Journal's gesture exactly (shared CSS) - the same promise, for the same reason.
export const LockButton = ({ onUnlocked }) => {
    const [unlocking, setUnlocking] = useState(false);
    return html`
        <button
            class=${unlocking ? 'journal-lock unlocking' : 'journal-lock'}
            title=${t('postentry.posted---click-then-wait', 'Posted - click, then wait 15 seconds, to edit this again')}
            onClick=${() => setUnlocking(true)}
            disabled=${unlocking}
        >
            <span class="journal-lock-face"><${Icons.lock} /></span>
            ${unlocking &&
            html`<span class="journal-unlock-bar" onAnimationEnd=${onUnlocked}></span>`}
        </button>
    `;
};

// The composer: the REAL notes editor, wearing Feed's clothes (Curtis's ruling, 2026-08-06:
// both point at a private document, so the features come over whole rather than being
// reimplemented). The registry's feature block does the tailoring - Feed already declares
// `date: false` (a post happens NOW; nobody claims a date for one) and `pin: false` - and
// everything else arrives free: the format-convert chip, the upload chip with drop-and-paste
// inline, tags and description, view modes, the delete chip (which, on the open draft, just
// clears it - the one-draft rule mints a fresh page the moment the old one dies).
//
// The Post button rides the editor's `foot` render-prop: the editor owns the session, the
// foot flushes the save and carries the confirmed words out (never refetched - the buffer in
// hand IS what the server acknowledged).
export const Composer = ({ root, docId, published, onPost, posting, onDeleted }) => {
    const feedApp = appById('feed');
    return html`
        <div class="feed-composer">
            <${Editor}
                root=${root}
                docId=${docId}
                features=${featuresOf(feedApp)}
                bucket=${FEED_STYLE}
                onDeleted=${onDeleted}
                foot=${({ save, status, body, title }) => {
                    const empty = !body.trim() && !title.trim();
                    return html`<div class="feed-composer-foot">
                        <${StatusDot} status=${status} />
                        <span class="feed-note">
                            ${t('postentry.posting-is-public---anyone', 'posting is public - anyone with your address can read it')}
                        </span>
                        <button
                            class="feed-post"
                            disabled=${posting || empty}
                            title=${empty ? t('postentry.write-something-first', 'write something first') : t('postentry.publish-these-words', 'publish these words')}
                            onClick=${async () => {
                                await save(); // the post publishes what is SAVED, so flush first
                                // The words ride along: whoever clicked already HAS them, and
                                // showing a user their own edit must never require asking the
                                // server for what they just typed.
                                onPost({ title, body });
                            }}
                        >${posting ? t('postentry.posting', 'posting…') : published ? t('postentry.post-the-changes', 'post the changes') : t('postentry.post', 'post')}</button>
                    </div>`;
                }}
            />
        </div>
    `;
};

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
export async function publishWithBaking(root, privDocId, onBaking) {
    for (;;) {
        const resp = await api(`/api/identity/${root}/docs/${privDocId}/publish`, {
            method: 'POST',
        });
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

/**
 * The editing wiring for posts that are YOURS, resolved off your own mirror. Returns
 * `editingFor(publicDocId)` - the props PostEntry's edit affordance needs, or null when the
 * post isn't yours (or you aren't signed in, or the mirror hasn't answered yet).
 *
 * `decorate` lets a caller overlay local knowledge on the mirror rows before the
 * published_as lookup - the feed uses it for publications the stream hasn't echoed yet.
 */
export function useOwnPostEditing(current, decorate = (row) => row) {
    const myRoot = current && current.root;
    const rows = useLive(() => (myRoot ? openMirror(myRoot).docs.toArray() : []), [myRoot]);
    const seals = usePrefMap(myRoot, SEAL_PREFIX) || new Map();
    const [posting, setPosting] = useState(false);
    // The bake modal's items while an edit's media prepares; null when quiet.
    const [baking, setBaking] = useState(null);

    const post = async (privDocId) => {
        setPosting(true);
        try {
            await publishWithBaking(myRoot, privDocId, setBaking);
            // Said again in public: seal it again, so the next edit costs the unlock again.
            setPref(myRoot, sealKey(privDocId), 'locked');
        } finally {
            setPosting(false);
        }
    };

    const editingFor = (publicDocId) => {
        if (!myRoot || !rows) return null;
        const row = rows
            .map(decorate)
            .find((r) => publishedState(r).postId === publicDocId);
        if (!row) return null;
        const seal = seals.get(sealKey(row.doc_id));
        return {
            root: myRoot,
            row,
            locked: publishedState(row, seal).locked,
            unseal: () => setPref(myRoot, sealKey(row.doc_id), 'open'),
            post: () => post(row.doc_id),
            posting,
            baking,
        };
    };
    return editingFor;
}

/**
 * One post, as the feed and the persona page both show it: banner, date, the words (cut to
 * their lead by the reader's interest) - and, when `editing` is present, the
 * unlock-then-edit-in-place ceremony.
 *
 * `item`: { author, doc_id (PUBLIC), title, format, published_ms, mine,
 *           author_name?, author_avatar? }
 */
/// "Take it down": recall a post you published.
///
/// **Its own gesture, on the PUBLIC document** (2026-08-11). Deleting the note this was minted
/// from is housekeeping in your own drawer and leaves the post standing; this is the act that
/// changes what other people can see. Sitting behind the same unlock as editing, because both
/// change something already said and both should take a breath.
///
/// Says what it costs before it does it: a retraction travels to followers' feeds and to anyone
/// holding a shared copy, but it cannot reach a node that never comes back online, and it cannot
/// unsee. Promising erasure would be a lie the protocol cannot keep.
const UnpublishButton = ({ item, current }) => {
    const [asking, setAsking] = useState(false);
    const [going, setGoing] = useState(false);

    if (!asking) {
        return html`<button
            class="feed-unpublish"
            title=${t('postentry.take-this-post-back-off', 'take this post back off the network')}
            onClick=${() => setAsking(true)}
        >${t('postentry.take-it-down', 'take it down')}</button>`;
    }
    return html`<span class="feed-unpublish-ask">
        <span class="feed-unpublish-warn"
            >${t(
                'postentry.this-removes-it-from-other',
                'removes it from other people\'s feeds and shares. Copies on computers that never come back cannot hear it.'
            )}</span
        >
        <button
            class="feed-unpublish-go"
            disabled=${going}
            onClick=${async () => {
                setGoing(true);
                try {
                    await api(`/api/identity/${current.root}/posts/${item.doc_id}`, {
                        method: 'DELETE',
                    });
                    // The row goes on the next feed read; nothing is faked here.
                } catch {
                    setGoing(false);
                    setAsking(false);
                }
            }}
        >${going ? t('postentry.taking-it-down', 'taking it down…') : t('postentry.yes-take-it-down', 'yes, take it down')}</button>
        <button class="feed-unpublish-no" onClick=${() => setAsking(false)}
            >${t('postentry.keep-it', 'keep it')}</button
        >
    </span>`;
};

/// "Pass this along": one click to rebroadcast a post into your own network.
///
/// Deliberately NOT a counter, and deliberately not showing how many others shared it. A share
/// here is a routing act - it puts a post in front of the people who follow you for your
/// recommendations - and a visible tally is the engagement machinery the Vision indicts. What it
/// shows is whether YOU have shared it, which is the only fact the button needs to carry.
///
/// The version is resolved server-side rather than sent: this node knows what head it served
/// the reader, and a hash carried from an earlier page load would endorse something staler than
/// what was on screen.
const ShareButton = ({ item, current }) => {
    const [sending, setSending] = useState(false);
    // `null` while we do not yet know - the list is one fetch per page, and a button that
    // guessed "share" and then flipped to "shared" is how a reader learns not to trust it.
    const known = useShared(current.root, item.author, item.doc_id);
    const shared = known === true;

    const pass = async () => {
        if (sending || known === null) return;
        setSending(true);
        const next = !shared;
        try {
            await api(`/api/identity/${current.root}/rebroadcasts`, {
                method: 'POST',
                body: JSON.stringify({
                    author: item.author,
                    doc_id: item.doc_id,
                    ...(next ? {} : { retract: true }),
                }),
            });
            // Only after the write lands. The chain either took it or it did not, and saying
            // "shared" on a failure is the one lie a share button must never tell.
            markShared(current.root, item.author, item.doc_id, next);
        } catch {
            // Left as it was. The next page load reads the chain and settles it.
        } finally {
            setSending(false);
        }
    };

    return html`<button
        class=${shared ? 'feed-share feed-share-on' : 'feed-share'}
        disabled=${sending || known === null}
        title=${shared
            ? t('postentry.stop-sharing-this-with-your', 'stop sharing this with your network')
            : t('postentry.pass-this-along-to-your', 'pass this along to your network')}
        onClick=${pass}
    >
        <${Icons.colRebroadcast} />
        ${shared ? t('postentry.shared', 'shared') : t('postentry.share', 'share')}
    </button>`;
};

export const PostEntry = ({ item, current, interest, editing }) => {
    const [body, setBody] = useState(undefined);
    const [wholeThing, setWholeThing] = useState(false);
    const [open, setOpen] = useState(false);
    // The words as this reader last CONFIRMED them: after an in-place edit, the session's
    // own buffer - already in hand, already acknowledged by the publish - never a refetch of
    // what the user just typed.
    const [amended, setAmended] = useState(null);
    const itemRef = useRef(null);

    useEffect(() => {
        let live = true;
        apiText(`/id/${item.author}/docs/${item.doc_id}/body`)
            .then((t) => live && setBody(t))
            .catch(() => live && setBody(null));
        return () => {
            live = false;
        };
    }, [item.author, item.doc_id]);

    // (A feed post used to mark itself SEEN here, via an IntersectionObserver that fired on
    // scroll. Removed 2026-08-09 with the whole read-state feature - PROJECT_PLAN, One Cursor.
    // Two reasons worth keeping: passive scrolling was writing one signed, encrypted,
    // fsynced private-chain entry per post that crossed the viewport, which made reading the
    // highest write-rate act in the application; and an unread dot is a debt the app invents
    // for you, which is the engagement machinery the Vision indicts. Automatic observation is
    // ruled out for good - the bell's watermark moves only when a human presses a button.)

    const emphasis = item.mine ? 'normal' : emphasisOf(interest);
    // The card's size rides one custom property; persona.css sizes the entry's every metric in
    // `em` off it, so this scales the WHOLE post - padding, title, date, dot - not just the words.
    const scale = item.mine ? 1 : postScale(interest);
    // Images get their own dial, in px rather than em, so the two ramps do not compound: a
    // low-interest card is both smaller AND holds a smaller picture, by separate amounts.
    const imageCap = item.mine ? null : postImageCap(interest);
    // Spelled out rather than interpolated, so the dead-CSS convention can see each class.
    const entryClass =
        emphasis === 'low'
            ? 'feed-entry feed-entry-low'
            : emphasis === 'high'
              ? 'feed-entry feed-entry-high'
              : 'feed-entry';

    const when = new Date(item.published_ms).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
    // The item's link: the title when there is one, a quiet line at the foot when not. It
    // goes to the author's page for now - which fresh-syncs them on arrival, most of what the
    // eventual per-item page owes - and the item page will take this href over when it exists.
    const href = `/id/${speakable(item.author)}`;
    // The words as shown: after an in-place edit, the buffer the user just confirmed - not a
    // refetch of what they typed. The item prop's copies are snapshots; a page refresh
    // reconciles everything against the canonical fold anyway.
    const shownBody = amended ? amended.body : body;
    const title = amended ? amended.title : item.title;
    const tlProfile = useTurbolinks(shownBody || '', item.format);
    const { lead, cut } = leadOf(shownBody || '', emphasis);
    const shown = wholeThing ? shownBody : lead;

    return html`
        <article
            class=${entryClass}
            ref=${itemRef}
            style=${[
                scale === 1 ? '' : `--post-scale: ${scale}`,
                imageCap === null || imageCap >= POST_IMAGE_MAX ? '' : `--post-image-cap: ${imageCap}px`,
            ]
                .filter(Boolean)
                .join('; ') || undefined}
        >
            ${editing && html`<${BakeModal} items=${editing.baking} />`}
            ${/* Who passed this along, when it arrived by rebroadcast. ABOVE the banner and
                quieter than it, because the card is still the AUTHOR speaking - a share is how
                it reached you, not whose words these are. Getting that hierarchy backwards is
                how a quote-tweet reads as the quoter's post. */ ''}
            ${!!item.via &&
            html`<p class="feed-entry-via">
                <${Icons.colRebroadcast} />
                <${PersonChip}
                    root=${item.via}
                    current=${current}
                    size="mini"
                    profile=${{
                        fields: [
                            item.via_name && { field: 'name', value: item.via_name },
                            item.via_avatar && { field: 'avatar', value: item.via_avatar },
                        ].filter(Boolean),
                        via: [],
                    }}
                />
                ${t('postentry.passed-this-along', 'passed this along')}
            </p>`}
            ${/* The banner, not the chip (2026-08-06): a feed item is a person speaking, and
                the face-plus-names row says who at a glance where the mini hexagon made you
                hover. The when and - for your own posts - the unlock ride its actions slot. */ ''}
            <${PersonBanner}
                root=${item.author}
                current=${current}
                profile=${{
                    fields: [
                        item.author_name && { field: 'name', value: item.author_name },
                        item.author_avatar && { field: 'avatar', value: item.author_avatar },
                    ].filter(Boolean),
                    via: [],
                }}
                actions=${html`<span class="feed-entry-when">${when}</span>
                    ${!item.mine && !!current && html`<${ShareButton} item=${item} current=${current} />`}
                    ${editing &&
                    !open &&
                    (editing.locked
                        ? html`<${LockButton}
                              onUnlocked=${() => {
                                  editing.unseal();
                                  setOpen(true);
                              }}
                          />`
                        : html`<button
                              class="feed-edit"
                              title=${t('postentry.open-this-for-editing', 'open this for editing')}
                              onClick=${() => setOpen(true)}
                          >${t('postentry.edit', 'edit')}</button>`)}
                    ${editing && !editing.locked && !open && html`<${UnpublishButton} item=${item} current=${current} />`}`}
            />
            ${!open &&
            !!title &&
            html`<h2 class="feed-entry-title"><a href=${href}>${title}</a></h2>`}
            ${open
                ? html`<${Composer}
                      root=${editing.root}
                      docId=${editing.row.doc_id}
                      published=${true}
                      onPost=${async (words) => {
                          // The publish's 200 IS the confirmation; on failure the editor
                          // stays open with the buffer intact, and nothing pretends.
                          try {
                              await editing.post();
                          } catch {
                              return;
                          }
                          setAmended(words);
                          setOpen(false);
                      }}
                      posting=${editing.posting}
                  />`
                : html`${shownBody === undefined && html`<p class="null-sub">…</p>`}
                      ${shownBody === null &&
                      html`<p class="null-sub">
                          <span class="waiting-dot"></span> ${t('postentry.these-words-havent-reached-this', "these words haven't reached this computer.")}
                      </p>`}
                      ${!!shownBody &&
                      html`<div class="feed-entry-body">
                          ${item.format === 'marquee'
                              ? html`<${MarqueeBody}
                                    source=${shown}
                                    profile=${tlProfile}
                                    onUnparsable=${bareSource}
                                />`
                              : html`<pre class="reader-plain">${shown}</pre>`}
                          ${cut &&
                          !wholeThing &&
                          html`<button class="feed-entry-more" onClick=${() => setWholeThing(true)}>
                              ${t('postentry.the-whole-thing', 'the whole thing')}
                          </button>`}
                      </div>`}`}
            ${!open &&
            !title &&
            html`<p class="feed-entry-foot">
                <a href=${href}>${t('postentry.from', 'from')} ${item.author_name || t('postentry.someone', 'someone')}${t('postentry.s-page', "'s page")}</a>
            </p>`}
        </article>
    `;
};

// Re-exported for the drafts column's card, which stayed in the feed app.
export { useDocDetail };
