// Chat: real-time rooms (CHAT.md). A room is a post - its title the room's name, its words
// the description, its seal and audience the post's own - and this app lists the rooms a
// persona may see (ruling 7) and opens them. The shape is Slack's, by Curtis's brief
// (2026-09-18): Writer's collapsible, resizable columns, a "chats" column on the left, open
// by default, with the rooms and a "new chat" button; the chosen room on the right under a
// fixed header, its floor scrolling with the newest line at the bottom and pinned there while
// you are at the end, one speaker's run of lines attributed once, the composer fixed to the
// bottom at full width. The room's own post is the first line, said by its creator.
import { h } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { api, apiTextTitled } from '../net.js';
import { t } from '../i18n.js';
import { Icons } from '../icons.js';
import { PersonChip, PersonHex, PersonInline, usePerson } from '../person.js';
import { agoUnit } from '../pure/ago.js';
import { MarqueeBody, bareSource } from '../doc/marqueebody.js';
import { useTurbolinks } from '../doc/turbolinks.js';
import { openMirror, useLive } from '../mirror.js';
import { tagCounts } from '../pure/contacttags.js';
import { contactCollection } from '../pure/contact.js';
import { isEmojiTag, MAX_TAG_CHARS } from '../pure/annotations.js';
import { veilsMedia } from '../pure/chatveil.js';
import { speakable } from '../speakable.js';
import { useColWidths, useColTucks, PaneHead, Rail, TagColumn } from '../panes.js';
import { tagCounts as roomTagCounts } from '../pure/doclist.js';
import { Modal } from '../modal.js';
import { usePref, OPEN_ROOM_KEY } from '../mirror/prefs.js';

/// Whether a trust dial says anything: absent or "none" is a stranger, whatever else a
/// person this reader has placed (Curtis, 2026-09-19: untrusted speakers read small and
/// gray, and may be hidden).
const hasTrust = (v) => !!v && v !== 'none';
/// The preference: hide untrusted speakers' lines in every room this persona reads.
const HIDE_UNTRUSTED_PREF = 'chat.hide-untrusted';
/// Whether some words embed media - a picture, a sound, a clip - by Marquee's two spellings.
/// Whether a line is nothing but emoji (Curtis, 2026-09-19: such a line reads at 150%) - the
/// picker's `:name:` shortcodes and the glyphs themselves, with their modifiers and joiners,
/// and whitespace between; up to a handful, so a wall of them stays a wall.
const EMOJI_ONLY = /^(?:\s|:[a-z0-9_+-]+:|\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?)*)+$/u;
const onlyEmoji = (words) => {
    if (!words || !words.trim() || !EMOJI_ONLY.test(words)) return false;
    const count = (words.match(/:[a-z0-9_+-]+:|\p{Extended_Pictographic}/gu) || []).length;
    return count > 0 && count <= 8;
};
import { EmojiStrip, shortcodeOf, glyphOf, toneOf } from '../emoji.js';
import { leanScale } from '../pure/lean.js';
import { useShared, markShared } from '../shares.js';
import { LiveMarquee } from '../doc/livemarquee.js';
import { useUploadCapture } from '../doc/upload.js';
import { emojiCompletions, linkCompletions, mediaCompletions, mentionCompletions } from '../doc/completions.js';
import { userCardHtml, userSpanHtml, useUserCards } from '../doc/usercard.js';
import { insertNewlineAndIndent } from '@codemirror/commands';
import { ImagePickModal } from '../doc/imagepick.js';
import { pickedReference } from '../doc/pickref.js';
import { DrawingThumb, drawingAsPicture } from '../doc/drawing.js';
import { stickersOf } from '../pure/imagepick.js';
import { togglePick } from '../pure/facets.js';
import { personHref, postHref, roomHref, copyLink, appHref } from '../links.js';
import { RoomTitle } from '../roomtitle.js';

/// Where a room's uploads file (CHAT.md, ruling 11): the chat app's own bucket, beside the
/// rooms - so the `!` picker offers what was said here before.
const CHAT_BUCKET = 'chat';
/// A room's description, at most (Curtis, 2026-09-20): the room post's words, which stand
/// at the top of the floor as the first thing said and ride every card. The wire would take
/// far more - a post's body is capped by the node's document limit - so this is the app's
/// own manners rather than the door's rule: a blurb, not an essay.
const MAX_ROOM_WORDS = 1024;
/// One message's words, at most - the wire's own cap (`ChatMessage::MAX_BODY_BYTES`), in
/// bytes of UTF-8, which is what the door measures. The counter shows past the halfway mark
/// and turns red past the cap, and the send button follows it (Curtis, 2026-09-19: "keep
/// the user unsurprised by the limit").
const MAX_MESSAGE_BYTES = 4096;
const byteLength = (s) => new TextEncoder().encode(s).length;

const html = htm.bind(h);

/// The rooms' drafts live in the app's eponymous bucket, as the feed's do in `feed`.
const CHAT_STYLE = 'chat';
const APP_ID = 'chat';

/// The floor's backstop poll; the socket is what makes it live.
const HISTORY_POLL_MS = 15000;

/// The last floor each room showed, this page-load (Curtis, 2026-09-29: coming back to a room
/// from the feed began empty and waited on a round trip for the history this computer already
/// had). A room comes back as it was left, and the fresh read replaces it a moment later.
const floorsSeen = new Map();

/// How close to the end counts as "at the end" - the pin that keeps a reader at the bottom
/// as new lines land, and lets go the moment they scroll up to read.
const AT_END_PX = 40;

/// A sealed room's name travels with its words (PROJECT_PLAN's Replies under the author's
/// seal, ruling 5): the row asks the body door for it, and reads "a sealed room" until the
/// words arrive - or forever, for a room this reader may not open.
const useRoomWords = (room) => {
    const [words, setWords] = useState({ title: room.title || '', body: undefined });
    useEffect(() => {
        let live = true;
        setWords({ title: room.title || '', body: undefined });
        if (!room.author || !room.doc_id) return undefined;
        const via = room.via ? `?via=${room.via}` : '';
        apiTextTitled(`/id/${room.author}/docs/${room.doc_id}/body${via}`)
            .then(({ text, title }) => live && setWords({ title: title || room.title || '', body: text }))
            .catch(() => live && setWords((w) => ({ ...w, body: null })));
        return () => {
            live = false;
        };
    }, [room.author, room.doc_id, room.title, room.via]);
    return words;
};

const whenWords = (ms) => {
    const ago = agoUnit(ms, Date.now());
    return ago
        ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(ago.value, ago.unit)
        : t('apps.chat.just-now', 'just now');
};

const roomName = (words, room) =>
    words.title ||
    (room && room.title) ||
    (room && room.trusted_only ? t('apps.chat.a-sealed-room', 'a sealed room') : t('apps.chat.an-unnamed-room', 'an unnamed room'));

// ---------------------------------------------------------------------------------------------
// The chats column

/// What a private chat is called (CHAT.md, ruling 12): the other person, as this reader
/// calls them - their nickname when one is set, else the name they answer to now. Never
/// the post's own title, which was minted once and would go stale the day they renamed
/// themselves.
const imName = (person, room) =>
    (person && person.primary) ||
    (room && room.other ? speakable(room.other) : t('apps.chat.a-private-chat', 'a private chat'));

const RoomRow = ({ room, current, selected }) => {
    const loc = useLocation();
    const words = useRoomWords(room);
    // A private chat wears the other person, whichever of the two opened it (CHAT.md,
    // ruling 12): their face, and their name as this reader calls them TODAY - a nickname
    // if one is set, else the name they answer to now, never the title the post was
    // minted with.
    const person = usePerson(room.im && room.other ? room.other : room.author, { current });
    // Every row in this list is a chat, so no row wears a chat icon (Curtis, 2026-09-20):
    // the slot holds the face of whoever opened the room, and the title gets the width.
    // Bold where something was said since this persona last looked (the `rooms_seen`
    // register, synced to every computer); the newest word's time beneath every room.
    const cls = ['chat-row', selected ? 'chat-row-selected' : '', room.unread ? 'chat-row-unread' : ''].filter(Boolean).join(' ');
    return html`<li class=${cls} data-settles onClick=${() => loc.route(roomHref(room.author, room.doc_id))}>
        <span class="chat-row-face" title=${person.primary || speakable(room.author)}>
            <${PersonHex} person=${person} size="small" />
        </span>
        <span class="chat-row-main">
            <span class="chat-row-name">
                ${room.closed && html`<${Icons.settled} />`}
                ${room.trusted_only && html`<${Icons.trustPrivate} />`}
                ${room.im ? person.primary || speakable(room.other || room.author) : html`<${RoomTitle}>${roomName(words, room)}</${RoomTitle}>`}
            </span>
            <span class="chat-row-by">
                <span class="chat-row-when">${room.latest_ms ? whenWords(room.latest_ms) : t('apps.chat.quiet', 'quiet')}</span>
                ${(room.tags || []).map((value) => html`<span class="chat-row-tag" key=${value}>${value}</span>`)}
            </span>
        </span>
    </li>`;
};

const RoomsColumn = ({ current, rooms, selected, onTuck, filtered }) => {
    const loc = useLocation();
    // Active rooms on top, the rooms this persona left beneath a divider (Curtis,
    // 2026-09-19): left rooms are not synced and never bold, until rejoined. Closed rooms
    // sit at the bottom of that pile for everyone - the door sorts them last.
    // Private chats have their own shelf (CHAT.md, ruling 12; Curtis, 2026-09-20): above
    // what was left, below the rooms - they are not rooms one wanders into, and they never
    // close.
    const active = (rooms || []).filter((r) => !r.left && !r.closed && !r.im);
    const ims = (rooms || []).filter((r) => r.im && !r.left && !r.request);
    // A chat somebody opened with a persona who has no relationship with them (Curtis,
    // 2026-09-20): its own pile, beneath the chats and above what was left, where it can be
    // answered. Nothing about it rings, and nothing of it syncs, until it is accepted.
    const requests = (rooms || []).filter((r) => r.im && r.request);
    const left = (rooms || []).filter((r) => !r.im && (r.left || r.closed));
    const row = (r) => html`<${RoomRow}
        key=${`${r.author}/${r.doc_id}`}
        room=${r}
        current=${current}
        selected=${!!selected && selected.author === r.author && selected.doc === r.doc_id}
    />`;
    return html`<aside class="chat-rooms">
        <${PaneHead} icon=${Icons.chat} label=${t('apps.chat.chats', 'chats')} onTuck=${onTuck} />
        <button class="chat-new-btn" data-settles onClick=${() => loc.route(`${appHref('chat')}/new`)}>
            ${t('apps.chat.new-chat', '+ new chat')}
        </button>
        ${rooms && rooms.length === 0
            ? html`<p class="chat-rooms-empty">${filtered ? t('apps.chat.no-chats-wear-those-tags', 'no chats wear those tags') : t('apps.chat.no-rooms-yet-column', 'no chats yet')}</p>`
            : html`<ul class="chat-list">${active.map(row)}</ul>`}
        ${ims.length > 0 &&
        html`<p class="chat-list-divider">${t('apps.chat.ims', 'IMs')}</p>
            <ul class="chat-list">${ims.map(row)}</ul>`}
        ${requests.length > 0 &&
        html`<p class="chat-list-divider">${t('apps.chat.requests', 'requests')}</p>
            <ul class="chat-list chat-list-requests">${requests.map(row)}</ul>`}
        ${left.length > 0 &&
        html`<p class="chat-list-divider">${t('apps.chat.left', 'left')}</p>
            <ul class="chat-list chat-list-left">${left.map(row)}</ul>`}
    </aside>`;
};

