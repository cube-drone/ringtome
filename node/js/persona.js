// Personas: the "who are you here?" layer, one hop above the account. The account never gets
// a noun (you sign in, that's all); the persona is the single taught concept (GLOSSARY,
// Cozyweb language mapping - "identity" is an engine-room word, banned from the UI).
//
// The flow this file owns: an account with personas auto-opens the first one (adding more is
// an inside-the-house action, later); an account with none gets the null state ("Nobody lives
// here yet") and the create flow - which includes the spare-key moment, because creation
// returns the recovery secret exactly once and we are not allowed to lose it politely.
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';

const html = htm.bind(h);

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

// A deterministic little color chip from the root pubkey - the identicon's humble seed
// (the real root-derived identicon is its own future feature; a persona should never render
// as bare hex in the meantime).
export function personaHue(rootHex) {
    const n = parseInt(rootHex.slice(0, 6), 16);
    return n % 360;
}

export const shortcode = (rootHex) => rootHex.slice(0, 4);

// The persona layer, as a hook. `current` is null while checking, while the account has no
// personas, and during the ceremony; the caller branches on `state`.
export function usePersona(account) {
    const [state, setState] = useState('checking'); // checking | none | ceremony | naming | open
    const [current, setCurrent] = useState(null); // { root, name }
    const [ceremony, setCeremony] = useState(null); // { root, secret }
    const [naming, setNaming] = useState(null); // root awaiting its display name
    const [error, setError] = useState(null);

    // Opening a persona = remembering its root and fetching its public name for display.
    const open = async (root) => {
        let name = '';
        try {
            const profile = await api(`/api/identity/${root}/profile`);
            name = (profile.find((f) => f.field === 'name') || {}).value || '';
        } catch {
            // A persona with no readable profile still opens; it just renders by shortcode.
        }
        setCurrent({ root, name });
        setState('open');
    };

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

    return { state, current, ceremony, error, create, ceremonyDone, setDisplayName };
}

// The null state: a signed-in account with nobody in it yet.
export const NullState = ({ persona }) => {
    const [busy, setBusy] = useState(false);
    const go = async () => {
        setBusy(true);
        try {
            await persona.create();
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
            <button class="welcome-go" disabled=${busy} onClick=${go}>
                ${busy ? '…' : 'create a persona'}
            </button>
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

// The persona badge: chip + name (or shortcode) - a persona never renders as bare hex.
export const PersonaBadge = ({ current }) => html`
    <span class="persona-badge">
        <span
            class="persona-chip"
            style="background: hsl(${personaHue(current.root)}, 60%, 55%)"
        ></span>
        ${current.name || `persona ${shortcode(current.root)}`}
    </span>
`;
