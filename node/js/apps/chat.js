// Chat: real-time rooms (CHAT.md). A room is a post - its title the room's name, its words
// the description, its seal and audience the post's own - and this app lists the rooms a
// persona may see (ruling 7) and opens them. The shape is Slack's, by Curtis's brief
// (2026-09-18): Writer's collapsible, resizable columns, a "chats" column on the left, open
// by default, with the rooms and a "new chat" button; the chosen room on the right under a
// fixed header, its floor scrolling with the newest line at the bottom and pinned there while
// you are at the end, one speaker's run of lines attributed once, the composer fixed to the
// bottom at full width. The room's own post is the first line, said by its creator.
import { h } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { api, apiTextTitled } from '../net.js';
import { t } from '../i18n.js';
import { Icons } from '../icons.js';
import { PersonChip, PersonHex, usePerson } from '../person.js';
import { agoUnit } from '../pure/ago.js';
import { MarqueeBody, bareSource } from '../doc/marqueebody.js';
import { useTurbolinks } from '../doc/turbolinks.js';
import { openMirror, useLive } from '../mirror.js';
import { tagCounts } from '../pure/contacttags.js';
import { MAX_TAG_CHARS } from '../pure/annotations.js';
import { speakable } from '../speakable.js';
import { useColWidths, useColTucks, PaneHead, Rail } from '../panes.js';
import { Modal } from '../modal.js';
import { usePref, OPEN_ROOM_KEY } from '../mirror/prefs.js';

/// Whether a trust dial says anything: absent or "none" is a stranger, whatever else a
/// person this reader has placed (Curtis, 2026-09-19: untrusted speakers read small and
/// gray, and may be hidden).
const hasTrust = (v) => !!v && v !== 'none';
/// The preference: hide untrusted speakers' lines in every room this persona reads.
const HIDE_UNTRUSTED_PREF = 'chat.hide-untrusted';
/// Whether some words embed media - a picture, a sound, a clip - by Marquee's two spellings.
export const embedsMedia = (words) => /!\[|:::media\b/.test(words || '');
/// Whether a line is nothing but emoji (Curtis, 2026-09-19: such a line reads at 150%) - the
/// picker's `:name:` shortcodes and the glyphs themselves, with their modifiers and joiners,
/// and whitespace between; up to a handful, so a wall of them stays a wall.
const EMOJI_ONLY = /^(?:\s|:[a-z0-9_+-]+:|\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?)*)+$/u;
const onlyEmoji = (words) => {
    if (!words || !words.trim() || !EMOJI_ONLY.test(words)) return false;
    const count = (words.match(/:[a-z0-9_+-]+:|\p{Extended_Pictographic}/gu) || []).length;
    return count > 0 && count <= 8;
};
import { POLE_EMOJI, EMOJI_PALETTE, shortcodeOf, glyphOf } from '../emoji.js';
import { useShared, markShared } from '../shares.js';
import { LiveMarquee } from '../doc/livemarquee.js';
import { useUploadCapture } from '../doc/upload.js';
import { emojiCompletions, linkCompletions, mediaCompletions, mentionCompletions } from '../doc/completions.js';
import { userCardHtml, userSpanHtml, useUserCards } from '../doc/usercard.js';
import { insertNewlineAndIndent } from '@codemirror/commands';

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

const RoomRow = ({ room, current, selected }) => {
    const loc = useLocation();
    const words = useRoomWords(room);
    // Bold where something was said since this persona last looked (the `rooms_seen`
    // register, synced to every computer); the newest word's time beside every room.
    const cls = ['chat-row', selected ? 'chat-row-selected' : '', room.unread ? 'chat-row-unread' : ''].filter(Boolean).join(' ');
    return html`<li class=${cls} onClick=${() => loc.route(`/home/chat/${room.author}/${room.doc_id}`)}>
        <span class="chat-row-icon">${room.trusted_only ? html`<${Icons.trustPrivate} />` : html`<${Icons.chat} />`}</span>
        <span class="chat-row-main">
            <span class="chat-row-top">
                <span class="chat-row-name">${room.closed && html`<${Icons.settled} />`} ${roomName(words, room)}</span>
                <span class="chat-row-when">${room.latest_ms ? whenWords(room.latest_ms) : t('apps.chat.quiet', 'quiet')}</span>
            </span>
            <span class="chat-row-by">
                <${PersonChip} root=${room.author} current=${current} />
                ${(room.tags || []).map((value) => html`<span class="chat-row-tag" key=${value}>${value}</span>`)}
            </span>
        </span>
    </li>`;
};

