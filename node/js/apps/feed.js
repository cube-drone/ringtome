// Feed: the app that writes in public.
//
// Every other documents app was built private-first, and publication was deliberately not
// bolted onto them (NOTES_APP: nobody authors in public, but neither should a private
// notebook grow a button that makes things public). Feed is the other way round: a draft
// here exists to be posted, and posting is the app's one verb.
//
// ONE OPEN DRAFT (reshaped 2026-08-03, after the first version put a "+ write something"
// button here). A button that mints a document looks broken for the second it takes the
// stream to come back - so it gets clicked again, and again, and seven untitled drafts
// arrive at once. There is no create button now: the app opens straight into the current
// draft, and if there isn't one it makes exactly one, silently. That is self-limiting by
// construction - a second visit finds the first visit's draft and makes nothing - so the
// failure mode isn't fixed, it's unrepresentable.
//
// Below the composer, the stack: what you have posted (sealed behind the deliberate unlock,
// Journal's gesture, because editing something already said should take a breath) and any
// older drafts, which stay visible rather than being hidden by the one-draft rule.
//
// What posting does (server side, NOTES_APP: Publication): the draft is a private note like
// any other, and Post MINTS a separate public artifact from its current text. Editing
// afterwards accumulates ordinary private versions; the next Post bakes all of them into ONE
// further public version. The public history is a history of publications, never of
// keystrokes - copy-don't-flip holding at every step rather than a rule to remember.
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';

import { api } from '../net.js';
import { openMirror, useLive } from '../mirror.js';
import { usePrefMap, setPref, sealKey, SEAL_PREFIX } from '../mirror/prefs.js';
import { Icons } from '../icons.js';
import { claimedMs } from '../pure/docdate.js';
import { FEED_STYLE, publishedState, openDraftOf } from '../pure/feed.js';
import { useDocSession } from '../doc/session.js';
import { LiveMarquee } from '../doc/livemarquee.js';
import { useTurbolinks } from '../doc/turbolinks.js';
import { emojiCompletions, linkCompletions, mediaCompletions } from '../doc/completions.js';

const html = htm.bind(h);

const EMPTY = new Map();

const StatusDot = ({ status }) =>
    html`<span class=${`status-dot status-${status}`} title=${status}></span>`;

// The unlock: a click starts a fifteen-second fill, and the item opens when it completes.
// Journal's gesture exactly (shared CSS) - the same promise, for the same reason.
const LockButton = ({ onUnlocked }) => {
    const [unlocking, setUnlocking] = useState(false);
    return html`
        <button
            class=${unlocking ? 'journal-lock unlocking' : 'journal-lock'}
            title="Posted - click, then wait 15 seconds, to edit this again"
            onClick=${() => setUnlocking(true)}
            disabled=${unlocking}
        >
            <span class="journal-lock-face"><${Icons.lock} /></span>
            ${unlocking &&
            html`<span class="journal-unlock-bar" onAnimationEnd=${onUnlocked}></span>`}
        </button>
    `;
};

// The composer: the open draft, edited IN PLACE with the interactive editor. It uses every
// other editing surface's save machinery (doc/session.js) - autosave, blur flush, the lookout
// that fast-forwards a clean buffer when another computer writes - because this is an editing
// surface like any other; only what it does at the end differs.
const Composer = ({ root, docId, published, onPost, posting }) => {
    const s = useDocSession(root, docId);
    const tlProfile = useTurbolinks(s.body, s.format);
    const empty = !s.body.trim() && !s.title.trim();

    if (s.status === 'opening' && !s.loaded) {
        return html`<p class="null-sub">opening…</p>`;
    }
    if (s.status === 'waiting') {
        return html`<p class="null-sub">
            <span class="waiting-dot"></span> some of this draft's words are still arriving
            from another computer.
        </p>`;
    }
    return html`
        <div class="feed-composer">
            <input
                class="feed-title"
                value=${s.title}
                placeholder="a title, if you like"
                onInput=${(e) => {
                    s.setTitle(e.currentTarget.value);
                    s.touched();
                }}
                onBlur=${() => s.save()}
            />
            <${LiveMarquee}
                body=${s.body}
                profile=${tlProfile}
                completions=${[
                    emojiCompletions,
                    linkCompletions(root, FEED_STYLE),
                    mediaCompletions(root, FEED_STYLE),
                ]}
                onInput=${(text) => {
                    s.setBody(text);
                    s.touched();
                }}
                onBlur=${s.save}
            />
            <div class="feed-composer-foot">
                <${StatusDot} status=${s.status} />
                <span class="feed-note">
                    posting is public - anyone with your address can read it
                </span>
                <button
                    class="feed-post"
                    disabled=${posting || empty}
                    title=${empty ? 'write something first' : 'publish these words'}
                    onClick=${async () => {
                        await s.save(); // the post publishes what is SAVED, so flush first
                        onPost();
                    }}
                >${posting ? 'posting…' : published ? 'post the changes' : 'post'}</button>
            </div>
        </div>
    `;
};

