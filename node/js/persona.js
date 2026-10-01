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

import { useLocation } from 'preact-iso';
import { api, saveFile } from './net.js';
import { takeImportIntent } from './auth.js';
import { ImagePickModal } from './doc/imagepick.js';
import { DrawingThumb, flattenToBlob } from './doc/drawing.js';
import { readBody } from './pure/drawing.js';
import { speakable } from './speakable.js';
import { startLiveCache, forgetMirror, openMirror, useLive } from './mirror.js';
import { isDeparted } from './pure/removal.js';
import { PROFILE_LIMITS, profileChars, overProfileLimit } from './pure/profile.js';
import { personaHue, shortcode } from './pure/person.js';
import { bannerStyle } from './person.js';
import { Icons } from './icons.js';
import { t, tNodes } from './i18n.js';
import { Version } from './version.js';
import { RELEASES_URL } from './pure/releasename.js';
import { COLORWAYS, DEFAULT_COLORWAY } from './colorway.js';
import { WarningLists } from './warnings.js';
import { usePref, TOOLTIPS_KEY, SETTINGS_MENU_KEY } from './mirror/prefs.js';
import { personHref, personaPageHref, LAUNCHER } from './links.js';

const html = htm.bind(h);

export { shortcode };

// The persona layer, as a hook. `current` is null while checking, while the account has no
// personas, and during the ceremony; the caller branches on `state`.
export function usePersona(account) {
    // checking | none | ceremony | naming | join | open | farewell
    const [state, setState] = useState('checking');
    const [current, setCurrent] = useState(null); // { root, name }
    const [ceremony, setCeremony] = useState(null); // { root, secret }
    const [naming, setNaming] = useState(null); // root awaiting its display name
    const [join, setJoin] = useState(null); // { requestCode } - the outbound half of adoption
    const [farewell, setFarewell] = useState(null); // { root, standing } - no longer this persona
    const [error, setError] = useState(null);
    const [personas, setPersonas] = useState([]); // the account's, as /api/identity lists them
    const live = useRef(null); // the open persona's live-cache handle
    // Which of the account's personas this browser was last using (Curtis, 2026-09-17: an
    // account may carry several): a per-browser convenience, never a fact of the persona.
    const rememberedKey = account ? `ringtome.persona.${account.id}` : null;
    const remembered = () => {
        try {
            return rememberedKey ? localStorage.getItem(rememberedKey) : null;
        } catch {
            return null;
        }
    };
    const remember = (root) => {
        try {
            if (rememberedKey) localStorage.setItem(rememberedKey, root);
        } catch {
            /* a browser without storage forgets; nothing breaks */
        }
    };

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
                // Auto-open the first persona this computer is still PART of: sign-in should
                // land you somewhere, not at a menu. A persona whose standing says this
                // computer was locked out (or left) gets the farewell instead - a
                // well-intentioned node discovers its own revocation and lets go, rather
                // than wandering a read-only ghost town (PROJECT_PLAN, Revocation).
                setPersonas(personas);
                const chosen = personas.find((p) => p.root_pubkey === remembered() && p.standing === 'active');
                if (chosen) return open(chosen.root_pubkey);
                const active = personas.find((p) => p.standing === 'active');
                if (active) return open(active.root_pubkey);
                // The farewell fires only on AFFIRMATIVE removal (isDeparted). "unknown" -
                // an unopenable db, an empty just-rebuilt tree awaiting its journal or a
                // peer - opens anyway: sync heals what it can, and can't-tell is not
                // goodbye (a farewell on absence-of-good-news once told a healthy computer
                // it had left, field-found 2026-08-02).
                const limbo = personas.find((p) => !isDeparted(p.standing));
                if (limbo) return open(limbo.root_pubkey);
                if (personas.length > 0) {
                    setFarewell({
                        root: personas[0].root_pubkey,
                        standing: personas[0].standing,
                    });
                    setState('farewell');
                    return;
                }
                // An account made by "import user" (auth.js): straight to bringing the persona
                // from its other computer.
                if (takeImportIntent()) {
                    startJoin().catch((e) => {
                        setError(e.message);
                        setState('none');
                    });
                    return;
                }
                setState('none');
            })
            .catch((e) => {
                setError(e.message);
                setState('none');
            });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [account]);

    // The live half of the same discovery: any surface's write bouncing with "revoked-signer"
    // (net.js announces it) means this computer's key was revoked while the tab was open.
    // Re-ask the node for standing and start the farewell - the moment a write fails is
    // exactly the moment the user needs to know why.
    useEffect(() => {
        const onRevoked = async () => {
            try {
                const personas = await api('/api/identity');
                const mine = current && personas.find((p) => p.root_pubkey === current.root);
                if (mine && isDeparted(mine.standing)) {
                    if (live.current) {
                        live.current.stop();
                        live.current = null;
                    }
                    setFarewell({ root: mine.root_pubkey, standing: mine.standing });
                    setState('farewell');
                }
            } catch {
                // If even the list won't load, the next write will re-announce.
            }
        };
        window.addEventListener('ringtome:revoked-signer', onRevoked);
        return () => window.removeEventListener('ringtome:revoked-signer', onRevoked);
         
    }, [current]);

    const refreshPersonas = async () => {
        try {
            setPersonas(await api('/api/identity'));
        } catch {
            /* the list is a convenience; the next open refreshes it */
        }
    };

    // Switch this browser to another of the account's personas: the old one's live cache
    // stops, the new one's starts, and the choice is remembered here.
    const switchTo = async (root) => {
        setError(null);
        remember(root);
        await open(root);
        await refreshPersonas();
    };

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
        remember(root);
        await open(root);
        await refreshPersonas();
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
        // Back to the persona this browser had, if it had one (2026-09-17).
        setState(current ? 'open' : 'none');
    };

    // While waiting in the join state, watch for the persona to arrive on its own: the granter
    // delivers the grant over the wire when it can (one-trip adoption), and this node completes
    // without anyone pasting anything. Polling the persona list is the humble, sufficient
    // signal - the live cache will replace it with a push someday.
    useEffect(() => {
        if (state !== 'join') return;
        // The persona that ARRIVES is the one to open - not the first on the list, which
        // may be one this account already had (2026-09-17).
        const known = new Set(personas.map((p) => p.root_pubkey));
        const timer = setInterval(async () => {
            try {
                const now = await api('/api/identity');
                const arrived = now.find((p) => !known.has(p.root_pubkey)) || (known.size === 0 ? now[0] : null);
                if (arrived) {
                    clearInterval(timer);
                    setPersonas(now);
                    remember(arrived.root_pubkey);
                    // Open FIRST, clear the join state after: `open` is async, and a render
                    // between `setJoin(null)` and its final `setState('open')` is still in
                    // the join state - JoinFlow with a null join crashed the whole render
                    // (field-found 2026-07-30: the new computer showed only the quickbar).
                    await open(arrived.root_pubkey);
                    setJoin(null);
                }
            } catch {
                // Transient fetch trouble just means we check again next tick.
            }
        }, 2000);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state]);

    const completeJoin = async (grantCode) => {
        const identity = await api('/api/identity/adopt/complete', {
            method: 'POST',
            body: JSON.stringify({ code: grantCode.trim() }),
        });
        // Same ordering rule as the arrival watcher above: open, then clear.
        remember(identity.root_pubkey);
        await open(identity.root_pubkey);
        await refreshPersonas();
        setJoin(null);
    };

    // The farewell's acknowledgment: unlink the persona from this node (node-local - the
    // persona goes on existing everywhere else), drop this browser's mirror of it, and go
    // back to being a computer with nobody in it.
    const letGo = async () => {
        const root = farewell.root;
        await api(`/api/identity/${root}/detach`, { method: 'POST' });
        await forgetMirror(root);
        setFarewell(null);
        setCurrent(null);
        setState('none');
    };

    return {
        state,
        current,
        personas,
        switchTo,
        refreshPersonas,
        ceremony,
        join,
        farewell,
        error,
        create,
        ceremonyDone,
        setDisplayName,
        startJoin,
        cancelJoin,
        completeJoin,
        letGo,
        shutdown,
    };
}