const RoomsColumn = ({ current, rooms, selected, onTuck }) => {
    const loc = useLocation();
    // Active rooms on top, the rooms this persona left beneath a divider (Curtis,
    // 2026-09-19): left rooms are not synced and never bold, until rejoined. Closed rooms
    // sit at the bottom of that pile for everyone - the door sorts them last.
    const active = (rooms || []).filter((r) => !r.left && !r.closed);
    const left = (rooms || []).filter((r) => r.left || r.closed);
    const row = (r) => html`<${RoomRow}
        key=${`${r.author}/${r.doc_id}`}
        room=${r}
        current=${current}
        selected=${!!selected && selected.author === r.author && selected.doc === r.doc_id}
    />`;
    return html`<aside class="chat-rooms">
        <${PaneHead} label=${t('apps.chat.chats', 'chats')} onTuck=${onTuck} />
        <button class="chat-new-btn" onClick=${() => loc.route('/home/chat/new')}>
            ${t('apps.chat.new-chat', '+ new chat')}
        </button>
        ${rooms && rooms.length === 0
            ? html`<p class="chat-rooms-empty">${t('apps.chat.no-rooms-yet-column', 'no chats yet')}</p>`
            : html`<ul class="chat-list">${active.map(row)}</ul>`}
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
                    <select class="feed-audience" value=${audience} onChange=${(e) => setAudience(e.currentTarget.value)}>
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
    return html`<a class="chat-speaker" href=${`/id/${speakable(root)}`}>
        <${PersonHex} person=${person} size="small" />
        <span class="chat-speaker-name">${person.primary || speakable(root)}</span>
    </a>`;
};

/// The emoji picker under a line's hover menu (CHAT.md, slice 9): the pole ten, then the
/// whole table, narrowed as you type a name. One click says the emoji.
const EmojiPicker = ({ onPick, onClose }) => {
    const [q, setQ] = useState('');
    const needle = q.trim().toLowerCase();
    const hit = ([name]) => !needle || name.replace(/_/g, ' ').includes(needle);
    const pole = POLE_EMOJI.filter(hit);
    const rest = EMOJI_PALETTE.filter(hit);
    const chip = ([name, ch]) => html`<button
        class="label-emoji"
        key=${name}
        title=${name}
        type="button"
        onMouseDown=${(e) => e.preventDefault()}
        onClick=${() => onPick(ch)}
    >${ch}</button>`;
    return html`<span class="chat-emoji-pop" onMouseDown=${(e) => e.stopPropagation()}>
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
        <span class="label-emoji-strip chat-emoji-strip">
            ${pole.map(chip)}
            ${pole.length > 0 && rest.length > 0 && html`<span class="label-emoji-pole-break"></span>`}
            ${rest.map(chip)}
        </span>
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

const Line = ({ m, current, cont, onReact, untrusted, onEdit, onDelete, onMute, hushed }) => {
    const profile = useTurbolinks(m.words || '', 'marquee');
    const [picking, setPicking] = useState(false);
    const when = new Date(m.said_ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const mine = !!current && current.root === m.speaker;
    const whoSaid = (r) => r.who.map((w) => w.name || speakable(w.root)).join(', ');
    // A speaker this reader has not placed reads small and gray: present, unimportant. Their
    // media wears the feed's veil until clicked (Curtis, 2026-09-19: "baddies might want to
    // pop on to a chat channel and drop in nasty images or sounds").
    const cls = ['chat-line', cont ? 'chat-line-cont' : '', untrusted ? 'chat-line-untrusted' : '', onlyEmoji(m.words) ? 'chat-line-emoji' : ''].filter(Boolean).join(' ');
    const [revealed, setRevealed] = useState(false);
    const veiled = untrusted && !revealed && m.words !== null && embedsMedia(m.words);
    return html`<li class=${cls} title=${untrusted ? t('apps.chat.someone-you-dont-trust', "someone you don't trust") : undefined}>
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
                    return html`<button
                        class=${mine ? 'chat-react chat-react-mine' : 'chat-react'}
                        type="button"
                        key=${r.emoji}
                        title=${mine ? t('apps.chat.who-said-click-to-take-yours-back', '{who} - click to take yours back', { who: whoSaid(r) }) : whoSaid(r)}
                        onClick=${() => onReact && onReact(m.hash, r.emoji, mine)}
                    ><span class="chat-react-glyph">${glyphOf(r.emoji)}</span> ${r.count}</button>`;
                })}
            </span>`}
        </div>
    </li>`;
};

const Room = ({ current, author, doc, onSeen, onChanged, admin }) => {
    const root = current && current.root;
    const loc = useLocation();
    const [room, setRoom] = useState(undefined); // undefined loading, null refused, object entered
    const [refusal, setRefusal] = useState('');
    const [history, setHistory] = useState(null); // { items, closed, more }
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
    const contacts = useLive(() => (root ? openMirror(root).contacts.toArray() : []), [root]);
    const trustOf = new Map((contacts || []).map((c) => [c.root, (c.facts || {}).trust]));
    const trusted = (speaker) => speaker === root || speaker === author || hasTrust(trustOf.get(speaker));
    const [hideUntrusted, setHideUntrusted] = usePref(root, HIDE_UNTRUSTED_PREF, '');
    const hiding = hideUntrusted === 'yes';
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
        pickFiles,
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
        setHistory(null);
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
        api(`/api/identity/${root}/rooms/${author}/${doc}/messages`)
            .then(setHistory)
            .catch(() => {});
        api(`/api/identity/${root}/rooms/${author}/${doc}/chatters`)
            .then((c) => {
                chattersRef.current = c.items || [];
                setChatters(c.items || []);
            })
            .catch(() => {});
    };
    useEffect(() => {
        if (!root || !room) return undefined;
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
    useEffect(() => {
        const el = floor.current;
        if (!el) return;
        if (keepOffset.current) {
            el.scrollTop = el.scrollHeight - keepOffset.current.height + keepOffset.current.top;
            keepOffset.current = null;
        } else if (atEnd.current) el.scrollTop = el.scrollHeight;
    }, [history, words.body, typing]);
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
        loc.route('/home/chat');
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
        try {
            await api(`/api/identity/${root}/rooms/${author}/${doc}/messages`, {
                method: 'POST',
                body: JSON.stringify({ words: code, reacts_to: hash, retract }),
            });
            readHistory();
        } catch (e) {
            setSendError(e.message || String(e));
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
            loc.route('/home/chat');
        } catch (e) {
            setSendError(e.message || String(e));
            setGoing(false);
            setDeleting(false);
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
    const name = roomName(words, room);
    // Muted here (CHAT.md, ruling 8; Curtis, 2026-09-20): the room hid this persona, which
    // they can read as plainly as everyone else, so the composer says so and stands down -
    // nothing typed into it would reach a floor.
    const iAmMuted = (room.muted || []).includes(root);
    // Who may mute here (CHAT.md, ruling 8): the creator, and the deputies they named.
    const iModerate = room.mine || (room.deputies || []).includes(root);
    const others = (chatters || []).filter((c) => c.root !== author);
    // The floor: the room's post first, said by its creator, then every line oldest to
    // newest; a run of lines by one speaker is attributed once.
    const lines = [];
    if (words.body) {
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
            <h2 class="chat-room-name">${name}</h2>
            ${room.trusted_only &&
            html`<span class="label-chip label-chip-flag"><${Icons.trustPrivate} /> ${room.onward ? t('apps.chat.trusted-and-onward', 'trusted, and onward') : t('apps.chat.sealed', 'sealed')}</span>`}
            ${/* The people (Curtis, 2026-09-19): the owner and how many others have spoken,
                in one box beside the title, the triangle promising the list - who has
                visibly spoken, newest first, with when; nobody is "in" a room. */ ''}
            <details class="chat-people">
                <summary class="chat-people-summary">
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
            </details>
            ${/* The tools, one strip on the right (Curtis, 2026-09-19): icons with their
                words on hover. */ ''}
            <span class="chat-tools">
                <button
                    class=${hiding ? 'chat-tool chat-tool-on' : 'chat-tool'}
                    type="button"
                    title=${hiding
                        ? hidden > 0
                            ? t('apps.chat.hiding-n-lines-click-to-show', "hiding {n} lines from people you don't trust - click to show them", { n: hidden })
                            : t('apps.chat.hiding-untrusted-click-to-show', "hiding people you don't trust - click to show them")
                        : t('apps.chat.hide-lines-from-people-you-dont-trust', "hide lines from people you don't trust, in every room")}
                    onClick=${() => setHideUntrusted(hiding ? 'no' : 'yes')}
                >
                    ${hiding ? html`<${Icons.eyeClosed} />` : html`<${Icons.eye} />`}
                </button>
                ${admin &&
                !room.archivist &&
                html`<button
                    class=${room.archived ? 'chat-tool chat-tool-on' : 'chat-tool'}
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
                    class=${shared ? 'chat-tool chat-tool-on' : 'chat-tool'}
                    type="button"
                    disabled=${sharing || shared === null}
                    title=${shared
                        ? t('apps.chat.stop-passing-this-room-along', 'stop passing this room along to your followers')
                        : t('apps.chat.pass-this-room-along', 'pass this room along to your followers')}
                    onClick=${passAlong}
                >
                    <${Icons.colRebroadcast} />
                </button>`}
                <a class="chat-tool" href=${`/id/${speakable(author)}/post/${doc}`} title=${t('apps.chat.the-rooms-post', "the room's post")}>
                    <${Icons.feed} />
                </a>
                ${room.joined &&
                html`<button class="chat-tool" type="button" title=${t('apps.chat.leave', 'leave')} onClick=${leave}>
                    <${Icons.leave} />
                </button>`}
                ${room.closed
                    ? html`<span class="chat-tool chat-tool-on chat-tool-static" title=${t('apps.chat.this-room-is-closed', 'this room is closed')}><${Icons.settled} /></span>`
                    : room.mine &&
                      html`<button
                          class="chat-tool"
                          type="button"
                          disabled=${closing || !roomDraft}
                          title=${t('apps.chat.close-the-room-title', 'close this room for good')}
                          onClick=${closeRoom}
                      >
                          <${Icons.settled} />
                      </button>`}
                ${room.mine &&
                html`<button class="chat-tool chat-tool-danger" type="button" title=${t('apps.chat.delete-the-room-title', 'delete this room')} onClick=${() => setDeleting(true)}>
                    <${Icons.trash} />
                </button>`}
            </span>
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
                    <button class="feed-unpublish-go" disabled=${going} onClick=${takeDown}>
                        ${going ? t('apps.chat.taking-it-down', 'taking it down…') : t('apps.chat.take-it-down', 'take it down')}
                    </button>
                    <button class="feed-unpublish-no" disabled=${going} onClick=${() => setDeleting(false)}>${t('apps.chat.keep-it', 'keep it')}</button>
                </div>
            </${Modal}>`}
        </header>
        <div class="chat-floor" ref=${floor} onScroll=${trackEnd}>
            ${/* The gap (Curtis, 2026-09-19): where what this computer holds runs out sits
                the way past it - a page of earlier lines for anyone, and for the node's
                operator the full-sync, which loads the entire history here and keeps it. */ ''}
            ${history &&
            history.more &&
            html`<div class="chat-gap">
                <button class="chat-older" disabled=${older} onClick=${readOlder}>${older ? t('apps.chat.reading', 'reading…') : t('apps.chat.earlier', 'earlier…')}</button>
            </div>`}
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
                              untrusted=${!m.post && !trusted(m.speaker)}
                              onReact=${m.post || room.left || (history && history.closed) ? null : react}
                              onEdit=${m.post || room.left || (history && history.closed) ? null : beginEdit}
                              onDelete=${m.post || room.left || (history && history.closed) ? null : setDeletingLine}
                              onMute=${iModerate && !m.post && !room.left ? (who) => setMuted(who, true) : null}
                              ${/* A muted reader's react, edit and delete would be seen by
                                  nobody: the menu stands down with the composer. */ ''}
                              hushed=${iAmMuted}
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
                    <button class="feed-unpublish-go" onClick=${deleteLine}>${t('apps.chat.delete', 'delete')}</button>
                    <button class="feed-unpublish-no" onClick=${() => setDeletingLine(null)}>${t('apps.chat.keep-it', 'keep it')}</button>
                </div>
            </${Modal}>`}
            ${/* A left room (Curtis, 2026-09-19): no composer - the honest word that it is
                not being updated, and the way back in. */ ''}
            ${iAmMuted
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
                          title=${t('apps.chat.attach-a-picture-sound-or-video', 'attach a picture, a sound or a video (drop or paste works too)')}
                          onClick=${pickFiles}
                      >
                          <${Icons.upload} />
                      </button>
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
                  ${uploadExtras}`}
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