// ---------------------------------------------------------------------------------------------
// The new-chat form (fills the right side when "new chat" is chosen)

const NewRoom = ({ root, onMade }) => {
    const [name, setName] = useState('');
    const [words, setWords] = useState('');
    const [audience, setAudience] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    // What the room is about (Curtis, 2026-09-19): the creator's own labels on the room
    // post, said after it is published and shown beside it in every chats column.
    const [roomTags, setRoomTags] = useState([]);
    const [tagInput, setTagInput] = useState('');
    const addRoomTag = (raw) => {
        const value = (raw || '').trim().replace(/,+$/, '');
        setTagInput('');
        if (!value || roomTags.includes(value)) return;
        // The door's own limit, met at the gesture (Curtis, 2026-09-20, having tagged a room
        // with a film script): a chip the door would refuse must never form, or the room is
        // made and the label quietly is not.
        if ([...value].length > MAX_TAG_CHARS) {
            setError(t('apps.chat.a-tag-is-n-characters-at-most', 'a tag is {cap} characters at most', { cap: MAX_TAG_CHARS }));
            return;
        }
        // The room is your own post, and a reaction is for somebody else's (2026-09-27): the
        // door refuses an author's emoji tag, so it is refused here, before the room is made.
        if (isEmojiTag(value)) {
            setError(t('apps.chat.no-reacting-to-your-own-room', "a reaction is for somebody else's post - tag your room with words"));
            return;
        }
        setError(null);
        setRoomTags((have) => [...have, value]);
    };
    const contactRows = useLive(() => (root ? openMirror(root).contacts.toArray() : []), [root]);
    const tags = tagCounts(contactRows || []).map((c) => c.value);
    const make = async () => {
        const title = name.trim();
        if (!title || busy) return;
        setBusy(true);
        setError(null);
        try {
            const made = await api(`/api/identity/${root}/docs`, {
                method: 'POST',
                body: JSON.stringify({ title, body: words, format: 'marquee' }),
            });
            await api(`/api/identity/${root}/docs/${made.doc_id}/buckets/${encodeURIComponent(CHAT_STYLE)}`, { method: 'PUT' });
            const wish =
                audience === ''
                    ? {}
                    : audience === 'trusted'
                      ? { trusted_only: true }
                      : audience === 'onward'
                        ? { trusted_only: true, audience: '@onward' }
                        : { trusted_only: true, audience: audience.slice(4) };
            const posted = await api(`/api/identity/${root}/docs/${made.doc_id}/publish`, {
                method: 'POST',
                body: JSON.stringify({ room: true, tz_offset_min: new Date().getTimezoneOffset(), ...wish }),
            });
            // The labels go on the POST (they travel with it), and a sealed room's seal
            // under its key - the door does both. Best-effort: a refused label costs a
            // label, never the room.
            const said = [...roomTags];
            if (tagInput.trim()) said.push(tagInput.trim());
            const refused = [];
            for (const value of said) {
                try {
                    await api(`/api/identity/${root}/public-annotations/${root}/${posted.post_id}`, {
                        method: 'PUT',
                        body: JSON.stringify({ key: 'tag', value }),
                    });
                } catch {
                    refused.push(value);
                }
            }
            setName('');
            setWords('');
            setRoomTags([]);
            setTagInput('');
            // A label that did not stick is said out loud, and the room still opens: it
            // exists either way, and its post page takes labels like any post's.
            if (refused.length > 0) {
                setError(t('apps.chat.the-room-was-made-but-tags-didnt-stick', 'the room was made, but these tags did not stick: {tags}', { tags: refused.join(', ') }));
            }
            onMade(posted.post_id);
        } catch (e) {
            setError(e.message || String(e));
        } finally {
            setBusy(false);
        }
    };
    return html`<section class="chat-new-pane">
        <header class="chat-room-head">
            <h2 class="chat-room-name">${t('apps.chat.a-new-chat', 'a new chat')}</h2>
        </header>
        <form
            class="chat-new"
            onSubmit=${(e) => {
                e.preventDefault();
                make();
            }}
        >
            <input
                class="chat-new-name"
                placeholder=${t('apps.chat.a-name-for-the-room', 'a name for the room')}
                value=${name}
                onInput=${(e) => setName(e.currentTarget.value)}
            />
            <div class="chat-new-tags">
                ${roomTags.map(
                    (value) => html`<span class="label-chip" key=${value}>
                        ${value}
                        <button
                            class="label-x"
                            type="button"
                            title=${t('apps.chat.take-this-tag-off', 'take this tag off')}
                            onClick=${() => setRoomTags((have) => have.filter((v) => v !== value))}
                        >×</button>
                    </span>`
                )}
                <input
                    class="chat-new-tag"
                    placeholder=${t('apps.chat.a-tag-optional', 'a tag (optional)')}
                    maxlength=${MAX_TAG_CHARS}
                    value=${tagInput}
                    onInput=${(e) => setTagInput(e.currentTarget.value)}
                    onKeyDown=${(e) => {
                        if (e.key === 'Enter' || e.key === ',') {
                            e.preventDefault();
                            addRoomTag(e.currentTarget.value);
                        }
                    }}
                    onBlur=${(e) => addRoomTag(e.currentTarget.value)}
                />
            </div>
            <textarea
                class="chat-new-words"
                placeholder=${t('apps.chat.what-is-it-for', 'what is it for? (optional)')}
                maxlength=${MAX_ROOM_WORDS}
                value=${words}
                onInput=${(e) => setWords(e.currentTarget.value)}
            ></textarea>
            ${words.length > MAX_ROOM_WORDS / 2 &&
            html`<p class="chat-new-count">${words.length} / ${MAX_ROOM_WORDS}</p>`}
            <div class="chat-new-foot">
                <label class="feed-settle">
                    ${t('apps.chat.only-show-to', 'only show to')}
                    <select class="feed-audience jag-field" value=${audience} onChange=${(e) => setAudience(e.currentTarget.value)}>
                        <option value="">${t('apps.chat.everyone', 'everyone')}</option>
                        <option value="onward">${t('apps.chat.people-i-trust-and-onward', 'people I trust, and onward')}</option>
                        <option value="trusted">${t('apps.chat.people-i-trust', 'people I trust')}</option>
                        ${tags.map((tag) => html`<option value=${`tag:${tag}`} key=${tag}>${tag}</option>`)}
                    </select>
                </label>
                <button class="chat-new-go" type="submit" disabled=${busy || !name.trim()}>
                    ${busy ? t('apps.chat.opening', 'opening…') : t('apps.chat.open-a-room', 'open a room')}
                </button>
            </div>
            ${error && html`<p class="form-error">${error}</p>`}
        </form>
    </section>`;
};

// ---------------------------------------------------------------------------------------------
// One room: the header, the floor, the composer

/// The speaker's card at the head of a run: the hex a size up from the chip, and the name
/// this reader calls them (their nickname when one is set, else the display name), inline.
const Speaker = ({ root, current }) => {
    const person = usePerson(root, { current });
    return html`<a class="chat-speaker" href=${personHref(root)}>
        <${PersonHex} person=${person} size="small" />
        <span class="chat-speaker-name">${person.primary || speakable(root)}</span>
    </a>`;
};

/// A picker under a line's menu that would open past the bottom of the room - a line near the end of
/// the floor - opens upward instead, when there is room above (Curtis, 2026-09-28: the pickers opened
/// behind the bottom of the page). Measured again whenever `size` - what the picker holds - changes,
/// since the sticker shelf grows once the mirror answers; it only ever flips up, so it never jumps
/// back and forth under the pointer.
function usePopSide(size) {
    const ref = useRef(null);
    const [up, setUp] = useState(false);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || up) return;
        const floor = el.closest('.chat-floor');
        const bottom = Math.min(floor ? floor.getBoundingClientRect().bottom : window.innerHeight, window.innerHeight);
        const top = floor ? Math.max(floor.getBoundingClientRect().top, 0) : 0;
        const pop = el.getBoundingClientRect();
        const anchor = el.parentElement ? el.parentElement.getBoundingClientRect() : pop;
        if (pop.bottom > bottom && anchor.top - top >= pop.height) setUp(true);
    }, [up, size]);
    return [ref, up ? 'chat-emoji-pop up' : 'chat-emoji-pop'];
}

/// The emoji picker under a line's hover menu (CHAT.md, slice 9): the pole rows, then the
/// whole table, narrowed as you type a name. One click says the emoji.
const EmojiPicker = ({ onPick, onClose }) => {
    const [q, setQ] = useState('');
    const needle = q.trim().toLowerCase();
    const hit = ([name]) => !needle || name.replace(/_/g, ' ').includes(needle);
    const [popRef, popClass] = usePopSide(needle);
    const chip = ([name, ch]) => html`<button
        class="label-emoji"
        key=${name}
        title=${name}
        type="button"
        onMouseDown=${(e) => e.preventDefault()}
        onClick=${() => onPick(ch)}
    >${ch}</button>`;
    return html`<span ref=${popRef} class=${popClass} onMouseDown=${(e) => e.stopPropagation()}>
        <input
            class="chat-emoji-search"
            placeholder=${t('apps.chat.find-an-emoji', 'find an emoji…')}
            value=${q}
            autofocus
            onInput=${(e) => setQ(e.currentTarget.value)}
            onKeyDown=${(e) => {
                if (e.key === 'Escape') onClose();
            }}
        />
        <${EmojiStrip} hit=${hit} chip=${chip} className="chat-emoji-strip" />
    </span>`;
};

