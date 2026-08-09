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
import { FEED_STYLE, publishedState, emphasisOf, leadOf } from './pure/feed.js';
import { appById, featuresOf } from './pure/apps.js';
import { Editor } from './doc/editor.js';
import { useDocDetail } from './doc/detail.js';
import { MarqueeBody, bareSource } from './doc/marqueebody.js';
import { useTurbolinks } from './doc/turbolinks.js';
import { PersonBanner } from './person.js';
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
 * their lead by the reader's interest), the unseen dot - and, when `editing` is present, the
 * unlock-then-edit-in-place ceremony.
 *
 * `item`: { author, doc_id (PUBLIC), title, format, published_ms, seen, mine,
 *           author_name?, author_avatar? }
 */
export const PostEntry = ({ item, current, interest, onSeen, editing }) => {
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

    // Seen, once, when actually looked at. jsdom has no IntersectionObserver; there the item
    // simply never auto-marks, which is the honest degradation (the probe marks by hand).
    useEffect(() => {
        if (item.seen || item.mine || !onSeen || typeof IntersectionObserver === 'undefined')
            return;
        const el = itemRef.current;
        if (!el) return;
        const io = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting)) {
                    io.disconnect();
                    onSeen(item);
                }
            },
            { threshold: 0.6 }
        );
        io.observe(el);
        return () => io.disconnect();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [item.seen, item.mine, item.author, item.doc_id]);

    const emphasis = item.mine ? 'normal' : emphasisOf(interest);
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
        <article class=${entryClass} ref=${itemRef}>
            ${editing && html`<${BakeModal} items=${editing.baking} />`}
            ${/* The banner, not the chip (2026-08-06): a feed item is a person speaking, and
                the face-plus-names row says who at a glance where the mini hexagon made you
                hover. The when, the unseen dot, and - for your own posts - the unlock ride
                its actions slot. */ ''}
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
                    ${!item.seen &&
                    html`<span class="feed-entry-new" title=${t('postentry.you-havent-seen-this-yet', "you haven't seen this yet")}></span>`}
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
                          >${t('postentry.edit', 'edit')}</button>`)}`}
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