// One item in the stack below the composer: something posted, or an older draft.
const StackItem = ({ root, row, seal, onSeal }) => {
    const state = publishedState(row, seal);
    const when = new Date(claimedMs(row)).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
    return html`
        <article class=${state.locked ? 'feed-item feed-item-posted' : 'feed-item'}>
            <header class="feed-item-head">
                <span class="feed-item-when">${when}</span>
                <span class="feed-item-state">${state.label}</span>
                ${state.locked && html`<${LockButton} onUnlocked=${onSeal} />`}
            </header>
            ${/* A sealed post is not a link: the editor behind it would open without the
                unlock, and a ceremony you can walk around isn't one. */ ''}
            <h2 class="feed-item-title">
                ${state.locked
                    ? html`<span>${row.title || 'untitled'}</span>`
                    : html`<a href=${`/home/feed/${row.doc_id}`}>${row.title || 'untitled'}</a>`}
            </h2>
            ${state.published &&
            html`<p class="feed-item-link">
                <a href=${`/id/${root}/docs/${state.postId}/body`}>read it as the world does</a>
            </p>`}
        </article>
    `;
};

export const FeedApp = ({ current }) => {
    const root = current && current.root;
    const [posting, setPosting] = useState(false);
    const [error, setError] = useState(null);
    const minting = useRef(false);
    const seals = usePrefMap(root, SEAL_PREFIX) || EMPTY;

    const rows = useLive(() => (root ? openMirror(root).docs.toArray() : []), [root]);
    const mine = (rows || [])
        .filter((d) => (d.buckets || []).includes(FEED_STYLE))
        .sort((a, b) => claimedMs(b) - claimedMs(a));
    const draft = openDraftOf(mine);

    // Mint the one draft. The guard is a ref rather than state because the mirror takes a
    // moment to show the new row, and a second render must not mint a second draft in that
    // window - which is the whole bug this shape exists to prevent.
    const mintDraft = async () => {
        if (minting.current) return;
        minting.current = true;
        try {
            // Create, then file: minting a document and placing it in a notebook are two
            // acts (a document's membership is an annotation, not a header).
            const made = await api(`/api/identity/${root}/docs`, {
                method: 'POST',
                body: JSON.stringify({ title: '', body: '', format: 'marquee' }),
            });
            await api(
                `/api/identity/${root}/docs/${made.doc_id}/buckets/${encodeURIComponent(FEED_STYLE)}`,
                { method: 'PUT' }
            );
        } catch (e) {
            setError(e.message);
            minting.current = false; // a failed mint may be retried; a successful one never
        }
    };

    useEffect(() => {
        if (!root || !rows || draft) return;
        mintDraft();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [root, rows, draft]);

    const post = async () => {
        if (!draft) return;
        setPosting(true);
        setError(null);
        try {
            await api(`/api/identity/${root}/docs/${draft.doc_id}/publish`, { method: 'POST' });
            // The next page BEFORE the old one leaves the slot: mint first, seal second. The
            // composer then hands over from one draft straight to the next, with no moment
            // where there is no open draft - which would tear the live editor down and put a
            // placeholder on screen mid-post.
            minting.current = false;
            await mintDraft();
            // Said in public: seal it, so editing again costs the unlock.
            setPref(root, sealKey(draft.doc_id), 'locked');
        } catch (e) {
            setError(e.message);
        }
        setPosting(false);
    };

    const stack = mine.filter((d) => !draft || d.doc_id !== draft.doc_id);
    return html`
        <div class="feed-app">
            ${error && html`<p class="form-error">${error}</p>`}
            ${draft
                ? html`<${Composer}
                      root=${root}
                      docId=${draft.doc_id}
                      published=${publishedState(draft, seals.get(sealKey(draft.doc_id))).published}
                      onPost=${post}
                      posting=${posting}
                  />`
                : html`<p class="null-sub">opening a fresh page…</p>`}
            <div class="feed-stack">
                ${stack.map(
                    (row) => html`<${StackItem}
                        key=${row.doc_id}
                        root=${root}
                        row=${row}
                        seal=${seals.get(sealKey(row.doc_id))}
                        onSeal=${() => setPref(root, sealKey(row.doc_id), 'open')}
                    />`
                )}
            </div>
        </div>
    `;
};
