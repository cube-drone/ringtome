// Node login and registration - the bargain-basement front door. Accounts here are
// node-local (username + password on THIS node); identities come later and are a
// separate, grander ceremony. Sessions ride an HttpOnly cookie the server sets, so
// this file never touches a token - net.js's `credentials: 'same-origin'` does all the work.
// The recovery flow reads `err.status` (the 409 re-homing branch), which is why net.js sets it
// on every failure rather than only where someone remembered to.
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';

import { api, isDevice, isLinuxApp } from './net.js';
import { t } from './i18n.js';
import { Icons } from './icons.js';
import { readQr } from './qrread.js';
import { DownloadPanel } from './downloads.js';
import { Marquee } from './frontdoor.js';

const html = htm.bind(h);

// "Import user" (Curtis, 2026-09-28): an account made to host a persona that already lives on
// another node goes straight into bringing it here, rather than landing on "nobody lives here
// yet". Held for the one page load between signing up and the persona layer asking
// (persona.js, `takeImportIntent`); never stored.
let importIntent = false;
export const takeImportIntent = () => {
    const was = importIntent;
    importIntent = false;
    return was;
};

// "Been here before" (Curtis, 2026-10-11): set the first time this browser holds a session, and
// never cleared - signing out does not make someone new. It only orders the front door's tabs:
// sign in leads for someone who has signed in here before, and comes last for everyone else.
const RETURNING = 'signed-in-before';
const wasHereBefore = () => {
    try {
        return localStorage.getItem(RETURNING) === 'yes';
    } catch {
        return false;
    }
};
const markHere = () => {
    try {
        localStorage.setItem(RETURNING, 'yes');
    } catch {
        /* no storage: they meet the newcomer's order next time */
    }
};

// The session, as a hook: `account` is null until whoami answers (or 401s).
// `checking` covers the first paint so we don't flash the login screen at
// someone who is already signed in.
export function useSession() {
    const [account, setAccount] = useState(null);
    const [checking, setChecking] = useState(true);

    useEffect(() => {
        api('/api/auth/whoami')
            .then((acct) => {
                if (acct) markHere();
                setAccount(acct);
            })
            .catch(() => setAccount(null))
            .finally(() => setChecking(false));
    }, []);

    const login = async (username, password) => {
        const acct = await api('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username, password }),
        });
        markHere();
        setAccount(acct);
    };

    // Register does not set the session cookie (it just makes the account), so
    // signing up is register-then-login in one motion.
    const register = async (username, password, registrationPassword) => {
        await api('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify({
                username,
                password,
                registration_password: registrationPassword || null,
            }),
        });
        await login(username, password);
    };

    const logout = async () => {
        await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
        setAccount(null);
    };

    return { account, checking, login, register, logout };
}

// Who may sign up here (node/src/registration.rs): 'open', 'password' (a shared sign-up
// password), or 'closed'. Asked once per visit to the front door; null until it answers, and
// 'open' if it cannot be asked - the node refuses at the door either way, so a wrong guess costs
// one error message, never an account.
function useRegistrationMode() {
    const [mode, setMode] = useState(null);
    useEffect(() => {
        api('/api/registration')
            .then((r) => setMode(r.mode || 'open'))
            .catch(() => setMode('open'));
    }, []);
    return mode;
}

// Live username availability for the signup form, debounced so we're not
// pestering the node per keystroke. Returns null (unknown/idle), or
// { ok: bool, note: string }.
function useAvailability(username, enabled) {
    const [state, setState] = useState(null);
    const timer = useRef(null);

    useEffect(() => {
        setState(null);
        if (!enabled || username.length < 2) return;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
            api(`/api/auth/check-username?username=${encodeURIComponent(username)}`)
                .then((r) =>
                    setState(
                        r.available
                            ? { ok: true, note: 'available!' }
                            : { ok: false, note: 'someone already has that name here' },
                    ),
                )
                // 400 means the name isn't a valid slug; the server message says why.
                .catch((e) => setState({ ok: false, note: e.message }));
        }, 400);
        return () => clearTimeout(timer.current);
    }, [username, enabled]);

    return state;
}

// Pull the 64-hex-char secret out of whatever got pasted - the bare seed, or the whole
// spare-key file ("spare key: <hex>"). Last match wins (the file lists the persona's root
// pubkey first, and that is also 64 hex chars).
function extractSecret(pasted) {
    const matches = pasted.match(/[0-9a-f]{64}/gi);
    return matches ? matches[matches.length - 1] : pasted.trim();
}

