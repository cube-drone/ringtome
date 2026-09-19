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
import { speakable } from '../speakable.js';
import { useColWidths, useColTucks, PaneHead, Rail } from '../panes.js';
import { LiveMarquee } from '../doc/livemarquee.js';
import { useUploadCapture } from '../doc/upload.js';
import { emojiCompletions, linkCompletions, mediaCompletions, mentionCompletions } from '../doc/completions.js';
import { userCardHtml, userSpanHtml, useUserCards } from '../doc/usercard.js';
import { insertNewlineAndIndent } from '@codemirror/commands';

/// Where a room's uploads file (CHAT.md, ruling 11): the chat app's own bucket, beside the
/// rooms - so the `!` picker offers what was said here before.
const CHAT_BUCKET = 'chat';

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
                <span class="chat-row-name">${roomName(words, room)}</span>
                <span class="chat-row-when">${room.latest_ms ? whenWords(room.latest_ms) : t('apps.chat.quiet', 'quiet')}</span>
            </span>
            <span class="chat-row-by"><${PersonChip} root=${room.author} current=${current} /></span>
        </span>
    </li>`;
};

const RoomsColumn = ({ current, rooms, selected, onTuck }) => {
    const loc = useLocation();
    // Active rooms on top, the rooms this persona left beneath a divider (Curtis,
    // 2026-09-19): left rooms are not synced and never bold, until rejoined.
    const active = (rooms || []).filter((r) => !r.left);
    const left = (rooms || []).filter((r) => r.left);
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
            setName('');
            setWords('');
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
            <textarea
                class="chat-new-words"
                placeholder=${t('apps.chat.what-is-it-for', 'what is it for? (optional)')}
                value=${words}
                onInput=${(e) => setWords(e.currentTarget.value)}
            ></textarea>
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

/// One line on the floor. `cont` is a line by the same speaker as the one before it: the
/// speaker is implied, so it wears no card (IRC's and Slack's run-of-lines).
const Line = ({ m, current, cont }) => {
    const profile = useTurbolinks(m.words || '', 'marquee');
    const when = new Date(m.said_ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return html`<li class=${cont ? 'chat-line chat-line-cont' : 'chat-line'}>
        ${!cont &&
        html`<div class="chat-line-head">
            <${Speaker} root=${m.speaker} current=${current} />
            <span class="chat-line-when">${when}</span>
        </div>`}
        <div class="chat-line-body" title=${cont ? when : undefined}>
            ${m.words === null
                ? html`<span class="chat-msg-sealed"><${Icons.trustPrivate} /> ${t('apps.chat.sealed-words-you-cannot-open', 'sealed words this computer cannot open')}</span>`
                : html`<${MarqueeBody} source=${m.words} profile=${profile} onUnparsable=${bareSource} />`}
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
    const keepOffset = useRef(null); // the floor's height before older lines landed
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [sendError, setSendError] = useState(null);
    const [typing, setTyping] = useState([]);
    const [chatters, setChatters] = useState(null);
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
    const completions = useMemo(
        () => [emojiCompletions, linkCompletions(root, CHAT_BUCKET), mediaCompletions(root, CHAT_BUCKET), mentionCompletions(root)],
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
            .then((c) => setChatters(c.items || []))
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
    const send = async () => {
        const said = draft.trim();
        if (!said || sending) return;
        setSending(true);
        setSendError(null);
        try {
            await api(`/api/identity/${root}/rooms/${author}/${doc}/messages`, {
                method: 'POST',
                body: JSON.stringify({ words: said }),
            });
            setDraft('');
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
    const leave = async () => {
        try {
            await api(`/api/identity/${root}/rooms/${author}/${doc}`, { method: 'DELETE' });
        } catch {
            /* the list re-reads on the next look */
        }
        if (onChanged) onChanged();
        loc.route('/home/chat');
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
    // The floor: the room's post first, said by its creator, then every line oldest to
    // newest; a run of lines by one speaker is attributed once.
    const lines = [];
    if (words.body) {
        lines.push({ hash: 'post', speaker: author, said_ms: room.published_ms || 0, words: words.body, post: true });
    }
    for (const m of [...((history && history.items) || [])].reverse()) lines.push(m);
    return html`<section class="chat-room">
        <header class="chat-room-head">
            <h2 class="chat-room-name">${name}</h2>
            <${PersonChip} root=${author} current=${current} />
            ${room.trusted_only &&
            html`<span class="label-chip label-chip-flag"><${Icons.trustPrivate} /> ${room.onward ? t('apps.chat.trusted-and-onward', 'trusted, and onward') : t('apps.chat.sealed', 'sealed')}</span>`}
            ${/* Nobody is "in" a room (Curtis, 2026-09-18): the only roster is who has visibly
                spoken, newest speaker first, with when. */ ''}
            <details class="chat-chatters">
                <summary class="chat-chatters-summary">
                    ${chatters && chatters.length > 0
                        ? t('apps.chat.n-chatters', '{count} chatters', { count: chatters.length })
                        : t('apps.chat.chatters', 'chatters')}
                </summary>
                <ul class="chat-chatters-list">
                    ${(chatters || []).map(
                        (c) => html`<li key=${c.root} class="chat-chatters-row">
                            <${Speaker} root=${c.root} current=${current} />
                            <span class="chat-chatters-when">${whenWords(c.last_ms)}</span>
                        </li>`
                    )}
                    ${chatters && chatters.length === 0 && html`<li class="chat-chatters-row chat-chatters-none">${t('apps.chat.nobody-has-spoken-here', 'nobody has spoken here yet')}</li>`}
                </ul>
            </details>
            <a class="chat-room-post" href=${`/id/${speakable(author)}/post/${doc}`}>${t('apps.chat.the-rooms-post', "the room's post")}</a>
            ${/* The archive's standing (ruling 6): the creator's node keeps its rooms whole
                unasked; a node whose operator pressed full-sync says so, and may release. */ ''}
            ${room.archived
                ? html`<span class="label-chip chat-archived" title=${t('apps.chat.this-node-keeps-the-whole-room', 'this node keeps the whole room, not just the latest')}>
                      ${t('apps.chat.kept-whole-here', 'kept whole here')}
                      ${admin && html`<button class="chat-archive" disabled=${archiving} onClick=${() => setArchive(false)}>${t('apps.chat.release', 'release')}</button>`}
                  </span>`
                : room.archivist && html`<span class="label-chip chat-archived">${t('apps.chat.the-archive', 'the archive')}</span>`}
            ${room.joined && html`<button class="chat-leave" onClick=${leave}>${t('apps.chat.leave', 'leave')}</button>`}
        </header>
        <div class="chat-floor" ref=${floor} onScroll=${trackEnd}>
            ${/* The gap (Curtis, 2026-09-19): where what this computer holds runs out sits
                the way past it - a page of earlier lines for anyone, and for the node's
                operator the full-sync, which loads the entire history here and keeps it. */ ''}
            ${history &&
            history.more &&
            html`<div class="chat-gap">
                <button class="chat-older" disabled=${older} onClick=${readOlder}>${older ? t('apps.chat.reading', 'reading…') : t('apps.chat.earlier', 'earlier…')}</button>
                ${admin &&
                !room.archived &&
                !room.archivist &&
                html`<button
                    class="chat-older chat-archive-all"
                    disabled=${archiving}
                    onClick=${() => setArchive(true)}
                    title=${t('apps.chat.pull-the-whole-room-and-keep-it', "pull the room's whole history from its creator's node, and keep it here from now on")}
                >
                    ${archiving ? t('apps.chat.loading-the-entire-history', 'loading the entire history…') : t('apps.chat.load-the-entire-history-here', 'load the entire history here')}
                </button>`}
            </div>`}
            ${history && lines.length === 0 && html`<p class="chat-empty">${t('apps.chat.nobody-has-said-anything-here', 'nobody has said anything here yet')}</p>`}
            <ul class="chat-lines">
                ${lines.map((m, i) => html`<${Line} key=${m.hash} m=${m} current=${current} cont=${i > 0 && lines[i - 1].speaker === m.speaker} />`)}
            </ul>
            ${/* Typing shows where the next line will land: at the end of the floor. */ ''}
            ${typing.length > 0 &&
            html`<p class="chat-typing">
                ${typing.map((r) => html`<${PersonChip} key=${r} root=${r} current=${current} />`)}
                ${typing.length === 1 ? t('apps.chat.is-typing', 'is typing…') : t('apps.chat.are-typing', 'are typing…')}
            </p>`}
        </div>
        <div class="chat-foot">
            ${/* A left room (Curtis, 2026-09-19): no composer - the honest word that it is
                not being updated, and the way back in. */ ''}
            ${room.left
                ? html`<p class="chat-closed chat-left-note">
                      <${Icons.trustPrivate} />
                      ${t('apps.chat.you-left-this-room', "you left this room - it isn't being updated here, and what you see may be out of date")}
                      <button class="chat-rejoin" onClick=${rejoin}>${t('apps.chat.rejoin', 'rejoin')}</button>
                  </p>`
                : history && history.closed
                ? html`<p class="chat-closed"><${Icons.settled} /> ${t('apps.chat.this-room-is-closed', 'this room is closed - the conversation ended, and the record stands')}</p>`
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
                          disabled=${sending || !draft.trim()}
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
