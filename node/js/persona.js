// Personas: the "who are you here?" layer, one hop above the account. The account never gets
// a noun (you sign in, that's all); the persona is the single taught concept (GLOSSARY,
// Cozyweb language mapping - "identity" is an engine-room word, banned from the UI).
//
// The flow this file owns: an account with personas auto-opens the first one (adding more is
// an inside-the-house action, later); an account with none gets the null state ("Nobody lives
// here yet") and the create flow - which includes the spare-key moment, because creation
// returns the recovery secret exactly once and we are not allowed to lose it politely.
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { startLiveCache, forgetMirror, openMirror, useLive } from './mirror.js';
import { Icons } from './icons.js';

const html = htm.bind(h);

// A deterministic little color chip from the root pubkey - the identicon's humble seed
// (the real root-derived identicon is its own future feature; a persona should never render
// as bare hex in the meantime).
function personaHue(rootHex) {
    const n = parseInt(rootHex.slice(0, 6), 16);
    return n % 360;
}

export const shortcode = (rootHex) => rootHex.slice(0, 4);

// The persona layer, as a hook. `current` is null while checking, while the account has no
// personas, and during the ceremony; the caller branches on `state`.
export function usePersona(account) {
    // checking | none | ceremony | naming | join | open
    const [state, setState] = useState('checking');
    const [current, setCurrent] = useState(null); // { root, name }
    const [ceremony, setCeremony] = useState(null); // { root, secret }
    const [naming, setNaming] = useState(null); // root awaiting its display name
    const [join, setJoin] = useState(null); // { requestCode } - the outbound half of adoption
    const [error, setError] = useState(null);
    const live = useRef(null); // the open persona's live-cache handle

    // Opening a persona = remembering its root, fetching its public name for display, and
    // starting the live cache - from here on, the mirror stays current and every view that
    // reads it is reactive.
    const open = async (root) => {
        let name = '';
        try {
            const profile = await api(`/api/identity/${root}/profile`);
            name = (profile.find((f) => f.field === 'name') || {}).value || '';
        } catch {
            // A persona with no readable profile still opens; it just renders by shortcode.
        }
        if (live.current) live.current.stop();
        live.current = startLiveCache(root);
        setCurrent({ root, name });
        setState('open');
    };

    // The way out: stop the stream and drop the mirror ("forget this browser" - PROJECT_PLAN,
    // The Browser Is a View). Called before logout; a signed-out browser keeps nothing.
    const shutdown = async () => {
        if (live.current) {
            live.current.stop();
            live.current = null;
        }
        if (current) {
            await forgetMirror(current.root);
        }
    };

    // A closed tab also stops streaming (the mirror persists for next time; only logout
    // forgets it).
    useEffect(() => () => live.current && live.current.stop(), []);

    useEffect(() => {
        if (!account) return;
        api('/api/identity')
            .then((personas) => {
                if (personas.length > 0) {
                    // Auto-open the first: sign-in should land you somewhere, not at a menu.
                    return open(personas[0].root_pubkey);
                }
                setState('none');
            })
            .catch((e) => {
                setError(e.message);
                setState('none');
            });
    }, [account]);

    const create = async () => {
        setError(null);
        const made = await api('/api/identity', { method: 'POST' });
        // The secret exists in this browser tab and nowhere else we can ever show again.
        setCeremony({ root: made.root_pubkey, secret: made.recovery_secret });
        setState('ceremony');
    };

    // The spare key is put away; next stop is the display name (a brand-new persona is
    // otherwise "persona 7db0", which is nobody).
    const ceremonyDone = () => {
        const root = ceremony.root;
        setCeremony(null);
        setNaming(root);
        setState('naming');
    };

    // Write the public display name (the profile's `name` field - a mutable self-claim,
    // PROJECT_PLAN: Display Names), then open. Skipping just opens; the shortcode fallback
    // stands until a name is chosen from the profile screens, someday.
    const setDisplayName = async (name) => {
        const root = naming;
        const trimmed = name.trim();
        if (trimmed) {
            await api(`/api/identity/${root}/profile`, {
                method: 'POST',
                body: JSON.stringify({ field: 'name', value: trimmed }),
            });
        }
        setNaming(null);
        await open(root);
    };

    // The join flow - adoption's new-device half. This computer mints its own leaf key and
    // gets a request code; the human carries it to a computer that's already the persona,
    // brings back the grant code, and completion pulls the whole persona here. Private keys
    // never travel - only these signed codes do.
    const startJoin = async () => {
        setError(null);
        const res = await api('/api/identity/adopt/begin', { method: 'POST' });
        setJoin({ requestCode: res.code });
        setState('join');
    };

    const cancelJoin = () => {
        setJoin(null);
        setState('none');
    };

    // While waiting in the join state, watch for the persona to arrive on its own: the granter
    // delivers the grant over the wire when it can (one-trip adoption), and this node completes
    // without anyone pasting anything. Polling the persona list is the humble, sufficient
    // signal - the live cache will replace it with a push someday.
    useEffect(() => {
        if (state !== 'join') return;
        const timer = setInterval(async () => {
            try {
                const personas = await api('/api/identity');
                if (personas.length > 0) {
                    clearInterval(timer);
                    setJoin(null);
                    await open(personas[0].root_pubkey);
                }
            } catch {
                // Transient fetch trouble just means we check again next tick.
            }
        }, 2000);
        return () => clearInterval(timer);
    }, [state]);

    const completeJoin = async (grantCode) => {
        const identity = await api('/api/identity/adopt/complete', {
            method: 'POST',
            body: JSON.stringify({ code: grantCode.trim() }),
        });
        setJoin(null);
        await open(identity.root_pubkey);
    };

    return {
        state,
        current,
        ceremony,
        join,
        error,
        create,
        ceremonyDone,
        setDisplayName,
        startJoin,
        cancelJoin,
        completeJoin,
        shutdown,
    };
}

