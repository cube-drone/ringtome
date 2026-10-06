// The CRT screen, on or off (Curtis, 2026-10-06): the persona's own choice, kept on its private
// chain - the `appearance` collection, key `crt`, 'off' or 'on' - so turning it off on one computer
// turns it off on every one the persona signs in on. Read once per page load into one shared store
// (as warnings.js reads the content warnings), and worn as `data-crt` on the page root, which
// crt.css reads.
//
// The last answer is also kept in this browser, and put on by index.html's first script before
// anything draws, so a persona who turned it off doesn't see it flash on at every reload while the
// register is asked. Signed out, it's on: the default.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { t } from './i18n.js';

const html = htm.bind(h);

const COLLECTION = 'appearance';
const KEY = 'crt';
/// This browser's copy (index.html reads the same key).
const KEPT = 'crt';

const store = new Map(); // root -> boolean (on)
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

const wear = (on) => {
    if (typeof document === 'undefined') return;
    if (on) delete document.documentElement.dataset.crt;
    else document.documentElement.dataset.crt = 'off';
    try {
        if (on) localStorage.removeItem(KEPT);
        else localStorage.setItem(KEPT, 'off');
    } catch {
        /* no storage: the register still decides, a beat later */
    }
};

async function load(root) {
    try {
        const r = await api(`/api/identity/${root}/private/kv/${COLLECTION}`);
        const saved = ((r.values || []).find((v) => v.key === KEY) || {}).value;
        store.set(root, saved !== 'off');
    } catch {
        store.set(root, true);
    }
    notify();
}

/// Whether `root` has the CRT screen on: true until the register answers otherwise.
export function useCrt(root) {
    const [, bump] = useState(0);
    useEffect(() => {
        if (!root) return undefined;
        const fn = () => bump((n) => n + 1);
        listeners.add(fn);
        if (!store.has(root)) load(root);
        return () => listeners.delete(fn);
    }, [root]);
    return root && store.has(root) ? store.get(root) : null;
}

/// The shell's half: wear the persona's choice on the page root, and the default signed out.
export function useWornCrt(root) {
    const on = useCrt(root);
    useEffect(() => {
        if (!root) wear(true);
        else if (on !== null) wear(on);
    }, [root, on]);
}

async function save(root, on) {
    await api(`/api/identity/${root}/private/kv/${COLLECTION}/${KEY}`, {
        method: 'PUT',
        body: JSON.stringify({ value: on ? 'on' : 'off' }),
    });
    store.set(root, on);
    notify();
}

/// The profile's switch, under the colourway: "disable CRT", or "enable CRT" once it's off.
export const CrtToggle = ({ root }) => {
    const on = useCrt(root);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    if (on === null) return null;
    const flip = async () => {
        setBusy(true);
        setError(null);
        try {
            await save(root, !on);
        } catch (e) {
            setError(e.message || String(e));
        } finally {
            setBusy(false);
        }
    };
    return html`<div class="profile-field">
        <button class="crt-toggle jag-line" type="button" disabled=${busy} onClick=${flip}>
            ${on ? t('crtpref.disable-crt', 'disable CRT') : t('crtpref.enable-crt', 'enable CRT')}
        </button>
        ${error && html`<p class="form-error">${error}</p>`}
    </div>`;
};