// The front door: sign in, make an account, or come back in with your spare key.
/// Above the sign-in, in the desktop app on Linux only (Curtis, 2026-09-28): its webview is slower
/// than a real browser and cannot show every picture, so it points the way out. The link asks
/// the app to open this node in the system's own browser (shell.rs).
/// Above the sign-in tabs, in the desktop app (Curtis, 2026-09-28): this is a server on this
/// computer, at an address any browser here can open - and the link opens the system's own.
const LocalServerNotice = () => {
    const [error, setError] = useState(null);
    if (!isDevice()) return null;
    const open = (e) => {
        e.preventDefault();
        setError(null);
        api('/api/shell/open-in-browser', { method: 'POST' }).catch((err) => setError(err.message));
    };
    return html`<div class="welcome-local">
        <span class="welcome-local-icon"><${Icons.device} /></span>
        <p class="welcome-local-mode">${t('auth.running-in-local-server-mode', 'Running in Local Server Mode:')}</p>
        <a class="welcome-local-address" href="#" onClick=${open}>${t('auth.local-address', 'localhost:{port}', { port: window.location.port })}</a>
        ${error && html`<p class="form-error">${error}</p>`}
    </div>`;
};

const LinuxNotice = () => {
    const [error, setError] = useState(null);
    if (!isLinuxApp()) return null;
    const open = (e) => {
        e.preventDefault();
        setError(null);
        api('/api/shell/open-in-browser', { method: 'POST' }).catch((err) => setError(err.message));
    };
    return html`<div class="welcome-notice">
        <strong>${t('auth.warning', 'Warning:')}</strong>
        ${' '}${t('auth.linux-works-best-in', 'on Linux, Horse Drawing Tycoon 2 works best from Chrome or Firefox.')}
        ${' '}<a href="#" onClick=${open}>${t('auth.open-in-your-browser', 'Click here to open in your system browser.')}</a>
        ${error && html`<p class="form-error">${error}</p>`}
    </div>`;
};

