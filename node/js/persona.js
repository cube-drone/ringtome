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
import { identityAddress, viaHints } from './pure/portable.js';
import { isDeparted } from './pure/removal.js';
import { PROFILE_LIMITS, profileChars, overProfileLimit } from './pure/profile.js';
import { speakable, toBase58 } from './speakable.js';
import { Icons } from './icons.js';

const html = htm.bind(h);

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
    // checking | none | ceremony | naming | join | open | farewell
    const [state, setState] = useState('checking');
    const [current, setCurrent] = useState(null); // { root, name }
    const [ceremony, setCeremony] = useState(null); // { root, secret }
    const [naming, setNaming] = useState(null); // root awaiting its display name
    const [join, setJoin] = useState(null); // { requestCode } - the outbound half of adoption
    const [farewell, setFarewell] = useState(null); // { root, standing } - no longer this persona
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
                // Auto-open the first persona this computer is still PART of: sign-in should
                // land you somewhere, not at a menu. A persona whose standing says this
                // computer was locked out (or left) gets the farewell instead - a
                // well-intentioned node discovers its own revocation and lets go, rather
                // than wandering a read-only ghost town (PROJECT_PLAN, Revocation).
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
                setState('none');
            })
            .catch((e) => {
                setError(e.message);
                setState('none');
            });
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
                    // Open FIRST, clear the join state after: `open` is async, and a render
                    // between `setJoin(null)` and its final `setState('open')` is still in
                    // the join state - JoinFlow with a null join crashed the whole render
                    // (field-found 2026-07-30: the new computer showed only the quickbar).
                    await open(personas[0].root_pubkey);
                    setJoin(null);
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
        // Same ordering rule as the arrival watcher above: open, then clear.
        await open(identity.root_pubkey);
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
                    ? 'This computer has been locked out.'
                    : 'This computer has left the persona.'}
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
                The persona itself is fine and lives on its other computers. All that's left
                here is to let it go.
            </p>
            ${error && html`<p class="form-error">${error}</p>`}
            <button class="welcome-go" disabled=${busy} onClick=${letGo}>
                ${busy ? '…' : 'okay - let it go'}
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

    // A transitional render can arrive with the join already cleared (the arrival watcher
    // opening the persona); rendering nothing for a frame beats crashing the whole tree.
    if (!persona.join) return null;

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
                ${over &&
                html`<p class="form-error">
                    <span class="profile-count profile-count-over">
                        ${profileChars(name)}/${PROFILE_LIMITS.name}
                    </span>
                    ${' '}- a name this long won't fit
                </p>`}
                ${error && html`<p class="form-error">${error}</p>`}
                <button class="welcome-go" type="submit" disabled=${busy || over}>
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

// The persona's shareable identity address (PROJECT_PLAN, Addressing): minted from the
// operator's declared public URL (`/api/config`) - or the origin-free path form when there
// isn't one - with `?via=` hints: this node's endpoint key first (`/api/node` - provably
// alive, it served this page), then the persona's liveliest known peers (`/peers`), capped
// by `viaHints`. All fetched once per mount; none change underneath a session.
function useIdentityAddress(root) {
    const [address, setAddress] = useState(null);
    useEffect(() => {
        let live = true;
        Promise.all([
            api('/api/config'),
            api('/api/node'),
            // Peers are gravy: a persona on one computer has none, and a failed fetch
            // must not cost the address row its self-hint.
            api(`/api/identity/${root}/peers`).catch(() => ({ peers: [] })),
        ])
            .then(([config, node, { peers }]) => {
                if (!live) return;
                // The root travels in its speakable form (pure/speakable.js): the checksum
                // words are the human anchor, the base58 tail is the key, and hex stays a
                // valid spelling everywhere addresses are parsed.
                setAddress(
                    identityAddress({
                        publicUrl: config.public_url,
                        root: speakable(root),
                        // Node keys wear base58 in the URL (44 chars against hex's 64) -
                        // ten hints fit where five used to.
                        via: viaHints(node.endpoint_id, peers).map((k) => toBase58(k)),
                    })
                );
            })
            .catch(() => {
                // No address row is better than a wrong one; the menu stands on its own.
            });
        return () => {
            live = false;
        };
    }, [root]);
    return address;
}

