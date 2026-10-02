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
import { useState, useEffect, useRef, useContext } from 'preact/hooks';
import { createContext } from 'preact';
import htm from 'htm';

import { api, apiText, apiTextTitled } from './net.js';
import { openMirror, useLive } from './mirror.js';
import { Icons } from './icons.js';
import { SuperPinChip } from './frontdoor.js';
import { Modal } from './modal.js';
import { speakable } from './speakable.js';
import { descriptionOf, excerpt } from './pure/excerpt.js';
// The reaction palette under the open tag input (Curtis, 2026-08-31): the nine in pole
// position, then the whole gemoji table - shared with the room's reaction picker
// (emoji.js). One click says the emoji as a tag.
import { EmojiStrip, toneOf } from './emoji.js';
import { groupLabels, isEmojiTag, mayTag, tagsLeft, visibleAnnotations, MAX_TAG_CHARS } from './pure/annotations.js';
import {
    FEED_STYLE,
    publishedState,
    emphasisOf,
    leadOf,
    postScale,
    postImageCap,
    POST_IMAGE_MAX,
    isBackdated,
} from './pure/feed.js';
import { appById, featuresOf } from './pure/apps.js';
import { Editor } from './doc/editor.js';
import { useDocDetail } from './doc/detail.js';
import { MarqueeBody, bareSource } from './doc/marqueebody.js';
import { useTurbolinks, turbolinkReader } from './doc/turbolinks.js';
import { registerRoomCard } from './doc/usercard.js';
import { parseRingtome } from './pure/ringtome.js';
import { parseSpeakable } from './speakable.js';
import { agoUnit } from './pure/ago.js';
import { PersonBanner, PersonChip, PersonHex, usePerson } from './person.js';
import { parseBook } from './pure/books.js';
import { useShared, markShared } from './shares.js';
import { t } from './i18n.js';
import { useWarnings } from './warnings.js';
import { CopyButton } from './copyinto.js';
import { warningFor } from './pure/warnings.js';
import { veilsMedia } from './pure/chatveil.js';

const html = htm.bind(h);

export const StatusDot = ({ status }) =>
    html`<span class=${`status-dot status-${status}`} title=${status}></span>`;

// The composer: the REAL notes editor, wearing Feed's clothes (Curtis's ruling, 2026-08-06:
// both point at a private document, so the features come over whole rather than being
// reimplemented). The registry's feature block does the tailoring - Feed already declares
// `pin: false` (no list to float atop; the date is ON since PUBLISH.md - a claim that files
// or schedules the post) - and
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
                uploadBucket=${FEED_STYLE}
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

