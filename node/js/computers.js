// "Your computers": the persona's key tree in domestic clothing (GLOSSARY, Cozyweb mapping -
// keys render by their device names, never as bare hex; the crown and the spare key render by
// role). Also the granting half of adoption: "invite this computer to be you" - paste the new
// computer's request code, carry the answer back.
import { h } from 'preact';
import { useState, useEffect, useCallback } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { shortcode } from './persona.js';
import { Modal } from './modal.js';
import { Icons } from './icons.js';
import { blastRadius } from './pure/removal.js';

const html = htm.bind(h);

// The key's authority status, in cozy words - and the normal state says NOTHING: "active" is
// the crown's word for not-revoked (an authority fact, not liveness - the spare key is
// "active" in the only sense the tree knows), and rendering it reads to a human as "recently
// seen", which it is not. Only the exceptional states get a word. The removal verbs set the
// vocabulary (GLOSSARY, Cozyweb mapping): "leave"/"have it leave" is the voluntary door,
// "lock out" is the forceful one, and the states read as their past tenses.
function cozyStatus(status) {
    if (status === 'active') return null;
    if (status === 'retired') return 'left';
    if (status === 'repudiated') return 'locked out';
    return status; // an unknown future state shows honestly rather than hiding
}

// Role by tree structure: the root is the crown (the founding computer's working key); the
// all-zeros spine is the spare key. Everything else is an ordinary computer.
function roleOf(key) {
    if (key.rank_path.length === 0) return 'crown';
    if (key.rank_path.every((r) => r === 0)) return 'spare';
    return 'device';
}

function describe(key) {
    const role = roleOf(key);
    if (role === 'spare') return { label: 'the spare key', detail: 'kept somewhere safe, we hope' };
    const name = key.name || `computer ${shortcode(key.pubkey)}`;
    if (role === 'crown') return { label: name, detail: 'your first computer' };
    return { label: name, detail: null };
}

// The removal ceremony. Two doors with deliberately different agency (settled 2026-07-30):
// "leave" is voluntary and gentle - this computer stops being you, everything it wrote stays
// good, computers it invited stay; "lock out" is forceful - for a computer you no longer
// trust, and every computer it invited is shut out with it. Locking out then asks the one
// question that decides the record: was this computer ever you? "Until now" keeps its history;
// "never" strikes everything it ever wrote. The confirmation always echoes the fingerprint,
// never just the name - names are pointers, never authority.
const RemovalFlow = ({ current, target, keys, onDone, onClose }) => {
    const isSelf = target.removal === 'self';
    // 'choose' (senior only) -> 'leave' | 'lockout'; lockout also picks a cut before confirm.
    const [step, setStep] = useState(isSelf ? 'leave' : 'choose');
    const [cut, setCut] = useState(null); // 'now' | 'genesis', lockout only
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const d = describe(target);
    const radius = blastRadius(keys, target.rank_path);

    const revoke = async (disposition, cutChoice) => {
        setBusy(true);
        setError(null);
        try {
            await api(`/api/identity/${current.root}/keys/${target.pubkey}/revoke`, {
                method: 'POST',
                body: JSON.stringify(
                    cutChoice ? { disposition, cut: cutChoice } : { disposition }
                ),
            });
            onDone();
        } catch (e) {
            setError(e.message);
            setBusy(false);
        }
    };

    // Every terminal screen echoes the key itself: the name is how you found the row, the
    // fingerprint is what actually leaves the tree.
    const fingerprint = html`<p class="removal-fact" title=${target.pubkey}>
        this computer's key: ${shortcode(target.pubkey)}
    </p>`;

    const title = isSelf
        ? 'leave this persona'
        : step === 'lockout'
          ? `lock out ${d.label}`
          : `remove ${d.label}`;

    return html`<${Modal} title=${title} onClose=${onClose}>
        ${step === 'choose' &&
        html`<p class="null-sub">How should ${d.label} go?</p>
            <button class="removal-option" onClick=${() => setStep('leave')}>
                <span class="removal-option-title">have this computer leave</span>
                <span class="removal-option-sub">
                    A graceful goodbye. Everything it wrote stays good, and any computers it
                    invited stay too.
                </span>
            </button>
            <button class="removal-option removal-option-forceful" onClick=${() => setStep('lockout')}>
                <span class="removal-option-title">lock this computer out</span>
                <span class="removal-option-sub">
                    For a computer you don't trust anymore. It is shut out - and every computer
                    it invited is shut out with it.
                </span>
            </button>`}
        ${step === 'leave' &&
        html`<p class="null-sub">
                ${isSelf
                    ? `This computer stops being you. Everything it already wrote stays good,
                       your other computers carry on without it - and this one is left out of
                       everything new, for keeps.`
                    : `${d.label} stops being you, gracefully. Everything it wrote stays good,
                       and any computers it invited stay too.`}
            </p>
            ${fingerprint}
            <button class="removal-go" disabled=${busy} onClick=${() => revoke('retirement')}>
                ${busy ? '…' : isSelf ? 'leave this persona' : 'have it leave'}
            </button>`}
        ${step === 'lockout' &&
        html`<p class="null-sub">Was this computer really you?</p>
            <button
                class="removal-option ${cut === 'now' ? 'removal-option-picked' : ''}"
                onClick=${() => setCut('now')}
            >
                <span class="removal-option-title">it was me, until now</span>
                <span class="removal-option-sub">
                    It was mine, but it isn't safe anymore. What it already wrote stands;
                    nothing new gets in.
                </span>
            </button>
            <button
                class="removal-option ${cut === 'genesis' ? 'removal-option-picked' : ''}"
                onClick=${() => setCut('genesis')}
            >
                <span class="removal-option-title">it was never me</span>
                <span class="removal-option-sub">
                    An impostor all along. Everything it ever wrote is struck from the record.
                </span>
            </button>
            ${cut &&
            html`${radius.length > 0 &&
                html`<p class="removal-blast">
                    locked out with it:${' '}
                    ${radius.map((k) => describe(k).label).join(', ')}
                </p>`}
                ${fingerprint}
                <button
                    class="removal-go"
                    disabled=${busy}
                    onClick=${() => revoke('repudiation', cut)}
                >
                    ${busy ? '…' : 'lock it out'}
                </button>`}`}
        ${error && html`<p class="form-error">${error}</p>`}
    <//>`;
};