// The null state: a signed-in account with nobody in it yet. Two doors: make someone new,
// or bring an existing you from another computer.
export const NullState = ({ persona }) => {
    const [busy, setBusy] = useState(false);
    const run = (fn) => async () => {
        setBusy(true);
        try {
            await fn();
        } finally {
            setBusy(false);
        }
    };
    return html`
        <div class="null-state">
            <p class="null-title">Nobody lives here yet.</p>
            <p class="null-sub">
                A persona is who you are around here - your name, your pages, your stuff.
                You can have more than one, later.
            </p>
            ${persona.error && html`<p class="form-error">${persona.error}</p>`}
            <button class="welcome-go" disabled=${busy} onClick=${run(persona.create)}>
                ${busy ? '…' : 'create a persona'}
            </button>
            <p class="null-sub">
                Every computer you bring the persona to
                fully syncs your persona's stuff everywhere. This computer will be you, too.
                That's what happens when you...
            </p>
            <button class="skip-link" disabled=${busy} onClick=${run(persona.startJoin)}>
                bring your persona from another computer.
            </button>
        </div>
    `;
};

// The join flow, new-computer side: show the request code to carry away, take the grant code
// back. Both computers must be awake for the handshake - completion dials the inviting
// computer directly to pull the persona across.
export const JoinFlow = ({ persona }) => {
    const [grantCode, setGrantCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const finish = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await persona.completeJoin(grantCode);
        } catch (err) {
            setError(err.message);
            setBusy(false);
        }
    };

    return html`
        <div class="ceremony">
            <p class="null-title">Bring your persona here.</p>
            <p class="null-sub">
                On a computer that is already you: open <strong>your computers</strong>,
                choose <strong>invite another computer</strong>, and give it this code:
            </p>
            <code class="spare-key">${persona.join.requestCode}</code>
            <p class="null-sub">
                <span class="waiting-dot"></span> Waiting - when the other computer accepts,
                your persona walks in here on its own. If it can't reach this computer, it
                will hand you an invite code instead; paste that below. Keep both computers
                awake either way.
            </p>
            <form class="welcome-form" onSubmit=${finish}>
                <textarea
                    class="spare-paste"
                    rows="4"
                    placeholder="invite code (only needed if it doesn't arrive on its own)"
                    value=${grantCode}
                    onInput=${(e) => setGrantCode(e.currentTarget.value)}
                    required
                ></textarea>
                ${error && html`<p class="form-error">${error}</p>`}
                <button class="welcome-go" type="submit" disabled=${busy}>
                    ${busy ? 'bringing your things across…' : 'become me here'}
                </button>
                <button type="button" class="skip-link" onClick=${persona.cancelJoin}>
                    never mind
                </button>
            </form>
        </div>
    `;
};

