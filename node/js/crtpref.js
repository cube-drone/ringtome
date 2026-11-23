// The CRT screen, on or off (Curtis, 2026-10-06): the persona's own choice, kept on its private
// chain - the `appearance` collection, key `crt`, 'off' or 'on' - so turning it off on one computer
// turns it off on every one the persona signs in on. Read once per page load into one shared store
// (as warnings.js reads the content warnings), and worn as `data-crt` on the page root, which
// crt.css reads.
//
// The last answer is also kept in this browser, and put on by index.html's first script before
// anything draws, so a persona who turned it off doesn't see it flash on at every reload while the
// register is asked. Signed out, it's on: the default.
//
// Snowflakes are the second effect (Curtis, 2026-11-22: "gentle snowfall from the top of the screen
// to the bottom. Not TOO intrusive. Disabled by default"): the same collection, key `snow`, worn as
// `data-snow="on"`, which snow.css reads. It stacks with the CRT - the glass is drawn over the snow.
//
// The server's own (the same day: "can the site operator set the outward facing CRT and snowflake
// settings?"): signed out, each effect is as the administrator set it in Server Customization,
// said in every page's head (`node-crt`, `node-snow`, frontdoor.rs) - and as the app has it where
// they chose nothing. So a signed-in persona's answers are kept in this browser both ways, on as
// well as off: nothing kept means nobody is in, and the server's say stands.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { t } from './i18n.js';
import { Icons } from './icons.js';

const html = htm.bind(h);

const COLLECTION = 'appearance';
/// What the server's administrator chose for an effect, from the page's head: on, off, or null
/// for the app's own.
const houseSays = (key) => {
    if (typeof document === 'undefined') return null;
    const meta = document.querySelector(`meta[name="node-${key}"]`);
    return meta && (meta.content === 'on' || meta.content === 'off') ? meta.content === 'on' : null;
};

/// The effects: each a key in the collection (and in this browser's storage, which index.html
/// reads), what it is until anyone says otherwise, and how the page root wears it.
const EFFECTS = {
    crt: {
        standing: true,
        dress: (on) => {
            if (on) delete document.documentElement.dataset.crt;
            else document.documentElement.dataset.crt = 'off';
        },
    },
    snow: {
        standing: false,
        dress: (on) => {
            if (on) document.documentElement.dataset.snow = 'on';
            else delete document.documentElement.dataset.snow;
        },
    },
};

/// Put an effect on or off. `mine` is a signed-in persona's own answer, kept in this browser;
/// without it nobody is in, nothing is kept, and the server's say (or the app's) is what's worn.
const wear = (key, on, mine) => {
    if (typeof document === 'undefined') return;
    EFFECTS[key].dress(on);
    try {
        if (mine) localStorage.setItem(key, on ? 'on' : 'off');
        else localStorage.removeItem(key);
    } catch {
        /* no storage: the register still decides, a beat later */
    }
};

/// An effect as it stands with nobody signed in: the server's, else the app's.
const outside = (key) => {
    const house = houseSays(key);
    return house === null ? EFFECTS[key].standing : house;
};

const store = new Map(); // root -> { crt, snow } (each on or off)
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

async function load(root) {
    const said = {};
    try {
        const r = await api(`/api/identity/${root}/private/kv/${COLLECTION}`);
        for (const v of r.values || []) said[v.key] = v.value;
    } catch {
        /* unread: each effect as it stands */
    }
    const state = {};
    for (const [key, effect] of Object.entries(EFFECTS)) {
        state[key] = said[key] === 'on' ? true : said[key] === 'off' ? false : effect.standing;
    }
    store.set(root, state);
    notify();
}

/// Whether `root` has an effect on: null until the register answers.
function useEffectOn(root, key) {
    const [, bump] = useState(0);
    useEffect(() => {
        if (!root) return undefined;
        const fn = () => bump((n) => n + 1);
        listeners.add(fn);
        if (!store.has(root)) load(root);
        return () => listeners.delete(fn);
    }, [root]);
    return root && store.has(root) ? store.get(root)[key] : null;
}

/// The shell's half: wear the persona's choices on the page root, and with nobody in, each effect
/// as the server has it - or as the app does: the CRT on, no snow.
export function useWornEffects(root) {
    const crt = useEffectOn(root, 'crt');
    const snow = useEffectOn(root, 'snow');
    useEffect(() => {
        if (!root) wear('crt', outside('crt'), false);
        else if (crt !== null) wear('crt', crt, true);
    }, [root, crt]);
    useEffect(() => {
        if (!root) wear('snow', outside('snow'), false);
        else if (snow !== null) wear('snow', snow, true);
    }, [root, snow]);
}

async function save(root, key, on) {
    await api(`/api/identity/${root}/private/kv/${COLLECTION}/${key}`, {
        method: 'PUT',
        body: JSON.stringify({ value: on ? 'on' : 'off' }),
    });
    store.set(root, { ...store.get(root), [key]: on });
    notify();
}

/// One effect's switch: its icon, and what pressing it would do.
const EffectToggle = ({ root, effect, icon, words }) => {
    const on = useEffectOn(root, effect);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    if (on === null) return null;
    const flip = async () => {
        setBusy(true);
        setError(null);
        try {
            await save(root, effect, !on);
        } catch (e) {
            setError(e.message || String(e));
        } finally {
            setBusy(false);
        }
    };
    return html`<button class="crt-toggle jag-line" type="button" disabled=${busy} onClick=${flip}>
            <${icon} /> ${words(on)}
        </button>
        ${error && html`<p class="form-error">${error}</p>`}`;
};

/// The profile's switches, under the colourway: "disable CRT" (or "enable CRT" once it's off), and
/// "enable snowflakes" (or "disable snowflakes" once they fall).
export const EffectToggles = ({ root }) => html`<div class="profile-field effect-toggles">
    <${EffectToggle}
        root=${root}
        effect="crt"
        icon=${Icons.crt}
        words=${(on) => (on ? t('crtpref.disable-crt', 'disable CRT') : t('crtpref.enable-crt', 'enable CRT'))}
    />
    <${EffectToggle}
        root=${root}
        effect="snow"
        icon=${Icons.snow}
        words=${(on) =>
            on
                ? t('crtpref.disable-snow', 'disable snowflakes')
                : t('crtpref.enable-snow', 'enable snowflakes')}
    />
</div>`;
