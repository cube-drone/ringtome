// Node login and registration - the bargain-basement front door. Accounts here are
// node-local (username + password on THIS node); identities come later and are a
// separate, grander ceremony. Sessions ride an HttpOnly cookie the server sets, so
// this file never touches a token - `credentials: 'same-origin'` does all the work.
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';

const html = htm.bind(h);

// Minimal fetch wrapper: JSON in/out, cookie riding along, server `{message}` surfaced
// as the thrown Error's message so forms can show it verbatim.
async function api(path, options = {}) {
    const res = await fetch(path, {
        credentials: 'same-origin',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        ...options,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(body.message || `request failed (${res.status})`);
    }
    return body;
}

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

// The front door: sign in, or make an account. One component, two moods.
export const Welcome = ({ session }) => {
    const [mode, setMode] = useState('login'); // 'login' | 'register'
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const registering = mode === 'register';
    const availability = useAvailability(username, registering);

    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            if (registering) {
                await session.register(username, password);
            } else {
                await session.login(username, password);
            }
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    };

    const switchMode = (next) => {
        setMode(next);
        setError(null);
    };

    return html`
        <div class="welcome">
            <h1 class="welcome-title">ringtome</h1>
            <p class="welcome-sub">a cozy corner of the internet</p>

            <div class="welcome-tabs">
                <button
                    class=${mode === 'login' ? 'tab active' : 'tab'}
                    onClick=${() => switchMode('login')}
                >sign in</button>
                <button
                    class=${registering ? 'tab active' : 'tab'}
                    onClick=${() => switchMode('register')}
                >new here?</button>
            </div>

            <form class="welcome-form" onSubmit=${submit}>
                <label>
                    name
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
                    password
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
                    ${busy ? '…' : registering ? 'make an account' : 'come in'}
                </button>
            </form>
        </div>
    `;
};
