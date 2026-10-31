// hrseAmp's player (plans/AUDIO.md, section 4; ruling 1): it plays across the whole app, so it
// belongs to the shell, not to hrseAmp's page - one audio element and one queue, held by the
// provider the shell wraps every app in, for as long as the persona is open. The desktop app is one
// window with no tabs, so a page that stopped its music on the way out would mean no music at all.
//
// hrseAmp hands it a list - the table as filtered and sorted - and a song to start with; it plays
// forward through the list, or through a shuffle of it (pure/shuffle.js). In hrseAmp it's a bar
// across the bottom; anywhere else in the app, a compact one above the dock while something plays;
// outside the app, the browser's Media Session, so the computer's media keys and the lock screen work.
import { h, createContext } from 'preact';
import { useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import { ShuffleRun } from './pure/shuffle.js';
import { clock, levelGain, onLabel, readContext, readPlayerState, slimRow } from './pure/amp.js';
import { LINE_ROOM, cassetteLook, fontFit } from './pure/cassette.js';
import { kickAt, kicks } from './pure/bounce.js';
import { Icons } from './icons.js';
import { t } from './i18n.js';
import { apiBytes } from './net.js';

const html = htm.bind(h);

const Player = createContext(null);
export const usePlayer = () => useContext(Player);

/// Where hrseAmp lives.
export const AMP_PATH = '/ringtome/amp';

const VOLUME_KEY = 'amp-volume';
/// Loudness levelling's switch, per computer (plans/AUDIO.md, section 9): on unless turned off.
const LEVEL_KEY = 'amp-level';
/// The list, the song, the shuffle and where it stands, per persona, durable across a refresh
/// (Curtis, 2026-10-12); and where in the song, kept apart since it's written every few seconds.
const STATE_KEY = (me) => `amp-player:${me}`;
const AT_KEY = (me) => `amp-player-at:${me}`;
const keep = (key, value) => {
    try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch {
        /* no storage, or full: the player lives for the page */
    }
};
const kept = (key) => {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
};

/// A song's address: your own through your private door, anyone else's through their public one.
export const soundSrc = (row, me) =>
    row.own ? `/api/identity/${me}/docs/${row.doc}/body` : `/id/${row.author}/docs/${row.doc}/body`;
export const soundThumb = (row, me) =>
    row.own
        ? `/api/identity/${me}/docs/${row.doc}/thumb`
        : `/id/${row.author}/docs/${row.doc}/thumb`;

const readVolume = () => {
    try {
        const v = parseFloat(localStorage.getItem(VOLUME_KEY));
        return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8;
    } catch {
        return 0.8;
    }
};

/// The shuffle's options: what a song is, who and what album it's by, and your thumbs on it.
export const SHUFFLE = {
    keyOf: (r) => r.key,
    artistOf: (r) => r.artist,
    albumOf: (r) => (r.album ? `${r.artist}/${r.album}` : ''),
    ratingOf: (r) => (r.layer && r.layer.reaction) || '',
};

/// The phone's own player (plans/AUDIO.md, section 10): on Android the page hands its queue to the
/// native player (desktop/gen/android, PlayerBridge.kt) - which holds the notification, the lock
/// screen, the headphones and the car, and plays on with the screen off - instead of playing it in
/// an `<audio>`. Everywhere else, null.
const nativePlayer = () => (typeof window !== 'undefined' && window.__ringtomePlayer) || null;

/// A song as the phone's player takes it (PlayerBridge.kt, AutoLibrary.kt): where it is on this
/// phone's own node, and what it is.
export function songForPhone(row, me) {
    const origin = typeof location !== 'undefined' ? location.origin : '';
    return {
        key: row.key,
        url: `${origin}${soundSrc(row, me)}`,
        title: row.title || '',
        artist: row.artist || '',
        album: row.album || '',
        art: row.thumb ? `${origin}${soundThumb(row, me)}` : '',
        durationMs: row.lengthMs || 0,
    };
}

/// How far ahead the phone's player is handed songs: it plays on through them while the page sleeps.
const NATIVE_AHEAD = 50;

/// How long the compact player stays after the music pauses (Curtis, 2026-10-13: it "stays up long
/// after we've stopped playing music"), in milliseconds. A stop takes it away at once.
const MINI_LINGER = 5 * 60 * 1000;

export const PlayerProvider = ({ me, children }) => {
    const native = useMemo(nativePlayer, []);
    const audio = useMemo(
        () => (native || typeof Audio === 'undefined' ? null : new Audio()),
        [native],
    );
    const [current, setCurrent] = useState(null);
    const [playing, setPlaying] = useState(false);
    const [shuffle, setShuffleState] = useState(false);
    const [position, setPosition] = useState(0);
    const [duration, setDuration] = useState(0);
    const [volume, setVolumeState] = useState(readVolume);
    // Muted by the speaker (Curtis, 2026-10-13): the volume kept, for unmuting back to.
    const [muted, setMuted] = useState(false);
    const [expanded, setExpanded] = useState(false);
    // When the music last stopped playing, for the compact player to go after a while; null while
    // it plays, and 0 for a song that hasn't played on this page (the one a refresh brought back).
    const [idleSince, setIdleSince] = useState(0);
    const wasPlaying = useRef(false);
    // What the list was played from (pure/amp.js `readContext`), for the now-playing column.
    const [context, setContextState] = useState(null);
    const contextRef = useRef(null);
    // The song the page is asked to show in its file column (the cover pressed), until it has.
    const [revealing, setRevealing] = useState(null);
    const [levelling, setLevellingState] = useState(() => {
        try {
            return localStorage.getItem(LEVEL_KEY) !== 'off';
        } catch {
            return true;
        }
    });
    // The list and where we are in it, kept out of render state: the audio element's events read
    // them, and a re-render must never lose the shuffle (stable within a session, ruling).
    const list = useRef([]);
    const index = useRef(-1);
    const run = useRef(null);
    const failures = useRef(0);
    // The song and the mode as the last call left them, for `persist` - render state lags a call.
    const currentRef = useRef(null);
    const shuffleRef = useRef(false);
    const savedAt = useRef(0);
    // A radio station playing (plans/AUDIO.md, section 6): its run picks every song, and its id is
    // what the page shows as playing. After a refresh the station comes back as its history alone
    // (`pending`) until hrseAmp, which holds the library a station picks from, rebuilds the run.
    const stationRun = useRef(null);
    const stationId = useRef(null);
    const pending = useRef(null); // { id, rows, pos }
    const [station, setStation] = useState(null);
    // What the phone's player holds (native mode): `rows` as handed over, `base` the model's place of
    // the first of them (the list's index, the shuffle's or the station's position), and `offset` the
    // player's index of the first - so the player's index says where the model is.
    const nq = useRef({ rows: [], base: 0, offset: 0 });
    // Where the phone's player last said it was, and when, for `now` to count on from - and how
    // many songs it holds, for play to know an empty player from a paused one.
    const said = useRef({ at: 0, when: 0, playing: false, count: 0 });
    // The saved song's hand-over to the phone's player, waiting for the player to say what it
    // holds (the restore, below): null once done, or when there was nothing to hand over.
    const joinPhone = useRef(null);

    const persist = () => {
        if (!me) return;
        if (stationId.current) {
            const history = stationRun.current
                ? stationRun.current.history
                : (pending.current && pending.current.rows) || [];
            const at = stationRun.current
                ? stationRun.current.pos
                : pending.current
                  ? pending.current.pos
                  : -1;
            // The last two hundred songs are history enough to walk back through.
            const kept = history.slice(-200);
            const from = stationRun.current
                ? stationRun.current.from
                : (pending.current && pending.current.from) || [];
            keep(
                STATE_KEY(me),
                JSON.stringify({
                    station: stationId.current,
                    rows: kept.map(slimRow),
                    from: from.slice(-kept.length),
                    pos: at - (history.length - kept.length),
                    current: currentRef.current ? currentRef.current.key : null,
                    context: contextRef.current,
                }),
            );
            return;
        }
        if (!list.current.length) {
            keep(STATE_KEY(me), null);
            keep(AT_KEY(me), null);
            return;
        }
        keep(
            STATE_KEY(me),
            JSON.stringify({
                rows: list.current.map(slimRow),
                current: currentRef.current ? currentRef.current.key : null,
                shuffle: shuffleRef.current,
                run: run.current ? run.current.snapshot() : null,
                context: contextRef.current,
            }),
        );
    };

    // The model's place, and the songs from it on - what the phone's player is handed.
    const modelPos = () =>
        stationId.current && stationRun.current
            ? stationRun.current.pos
            : shuffleRef.current && run.current
              ? run.current.pos
              : index.current;
    const setModelPos = (p) => {
        if (stationId.current && stationRun.current) stationRun.current.pos = p;
        else if (shuffleRef.current && run.current) run.current.pos = p;
        else index.current = p;
    };
    const fromModel = () => {
        if (stationId.current) {
            const r = stationRun.current;
            if (!r) return [];
            r.ahead(NATIVE_AHEAD);
            return r.history.slice(r.pos);
        }
        if (shuffleRef.current && run.current) {
            const r = run.current;
            while (r.items.length && r.order.length - 1 - r.pos < NATIVE_AHEAD) r.extend();
            return r.order.slice(r.pos);
        }
        return list.current.slice(Math.max(0, index.current));
    };
    const handed = (rows) => JSON.stringify(rows.map((r) => songForPhone(r, me)));

    const load = (row, { play = true } = {}) => {
        if (native) {
            setCurrent(row);
            currentRef.current = row;
            persist();
            if (!row) {
                native.stop();
                setPlaying(false);
                return;
            }
            const rows = fromModel();
            nq.current = { rows, base: modelPos(), offset: 0 };
            native.play(handed(rows), 0, 0, play);
            return;
        }
        if (!audio) return;
        setCurrent(row);
        currentRef.current = row;
        persist();
        keep(AT_KEY(me), null);
        if (!row) {
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
            setPlaying(false);
            return;
        }
        audio.src = soundSrc(row, me);
        if (play) audio.play().catch(() => {});
    };

    const step = (forward) => {
        // The phone's player walks its own queue; the page follows what it says (below).
        if (native) {
            if (!currentRef.current) return load(fromModel()[0] || null);
            return forward ? native.next() : native.previous();
        }
        if (stationId.current) {
            // Rebuilt by the page after a refresh; until then the song in hand is all there is.
            if (!stationRun.current) return undefined;
            return load(forward ? stationRun.current.next() : stationRun.current.prev());
        }
        if (!list.current.length) return load(null);
        if (shuffleRef.current && run.current) {
            return load(forward ? run.current.next() : run.current.prev());
        }
        const next = index.current + (forward ? 1 : -1);
        if (next >= list.current.length) {
            // The end of the list: stop, and stand ready at its start.
            index.current = -1;
            return load(null);
        }
        index.current = Math.max(0, next);
        return load(list.current[index.current]);
    };

    // The phone's player told what comes after the song playing, after a re-sort or a shuffle
    // switched: the model's songs from here on, in place of what it held.
    const handUpcoming = () => {
        if (!native || !currentRef.current) return;
        const rows = fromModel();
        // Only when the model holds the song the phone is playing, at its head: a table still
        // loading (empty, or not yet holding it) must never cut the phone's queue mid-drive.
        if (!rows.length || rows[0].key !== currentRef.current.key) return;
        const playingAt = nq.current.rows.findIndex((r) => r.key === currentRef.current.key);
        nq.current = {
            rows,
            base: modelPos(),
            offset: (playingAt >= 0 ? playingAt : 0) + nq.current.offset,
        };
        native.upcoming(handed(rows.slice(1)));
    };

    // What's playing is from here.
    const setContext = (c) => {
        const next = readContext(c);
        contextRef.current = next;
        setContextState(next);
    };

    // The song where the model stands: the station's, the shuffle's, or the list's.
    const modelRow = () =>
        stationId.current
            ? stationRun.current && stationRun.current.current()
            : shuffleRef.current && run.current
              ? run.current.current()
              : list.current[index.current] || null;

    // The songs either side of the one playing, up to `n` each way, for the now-playing column:
    // `{ past, ahead }`, each `[{ row, from }]` - `from` the station's slice that picked it, by its
    // path, where a station did. Looking ahead picks ahead, as the phone's player is handed picks:
    // next walks the same songs.
    const around = (n) => {
        const none = { past: [], ahead: [] };
        if (!currentRef.current) return none;
        const pair = (rows, from, at) =>
            rows.map((row, i) => ({ row, from: from[at + i] || null }));
        if (stationId.current) {
            const r = stationRun.current;
            if (!r) {
                const p = pending.current;
                if (!p) return none;
                const lo = Math.max(0, p.pos - n);
                return { past: pair(p.rows.slice(lo, p.pos), p.from || [], lo), ahead: [] };
            }
            r.ahead(n);
            const lo = Math.max(0, r.pos - n);
            return {
                past: pair(r.history.slice(lo, r.pos), r.from, lo),
                ahead: pair(r.history.slice(r.pos + 1, r.pos + 1 + n), r.from, r.pos + 1),
            };
        }
        if (shuffleRef.current && run.current) {
            const r = run.current;
            while (r.items.length && r.order.length - 1 - r.pos < n) r.extend();
            const lo = Math.max(0, r.pos - n);
            return {
                past: pair(r.order.slice(lo, r.pos), [], 0),
                ahead: pair(r.order.slice(r.pos + 1, r.pos + 1 + n), [], 0),
            };
        }
        const i = index.current;
        const lo = Math.max(0, i - n);
        return {
            past: i > 0 ? pair(list.current.slice(lo, i), [], 0) : [],
            ahead: pair(list.current.slice(i + 1, i + 1 + n), [], 0),
        };
    };

    // Out of station mode, into a list.
    const leaveStation = () => {
        stationRun.current = null;
        stationId.current = null;
        pending.current = null;
        setStation(null);
    };

    const api = {
        current,
        playing,
        shuffle,
        station,
        position,
        duration,
        volume,
        expanded,
        me,
        muted,
        idleSince,
        context,
        revealing,
        /// The songs around the one playing (`around`).
        around,
        /// Play `rows`, from `row` (or the first, or the shuffle's first). `from` says what they
        /// are (pure/amp.js `readContext`).
        play(rows, row = null, from = null) {
            leaveStation();
            setContext(from);
            list.current = rows;
            failures.current = 0;
            if (shuffleRef.current) {
                run.current = new ShuffleRun(rows, { ...SHUFFLE, random: Math.random }, row);
                load(run.current.next());
            } else {
                index.current = row
                    ? Math.max(
                          0,
                          rows.findIndex((r) => r.key === row.key),
                      )
                    : 0;
                load(rows[index.current] || null);
            }
        },
        /// The list changed under a playing song (a filter, a sort): keep playing, carry on through
        /// the new list from where this song sits in it.
        relist(rows, from = null) {
            // A station picks from its own slices, whatever the table shows.
            if (stationId.current) return;
            setContext(from);
            list.current = rows;
            if (run.current) run.current.replaceItems(rows);
            if (current) index.current = rows.findIndex((r) => r.key === current.key);
            persist();
            handUpcoming();
        },
        /// Play a radio station: `stationRunObj` (pure/stations.js `StationRun`) picks every song.
        playStation(id, stationRunObj, name = '') {
            setContext({ kind: 'station', id, name });
            list.current = [];
            index.current = -1;
            run.current = null;
            stationRun.current = stationRunObj;
            stationId.current = id;
            pending.current = null;
            setStation(id);
            failures.current = 0;
            load(stationRunObj.next());
        },
        /// The station that was playing before a refresh, as its history - for the page to rebuild
        /// its run from - or null.
        pendingStation: () => (stationId.current && !stationRun.current ? pending.current : null),
        /// The page rebuilt the station's run; it carries on from here.
        resumeStation(stationRunObj) {
            if (!stationId.current) return;
            stationRun.current = stationRunObj;
            pending.current = null;
            persist();
        },
        /// The run playing now, so the page can tell it the library changed.
        stationRun: () => stationRun.current,
        /// The playing station's picks ahead changed (new songs came in): a phone's player holding
        /// the old ones is handed what follows the song it's on again.
        stationAhead() {
            if (!native || !stationId.current || !stationRun.current) return;
            const rows = fromModel();
            const q = nq.current;
            nq.current = { rows, base: modelPos(), offset: q.offset + (modelPos() - q.base) };
            native.upcoming(handed(rows.slice(1)));
        },
        toggle() {
            if (native) {
                if (!currentRef.current) return step(true);
                // A song in hand but none in the phone's player - the service ended while the page
                // slept, say: play hands it over again rather than toggling an empty player.
                if (!said.current.count) return load(currentRef.current);
                return native.toggle();
            }
            if (!audio) return;
            if (!current) return step(true);
            if (audio.paused) audio.play().catch(() => {});
            else audio.pause();
        },
        /// The end of listening, where pause is a breath (Curtis, 2026-10-13: "what's the difference
        /// between pause and stop?"): the song is let go - the compact player goes with it - and a
        /// station goes off the air. What was playing is kept, for play to start again.
        stop() {
            leaveStation();
            load(null);
            setIdleSince(Date.now());
            if (!native) keep(AT_KEY(me), null);
        },
        /// Jump `by` songs along the queue - back into what played, or ahead into what's picked.
        jump(by) {
            if (!by || !currentRef.current) return;
            if (stationId.current && stationRun.current) {
                const r = stationRun.current;
                r.ahead(Math.max(0, by));
                r.pos = Math.max(0, Math.min(r.history.length - 1, r.pos + by));
            } else if (shuffleRef.current && run.current) {
                const r = run.current;
                while (r.items.length && r.order.length - 1 - r.pos < by) r.extend();
                r.pos = Math.max(0, Math.min(r.order.length - 1, r.pos + by));
            } else if (list.current.length) {
                index.current = Math.max(0, Math.min(list.current.length - 1, index.current + by));
            } else return;
            failures.current = 0;
            load(modelRow());
        },
        /// Show the song playing in hrseAmp's file column (its cover pressed); `revealed` once shown.
        reveal() {
            if (currentRef.current) setRevealing(currentRef.current.key);
        },
        revealed: () => setRevealing(null),
        next: () => step(true),
        /// Back a song - or, a few seconds in, to this song's start, as every player does.
        prev() {
            if (native) return step(false);
            if (audio && audio.currentTime > 3) {
                audio.currentTime = 0;
                return;
            }
            step(false);
        },
        setShuffle(on) {
            setShuffleState(on);
            shuffleRef.current = on;
            if (on) {
                run.current = new ShuffleRun(
                    list.current,
                    { ...SHUFFLE, random: Math.random },
                    current,
                );
                if (current) run.current.next();
            } else {
                run.current = null;
                if (current) index.current = list.current.findIndex((r) => r.key === current.key);
            }
            persist();
            handUpcoming();
        },
        /// Where in the song, now, to the frame - the cassette's bounce asks every frame, and the
        /// position the page re-renders on moves only a few times a second.
        now() {
            if (audio) return audio.currentTime || 0;
            const s = said.current;
            return s.at + (s.playing ? (performance.now() - s.when) / 1000 : 0);
        },
        seek(seconds) {
            if (native && Number.isFinite(seconds)) native.seek(Math.round(seconds * 1000));
            if (audio && Number.isFinite(seconds)) audio.currentTime = seconds;
        },
        setVolume(v) {
            setVolumeState(v);
            setMuted(false);
            try {
                localStorage.setItem(VOLUME_KEY, String(v));
            } catch {
                /* the volume lives for the page */
            }
        },
        toggleMute: () => setMuted((m) => !m),
        setExpanded,
        levelling,
        setLevelling(on) {
            setLevellingState(on);
            try {
                localStorage.setItem(LEVEL_KEY, on ? 'on' : 'off');
            } catch {
                /* the switch lives for the page */
            }
        },
    };
    // The audio element's events call through this, so they always see the latest list and mode.
    const live = useRef(api);
    live.current = api;

    // The volume, and a loud song brought down to the rest (ruling 20) - a multiplier on the
    // volume alone, so no Web Audio, and nothing to stop the music when the screen locks.
    const gain = levelling && current ? levelGain(current.loudness) : 1;
    useEffect(() => {
        const level = muted ? 0 : Math.max(0, Math.min(1, volume * gain));
        if (native) native.volume(level);
        if (!audio) return undefined;
        audio.volume = level;
    }, [audio, native, volume, gain, muted]);

    // The compact player's clock: playing, it stays; stopped playing, it goes a while later.
    useEffect(() => {
        if (playing) {
            wasPlaying.current = true;
            setIdleSince(null);
        } else if (wasPlaying.current) {
            wasPlaying.current = false;
            setIdleSince(Date.now());
        }
    }, [playing]);

    // What the phone's player says (PlayerBridge.kt): the song it's on, whether it plays, where it
    // is. The page follows - its model moved to the song the player reached, more songs handed over
    // as it nears the end of what it holds - so the bar, the compact player and the cassette show
    // the phone's truth, even after the page has slept through several songs.
    useEffect(() => {
        if (!native || typeof window === 'undefined') return undefined;
        const hear = (state) => {
            if (!state || typeof state !== 'object') return;
            setPlaying(!!state.playing);
            setPosition((state.position || 0) / 1000);
            said.current = {
                at: (state.position || 0) / 1000,
                when: performance.now(),
                playing: !!state.playing,
                count: state.count || 0,
            };
            setDuration((state.duration || 0) / 1000);
            const q = nq.current;
            const at = (state.index ?? -1) - q.offset;
            const row = at >= 0 ? q.rows[at] : null;
            if (row && state.key === row.key) {
                if (!currentRef.current || currentRef.current.key !== row.key) {
                    setModelPos(q.base + at);
                    currentRef.current = row;
                    setCurrent(row);
                    persist();
                }
                // Near the end of what it holds: a shuffle's next cycle, a station's next picks.
                if (q.rows.length - at <= 8 && (shuffleRef.current || stationId.current)) {
                    const more = fromModel().slice(q.rows.length - at);
                    if (more.length) {
                        q.rows = q.rows.concat(more);
                        native.append(handed(more));
                    }
                }
            } else if (!state.key && state.title) {
                // A song the car picked from its own lists: shown as what it is.
                setCurrent({ key: `car:${state.title}`, title: state.title, artist: state.artist });
            }
            // The player has connected and said what it holds: the restore can decide now.
            if (joinPhone.current && 'count' in state) {
                const join = joinPhone.current;
                joinPhone.current = null;
                join(state);
            }
        };
        window.__ringtomePlayerEvent = hear;
        try {
            hear(JSON.parse(native.state()));
        } catch {
            /* nothing said yet */
        }
        return () => {
            if (window.__ringtomePlayerEvent === hear) delete window.__ringtomePlayerEvent;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [native, me]);

    useEffect(() => {
        if (!audio) return undefined;
        const on = {
            play: () => setPlaying(true),
            pause: () => setPlaying(false),
            timeupdate: () => {
                setPosition(audio.currentTime || 0);
                // Where in the song, every few seconds, for a refresh to pick up from.
                const now = Date.now();
                if (me && now - savedAt.current > 4000 && currentRef.current) {
                    savedAt.current = now;
                    keep(
                        AT_KEY(me),
                        JSON.stringify({ key: currentRef.current.key, at: audio.currentTime }),
                    );
                }
            },
            durationchange: () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0),
            playing: () => {
                failures.current = 0;
            },
            ended: () => live.current.next(),
            // A song that won't play - not on this computer, offline - is skipped (section 7), but
            // never round and round a list that won't play at all.
            error: () => {
                failures.current += 1;
                const bound = stationId.current ? 20 : list.current.length;
                if (failures.current <= bound) live.current.next();
                else setPlaying(false);
            },
        };
        // And exactly where, on a pause and as the page goes - a refresh lands on the second.
        const keepAt = () => {
            if (me && currentRef.current && audio.currentTime > 0)
                keep(
                    AT_KEY(me),
                    JSON.stringify({ key: currentRef.current.key, at: audio.currentTime }),
                );
        };
        audio.addEventListener('pause', keepAt);
        window.addEventListener('pagehide', keepAt);
        for (const [kind, fn] of Object.entries(on)) audio.addEventListener(kind, fn);
        return () => {
            for (const [kind, fn] of Object.entries(on)) audio.removeEventListener(kind, fn);
            audio.removeEventListener('pause', keepAt);
            window.removeEventListener('pagehide', keepAt);
        };
    }, [audio, me]);

    // A refresh picks up where the last page left off: the same list, the same song, paused where it
    // was, and the shuffle on or off with its order and its place - so previous walks back over the
    // same songs. Nothing plays until asked (a browser won't let a page start sound on its own).
    useEffect(() => {
        if ((!audio && !native) || !me) return undefined;
        const state = readPlayerState(kept(STATE_KEY(me)));
        if (!state) return undefined;
        setContext(state.context);
        if (state.station) {
            stationId.current = state.station;
            pending.current = {
                id: state.station,
                rows: state.rows,
                pos: state.pos,
                from: state.from,
            };
            setStation(state.station);
            list.current = [];
        } else list.current = state.rows;
        shuffleRef.current = state.shuffle;
        setShuffleState(state.shuffle);
        run.current =
            state.shuffle && state.run
                ? ShuffleRun.restore(state.rows, { ...SHUFFLE, random: Math.random }, state.run)
                : null;
        const row = state.current;
        if (!row) return undefined;
        index.current = state.rows.findIndex((r) => r.key === row.key);
        let at = 0;
        try {
            const where = JSON.parse(kept(AT_KEY(me)) || 'null');
            if (where && where.key === row.key && Number.isFinite(where.at)) at = where.at;
        } catch {
            /* from the start, then */
        }
        if (native) {
            // The phone's player may have played on while the page was away - several songs on,
            // with the screen off. Whatever it holds, the page joins it there and never interrupts
            // it; only a player holding nothing is handed the saved song, paused where it was.
            // Decided once the player has said what it holds (Curtis, 2026-10-19): it connects a
            // moment after the page opens, and until then it says nothing - which read as holding
            // nothing, and the hand-over was lost on the way.
            const join = (phone) => {
                if (phone.count > 0) {
                    currentRef.current = row;
                    const rows = fromModel();
                    const j = phone.key ? rows.findIndex((r) => r.key === phone.key) : -1;
                    if (j >= 0) {
                        setModelPos(modelPos() + j);
                        currentRef.current = rows[j];
                        setCurrent(rows[j]);
                        nq.current = {
                            rows: rows.slice(j),
                            base: modelPos(),
                            offset: phone.index ?? 0,
                        };
                        if (rows.length > j + 1) native.upcoming(handed(rows.slice(j + 1)));
                    } else {
                        setCurrent(
                            phone.title
                                ? {
                                      key: `car:${phone.title}`,
                                      title: phone.title,
                                      artist: phone.artist,
                                  }
                                : row,
                        );
                    }
                    return;
                }
                load(row, { play: false });
                if (at > 0) native.seek(Math.round(at * 1000));
            };
            let phone = null;
            try {
                phone = JSON.parse(native.state());
            } catch {
                /* nothing said yet */
            }
            if (phone && 'count' in phone) join(phone);
            else joinPhone.current = join;
            return () => {
                joinPhone.current = null;
            };
        }
        load(row, { play: false });
        if (at > 0) {
            const seek = () => {
                audio.currentTime = at;
            };
            audio.addEventListener('loadedmetadata', seek, { once: true });
            keep(AT_KEY(me), JSON.stringify({ key: row.key, at }));
            return () => audio.removeEventListener('loadedmetadata', seek);
        }
        return undefined;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [audio, native, me]);

    // The persona changed, or the app closed: the music stops with it. (Not the phone's player: on
    // Android the music outlives the page, which is the point of it.)
    useEffect(
        () => () => {
            if (audio) audio.pause();
        },
        [audio, me],
    );

    // The computer's own controls: media keys, the lock screen, the phone's notification shade.
    useEffect(() => {
        const session = typeof navigator !== 'undefined' && navigator.mediaSession;
        // On Android the phone's player holds the real media session (PlayerService.kt).
        if (!session || native) return;
        if (!current) {
            session.metadata = null;
            return;
        }
        try {
            session.metadata = new window.MediaMetadata({
                title: current.title || '',
                artist: current.artist || '',
                album: current.album || '',
                artwork: current.thumb ? [{ src: soundThumb(current, me) }] : [],
            });
            session.setActionHandler('play', () => live.current.toggle());
            session.setActionHandler('pause', () => live.current.toggle());
            session.setActionHandler('nexttrack', () => live.current.next());
            session.setActionHandler('previoustrack', () => live.current.prev());
            session.setActionHandler('stop', () => live.current.stop());
        } catch {
            /* a browser with half a Media Session: the page's own controls still work */
        }
    }, [current, me, native]);

    return html`<${Player.Provider} value=${api}>${children}</${Player.Provider}>`;
};

const Thumb = ({ row, me, className, onClick = null }) => {
    const glyph =
        row && row.thumb
            ? html`<img class=${className} src=${soundThumb(row, me)} alt="" />`
            : html`<span class=${`${className} player-thumb-none`}><${Icons.music} /></span>`;
    // Pressed, the song's file (Curtis, 2026-10-13: the cover brings up the File column).
    return onClick && row
        ? html`<button class="player-thumb-button" title=${t('player.show-file', 'show its file')} onClick=${onClick}>${glyph}</button>`
        : glyph;
};

/// Thumbs up and down on the song playing (Curtis, 2026-10-13: quick per-song thoughts, in reach):
/// your own, private; a thumbs-up song comes round twice a shuffle, a thumbs-down one every second
/// (pure/shuffle.js `rated`). Pressed again, taken back.
export const Thumbs = ({
    rating,
    onRate,
    className = 'player-rate',
}) => html`<span class=${className}>
    <button
        class=${rating === 'up' ? 'player-button player-on' : 'player-button'}
        title=${t('player.thumbs-up', 'thumbs up - it comes round twice a shuffle')}
        aria-pressed=${rating === 'up'}
        onClick=${() => onRate(rating === 'up' ? '' : 'up')}
    ><${Icons.thumbsUp} /></button>
    <button
        class=${rating === 'down' ? 'player-button player-on' : 'player-button'}
        title=${t('player.thumbs-down', 'thumbs down - it sits out every second shuffle')}
        aria-pressed=${rating === 'down'}
        onClick=${() => onRate(rating === 'down' ? '' : 'down')}
    ><${Icons.thumbsDown} /></button>
</span>`;

/// The bar: in hrseAmp, across its foot. `list` is what play starts when nothing is loaded yet - the
/// table as it stands - and `from` what it is. `source` says where the song playing came from;
/// `rating` and `onRate` are its thumbs; `onStarted(from)` hears play start the list from nothing.
export const PlayerBar = ({
    list = [],
    from = null,
    source = '',
    rating = '',
    onRate = null,
    onStarted = null,
}) => {
    const p = usePlayer();
    if (!p) return null;
    const { current, playing, shuffle, position, duration, volume, me } = p;
    const playOrPause = () => {
        if (current) p.toggle();
        else if (list.length) {
            p.play(list, null, from);
            if (onStarted && from) onStarted(from);
        }
    };
    return html`<div class="player-bar">
        <span class="player-buttons">
            <button class="player-button" title=${t('player.previous', 'previous')} onClick=${p.prev}><${Icons.skipBack} /></button>
            <button class="player-button player-play" title=${playing ? t('player.pause', 'pause') : t('player.play', 'play')} onClick=${playOrPause}>
                ${playing ? html`<${Icons.pause} />` : html`<${Icons.play} />`}
            </button>
            <button class="player-button" title=${t('player.next', 'next')} onClick=${p.next}><${Icons.skipForward} /></button>
            <button class="player-button" title=${t('player.stop', 'stop')} onClick=${p.stop}><${Icons.stop} /></button>
            <button
                class=${shuffle && !p.station ? 'player-button player-on' : 'player-button'}
                title=${p.station ? t('player.station-picks', 'a station picks its own order') : shuffle ? t('player.shuffle-on', 'shuffle: on') : t('player.shuffle-off', 'shuffle: off')}
                disabled=${!!p.station}
                onClick=${() => p.setShuffle(!shuffle)}
            ><${Icons.shuffle} /></button>
        </span>
        <${Thumb} row=${current} me=${me} className="player-thumb" onClick=${p.reveal} />
        <span class="player-now">
            <span class="player-title">${current ? current.title : t('player.nothing-playing', 'nothing playing')}</span>
            <span class="player-artist">${current ? current.artist : ''}${current && source && html`<span class="player-source">${' · '}${source}</span>`}</span>
        </span>
        ${current && onRate && html`<${Thumbs} rating=${rating} onRate=${onRate} />`}
        <span class="player-track">
            <span class="player-time">${clock(position * 1000)}</span>
            <input
                class="player-scrub"
                type="range"
                min="0"
                max=${Math.max(1, Math.floor(duration || (current && current.lengthMs / 1000) || 0))}
                step="1"
                value=${Math.floor(position)}
                disabled=${!current}
                onInput=${(e) => p.seek(Number(e.currentTarget.value))}
            />
            <span class="player-time">${clock((duration || (current && current.lengthMs / 1000) || 0) * 1000)}</span>
        </span>
        <span class="player-volume" title=${t('player.volume', 'volume')}>
            <button
                class=${p.muted ? 'player-button player-on' : 'player-button'}
                title=${p.muted ? t('player.unmute', 'muted - press to hear it again') : t('player.mute', 'mute')}
                aria-pressed=${p.muted}
                onClick=${p.toggleMute}
            ><${p.muted || volume === 0 ? Icons.speakerOff : Icons.speaker} /></button>
            <input class=${p.muted ? 'player-volume-muted' : ''} type="range" min="0" max="1" step="0.05" value=${volume} onInput=${(e) => p.setVolume(Number(e.currentTarget.value))} />
        </span>
        <button
            class=${p.levelling ? 'player-button player-level player-on' : 'player-button player-level'}
            title=${p.levelling ? t('player.levelling-on', 'levelling: on - loud songs are turned down to match the rest') : t('player.levelling-off', 'levelling: off - every song plays as loud as it was made')}
            onClick=${() => p.setLevelling(!p.levelling)}
        ><${Icons.mediaAudio} /></button>
        <button
            class="player-button"
            title=${p.expanded ? t('player.shrink', 'back to the list') : t('player.expand', 'fill the page')}
            onClick=${() => p.setExpanded(!p.expanded)}
        >${p.expanded ? html`<${Icons.cornersIn} />` : html`<${Icons.cornersOut} />`}</button>
    </div>`;
};

/// The cassette bounces to the music (pure/bounce.js): each song read a second time, quietly -
/// decoded at a low rate, its bass kept - into how hard it kicks every 50ms. Read once a song, the
/// last few kept; none past a quarter of an hour, which would be a lot to decode on a phone; none
/// where the browser can't decode it, which only means a still cassette.
const KICK_RATE = 8000;
const KICK_MOST_MS = 15 * 60 * 1000;
const keptKicks = new Map(); // song key -> its kicks, being read or read
function readKicks(row, me) {
    if (keptKicks.has(row.key)) return keptKicks.get(row.key);
    const Offline =
        typeof window !== 'undefined' &&
        (window.OfflineAudioContext || window.webkitOfflineAudioContext);
    if (!Offline || (row.lengthMs || 0) > KICK_MOST_MS) return Promise.resolve(null);
    const reading = (async () => {
        const bytes = await apiBytes(soundSrc(row, me));
        const song = await new Offline(1, 1, KICK_RATE).decodeAudioData(bytes);
        const bass = new Offline(1, song.length, KICK_RATE);
        const source = bass.createBufferSource();
        source.buffer = song;
        const low = bass.createBiquadFilter();
        low.type = 'lowpass';
        low.frequency.value = 150;
        source.connect(low).connect(bass.destination);
        source.start();
        return kicks((await bass.startRendering()).getChannelData(0), KICK_RATE);
    })().catch(() => null);
    keptKicks.set(row.key, reading);
    while (keptKicks.size > 12) keptKicks.delete(keptKicks.keys().next().value);
    return reading;
}

/// The song's kicks, once read - null until then, and for a song that can't be.
function useKicks(row, me) {
    const [kept, setKept] = useState(null);
    const key = row ? row.key : null;
    useEffect(() => {
        setKept(null);
        if (!row || !row.doc) return undefined;
        let here = true;
        readKicks(row, me).then((k) => here && setKept(k));
        return () => {
            here = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, me]);
    return kept;
}

/// The bounce, a frame at a time while it plays: a kick lifts the cassette and squashes it a
/// little, and it settles back between - its shadow left on the floor, smaller and fainter the
/// higher it goes. Still for anyone who asks their computer for less motion.
function useBounce(svg, floor, kickList, playing, p) {
    const player = useRef(p);
    player.current = p;
    useEffect(() => {
        const el = svg.current;
        const ground = floor.current;
        const still =
            typeof window !== 'undefined' &&
            window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (!el || !kickList || !playing || still) return undefined;
        let shown = 0;
        let frame = 0;
        const tick = () => {
            shown = Math.max(kickAt(kickList, player.current.now()), shown * 0.82);
            el.style.transform = `translateY(${(-shown * 3).toFixed(2)}%) scale(${(1 + shown * 0.025).toFixed(4)}, ${(1 - shown * 0.015).toFixed(4)})`;
            if (ground) {
                ground.style.transform = `scale(${(1 - shown * 0.12).toFixed(4)})`;
                ground.style.opacity = (1 - shown * 0.35).toFixed(3);
            }
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => {
            cancelAnimationFrame(frame);
            el.style.transform = '';
            if (ground) {
                ground.style.transform = '';
                ground.style.opacity = '';
            }
        };
    }, [svg, floor, kickList, playing]);
}

/// A label line that still runs past its room once drawn - a hand wider than its average for these
/// letters (all capitals, say) - squeezed to fit, as a pen crowds the last words in. Measured once
/// the fonts are in.
function useFitted(svg) {
    useEffect(() => {
        const el = svg.current;
        if (!el) return undefined;
        const squeeze = () => {
            for (const line of el.querySelectorAll('text[data-room]')) {
                line.removeAttribute('textLength');
                line.removeAttribute('lengthAdjust');
                const room = Number(line.dataset.room);
                if (line.getComputedTextLength() > room) {
                    line.setAttribute('textLength', String(room));
                    line.setAttribute('lengthAdjust', 'spacingAndGlyphs');
                }
            }
        };
        squeeze();
        let here = true;
        if (typeof document !== 'undefined' && document.fonts)
            document.fonts.ready.then(() => here && squeeze());
        return () => {
            here = false;
        };
    });
}

/// Expanded (section 4): the page is a cassette whose reels turn while it plays, over the song's
/// cover, blurred.
/// A compact cassette (Curtis, 2026-10-12): screws in the four corners; a paper label wrapped round
/// the window, the song's title and artist written on it in a hand (Caveat); the two reels high in
/// the window, turning while it plays, with the tape wound on them showing through; and the tapered
/// edge below, with its capstan and guide holes. Each song's has its own colours and extras - a
/// side, a length, a brand, stripes, where the words go (pure/cassette.js).
/// On a phone the bar has no room for the thumbs (Curtis, 2026-10-13), so the cassette's page
/// carries them, under the cassette: `rating` and `onRate` as the bar takes them.
/// The cassette is the play button too (Curtis, 2026-10-18): a press pauses it or plays it on, and
/// so does Enter while it has the focus (Space already does, anywhere in hrseAmp).
export const Cassette = ({ rating = '', onRate = null }) => {
    const p = usePlayer();
    const svg = useRef(null);
    const floor = useRef(null);
    const kickList = useKicks(p && p.current, p && p.me);
    useBounce(svg, floor, kickList, !!(p && p.playing), p);
    useFitted(svg);
    if (!p) return null;
    const { current, playing, me } = p;
    const press = playing ? t('player.pause', 'pause') : t('player.play', 'play');
    const onKey = (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (current) p.toggle();
    };
    const reels = [100, 220];
    const look = cassetteLook(current && current.key);
    const stacked = look.layout === 'stacked';
    const fit = (words, part) => {
        const f = fontFit(look.font, part, stacked);
        return onLabel(words, f.room, f.size, f.least);
    };
    const title = fit(current && current.title, 'title');
    const artist = fit(current && current.artist, 'artist');
    // Where the words go (pure/cassette.js `LAYOUTS`).
    const titleAt = stacked
        ? { x: 40, y: 32, anchor: 'start' }
        : look.layout === 'centred'
          ? { x: 160, y: 40, anchor: 'middle' }
          : { x: 40, y: 40, anchor: 'start' };
    const artistAt = stacked
        ? { x: 40, y: 48, anchor: 'start' }
        : look.layout === 'left'
          ? { x: 40, y: 136, anchor: 'start' }
          : { x: 160, y: 136, anchor: 'middle' };
    // The lines to write on: under the words, or ruled down the top, faint, or none.
    const lines =
        look.lines === 'none'
            ? []
            : stacked
              ? [...(look.lines === 'ruled' ? [[20, true]] : []), [36, false], [50, false]]
              : [
                    ...(look.lines === 'ruled'
                        ? [
                              [26, true],
                              [36, true],
                              [139, true],
                          ]
                        : []),
                    [46, false],
                ];
    // The band under the words, wider when it carries the brand or the stripes.
    const wide = !!(look.brand || look.stripes);
    const band = wide ? { y: 52, height: 12 } : { y: 54, height: 6 };
    // Diagonal stripes at the band's end, each wider than the last.
    const diagonals = [];
    if (look.stripes) {
        let x = 294;
        for (const w of [10, 7, 5, 3, 2]) {
            x -= w;
            diagonals.push(
                `M${x} ${band.y + band.height} L${x + band.height} ${band.y} L${x + band.height + w} ${band.y} L${x + w} ${band.y + band.height} Z`,
            );
            x -= 4;
        }
    }
    // The side's square, and the tape's length opposite it (on the right, with no side) - each in
    // the room beside the window, a little further in where a block of colour runs down that edge.
    const leftX = look.block === 'left' ? 53 : 48;
    const rightX = look.block === 'right' ? 267 : 272;
    const sideX = look.side && look.side.at === 'left' ? leftX : rightX;
    const lengthX = look.side && look.side.at === 'right' ? leftX : rightX;
    const block = {
        left: { x: 26, y: 12, width: 10, height: 130 },
        right: { x: 284, y: 12, width: 10, height: 130 },
        top: { x: 26, y: 12, width: 268, height: stacked ? 5 : 7 },
    }[look.block];
    return html`<div class="player-expanded">
        ${
            /* The cover behind it, blurred most at the middle and least at the edges (Curtis,
            2026-10-13): a lightly blurred copy, under a heavily blurred one masked to a circle. */ ''
        }
        ${
            current &&
            current.thumb &&
            html`<div class="player-backdrop">
                <img class="player-backdrop-light" src=${soundThumb(current, me)} alt="" />
                <img class="player-backdrop-heavy" src=${soundThumb(current, me)} alt="" />
            </div>`
        }
        <div class="cassette-stage">
        <div class="cassette-floor" ref=${floor}></div>
        <svg ref=${svg} class=${`cassette ${look.style} ${look.font.cls}${playing ? ' cassette-playing' : ''}`} viewBox="0 0 320 200" role="button" tabindex="0" aria-label=${press} title=${press} onClick=${() => current && p.toggle()} onKeyDown=${onKey}>
            <defs>
                <clipPath id="cassette-window-clip">
                    <rect x="70" y="72" width="180" height="40" rx="20" />
                </clipPath>
                <clipPath id="cassette-label-clip">
                    <rect x="26" y="12" width="268" height="130" rx="6" />
                </clipPath>
            </defs>
            <rect class="cassette-body" x="4" y="4" width="312" height="192" rx="12" />
            ${[
                [16, 16],
                [304, 16],
                [16, 184],
                [304, 184],
            ].map(
                ([x, y]) => html`<g key=${`${x}-${y}`}>
                    <circle class="cassette-screw" cx=${x} cy=${y} r="5" />
                    <path class="cassette-screw-slot" d=${`M${x - 3} ${y} H${x + 3} M${x} ${y - 3} V${y + 3}`} />
                </g>`,
            )}
            <rect class="cassette-label" x="26" y="12" width="268" height="130" rx="6" />
            <g clip-path="url(#cassette-label-clip)">
                ${block && html`<rect class="cassette-block" ...${block} />`}
                <rect class="cassette-stripe" x="26" y=${band.y} width="268" height=${band.height} />
                <rect class="cassette-stripe" x="26" y="122" width="268" height="4" />
                ${diagonals.map((d) => html`<path key=${d} class="cassette-diagonal" d=${d} />`)}
            </g>
            ${look.brand && html`<text class="cassette-brand" x="160" y=${band.y + 8.5} text-anchor="middle">${look.brand}</text>`}
            ${lines.map(([y, faint]) => html`<path key=${y} class=${faint ? 'cassette-line cassette-line-faint' : 'cassette-line'} d=${`M38 ${y} H282`} />`)}
            ${
                look.side &&
                html`<rect class="cassette-side" x=${sideX - 13} y="79" width="26" height="26" rx="2" />
                    <text class="cassette-side-letter" x=${sideX} y="99" text-anchor="middle">${look.side.letter}</text>`
            }
            ${look.length && html`<text class="cassette-print" x=${lengthX} y="96" text-anchor="middle">${look.length}</text>`}
            <text class="cassette-text" data-room=${LINE_ROOM.title} x=${titleAt.x} y=${titleAt.y} text-anchor=${titleAt.anchor} style=${`font-size: ${title.size}px`}>${title.words}</text>
            <rect class="cassette-window" x="70" y="72" width="180" height="40" rx="20" />
            <g clip-path="url(#cassette-window-clip)">
                <circle class="cassette-tape" cx=${reels[0]} cy="92" r="34" />
                <circle class="cassette-tape" cx=${reels[1]} cy="92" r="24" />
            </g>
            ${reels.map(
                (
                    cx,
                ) => html`<g key=${cx} class="cassette-reel" style=${`transform-origin: ${cx}px 92px`}>
                    <circle class="cassette-hub" cx=${cx} cy="92" r="14" />
                    <circle class="cassette-hole" cx=${cx} cy="92" r="8" />
                    ${[0, 60, 120, 180, 240, 300].map(
                        (deg) =>
                            html`<rect key=${deg} class="cassette-tooth" x=${cx - 1.5} y="84" width="3" height="4" style=${`transform: rotate(${deg}deg); transform-origin: ${cx}px 92px`} />`,
                    )}
                </g>`,
            )}
            <text class="cassette-text cassette-text-small" data-room=${LINE_ROOM.artist} x=${artistAt.x} y=${artistAt.y} text-anchor=${artistAt.anchor} style=${`font-size: ${artist.size}px`}>${artist.words}</text>
            <path class="cassette-foot" d="M58 196 L78 152 L242 152 L262 196 Z" />
            <circle class="cassette-hole" cx="96" cy="180" r="5" />
            <circle class="cassette-hole" cx="224" cy="180" r="5" />
            <rect class="cassette-hole" x="134" y="174" width="10" height="10" rx="2" />
            <rect class="cassette-hole" x="176" y="174" width="10" height="10" rx="2" />
            <rect class="cassette-hole" x="154" y="164" width="12" height="6" rx="2" />
        </svg>
        </div>
        ${current && onRate && html`<${Thumbs} rating=${rating} onRate=${onRate} className="player-rate player-cassette-rate" />`}
    </div>`;
};

/// Anywhere else in the app (ruling 1): a compact player above the dock while there's a song - the
/// song, play and pause, and next - which opens hrseAmp when its words are pressed, and the song's
/// file when its cover is. It goes when the music stops: at once for a stop, a few minutes after a
/// pause, and a song a refresh brought back waits in hrseAmp until it's played. Its X is that stop
/// (Curtis, 2026-10-30, from a tester who couldn't get it off the chat's buttons): the song ends and
/// the player goes. In a narrow window it is a band of its own above the app bar (amp.css), so it
/// never hangs over what an app shows.
export const MiniPlayer = () => {
    const p = usePlayer();
    const loc = useLocation();
    const [, tick] = useState(0);
    const idle = p ? p.idleSince : null;
    const left = idle ? MINI_LINGER - (Date.now() - idle) : 0;
    useEffect(() => {
        if (!idle || left <= 0) return undefined;
        const timer = setTimeout(() => tick((n) => n + 1), left + 50);
        return () => clearTimeout(timer);
    }, [idle, left > 0]); // eslint-disable-line react-hooks/exhaustive-deps
    if (!p || !p.current || loc.path.startsWith(AMP_PATH)) return null;
    if (!p.playing && left <= 0) return null;
    return html`<div class="player-mini">
        <${Thumb}
            row=${p.current}
            me=${p.me}
            className="player-mini-thumb"
            onClick=${() => {
                p.reveal();
                loc.route(AMP_PATH);
            }}
        />
        <button class="player-mini-now" title=${t('player.open-hrseamp', 'open hrseAmp')} onClick=${() => loc.route(AMP_PATH)}>
            <span class="player-title">${p.current.title}</span>
            <span class="player-artist">${p.current.artist}</span>
        </button>
        <button class="player-button" title=${p.playing ? t('player.pause', 'pause') : t('player.play', 'play')} onClick=${p.toggle}>
            ${p.playing ? html`<${Icons.pause} />` : html`<${Icons.play} />`}
        </button>
        <button class="player-button" title=${t('player.next', 'next')} onClick=${p.next}><${Icons.skipForward} /></button>
        <button class="player-button player-mini-close" title=${t('player.stop-and-close', 'stop, and close the player')} onClick=${p.stop}><${Icons.close} /></button>
    </div>`;
};

/// A sound opened in hrseFiles (Curtis, 2026-10-13: songs played in the File Browser should play
/// in hrseAmp): played by the player the whole app shares, so it carries on as you go elsewhere,
/// and shows in the compact player and in hrseAmp's now-playing column - which is a press away.
export const FilePlayer = ({ row }) => {
    const p = usePlayer();
    const loc = useLocation();
    if (!p || !row) return null;
    const mine = !!p.current && p.current.key === row.key;
    const length = (mine && p.duration) || (row.lengthMs || 0) / 1000;
    return html`<div class="player-file">
        <button
            class="player-button player-play"
            title=${mine && p.playing ? t('player.pause', 'pause') : t('player.play', 'play')}
            onClick=${() => (mine ? p.toggle() : p.play([row], row, { kind: 'file', name: row.title }))}
        >${mine && p.playing ? html`<${Icons.pause} />` : html`<${Icons.play} />`}</button>
        <span class="player-track">
            <span class="player-time">${clock(mine ? p.position * 1000 : 0)}</span>
            <input
                class="player-scrub"
                type="range"
                min="0"
                max=${Math.max(1, Math.floor(length))}
                step="1"
                value=${mine ? Math.floor(p.position) : 0}
                disabled=${!mine}
                onInput=${(e) => p.seek(Number(e.currentTarget.value))}
            />
            <span class="player-time">${clock(length * 1000)}</span>
        </span>
        <button class="facet-more player-file-amp" onClick=${() => loc.route(AMP_PATH)}>
            <${Icons.cassette} /> ${t('player.open-in-hrseamp', 'open hrseAmp')}
        </button>
    </div>`;
};
