// Node login and registration - the bargain-basement front door. Accounts here are
// node-local (username + password on THIS node); identities come later and are a
// separate, grander ceremony. Sessions ride an HttpOnly cookie the server sets, so
// this file never touches a token - net.js's `credentials: 'same-origin'` does all the work.
// The recovery flow reads `err.status` (the 409 re-homing branch), which is why net.js sets it
// on every failure rather than only where someone remembered to.
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { t } from './i18n.js';

const html = htm.bind(h);

// The session, as a hook: `account` is null until whoami answers (or 401s).
// `checking` covers the first paint so we don't flash the login screen at
// someone who is already signed in.
export function useSession() {
    const [account, setAccount] = useState(null);
    const [checking, setChecking] = useState(true);

    useEffect(() => {
        api('/api/auth/whoami')
            .then(setAccount)
            .catch(() => setAccount(null))
            .finally(() => setChecking(false));
    }, []);

    const login = async (username, password) => {
        const acct = await api('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username, password }),
        });
        setAccount(acct);
    };

    // Register does not set the session cookie (it just makes the account), so
    // signing up is register-then-login in one motion.
    const register = async (username, password) => {
        await api('/api/auth/register', {
            method: 'POST',
            body: JSON.stringify({ username, password }),
        });
        await login(username, password);
    };

    const logout = async () => {
        await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
        setAccount(null);
    };

    return { account, checking, login, register, logout };
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
                            : { ok: false, note: 'someone already has that name here' }
                    )
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
export const Welcome = ({ session }) => {
    const [mode, setMode] = useState('login'); // 'login' | 'register' | 'recover'
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [spareKey, setSpareKey] = useState('');
    // Re-homing: revealed only when the server answers 409 ("this key is real, but the
    // account holds siblings") - the proven persona then moves to a fresh account.
    const [needsNewName, setNeedsNewName] = useState(false);
    const [newUsername, setNewUsername] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const registering = mode === 'register';
    const availability = useAvailability(username, registering);
    const newNameAvailability = useAvailability(newUsername, needsNewName);

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
                await session.register(username, password);
            } else {
                await session.login(username, password);
            }
        } catch (err) {
            if (mode === 'recover' && err.status === 409) {
                setNeedsNewName(true);
                setError(err.message);
            } else {
                setError(err.message);
            }
        } finally {
            setBusy(false);
        }
    };

    const switchMode = (next) => {
        setMode(next);
        setError(null);
    };

    if (mode === 'recover') {
        return html`
            <div class="welcome">
                <h1 class="welcome-title">${t('auth.ringtome', 'ringtome')}</h1>
                <p class="welcome-sub">${t('auth.locked-out-your-spare-key', 'locked out? your spare key gets you back in.')}</p>
                <form class="welcome-form" onSubmit=${submit}>
                    <label>
                        ${t('auth.name', 'name')}
                        <input
                            type="text"
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
                            class="spare-paste"
                            rows="3"
                            placeholder=${t('auth.paste-your-spare-key-here', 'paste your spare key here - the whole file is fine')}
                            value=${spareKey}
                            onInput=${(e) => setSpareKey(e.currentTarget.value)}
                            required
                        ></textarea>
                    </label>
                    <label>
                        ${t('auth.new-password', 'new password')}
                        <input
                            type="password"
                            value=${password}
                            onInput=${(e) => setPassword(e.currentTarget.value)}
                            autocomplete="new-password"
                            required
                        />
                    </label>
                    ${needsNewName &&
                    html`<label>
                        ${t('auth.new-sign-in-name', 'new sign-in name')}
                        <input
                            type="text"
                            value=${newUsername}
                            onInput=${(e) => setNewUsername(e.currentTarget.value)}
                            autocapitalize="off"
                            required
                        />
                    </label>
                    ${newNameAvailability &&
                    html`<p class=${newNameAvailability.ok ? 'field-note ok' : 'field-note bad'}>
                        ${newNameAvailability.note}
                    </p>`}`}
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
        `;
    }

    return html`
        <div class="welcome">
            <h1 class="welcome-title">${t('auth.ringtome-2', 'ringtome')}</h1>
            <p class="welcome-sub">${t('auth.a-cozy-corner-of-the', 'a cozy corner of the internet')}</p>

            <div class="welcome-tabs">
                <button
                    class=${mode === 'login' ? 'tab active' : 'tab'}
                    onClick=${() => switchMode('login')}
                >${t('auth.sign-in', 'sign in')}</button>
                <button
                    class=${registering ? 'tab active' : 'tab'}
                    onClick=${() => switchMode('register')}
                >${t('auth.new-here', 'new here?')}</button>
            </div>

            <form class="welcome-form" onSubmit=${submit}>
                <label>
                    ${t('auth.name-2', 'name')}
                    <input
                        type="text"
                        value=${username}
                        onInput=${(e) => setUsername(e.currentTarget.value)}
                        autocomplete="username"
                        autocapitalize="off"
                        required
                    />
                </label>
                ${registering && availability &&
                html`<p class=${availability.ok ? 'field-note ok' : 'field-note bad'}>
                    ${availability.note}
                </p>`}
                <label>
                    ${t('auth.password', 'password')}
                    <input
                        type="password"
                        value=${password}
                        onInput=${(e) => setPassword(e.currentTarget.value)}
                        autocomplete=${registering ? 'new-password' : 'current-password'}
                        required
                    />
                </label>

                ${error && html`<p class="form-error">${error}</p>`}

                <button class="welcome-go" type="submit" disabled=${busy}>
                    ${busy ? '…' : registering ? t('auth.make-an-account', 'make an account') : t('auth.come-in', 'come in')}
                </button>
                ${!registering &&
                html`<button
                    type="button"
                    class="skip-link"
                    onClick=${() => switchMode('recover')}
                >${t('auth.lost-your-password', 'lost your password?')}</button>`}
            </form>
        </div>
    `;
};