export const ChatApp = ({ current, author, doc, mode, admin }) => {
    const root = current && current.root;
    const loc = useLocation();
    const [page, setPage] = useState(null);
    // Where this browser was (Curtis, 2026-09-20): the room last opened here, remembered
    // across a close and a refresh, and only here - a per-browser gesture, like a tucked
    // column, never a fact about the persona.
    const [wasOpen, setWasOpen] = usePref(root, OPEN_ROOM_KEY, '');
    const restored = useRef(false);
    const { tucked, toggleTuck } = useColTucks(root, APP_ID, []);
    const { resizer, colStyle } = useColWidths(root, APP_ID, ['rooms'], { rooms: 180 });
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
            loc.route(`/home/chat/${was}/${wasDoc}`);
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
    const rooms = page && page.items;
    const selected = author && doc ? { author, doc } : null;
    return html`<div class="chat">
        <div class="chat-columns" style=${colStyle}>
            ${tucked.has('rooms')
                ? html`<${Rail} icon=${Icons.chat} label=${t('apps.chat.chats', 'chats')} onClick=${() => toggleTuck('rooms')} />`
                : html`<${RoomsColumn} current=${current} rooms=${rooms} selected=${selected} onTuck=${() => toggleTuck('rooms')} />${resizer('rooms')}`}
            <section class="chat-main">
                ${mode === 'new'
                    ? html`<${NewRoom}
                          root=${root}
                          onMade=${(post) => {
                              load();
                              loc.route(`/home/chat/${root}/${post}`);
                          }}
                      />`
                    : selected
                      ? html`<${Room}
                            key=${`${author}/${doc}`}
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