export const Welcome = ({ session }) => {
    const [returning] = useState(wasHereBefore);
    // 'login' | 'register' | 'import' | 'recover' | 'download'; the first tab until answered.
    const [mode, setMode] = useState(returning ? 'login' : 'register');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [spareKey, setSpareKey] = useState('');
    // Reading the spare key's QR code from a picture: '' | 'reading' | 'read' | 'none'.
    const [qrRead, setQrRead] = useState('');
    // Re-homing: revealed only when the server answers 409 ("this key is real, but the
    // account holds siblings") - the proven persona then moves to a fresh account.
    const [needsNewName, setNeedsNewName] = useState(false);
    const [newUsername, setNewUsername] = useState('');
    const [signupPassword, setSignupPassword] = useState('');
    const registration = useRegistrationMode();
    const signupsClosed = registration === 'closed';
    const askSignupPassword = registration === 'password';
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    // Importing is making an account too, with a word about why, and a different landing.
    const importing = mode === 'import';
    const registering = mode === 'register' || importing;
    const availability = useAvailability(username, registering);
    // On a local device the account's secret is a PIN (Curtis, 2026-10-20): it only guards this
    // computer's own server, and "password" made it sound like the network's.
    const pin = isDevice();
    const newNameAvailability = useAvailability(newUsername, needsNewName);

    // A picture of the spare key's QR code (persona.js shows one, 2026-10-20) in place of pasting
    // it: what the code says lands in the field as if pasted, for the person to see before going on.
    const readPicture = async (file) => {
        if (!file) return;
        setQrRead('reading');
        let said = null;
        try {
            said = await readQr(file);
        } catch {
            said = null; // not a picture this browser can open
        }
        if (said && /[0-9a-f]{64}/i.test(said)) {
            setSpareKey(extractSecret(said));
            setQrRead('read');
        } else {
            setQrRead('none');
        }
    };

    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            if (mode === 'recover') {
                const body = {
                    username,
                    recovery_secret: extractSecret(spareKey),
                    new_password: password,
                };
                if (needsNewName) {
                    body.new_username = newUsername;
                }
                const res = await api('/api/auth/recover', {
                    method: 'POST',
                    body: JSON.stringify(body),
                });
                // Re-homed personas live under the new name; in-place resets keep the old.
                await session.login(res.rehomed ? newUsername : username, password);
            } else if (registering) {
                importIntent = importing;
                try {
                    await session.register(username, password, signupPassword);
                } catch (err) {
                    importIntent = false;
                    throw err;
                }
            } else {
                await session.login(username, password);
            }
        } catch (err) {
            if (mode === 'recover' && err.status === 409) {
                setNeedsNewName(true);
                setError(err.message);
            } else if (pin && err.status === 401 && mode === 'login') {
                // The server's "wrong name or password", in the PIN's word.
                setError(t('auth.wrong-name-or-pin', 'wrong name or PIN'));
            } else {
                setError(err.message);
            }
        } finally {
            setBusy(false);
        }
    };

    const picked = useRef(false);
    const switchMode = (next) => {
        picked.current = true;
        setMode(next);
        setError(null);
    };
    // The tabs' order (Curtis, 2026-10-11): sign in first for someone who has signed in here
    // before, last for everyone else; ahead of it, "new here?" where anyone may sign up, and
    // download where sign-ups are closed or need a password. The desktop app is already
    // downloaded. Until the node says who may sign up, it is taken as open.
    const signups = signupsClosed ? [] : ['register', 'import'];
    const download = isDevice() ? [] : ['download'];
    const rest =
        registration === 'open' || registration === null
            ? [...signups, ...download]
            : [...download, ...signups];
    const tabs = returning ? ['login', ...rest] : [...rest, 'login'];
    // The first tab is the one open on arrival, unless the visitor has already picked one that
    // is still there.
    const first = tabs[0];
    const gone = mode !== 'recover' && !tabs.includes(mode);
    useEffect(() => {
        if (!picked.current || gone) {
            setMode(first);
        }
    }, [first, gone]);

    if (mode === 'recover') {
        return html`
            <div class="welcome">
                <${LinuxNotice} />
                <p class="welcome-sub">${t('auth.locked-out-your-spare-key', 'locked out? your spare key gets you back in.')}</p>
                <div class="welcome-box">
                <form class="welcome-form" onSubmit=${submit}>
                    <label>
                        ${t('auth.name', 'name')}
                        <input
                            class="jag-field"
                            type="text"
                            placeholder=${t('auth.any-name-of-yours', 'your sign-in name, or a name your persona goes by')}
                            value=${username}
                            onInput=${(e) => setUsername(e.currentTarget.value)}
                            autocomplete="username"
                            autocapitalize="off"
                            required
                        />
                    </label>
                    <label>
                        ${t('auth.spare-key', 'spare key')}
                        <textarea
                            class="spare-paste jag-field"
                            rows="3"
                            placeholder=${t('auth.paste-your-spare-key-here', 'paste your spare key here - the whole file is fine')}
                            value=${spareKey}
                            onInput=${(e) => setSpareKey(e.currentTarget.value)}
                            required
                        ></textarea>
                    </label>
                    <label class="spare-picture jag-line">
                        <${Icons.qrCode} /> ${t('auth.or-a-picture-of-its-qr', 'or pick a picture of its QR code')}
                        <input
                            type="file"
                            accept="image/*"
                            onChange=${(e) => {
                                readPicture(e.currentTarget.files[0]);
                                e.currentTarget.value = ''; // the same picture, picked again, still reads
                            }}
                        />
                    </label>
                    ${qrRead === 'reading' && html`<p class="field-note">${t('auth.reading-the-picture', 'reading the picture…')}</p>`}
                    ${qrRead === 'read' && html`<p class="field-note ok">${t('auth.read-the-spare-key', 'found your spare key in the picture')}</p>`}
                    ${qrRead === 'none' && html`<p class="field-note bad">${t('auth.no-spare-key-in-the-picture', "couldn't find a spare key's QR code in that picture - try a closer, sharper one")}</p>`}
                    <label>
                        ${pin ? t('auth.new-pin', 'new PIN') : t('auth.new-password', 'new password')}
                        <input
                            class="jag-field"
                            type="password"
                            value=${password}
                            onInput=${(e) => setPassword(e.currentTarget.value)}
                            autocomplete="new-password"
                            required
                        />
                    </label>
                    ${
                        needsNewName &&
                        html`<label>
                        ${t('auth.new-sign-in-name', 'new sign-in name')}
                        <input
                            class="jag-field"
                            type="text"
                            value=${newUsername}
                            onInput=${(e) => setNewUsername(e.currentTarget.value)}
                            autocapitalize="off"
                            required
                        />
                    </label>
                    ${
                        newNameAvailability &&
                        html`<p class=${newNameAvailability.ok ? 'field-note ok' : 'field-note bad'}>
                        ${newNameAvailability.note}
                    </p>`
                    }`
                    }
                    ${error && html`<p class="form-error">${error}</p>`}
                    <button class="welcome-go" type="submit" disabled=${busy}>
                        ${busy ? '…' : needsNewName ? t('auth.move-me-in', 'move me in') : t('auth.let-me-back-in', 'let me back in')}
                    </button>
                    <button
                        type="button"
                        class="skip-link"
                        onClick=${() => switchMode('login')}
                    >${t('auth.back-to-signing-in', 'back to signing in')}</button>
                </form>
                </div>
            </div>
        `;
    }

    // Signing in takes a persona's names too (auth.rs `account_for_sign_in`, 2026-10-20); a new
    // account's name is only its own.
    const namePlaceholder = registering
        ? ''
        : t('auth.any-name-of-yours', 'your sign-in name, or a name your persona goes by');
    const tab = (which, icon, label) =>
        html`<button
            key=${which}
            class=${mode === which ? 'tab active' : 'tab'}
            onClick=${() => switchMode(which)}
        ><${icon} /> ${label}</button>`;
    const tabFor = {
        login: () => tab('login', Icons.signIn, t('auth.sign-in', 'sign in')),
        register: () => tab('register', Icons.newHere, t('auth.new-here', 'new here?')),
        import: () => tab('import', Icons.importUser, t('auth.import-user', 'import user')),
        download: () => tab('download', Icons.download, t('auth.download', 'download')),
    };

    return html`
        <div class="welcome">
            <${LinuxNotice} />
            <${Marquee} />

            <${LocalServerNotice} />
            <div class="welcome-box">
            <div class="welcome-tabs">
                ${tabs.map((which) => tabFor[which]())}
            </div>
            ${mode === 'download' && html`<${DownloadPanel} />`}
            ${
                importing &&
                html`<p class="welcome-note">
                ${t(
                    'auth.an-account-here-to-host',
                    'Even if you have a user already on a different node, you need an account on this node to host your user.',
                )}
            </p>`
            }

            ${
                mode !== 'download' &&
                html`<form class="welcome-form" onSubmit=${submit}>
                <label>
                    ${t('auth.name-2', 'name')}
                    <input
                        class="jag-field"
                        type="text"
                        placeholder=${namePlaceholder}
                        value=${username}
                        onInput=${(e) => setUsername(e.currentTarget.value)}
                        autocomplete="username"
                        autocapitalize="off"
                        required
                    />
                </label>
                ${
                    registering &&
                    availability &&
                    html`<p class=${availability.ok ? 'field-note ok' : 'field-note bad'}>
                    ${availability.note}
                </p>`
                }
                <label>
                    ${pin ? t('auth.pin', 'PIN') : t('auth.password', 'password')}
                    <input
                        class="jag-field"
                        type="password"
                        value=${password}
                        onInput=${(e) => setPassword(e.currentTarget.value)}
                        autocomplete=${registering ? 'new-password' : 'current-password'}
                        required
                    />
                </label>

                ${
                    registering &&
                    askSignupPassword &&
                    html`<label>
                    ${t('auth.sign-up-password', 'sign-up password')}
                    <input
                        class="jag-field"
                        type="password"
                        value=${signupPassword}
                        onInput=${(e) => setSignupPassword(e.currentTarget.value)}
                        autocomplete="off"
                        required
                    />
                </label>
                <p class="field-note">${t('auth.whoever-invited-you-has-it', 'whoever invited you has it')}</p>`
                }

                ${error && html`<p class="form-error">${error}</p>`}

                <button class="welcome-go" type="submit" disabled=${busy}>
                    ${busy ? '…' : registering ? t('auth.make-an-account', 'make an account') : t('auth.come-in', 'come in')}
                </button>
                ${
                    !registering &&
                    html`<button
                    type="button"
                    class="skip-link"
                    onClick=${() => switchMode('recover')}
                >${pin ? t('auth.lost-your-pin', 'lost your PIN?') : t('auth.lost-your-password', 'lost your password?')}</button>`
                }
            </form>`
            }
            </div>
        </div>
    `;
};
