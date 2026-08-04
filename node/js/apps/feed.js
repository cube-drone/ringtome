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
// TWO COLUMNS, the documents apps' layout (panes.js): the composer is a column on the left,
// draggable and tuckable like Notes' list or the wiki's tree, and the stream fills the main
// area. Writing and reading are then both always on screen - which is the arrangement the
// app's own name implies, and what the one-column version couldn't do once posts rendered
// their words rather than a link.
//
// The stack: what you have posted (sealed behind the deliberate unlock, Journal's gesture,
// because editing something already said should take a breath) and any older drafts, which
// stay visible rather than being hidden by the one-draft rule.
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
import { useColWidths, useColTucks, PaneHead, Rail } from '../panes.js';
import { claimedMs } from '../pure/docdate.js';
import { FEED_STYLE, publishedState, openDraftOf, overlayPosted } from '../pure/feed.js';
import { useDocSession } from '../doc/session.js';
import { useDocDetail } from '../doc/detail.js';
import { MarqueeBody, bareSource } from '../doc/marqueebody.js';
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

// A stack item's words, rendered. Journal's reader exactly (doc/detail.js, cache-first and
// patient about a body still in flight), and the BARE fallback for an unparsable document
// rather than the apology - a paragraph of explanation per card is noise in a stream.
//
// This renders YOUR copy of the document, not the public artifact it was minted into: they
// hold the same words until you edit again, and after that the honest thing to show in your
// own app is the draft you are actually working on. The link below says where the public one
// lives.
const PostBody = ({ root, docId }) => {
    const { doc } = useDocDetail(root, docId);
    const tlProfile = useTurbolinks(doc?.body ?? '', doc?.format);
    if (!doc) return html`<p class="null-sub">…</p>`;
    if (doc.body == null) {
        return html`<p class="null-sub">
            <span class="waiting-dot"></span> still arriving from another computer.
        </p>`;
    }
    if (!doc.body.trim()) return null;
    return html`<div class="feed-item-body">
        ${doc.format === 'marquee'
            ? html`<${MarqueeBody} source=${doc.body} profile=${tlProfile} onUnparsable=${bareSource} />`
            : html`<pre class="reader-plain">${doc.body}</pre>`}
    </div>`;
};

