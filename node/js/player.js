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
import { clock, levelGain, readPlayerState, slimRow } from './pure/amp.js';
import { Icons } from './icons.js';
import { t } from './i18n.js';

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

/// The shuffle's options: what a song is, and who and what album it's by.
const SHUFFLE = {
    keyOf: (r) => r.key,
    artistOf: (r) => r.artist,
    albumOf: (r) => (r.album ? `${r.artist}/${r.album}` : ''),
};

export const PlayerProvider = ({ me, children }) => {
    const audio = useMemo(() => (typeof Audio === 'undefined' ? null : new Audio()), []);
    const [current, setCurrent] = useState(null);
    const [playing, setPlaying] = useState(false);
    const [shuffle, setShuffleState] = useState(false);
    const [position, setPosition] = useState(0);
    const [duration, setDuration] = useState(0);
    const [volume, setVolumeState] = useState(readVolume);
    const [expanded, setExpanded] = useState(false);
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
            keep(
                STATE_KEY(me),
                JSON.stringify({
                    station: stationId.current,
                    rows: kept.map(slimRow),
                    pos: at - (history.length - kept.length),
                    current: currentRef.current ? currentRef.current.key : null,
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
            }),
        );
    };

    const load = (row, { play = true } = {}) => {
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
        /// Play `rows`, from `row` (or the first, or the shuffle's first).
        play(rows, row = null) {
            leaveStation();
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
        relist(rows) {
            // A station picks from its own slices, whatever the table shows.
            if (stationId.current) return;
            list.current = rows;
            if (run.current) run.current.replaceItems(rows);
            if (current) index.current = rows.findIndex((r) => r.key === current.key);
            persist();
        },
        /// Play a radio station: `stationRunObj` (pure/stations.js `StationRun`) picks every song.
        playStation(id, stationRunObj) {
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
        toggle() {
            if (!audio) return;
            if (!current) return step(true);
            if (audio.paused) audio.play().catch(() => {});
            else audio.pause();
        },
        stop() {
            if (!audio) return;
            audio.pause();
            audio.currentTime = 0;
            setPlaying(false);
        },
        next: () => step(true),
        /// Back a song - or, a few seconds in, to this song's start, as every player does.
        prev() {
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
        },
        seek(seconds) {
            if (audio && Number.isFinite(seconds)) audio.currentTime = seconds;
        },
        setVolume(v) {
            setVolumeState(v);
            try {
                localStorage.setItem(VOLUME_KEY, String(v));
            } catch {
                /* the volume lives for the page */
            }
        },
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
        if (!audio) return undefined;
        audio.volume = Math.max(0, Math.min(1, volume * gain));
    }, [audio, volume, gain]);

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
        if (!audio || !me) return undefined;
        const state = readPlayerState(kept(STATE_KEY(me)));
        if (!state) return undefined;
        if (state.station) {
            stationId.current = state.station;
            pending.current = { id: state.station, rows: state.rows, pos: state.pos };
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
    }, [audio, me]);

    // The persona changed, or the app closed: the music stops with it.
    useEffect(
        () => () => {
            if (audio) audio.pause();
        },
        [audio, me],
    );

    // The computer's own controls: media keys, the lock screen, the phone's notification shade.
    useEffect(() => {
        const session = typeof navigator !== 'undefined' && navigator.mediaSession;
        if (!session) return;
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
    }, [current, me]);

    return html`<${Player.Provider} value=${api}>${children}</${Player.Provider}>`;
};

const Thumb = ({ row, me, className }) =>
    row && row.thumb
        ? html`<img class=${className} src=${soundThumb(row, me)} alt="" />`
        : html`<span class=${`${className} player-thumb-none`}><${Icons.music} /></span>`;