/// A sticker said as a reaction (2026-09-28): the words are exactly one picture embed. Its picture's
/// address, or null for an emoji.
const STICKER_WORDS = /^!\[[^\]\n]*\]\(([^()\s]+)\)$/;
const stickerSrc = (words) => {
    const m = STICKER_WORDS.exec(words || '');
    return m ? m[1] : null;
};

/// Stickers this page could not show (2026-09-28): their pictures never arrived - taken back by the
/// person whose sticker it was before this node fetched it, say. Remembered for the page, so every
/// line's pill of it stays hidden rather than each trying and failing again.
const unshowable = new Set();

/// One reaction's pill: the emoji, or the sticker at 48 by 48, and the count past one. A sticker whose
/// picture will not load hides its whole pill, count and all (Curtis, 2026-09-28) - a stack nobody can
/// see is not worth a broken image.
const ReactPill = ({ r, mine, title, onClick }) => {
    const src = stickerSrc(r.emoji);
    const [gone, setGone] = useState(!!src && unshowable.has(src));
    if (gone) return null;
    return html`<button class=${mine ? 'chat-react chat-react-mine' : 'chat-react'} type="button" title=${title} onClick=${onClick}>
        ${src
            ? html`<img
                  class="chat-react-sticker"
                  src=${src}
                  alt=""
                  width="48"
                  height="48"
                  onError=${() => {
                      unshowable.add(src);
                      setGone(true);
                  }}
              />`
            : html`<span class="chat-react-glyph">${glyphOf(r.emoji)}</span>`}${r.count > 1 ? ` ${r.count}` : ''}
    </button>`;
};

/// The sticker picker under a line's hover menu (Curtis, 2026-09-28): your stickers - the pictures
/// and drawings tagged `sticker` (pure/imagepick.js) - narrowed by their other tags. One click says
/// the sticker; a drawing is flattened into a picture first, as the drawing app does.
const StickerPicker = ({ root, onPick, onClose }) => {
    const docs = useLive(() => openMirror(root).docs.toArray(), [root]);
    const [tags, setTags] = useState([]);
    const [busy, setBusy] = useState(null);
    const { stickers, tags: cloud } = stickersOf(docs || [], tags);
    const [popRef, popClass] = usePopSide(stickers.length + cloud.length);
    const choose = async (doc) => {
        if (doc.format !== 'drawing') return onPick(doc.doc_id, doc.format === 'apng' ? 'apng' : 'avif');
        setBusy(doc.doc_id);
        try {
            const flat = await drawingAsPicture(root, doc.doc_id);
            onPick(flat.doc, 'avif');
        } finally {
            setBusy(null);
        }
    };
    return html`<span
        ref=${popRef}
        class=${`${popClass} chat-sticker-pop`}
        onMouseDown=${(e) => e.stopPropagation()}
        onKeyDown=${(e) => e.key === 'Escape' && onClose()}
    >
        ${cloud.length > 0 &&
        html`<span class="imagepick-tags">
            ${cloud.map(
                ([tag, count]) => html`<button
                    key=${tag}
                    type="button"
                    class=${tags.includes(tag) ? 'imagepick-tag active' : 'imagepick-tag'}
                    onClick=${() => setTags(togglePick(tags, tag))}
                >${tag} <span class="imagepick-tag-count">${count}</span></button>`
            )}
        </span>`}
        ${stickers.length === 0
            ? html`<span class="null-sub">${t('apps.chat.no-stickers', 'tag a picture or a drawing "sticker" to react with it')}</span>`
            : html`<span class="chat-sticker-grid">
                  ${stickers.map(
                      (doc) => html`<button
                          key=${doc.doc_id}
                          type="button"
                          class="chat-sticker-choice drawing-floor"
                          title=${doc.title || ''}
                          disabled=${busy === doc.doc_id}
                          onClick=${() => choose(doc)}
                      >${doc.format === 'drawing'
                          ? html`<${DrawingThumb} root=${root} doc=${doc} />`
                          : doc.media.has_thumb && html`<img src=${`/api/identity/${root}/docs/${doc.doc_id}/thumb?v=${doc.head}`} alt="" />`}</button>`
                  )}
              </span>`}
    </span>`;
};

/// One line on the floor. `cont` is a line by the same speaker as the one before it: the
/// speaker is implied, so it wears no card (IRC's and Slack's run-of-lines). Hovering a
/// line shows its menu (CHAT.md, slice 9): the smiley opens the emoji picker; a line of
/// one's own also offers edit and delete, which slice 8 will wire. The emoji said in answer
/// stack under the words, most-said first, who on hover.
/// A moderation act, said in the room (CHAT.md, ruling 8): not talk, so it reads as its own
/// quiet line with both people named, and wears no menu.
/// The four acts a notice can carry, as the door names them, and how each reads here.
const NOTICE_WORDS = {
    muted: () => t('apps.chat.muted', 'muted'),
    unmuted: () => t('apps.chat.unmuted', 'unmuted'),
    deputized: () => t('apps.chat.deputized', 'deputized'),
    undeputized: () => t('apps.chat.undeputized', 'took the badge back from'),
};
const BADGE_NOTICES = ['deputized', 'undeputized'];
const NoticeLine = ({ m, current }) => html`<li class="chat-line chat-line-notice">
    ${BADGE_NOTICES.includes(m.notice) ? html`<${Icons.deputy} />` : html`<${Icons.mute} />`}
    <${PersonChip} root=${m.speaker} current=${current} />
    <span>${(NOTICE_WORDS[m.notice] || NOTICE_WORDS.muted)()}</span>
    <${PersonChip} root=${m.notice_subject} current=${current} />
</li>`;

