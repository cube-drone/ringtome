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
    isTextDoc,
    overlayPosted,
    mergeFeed,
    feedKey,
    feedCursor,
    collapseReplyPairs,
    PUBLISHED_AS,
} from '../pure/feed.js';
import { api } from '../net.js';
import { SELECTIVITY_STOPS, DEFAULT_STOP, effectiveInterest, visibleAt } from '../pure/selectivity.js';
import { useDocDetail } from '../doc/detail.js';
import { MarqueeBody, bareSource } from '../doc/marqueebody.js';
import { useTurbolinks } from '../doc/turbolinks.js';
import { t } from '../i18n.js';
import { ANNOTATION_STOPS } from '../pure/annotations.js';
import { useAnnotationStop, setAnnotationStop } from '../annotations-stop.js';
import {
    PostEntry,
    Composer,
    LockButton,
    useOwnPostEditing,
    publishWithBaking,
    BakeModal,
} from '../postentry.js';

const html = htm.bind(h);

const EMPTY = new Map();

// A stack item's words, rendered. Journal's reader exactly (doc/detail.js, cache-first and
// patient about a body still in flight), and the BARE fallback for an unparsable document
// rather than the apology - a paragraph of explanation per card is noise in a stream.
//
// This renders YOUR copy of the document, not the public artifact it was minted into: they
// hold the same words until you edit again, and after that the honest thing to show in your
// own app is the draft you are actually working on. The link below says where the public one
// lives.
const PostBody = ({ doc }) => {
    const tlProfile = useTurbolinks(doc?.body ?? '', doc?.format);
    if (!doc) return html`<p class="null-sub">…</p>`;
    if (doc.body == null) {
        return html`<p class="null-sub">
            <span class="waiting-dot"></span> ${t('apps.feed.still-arriving-from-another-computer', 'still arriving from another computer.')}
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
    // The body read, hoisted from PostBody so the stack can judge emptiness (Curtis,
    // 2026-08-28): an unposted draft with no title and no words is a blank page - most
    // often a reply box opened and walked away from - and listing it is noise. Hidden
    // only once the body has ARRIVED and is known empty; while it loads, the row shows as
    // before, so nothing flashes. The document itself stays (the GC in NEXT_STEPS is the
    // road for reclaiming it); this is a display judgment, not a deletion.
    const { doc } = useDocDetail(root, row.doc_id);
    const blank =
        !state.published &&
        !open &&
        !(row.title || '').trim() &&
        doc &&
        typeof doc.body === 'string' &&
        !doc.body.trim();
    // Discard an unposted draft (Curtis, 2026-08-28: the stack had no way to delete one).
    // The same reversible tombstone the editor's own delete chip mints - the doc leaves
    // every list, its history stays - behind the app's native confirm idiom. The mirror's
    // live rows drop it from the stack on their own; nothing here needs to.
    const discard = async () => {
        if (!confirm(t('apps.feed.discard-this-draft', 'Discard this draft? It leaves the list right away.'))) return;
        try {
            await api(`/api/identity/${root}/docs/${row.doc_id}`, { method: 'DELETE' });
        } catch (e) {
            alert(t('apps.feed.couldnt-discard-it', "couldn't discard it: {message}", { message: e.message }));
        }
    };
    const when = new Date(createdMs(row)).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
    if (blank) return null;
    return html`
        <article class=${state.locked ? 'feed-item feed-item-posted' : 'feed-item'}>
            <header class="feed-item-head">
                <span class="feed-item-when">${when}</span>
                <span class="feed-item-state">${open ? t('apps.feed.editing', 'editing') : state.label}</span>
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
                              title=${t('apps.feed.open-this-for-editing', 'open this for editing')}
                              onClick=${() => setOpen(true)}
                          >${t('apps.feed.edit', 'edit')}</button>
                          ${!state.published &&
                          html`<button
                              class="feed-discard"
                              title=${t('apps.feed.discard-this-draft-title', 'discard this draft')}
                              onClick=${discard}
                          >${t('apps.feed.discard', 'discard')}</button>`}`)}
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
                      onDeleted=${() => setOpen(false)}
                  />`
                : html`<${PostBody} doc=${doc} />`}
            ${state.published &&
            html`<p class="feed-item-link">
                <a href=${`/id/${root}/docs/${state.postId}/body`}>${t('apps.feed.the-public-copy', 'the public copy')}</a>
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

const FeedStream = ({ root, current, contacts, fresh, editingFor }) => {
    const [items, setItems] = useState([]);
    const [more, setMore] = useState(false);
    const [loading, setLoading] = useState(true);
    // Arrivals detected but NOT shown: things popping into a list you are reading is
    // infuriating, so updates wait in a reserved bar until asked for. The bar's space is
    // always held (fixed height), so its appearance never moves your read position either.
    const [pending, setPending] = useState([]);
    const [pageError, setPageError] = useState(false);
    const streamRef = useRef(null);

    const loadPage = async (cursor) => {
        setLoading(true);
        setPageError(false);
        try {
            const qs = cursor
                ? `?before_ms=${cursor.before_ms}&before_doc=${cursor.before_doc}`
                : '';
            const page = await api(`/api/identity/${root}/feed${qs}`);
            setItems((have) => mergeFeed(cursor ? have : [], page.items));
            setMore(!!page.more);
        } catch {
            // A failed page leaves what's shown - but says so. The silent version of this
            // catch hid a server 500 behind a button that "did nothing" (2026-08-06).
            setPageError(true);
        }
        setLoading(false);
    };
    useEffect(() => {
        if (root) loadPage(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [root]);

    // Notice new arrivals without showing them: poll the head page on a slow beat (and on
    // window focus - coming back to the tab is when "anything new?" is the live question),
    // and count what isn't already on screen.
    useEffect(() => {
        if (!root) return;
        let live = true;
        const look = async () => {
            try {
                const page = await api(`/api/identity/${root}/feed`);
                if (!live) return;
                setPending((cur) => {
                    const shown = new Set(items.map(feedKey));
                    const news = (page.items || []).filter((i) => !shown.has(feedKey(i)));
                    return news.length === cur.length ? cur : news;
                });
            } catch {
                // A failed look leaves the bar as it was; the next beat retries.
            }
        };
        const timer = setInterval(look, 30_000);
        window.addEventListener('focus', look);
        return () => {
            live = false;
            clearInterval(timer);
            window.removeEventListener('focus', look);
        };
    }, [root, items]);

    // A fresh post of your own joins the stream immediately - your attention is already at
    // the top, so the popping-in objection doesn't apply to the thing you just did. The
    // synthesized item merges by the same key the real journal row will carry, so when the
    // poll later brings the real one, the dedupe swallows it instead of doubling it.
    useEffect(() => {
        if (!fresh) return;
        setItems((have) => mergeFeed([fresh], have));
        setPending((p) => p.filter((i) => feedKey(i) !== feedKey(fresh)));
        if (streamRef.current) streamRef.current.scrollTop = 0;
    }, [fresh]);

    const takePending = () => {
        setItems((have) => mergeFeed(have, pending));
        setPending([]);
        if (streamRef.current) streamRef.current.scrollTop = 0;
    };

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

    // The slider (PROJECT_PLAN: one slider, two budgets; PROJECT_PLAN's Discovery, slice 3). Pure
    // attention: a read-time floor over rows already journaled, network-silent both ways.
    // The position is a PERSONA-level private register - selectivity is a fact about the
    // person's feed and syncs with them, unlike the per-device seal prefs - read once per
    // mount, written on every move. null until the read lands, so the first render filters
    // at the persisted stop rather than flashing Explorer and narrowing.
    const [stop, setStop] = useState(null);
    useEffect(() => {
        if (!root) return undefined;
        let live = true;
        api(`/api/identity/${root}/private/kv/feed_selectivity`)
            .then((r) => {
                if (!live) return;
                const saved = ((r && r.values) || []).find((v) => v.key === 'stop');
                const known = saved && SELECTIVITY_STOPS.some((s) => s.key === saved.value);
                setStop(known ? saved.value : DEFAULT_STOP);
            })
            .catch(() => live && setStop(DEFAULT_STOP));
        return () => {
            live = false;
        };
    }, [root]);
    const moveStop = (key) => {
        setStop(key);
        api(`/api/identity/${root}/private/kv/feed_selectivity/stop`, {
            method: 'PUT',
            body: JSON.stringify({ value: key }),
        }).catch(() => {});
    };

    const factsByRoot = {};
    for (const c of contacts || []) factsByRoot[c.root] = c.facts || {};

    // Emphasis rides the EFFECTIVE level (the slider's own precedence): an explicit dial -
    // author's or sharer's - carries its band; a speculative row arrives small and quiet by
    // construction, whatever its path score, because the path admits it without entitling
    // it to size. Your own posts bypass in PostEntry, as before.
    const emphasisBand = (item) => {
        const eff = effectiveInterest(item, factsByRoot);
        if (eff.kind === 'author-dial' || eff.kind === 'sharer-dial') return eff.band;
        return item.suggested_via ? 'low' : undefined;
    };

    const stopKey = stop || DEFAULT_STOP;
    // Whose labels show (ANNOTATIONS.md ruling 5): the second read-time dial, beside the
    // first. Same discipline - a persona-level register, instant, network-silent.
    const labelStop = useAnnotationStop(root);
    // Your own posts always show: the slider curates OTHER people's claims on your
    // attention, and hiding your words from yourself at "high interest only" would read as
    // loss, not selectivity.
    // The share/reply pair collapses at render (pure/feed.js): when a reply and the
    // parent row its pin journaled are both on screen, the quote-card says it once.
    const visible = collapseReplyPairs(
        items.filter((item) => item.mine || visibleAt(stopKey, item, factsByRoot))
    );

    return html`
        <main class="feed-stream" ref=${streamRef}>
            <div class="feed-fresh-bar">
                ${pending.length > 0 &&
                html`<button class="feed-fresh-btn" onClick=${takePending}>
                    ${pending.length === 1 ? t('apps.feed.1-update', '1 update') : `${pending.length} updates`} ${t('apps.feed.refresh', '· refresh')}
                </button>`}
            </div>
            ${/* No unread filter, and no unread anything (2026-08-09): a feed is a river you
                dip into, not an inbox to empty. The fresh-updates bar above is the one "what
                arrived" affordance, and it is per-visit, in memory, costing no chain. */ ''}
            <div class="feed-stream-head">
                <span class="feed-stream-title">${t('apps.feed.the-feed', 'the feed')}</span>
                ${stop !== null &&
                html`<label class="feed-selectivity" title=${t('apps.feed.how-far-past-the-people', 'how far past the people you chose this feed may reach')}>
                    <input
                        type="range"
                        min="0"
                        max=${SELECTIVITY_STOPS.length - 1}
                        value=${SELECTIVITY_STOPS.findIndex((s) => s.key === stopKey)}
                        onInput=${(e) => moveStop(SELECTIVITY_STOPS[Number(e.currentTarget.value)].key)}
                    />
                    <span class="feed-selectivity-label">${(SELECTIVITY_STOPS.find((s) => s.key === stopKey) || {}).label}</span>
                </label>`}
                ${labelStop &&
                html`<label class="feed-labels-dial" title=${t('apps.feed.whose-labels-show', 'whose labels show on posts')}>
                    <select
                        value=${labelStop}
                        onChange=${(e) => setAnnotationStop(root, e.currentTarget.value)}
                    >
                        ${ANNOTATION_STOPS.map(
                            (s) => html`<option value=${s.key} key=${s.key}>${s.label}</option>`
                        )}
                    </select>
                </label>`}
            </div>
            ${visible.map(
                (item) => html`<${PostEntry}
                    key=${`${item.author}:${item.doc_id}`}
                    item=${item}
                    interest=${emphasisBand(item)}
                    current=${current}
                    editing=${item.mine ? editingFor(item.doc_id) : null}
                />`
            )}
            ${items.length === 0 &&
            !loading &&
            html`<p class="null-sub">
                ${t('apps.feed.nothing-here-yet---follow', 'nothing here yet - follow someone, or write something on the left.')}
            </p>`}
            ${items.length > 0 &&
            visible.length === 0 &&
            !loading &&
            html`<p class="null-sub">
                ${t('apps.feed.nothing-at-this-selectivity', 'nothing at this selectivity - slide toward Explorer to widen the feed.')}
            </p>`}
            ${more &&
            html`<button class="feed-more" disabled=${loading} onClick=${() => loadPage(feedCursor(items))}>
                ${loading
                    ? t('apps.feed.reading-further-back', 'reading further back…')
                    : pageError
                      ? t('apps.feed.couldnt-reach-further-back--', "couldn't reach further back - try again")
                      : t('apps.feed.further-back', 'further back')}
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
    // The shared edit wiring (postentry.js): resolves a public post to your private twin so
    // the stream's own items carry the unlock-and-edit ceremony. Decorated with the local
    // publication overlay, so a post made seconds ago is editable before the stream echoes.
    const editingFor = useOwnPostEditing(current, (r) => overlayPosted(r, postedAs[r.doc_id]));
    // Column chrome, shared with the documents apps (panes.js): the composer is a column you
    // can widen or tuck away to a rail, and the choice settles into this browser's prefs.
    const { tucked, toggleTuck } = useColTucks(root, 'feed');
    // The composer's floor is 260px: below that the editor's chrome crushes even in its
    // narrow mode (panes.js applies the floor to drags AND to previously-stored widths).
    const { resizer, colStyle } = useColWidths(root, 'feed', ['compose'], { compose: 260 });

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
    // The freshly-published post, handed to the stream the moment the server confirms:
    // "seeing the thing I just posted" is the feedback that says it really happened. It goes
    // in AT ITS CHRONOLOGICAL PLACE, which is the top - a public post is minted at publish,
    // parentless, stamped now; the private draft's editing history never enters the public
    // date (copy-don't-flip). No pinning needed: chronology already guarantees the top slot
    // for a first publication, and the prepend just beats the journal's round trip.
    const [fresh, setFresh] = useState(null);
    // The "preparing media for the network" modal's items, while a post's embeds bake.
    const [baking, setBaking] = useState(null);

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
            const made = await publishWithBaking(root, posted, setBaking);
            // Say it here rather than waiting for the stream to say it back: the label and the
            // public link are true the moment the server answers.
            setPostedAs((p) => ({ ...p, [posted]: made.post_id }));
            const row = (rows || []).find((d) => d.doc_id === posted);
            // The labels ride the overlay too (Curtis, 2026-08-30: tags didn't show until
            // a refresh): the synthesized item is what the stream shows until the poll,
            // and the dedupe deliberately swallows the dressed journal row - so the
            // overlay must carry what the mirror already knows. Same exclusions as the
            // server's mint: `published_as` is bookkeeping, and the default bucket is
            // quiet at render anyway.
            const overlayLabels = [];
            for (const tag of (row && row.tags) || []) {
                overlayLabels.push({ annotator: root, key: 'tag', value: tag });
            }
            for (const [field, value] of Object.entries((row && row.fields) || {})) {
                if (field === PUBLISHED_AS || !(value || '').trim()) continue;
                overlayLabels.push({ annotator: root, key: field, value });
            }
            for (const bucket of (row && row.buckets) || []) {
                overlayLabels.push({ annotator: root, key: 'bucket', value: bucket });
            }
            setFresh({
                author: root,
                doc_id: made.post_id,
                title: (row && row.title) || '',
                format: 'marquee',
                published_ms: Date.now(),
                updated_ms: Date.now(),
                arrived_ms: Date.now(),
                annotations: overlayLabels,
                mine: true,
            });
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
        (d) =>
            d.doc_id !== draftId &&
            isTextDoc(d) && // an uploaded image in the feed bucket is media, never a draft
            !publishedState(overlayPosted(d, postedAs[d.doc_id])).published
    );
    return html`
        <div class="feed-app">
            <${BakeModal} items=${baking} />
            <div class="feed-columns" style=${colStyle}>
                ${tucked.has('compose')
                    ? html`<${Rail}
                          icon=${Icons.notes}
                          label=${t('apps.feed.write', 'write')}
                          onClick=${() => toggleTuck('compose')}
                      />`
                    : html`<aside class="feed-compose">
                              <${PaneHead} label=${t('apps.feed.write-2', 'write')} onTuck=${() => toggleTuck('compose')} />
                              ${draftId
                                  ? html`<${Composer}
                                        root=${root}
                                        docId=${draftId}
                                        published=${!!onDraft &&
                                        publishedState(onDraft, seals.get(sealKey(draftId)))
                                            .published}
                                        onPost=${() => post()}
                                        posting=${posting}
                                        onDeleted=${() => {
                                            /* the one-draft rule mints the next page; the
                                               overlay must not resurrect the dead one */
                                            setMinted(null);
                                            minting.current = false;
                                        }}
                                    />`
                                  : html`<p class="null-sub">${t('apps.feed.opening-a-fresh-page', 'opening a fresh page…')}</p>`}
                              ${/* Beside the button that caused it. This used to sit above the
                                  columns, where a failed post reported itself a long way from
                                  the post. */ ''}
                              ${error && html`<p class="form-error">${error}</p>`}
                              ${drafts.length > 0 &&
                              html`<div class="feed-drafts">
                                  <p class="feed-drafts-head">${t('apps.feed.older-drafts', 'older drafts')}</p>
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
                <${FeedStream}
                    root=${root}
                    current=${current}
                    contacts=${contactRows}
                    fresh=${fresh}
                    editingFor=${editingFor}
                />
            </div>
        </div>
    `;
};