/// The bar: in hrseAmp, across its foot. `list` is what play starts when nothing is loaded yet - the
/// table as it stands.
export const PlayerBar = ({ list = [] }) => {
    const p = usePlayer();
    if (!p) return null;
    const { current, playing, shuffle, position, duration, volume, me } = p;
    const playOrPause = () => (current ? p.toggle() : list.length && p.play(list));
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
        <${Thumb} row=${current} me=${me} className="player-thumb" />
        <span class="player-now">
            <span class="player-title">${current ? current.title : t('player.nothing-playing', 'nothing playing')}</span>
            <span class="player-artist">${current ? current.artist : ''}</span>
        </span>
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
            <${volume === 0 ? Icons.speakerOff : Icons.speaker} />
            <input type="range" min="0" max="1" step="0.05" value=${volume} onInput=${(e) => p.setVolume(Number(e.currentTarget.value))} />
        </span>
        <button
            class=${p.levelling ? 'player-button player-on' : 'player-button'}
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

/// Expanded (section 4): the page is a cassette whose reels turn while it plays, over the song's
/// cover, blurred.
/// Words cut to fit a cassette's label, as a pen would run out of room.
const onLabel = (words, room) =>
    !words ? '' : words.length > room ? `${words.slice(0, room - 1).trimEnd()}…` : words;

/// A compact cassette (Curtis, 2026-10-12): screws in the four corners; a paper label wrapped round
/// the window, the song's title written on its top line and the artist on its bottom one, in a hand
/// (Caveat); the two reels high in the window, turning while it plays, with the tape wound on them
/// showing through; and the tapered edge below, with its capstan and guide holes.
export const Cassette = () => {
    const p = usePlayer();
    if (!p) return null;
    const { current, playing, me } = p;
    const reels = [100, 220];
    return html`<div class="player-expanded">
        ${current && current.thumb && html`<img class="player-backdrop" src=${soundThumb(current, me)} alt="" />`}
        <svg class=${playing ? 'cassette cassette-playing' : 'cassette'} viewBox="0 0 320 200" role="img" aria-label=${t('player.a-cassette', 'a cassette')}>
            <defs>
                <clipPath id="cassette-window-clip">
                    <rect x="70" y="72" width="180" height="40" rx="20" />
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
            <rect class="cassette-stripe" x="26" y="54" width="268" height="6" />
            <rect class="cassette-stripe" x="26" y="122" width="268" height="4" />
            <text class="cassette-text" x="40" y="40">${onLabel(current && current.title, 30)}</text>
            <path class="cassette-line" d="M38 46 H282" />
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
            <text class="cassette-text cassette-text-small" x="160" y="136" text-anchor="middle">${onLabel(current && current.artist, 40)}</text>
            <path class="cassette-foot" d="M58 196 L78 152 L242 152 L262 196 Z" />
            <circle class="cassette-hole" cx="96" cy="180" r="5" />
            <circle class="cassette-hole" cx="224" cy="180" r="5" />
            <rect class="cassette-hole" x="134" y="174" width="10" height="10" rx="2" />
            <rect class="cassette-hole" x="176" y="174" width="10" height="10" rx="2" />
            <rect class="cassette-hole" x="154" y="164" width="12" height="6" rx="2" />
        </svg>
    </div>`;
};

/// Anywhere else in the app (ruling 1): a compact player above the dock while there's a song - the
/// song, play and pause, and next - which opens hrseAmp when its words are pressed.
export const MiniPlayer = () => {
    const p = usePlayer();
    const loc = useLocation();
    if (!p || !p.current || loc.path.startsWith(AMP_PATH)) return null;
    return html`<div class="player-mini">
        <${Thumb} row=${p.current} me=${p.me} className="player-mini-thumb" />
        <button class="player-mini-now" title=${t('player.open-hrseamp', 'open hrseAmp')} onClick=${() => loc.route(AMP_PATH)}>
            <span class="player-title">${p.current.title}</span>
            <span class="player-artist">${p.current.artist}</span>
        </button>
        <button class="player-button" title=${p.playing ? t('player.pause', 'pause') : t('player.play', 'play')} onClick=${p.toggle}>
            ${p.playing ? html`<${Icons.pause} />` : html`<${Icons.play} />`}
        </button>
        <button class="player-button" title=${t('player.next', 'next')} onClick=${p.next}><${Icons.skipForward} /></button>
    </div>`;
};