// The farewell: this computer's key was revoked - locked out by a senior computer, or it left
// on its own - and the network no longer accepts anything it signs. The honest posture is a
// plain goodbye and a clean detach, not a read-only ghost town where every save silently
// bounces. Cozy words match the Computers screen's status chips ("locked out" / "left"); the
// one button acknowledges and lets go.
export const FarewellScreen = ({ persona }) => {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    if (!persona.farewell) return null; // transitional render during the detach
    const lockedOut = persona.farewell.standing === 'repudiated';
    const letGo = async () => {
        setBusy(true);
        setError(null);
        try {
            await persona.letGo();
        } catch (e) {
            setError(e.message);
            setBusy(false);
        }
    };
    return html`
        <div class="null-state">
            <p class="null-title">
                ${lockedOut
                    ? t('persona.this-computer-has-been-locked-out', 'This computer has been locked out.')
                    : t('persona.this-computer-has-left-the-persona', 'This computer has left the persona.')}
            </p>
            <p class="null-sub">
                ${lockedOut
                    ? `Another of the persona's computers locked this one out - it no longer
                       speaks for the persona, and nothing written here will reach anyone.
                       If that's a surprise, talk to whoever holds the persona's other
                       computers (or its spare key).`
                    : `This computer's key retired. Everything it wrote up to that point still
                       counts; it just isn't part of the persona anymore.`}
            </p>
            <p class="null-sub">
                ${t(
                    'persona.the-persona-itself-is-fine',
                    "The persona itself is fine and lives on its other computers. All that's left here is to let it go."
                )}
            </p>
            ${error && html`<p class="form-error">${error}</p>`}
            <button class="welcome-go" disabled=${busy} onClick=${letGo}>
                ${busy ? '…' : t('persona.okay-let-it-go', 'okay - let it go')}
            </button>
        </div>
    `;
};

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
            <p class="null-title">${t('persona.nobody-lives-here-yet', 'Nobody lives here yet.')}</p>
            <p class="null-sub">
                ${t('persona.a-persona-is-who-you', 'A persona is who you are around here - your name, your pages, your stuff. You can have more than one, later.')}
            </p>
            ${persona.error && html`<p class="form-error">${persona.error}</p>`}
            <button class="welcome-go" disabled=${busy} onClick=${run(persona.create)}>
                ${busy ? '…' : t('persona.create-a-persona', 'create a persona')}
            </button>
            <p class="null-sub">
                ${t('persona.every-computer-you-bring-the', 'This computer becomes you too, with everything synced, when you')}
            </p>
            <button class="skip-link" disabled=${busy} onClick=${run(persona.startJoin)}>
                ${t('persona.bring-your-persona-from-another', 'bring your persona from another computer.')}
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

    // A transitional render can arrive with the join already cleared (the arrival watcher
    // opening the persona); rendering nothing for a frame beats crashing the whole tree.
    if (!persona.join) return null;

    return html`
        <div class="ceremony">
            <p class="null-title">${t('persona.bring-your-persona-here', 'Bring your persona here.')}</p>
            <p class="null-sub">
                ${tNodes(
                    'persona.on-a-computer-that-is',
                    'On a computer that is already you: open {computers}, choose {invite}, and give it this code:',
                    {
                        computers: html`<strong>${t('persona.your-computers', 'your computers')}</strong>`,
                        invite: html`<strong
                            >${t('persona.invite-another-computer', 'invite another computer')}</strong
                        >`,
                    },
                )}
            </p>
            <code class="spare-key">${persona.join.requestCode}</code>
            <p class="null-sub">
                <span class="waiting-dot"></span> ${t('persona.waiting---when-the-other', "Waiting - when the other computer accepts, your persona walks in here on its own. If it can't reach this computer, it will hand you an invite code instead; paste that below. Keep both computers awake either way.")}
            </p>
            <form class="welcome-form" onSubmit=${finish}>
                <textarea
                    class="spare-paste jag-field"
                    rows="4"
                    placeholder=${t('persona.invite-code-only-needed-if', "invite code (only needed if it doesn't arrive on its own)")}
                    value=${grantCode}
                    onInput=${(e) => setGrantCode(e.currentTarget.value)}
                    required
                ></textarea>
                ${error && html`<p class="form-error">${error}</p>`}
                <button class="welcome-go" type="submit" disabled=${busy}>
                    ${busy ? t('persona.bringing-your-things-across', 'bringing your things across…') : t('persona.become-me-here', 'become me here')}
                </button>
                <button type="button" class="skip-link" onClick=${persona.cancelJoin}>
                    ${t('persona.never-mind', 'never mind')}
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
    const [error, setError] = useState(null);

    const download = () => {
        const contents = [
            'HORSE DRAWING TYCOON 2 SPARE KEY - keep this somewhere safe and private.',
            'If you ever lose every computer that is you, this brings you back.',
            '',
            `persona: ${root}`,
            `spare key: ${secret}`,
        ].join('\n');
        setError(null);
        saveFile(`horse-drawing-tycoon-2-spare-key-${shortcode(root)}.txt`, new Blob([contents], { type: 'text/plain' })).catch((e) =>
            setError(e.message),
        );
    };

    return html`
        <div class="ceremony">
            <p class="null-title">${t('persona.this-is-your-spare-key', 'This is your spare key.')}</p>
            <p class="null-sub">
                ${tNodes(
                    'persona.if-you-ever-lose-every',
                    "If you ever lose every computer that knows you, this - and only this - brings you back. We don't keep a copy. {warning}",
                    {
                        warning: html`<strong
                            >${t('persona.we-can-never-show-it', 'We can never show it again.')}</strong
                        >`,
                    },
                )}
            </p>
            <code class="spare-key">${secret}</code>
            <button class="ceremony-download" onClick=${download}>${t('persona.download-it', 'download it')}</button>
            ${error && html`<p class="form-error">${error}</p>`}
            <label class="ceremony-confirm">
                <input
                    type="checkbox"
                    checked=${saved}
                    onInput=${(e) => setSaved(e.currentTarget.checked)}
                />
                ${t('persona.i-put-my-spare-key', 'I put my spare key somewhere safe')}
            </label>
            <button class="welcome-go" disabled=${!saved} onClick=${persona.ceremonyDone}>
                ${t('persona.okay-im-ready', "okay, I'm ready")}
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
    // The same cozy cap the profile editor enforces (pure/profile.js) - the first name a
    // persona ever gets must fit the same field every later rename does.
    const over = overProfileLimit('name', name);

    const submit = async (e) => {
        e.preventDefault();
        if (over) return;
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
            <p class="null-title">${t('persona.what-should-people-call-you', 'What should people call you?')}</p>
            <p class="null-sub">
                ${t('persona.this-is-the-name-people', "This is the name people see next to your stuff. It's yours to change whenever - it doesn't have to match your sign-in.")}
            </p>
            <form class="welcome-form" onSubmit=${submit}>
                <input
                    type="text"
                    class="name-input jag-field"
                    value=${name}
                    onInput=${(e) => setName(e.currentTarget.value)}
                    autocapitalize="off"
                />
                ${over &&
                html`<p class="form-error">
                    <span class="profile-count profile-count-over">
                        ${profileChars(name)}/${PROFILE_LIMITS.name}
                    </span>
                    ${' '}${t('persona.--a-name-this-long', "- a name this long won't fit")}
                </p>`}
                ${error && html`<p class="form-error">${error}</p>`}
                <button class="welcome-go" type="submit" disabled=${busy || over}>
                    ${busy ? '…' : t('persona.thats-me', 'that’s me')}
                </button>
                <button
                    type="button"
                    class="skip-link"
                    disabled=${busy}
                    onClick=${() => persona.setDisplayName('')}
                >${t('persona.maybe-later', 'maybe later')}</button>
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
/// The persona app IS your own /id page now (Curtis, 2026-09-05: the two overlapped, so
/// "/home/persona" is abandoned as a place and kept as a jump). The dock tile, the console
/// tile and every sub-page's back button still say /home/persona; this turns them into a
/// visit to your own page, replacing the history entry so back never lands here twice.
export const PersonaHome = ({ persona }) => {
    const loc = useLocation();
    const root = persona.current && persona.current.root;
    useEffect(() => {
        if (root) loc.route(personHref(root), true);
    }, [root]); // eslint-disable-line react-hooks/exhaustive-deps
    return null;
};

/// Managing yourself, on your own page: the three items the old persona home carried -
/// profile, your computers, log out - folded into the disclosure that sits where "this is
/// you" used to be a link (Curtis, 2026-09-05), under a gear and "your settings". Only the
/// person in question ever sees it.
// The account tag the node hands its administrators (src/auth.rs) - a key, never a phrase.
const NODE_ADMIN_TAG = 'node_admin';

export const PersonaMenu = ({ persona, session }) => {
    // Left open or closed, it stays that way (Curtis, 2026-09-27) - a pref, kept by this browser.
    const [menu, setMenu] = usePref(persona.current.root, SETTINGS_MENU_KEY, 'closed');
    const logout = async () => {
        // Heading out forgets this browser: stream stopped, mirror dropped. Confirm first - it's
        // easy to hit by mistake, and coming back means signing in again.
        if (!confirm(t('persona.log-out-of-this-browser', 'Log out of this browser? You will sign in again to come back.'))) return;
        await persona.shutdown();
        session.logout();
    };
    return html`
        <details
            class="you-menu"
            open=${menu === 'open'}
            onToggle=${(e) => {
                const now = e.currentTarget.open ? 'open' : 'closed';
                if (now !== menu) setMenu(now);
            }}
        >
            <summary class="ledger-head">
                <span class="persona-menu-icon"><${Icons.settings} /></span>
                ${t('persona.your-settings', 'your settings')}
            </summary>
            ${/* An administrator is told so (Curtis, 2026-09-16): the account's tags ride
                the session's whoami answer. */ ''}
            ${session && session.account && (session.account.tags || []).includes(NODE_ADMIN_TAG) &&
            html`<p class="persona-menu-note">${t('persona.you-administer-this-node', 'you administer this node')}</p>`}
            <nav class="persona-menu">
                <a class="persona-menu-item" href=${personaPageHref('profile')}>
                    <span class="persona-menu-icon"><${Icons.profile} /></span>
                    <span class="persona-menu-label">
                        <strong>${t('persona.profile', 'profile')}</strong>
                        <small>${t('persona.your-name-and-how-you', 'your name and how you appear')}</small>
                    </span>
                </a>
                <a class="persona-menu-item" href=${personaPageHref('settings')}>
                    <span class="persona-menu-icon"><${Icons.appSettings} /></span>
                    <span class="persona-menu-label">
                        <strong>${t('persona.application-settings-menu', 'application settings')}</strong>
                        <small>${t('persona.how-the-app-behaves', 'how the app behaves for you, on this browser')}</small>
                    </span>
                </a>
                <a class="persona-menu-item" href=${personaPageHref('personas')}>
                    <span class="persona-menu-icon"><${Icons.personas} /></span>
                    <span class="persona-menu-label">
                        <strong>${t('persona.your-personas', 'your personas')}</strong>
                        <small>${t('persona.manage-who-you-appear-to-be', 'manage who you appear to be')}</small>
                    </span>
                </a>
                <a class="persona-menu-item" href=${personaPageHref('computers')}>
                    <span class="persona-menu-icon"><${Icons.computers} /></span>
                    <span class="persona-menu-label">
                        <strong>${t('persona.your-computers-2', 'your computers')}</strong>
                        <small>${t('persona.the-machines-that-carry-this', "the computers you're signed in on")}</small>
                    </span>
                </a>
                <a class="persona-menu-item" href=${personaPageHref('content')}>
                    <span class="persona-menu-icon"><${Icons.biohazard} /></span>
                    <span class="persona-menu-label">
                        <strong>${t('persona.content-control', 'content control')}</strong>
                        <small>${t('persona.what-gets-blurred-or-hidden', 'what gets blurred, and what stays off your pages')}</small>
                    </span>
                </a>
                <button class="persona-menu-item persona-menu-danger" onClick=${logout}>
                    <span class="persona-menu-icon"><${Icons.logout} /></span>
                    <span class="persona-menu-label">
                        <strong>${t('persona.log-out', 'log out')}</strong>
                        <small>${t('persona.forget-this-browser-and-head', 'forget this browser and head out')}</small>
                    </span>
                </button>
            </nav>
        </details>
    `;
};

// One profile field as an explicit DRAFT - not a shadow buffer, deliberately: every profile
// save mints a permanent chain record, so nothing here saves on its own. The draft holds
// your typing; `commit` writes it; a mirror echo (a rename on another computer) is adopted
// only while your draft is clean, exactly the shadow contract minus the autosave.
/// Content control (Curtis, 2026-09-07): its own page under your settings, the biohazard
/// on the door - the blur and hide tag lists (warnings.js), which lived on the profile page
/// for an afternoon.
export const ContentControl = ({ current }) => {
    if (!current) return null;
    return html`
        <div class="persona-page">
            <div class="persona-page-head">
                <h1 class="persona-page-title">${t('persona.content-control-2', 'content control')}</h1>
            </div>
            <${WarningLists} root=${current.root} />
        </div>
    `;
};

/// Application settings (Curtis, 2026-09-27): how the app behaves for you, a zone of your settings
/// of its own, after the profile - as opposed to what you say about yourself there. Prefs, so kept
/// by this browser alone (mirror/prefs.js).
export const AppSettings = ({ current }) => (current && current.root ? html`<${AppSettingsFor} root=${current.root} />` : null);

// The page itself, once there is a persona whose prefs to read.
const AppSettingsFor = ({ root }) => {
    const [tooltips, setTooltips] = usePref(root, TOOLTIPS_KEY, 'on');
    return html`
        <div class="persona-page">
            <div class="persona-page-head">
                <h1 class="persona-page-title">${t('persona.application-settings', 'application settings')}</h1>
            </div>
            <label class="profile-setting">
                <input
                    type="checkbox"
                    checked=${tooltips === 'off'}
                    onChange=${(e) => setTooltips(e.currentTarget.checked ? 'off' : 'on')}
                />
                ${t('persona.disable-tooltips', 'disable tooltips')}
            </label>
            <p class="null-sub">${t('persona.settings-this-browser', 'these settings are for this browser')}</p>
            ${/* The running build (Curtis, 2026-09-30: a narrow window's bar has no version, so a phone
                had "no way to see this when you're logged in"): its name, linked to its notes as
                the bar's is, and every release beside it. */ ''}
            <p class="settings-version-line">
                ${t('persona.version', 'version')}${' '}<${Version} className="settings-version" />${' '}·${' '}<a href=${RELEASES_URL} target="_blank" rel="noopener">${t('persona.every-release', 'every release')}</a>
            </p>
        </div>
    `;
};

/// The longest side a profile picture is sent at: the node keeps an avatar small, and a phone
/// photo at full size would only be a slower upload to the same result.
const AVATAR_MAX_SIDE = 1024;

/// A picture chosen for the profile (Curtis, 2026-09-27: make your own rather than upload one) as
/// image bytes for the avatar door, made here in the browser: a drawing flattened - its pictures
/// and fonts waited for, as a publication does - or a picture from your media drawn onto a canvas,
/// no larger than AVATAR_MAX_SIDE. Either way a PNG, which the node's image ingest takes like any
/// upload; the avatar is public, so the node makes it a born-public picture of its own, and the
/// original stays as private as it was.
async function avatarBytes(root, pick) {
    if (pick.format === 'drawing') {
        const detail = await api(`/api/identity/${root}/docs/${pick.doc}`);
        if (detail.body == null) throw new Error(t('persona.drawing-not-here-yet', 'that drawing has not reached this computer yet - try again in a moment'));
        return flattenToBlob(root, readBody(detail.body));
    }
    const img = new Image();
    img.src = `/api/identity/${root}/docs/${pick.doc}/body`;
    await img.decode();
    const scale = Math.min(1, AVATAR_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(t('persona.could-not-read-that-picture', 'could not read that picture')))), 'image/png')
    );
}

// The banner's look lives with the person widgets now (person.js), which a People row shares.
export { bannerStyle };

function useProfileDraft(root, field) {
    const live = useLive(() => openMirror(root).profile.get(field), [root, field]);
    const mirror = (live && live.value) || '';
    const [draft, setDraft] = useState(mirror);
    // The value we successfully wrote, standing in for the mirror until its echo lands -
    // without it, the moment after a save reads as "unsaved changes" again.
    const [written, setWritten] = useState(null);
    const adopted = useRef(mirror);
    useEffect(() => {
        if (mirror === adopted.current) return;
        if (draft === adopted.current) setDraft(mirror);
        adopted.current = mirror;
        if (written !== null && mirror === written) setWritten(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mirror]);

    const baseline = written !== null ? written : mirror;
    return {
        draft,
        setDraft,
        dirty: draft !== baseline,
        chars: profileChars(draft),
        cap: PROFILE_LIMITS[field],
        over: overProfileLimit(field, draft),
        commit: async () => {
            await api(`/api/identity/${root}/profile`, {
                method: 'POST',
                body: JSON.stringify({ field, value: draft }),
            });
            setWritten(draft);
            adopted.current = draft;
        },
    };
}

// A field's label row: the name on the left, the count on the right - characters spent
// against the field's cozy cap (pure/profile.js; the wire's byte cap sits safely beyond it),
// red once it can no longer save.
const FieldLabel = ({ label, field }) => html`
    <span class="profile-field-label">
        ${label}
        <span class=${field.over ? 'profile-count profile-count-over' : 'profile-count'}>
            ${field.chars}/${field.cap}
        </span>
    </span>
`;

// The profile editor: your public self-claims (name, bio). Saving is a BUTTON, not a
// debounce - every change mints a whole permanent record on the profile chain, so the write
// happens when you've committed to the words, not when you pause typing.
export const Profile = ({ current }) => {
    const root = current.root;
    const loc = useLocation();
    const name = useProfileDraft(root, 'name');
    const bio = useProfileDraft(root, 'bio');
    const [busy, setBusy] = useState(false);
    // An error message, or null: only an error ever shows, since a save that lands leaves for your page.
    const [flash, setFlash] = useState(null);
    const dirty = name.dirty || bio.dirty;
    const over = name.over || bio.over;

    const save = async () => {
        setBusy(true);
        setFlash(null);
        try {
            if (name.dirty) await name.commit();
            if (bio.dirty) await bio.commit();
            // Saved: back to your own page, where the words now show (Curtis, 2026-09-27). A
            // failed save stays here, with its error.
            loc.route(personHref(root));
            return;
        } catch (e) {
            setFlash(e.message || 'that save did not take - try again');
        }
        setBusy(false);
    };

    // The avatar: a register holds the pointer, a born-public media document holds the
    // file (PROJECT_PLAN - everything file-shaped is a document). Upload crushes inline
    // and echoes back through the profile stream within a beat.
    const avatarLive = useLive(() => openMirror(root).profile.get('avatar'), [root]);
    const avatarDoc = avatarLive && avatarLive.value;
    const [avatarBusy, setAvatarBusy] = useState(false);
    const [avatarErr, setAvatarErr] = useState(null);
    // The picture is chosen, not uploaded (Curtis, 2026-09-27): the image picker the drawing uses,
    // offering your drawings as well as your media - make your own. (An outside picture comes in
    // through hrseFiles, like any file, and can be chosen from there.)
    const [choosing, setChoosing] = useState(false);
    // The banner (2026-09-28): chosen the same way, a still picture across the top of your page.
    const bannerLive = useLive(() => openMirror(root).profile.get('banner'), [root]);
    const bannerDoc = (bannerLive && bannerLive.value) || '';
    const [bannerBusy, setBannerBusy] = useState(false);
    const [bannerErr, setBannerErr] = useState(null);
    const [choosingBanner, setChoosingBanner] = useState(false);
    const pickBanner = async (pick) => {
        setChoosingBanner(false);
        setBannerBusy(true);
        setBannerErr(null);
        try {
            const form = new FormData();
            form.append('image', await avatarBytes(root, pick), 'banner.png');
            await api(`/api/identity/${root}/banner`, { method: 'POST', body: form });
        } catch (err) {
            setBannerErr(err.message);
        }
        setBannerBusy(false);
    };
    const clearBanner = async () => {
        setBannerBusy(true);
        setBannerErr(null);
        try {
            await api(`/api/identity/${root}/banner`, { method: 'DELETE' });
        } catch (err) {
            setBannerErr(err.message);
        }
        setBannerBusy(false);
    };
    const pickAvatar = async (pick) => {
        setChoosing(false);
        setAvatarBusy(true);
        setAvatarErr(null);
        try {
            const form = new FormData();
            form.append('image', await avatarBytes(root, pick), 'avatar.png');
            await api(`/api/identity/${root}/avatar`, { method: 'POST', body: form });
        } catch (err) {
            setAvatarErr(err.message);
        }
        setAvatarBusy(false);
    };

    return html`
        <div class="persona-page">
            <div class="persona-page-head">
                <h1 class="persona-page-title">${t('persona.profile-2', 'profile')}</h1>
            </div>
            <div class="profile-avatar-row">
                ${avatarDoc
                    ? html`<img
                          class="profile-avatar"
                          src="/id/${root}/docs/${avatarDoc}/thumb"
                          alt=${t('persona.your-avatar', 'your avatar')}
                      />`
                    : html`<span
                          class="profile-avatar profile-avatar-empty"
                          style="background: hsl(${personaHue(root)}, 60%, 55%)"
                      ></span>`}
                <button class="profile-avatar-pick" disabled=${avatarBusy} onClick=${() => setChoosing(true)}>
                    ${avatarBusy ? t('persona.working-on-it', 'working on it…') : avatarDoc ? t('persona.change-your-picture', 'change your picture') : t('persona.add-a-picture', 'add a picture')}
                </button>
                ${choosing &&
                html`<${ImagePickModal}
                    root=${root}
                    drawings=${true}
                    DrawingThumb=${DrawingThumb}
                    heading=${t('persona.choose-your-picture', 'choose your picture')}
                    onPick=${pickAvatar}
                    onClose=${() => setChoosing(false)}
                />`}
            </div>
            ${avatarErr && html`<p class="form-error">${avatarErr}</p>`}
            <div class="profile-banner-row">
                <div class="profile-banner" style=${bannerStyle(root, bannerDoc)} aria-label=${t('persona.your-banner', 'your banner')}></div>
                <div class="profile-banner-acts">
                    <button class="profile-avatar-pick" disabled=${bannerBusy} onClick=${() => setChoosingBanner(true)}>
                        ${bannerBusy ? t('persona.working-on-it', 'working on it…') : bannerDoc ? t('persona.change-your-banner', 'change your banner') : t('persona.add-a-banner', 'add a banner')}
                    </button>
                    ${bannerDoc &&
                    html`<button class="profile-avatar-pick" disabled=${bannerBusy} onClick=${clearBanner}>
                        ${t('persona.remove-your-banner', 'back to your pattern')}
                    </button>`}
                </div>
                ${choosingBanner &&
                html`<${ImagePickModal}
                    root=${root}
                    drawings=${true}
                    DrawingThumb=${DrawingThumb}
                    heading=${t('persona.choose-your-banner', 'choose your banner')}
                    onPick=${pickBanner}
                    onClose=${() => setChoosingBanner(false)}
                />`}
            </div>
            ${bannerErr && html`<p class="form-error">${bannerErr}</p>`}
            <label class="profile-field">
                <${FieldLabel} label=${t('persona.name', 'name')} field=${name} />
                <input
                    class="name-input jag-field"
                    value=${name.draft}
                    onInput=${(e) => name.setDraft(e.currentTarget.value)}
                    placeholder=${t('persona.what-people-call-you-here', 'what people call you here')}
                />
            </label>
            <${NodeSlug} root=${root} />
            <label class="profile-field">
                <${FieldLabel} label=${t('persona.bio', 'bio')} field=${bio} />
                <textarea
                    class="profile-bio jag-field"
                    value=${bio.draft}
                    onInput=${(e) => bio.setDraft(e.currentTarget.value)}
                    rows="6"
                    placeholder=${t('persona.a-line-or-two-about', 'a line or two about you (optional)')}
                ></textarea>
            </label>
            <${ColorwayPicker} root=${root} />
            <div class="profile-save-row">
                <button
                    class="profile-save"
                    disabled=${!dirty || over || busy}
                    onClick=${save}
                >${t('persona.save', 'Save')}</button>
                <span class="profile-flash profile-flash-err">${flash}</span>
            </div>
        </div>
    `;
};

/// Your colourway for the whole app (Curtis, 2026-09-30), a profile field like your name - but saved
/// the moment you pick it, since trying one on IS picking it. Public: your page wears it for anyone
/// who visits (colorway.js).
const COLORWAY_WORDS = {
    'horse-relax': () => t('persona.colorway-horse-relax', 'horse-relax'),
    witchlight: () => t('persona.colorway-witchlight', 'witchlight'),
    'doors-xp': () => t('persona.colorway-doors-xp', 'doors-xp'),
    bosc: () => t('persona.colorway-bosc', 'bosc'),
    micross: () => t('persona.colorway-micross', 'micross'),
    terminal: () => t('persona.colorway-terminal', 'terminal'),
};
const COLORWAY_CLASS = {
    'horse-relax': 'colorway-swatch colorway-horse-relax',
    witchlight: 'colorway-swatch colorway-witchlight',
    'doors-xp': 'colorway-swatch colorway-doors-xp',
    bosc: 'colorway-swatch colorway-bosc',
    micross: 'colorway-swatch colorway-micross',
    terminal: 'colorway-swatch colorway-terminal',
};

const ColorwayPicker = ({ root }) => {
    const row = useLive(() => openMirror(root).profile.get('colorway'), [root]);
    const current = (row && COLORWAYS.includes(row.value) && row.value) || DEFAULT_COLORWAY;
    const [error, setError] = useState(null);
    const pick = async (colorway) => {
        setError(null);
        try {
            await api(`/api/identity/${root}/profile`, { method: 'POST', body: JSON.stringify({ field: 'colorway', value: colorway }) });
        } catch (e) {
            setError(e.message || String(e));
        }
    };
    return html`<div class="profile-field">
        <span class="profile-field-label">${t('persona.colorway', 'colorway')}</span>
        <div class="colorway-options" role="radiogroup">
            ${COLORWAYS.map(
                (c) => html`<button
                    key=${c}
                    type="button"
                    role="radio"
                    aria-checked=${c === current}
                    class=${c === current ? 'colorway-option jag-line picked' : 'colorway-option jag-line'}
                    onClick=${() => pick(c)}
                ><span class=${COLORWAY_CLASS[c]}><span></span><span></span><span></span></span>${COLORWAY_WORDS[c]()}</button>`
            )}
        </div>
        ${error && html`<p class="form-error">${error}</p>`}
    </div>`;
};

/// Your short name on this node (PROJECT_PLAN's The node's public face, rulings 6 and 7): `@cube-drone`, first come
/// first served here and meaning nothing anywhere else. You keep the one before it too,
/// which sends readers on to the current one; changing again drops the older.
const NodeSlug = ({ root }) => {
    const [held, setHeld] = useState(null); // { slug, last }
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState(null);
    useEffect(() => {
        if (!root) return undefined;
        let live = true;
        api(`/api/identity/${root}/slug`)
            .then((r) => {
                if (!live) return;
                setHeld(r);
                setDraft(r.slug || '');
            })
            .catch(() => live && setHeld({ slug: null, last: null }));
        return () => {
            live = false;
        };
    }, [root]);
    const claim = async () => {
        setBusy(true);
        setNote(null);
        try {
            const r = await api(`/api/identity/${root}/slug`, { method: 'PUT', body: JSON.stringify({ slug: draft }) });
            setHeld(r);
            setDraft(r.slug || '');
            setNote(r.slug ? t('persona.this-node-knows-you-as', 'this node knows you as @{slug}', { slug: r.slug }) : t('persona.name-given-up', 'name given up'));
        } catch (e) {
            setNote(e.message || t('persona.that-name-did-not-take', 'that name did not take'));
        }
        setBusy(false);
    };
    if (!held) return null;
    const same = (draft || '').trim().replace(/^@/, '').toLowerCase() === (held.slug || '');
    return html`
        <label class="profile-field profile-slug">
            <span class="profile-field-label">
                ${t('persona.your-name-on-this-node', 'your name on this node')}
                <small>${t('persona.slug-hint', 'your @name here')}</small>
            </span>
            <span class="profile-slug-row">
                <span class="profile-slug-at">@</span>
                <input
                    class="profile-slug-input jag-field"
                    type="text"
                    maxlength="32"
                    placeholder=${t('persona.a-name', 'a-name')}
                    value=${draft}
                    onInput=${(e) => setDraft(e.currentTarget.value)}
                    onKeyDown=${(e) => e.key === 'Enter' && !same && claim()}
                />
                <button class="profile-save" disabled=${busy || same} onClick=${claim}>
                    ${held.slug ? t('persona.change', 'change') : t('persona.claim', 'claim')}
                </button>
            </span>
            ${held.last &&
            html`<small class="profile-slug-last">${t('persona.also-answers-to', 'also @{last}', { last: held.last })}</small>`}
            ${note && html`<span class="profile-flash">${note}</span>`}
        </label>
    `;
};

/// Your personas (Curtis, 2026-09-17): every persona this account carries on this node, the
/// one this browser is using marked; switch to another, make a new one, or bring one here
/// from another computer. Switching is a per-browser choice; each persona is its own, whole.
export const Personas = ({ persona, current }) => {
    const loc = useLocation();
    const [names, setNames] = useState({});
    const [busy, setBusy] = useState(false);
    const list = persona.personas || [];
    const roots = list.map((p) => p.root_pubkey).join(',');
    useEffect(() => {
        persona.refreshPersonas();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useEffect(() => {
        let live = true;
        Promise.all(
            list.map(async (p) => {
                try {
                    const profile = await api(`/api/identity/${p.root_pubkey}/profile`);
                    return [p.root_pubkey, (profile.find((f) => f.field === 'name') || {}).value || ''];
                } catch {
                    return [p.root_pubkey, ''];
                }
            })
        ).then((pairs) => live && setNames(Object.fromEntries(pairs)));
        return () => {
            live = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [roots]);
    const run = (fn) => async () => {
        setBusy(true);
        try {
            await fn();
        } finally {
            setBusy(false);
        }
    };
    return html`
        <div class="persona-page">
            <div class="persona-page-head">
                <h1 class="persona-page-title">${t('persona.your-personas-2', 'your personas')}</h1>
                <p class="persona-page-sub">${t('persona.personas-hint', 'each has its own name, pages and people')}</p>
            </div>
            <div class="persona-list">
                ${list.map((p) => {
                    const mine = current && current.root === p.root_pubkey;
                    const words = speakable(p.root_pubkey).split('-').slice(0, 2).join('-');
                    return html`<div class=${mine ? 'persona-row jag-line persona-row-current' : 'persona-row jag-line'} key=${p.root_pubkey}>
                        <span class="persona-chip" style="background: hsl(${personaHue(p.root_pubkey)}, 60%, 55%)"></span>
                        <span class="persona-row-words">
                            <strong>${names[p.root_pubkey] || words}</strong>
                            <small>${words}${p.standing !== 'active' ? ` · ${p.standing}` : ''}</small>
                        </span>
                        ${mine
                            ? html`<span class="persona-row-mark">${t('persona.this-browser', 'this browser')}</span>`
                            : html`<button
                                  class="persona-row-switch jag-line"
                                  disabled=${busy || p.standing !== 'active'}
                                  onClick=${run(() => persona.switchTo(p.root_pubkey).then(() => loc.route(LAUNCHER)))}
                              >${t('persona.switch', 'switch')}</button>`}
                    </div>`;
                })}
            </div>
            <div class="persona-list-actions">
                <button class="welcome-go" disabled=${busy} onClick=${run(persona.create)}>
                    ${t('persona.make-a-new-persona', 'make a new persona')}
                </button>
                <button class="skip-link" disabled=${busy} onClick=${run(persona.startJoin)}>
                    ${t('persona.bring-a-persona-here-from', 'bring a persona here from another computer')}
                </button>
            </div>
            ${persona.error && html`<p class="form-error">${persona.error}</p>`}
        </div>
    `;
};