export const Computers = ({ current }) => {
    const [keys, setKeys] = useState(null);
    const [requestCode, setRequestCode] = useState('');
    const [grantCode, setGrantCode] = useState(null);
    const [delivered, setDelivered] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [removing, setRemoving] = useState(null); // the key whose removal flow is open

    const load = useCallback(
        () =>
            api(`/api/identity/${current.root}/keys`)
                .then((r) => setKeys(r.keys))
                .catch((e) => setError(e.message)),
        [current.root]
    );
    useEffect(() => {
        load();
    }, [load]);

    const invite = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
            const res = await api(`/api/identity/${current.root}/nodes`, {
                method: 'POST',
                body: JSON.stringify({ code: requestCode.trim() }),
            });
            // One-trip: delivered means the grant went over the wire and the new computer has
            // already moved in - no code to carry. Otherwise, fall back to the courier.
            setDelivered(res.delivered);
            setGrantCode(res.delivered ? null : res.code);
            setRequestCode('');
            load(); // the new key is authorized now; show it (named once it syncs back)
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    };

    return html`
        <div class="computers">
            <h2 class="computers-title">your computers</h2>
            ${!keys && !error && html`<p class="null-sub">looking around…</p>`}
            ${keys &&
            html`<ul class="computer-list">
                ${keys.map((k) => {
                    const d = describe(k);
                    // The server sends responsibility order (rank paths); the indent makes the
                    // chain of vouching visible - each computer sits under whoever invited it.
                    const depth = k.rank_path.length;
                    return html`<li
                        class="computer-row"
                        key=${k.pubkey}
                        style="margin-left: ${depth * 0.9}rem"
                    >
                        <span class="computer-name">
                            ${d.label}
                            ${d.detail && html` <span class="computer-detail">— ${d.detail}</span>`}
                        </span>
                        <span class="computer-facts" title=${k.pubkey}>
                            ${cozyStatus(k.status) && html`<span class="computer-status">${cozyStatus(k.status)}${' · '}</span>`}${shortcode(k.pubkey)}
                        </span>
                        ${k.removal &&
                        html`<button
                            class="computer-remove"
                            title=${k.removal === 'self'
                                ? 'leave this persona'
                                : 'remove this computer'}
                            onClick=${() => setRemoving(k)}
                        >
                            <${Icons.trash} />
                        </button>`}
                    </li>`;
                })}
            </ul>`}

            <h3 class="computers-subtitle">invite another computer to be you</h3>
            ${delivered &&
            html`<p class="field-note ok">
                    It moved right in - nothing to carry back. It should be itself over there
                    already.
                </p>
                <button class="skip-link" onClick=${() => setDelivered(false)}>
                    invite another computer
                </button>`}
            ${grantCode
                ? html`<p class="null-sub">
                          Couldn't reach the new computer directly - carry this invite back
                          and paste it there. Keep this computer awake while it moves in.
                      </p>
                      <code class="spare-key">${grantCode}</code>
                      <button class="skip-link" onClick=${() => setGrantCode(null)}>
                          invite a different computer
                      </button>`
                : !delivered &&
                  html`<p class="null-sub">
                          On the new computer, sign in and choose
                          ${' '}<strong>bring your persona from another computer</strong> - it
                          will give you a code to paste here.
                      </p>
                      <form class="welcome-form" onSubmit=${invite}>
                          <textarea
                              class="spare-paste"
                              rows="4"
                              placeholder="paste the new computer's code here"
                              value=${requestCode}
                              onInput=${(e) => setRequestCode(e.currentTarget.value)}
                              required
                          ></textarea>
                          <button class="welcome-go" type="submit" disabled=${busy}>
                              ${busy ? '…' : 'invite this computer to be you'}
                          </button>
                      </form>`}
            ${error && html`<p class="form-error">${error}</p>`}
            ${removing &&
            html`<${RemovalFlow}
                current=${current}
                target=${removing}
                keys=${keys || []}
                onDone=${() => {
                    setRemoving(null);
                    load(); // the tree changed; show the new status
                }}
                onClose=${() => setRemoving(null)}
            />`}
        </div>
    `;
};
