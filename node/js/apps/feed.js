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

import { openMirror, useLive } from '../mirror.js';
import { usePrefMap, setPref, sealKey, SEAL_PREFIX } from '../mirror/prefs.js';
import { Icons } from '../icons.js';
import { useColWidths, useColTucks, PaneHead, Rail } from '../panes.js';
import { createdMs } from '../pure/docdate.js';
import {
    FEED_STYLE,
    publishedState,
    openDraftOf,
    overlayPosted,
    emphasisOf,
    leadOf,
    mergeFeed,
    feedCursor,
} from '../pure/feed.js';
import { api, apiText } from '../net.js';
import { speakable } from '../speakable.js';
import { PersonChip } from '../person.js';
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
    const when = new Date(createdMs(row)).toLocaleString(undefined, {
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

// ---------------------------------------------------------------------------------------------
// The feed itself: everyone you follow, and you, strictly newest-first.
//
// Chronology is the WHOLE ordering, on purpose. "How do we generate a good feed" is a
// million-dollar question and an open research problem; this draft doesn't pretend to answer
// it. The one thing your interest dials do is shape RENDERING - a low-interest source is
// smaller, a little transparent, and cut to its lead; a high-interest one gets a touch more
// visual importance and is never cut. Order never moves.

// One feed item. The body arrives by the same anonymous path a stranger reads (the item may be
// yours - your posts are public too). Seen is marked when the item enters the viewport, once,
// via the reader's own private chain, so it travels to their other computers.
const FeedItem = ({ item, interest, onSeen }) => {
    const [body, setBody] = useState(undefined);
    const [wholeThing, setWholeThing] = useState(false);
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
        if (item.seen || item.mine || typeof IntersectionObserver === 'undefined') return;
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
    const tlProfile = useTurbolinks(body || '', item.format);
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
    const { lead, cut } = leadOf(body || '', emphasis);
    const shown = wholeThing ? body : lead;

    return html`
        <article class=${entryClass} ref=${itemRef}>
            <header class="feed-entry-head">
                <${PersonChip}
                    root=${item.author}
                    size="mini"
                    profile=${{
                        fields: [
                            item.author_name && { field: 'name', value: item.author_name },
                            item.author_avatar && { field: 'avatar', value: item.author_avatar },
                        ].filter(Boolean),
                        via: [],
                    }}
                />
                <span class="feed-entry-when">${when}</span>
                ${!item.seen && html`<span class="feed-entry-new" title="you haven't seen this yet"></span>`}
            </header>
            ${!!item.title && html`<h2 class="feed-entry-title"><a href=${href}>${item.title}</a></h2>`}
            ${body === undefined && html`<p class="null-sub">…</p>`}
            ${body === null &&
            html`<p class="null-sub">
                <span class="waiting-dot"></span> these words haven't reached this computer.
            </p>`}
            ${!!body &&
            html`<div class="feed-entry-body">
                ${item.format === 'marquee'
                    ? html`<${MarqueeBody} source=${shown} profile=${tlProfile} onUnparsable=${bareSource} />`
                    : html`<pre class="reader-plain">${shown}</pre>`}
                ${cut &&
                !wholeThing &&
                html`<button class="feed-entry-more" onClick=${() => setWholeThing(true)}>
                    the whole thing
                </button>`}
            </div>`}
            ${!item.title &&
            html`<p class="feed-entry-foot"><a href=${href}>from ${item.author_name || 'someone'}'s page</a></p>`}
        </article>
    `;
};

const FeedStream = ({ root, contacts }) => {
    const [items, setItems] = useState([]);
    const [more, setMore] = useState(false);
    const [loading, setLoading] = useState(true);
    const [unseenOnly, setUnseenOnly] = useState(false);
    const streamRef = useRef(null);

    const loadPage = async (cursor) => {
        setLoading(true);
        try {
            const qs = cursor
                ? `?before_ms=${cursor.before_ms}&before_doc=${cursor.before_doc}`
                : '';
            const page = await api(`/api/identity/${root}/feed${qs}`);
            setItems((have) => mergeFeed(cursor ? have : [], page.items));
            setMore(!!page.more);
        } catch {
            // A failed page leaves what's shown; scrolling retries.
        }
        setLoading(false);
    };
    useEffect(() => {
        if (root) loadPage(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [root]);

    // Infinite scroll: nearing the bottom asks for the next page. The button below does the
    // same by hand - the accessible path, and the only one an instrument can press.
    useEffect(() => {
        const el = streamRef.current;
        if (!el || !more) return;
        const onScroll = () => {
            if (el.scrollTop + el.clientHeight > el.scrollHeight - 600 && !loading) {
                loadPage(feedCursor(items));
            }
        };
        el.addEventListener('scroll', onScroll);
        return () => el.removeEventListener('scroll', onScroll);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [more, loading, items]);

    const markSeen = async (item) => {
        setItems((have) =>
            have.map((i) => (i.doc_id === item.doc_id && i.author === item.author ? { ...i, seen: true } : i))
        );
        try {
            await api(
                `/api/identity/${root}/private/kv/feed_seen/${item.doc_id}`,
                { method: 'PUT', body: JSON.stringify({ value: '1' }) }
            );
        } catch {
            // An unmarked seen re-marks on the next look; never worth an error surface.
        }
    };

    const interestOf = (author) => {
        const row = (contacts || []).find((c) => c.root === author);
        return row && row.facts ? row.facts.interest : undefined;
    };
    const visible = unseenOnly ? items.filter((i) => !i.seen) : items;

    return html`
        <main class="feed-stream" ref=${streamRef}>
            <div class="feed-stream-head">
                <span class="feed-stream-title">the feed</span>
                <label class="feed-unseen-toggle">
                    <input
                        type="checkbox"
                        checked=${unseenOnly}
                        onChange=${(e) => setUnseenOnly(e.currentTarget.checked)}
                    />
                    only what's new to you
                </label>
            </div>
            ${visible.map(
                (item) => html`<${FeedItem}
                    key=${`${item.author}:${item.doc_id}`}
                    item=${item}
                    interest=${interestOf(item.author)}
                    onSeen=${markSeen}
                />`
            )}
            ${visible.length === 0 &&
            !loading &&
            html`<p class="null-sub">
                ${unseenOnly
                    ? 'nothing new - you have seen it all.'
                    : 'nothing here yet - follow someone, or write something on the left.'}
            </p>`}
            ${more &&
            html`<button class="feed-more" disabled=${loading} onClick=${() => loadPage(feedCursor(items))}>
                ${loading ? 'reading further back…' : 'further back'}
            </button>`}
        </main>
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
    // Your ledger, for the rendering dials: interest shapes an item's size, never its place.
    const contactRows = useLive(() => (root ? openMirror(root).contacts.toArray() : []), [root]);
    const mine = (rows || [])
        .filter((d) => (d.buckets || []).includes(FEED_STYLE))
        // By when it was WRITTEN, not when it was last touched: editing a post is not saying
        // it again, and a stream that reshuffles because you fixed a typo has stopped being a
        // record of when things happened.
        .sort((a, b) => createdMs(b) - createdMs(a));
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

    // Older UNPOSTED drafts keep a home under the composer; posted items now live in the
    // feed itself, where your own posts read like anyone else's ("as if the user themself had
    // written them" - which they did). The in-place unlock-and-edit for a posted item moved
    // with them out of the main area; editing your history is the persona page's business now,
    // and re-posting a draft still works right here.
    const drafts = mine.filter(
        (d) => d.doc_id !== draftId && !publishedState(overlayPosted(d, postedAs[d.doc_id])).published
    );
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
                              ${drafts.length > 0 &&
                              html`<div class="feed-drafts">
                                  <p class="feed-drafts-head">older drafts</p>
                                  ${drafts.map(
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
                              </div>`}
                          </aside>
                          ${resizer('compose')}`}
                <${FeedStream} root=${root} contacts=${contactRows} />
            </div>
        </div>
    `;
};
