// Chat: real-time rooms (CHAT.md). A room is a post - its title the room's name, its words
// the description, its seal and audience the post's own - and this app lists the rooms a
// persona may see (ruling 7): its own, the ones its feed carries, the ones it entered by
// link. Slice 1 (2026-09-18): the rooms and their doors; a room you can enter and find
// empty. Messages, presence and history are the slices after this one.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { api, apiTextTitled } from '../net.js';
import { t } from '../i18n.js';
import { Icons } from '../icons.js';
import { PersonChip } from '../person.js';
import { MarqueeBody, bareSource } from '../doc/marqueebody.js';
import { useTurbolinks } from '../doc/turbolinks.js';
import { openMirror, useLive } from '../mirror.js';
import { tagCounts } from '../pure/contacttags.js';
import { speakable } from '../speakable.js';

const html = htm.bind(h);

/// The rooms' drafts live in the app's eponymous bucket, as the feed's do in `feed`.
const CHAT_STYLE = 'chat';

/// A sealed room's name travels with its words (PROJECT_PLAN's Replies under the author's
/// seal, ruling 5): the list row asks the body door for it, and reads "a sealed room" until
/// the words arrive - or forever, for a room this reader may not open.
const useRoomWords = (room) => {
    const [words, setWords] = useState({ title: room.title || '', body: undefined });
    useEffect(() => {
        let live = true;
        setWords({ title: room.title || '', body: undefined });
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

const RoomRow = ({ room, current }) => {
    const loc = useLocation();
    const words = useRoomWords(room);
    const name = words.title || (room.trusted_only ? t('apps.chat.a-sealed-room', 'a sealed room') : t('apps.chat.an-unnamed-room', 'an unnamed room'));
    return html`<li class="chat-row" onClick=${() => loc.route(`/home/chat/${room.author}/${room.doc_id}`)}>
        <span class="chat-row-icon"><${Icons.chat} /></span>
        <span class="chat-row-main">
            <span class="chat-row-name">${name}</span>
            <span class="chat-row-by">
                <${PersonChip} root=${room.author} current=${current} />
                ${room.trusted_only &&
                html`<span class="label-chip label-chip-flag" title=${t('apps.chat.sealed-room-title', 'the author shares this room only with people they trust')}
                    ><${Icons.trustPrivate} /> ${room.onward ? t('apps.chat.trusted-and-onward', 'trusted, and onward') : t('apps.chat.sealed', 'sealed')}</span
                >`}
                ${room.joined && html`<span class="label-chip label-chip-flag">${t('apps.chat.joined-by-link', 'joined by link')}</span>`}
                ${room.mine && html`<span class="label-chip label-chip-flag">${t('apps.chat.yours', 'yours')}</span>`}
            </span>
        </span>
    </li>`;
};

/// The new-room form: a name, a description, and who may see it - the composer's own list
/// (Contact tags, rulings 4 and 7), most to least permissive.
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
    return html`<form
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
    </form>`;
};

export const ChatApp = ({ current }) => {
    const root = current && current.root;
    const loc = useLocation();
    const [page, setPage] = useState(null);
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
    const items = (page && page.items) || [];
    return html`<div class="chat-app">
        <${NewRoom} root=${root} onMade=${(post) => loc.route(`/home/chat/${root}/${post}`)} />
        ${page && items.length === 0
            ? html`<p class="chat-empty">
                  <${Icons.chat} />
                  ${t('apps.chat.no-rooms-yet', 'no rooms yet - open one above, or follow someone who has')}
              </p>`
            : html`<ul class="chat-list">
                  ${items.map((r) => html`<${RoomRow} key=${`${r.author}/${r.doc_id}`} room=${r} current=${current} />`)}
              </ul>`}
    </div>`;
};

/// The room's floor (CHAT.md, slice 2): the history this node holds, newest at the bottom,
/// re-read on a slow beat and after every send. Sync alone carries the messages - the
/// node pulls the room from the creator's node when the page opens and on its own beat -
/// so the floor is honest about its lag; live delivery is slice 3's.
const HISTORY_POLL_MS = 15000;

const MessageRow = ({ m, current }) => {
    const profile = useTurbolinks(m.words || '', 'marquee');
    const when = new Date(m.said_ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return html`<li class="chat-msg">
        <span class="chat-msg-who"><${PersonChip} root=${m.speaker} current=${current} /></span>
        <span class="chat-msg-main">
            <span class="chat-msg-when">${when}</span>
            ${m.words === null
                ? html`<span class="chat-msg-sealed"><${Icons.trustPrivate} /> ${t('apps.chat.sealed-words-you-cannot-open', 'sealed words this computer cannot open')}</span>`
                : html`<div class="chat-msg-words"><${MarqueeBody} source=${m.words} profile=${profile} onUnparsable=${bareSource} /></div>`}
        </span>
    </li>`;
};

/// One room, entered: the door decides (CHAT.md, ruling 2), the words describe it, and the
/// floor is what the node holds of every speaker's chain (ruling 3).
export const RoomPage = ({ current, author, doc }) => {
    const root = current && current.root;
    const loc = useLocation();
    const [room, setRoom] = useState(undefined); // undefined loading, null refused, object entered
    const [refusal, setRefusal] = useState('');
    const [history, setHistory] = useState(null); // { items, closed }
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [sendError, setSendError] = useState(null);
    const [here, setHere] = useState([]);
    const [typing, setTyping] = useState([]);
    const socket = useRef(null);
    const typingSaid = useRef(0);
    const readHistory = () => {
        if (!root) return;
        api(`/api/identity/${root}/rooms/${author}/${doc}/messages`)
            .then(setHistory)
            .catch(() => {});
    };
    useEffect(() => {
        if (!root || !room) return undefined;
        // Pull the room from the creator's node first, then read what landed; then the beat.
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
        if (!root || !room) return undefined;
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
                    if (msg.type === 'presence') {
                        setHere(msg.here || []);
                        setTyping((msg.typing || []).filter((r) => r !== root));
                    }
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
    const typingIdle = useRef(null);
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
        const words = draft.trim();
        if (!words || sending) return;
        setSending(true);
        setSendError(null);
        try {
            await api(`/api/identity/${root}/rooms/${author}/${doc}/messages`, {
                method: 'POST',
                body: JSON.stringify({ words }),
            });
            setDraft('');
            sayTyping(false);
            readHistory();
        } catch (e) {
            setSendError(e.message || String(e));
        } finally {
            setSending(false);
        }
    };
    useEffect(() => {
        if (!root) return undefined;
        let live = true;
        setRoom(undefined);
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
    const profile = useTurbolinks(words.body || '', 'marquee');
    if (!root) return null;
    if (room === undefined) return html`<p class="chat-empty">${t('apps.chat.knocking', 'knocking…')}</p>`;
    if (room === null) {
        return html`<div class="chat-app">
            <p class="chat-empty"><${Icons.trustPrivate} /> ${refusal || t('apps.chat.this-room-is-not-open-to-you', 'this room is not open to you')}</p>
            <a class="chat-back" href="/home/chat">${t('apps.chat.back-to-your-rooms', 'back to your rooms')}</a>
        </div>`;
    }
    const name = words.title || room.title || (room.trusted_only ? t('apps.chat.a-sealed-room', 'a sealed room') : t('apps.chat.an-unnamed-room', 'an unnamed room'));
    const leave = async () => {
        try {
            await api(`/api/identity/${root}/rooms/${author}/${doc}`, { method: 'DELETE' });
        } catch {
            /* the list re-reads on the next look */
        }
        loc.route('/home/chat');
    };
    return html`<div class="chat-room">
        <header class="chat-room-head">
            <a class="chat-back" href="/home/chat" title=${t('apps.chat.back-to-your-rooms', 'back to your rooms')}><${Icons.chat} /></a>
            <h2 class="chat-room-name">${name}</h2>
            <${PersonChip} root=${author} current=${current} />
            ${room.trusted_only &&
            html`<span class="label-chip label-chip-flag"><${Icons.trustPrivate} /> ${room.onward ? t('apps.chat.trusted-and-onward', 'trusted, and onward') : t('apps.chat.sealed', 'sealed')}</span>`}
            <a class="chat-room-post" href=${`/id/${speakable(author)}/post/${doc}`}>${t('apps.chat.the-rooms-post', "the room's post")}</a>
            ${room.joined && html`<button class="chat-leave" onClick=${leave}>${t('apps.chat.leave', 'leave')}</button>`}
        </header>
        ${!!words.body && html`<div class="chat-room-words"><${MarqueeBody} source=${words.body} profile=${profile} onUnparsable=${bareSource} /></div>`}
        <div class="chat-room-body">
            <div class="chat-messages">
                ${history && history.items.length === 0 &&
                html`<p class="chat-empty">${t('apps.chat.nobody-has-said-anything-here', 'nobody has said anything here yet')}</p>`}
                ${history &&
                history.items.length > 0 &&
                html`<ul class="chat-msg-list">
                    ${[...history.items].reverse().map((m) => html`<${MessageRow} key=${m.hash} m=${m} current=${current} />`)}
                </ul>`}
                ${history && history.closed
                    ? html`<p class="chat-closed"><${Icons.settled} /> ${t('apps.chat.this-room-is-closed', 'this room is closed - the conversation ended, and the record stands')}</p>`
                    : html`<form
                          class="chat-composer"
                          onSubmit=${(e) => {
                              e.preventDefault();
                              send();
                          }}
                      >
                          <textarea
                              class="chat-composer-words"
                              placeholder=${t('apps.chat.say-something', 'say something…')}
                              value=${draft}
                              onInput=${(e) => {
                                  setDraft(e.currentTarget.value);
                                  sayTyping(e.currentTarget.value.trim().length > 0);
                              }}
                              onKeyDown=${(e) => {
                                  // Enter sends, Shift-Enter breaks a line (CHAT.md, ruling 7).
                                  if (e.key === 'Enter' && !e.shiftKey) {
                                      e.preventDefault();
                                      send();
                                  }
                              }}
                          ></textarea>
                          <button class="chat-composer-send" type="submit" disabled=${sending || !draft.trim()}>
                              ${t('apps.chat.send', 'send')}
                          </button>
                      </form>`}
                ${sendError && html`<p class="form-error">${sendError}</p>`}
            </div>
            <aside class="chat-rail">
                <p class="chat-rail-head">${t('apps.chat.here-now', 'here now')}</p>
                <ul class="chat-rail-list">
                    ${(here.includes(root) ? here : [root, ...here]).map(
                        (r) => html`<li key=${r} class="chat-rail-row">
                            <${PersonChip} root=${r} current=${current} />
                            ${typing.includes(r) && html`<span class="chat-rail-typing">${t('apps.chat.typing', 'typing…')}</span>`}
                        </li>`
                    )}
                </ul>
            </aside>
        </div>
    </div>`;
};