// The spare-key moment. Minimal honest version of the eventual photo ceremony: show the
// secret, offer it as a download, and refuse to continue until the human says it's safe.
// The server does not keep this; there is no "show it again."
export const SpareKeyCeremony = ({ persona }) => {
    const { secret, root } = persona.ceremony;
    const [saved, setSaved] = useState(false);

    const download = () => {
        const contents = [
            'RINGTOME SPARE KEY - keep this somewhere safe and private.',
            'If you ever lose every computer that is you, this brings you back.',
            '',
            `persona: ${root}`,
            `spare key: ${secret}`,
        ].join('\n');
        const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `ringtome-spare-key-${shortcode(root)}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    };

    return html`
        <div class="ceremony">
            <p class="null-title">This is your spare key.</p>
            <p class="null-sub">
                If you ever lose every computer that knows you, this - and only this - brings
                you back. We don't keep a copy. <strong>We can never show it again.</strong>
            </p>
            <code class="spare-key">${secret}</code>
            <button class="ceremony-download" onClick=${download}>download it</button>
            <label class="ceremony-confirm">
                <input
                    type="checkbox"
                    checked=${saved}
                    onInput=${(e) => setSaved(e.currentTarget.checked)}
                />
                I put my spare key somewhere safe
            </label>
            <button class="welcome-go" disabled=${!saved} onClick=${persona.ceremonyDone}>
                okay, I'm ready
            </button>
        </div>
    `;
};

// Picking the display name: the last step of being born. Pre-filled with the account
// username - the one name this human has already chosen today - but it's a self-claim, not a
// binding: change it whenever, or skip and stay a shortcode for now.
export const NamePicker = ({ persona, account }) => {
    const [name, setName] = useState(account.username);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            await persona.setDisplayName(name);
        } catch (err) {
            setError(err.message);
            setBusy(false);
        }
    };

    return html`
        <div class="ceremony">
            <p class="null-title">What should people call you?</p>
            <p class="null-sub">
                This is the name people see next to your stuff. It's yours to change
                whenever - it doesn't have to match your sign-in.
            </p>
            <form class="welcome-form" onSubmit=${submit}>
                <input
                    type="text"
                    class="name-input"
                    value=${name}
                    onInput=${(e) => setName(e.currentTarget.value)}
                    autocapitalize="off"
                />
                ${error && html`<p class="form-error">${error}</p>`}
                <button class="welcome-go" type="submit" disabled=${busy}>
                    ${busy ? '…' : 'that’s me'}
                </button>
                <button
                    type="button"
                    class="skip-link"
                    disabled=${busy}
                    onClick=${() => persona.setDisplayName('')}
                >maybe later</button>
            </form>
        </div>
    `;
};

// The persona's live display name, or '' if it has none yet. Reads the mirror first so a rename
// on any computer lands within seconds; the fetched-at-open name is the fallback while the mirror
// fills. Safe on a null persona (pre-open) - returns ''. Callers add their own shortcode fallback.
export function usePersonaName(current) {
    const liveName = useLive(
        () => (current ? openMirror(current.root).profile.get('name') : Promise.resolve(null)),
        [current && current.root]
    );
    return (liveName && liveName.value) || (current && current.name) || '';
}

// The persona home: the root of identity management (reached by the dock's persona tile). A small
// menu - profile, your computers, log out - each its own place under /home/persona.
export const PersonaHome = ({ persona, session }) => {
    const current = persona.current;
    // Live name (mirror-first), so a rename lands here as fast as it does in the header and badge -
    // not the fetched-at-open snapshot, which only refreshed on reload.
    const name = usePersonaName(current);
    const logout = async () => {
        // Heading out forgets this browser: stream stopped, mirror dropped. Confirm first - it's
        // easy to hit by mistake, and coming back means signing in again.
        if (!confirm('Log out of this browser? You will sign in again to come back.')) return;
        await persona.shutdown();
        session.logout();
    };
    return html`
        <div class="persona-page">
            <h1 class="persona-page-title">
                <span
                    class="persona-chip"
                    style="background: hsl(${personaHue(current.root)}, 60%, 55%)"
                ></span>
                ${name || `persona ${shortcode(current.root)}`}
            </h1>
            <nav class="persona-menu">
                <a class="persona-menu-item" href="/home/persona/profile">
                    <span class="persona-menu-icon"><${Icons.profile} /></span>
                    <span class="persona-menu-label">
                        <strong>profile</strong>
                        <small>your name and how you appear</small>
                    </span>
                </a>
                <a class="persona-menu-item" href="/home/persona/computers">
                    <span class="persona-menu-icon"><${Icons.computers} /></span>
                    <span class="persona-menu-label">
                        <strong>your computers</strong>
                        <small>the machines that carry this persona</small>
                    </span>
                </a>
                <button class="persona-menu-item persona-menu-danger" onClick=${logout}>
                    <span class="persona-menu-icon"><${Icons.logout} /></span>
                    <span class="persona-menu-label">
                        <strong>log out</strong>
                        <small>forget this browser and head out</small>
                    </span>
                </button>
            </nav>
        </div>
    `;
};

// One editable profile field as a shadow buffer: local while you type (so the live stream
// never repaints mid-edit), saved on a debounce and on blur, adopting the mirror when clean.
function useProfileField(root, field, { debounceMs = 800 } = {}) {
    const live = useLive(() => openMirror(root).profile.get(field), [root, field]);
    const mirror = (live && live.value) || '';
    const [value, setValue] = useState(mirror);
    const valueRef = useRef(value);
    valueRef.current = value;
    const dirty = useRef(false);
    const timer = useRef(null);

    useEffect(() => {
        if (!dirty.current) setValue(mirror);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mirror]);

    const flush = async () => {
        if (!dirty.current) return;
        const v = valueRef.current;
        dirty.current = false;
        try {
            await api(`/api/identity/${root}/profile`, {
                method: 'POST',
                body: JSON.stringify({ field, value: v }),
            });
        } catch {
            dirty.current = true; // a failed save stays dirty; blur/next edit retries
        }
    };

    const onInput = (e) => {
        const v = e.currentTarget.value;
        setValue(v);
        valueRef.current = v;
        dirty.current = true;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(flush, debounceMs);
    };

    useEffect(
        () => () => {
            if (timer.current) clearTimeout(timer.current);
            if (dirty.current) flush();
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [root, field]
    );

    return { value, onInput, flush };
}

// The profile editor: your public self-claims (name, bio). Writes land on the profile chain
// and echo to every computer within seconds. (History-over-time is a future addition.)
export const Profile = ({ current }) => {
    const root = current.root;
    const name = useProfileField(root, 'name');
    const bio = useProfileField(root, 'bio');
    return html`
        <div class="persona-page">
            <div class="persona-page-head">
                <h1 class="persona-page-title">profile</h1>
            </div>
            <label class="profile-field">
                <span class="profile-field-label">name</span>
                <input
                    class="name-input"
                    value=${name.value}
                    onInput=${name.onInput}
                    onBlur=${name.flush}
                    placeholder="what people call you here"
                />
            </label>
            <label class="profile-field">
                <span class="profile-field-label">bio</span>
                <textarea
                    class="profile-bio"
                    value=${bio.value}
                    onInput=${bio.onInput}
                    onBlur=${bio.flush}
                    rows="3"
                    placeholder="a line or two about you (optional)"
                ></textarea>
            </label>
            <p class="null-sub">
                changes save on their own and appear on all your computers within seconds.
            </p>
        </div>
    `;
};
