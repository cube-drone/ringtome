// Sound effects (Curtis, 2026-11-15): the app's first, so this is the whole system.
//
// Where they live: `node/sounds/`, baked into the binary and served at `/sounds/<name>.ogg` (and
// `.mp3`, for a web view that cannot decode Ogg) - ui.rs, as the fonts are. A sound is named here
// without its ending.
//
// When they load: nothing is fetched until a page that makes sound says `preloadSounds`, and then
// only the files it names, a few kilobytes each. They are decoded once, at the first play.
//
// Whether they play: a browser lets a page make sound only once its reader has clicked, tapped or
// typed somewhere on it. So a sound asked for before that is dropped, not held - dice heard a
// minute after they rolled are worse than silent dice - and the same goes for one that could not
// be made ready within a moment. Nothing here throws or rejects: a sound that cannot play is
// silence, and the page goes on.
//
// On or off is this device's own choice (a phone on a bus and a desk at home differ), kept in this
// browser.
import { useEffect, useState } from 'preact/hooks';

import { apiBytes } from './net.js';

/// This browser's choice: absent is on, 'off' is off.
const KEPT = 'sound';
/// A sound later than this (ms) after it was asked for is not played.
const LATE = 250;

const listeners = new Set();
let on = (() => {
    try {
        return localStorage.getItem(KEPT) !== 'off';
    } catch {
        return true;
    }
})();

export const soundOn = () => on;

export const setSoundOn = (next) => {
    on = !!next;
    try {
        if (on) localStorage.removeItem(KEPT);
        else localStorage.setItem(KEPT, 'off');
    } catch {
        /* no storage: the choice lives for the page */
    }
    listeners.forEach((fn) => fn());
};

/// Whether sound is on, redrawn when it changes.
export function useSoundOn() {
    const [, bump] = useState(0);
    useEffect(() => {
        const fn = () => bump((n) => n + 1);
        listeners.add(fn);
        return () => listeners.delete(fn);
    }, []);
    return on;
}

// ---- the one audio context, made late ----

let audio = null;
let gestured = false;

/// Whether the reader has touched the page, which is what a browser waits for.
const allowed = () =>
    gestured || (typeof navigator !== 'undefined' && !!navigator.userActivation?.hasBeenActive);

/// The context, made at the first sound that is allowed to play: one made before the reader has
/// touched the page starts suspended, and Chrome says so in the console.
const context = () => {
    if (audio) return audio;
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return null;
    try {
        audio = new Context();
    } catch {
        audio = null;
    }
    return audio;
};

const wake = () => {
    gestured = true;
    // iOS wakes a context only from inside a touch, and suspends it again when the app is put
    // away, so every touch tries.
    if (audio && audio.state !== 'running') audio.resume().catch(() => {});
};

if (typeof window !== 'undefined') {
    for (const kind of ['pointerdown', 'keydown', 'touchend'])
        window.addEventListener(kind, wake, { capture: true, passive: true });
}

// ---- loading ----

/// The ending to ask for first: Ogg where the web view says it plays it, MP3 where it doesn't.
let ending = null;
const endings = () => {
    if (!ending) {
        let ogg = '';
        try {
            ogg = document.createElement('audio').canPlayType('audio/ogg; codecs="vorbis"');
        } catch {
            /* no audio element: ask for the Ogg and see */
        }
        ending = ogg ? ['ogg', 'mp3'] : ['mp3', 'ogg'];
    }
    return ending;
};

const fetched = new Map(); // file -> Promise<ArrayBuffer | null>
const bytes = (file) => {
    if (!fetched.has(file))
        fetched.set(
            file,
            apiBytes(`/sounds/${file}`).catch(() => null),
        );
    return fetched.get(file);
};

/// Decoded, or null. The callback form is the one every web view has; a newer one also returns a
/// promise, whose rejection is the same failure said twice.
const decode = (data) =>
    new Promise((resolve) => {
        try {
            // A copy: decoding takes the bytes it is given.
            const said = audio.decodeAudioData(data.slice(0), resolve, () => resolve(null));
            said?.catch?.(() => resolve(null));
        } catch {
            resolve(null);
        }
    });

const decoded = new Map(); // name -> Promise<AudioBuffer | null>
const buffer = (name) => {
    if (!decoded.has(name))
        decoded.set(
            name,
            (async () => {
                for (const end of endings()) {
                    const data = await bytes(`${name}.${end}`);
                    const sound = data && (await decode(data));
                    if (sound) return sound;
                }
                return null;
            })(),
        );
    return decoded.get(name);
};

/// Fetch these sounds now, so the first play does not wait on the network.
export function preloadSounds(names) {
    if (typeof window === 'undefined' || !on) return;
    for (const name of names) bytes(`${name}.${endings()[0]}`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/// Play one of `names`, picked at random - or nothing, if sound is off, the reader has not yet
/// touched the page, or the sound is not ready in time.
export async function playSound(names) {
    if (typeof window === 'undefined' || !on || names.length === 0 || !allowed()) return;
    if (!context()) return;
    const asked = performance.now();
    const name = names[Math.floor(Math.random() * names.length)];
    // A context just made, or put to sleep, takes a beat to run: wait for it, but not for long.
    const running =
        audio.state === 'running'
            ? null
            : Promise.race([audio.resume().catch(() => {}), wait(LATE)]);
    const [sound] = await Promise.all([buffer(name), running]);
    if (!sound || audio.state !== 'running' || performance.now() - asked > LATE) return;
    try {
        const source = audio.createBufferSource();
        source.buffer = sound;
        source.connect(audio.destination);
        source.start();
    } catch {
        /* silence */
    }
}
