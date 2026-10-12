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
import { clock } from './pure/amp.js';
import { Icons } from './icons.js';
import { t } from './i18n.js';

const html = htm.bind(h);

const Player = createContext(null);
export const usePlayer = () => useContext(Player);

/// Where hrseAmp lives.
export const AMP_PATH = '/ringtome/amp';

const VOLUME_KEY = 'amp-volume';

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
    // The list and where we are in it, kept out of render state: the audio element's events read
    // them, and a re-render must never lose the shuffle (stable within a session, ruling).
    const list = useRef([]);
    const index = useRef(-1);
    const run = useRef(null);
    const failures = useRef(0);

    const load = (row) => {
        if (!audio) return;
        setCurrent(row);
        if (!row) {
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
            setPlaying(false);
            return;
        }
        audio.src = soundSrc(row, me);
        audio.play().catch(() => {});
    };

    const step = (forward) => {
        if (!list.current.length) return load(null);
        if (shuffle && run.current) {
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

    const api = {
        current,
        playing,
        shuffle,
        position,
        duration,
        volume,
        expanded,
        me,
        /// Play `rows`, from `row` (or the first, or the shuffle's first).
        play(rows, row = null) {
            list.current = rows;
            failures.current = 0;
            if (shuffle) {
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
            list.current = rows;
            if (run.current) run.current.replaceItems(rows);
            if (current) index.current = rows.findIndex((r) => r.key === current.key);
        },
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
    };
    // The audio element's events call through this, so they always see the latest list and mode.
    const live = useRef(api);
    live.current = api;

    useEffect(() => {
        if (!audio) return undefined;
        audio.volume = volume;
    }, [audio, volume]);

    useEffect(() => {
        if (!audio) return undefined;
        const on = {
            play: () => setPlaying(true),
            pause: () => setPlaying(false),
            timeupdate: () => setPosition(audio.currentTime || 0),
            durationchange: () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0),
            playing: () => {
                failures.current = 0;
            },
            ended: () => live.current.next(),
            // A song that won't play - not on this computer, offline - is skipped (section 7), but
            // never round and round a list that won't play at all.
            error: () => {
                failures.current += 1;
                if (failures.current <= list.current.length) live.current.next();
                else setPlaying(false);
            },
        };
        for (const [kind, fn] of Object.entries(on)) audio.addEventListener(kind, fn);
        return () => {
            for (const [kind, fn] of Object.entries(on)) audio.removeEventListener(kind, fn);
        };
    }, [audio]);

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
                class=${shuffle ? 'player-button player-on' : 'player-button'}
                title=${shuffle ? t('player.shuffle-on', 'shuffle: on') : t('player.shuffle-off', 'shuffle: off')}
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
            class="player-button"
            title=${p.expanded ? t('player.shrink', 'back to the list') : t('player.expand', 'fill the page')}
            onClick=${() => p.setExpanded(!p.expanded)}
        >${p.expanded ? html`<${Icons.cornersIn} />` : html`<${Icons.cornersOut} />`}</button>
    </div>`;
};

/// Expanded (section 4): the page is a cassette whose reels turn while it plays, over the song's
/// cover, blurred.
export const Cassette = () => {
    const p = usePlayer();
    if (!p) return null;
    const { current, playing, me } = p;
    return html`<div class="player-expanded">
        ${current && current.thumb && html`<img class="player-backdrop" src=${soundThumb(current, me)} alt="" />`}
        <svg class=${playing ? 'cassette cassette-playing' : 'cassette'} viewBox="0 0 320 200" role="img" aria-label=${t('player.a-cassette', 'a cassette')}>
            <rect class="cassette-body" x="4" y="4" width="312" height="192" rx="14" />
            <rect class="cassette-label" x="28" y="22" width="264" height="58" rx="6" />
            <text class="cassette-text" x="160" y="48" text-anchor="middle">${(current && current.title) || ''}</text>
            <text class="cassette-text cassette-text-small" x="160" y="68" text-anchor="middle">${(current && current.artist) || ''}</text>
            <rect class="cassette-window" x="70" y="96" width="180" height="60" rx="28" />
            ${[110, 210].map(
                (cx) => html`<g class="cassette-reel" style=${`transform-origin: ${cx}px 126px`}>
                    <circle class="cassette-hub" cx=${cx} cy="126" r="22" />
                    ${[0, 60, 120, 180, 240, 300].map(
                        (deg) =>
                            html`<rect class="cassette-tooth" x=${cx - 2} y="106" width="4" height="10" style=${`transform: rotate(${deg}deg); transform-origin: ${cx}px 126px`} />`,
                    )}
                </g>`,
            )}
            <path class="cassette-foot" d="M60 196 L84 166 L236 166 L260 196 Z" />
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