// The address row: where this persona lives, ready to hand to someone - and, since the /id
// surface opened, a door. The link IS the displayed address, whole - origin, ?via= hints and
// all (what you see is what you click is what you copy); the /id surface simply ignores the
// query it doesn't need.
// Exported: the id lens page (idpage.js) shows the same row for any hosted persona. The row
// explains nothing - the whole string, a quiet "address" tag, a copy button. The address is
// its own document; the label lost its subtitle on field review (2026-08-01).
export const AddressRow = ({ root }) => {
    const address = useIdentityAddress(root);
    const [copied, setCopied] = useState(false);
    if (!address) return null;
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(address);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            /* clipboard refused (permissions): the text stays selectable by hand */
        }
    };
    return html`
        <div class="persona-address">
            <span class="persona-address-label">address</span>
            <a class="persona-address-value" href=${address} title="see this persona's page">
                <code>${address}</code>
            </a>
            <button class="persona-address-copy" onClick=${copy}>
                ${copied ? 'copied!' : 'copy'}
            </button>
        </div>
    `;
};

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
            <${AddressRow} root=${current.root} />
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

// One profile field as an explicit DRAFT - not a shadow buffer, deliberately: every profile
// save mints a permanent chain record, so nothing here saves on its own. The draft holds
// your typing; `commit` writes it; a mirror echo (a rename on another computer) is adopted
// only while your draft is clean, exactly the shadow contract minus the autosave.
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
    const name = useProfileDraft(root, 'name');
    const bio = useProfileDraft(root, 'bio');
    const [busy, setBusy] = useState(false);
    const [flash, setFlash] = useState(null); // 'saved' | an error message
    const dirty = name.dirty || bio.dirty;
    const over = name.over || bio.over;

    const save = async () => {
        setBusy(true);
        setFlash(null);
        try {
            if (name.dirty) await name.commit();
            if (bio.dirty) await bio.commit();
            setFlash('saved');
            setTimeout(() => setFlash((f) => (f === 'saved' ? null : f)), 1800);
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
    const pickAvatar = async (e) => {
        const file = e.currentTarget.files[0];
        e.currentTarget.value = '';
        if (!file) return;
        setAvatarBusy(true);
        setAvatarErr(null);
        try {
            const form = new FormData();
            form.append('image', file);
            await api(`/api/identity/${root}/avatar`, { method: 'POST', body: form });
        } catch (err) {
            setAvatarErr(err.message);
        }
        setAvatarBusy(false);
    };

    return html`
        <div class="persona-page">
            <div class="persona-page-head">
                <h1 class="persona-page-title">profile</h1>
            </div>
            <div class="profile-avatar-row">
                ${avatarDoc
                    ? html`<img
                          class="profile-avatar"
                          src="/id/${root}/docs/${avatarDoc}/thumb"
                          alt="your avatar"
                      />`
                    : html`<span
                          class="profile-avatar profile-avatar-empty"
                          style="background: hsl(${personaHue(root)}, 60%, 55%)"
                      ></span>`}
                <label class="profile-avatar-pick">
                    ${avatarBusy ? 'working on it…' : avatarDoc ? 'change your picture' : 'add a picture'}
                    <input type="file" accept="image/*" onChange=${pickAvatar} disabled=${avatarBusy} />
                </label>
            </div>
            ${avatarErr && html`<p class="form-error">${avatarErr}</p>`}
            <label class="profile-field">
                <${FieldLabel} label="name" field=${name} />
                <input
                    class="name-input"
                    value=${name.draft}
                    onInput=${(e) => name.setDraft(e.currentTarget.value)}
                    placeholder="what people call you here"
                />
            </label>
            <label class="profile-field">
                <${FieldLabel} label="bio" field=${bio} />
                <textarea
                    class="profile-bio"
                    value=${bio.draft}
                    onInput=${(e) => bio.setDraft(e.currentTarget.value)}
                    rows="12"
                    placeholder="a line or two about you (optional)"
                ></textarea>
            </label>
            <div class="profile-save-row">
                <button
                    class="profile-save"
                    disabled=${!dirty || over || busy}
                    onClick=${save}
                >Save</button>
                <span class=${flash === 'saved' ? 'profile-flash' : 'profile-flash profile-flash-err'}>
                    ${flash === 'saved' ? 'saved - on all your computers in a moment' : flash}
                </span>
            </div>
        </div>
    `;
};