// `publishWithBaking` and `BakeModal` live in doc/publish.js now (Writer's chip uses them
// too, and doc/editor.js cannot import this module without a cycle); re-exported for the
// surfaces that always found them here.
import { publishWithBaking, BakeModal } from './doc/publish.js';
import { beatLabel } from './pure/swatch.js';
import { postHref, docHref, roomHref, CopyLinkChip, postHistoryHref } from './links.js';
import { RoomTitle, BookTitle } from './roomtitle.js';
import { formatWhen } from './pure/when.js';
export { publishWithBaking, BakeModal };

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
    const [posting, setPosting] = useState(false);
    // The bake modal's items while an edit's media prepares; null when quiet.
    const [baking, setBaking] = useState(null);

    const post = async (privDocId) => {
        setPosting(true);
        try {
            await publishWithBaking(myRoot, privDocId, setBaking);
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
        return {
            root: myRoot,
            row,
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
/// changes what other people can see.
///
/// On your own posts directly, NOT behind the editing unlock (moved 2026-08-14): the unlock
/// jumps straight into the composer, so the only state that ever rendered this button was
/// unlocked-but-closed - reachable exclusively by unlocking and then reloading the page.
/// Curtis went looking for it and could not find it, which is the whole finding. The ask/
/// confirm below is the gesture's own breath; a second gate labeled "open this for editing"
/// guarded nothing and pointed the wrong way.
///
/// Says what it costs before it does it: a retraction travels to followers' feeds and to anyone
/// holding a shared copy, but it cannot reach a node that never comes back online, and it cannot
/// unsee. Promising erasure would be a lie the protocol cannot keep.
/// The author's own pin (PROJECT_PLAN's Peeks, ruling 11-12): one public annotation, `pin`, said about
/// their own post and retracted to unpin - the page's strip reads it, the card wears it.
/// Beside the note-pencil and the takedown, for the author only; never from the Writer.
/// A post the page's persona passes along is theirs to pin too (Curtis, 2026-09-29: "Pin books,
/// chats, or rebroadcasts"): the same statement, said by the sharer - `via` - about the post.
/// A share's card carries no annotations, so the page says `pinned` on it outright.
const pinner = (item) => (item.kind === 'share' ? item.via : item.author);
const pinnedByAuthor = (item) =>
    !!item.pinned || (item.annotations || []).some((a) => a.key === PIN_KEY && a.annotator === pinner(item));

const PinButton = ({ item, current, pinned, onPinned }) => {
    const [busy, setBusy] = useState(false);
    const base = `/api/identity/${current.root}/public-annotations/${item.author}/${item.doc_id}`;
    return html`<button
        class=${pinned ? 'chip chip-button chip-pinned' : 'chip chip-button'}
        title=${pinned
            ? t('postentry.unpin-this-from-your-page', 'unpin this from your page')
            : t('postentry.pin-this-to-the-top', 'pin this to the top of your page')}
        disabled=${busy}
        onClick=${async () => {
            setBusy(true);
            try {
                if (pinned) await api(`${base}/${PIN_KEY}/${PIN_VALUE}`, { method: 'DELETE' });
                else await api(base, { method: 'PUT', body: JSON.stringify({ key: PIN_KEY, value: PIN_VALUE }) });
                onPinned(!pinned);
            } catch {
                /* the next click retries; the chip stays honest to what the server holds */
            }
            setBusy(false);
        }}
    ><${Icons.pin} /></button>`;
};

const UnpublishButton = ({ item, current, onTakenDown }) => {
    const [asking, setAsking] = useState(false);
    const [going, setGoing] = useState(false);

    // Icon-plus-hover like its neighbors (2026-08-14); the deliberation moved from an inline
    // strip to the house modal, because a confirm that reflows the card it is deciding about
    // reads as part of the card - the system stepping forward is exactly what the modal frame
    // is for, and a takedown is the system being asked to do something irreversible.
    return html`<button
            class="chip chip-button chip-delete"
            title=${t('postentry.take-this-post-back-off', 'take this post back off the network')}
            onClick=${() => setAsking(true)}
        ><${Icons.trash} /></button>
        ${asking &&
        html`<${Modal}
            title=${t('postentry.take-it-down', 'take it down')}
            onClose=${() => {
                if (!going) setAsking(false);
            }}
        >
            <p class="feed-unpublish-warn">
                ${t(
                    'postentry.this-removes-it-from-other',
                    'It may take a while to disappear everywhere.'
                )}
            </p>
            <div class="feed-unpublish-acts">
                <button
                    class="feed-unpublish-go jag-line"
                    disabled=${going}
                    onClick=${async () => {
                        setGoing(true);
                        try {
                            await api(`/api/identity/${current.root}/posts/${item.doc_id}`, {
                                method: 'DELETE',
                            });
                            // The server released the note (published_as cleared - it is a
                            // draft again, and re-posting mints a NEW post).
                            // And the card retires NOW. This used to wait for the next feed
                            // read ("nothing is faked here"), and nothing is faked here
                            // either: the 200 IS the tombstone on the chain, and a post the
                            // reader just deleted staring back at them reads as the delete
                            // not having worked (Curtis, 2026-08-14, from the UI). The
                            // markShared discipline - reflect the confirmed write, never
                            // the guess.
                            if (onTakenDown) onTakenDown();
                        } catch {
                            // Fall through: either way the modal closes, and the next feed
                            // read tells the truth about what happened.
                        }
                        setGoing(false);
                        setAsking(false);
                    }}
                >${going ? t('postentry.taking-it-down', 'taking it down…') : t('postentry.yes-take-it-down', 'yes, take it down')}</button>
                <button
                    class="feed-unpublish-no"
                    disabled=${going}
                    onClick=${() => setAsking(false)}
                >${t('postentry.keep-it', 'keep it')}</button>
            </div>
        <//>`}`;
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
/// "and four others", with the four of them behind a hover.
///
/// Two numbers, deliberately not the same one: the COUNT is the server's and is exact, while the
/// roster is capped (`fanout::VIA_OTHERS_CAP`) because a list is a payload and a viral post could
/// otherwise put two hundred names on one row. When the cap bites, the roster says so rather than
/// quietly presenting a sample as the whole set.
///
/// The others are chips, not names, so a sharer reads the same here as everywhere else - nickname,
/// claimed name, speakable fallback and face all come out of `usePerson`, instead of this row
/// growing a second and thinner copy of that logic.
const ViaOthers = ({ item, current }) => {
    const others = item.via_others || [];
    if (!others.length) return null;
    // via_count includes the lead; the phrase is about everyone BUT the lead.
    const more = (item.via_count || others.length + 1) - 1;
    const hidden = more - others.length;
    return html`<span class="feed-entry-via-others">
        <span class="feed-entry-via-count">
            ${more === 1
                ? t('postentry.and-one-other', 'and one other')
                : t('postentry.and-count-others', 'and {count} others', { count: more })}
        </span>
        <span class="feed-entry-via-roster">
            ${others.map(
                (other) => html`<${PersonChip}
                    key=${other.root}
                    root=${other.root}
                    current=${current}
                    size="mini"
                    profile=${{
                        fields: [
                            other.name && { field: 'name', value: other.name },
                            other.avatar && { field: 'avatar', value: other.avatar },
                        ].filter(Boolean),
                        via: [],
                    }}
                />`
            )}
            ${hidden > 0 &&
            html`<span class="feed-entry-via-rest"
                >${t('postentry.count-more-not-listed', 'and {count} more, not listed here', {
                    count: hidden,
                })}</span
            >`}
        </span>
    </span>`;
};

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

    // Icon-only, a Writer chip (doc/chips.js) like every file chip (Curtis, 2026-09-27): a glyph,
    // a hover title with the words, no label. Shared, it wears the chip's lit look.
    return html`<button
        class=${shared ? 'chip chip-button chip-open' : 'chip chip-button'}
        disabled=${sending || known === null}
        title=${shared
            ? t('postentry.stop-sharing-this-with-your', 'stop sharing this with your network')
            : t('postentry.pass-this-along-to-your', 'pass this along to your network')}
        onClick=${pass}
    >
        <${Icons.colRebroadcast} />
    </button>`;
};

/// A post, REFERRED to - the mini-card (2026-08-26): title and date in a small clickable
/// footprint, for surfaces that mention a post rather than show it (the bell's rebroadcast
/// rows first). Not a compact PostEntry on purpose: the one-component ruling covers "a
/// post, shown", and this shows nothing of the post's body beyond a mention's worth - it
/// is a dressed link. An untitled post says its first words instead (Curtis, 2026-09-05):
/// the author's description if they wrote one, else the body's first nine usable words,
/// fetched here so a sealed body a reader cannot open stays sealed (the door refuses, the
/// card falls back to "link"). Every card wears the author's heptagon (Curtis, 2026-09-05:
/// "display it as a profile icon"): provenance at a glance, their name when you point at it.
const PIN_KEY = 'pin';
const PIN_VALUE = 'yes';

export const MiniPost = ({ author, doc_id, title, published_ms }) => {
    const person = usePerson(author);
    const [words, setWords] = useState('');
    useEffect(() => {
        setWords('');
        if (title || !author || !doc_id) return undefined;
        let live = true;
        (async () => {
            try {
                const head = await api(`/api/id/${author}/posts/${doc_id}`);
                // The title the caller lacked, first (Curtis, 2026-09-05: a reply's parent
                // read "link" although the post had a title and the node held it).
                if (head.title) {
                    if (live) setWords(head.title);
                    return;
                }
                const said = descriptionOf(head.annotations, author);
                if (said) {
                    if (live) setWords(said);
                    return;
                }
                // Sealed: the title travels with the words, for whoever may have them
                // (ruling 5) - ask the body door and stay a link when it refuses.
                if (head.trusted_only) {
                    try {
                        const { title } = await apiTextTitled(`/id/${author}/docs/${doc_id}/body`);
                        if (live && title) setWords(title);
                    } catch {
                        /* not for us: the mini-card stays a link */
                    }
                    return;
                }
                if (head.format === 'book') return; // a table: no peeking
                const body = await apiText(`/id/${author}/docs/${doc_id}/body`);
                if (live) setWords(excerpt(body, head.format));
            } catch {
                /* the post has left the shelf, or its words refuse this reader: "link" */
            }
        })();
        return () => {
            live = false;
        };
    }, [author, doc_id, title]);
    const when = published_ms && formatWhen(published_ms, undefined, { time: false });
    return html`<a class="minipost" href=${postHref(author, doc_id)}>
        <span class="minipost-who" title=${person.primary}><${PersonHex} person=${person} size="mini" /></span>
        <span class=${title ? 'minipost-title' : 'minipost-words'}>${title || words || t('postentry.link', 'link')}</span>
        ${when && html`<span class="minipost-when">${when}</span>`}
    </a>`;
};

/// A book on the feed (PROJECT_PLAN's Books, ruling 5): the whole table - sections and pages, each page a
/// link to its own permalink - under one line saying what it is. The reader's browser
/// (slice 4) grows out of this.
const BookSection = ({ section, author, depth }) => html`<li class="book-card-section">
    ${section.title && html`<span class="book-card-section-title">${section.title}</span>`}
    <ul class="book-card-list">
        ${section.pages.map(
            (p) => html`<li class="book-card-page" key=${p.post}>
                <a href=${postHref(author, p.post)}>${p.title || t('postentry.untitled-page', 'untitled page')}</a>
            </li>`
        )}
        ${section.sections.map((s, i) => html`<${BookSection} key=${`${depth}-${i}`} section=${s} author=${author} depth=${depth + 1} />`)}
    </ul>
</li>`;

const BookCard = ({ book, author }) => {
    // The title page's words ride the card in full (PROJECT_PLAN's Books, ruling 11), then the table.
    const cover = book && book.cover ? book.cover.post : null;
    const [coverWords, setCoverWords] = useState(undefined);
    useEffect(() => {
        if (!cover) {
            setCoverWords(undefined);
            return undefined;
        }
        let live = true;
        apiText(`/id/${author}/docs/${cover}/body`)
            .then((text) => live && setCoverWords(text))
            .catch(() => live && setCoverWords(null));
        return () => {
            live = false;
        };
    }, [author, cover]);
    const coverProfile = useTurbolinks(coverWords || '', 'marquee');
    if (!book) return html`<p class="null-sub">${t('postentry.a-book-this-node-cannot-read', 'a book this computer cannot read yet')}</p>`;
    return html`<div class="book-card">
        ${!!coverWords && html`<div class="book-card-cover"><${MarqueeBody} source=${coverWords} profile=${coverProfile} onUnparsable=${bareSource} /></div>`}
        <p class="book-card-head">
            <${Icons.book} />
            ${book.count === 1
                ? t('postentry.a-book-1-page', 'a book · 1 page')
                : t('postentry.a-book-n-pages', 'a book · {count} pages', { count: book.count })}
        </p>
        <ul class="book-card-list">
            <${BookSection} section=${{ title: '', pages: book.pages, sections: book.sections }} author=${author} depth=${0} />
        </ul>
    </div>`;
};

/// A room's card is a slice of its floor (Curtis, 2026-09-18): the post as the first
/// thing said, by its creator, then "and N more", then the last three things said - every
/// line the same shape, rendered as the room renders them, each with when. Off the room's
/// history door, which fills from the archive when this node keeps less and says how many
/// the room holds without syncing it; past a hundred more the card says "100+". Nothing
/// past the post when the reader may not enter, or is signed out.
const ROOM_TAIL = 3;
const ROOM_MORE_CAP = 100;
const sinceWords = (ms) => {
    const ago = agoUnit(ms, Date.now());
    return ago ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(ago.value, ago.unit) : t('postentry.just-now', 'just now');
};
const RoomLine = ({ speaker, words, said_ms, current, author, im }) => {
    const profile = useTurbolinks(words || '', 'marquee');
    // A stranger's media wears the veil here too (Curtis, 2026-09-19): the card sits in the
    // feed, where a dropped image would otherwise land unasked. The rule is the chat's own,
    // shared (pure/chatveil.js) - including its one subtlety: the room's creator is never a
    // stranger in a room, and IS one in a chat for two, where the creator is the other
    // person and opening a chat with somebody is not a relationship with them.
    const person = usePerson(speaker, { current });
    const trust = (person.facts || {}).trust;
    const stranger = !!current && speaker !== current.root && speaker !== author && (!trust || trust === 'none');
    const [revealed, setRevealed] = useState(false);
    const veiled =
        !revealed &&
        !!current &&
        veilsMedia({
            words,
            speaker,
            me: current.root,
            author,
            im: !!im,
            trusted: !!trust && trust !== 'none',
        });
    return html`<li class=${stranger ? 'room-card-line room-card-line-untrusted' : 'room-card-line'}>
        <${PersonChip} root=${speaker} current=${current} />
        <div class="room-card-words">
            ${words === null
                ? html`<span class="chat-msg-sealed">${t('postentry.sealed-words', 'sealed words')}</span>`
                : veiled
                  ? html`<div class="feed-entry-veil">
                        <div class="feed-entry-body feed-entry-body-veiled" aria-hidden="true">
                            <${MarqueeBody} source=${words} profile=${profile} onUnparsable=${bareSource} />
                        </div>
                        <button class="feed-entry-unveil" type="button" onClick=${() => setRevealed(true)}>
                            ${t('postentry.media-from-someone-you-dont-trust', "media from someone you don't trust - click to see")}
                        </button>
                    </div>`
                  : html`<${MarqueeBody} source=${words} profile=${profile} onUnparsable=${bareSource} />`}
        </div>
        <span class="room-card-when" title=${new Date(said_ms).toLocaleString()}>${sinceWords(said_ms)}</span>
    </li>`;
};
const RoomFloor = ({ item, current, post }) => {
    const root = current && current.root;
    const [tail, setTail] = useState(null);
    useEffect(() => {
        if (!root) return undefined;
        let live = true;
        api(`/api/identity/${root}/rooms/${item.author}/${item.doc_id}/messages?limit=${ROOM_TAIL}`)
            .then((page) => live && setTail(page))
            .catch(() => live && setTail(null));
        return () => {
            live = false;
        };
    }, [root, item.author, item.doc_id]);
    const lines = tail && tail.items ? [...tail.items].reverse() : [];
    const more = tail ? Math.max(0, (tail.total || 0) - lines.length) : 0;
    return html`<ul class="room-card-lines">
        <${RoomLine} speaker=${item.author} words=${post} said_ms=${item.published_ms} current=${current} author=${item.author} im=${tail && tail.im} />
        ${/* A rule with the count on it: a break in the conversation, not a line of it
            (Curtis, 2026-09-18). */ ''}
        ${more > 0 &&
        html`<li class="room-card-more" role="separator">
            ${more > ROOM_MORE_CAP
                ? t('postentry.and-100-more', 'and {cap}+ more', { cap: ROOM_MORE_CAP })
                : more === 1
                  ? t('postentry.and-one-more', 'and one more')
                  : t('postentry.and-n-more', 'and {n} more', { n: more })}
        </li>`}
        ${lines.map((m) => html`<${RoomLine} key=${m.hash} speaker=${m.speaker} words=${m.words} said_ms=${m.said_ms} current=${current} author=${item.author} im=${tail && tail.im} />`)}
    </ul>`;
};

/// Inside a room's card already: a room linked from inside one - or a room linking itself - draws only
/// its header, never another floor, so a card can never nest without end.
const InRoomCard = createContext(false);

/// A room's link, pasted (Curtis, 2026-09-28): the room as the feed shows it - its title, then its
/// opening words and last few lines, read as the persona that is open. A room this reader may not
/// enter, or one inside another card, is its header alone.
const RoomLinkCard = ({ target }) => {
    const nested = useContext(InRoomCard);
    const ref = parseRingtome(target);
    const parsed = ref && parseSpeakable(ref.seg);
    const author = parsed && parsed.ok ? parsed.root : null;
    const reader = turbolinkReader();
    const owner = usePerson(author);
    const [room, setRoom] = useState(undefined); // undefined looking, else { title, words, published_ms, locked }
    const seg = ref ? ref.seg : null;
    const doc = ref ? ref.doc : null;
    useEffect(() => {
        if (!author || !seg || !doc) return undefined;
        let live = true;
        (async () => {
            const post = await api(`/api/id/${seg}/posts/${doc}`).catch(() => null);
            const said = await apiTextTitled(`/id/${author}/docs/${doc}/body`).catch(() => null);
            if (!live) return;
            const title = (post && post.title) || (said && said.title) || '';
            setRoom({
                title,
                words: said ? said.text : null,
                published_ms: post ? post.published_ms : null,
                locked: !!(post && post.trusted_only) && !said,
            });
        })();
        return () => {
            live = false;
        };
    }, [author, seg, doc]);
    if (!author || !ref) return null;
    const title =
        (room && room.title) ||
        (room && room.locked ? t('postentry.a-private-chat-room', 'a private chat room') : t('postentry.a-chat-room', 'a chat room'));
    const head = html`<a class="rt-room-head" href=${ref.path}>
        <${Icons.room} />
        <span class="rt-room-title">${title}</span>
        <span class="rt-room-owner">${owner.primary}</span>
    </a>`;
    const floor = !nested && reader && room && !room.locked && room.words !== null;
    return html`<div class="rt-room">
        ${head}
        ${floor &&
        html`<${InRoomCard.Provider} value=${true}>
            <${RoomFloor}
                item=${{ author, doc_id: ref.doc, published_ms: room.published_ms }}
                current=${{ root: reader }}
                post=${room.words}
            />
        </${InRoomCard.Provider}>`}
    </div>`;
};
registerRoomCard(RoomLinkCard);

export const PostEntry = ({ item, current, interest, editing, quote, standalone = false }) => {
    const [body, setBody] = useState(undefined);
    const [sealedWords, setSealedWords] = useState('');
    const [wholeThing, setWholeThing] = useState(false);
    const [open, setOpen] = useState(false);
    // Why the last in-place publish was refused, rendered under the composer - see the
    // catch below.
    const [postError, setPostError] = useState(null);
    // Taken down from THIS card, this session: the card retires itself rather than waiting
    // for a page refresh to stop showing a post its owner just watched die. List state
    // upstream still names the row; the next feed read reconciles, and until then null is
    // the truthful render.
    const [gone, setGone] = useState(false);
    // The author's pin, as the card knows it: the header's labels say it, the toggle moves
    // it, and a fresh row from the server wins (PROJECT_PLAN's Peeks, ruling 12).
    // Re-synced from the FACT, never the row object: the page rebuilds its rows on every
    // render, and keying on the object reset the toggle's own state from a row that did not
    // carry the pin yet (Curtis, 2026-09-05: "it darkened for a second, then went back").
    const serverPinned = pinnedByAuthor(item);
    const [pinned, setPinned] = useState(serverPinned);
    useEffect(() => setPinned(serverPinned), [serverPinned]);
    // The words as this reader last CONFIRMED them: after an in-place edit, the session's
    // own buffer - already in hand, already acknowledged by the publish - never a refetch of
    // what the user just typed.
    const [amended, setAmended] = useState(null);
    const itemRef = useRef(null);

    useEffect(() => {
        let live = true;
        // A scheduled draft has no public body yet: its words come from the private door.
        // A share's words may live only on the sharer's node: the hint tells the body
        // door where to ask (2026-09-08) - and on a post sealed "people I trust, and
        // onward" (Contact tags, ruling 7) the sharer is whose trust opens it, so a feed
        // row that came by a share names them too.
        const bodyUrl = item.private_doc
            ? `/api/identity/${item.author}/docs/${item.doc_id}/body`
            : `/id/${item.author}/docs/${item.doc_id}/body${item.via ? `?via=${item.via}` : ''}`;
        apiTextTitled(bodyUrl)
            .then(({ text, title }) => {
                if (!live) return;
                setBody(text);
                if (title) setSealedWords(title);
            })
            .catch(() => live && setBody(null));
        return () => {
            live = false;
        };
    }, [item.author, item.doc_id, item.private_doc, item.kind, item.via]);

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

    // Today the time, another year the year (pure/when.js) - the cards used to drop the year
    // always, so five years of imported posts all read as this year's.
    const when = formatWhen(item.published_ms);
    // A backdated post wears its date a little differently (Curtis, 2026-09-02), and says
    // on hover when it was actually written down.
    const backdated = isBackdated(item);
    const minted = backdated ? formatWhen(item.minted_ms) : null;
    // Its words changed after it went out: the head's stamp past the mint's.
    const edited = !item.scheduled && item.updated_ms && item.minted_ms && item.updated_ms > item.minted_ms;
    // The item's link: the title when there is one, a quiet line at the foot when not. It
    // goes to the post's OWN page (postpage.js) - the per-item page this comment spent
    // months promising took the href over on 2026-08-26, the day after it was built. The
    // permalink's profile-visit-first load keeps the fresh-sync the author-page link used
    // to buy.
    const href = postHref(item.author, item.doc_id);
    // The words as shown: after an in-place edit, the buffer the user just confirmed - not a
    // refetch of what they typed. The item prop's copies are snapshots; a page refresh
    // reconciles everything against the canonical fold anyway.
    // A sealed post's title travels with its words (PROJECT_PLAN's Replies under the
    // author's seal, ruling 5): the public header carries none, and the body door hands
    // the title to whoever it hands the body - so the card knows it the moment the words
    // arrive, and never before.
    const shownBody = amended ? amended.body : body;
    const title = amended ? amended.title : item.title || sealedWords || '';
    // A room's description is Marquee (CHAT.md, ruling 1): rendered as such.
    const bodyFormat = item.format === 'room' ? 'marquee' : item.format;
    const tlProfile = useTurbolinks(shownBody || '', bodyFormat);
    const { lead, cut: leadCut } = leadOf(shownBody || '', emphasis);
    // A book's card always draws its whole table (below), so nothing is ever held back from it.
    const cut = item.format !== 'book' && leadCut;
    // A book's body is its tree, never prose: no lead cut, the card draws the whole table.
    const shown = item.format === 'book' || wholeThing ? shownBody : lead;
    // Whose labels this reader sees: the register and their ledger, both live. The
    // description key is the author's alone here (one description per post); anyone
    // else's description is shown only at 'everyone', as a label.
    const contactRows = useLive(
        () => (current && current.root ? openMirror(current.root).contacts.toArray() : []),
        [current && current.root]
    );
    const factsByRoot = current && current.root ? {} : null;
    if (factsByRoot) for (const c of contactRows || []) factsByRoot[c.root] = c.facts || {};
    // Labels said or retracted from THIS card, this session - the overlay idiom: shown at
    // once, deduped when the dressed rows eventually agree.
    // Content warnings (2026-09-07): the reader's blur and hide lists against the tags the
    // author, the reader, or anyone the reader trusts put on this post. Hidden posts leave
    // the page (their own page shows them blurred - you asked for it by address); blurred
    // ones keep their front matter and veil the rest until clicked through.
    const warnLists = useWarnings(current && current.root);
    const warning = warningFor(item.annotations, {
        author: item.author,
        me: current && current.root,
        factsByRoot,
        blur: warnLists.blur,
        hide: warnLists.hide,
    });
    const [revealed, setRevealed] = useState(false);
    const veiled = !revealed && (warning.kind === 'blur' || (warning.kind === 'hide' && standalone));
    // The foot's parts (see the foot, below): each only where the words are on screen to act on.
    const bodyShown = !!shownBody && !veiled;
    const seeMore = bodyShown && cut && !wholeThing;
    const roomDoor = bodyShown && item.format === 'room';
    // Whether this reader could answer (Curtis, 2026-09-29): not with replies turned off (the settled
    // wish), and not signed out - the front page's visitors. Where they cannot, the foot is just the
    // post's own link rather than an offer that goes nowhere.
    const canReply = !!(current && current.root) && !item.settled;
    const replyWords = item.replies
        ? item.replies === 1
            ? t('postentry.1-reply', '1 reply')
            : t('postentry.n-replies', '{n} replies', { n: item.replies })
        : !seeMore && item.format !== 'room'
          ? canReply
              ? t('postentry.reply', 'reply')
              : t('postentry.link', 'link')
          : null;
    const [saidLabels, setSaidLabels] = useState([]);
    const [retractedLabels, setRetractedLabels] = useState([]);
    const [tagging, setTagging] = useState(false);
    const [tagInput, setTagInput] = useState('');
    const labelKey = (a) => `${a.annotator}:${a.key}:${a.value}`;
    // Enter submits AND unmounts the input, whose blur then submits the same text again
    // (Curtis, 2026-08-31: every tag on another user's post appeared twice until a reload
    // let the server's one row win). One flight at a time; the blur echo lands here.
    const tagInFlight = useRef(false);
    // The reader's own display name, for the overlay chip's byline (Curtis, 2026-08-31:
    // a fresh tag wore the speakable address until a refresh brought the server's
    // dressed row). The mirror's live profile name, the fetched-at-open name behind it -
    // persona.js's usePersonaName, restated here to keep the import graph acyclic.
    const liveMyName = useLive(
        () => (current ? openMirror(current.root).profile.get('name') : Promise.resolve(null)),
        [current && current.root]
    );
    const myName = (liveMyName && liveMyName.value) || (current && current.name) || undefined;
    const addTag = async (raw) => {
        if (tagInFlight.current) return; // the unmount-blur echo of the Enter that just fired
        tagInFlight.current = true;
        setTimeout(() => (tagInFlight.current = false), 0); // outlives the synchronous echo only
        const value = raw.trim().toLowerCase().slice(0, 32); // the input's maxlength, restated
        setTagInput('');
        setTagging(false);
        if (!value || !current) return;
        const me = current.root;
        // Two tags to a person on somebody else's post, and no reaction to your own
        // (Curtis, 2026-09-27) - the node refuses the same, and every reader drops the rest.
        if (!mayTag(shownLabels, { author: item.author, me, value })) return;
        try {
            await api(`/api/identity/${me}/public-annotations/${item.author}/${item.doc_id}`, {
                method: 'PUT',
                body: JSON.stringify({ key: 'tag', value }),
            });
        } catch {
            return; // a refused statement shows nothing - nothing was said
        }
        // Tagging YOUR OWN post also files the tag on the private draft (found by its
        // published_as back-reference): the publish diff restates the DRAFT's annotations,
        // and a public-only tag would be retracted on the next re-post. Best-effort for
        // sync lag only - the draft chain reaches every member device (Curtis, 2026-08-30,
        // correcting this comment's first claim), so the miss is a mirror that has not
        // caught up yet, and the statement stands either way.
        if (me === item.author) {
            try {
                const draft = (await openMirror(me).docs.toArray()).find(
                    (d) => d.fields && d.fields.published_as === item.doc_id
                );
                if (draft) {
                    await api(
                        `/api/identity/${me}/docs/${draft.doc_id}/annotations/tags/${encodeURIComponent(value)}`,
                        { method: 'PUT' }
                    );
                }
            } catch {
                // the public statement is the speech; the filing catch-up can wait
            }
        }
        const said = { annotator: me, annotator_name: myName, key: 'tag', value };
        setSaidLabels((have) =>
            have.some((a) => labelKey(a) === labelKey(said)) ? have : [...have, said]
        );
    };
    const removeLabel = async (a) => {
        if (!current || a.annotator !== current.root) return;
        const me = current.root;
        try {
            await api(
                `/api/identity/${me}/public-annotations/${item.author}/${item.doc_id}/${encodeURIComponent(a.key)}/${encodeURIComponent(a.value)}`,
                { method: 'DELETE' }
            );
        } catch {
            return;
        }
        if (me === item.author && a.key === 'tag') {
            try {
                const draft = (await openMirror(me).docs.toArray()).find(
                    (d) => d.fields && d.fields.published_as === item.doc_id
                );
                if (draft) {
                    await api(
                        `/api/identity/${me}/docs/${draft.doc_id}/annotations/tags/${encodeURIComponent(a.value)}`,
                        { method: 'DELETE' }
                    );
                }
            } catch {
                // as above
            }
        }
        setRetractedLabels((have) => [...have, labelKey(a)]);
    };
    const baseLabels = visibleAnnotations(item.annotations, {
        author: item.author,
        factsByRoot,
        me: current && current.root,
    })
        // The default bucket is the universal truth wearing a chip: every composed post is
        // "in: feed", so the label carries no information and renders as noise (Curtis,
        // 2026-08-30). Hidden at DISPLAY only - the statement still replicates publicly by
        // ruling, and any other bucket ("blog") still shows.
        .filter((a) => !(a.key === 'bucket' && a.value === FEED_STYLE && a.annotator === item.author));
    const shownLabels = [
        ...baseLabels,
        ...saidLabels.filter((a) => !baseLabels.some((b) => labelKey(b) === labelKey(a))),
    ]
        .filter((a) => !retractedLabels.includes(labelKey(a)))
        // A pin is chrome (the chip above), never a label: the author's places the post on their
        // page, and anyone else's places it on THEIR page, beside their share of it (PROJECT_PLAN's
        // Peeks, ruling 11, as amended 2026-09-29).
        .filter((a) => a.key !== PIN_KEY)
        // A mention is machinery, not a label (Curtis, 2026-09-07: comments naming people
        // wore a root hex as a chip): the statement's wire form is the mentioned root, and
        // the card in the words already shows WHO. Hidden at display only - the statement
        // still replicates and rings the bell it names.
        .filter((a) => a.key !== 'mention')
        // The copy chain (2026-09-08) is a list on the post's page, under the replies -
        // never a chip.
        .filter((a) => a.key !== 'provenance')
        // Which note the post came from (2026-09-28) is how a link to that note finds the post -
        // machinery, never a chip.
        .filter((a) => a.key !== 'published_from')
        // The room's own word (Contact tags, ruling 5): "@mentioned", said by the author as
        // a sealed label so the people in the room see why they are there - it dresses
        // the wish chip below, never a chip of its own.
        .filter((a) => a.key !== 'audience');
    // The author's own description is the post's subtitle (Curtis, 2026-10-02): small italics under
    // the title, not an "about" chip among the tags. Anyone else's description stays a label.
    const subtitle = descriptionOf(shownLabels, item.author);
    const chipLabels = subtitle
        ? shownLabels.filter((a) => !(a.key === 'description' && a.annotator === item.author))
        : shownLabels;
    // The list a sealed post is for: the server says it for your own posts; for a post
    // sealed to the people mentioned, the author's own sealed label says it to the room.
    const saidAudience = ((item.annotations || []).find((a) => a.key === 'audience' && a.annotator === item.author) || {}).value;
    const audience = item.audience || saidAudience || '';
    // "People I trust, and onward" (Contact tags, ruling 7): the header says it, to everyone.
    const onward = !!item.onward;

    // After every hook has run (useTurbolinks above is one), never before - a card that
    // skipped hooks while retiring would trip preact's ordering on the re-render.
    if (gone) return null;
    if (warning.kind === 'hide' && !standalone) return null;

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
                <${ViaOthers} item=${item} current=${current} />
                ${t('postentry.passed-this-along', 'passed this along')}
            </p>`}
            ${/* The speculative sibling: nobody you follow brought this - your trust graph
                did (PROJECT_PLAN's Discovery, slice 2). Same seat, same quiet voice, and honest about the
                different mechanism: a vouch is not a share. Mutually exclusive with the
                share line by construction, so the two never stack. */ ''}
            ${!item.via &&
            !!item.suggested_via &&
            html`<p class="feed-entry-via">
                <${PersonChip}
                    root=${item.suggested_via}
                    current=${current}
                    size="mini"
                    profile=${{
                        fields: [
                            item.suggested_via_name && { field: 'name', value: item.suggested_via_name },
                        ].filter(Boolean),
                        via: [],
                    }}
                />
                ${t('postentry.vouches-for-this-author', 'trusts this author')}
            </p>`}
            ${/* The banner, not the chip (2026-08-06): a feed item is a person speaking, and
                the face-plus-names row says who at a glance where the mini heptagon made you
                hover. The when and - for your own posts - the unlock ride its actions slot. */ ''}
            <div class="feed-entry-head">
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
                actions=${html`${item.scheduled
                        ? html`<span class="feed-entry-when feed-entry-scheduled"><${Icons.scheduled} /> ${t('postentry.scheduled-for', 'scheduled for {when}', { when })}</span>`
                        : backdated
                          ? html`<span class="feed-entry-when feed-entry-dated" title=${t('postentry.dated-by-its-author', 'dated by the author, written {minted}', { minted })}>${when} <span class="feed-entry-beats" title=${t('postentry.internet-time', 'internet time')}>${beatLabel(item.published_ms)}</span></span>`
                          : html`<span class="feed-entry-when">${when} <span class="feed-entry-beats" title=${t('postentry.internet-time', 'internet time')}>${beatLabel(item.published_ms)}</span></span>`}
                    ${/* Edited after it went out (Curtis, 2026-10-02: posts edit forever, so an edit says
                        so): when, and the way to every version it has been. */ ''}
                    ${edited &&
                    html`<a class="feed-entry-edited" href=${postHistoryHref(item.author, item.doc_id)} title=${t('postentry.see-every-version', 'see every version of this post')}>${t('postentry.edited-when', 'edited {when}', { when: formatWhen(item.updated_ms) })}</a>`}
                    ${/* The takedown first, after the date: trash is always the leftmost chip, on every
                        row (Curtis, 2026-09-27). Only ever on your own posts, so never beside share. */ ''}
                    ${editing && !open && html`<${UnpublishButton} item=${item} current=${current} onTakenDown=${() => setGone(true)} />`}
                    ${/* No share on a sealed post (Curtis, 2026-09-08): a share moves the pointer,
                        never the key, and that is not what the button promises - unless the
                        author asked for the hop (Contact tags, ruling 7). */ ''}
                    ${!item.mine && !!current && (!item.trusted_only || onward) && html`<${ShareButton} item=${item} current=${current} />`}
                    ${/* A post whose private analogue lives in a NOTEBOOK (any bucket beyond the
                        feed's own) is edited where it lives: "edit" with the note-pencil goes to
                        that note in Writer - or, for a posted drawing, the brush to Drawing (Curtis,
                        2026-09-27) - and the publish bar there says the changes again. A post
                        composed in the feed opens for editing in place, at once: no lock, no
                        wait, and no day after which it can't (Curtis, 2026-10-02 - the lock was
                        confusing, and posts edit forever). */ ''}
                    ${editing &&
                    !open &&
                    (editing.row.buckets || []).some((b) => b !== FEED_STYLE)
                        ? editing.row.format === 'drawing'
                            ? html`<a
                                  class="chip chip-button"
                                  href=${docHref(current.root, editing.row.doc_id)}
                                  title=${t('postentry.edit-this-drawing-in-drawing', 'edit this drawing in hrseDrawing™')}
                              ><${Icons.drawing} /></a>`
                            : html`<a
                                  class="chip chip-button"
                                  href=${docHref(current.root, editing.row.doc_id)}
                                  title=${t('postentry.edit-this-note-in-writer', 'edit this note in hrseWriter™')}
                              ><${Icons.notes} /></a>`
                        : editing &&
                          !open &&
                          html`<button
                              class="chip chip-button"
                              title=${t('postentry.open-this-for-editing', 'open this for editing')}
                              aria-label=${t('postentry.open-this-for-editing', 'open this for editing')}
                              onClick=${() => setOpen(true)}
                          ><${Icons.rename} /></button>`}
                    ${/* Any post of yours - a book and a room too, which have no in-place editor
                        - and any post you pass along (2026-09-29). */ ''}
                    ${!open && !item.private_doc && !!current && !!current.root && pinner(item) === current.root &&
                    html`<${PinButton} item=${item} current=${current} pinned=${pinned} onPinned=${setPinned} />`}
                    ${/* A node administrator's super-pin (2026-09-30): onto the server's front page. */ ''}
                    ${!open && !item.private_doc && !item.trusted_only && item.kind !== 'share' && !!current && html`<${SuperPinChip} item=${item} />`}
                    ${/* The post's address (2026-09-28), just before the copy into notes: pasted
                        in the app it unfolds as this card; pasted outside, it opens. */ ''}
                    ${!open && html`<${CopyLinkChip} path=${href} />`}
                    ${/* Copy into private notes, last on every card (Curtis, 2026-09-08: the
                        same seat on your own posts and other people's). */ ''}
                    ${/* A room is a conversation, not a note (Curtis, 2026-09-18): it does
                        not copy, and it takes no replies (the page hides the thread). */ ''}
                    ${!!current && !!current.root && !open && item.kind !== 'share' && item.format !== 'room' && html`<${CopyButton} item=${item} current=${current} />`}`}
            />
            ${!open &&
            !!title &&
            html`<h2 class="feed-entry-title"><a href=${href}>${item.format === 'room' && !item.im
                ? html`<${RoomTitle}>${title}</${RoomTitle}>`
                : item.format === 'book'
                  ? html`<${BookTitle}>${title}</${BookTitle}>`
                  : title}</a></h2>`}
            ${!open && !!subtitle && html`<p class="feed-entry-subtitle">${subtitle}</p>`}
            </div>
            ${/* The quoted context (PROJECT_PLAN's Replies slice 3): this post is a REPLY, and the
                mini-card names what it answers - which is the whole reason context-free
                "@rando, I disagree" cannot happen here. Suppressed on the thread page
                (quote=false), where nesting under the parent already says it. */ ''}
            ${/* Deeper than depth one, the thread's ROOT first (Curtis, 2026-08-28): the
                conversation's subject above the words these answer - root, then parent,
                then the reply, reading downward like the thread itself. Absent when the
                parent IS the root - one card, not the same card twice. The label is just
                "thread": the card carries the title, and nothing needs saying twice. */ ''}
            ${!!item.thread_root &&
            quote !== false &&
            html`<p class="feed-entry-replyto feed-entry-thread-root">
                ${t('postentry.thread', 'thread')}
                <${MiniPost}
                    author=${item.thread_root.author}
                    doc_id=${item.thread_root.doc_id}
                    title=${item.thread_root.title}
                    published_ms=${item.thread_root.published_ms}
                />
            </p>`}
            ${/* The labels (PROJECT_PLAN's Public annotations, slice 2): the author's own plain, anyone else's
                with the annotator's byline - never an anonymous cloud - and only the
                annotators the reader's display register admits. The author's description
                is the one description; others' descriptions are tags-grade and ride the
                display rule like any label. */ ''}
            ${!!item.reply_to &&
            quote !== false &&
            html`<p class="feed-entry-replyto">
                ${item.reply_to.name
                    ? t('postentry.in-reply-to-name', 'in reply to {name}', { name: item.reply_to.name })
                    : t('postentry.in-reply-to', 'in reply to')}
                <${MiniPost}
                    author=${item.reply_to.author}
                    doc_id=${item.reply_to.doc_id}
                    title=${item.reply_to.title}
                    published_ms=${item.reply_to.published_ms}
                />
            </p>`}
            ${!open && (chipLabels.length > 0 || !!current || item.trusted_only || item.settled || pinned) &&
            html`<div class="feed-entry-labels">
                ${pinned &&
                html`<span class="label-chip label-chip-flag" title=${item.kind === 'share'
                    ? t('postentry.pinned-share-chip-title', 'pinned to the top of the page of the person passing it along')
                    : t('postentry.pinned-chip-title', 'the author pinned this to the top of their page')}><${Icons.pin} /> ${t('postentry.pinned', 'pinned')}</span>`}
                ${/* The author's wishes wear chips of their own, first in the row (Curtis,
                    2026-09-03: "I didn't know that this post was trusted-only") - chrome,
                    not labels: nobody said them, the header did. */ ''}
                ${item.trusted_only &&
                html`<span
                    class="label-chip label-chip-flag"
                    title=${audience === '@mentioned'
                        ? t('postentry.mentioned-chip-title', 'these words are for the people named in them')
                        : onward
                          ? t('postentry.onward-chip-title', 'the author shares these words with people they trust, who may pass them to people they trust')
                          : audience
                            ? t('postentry.audience-chip-title', 'you share these words only with the people you tagged {audience}', { audience })
                            : t('postentry.trusted-only-chip-title', 'the author shares these words only with people they trust')}
                ><${Icons.trustPrivate} /> ${audience === '@mentioned'
                    ? t('postentry.only-the-people-mentioned', 'only the people mentioned')
                    : onward
                      ? t('postentry.trusted-and-onward', 'trusted, and onward')
                      : audience
                        ? t('postentry.only-audience', 'only {audience}', { audience })
                        : t('postentry.trusted-only', 'trusted only')}</span>`}
                ${item.settled &&
                html`<span class="label-chip label-chip-flag" title=${t('postentry.settled-chip-title', 'the author turned off comments on this post')}><${Icons.settled} /> ${t('postentry.no-rebroadcast-or-comment', 'comments off')}</span>`}
                ${groupLabels(chipLabels, { author: item.author }).map((g) => {
                    // One chip per (key, value), worn by everyone who said it: most-agreed
                    // first, names smashed ("Jeff Dorp and 3 others"), and the chip itself
                    // is the agree button when you have not said it yet.
                    const names = g.contributors.map((c) => c.annotator_name || speakable(c.annotator));
                    const mine = current && g.contributors.find((c) => c.annotator === current.root);
                    const canAgree =
                        !!current &&
                        g.key === 'tag' &&
                        !mine &&
                        mayTag(shownLabels, { author: item.author, me: current.root, value: g.value });
                    const soleAuthor =
                        g.contributors.length === 1 && g.contributors[0].annotator === item.author;
                    // A reaction wears its lean (Curtis, 2026-09-27): the glad on green, the
                    // sour on red - the picker's own rows (emoji.js POLE_ROWS).
                    const tone = g.key === 'tag' && isEmojiTag(g.value) ? toneOf(g.value) : null;
                    return html`<span
                        class=${[
                            'label-chip',
                            g.contributors.some((c) => c.annotator === item.author) ? '' : 'label-chip-theirs',
                            canAgree ? 'label-chip-agree' : '',
                            mine ? 'label-chip-mine' : '',
                            tone === 'good' ? 'label-chip-good' : tone === 'bad' ? 'label-chip-bad' : '',
                        ]
                            .filter(Boolean)
                            .join(' ')}
                        key=${`${g.key}:${g.value}`}
                        title=${canAgree
                            ? t('postentry.click-to-agree', '{names} - click to agree', { names: names.join(', ') })
                            : soleAuthor
                              ? t('postentry.the-authors-label', "the author's label")
                              : t('postentry.label-by-name', 'label by {name}', { name: names.join(', ') })}
                        onClick=${canAgree ? () => addTag(g.value) : undefined}
                    >
                        ${g.key === 'bucket' ? html`<span class="label-kind">${t('postentry.in', 'in')}</span>` : ''}
                        ${g.key === 'description' ? html`<span class="label-kind">${t('postentry.about', 'about')}</span>` : ''}
                        ${g.key === 'tag' && isEmojiTag(g.value)
                            ? html`<span class="label-emoji-value">${g.value}</span>`
                            : g.value}
                        ${/* Provenance lives on hover (Curtis, 2026-08-31); the chip face
                            wears only the tag and how many people applied it - a bare chip
                            means one. */ ''}
                        ${g.contributors.length > 1 &&
                        html`<span class="label-count">${g.contributors.length}</span>`}
                        ${!!mine &&
                        html`<button
                            class="label-x"
                            title=${t('postentry.take-this-label-back', 'take this label back')}
                            onClick=${(e) => {
                                e.stopPropagation();
                                removeLabel(mine);
                            }}
                        >×</button>`}
                    </span>`;
                })}
                ${/* Say something about any post - yours or anyone's (PROJECT_PLAN's Public annotations
                    slice 4): the statement lands on YOUR chain, bylined as yours
                    everywhere it travels. */ ''}
                ${!!current &&
                (tagging || tagsLeft(shownLabels, { author: item.author, me: current.root }) > 0) &&
                (tagging
                    ? html`<span class="label-add-anchor"><input
                          class="label-add-input jag-field"
                          maxlength="32"
                          placeholder=${t('postentry.tag-placeholder', 'a tag')}
                          maxlength=${MAX_TAG_CHARS}
                          value=${tagInput}
                          ref=${(el) => el && el.focus()}
                          onInput=${(e) => setTagInput(e.currentTarget.value)}
                          onKeyDown=${(e) => {
                              if (e.key === 'Enter' || e.key === ',') {
                                  e.preventDefault();
                                  addTag(tagInput);
                              }
                              if (e.key === 'Escape') {
                                  setTagInput('');
                                  setTagging(false);
                              }
                          }}
                          onBlur=${() => addTag(tagInput)}
                      />
                      ${(() => {
                          // Typing filters the palette by emoji name (Curtis, 2026-08-31):
                          // "thum" narrows to the thumbs, Enter still says the TEXT as the
                          // tag - the filter is a lens, not a commitment. Underscores in
                          // gemoji names read as spaces so "rolling e" finds roll_eyes.
                          // No palette on your own post: a reaction is for somebody else's.
                          if (current.root === item.author) return '';
                          const q = tagInput.trim().toLowerCase();
                          const hit = ([name]) => !q || name.replace(/_/g, ' ').includes(q);
                          const chip = ([name, ch]) => html`<button
                              class="label-emoji"
                              key=${name}
                              title=${name}
                              onMouseDown=${(e) => e.preventDefault()}
                              onClick=${() => addTag(ch)}
                          >${ch}</button>`;
                          return html`<${EmojiStrip} hit=${hit} chip=${chip} />`;
                      })()}</span>`
                    : html`<button
                          class="label-add"
                          title=${t('postentry.say-what-this-post-is', 'add a label, in your name')}
                          onClick=${() => setTagging(true)}
                      >${t('postentry.plus-tag', '+ tag')}</button>`)}
            </div>`}

            ${open
                ? html`<${Composer}
                      root=${editing.root}
                      docId=${editing.row.doc_id}
                      published=${true}
                      onPost=${async (words) => {
                          // The publish's 200 IS the confirmation; on failure the editor
                          // stays open with the buffer intact, and nothing pretends - but the
                          // REASON shows (2026-08-15): a swallowed refusal reads as a broken
                          // button, and a refusal is something the author needs the words of.
                          try {
                              await editing.post();
                          } catch (e) {
                              setPostError(e.message);
                              return;
                          }
                          setPostError(null);
                          setAmended(words);
                          // The whole thing, not the lead: you just edited it, and a cut
                          // that hid the paragraph you changed read as "the post didn't
                          // update" (Curtis, 2026-09-03). The next page load may cut again.
                          setWholeThing(true);
                          setOpen(false);
                      }}
                      posting=${editing.posting}
                  />
                  ${postError && html`<p class="form-error">${postError}</p>`}`
                : html`${shownBody === undefined && html`<p class="null-sub">…</p>`}
                      ${shownBody === null &&
                      html`<p class="null-sub">
                          ${item.trusted_only
                              ? t('postentry.for-trusted-readers-only', 'the author shares these words only with people they trust')
                              : html`<span class="waiting-dot"></span> ${t('postentry.these-words-havent-reached-this', "these words haven't reached this computer.")}`}
                      </p>`}
                      ${!!shownBody &&
                      veiled &&
                      html`<div class="feed-entry-veil">
                          <div class="feed-entry-body feed-entry-body-veiled" aria-hidden="true">
                              ${bodyFormat === 'marquee'
                                  ? html`<${MarqueeBody} source=${shown} profile=${tlProfile} onUnparsable=${bareSource} />`
                                  : html`<pre class="reader-plain jag-line">${shown}</pre>`}
                          </div>
                          <button class="feed-entry-unveil" onClick=${() => setRevealed(true)}>
                              ${t('postentry.tagged-show-anyway', 'tagged {tags} - show anyway', { tags: warning.tags.join(', ') })}
                          </button>
                      </div>`}
                      ${!!shownBody &&
                      !veiled &&
                      html`<div class="feed-entry-body">
                          ${item.format === 'book'
                              ? html`<${BookCard} book=${parseBook(shown)} author=${item.author} />`
                              : item.format === 'room'
                                ? html`${/* In the post's own paper (Curtis, 2026-09-30): a room's
                                      opening line and its latest, bubbled as a post's words are. */ ''}<div class="reader-marquee jag-line">
                                      <${RoomFloor} item=${item} current=${current} post=${shownBody} />
                                  </div>`
                                : bodyFormat === 'marquee'
                                  ? html`<${MarqueeBody}
                                        source=${shown}
                                        profile=${tlProfile}
                                        onUnparsable=${bareSource}
                                    />`
                                  : html`<pre class="reader-plain jag-line">${shown}</pre>`}
                      </div>`}`}
            ${/* The card's foot (Curtis, 2026-09-27): centred under the post, large and bold, stacking
                whichever apply - "see more…" when something was held back; "enter the room" on a
                room (CHAT.md, ruling 1 - a stranger's shell has no rooms, so the door is the
                sign-in); and the replies: "N replies" whenever this node knows of any ("how many
                replies we THINK exist", honest-partial like the thread it summarizes), titled post
                or not, else "reply" - to the post's own page, where the thread assembles - unless
                "see more…" already stands there. A room takes no replies, so offers none. */ ''}
            ${!open &&
            html`<div class="feed-entry-acts">
                ${seeMore &&
                html`<button class="feed-entry-act" onClick=${() => setWholeThing(true)}>${t('postentry.see-more', 'see more…')}</button>`}
                ${roomDoor &&
                html`<a class="feed-entry-act" href=${roomHref(item.author, item.doc_id)}
                    ><${Icons.room} /> ${t('postentry.enter-the-room', 'enter the room')}</a
                >`}
                ${replyWords && html`<a class="feed-entry-act" href=${href}>${replyWords}</a>`}
            </div>`}
        </article>
    `;
};

// Re-exported for the drafts column's card, which stayed in the feed app.
export { useDocDetail };