// One item in the stack below the composer: something posted, or an older draft.
//
// EDITING HAPPENS HERE, in place - the same interactive editor the composer runs, mounted
// where the words already are. The first version made the title a link instead, which was
// wrong twice over: an untitled post has no title to click, so the unlock ceremony completed
// and nothing whatsoever happened; and the link led to `/home/feed/<id>`, an address this app
// doesn't answer, so it fell through to the documents-app rendering of a feed post - the
// "clicking one carried me into essentially the notes app" from the day this app was built.
//
// The editor mounts on demand rather than whenever an item is unlocked: a stack of leftover
// drafts would otherwise raise a live CodeMirror each on first paint.
const StackItem = ({ root, row, seal, onSeal, onPost, posting }) => {
    const [open, setOpen] = useState(false);
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
                <span class="feed-item-state">${open ? 'editing' : state.label}</span>
                ${!open &&
                (state.locked
                    ? html`<${LockButton}
                          onUnlocked=${() => {
                              onSeal();
                              setOpen(true);
                          }}
                      />`
                    : html`<button
                          class="feed-edit"
                          title="open this for editing"
                          onClick=${() => setOpen(true)}
                      >edit</button>`)}
            </header>
            ${/* No title, no heading. A post that was never given one is untitled in the
                ordinary sense of the word - the app inventing the LABEL "untitled" and
                setting it in heading type says the author called it that. */ ''}
            ${!open && !!row.title && html`<h2 class="feed-item-title">${row.title}</h2>`}
            ${open
                ? html`<${Composer}
                      root=${root}
                      docId=${row.doc_id}
                      published=${state.published}
                      onPost=${async () => {
                          await onPost(row.doc_id);
                          setOpen(false); // said again, and sealed again
                      }}
                      posting=${posting}
                  />`
                : html`<${PostBody} root=${root} docId=${row.doc_id} />`}
            ${state.published &&
            html`<p class="feed-item-link">
                <a href=${`/id/${root}/docs/${state.postId}/body`}>the public copy</a>
            </p>`}
        </article>
    `;
};

export const FeedApp = ({ current }) => {
    const root = current && current.root;
    const [posting, setPosting] = useState(false);
    const [error, setError] = useState(null);
    const minting = useRef(false);
    // The draft we just made, held locally until the stream brings its row back. Minting is a
    // round trip and the echo is another, so without this the app sits on a placeholder for
    // seconds while a document that already exists makes its way home. Same overlay the
    // contact ledger and the tags use: local hint over the mirror, cleared the moment the
    // mirror agrees (PROJECT_PLAN, The Browser Is a View - the view may run ahead of the
    // stream as long as it never disagrees with it).
    const [minted, setMinted] = useState(null);
    // Publications this app performed, by doc id, ahead of the stream (pure/feed.js's
    // `overlayPosted` yields once the mirror carries the annotation, so these go inert rather
    // than needing to be cleared).
    const [postedAs, setPostedAs] = useState({});
    const seals = usePrefMap(root, SEAL_PREFIX) || EMPTY;
    // Column chrome, shared with the documents apps (panes.js): the composer is a column you
    // can widen or tuck away to a rail, and the choice settles into this browser's prefs.
    const { tucked, toggleTuck } = useColTucks(root, 'feed');
    const { resizer, colStyle } = useColWidths(root, 'feed', ['compose']);

    const rows = useLive(() => (root ? openMirror(root).docs.toArray() : []), [root]);
    const mine = (rows || [])
        .filter((d) => (d.buckets || []).includes(FEED_STYLE))
        .sort((a, b) => claimedMs(b) - claimedMs(a));
    const draft = openDraftOf(mine);
    // The overlay leads: a just-minted draft is the open one even before its row lands.
    const draftId = minted || (draft && draft.doc_id) || null;
    const onDraft = draft && draft.doc_id === draftId ? draft : null;

    useEffect(() => {
        if (minted && draft && draft.doc_id === minted) setMinted(null); // the stream caught up
    }, [minted, draft]);

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
            setMinted(made.doc_id); // on screen now, not when the stream says so
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
        if (!root || !rows || draftId) return;
        mintDraft();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [root, rows, draftId]);

    // Posting used to be a queue of round trips: save, then publish, then create the next
    // page, then file it - four chain appends end to end, and the words sat in the composer
    // for all of them. Only the first two have to happen in that order. The next page is
    // minted ALONGSIDE the publish, and the composer hands over the moment that document
    // exists, so what you wrote joins the stream while the publish is still in flight.
    const post = async (docId) => {
        const posted = docId || draftId;
        if (!posted) return;
        setPosting(true);
        setError(null);
        // Only the open draft moves the slot along. Re-posting something already in the stack
        // says the same document again - there is no next page to make, and minting one would
        // hand you a blank composer for pressing a button on an old post.
        if (posted === draftId) {
            minting.current = false;
            mintDraft(); // deliberately not awaited - it carries its own error path
        }
        try {
            const made = await api(`/api/identity/${root}/docs/${posted}/publish`, {
                method: 'POST',
            });
            // Say it here rather than waiting for the stream to say it back: the label and the
            // public link are true the moment the server answers.
            setPostedAs((p) => ({ ...p, [posted]: made.post_id }));
            // Said in public: seal it, so editing again costs the unlock.
            setPref(root, sealKey(posted), 'locked');
        } catch (e) {
            // The handover already happened, so a refused publish leaves the words in the
            // stream as what they still are - a draft - with the reason above them.
            setError(e.message);
        }
        setPosting(false);
    };

    const stack = mine.filter((d) => d.doc_id !== draftId);
    return html`
        <div class="feed-app">
            <div class="feed-columns" style=${colStyle}>
                ${tucked.has('compose')
                    ? html`<${Rail}
                          icon=${Icons.notes}
                          label="write"
                          onClick=${() => toggleTuck('compose')}
                      />`
                    : html`<aside class="feed-compose">
                              <${PaneHead} label="write" onTuck=${() => toggleTuck('compose')} />
                              ${draftId
                                  ? html`<${Composer}
                                        root=${root}
                                        docId=${draftId}
                                        published=${!!onDraft &&
                                        publishedState(onDraft, seals.get(sealKey(draftId)))
                                            .published}
                                        onPost=${post}
                                        posting=${posting}
                                    />`
                                  : html`<p class="null-sub">opening a fresh page…</p>`}
                              ${/* Beside the button that caused it. This used to sit above the
                                  columns, where a failed post reported itself a long way from
                                  the post. */ ''}
                              ${error && html`<p class="form-error">${error}</p>`}
                          </aside>
                          ${resizer('compose')}`}
                <main class="feed-stack">
                    ${stack.length === 0 &&
                    html`<p class="null-sub">
                        nothing posted yet - what you write on the left lands here.
                    </p>`}
                    ${stack.map(
                        (row) => html`<${StackItem}
                            key=${row.doc_id}
                            root=${root}
                            row=${overlayPosted(row, postedAs[row.doc_id])}
                            seal=${seals.get(sealKey(row.doc_id))}
                            onSeal=${() => setPref(root, sealKey(row.doc_id), 'open')}
                            onPost=${post}
                            posting=${posting}
                        />`
                    )}
                </main>
            </div>
        </div>
    `;
};