const Line = ({ m, current, cont, onReact, untrusted, veil, onEdit, onDelete, onMute, hushed, found, room }) => {
    const profile = useTurbolinks(m.words || '', 'marquee');
    const [picking, setPicking] = useState(false);
    const [stickering, setStickering] = useState(false);
    const when = new Date(m.said_ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const mine = !!current && current.root === m.speaker;
    const whoSaid = (r) => r.who.map((w) => w.name || speakable(w.root)).join(', ');
    // A speaker this reader has not placed reads small and gray: present, unimportant. Their
    // media wears the feed's veil until clicked (Curtis, 2026-09-19: "baddies might want to
    // pop on to a chat channel and drop in nasty images or sounds").
    // The two are separate questions (Curtis, 2026-09-20): in a chat for two, nobody reads
    // gray - there is one other person in it and they are who you opened it with - but the
    // veil is about what arrives unasked, and a stranger's picture arrives unasked wherever
    // it is said. So `untrusted` dresses the line and `veil` decides the media, and a
    // private chat with no trust in it takes the second without the first.
    const cls = ['chat-line', cont ? 'chat-line-cont' : '', untrusted ? 'chat-line-untrusted' : '', onlyEmoji(m.words) ? 'chat-line-emoji' : ''].filter(Boolean).join(' ');
    const [revealed, setRevealed] = useState(false);
    const veiled = veil && !revealed;
    // The line's lean (pure/lean.js): bigger for every glad reaction on it, smaller for every sour.
    let glad = 0;
    let sour = 0;
    for (const r of m.reactions || []) {
        if (stickerSrc(r.emoji)) continue; // a sticker has no tone
        const tone = toneOf(glyphOf(r.emoji));
        if (tone === 'good') glad += r.count;
        if (tone === 'bad') sour += r.count;
    }
    const lean = leanScale(glad, sour);
    return html`<li
        class=${found ? `${cls} chat-line-found` : cls}
        style=${lean === 1 ? undefined : `--lean: ${lean}`}
        data-line=${m.hash}
        title=${untrusted ? t('apps.chat.someone-you-dont-trust', "someone you don't trust") : undefined}
    >
        ${!cont &&
        html`<div class="chat-line-head">
            <${Speaker} root=${m.speaker} current=${current} />
            <span class="chat-line-when">${when}</span>
            ${m.edited && html`<span class="chat-line-edited">${t('apps.chat.edited', '(edited)')}</span>`}
        </div>`}
        ${!!onReact &&
        !hushed &&
        html`<span class="chat-line-menu">
            <button class="chat-line-act" type="button" title=${t('apps.chat.react-with-an-emoji', 'react with an emoji')} onClick=${() => setPicking((p) => !p)}>
                <${Icons.smiley} />
            </button>
            <button
                class="chat-line-act"
                type="button"
                title=${t('apps.chat.react-with-a-sticker', 'react with a sticker')}
                onClick=${() => {
                    setPicking(false);
                    setStickering((p) => !p);
                }}
            ><${Icons.sticker} /></button>
            ${/* This line's address (2026-09-28): pasted in the app it unfolds for the room's
                members, and for nobody else. */ ''}
            ${room &&
            html`<button
                class="chat-line-act"
                type="button"
                title=${t('apps.chat.copy-link', 'copy link')}
                onClick=${() => copyLink(roomHref(room.author, room.doc, m.hash)).catch(() => {})}
            ><${Icons.link} /></button>`}
            ${mine &&
            html`<button class="chat-line-act" type="button" title=${t('apps.chat.edit-this-line', 'edit')} onClick=${() => onEdit && onEdit(m)}><${Icons.rename} /></button>
                <button class="chat-line-act chat-line-act-danger" type="button" title=${t('apps.chat.delete-this-line', 'delete')} onClick=${() => onDelete && onDelete(m)}><${Icons.trash} /></button>`}
            ${!mine &&
            !!onMute &&
            html`<button
                class="chat-line-act chat-line-act-danger"
                type="button"
                title=${t('apps.chat.mute-this-person', 'mute this person in the room')}
                onClick=${() => onMute(m.speaker)}
            ><${Icons.mute} /></button>`}
            ${stickering &&
            html`<${StickerPicker}
                root=${current.root}
                onClose=${() => setStickering(false)}
                onPick=${(doc, ext) => {
                    setStickering(false);
                    onReact(m.hash, `![sticker](/api/identity/${current.root}/docs/${doc}/body/sticker.${ext})`);
                }}
            />`}
            ${picking &&
            html`<${EmojiPicker}
                onClose=${() => setPicking(false)}
                onPick=${(glyph) => {
                    setPicking(false);
                    const code = shortcodeOf(glyph);
                    if (code) onReact(m.hash, code);
                }}
            />`}
        </span>`}
        <div class="chat-line-body" title=${cont ? when : undefined}>
            ${m.words === null
                ? html`<span class="chat-msg-sealed"><${Icons.trustPrivate} /> ${t('apps.chat.sealed-words-you-cannot-open', 'sealed words this computer cannot open')}</span>`
                : veiled
                  ? html`<div class="feed-entry-veil chat-line-veil">
                        <div class="feed-entry-body feed-entry-body-veiled" aria-hidden="true">
                            <${MarqueeBody} source=${m.words} profile=${profile} onUnparsable=${bareSource} />
                        </div>
                        <button class="feed-entry-unveil" type="button" onClick=${() => setRevealed(true)}>
                            ${t('apps.chat.media-from-someone-you-dont-trust', "media from someone you don't trust - click to see")}
                        </button>
                    </div>`
                  : html`<${MarqueeBody} source=${m.words} profile=${profile} onUnparsable=${bareSource} />`}
            ${(m.reactions || []).length > 0 &&
            html`<span class="chat-reacts">
                ${m.reactions.map((r) => {
                    // A pill you are in takes yours back; one you are not says it too.
                    const mine = r.who.some((w) => !!current && w.root === current.root);
                    return html`<${ReactPill}
                        key=${r.emoji}
                        r=${r}
                        mine=${mine}
                        title=${mine ? t('apps.chat.who-said-click-to-take-yours-back', '{who} - click to take yours back', { who: whoSaid(r) }) : whoSaid(r)}
                        onClick=${() => onReact && onReact(m.hash, r.emoji, mine)}
                    />`;
                })}
            </span>`}
        </div>
    </li>`;
};

const Room = ({ current, author, doc, onSeen, onChanged, admin, at }) => {
    const root = current && current.root;
    const loc = useLocation();
    const [room, setRoom] = useState(undefined); // undefined loading, null refused, object entered
    const [refusal, setRefusal] = useState('');
    const [history, setHistory] = useState(null); // { items, closed, more }
    // Which history read is newest: an answer that set out before another one already shown is
    // dropped (2026-09-29: the poll's read, begun just before a line landed, finished after the
    // live lane's read and took the line back off the floor until the next thing was said).
    const readsAsked = useRef(0);
    const readShown = useRef(0);
    const floorOf = useRef('');
    floorOf.current = `${root}/${author}/${doc}`;
    const [older, setOlder] = useState(false); // an earlier page on its way
    const [archiving, setArchiving] = useState(false);
    // Passing a room along (Curtis, 2026-09-19): a room is a post, and a rebroadcast is how
    // one travels past the people who already follow its creator. The post's own rule
    // decides who may - a sealed room does not pass along, a sealed-and-onward one does,
    // one hop, for a reader who can read it - and one's own room is published, not shared.
    const [sharing, setSharing] = useState(false);
    const shared = useShared(root, author, doc);
    // `room` is undefined while the door is answering, so this reads it defensively: it sits
    // among the hooks, above the loading guard, where the header's own reads do not.
    const mayShare = !!room && !room.mine && (!room.trusted_only || room.onward);
    const passAlong = async () => {
        if (sharing || shared === null) return;
        setSharing(true);
        const next = !shared;
        try {
            await api(`/api/identity/${root}/rebroadcasts`, {
                method: 'POST',
                body: JSON.stringify({ author, doc_id: doc, ...(next ? {} : { retract: true }) }),
            });
            markShared(root, author, doc, next);
        } catch (e) {
            setSendError(e.message || String(e));
        } finally {
            setSharing(false);
        }
    };
    // The owner's two powers (CHAT.md, ruling 10; slice 7): close is the settled wish on the
    // room post, set through the publish door with the room's own draft - and one-way, as a
    // re-publish carries the wish forward: the conversation ended, and the record stands;
    // delete is the takedown every post has, confirmed in the house modal.
    const [deleting, setDeleting] = useState(false);
    const [going, setGoing] = useState(false);
    const [closing, setClosing] = useState(false);
    const myDocs = useLive(() => (root ? openMirror(root).docs.toArray() : []), [root]);
    const roomDraft = (myDocs || []).find((d) => (d.fields || {}).published_as === doc);
    // Who this reader trusts, off the contacts mirror (Curtis, 2026-09-19): a speaker with
    // no trust placed reads small and gray, and the preference hides them outright. The
    // reader trusts themself, and the room's creator opened the door - both stand.
    // The other half of a private chat (ruling 12), read among the hooks: `room` is
    // undefined while the door answers, and this must be asked at every render either way.
    const other = usePerson((room && room.im && room.other) || null, { current });
    const contacts = useLive(() => (root ? openMirror(root).contacts.toArray() : []), [root]);
    const trustOf = new Map((contacts || []).map((c) => [c.root, (c.facts || {}).trust]));
    const trusted = (speaker) => speaker === root || speaker === author || hasTrust(trustOf.get(speaker));
    const [hideUntrusted, setHideUntrusted] = usePref(root, HIDE_UNTRUSTED_PREF, '');
    // The trust filter has no say in a private chat (CHAT.md, ruling 12; Curtis,
    // 2026-09-20): an IM is one person's words, and hiding them would leave a conversation
    // with nothing in it. The tool goes with the rule.
    const isIm = !!room && !!room.im;
    const hiding = hideUntrusted === 'yes' && !isIm;
    const keepOffset = useRef(null); // the floor's height before older lines landed
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [sendError, setSendError] = useState(null);
    const [typing, setTyping] = useState([]);
    // Editing (CHAT.md, slice 8): the line's words load into the composer, and the next
    // send says them again as an edit naming the line - a new entry, never a change to the
    // old one. Deleting asks first, then says the one word "deleted" naming the line.
    const [editingLine, setEditingLine] = useState(null);
    const [deletingLine, setDeletingLine] = useState(null);
    const [chatters, setChatters] = useState(null);
    const chattersRef = useRef(null); // the `@` picker reads the latest roster per pop
    const socket = useRef(null);
    const typingSaid = useRef(0);
    const typingIdle = useRef(null);
    const floor = useRef(null);
    const atEnd = useRef(true);
    const seen = useRef({ written: 0, at: 0, timer: null });
    // The composer is the post composer's surface (ruling 11): Marquee live, the colon
    // emoji picker, the bang media picker over the chat bucket, the at picker, and uploads
    // by chip, drop or paste - the say door bakes what the words embed.
    const cursor = useRef(null);
    const sendRef = useRef(null);
    // The live preview dresses a user card as the person (Curtis, 2026-09-18: "@pete"
    // rendered in the post composer and not here) - the same directive, span and faces the
    // Writer's editor hands its surface, rebuilt as the faces land.
    const tlProfile = useTurbolinks(draft, 'marquee');
    const facesGen = useUserCards(draft, 'marquee');
    const composerProfile = useMemo(
        () => ({ ...tlProfile, directive: userCardHtml, span: userSpanHtml, faces: facesGen }),
        [tlProfile, facesGen]
    );
    // The `@` picker knows the room (CHAT.md, slice 6): who has spoken here comes first.
    const completions = useMemo(
        () => [
            emojiCompletions,
            linkCompletions(root, CHAT_BUCKET),
            mediaCompletions(root, CHAT_BUCKET),
            mentionCompletions(root, () => (chattersRef.current || []).map((c) => ({ root: c.root, name: c.name || '' }))),
        ],
        [root]
    );
    const keys = useMemo(
        () => [
            // Enter sends, Shift-Enter breaks a line (CHAT.md, ruling 7).
            {
                key: 'Enter',
                run: () => {
                    if (sendRef.current) sendRef.current();
                    return true;
                },
            },
            { key: 'Shift-Enter', run: insertNewlineAndIndent },
        ],
        []
    );
    const {
        catchDrop,
        allowFileDrag,
        catchPaste,
        extras: uploadExtras,
    } = useUploadCapture({
        root,
        bucket: CHAT_BUCKET,
        format: 'marquee',
        body: draft,
        setBody: setDraft,
        touched: () => {},
        cursorPos: () => cursor.current,
        onRefused: (message) => setSendError(message),
    });
    // The upload button (Curtis, 2026-09-28): each file goes into the room as a line of its own,
    // as "add picture" sends one - once the node has processed it, since a room refuses media
    // still being prepared. Drop and paste still write into the draft; only the button sends.
    // Its own capture, writing into a scratch buffer rather than the draft.
    const [directBody, setDirectBody] = useState('');
    const [landing, setLanding] = useState([]); // [{ docId, since }] uploaded, not yet processed
    const sentLanded = useRef(new Set());
    const { pickFiles: pickAndSend, extras: sendExtras } = useUploadCapture({
        root,
        bucket: CHAT_BUCKET,
        format: 'marquee',
        body: directBody,
        setBody: setDirectBody,
        touched: () => {},
        cursorPos: () => null,
        onRefused: (message) => setSendError(message),
        onUploadedDoc: (docId) => setLanding((l) => [...l, { docId, since: Date.now() }]),
    });
    // What the floor showed is what this persona has seen (Curtis, 2026-09-18): the newest
    // stamp goes to the `rooms_seen` register, throttled, and the column un-bolds the room.
    useEffect(() => {
        if (!root || !history || !history.items.length) return undefined;
        if (room && room.left) return undefined; // a left room is not this persona's to catch up on
        const newest = Math.max(...history.items.map((m) => m.said_ms));
        if (newest <= seen.current.written) return undefined;
        const write = () => {
            seen.current.written = newest;
            seen.current.at = Date.now();
            api(`/api/identity/${root}/private/kv/rooms_seen/${author}:${doc}`, {
                method: 'PUT',
                body: JSON.stringify({ value: String(newest) }),
            })
                .then(() => onSeen && onSeen(author, doc, newest))
                .catch(() => {});
        };
        const wait = SEEN_THROTTLE_MS - (Date.now() - seen.current.at);
        if (wait <= 0) write();
        else {
            if (seen.current.timer) clearTimeout(seen.current.timer);
            seen.current.timer = setTimeout(write, wait);
        }
        return undefined;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [history]);

    useEffect(() => {
        if (!root) return undefined;
        let live = true;
        setRoom(undefined);
        setHistory(floorsSeen.get(`${root}/${author}/${doc}`) || null);
        atEnd.current = true;
        api(`/api/identity/${root}/rooms/${author}/${doc}`)
            .then((r) => live && setRoom(r))
            .catch((e) => {
                if (!live) return;
                setRefusal(e.message || '');
                setRoom(null);
            });
        return () => {
            live = false;
        };
    }, [root, author, doc]);
    const words = useRoomWords({ author, doc_id: doc, title: (room && room.title) || '' });

    const readHistory = () => {
        if (!root) return;
        // Landed on a line's own address (Curtis, 2026-09-20): the page it sits on, rather
        // than the newest - the conversation as it was when that was said.
        const where = at ? `?at=${at}` : '';
        const asked = ++readsAsked.current;
        const floorKey = `${root}/${author}/${doc}`;
        api(`/api/identity/${root}/rooms/${author}/${doc}/messages${where}`)
            .then((h) => {
                if (asked < readShown.current) return; // a newer read is already on the floor
                if (floorKey !== floorOf.current) return; // the page has moved to another room
                readShown.current = asked;
                if (!at) floorsSeen.set(floorKey, h);
                setHistory(h);
            })
            .catch(() => {});
        api(`/api/identity/${root}/rooms/${author}/${doc}/chatters`)
            .then((c) => {
                chattersRef.current = c.items || [];
                setChatters(c.items || []);
            })
            .catch(() => {});
    };
    // What this computer already holds, at once - beside the room's own details rather than after
    // them (Curtis, 2026-09-29: the floor waited on one round trip, then another).
    useEffect(() => {
        if (root) readHistory();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [root, author, doc]);
    useEffect(() => {
        if (!root || !room) return undefined;
        // Then the pull from the creator's node, and what it brought (Curtis, 2026-09-29: over
        // the real internet the pull takes seconds, and the room sat empty behind it with no
        // word of why).
        api(`/api/identity/${root}/rooms/${author}/${doc}/sync`, { method: 'POST' })
            .catch(() => {})
            .then(readHistory);
        const interval = setInterval(readHistory, HISTORY_POLL_MS);
        return () => clearInterval(interval);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [root, author, doc, !!room]);
    // The live lane (CHAT.md, ruling 5): the room's socket says when the floor moved and
    // who is here; it reconnects with backoff, and the poll above is the backstop.
    useEffect(() => {
        if (!root || !room || room.left) return undefined; // no live lane for a left room
        let stopped = false;
        let retry = 1000;
        const connect = () => {
            if (stopped) return;
            const proto = location.protocol === 'https:' ? 'wss' : 'ws';
            const ws = new WebSocket(`${proto}://${location.host}/api/identity/${root}/rooms/${author}/${doc}/live`);
            socket.current = ws;
            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'message') readHistory();
                    if (msg.type === 'presence') setTyping((msg.typing || []).filter((r) => r !== root));
                    retry = 1000;
                } catch {
                    /* a bad frame is ignored; the poll still runs */
                }
            };
            ws.onclose = () => {
                socket.current = null;
                if (stopped) return;
                setTimeout(connect, retry);
                retry = Math.min(retry * 2, 15000);
            };
            ws.onerror = () => ws.close();
        };
        connect();
        return () => {
            stopped = true;
            if (socket.current) socket.current.close();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [root, author, doc, !!room]);

    // Scroll-back (CHAT.md, ruling 6): past the top of what the floor holds, the page
    // before it - from this node's memo, or from the room's archive when this node keeps
    // only the budget. The floor keeps its place while the older lines land above it.
    const readOlder = () => {
        if (!root || older || !history || !history.more || !history.items.length) return;
        const oldest = Math.min(...history.items.map((m) => m.said_ms));
        setOlder(true);
        api(`/api/identity/${root}/rooms/${author}/${doc}/messages?before_ms=${oldest}`)
            .then((page) => {
                const el = floor.current;
                keepOffset.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
                const held = new Set(history.items.map((m) => m.hash));
                const fresh = (page.items || []).filter((m) => !held.has(m.hash));
                setHistory((h) => h && { ...h, items: [...h.items, ...fresh], more: !!page.more && fresh.length > 0 });
            })
            .catch(() => {})
            .finally(() => setOlder(false));
    };
    // The pin: at the end before the floor changed, at the end after.
    const trackEnd = () => {
        const el = floor.current;
        if (!el) return;
        atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < AT_END_PX;
        if (el.scrollTop < AT_END_PX) readOlder();
    };
    // The found line, brought into view and marked once its page is on the floor.
    useEffect(() => {
        if (!at || !history) return;
        atEnd.current = false;
        const el = floor.current && floor.current.querySelector(`[data-line="${at}"]`);
        if (el) el.scrollIntoView({ block: 'center' });
    }, [at, history]);
    useEffect(() => {
        const el = floor.current;
        if (!el) return;
        if (at) return; // a landing holds its place; the pin is for the living end
        if (keepOffset.current) {
            el.scrollTop = el.scrollHeight - keepOffset.current.height + keepOffset.current.top;
            keepOffset.current = null;
        } else if (atEnd.current) el.scrollTop = el.scrollHeight;
    }, [history, words.body, typing, at]);
    // The full-sync button (ruling 6): the node's operator makes this node keep the room
    // whole, or lets the budget apply again.
    const setArchive = async (on) => {
        if (archiving) return;
        setArchiving(true);
        try {
            await api(`/api/identity/${root}/rooms/${author}/${doc}/archive`, { method: on ? 'POST' : 'DELETE' });
            setRoom((r) => r && { ...r, archived: on, archivist: on || r.mine });
            if (on) readHistory();
        } catch {
            /* the header shows what stands */
        } finally {
            setArchiving(false);
        }
    };

    // "Typing" is said at most every two seconds while the keys move, and "stopped" three
    // seconds after they rest, or the moment the draft empties or sends.
    const sayTyping = (on) => {
        const ws = socket.current;
        if (!ws || ws.readyState !== 1) return;
        const now = Date.now();
        if (typingIdle.current) clearTimeout(typingIdle.current);
        typingIdle.current = null;
        if (on) {
            typingIdle.current = setTimeout(() => sayTyping(false), 3000);
            if (now - typingSaid.current < 2000) return;
            typingSaid.current = now;
        } else {
            if (!typingSaid.current) return;
            typingSaid.current = 0;
        }
        ws.send(JSON.stringify({ typing: on }));
    };
    const draftBytes = byteLength(draft);
    const overLong = draftBytes > MAX_MESSAGE_BYTES;
    const send = async () => {
        const said = draft.trim();
        if (!said || sending || overLong) return;
        setSending(true);
        setSendError(null);
        try {
            await api(`/api/identity/${root}/rooms/${author}/${doc}/messages`, {
                method: 'POST',
                body: JSON.stringify(editingLine ? { words: said, edits: editingLine.hash } : { words: said }),
            });
            setDraft('');
            setEditingLine(null);
            sayTyping(false);
            atEnd.current = true; // your own line always brings you to the end
            readHistory();
        } catch (e) {
            setSendError(e.message || String(e));
        } finally {
            setSending(false);
        }
    };
    sendRef.current = send;
    // The image picker (Curtis, 2026-09-27): a picture or a drawing of yours goes into the room at
    // once, as a line of its own - the draft left as it was. The say bakes it as it bakes an
    // attachment: a public twin, sealed under the room's key in a sealed room (CHAT.md ruling 11).
    const [picking, setPicking] = useState(false);
    const sendPicked = async (pick) => {
        setPicking(false);
        setSending(true);
        setSendError(null);
        try {
            const words = await pickedReference(root, pick, 'marquee');
            await api(`/api/identity/${root}/rooms/${author}/${doc}/messages`, {
                method: 'POST',
                body: JSON.stringify({ words }),
            });
            atEnd.current = true;
            readHistory();
        } catch (e) {
            setSendError(e.message || String(e));
        } finally {
            setSending(false);
        }
    };
    // Each uploaded file, watched until the node has processed it, then sent as its own line. The
    // document is watched, not the upload window - closing the window loses nothing.
    useEffect(() => {
        if (!landing.length) return undefined;
        let live = true;
        const tick = setInterval(async () => {
            for (const item of landing) {
                if (sentLanded.current.has(item.docId)) continue;
                try {
                    const d = await api(`/api/identity/${root}/docs/${item.docId}`);
                    if (!live) return;
                    if (d && d.media) {
                        // Claimed before the send, so the next tick cannot send it twice; a send
                        // the room refuses ("still being prepared") lets go, to try again.
                        sentLanded.current.add(item.docId);
                        try {
                            const words = await pickedReference(
                                root,
                                { doc: item.docId, format: d.format, title: d.title, animation: !!d.media.animation },
                                'marquee'
                            );
                            await api(`/api/identity/${root}/rooms/${author}/${doc}/messages`, {
                                method: 'POST',
                                body: JSON.stringify({ words }),
                            });
                        } catch (e) {
                            sentLanded.current.delete(item.docId);
                            throw e;
                        }
                        if (!live) return;
                        setLanding((l) => l.filter((x) => x.docId !== item.docId));
                        setDirectBody('');
                        atEnd.current = true;
                        readHistory();
                    } else if (Date.now() - item.since > 10 * 60 * 1000) {
                        setLanding((l) => l.filter((x) => x.docId !== item.docId));
                        setSendError(t('apps.chat.upload-never-finished', 'that upload never finished processing - try it again'));
                    }
                } catch {
                    // not ready, or a blip: the next tick looks again, until the ten minutes are up
                    if (Date.now() - item.since > 10 * 60 * 1000) {
                        setLanding((l) => l.filter((x) => x.docId !== item.docId));
                        setSendError(t('apps.chat.upload-never-finished', 'that upload never finished processing - try it again'));
                    }
                }
            }
        }, 1000);
        return () => {
            live = false;
            clearInterval(tick);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [landing, root]);
    const beginEdit = (m) => {
        setEditingLine({ hash: m.hash, words: m.words || '' });
        setDraft(m.words || '');
    };
    const cancelEdit = () => {
        setEditingLine(null);
        setDraft('');
    };
    const deleteLine = async () => {
        const m = deletingLine;
        if (!m) return;
        try {
            await api(`/api/identity/${root}/rooms/${author}/${doc}/messages`, {
                method: 'POST',
                body: JSON.stringify({ words: 'deleted', deletes: m.hash }),
            });
            readHistory();
        } catch (e) {
            setSendError(e.message || String(e));
        } finally {
            setDeletingLine(null);
        }
    };
    const leave = async () => {
        try {
            await api(`/api/identity/${root}/rooms/${author}/${doc}`, { method: 'DELETE' });
        } catch {
            /* the list re-reads on the next look */
        }
        if (onChanged) onChanged();
        loc.route(appHref('chat'));
    };
    const closeRoom = async () => {
        if (!roomDraft || closing) return;
        setClosing(true);
        try {
            await api(`/api/identity/${root}/docs/${roomDraft.doc_id}/publish`, { method: 'POST', body: JSON.stringify({ settled: true }) });
            setRoom((r) => r && { ...r, closed: true });
            readHistory();
            if (onChanged) onChanged();
        } catch (e) {
            setSendError(e.message || String(e));
        } finally {
            setClosing(false);
        }
    };
    // A reaction (slice 9): an emoji said in answer to a line - a message on this persona's
    // own chain that names the line, stacked under it by the door.
    const react = async (hash, code, retract = false) => {
        // A sticker just flattened from a drawing is a moment from being bakeable: the room says
        // "still being prepared", and the sticker is said again shortly rather than refused.
        const fresh = !retract && code.startsWith('![') && code.includes('/api/identity/');
        for (let tries = 0; ; tries++) {
            try {
                await api(`/api/identity/${root}/rooms/${author}/${doc}/messages`, {
                    method: 'POST',
                    body: JSON.stringify({ words: code, reacts_to: hash, retract }),
                });
                readHistory();
                return;
            } catch (e) {
                if (fresh && e.status === 400 && tries < 12) {
                    await new Promise((r) => setTimeout(r, 800));
                    continue;
                }
                setSendError(e.message || String(e));
                return;
            }
        }
    };
    // The creator's moderation (CHAT.md, ruling 8): a label on the room post, and a line in
    // the room saying so. The door does both; here it is one click.
    const setDeputy = async (who, on) => {
        try {
            await api(`/api/identity/${root}/rooms/${author}/${doc}/deputies/${who}`, { method: on ? 'POST' : 'DELETE' });
            setRoom((r) => r && { ...r, deputies: on ? [...(r.deputies || []), who] : (r.deputies || []).filter((d) => d !== who) });
            readHistory();
        } catch (e) {
            setSendError(e.message || String(e));
        }
    };
    const setMuted = async (who, on) => {
        try {
            await api(`/api/identity/${root}/rooms/${author}/${doc}/mutes/${who}`, { method: on ? 'POST' : 'DELETE' });
            setRoom((r) => r && { ...r, muted: on ? [...(r.muted || []), who] : (r.muted || []).filter((m) => m !== who) });
            readHistory();
        } catch (e) {
            setSendError(e.message || String(e));
        }
    };
    const takeDown = async () => {
        setGoing(true);
        try {
            await api(`/api/identity/${root}/posts/${doc}`, { method: 'DELETE' });
            if (onChanged) onChanged();
            loc.route(appHref('chat'));
        } catch (e) {
            setSendError(e.message || String(e));
            setGoing(false);
            setDeleting(false);
        }
    };
    // The way out of a private chat (CHAT.md, ruling 12): there is nobody to appeal to and
    // nothing to moderate, so the one honest power is to block them - the ordinary contact
    // block, said on this persona's own ledger and never to them.
    const [blocking, setBlocking] = useState(false);
    const blockThem = async () => {
        const them = room && room.other;
        if (!them) return;
        try {
            await api(`/api/identity/${root}/private/kv/${encodeURIComponent(contactCollection(them))}/blocked`, {
                method: 'PUT',
                body: JSON.stringify({ value: 'yes' }),
            });
            setBlocking(false);
            if (onChanged) onChanged();
            loc.route(appHref('chat'));
        } catch (e) {
            setSendError(e.message || String(e));
            setBlocking(false);
        }
    };
    // Accepting a chat request (Curtis, 2026-09-20): the same door the rejoin asks - in
    // from now on, listed, synced and rung with the rest.
    const [accepting, setAccepting] = useState(false);
    const acceptChat = async () => {
        if (accepting) return;
        setAccepting(true);
        try {
            await api(`/api/identity/${root}/rooms/${author}/${doc}/join`, { method: 'POST' });
            setRoom((r) => r && { ...r, request: false, joined: true });
            readHistory();
            if (onChanged) onChanged();
        } catch (e) {
            setSendError(e.message || String(e));
        } finally {
            setAccepting(false);
        }
    };
    // Rejoin (Curtis, 2026-09-19): the room becomes active again and syncs from now on.
    const rejoin = async () => {
        try {
            await api(`/api/identity/${root}/rooms/${author}/${doc}/join`, { method: 'POST' });
            setRoom((r) => r && { ...r, left: false, joined: true });
            readHistory();
            if (onChanged) onChanged();
        } catch (e) {
            setSendError(e.message || String(e));
        }
    };

    if (!root) return null;
    if (room === undefined) return html`<p class="chat-empty">${t('apps.chat.knocking', 'knocking…')}</p>`;
    if (room === null) {
        return html`<div class="chat-refused">
            <p class="chat-empty"><${Icons.trustPrivate} /> ${refusal || t('apps.chat.this-room-is-not-open-to-you', 'this room is not open to you')}</p>
        </div>`;
    }
    // A private chat is titled with the other person, always and freshly (ruling 12): what
    // this reader calls them today, never the name the post was minted under.
    const name = room.im ? imName(other, room) : roomName(words, room);
    // Muted here (CHAT.md, ruling 8; Curtis, 2026-09-20): the room hid this persona, which
    // they can read as plainly as everyone else, so the composer says so and stands down -
    // nothing typed into it would reach a floor.
    const iAmMuted = (room.muted || []).includes(root);
    // Who may mute here (CHAT.md, ruling 8): the creator, and the deputies they named.
    // ...and nobody moderates a private chat (ruling 12): there is no third party to
    // protect anyone from, and the door refuses the act whatever the chrome offers.
    const iModerate = !room.im && (room.mine || (room.deputies || []).includes(root));
    const others = (chatters || []).filter((c) => c.root !== author);
    // The floor: the room's post first, said by its creator, then every line oldest to
    // newest; a run of lines by one speaker is attributed once.
    const lines = [];
    // A private chat's post is a user card naming the other person - the seal's audience
    // written out (ruling 12) - so it is not a first line anybody wants to read.
    if (words.body && !room.im) {
        lines.push({ hash: 'post', speaker: author, said_ms: room.published_ms || 0, words: words.body, post: true });
    }
    // Hidden lines (the preference) collapse to one stub per run, so the floor still says
    // that something was said, and by whom it was not.
    let hidden = 0;
    for (const m of [...((history && history.items) || [])].reverse()) {
        if (hiding && !trusted(m.speaker)) {
            hidden += 1;
            const last = lines[lines.length - 1];
            if (last && last.stub) last.count += 1;
            else lines.push({ hash: `stub-${m.hash}`, stub: true, count: 1, speaker: null });
            continue;
        }
        lines.push(m);
    }
    return html`<section class="chat-room">
        <header class="chat-room-head">
            <h2 class="chat-room-name">${room.im ? name : html`<${RoomTitle}>${name}</${RoomTitle}>`}</h2>
            ${room.trusted_only &&
            html`<span class="label-chip label-chip-flag"><${Icons.trustPrivate} />
                ${room.im
                    ? t('apps.chat.just-the-two-of-you', 'just the two of you')
                    : room.onward
                      ? t('apps.chat.trusted-and-onward', 'trusted, and onward')
                      : t('apps.chat.sealed', 'sealed')}</span>`}
            ${/* The people (Curtis, 2026-09-19): the owner and how many others have spoken,
                in one box beside the title, the triangle promising the list - who has
                visibly spoken, newest first, with when; nobody is "in" a room. */ ''}
            ${room.im
                ? html`<span class="chat-people-two"><${PersonChip} root=${room.other || author} current=${current} /></span>`
                : html`<details class="chat-people">
                <summary class="chat-people-summary jag-line">
                    <${PersonChip} root=${author} current=${current} />
                    ${others.length > 0 &&
                    html`<span class="chat-people-others">${others.length === 1 ? t('apps.chat.and-one-other', 'and one other') : t('apps.chat.and-n-others', 'and {n} others', { n: others.length })}</span>`}
                    <${Icons.caretDown} class="chat-people-caret" />
                </summary>
                <ul class="chat-chatters-list">
                    <li class="chat-chatters-row">
                        <${Speaker} root=${author} current=${current} />
                        <span class="chat-chatters-when">${t('apps.chat.opened-the-room', 'opened the room')}</span>
                    </li>
                    ${others.map(
                        (c) => html`<li key=${c.root} class=${c.muted ? 'chat-chatters-row chat-chatters-muted' : 'chat-chatters-row'}>
                            <${Speaker} root=${c.root} current=${current} />
            ${/* The creator hands out the badge (ruling 8); a deputy may mute, and cannot
                deputize or mute another deputy - the door says so too. */ ''}
                            ${room.mine &&
                            html`<button
                                class=${c.deputy ? 'chat-chatters-mute chat-chatters-on' : 'chat-chatters-mute'}
                                type="button"
                                title=${c.deputy ? t('apps.chat.take-the-badge-back', 'take the badge back') : t('apps.chat.deputize-this-person', 'deputize them - their mutes count as yours')}
                                onClick=${() => setDeputy(c.root, !c.deputy)}
                            ><${Icons.deputy} /></button>`}
                            ${iModerate &&
                            !c.deputy &&
                            html`<button
                                class="chat-chatters-mute"
                                type="button"
                                title=${c.muted ? t('apps.chat.unmute-this-person', 'let them speak here again') : t('apps.chat.mute-this-person', 'mute this person in the room')}
                                onClick=${() => setMuted(c.root, !c.muted)}
                            ><${Icons.mute} /></button>`}
                            <span class="chat-chatters-when">${c.muted ? t('apps.chat.muted', 'muted') : whenWords(c.last_ms)}</span>
                        </li>`
                    )}
                </ul>
            </details>`}
            ${/* The tools, one strip on the right (Curtis, 2026-09-19): icons with their
                words on hover. A private chat keeps two of them: the trust filter has no
                say there, and neither share, post link, leave, close nor delete is a thing
                anyone may do to a conversation between two people (ruling 12). */ ''}
            <span class="chat-tools">
                ${/* Writer's chips (Curtis, 2026-09-27), trash leftmost. */ ''}
                ${!room.im &&
                room.mine &&
                html`<button class="chip chip-button chip-delete" type="button" title=${t('apps.chat.delete-the-room-title', 'delete this room')} onClick=${() => setDeleting(true)}>
                    <${Icons.trash} />
                </button>`}
                ${!room.im &&
                html`<button
                    class=${hiding ? 'chip chip-button chip-open' : 'chip chip-button'}
                    type="button"
                    title=${hiding
                        ? hidden > 0
                            ? t('apps.chat.hiding-n-lines-click-to-show', "hiding {n} lines from people you don't trust - click to show them", { n: hidden })
                            : t('apps.chat.hiding-untrusted-click-to-show', "hiding people you don't trust - click to show them")
                        : t('apps.chat.hide-lines-from-people-you-dont-trust', "hide lines from people you don't trust, in every room")}
                    onClick=${() => setHideUntrusted(hiding ? 'no' : 'yes')}
                >
                    ${hiding ? html`<${Icons.eyeClosed} />` : html`<${Icons.eye} />`}
                </button>`}
                ${admin &&
                !room.archivist &&
                html`<button
                    class=${room.archived ? 'chip chip-button chip-open' : 'chip chip-button'}
                    type="button"
                    disabled=${archiving}
                    title=${room.archived
                        ? t('apps.chat.kept-whole-here-click-to-release', 'this computer keeps the whole conversation - click to stop')
                        : t('apps.chat.pull-the-whole-room-and-keep-it', 'keep the whole conversation on this computer')}
                    onClick=${() => setArchive(!room.archived)}
                >
                    <${Icons.memory} />
                </button>`}
                ${mayShare &&
                html`<button
                    class=${shared ? 'chip chip-button chip-open' : 'chip chip-button'}
                    type="button"
                    disabled=${sharing || shared === null}
                    title=${shared
                        ? t('apps.chat.stop-passing-this-room-along', 'stop passing this room along to your followers')
                        : t('apps.chat.pass-this-room-along', 'pass this room along to your followers')}
                    onClick=${passAlong}
                >
                    <${Icons.colRebroadcast} />
                </button>`}
                ${!room.im &&
                html`<a class="chip chip-button" href=${postHref(author, doc)} title=${t('apps.chat.the-rooms-post', "the room's post")}>
                    <${Icons.feed} />
                </a>`}
                ${room.im &&
                html`<button
                    class="chip chip-button chip-delete"
                    type="button"
                    title=${t('apps.chat.block-them', 'block them')}
                    onClick=${() => setBlocking(true)}
                ><${Icons.block} /></button>`}
                ${!room.im &&
                room.joined &&
                html`<button class="chip chip-button" type="button" title=${t('apps.chat.leave', 'leave')} onClick=${leave}>
                    <${Icons.leave} />
                </button>`}
                ${room.im
                    ? null
                    : room.closed
                    ? html`<span class="chip chip-open" title=${t('apps.chat.this-room-is-closed', 'this room is closed')}><${Icons.settled} /></span>`
                    : room.mine &&
                      html`<button
                          class="chip chip-button"
                          type="button"
                          disabled=${closing || !roomDraft}
                          title=${t('apps.chat.close-the-room-title', 'close this room for good')}
                          onClick=${closeRoom}
                      >
                          <${Icons.settled} />
                      </button>`}
            </span>
            ${blocking &&
            html`<${Modal}
                title=${t('apps.chat.block-them-title', 'block them')}
                onClose=${() => setBlocking(false)}
            >
                <p class="feed-unpublish-warn">
                    ${t('apps.chat.block-them-question', 'Block {who}? You stop seeing anything of theirs, here and everywhere else. They are not told.', { who: name })}
                </p>
                <div class="feed-unpublish-acts">
                    <button class="feed-unpublish-go jag-line" onClick=${blockThem}>${t('apps.chat.block', 'block')}</button>
                    <button class="feed-unpublish-no" onClick=${() => setBlocking(false)}>${t('apps.chat.never-mind', 'never mind')}</button>
                </div>
            </${Modal}>`}
            ${deleting &&
            html`<${Modal}
                title=${t('apps.chat.take-the-room-down', 'take the room down')}
                onClose=${() => {
                    if (!going) setDeleting(false);
                }}
            >
                <p class="feed-unpublish-warn">
                    ${/* Plain words for the person deciding (Curtis, 2026-09-19): the
                        machinery behind a takedown is CHAT.md's business, not theirs. */ ''}
                    ${t('apps.chat.do-you-want-to-take-the-room-down', 'Do you want to take the room down? It may take a while.')}
                </p>
                <div class="feed-unpublish-acts">
                    <button class="feed-unpublish-go jag-line" disabled=${going} onClick=${takeDown}>
                        ${going ? t('apps.chat.taking-it-down', 'taking it down…') : t('apps.chat.take-it-down', 'take it down')}
                    </button>
                    <button class="feed-unpublish-no" disabled=${going} onClick=${() => setDeleting(false)}>${t('apps.chat.keep-it', 'keep it')}</button>
                </div>
            </${Modal}>`}
        </header>
        ${at &&
        html`<p class="chat-landed">
            ${t('apps.chat.you-are-reading-back', 'reading back from a search')}
            <button class="chat-older" type="button" onClick=${() => loc.route(roomHref(author, doc))}>
                ${t('apps.chat.jump-to-the-newest', 'jump to the newest')}
            </button>
        </p>`}
        <div class="chat-floor" ref=${floor} onScroll=${trackEnd}>
            ${/* The gap (Curtis, 2026-09-19): where what this computer holds runs out sits
                the way past it - a page of earlier lines for anyone, and for the node's
                operator the full-sync, which loads the entire history here and keeps it. */ ''}
            ${history &&
            history.more &&
            html`<div class="chat-gap">
                <button class="chat-older" disabled=${older} onClick=${readOlder}>${older ? t('apps.chat.reading', 'reading…') : t('apps.chat.earlier', 'earlier…')}</button>
            </div>`}
            ${!history && html`<p class="chat-empty"><span class="status-spin"><${Icons.spinner} /></span></p>`}
            ${history && lines.length === 0 && html`<p class="chat-empty">${t('apps.chat.nobody-has-said-anything-here', 'nobody has said anything here yet')}</p>`}
            <ul class="chat-lines">
                ${lines.map((m, i) =>
                    m.notice
                        ? html`<${NoticeLine} key=${m.hash} m=${m} current=${current} />`
                        : m.stub
                        ? html`<li key=${m.hash} class="chat-line chat-line-hidden">
                              ${m.count === 1
                                  ? t('apps.chat.one-line-hidden', "one line hidden - from someone you don't trust")
                                  : t('apps.chat.n-lines-hidden', "{n} lines hidden - from people you don't trust", { n: m.count })}
                          </li>`
                        : html`<${Line}
                              key=${m.hash}
                              m=${m}
                              current=${current}
                              cont=${i > 0 && lines[i - 1].speaker === m.speaker}
                              ${/* ...nor does trust dim a line in a private chat (ruling
                                  12): there is one other person in it, and they are who
                                  the reader opened it with. */ ''}
                              untrusted=${!room.im && !m.post && !trusted(m.speaker)}
                              veil=${!m.post &&
                                  veilsMedia({
                                      words: m.words,
                                      speaker: m.speaker,
                                      me: root,
                                      author,
                                      im: !!room.im,
                                      trusted: hasTrust(trustOf.get(m.speaker)),
                                  })}
                              onReact=${m.post || room.left || (history && history.closed) ? null : react}
                              onEdit=${m.post || room.left || (history && history.closed) ? null : beginEdit}
                              onDelete=${m.post || room.left || (history && history.closed) ? null : setDeletingLine}
                              onMute=${iModerate && !m.post && !room.left ? (who) => setMuted(who, true) : null}
                              ${/* A muted reader's react, edit and delete would be seen by
                                  nobody: the menu stands down with the composer. */ ''}
                              hushed=${iAmMuted}
                              found=${at === m.hash}
                              room=${{ author, doc }}
                          />`
                )}
            </ul>
            ${/* Typing shows where the next line will land: at the end of the floor. */ ''}
            ${typing.length > 0 &&
            html`<p class="chat-typing">
                ${typing.map((r) => html`<${PersonChip} key=${r} root=${r} current=${current} />`)}
                ${typing.length === 1 ? t('apps.chat.is-typing', 'is typing…') : t('apps.chat.are-typing', 'are typing…')}
            </p>`}
        </div>
        <div class="chat-foot">
            ${editingLine &&
            html`<p class="chat-editing">
                <${Icons.rename} /> ${t('apps.chat.editing-a-line', 'editing a line')}
                <button class="chat-editing-cancel" type="button" onClick=${cancelEdit}>${t('apps.chat.never-mind', 'never mind')}</button>
            </p>`}
            ${deletingLine &&
            html`<${Modal}
                title=${t('apps.chat.delete-this-line-title', 'delete this line')}
                onClose=${() => setDeletingLine(null)}
            >
                <p class="feed-unpublish-warn">${t('apps.chat.delete-this-line-question', 'Delete this line? It may take a while to disappear everywhere.')}</p>
                <div class="feed-unpublish-acts">
                    <button class="feed-unpublish-go jag-line" onClick=${deleteLine}>${t('apps.chat.delete', 'delete')}</button>
                    <button class="feed-unpublish-no" onClick=${() => setDeletingLine(null)}>${t('apps.chat.keep-it', 'keep it')}</button>
                </div>
            </${Modal}>`}
            ${/* A left room (Curtis, 2026-09-19): no composer - the honest word that it is
                not being updated, and the way back in. */ ''}
            ${room.request
                ? html`<div class="chat-closed chat-request-note">
                      <span class="chat-request-words">
                          ${t('apps.chat.wants-to-chat-with-you', '{who} wants to chat with you', { who: name })}
                      </span>
                      ${/* Two answers and a third that is silence (Curtis, 2026-09-20):
                          accepting files the chat with the rest; blocking ends it; walking
                          away leaves it where it is, saying nothing to them either way. */ ''}
                      <button class="chat-accept" disabled=${accepting} onClick=${acceptChat}>
                          ${t('apps.chat.accept', 'accept')}
                      </button>
                      <button class="chat-rejoin" onClick=${() => setBlocking(true)}>${t('apps.chat.block', 'block')}</button>
                  </div>`
                : iAmMuted
                ? html`<p class="chat-closed chat-muted-note">
                      <${Icons.mute} /> ${t('apps.chat.youve-been-muted-by-the-room', "you've been muted by the room")}
                  </p>`
                : room.left
                ? html`<p class="chat-closed chat-left-note">
                      <${Icons.trustPrivate} />
                      ${t('apps.chat.you-left-this-room', "you left this room. It isn't updating.")}
                      <button class="chat-rejoin" onClick=${rejoin}>${t('apps.chat.rejoin', 'rejoin')}</button>
                  </p>`
                : history && history.closed
                ? html`<p class="chat-closed"><${Icons.settled} /> ${t('apps.chat.this-room-is-closed', 'this room is closed')}</p>`
                : html`<form
                      class="chat-composer"
                      onSubmit=${(e) => {
                          e.preventDefault();
                          send();
                      }}
                      onDrop=${catchDrop}
                      onDragOver=${allowFileDrag}
                      onPaste=${catchPaste}
                  >
                      <div class="chat-composer-words">
                          <${LiveMarquee}
                              body=${draft}
                              profile=${composerProfile}
                              completions=${completions}
                              keys=${keys}
                              placeholder=${t('apps.chat.say-something', 'say something…')}
                              onInput=${(text) => {
                                  setDraft(text);
                                  sayTyping(text.trim().length > 0);
                              }}
                              onCursor=${(_start, end) => {
                                  cursor.current = end;
                              }}
                          />
                      </div>
                      ${draftBytes > MAX_MESSAGE_BYTES / 2 &&
                      html`<span
                          class=${overLong ? 'chat-composer-count chat-composer-count-over' : 'chat-composer-count'}
                          title=${t('apps.chat.bytes-of-this-message', 'message length')}
                      >${draftBytes} / ${MAX_MESSAGE_BYTES}</span>`}
                      <button
                          class="chat-composer-attach"
                          type="button"
                          title=${t('apps.chat.send-a-file', 'send a picture, a sound or a video - it goes in once it is ready (drop or paste into the message to add it there instead)')}
                          onClick=${pickAndSend}
                      >
                          <${Icons.upload} />
                      </button>
                      <button
                          class="chat-composer-attach"
                          type="button"
                          disabled=${sending}
                          title=${t('apps.chat.send-a-picture', 'send one of your pictures or drawings - it goes at once')}
                          onClick=${() => setPicking(true)}
                      >
                          <${Icons.addImage} />
                      </button>
                      ${picking &&
                      html`<${ImagePickModal}
                          root=${root}
                          drawings=${true}
                          DrawingThumb=${DrawingThumb}
                          heading=${t('apps.chat.send-a-picture-heading', 'send a picture')}
                          onPick=${sendPicked}
                          onClose=${() => setPicking(false)}
                      />`}
                      <button
                          class="chat-composer-send"
                          type="submit"
                          disabled=${sending || !draft.trim() || overLong}
                          title=${t('apps.chat.send', 'send')}
                          aria-label=${t('apps.chat.send', 'send')}
                      >
                          <${Icons.send} weight="fill" />
                      </button>
                  </form>
                  ${uploadExtras}
                  ${sendExtras}
                  ${landing.length > 0 &&
                  html`<p class="chat-landing null-sub">
                      <span class="waiting-dot"></span>
                      ${landing.length === 1
                          ? t('apps.chat.preparing-a-file', 'preparing a file - it goes in once it is ready')
                          : t('apps.chat.preparing-n-files', 'preparing {n} files - each goes in once it is ready', { n: landing.length })}
                  </p>`}`}
            ${sendError && html`<p class="form-error">${sendError}</p>`}
        </div>
    </section>`;
};

// ---------------------------------------------------------------------------------------------
// The app: the chats column and whatever the right side holds

/// The chat app at `/home/chat`, `/home/chat/new` and `/home/chat/:author/:doc`: one shell,
/// the chats column on the left, the chosen room (or the new-chat form) on the right.
/// Mark the newest read stamp as seen: one private register per room, written at most
/// every few seconds while the floor moves and once more when the page leaves.
const SEEN_THROTTLE_MS = 5000;

/// One line a search found: the room it was said in, who said it, when, and the words with
/// the match marked. Clicking it opens that room AT that line (Curtis, 2026-09-20), not at
/// the newest word - the conversation as it was around what you were looking for.
const marked = (words, needle) => {
    const at = (words || '').toLowerCase().indexOf((needle || '').toLowerCase());
    if (at < 0 || !needle) return words;
    return html`${words.slice(0, at)}<mark>${words.slice(at, at + needle.length)}</mark>${words.slice(at + needle.length)}`;
};
const SearchResults = ({ current, needle, hits, onOpen }) => {
    if (hits === null) return html`<p class="chat-empty">${t('apps.chat.searching', 'searching…')}</p>`;
    if (hits.length === 0) {
        return html`<p class="chat-empty">${t('apps.chat.nothing-said-that', 'nothing said in your chats says that')}</p>`;
    }
    return html`<section class="chat-results">
        <header class="chat-room-head">
            <h2 class="chat-room-name">${t('apps.chat.n-lines-say-that', '{n} lines say that', { n: hits.length })}</h2>
        </header>
        <ul class="chat-result-list">
            ${hits.map(
                (h) => html`<li key=${h.hash} class="chat-result">
                    <button class="chat-result-hit" type="button" onClick=${() => onOpen(h)}>
                        <span class="chat-result-where">
                            <${Icons.room} />
                            ${h.title || t('apps.chat.a-sealed-room', 'a sealed room')}
                            <span class="chat-result-when">${whenWords(h.said_ms)}</span>
                        </span>
                        <span class="chat-result-said">
                            <${PersonInline} root=${h.speaker} current=${current} />
                            <span class="chat-result-words">${marked(h.words, needle)}</span>
                        </span>
                    </button>
                </li>`
            )}
        </ul>
    </section>`;
};

export const ChatApp = ({ current, author, doc, line, mode, admin, searchQuery, onSearch }) => {
    const root = current && current.root;
    const loc = useLocation();
    const [page, setPage] = useState(null);
    // Where this browser was (Curtis, 2026-09-20): the room last opened here, remembered
    // across a close and a refresh, and only here - a per-browser gesture, like a tucked
    // column, never a fact about the persona.
    const [wasOpen, setWasOpen] = usePref(root, OPEN_ROOM_KEY, '');
    // The header's search, over every conversation this computer holds: asked a beat after
    // the typing stops, so a long word is one question rather than eight.
    const makingNew = mode === 'new';
    const needle = (searchQuery || '').trim();
    const searching = needle.length >= 2;
    const [hits, setHits] = useState(null);
    useEffect(() => {
        if (!root || !searching) return undefined;
        let live = true;
        setHits(null);
        const timer = setTimeout(() => {
            api(`/api/identity/${root}/rooms/search?q=${encodeURIComponent(needle)}`)
                .then((page) => live && setHits(page.items || []))
                .catch(() => live && setHits([]));
        }, 250);
        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [root, needle, searching]);
    const restored = useRef(false);
    // The tags column (Curtis, 2026-09-20), Writer's: a histogram of the tags the rooms in
    // view wear, clicking one into or out of the filter, and minimized to a rail until asked
    // for - a room's tags are its creator's word about it, and most rooms have none.
    const [tagFilter, setTagFilter] = useState([]);
    // In a narrow window (panes.js) the rooms are the tab it opens on while no room is open, and
    // opening one closes the tab to show it.
    const { tucked, toggleTuck, settle, tab } = useColTucks(root, APP_ID, ['tags'], { lead: author && doc ? null : 'rooms' });
    useEffect(() => {
        if (author && doc) settle();
    }, [author, doc, settle]);
    const { resizer, colStyle } = useColWidths(root, APP_ID, ['tags', 'rooms'], { rooms: 180, tags: 150 });
    const load = () => {
        if (!root) return;
        api(`/api/identity/${root}/rooms`)
            .then(setPage)
            .catch(() => {});
    };
    useEffect(load, [root]);
    useEffect(() => {
        if (author && doc) {
            restored.current = true;
            if (wasOpen !== `${author}/${doc}`) setWasOpen(`${author}/${doc}`);
            return;
        }
        // Nothing named in the address: walk back into the remembered room, once, and only
        // when it is still one of this persona's - a room taken down leaves the memory stale
        // rather than the page broken.
        if (mode || restored.current || !wasOpen || !page) return;
        restored.current = true;
        const [was, wasDoc] = wasOpen.split('/');
        if ((page.items || []).some((r) => r.author === was && r.doc_id === wasDoc)) {
            loc.route(roomHref(was, wasDoc));
        } else {
            setWasOpen('');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [author, doc, mode, wasOpen, page]);
    useEffect(() => {
        const interval = setInterval(load, 30_000);
        window.addEventListener('focus', load);
        return () => {
            clearInterval(interval);
            window.removeEventListener('focus', load);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [root]);
    if (!root) return null;
    const all = page && page.items;
    // Counted over every room this persona may see, so the cloud shows what could be picked
    // rather than only what survives the picking; the list narrows, the cloud does not.
    const cloud = roomTagCounts(all);
    const rooms =
        all && tagFilter.length > 0 ? all.filter((r) => tagFilter.every((tag) => (r.tags || []).includes(tag))) : all;
    const selected = author && doc ? { author, doc } : null;
    return html`<div class="chat">
        <div class="chat-columns panes" style=${colStyle}>
            ${tucked.has('tags')
                ? html`<${Rail} icon=${Icons.tag} label=${t('apps.chat.tags', 'tags')} onClick=${() => toggleTuck('tags')} />`
                : html`${tab('tags', Icons.tag, t('apps.chat.tags', 'tags'))}<${TagColumn}
                      cloud=${cloud}
                      active=${tagFilter}
                      label=${t('apps.chat.tags', 'tags')}
                      onToggleTag=${(tag) => setTagFilter((have) => (have.includes(tag) ? have.filter((x) => x !== tag) : [...have, tag]))}
                      onTuck=${() => toggleTuck('tags')}
                  />${resizer('tags')}`}
            ${tucked.has('rooms')
                ? html`<${Rail} icon=${Icons.chat} label=${t('apps.chat.chats', 'chats')} onClick=${() => toggleTuck('rooms')} />`
                : html`${tab('rooms', Icons.chat, t('apps.chat.chats', 'chats'))}<${RoomsColumn}
                      current=${current}
                      rooms=${rooms}
                      selected=${selected}
                      filtered=${tagFilter.length > 0}
                      onTuck=${() => toggleTuck('rooms')}
                  />${resizer('rooms')}`}
            <section class="chat-main">
                ${searching
                    ? html`<${SearchResults}
                          current=${current}
                          needle=${needle}
                          hits=${hits}
                          ${/* A line has its own address (Curtis, 2026-09-20), so opening
                              one is a route and the box empties behind you. */ ''}
                          onOpen=${(h) => {
                              if (onSearch) onSearch('');
                              loc.route(roomHref(h.author, h.doc_id, h.hash));
                          }}
                      />`
                    : makingNew
                    ? html`<${NewRoom}
                          root=${root}
                          onMade=${(post) => {
                              load();
                              loc.route(roomHref(root, post));
                          }}
                      />`
                    : selected
                      ? html`<${Room}
                            key=${`${author}/${doc}/${line || ''}`}
                            at=${line || null}
                            current=${current}
                            author=${author}
                            doc=${doc}
                            admin=${admin}
                            onChanged=${load}
                            onSeen=${(a, d, ms) =>
                                setPage((p) =>
                                    p && {
                                        ...p,
                                        items: p.items.map((r) => (r.author === a && r.doc_id === d ? { ...r, seen_ms: ms, unread: !!(r.latest_ms && r.latest_ms > ms) } : r)),
                                    }
                                )}
                        />`
                      : html`<p class="chat-empty">
                            <${Icons.chat} />
                            ${rooms && rooms.length === 0
                                ? t('apps.chat.no-rooms-yet', 'no rooms yet - open one above, or follow someone who has')
                                : t('apps.chat.pick-a-chat', 'pick a chat on the left, or start a new one')}
                        </p>`}
            </section>
        </div>
    </div>`;
};
