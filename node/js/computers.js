// "Your computers": the persona's key tree in domestic clothing (GLOSSARY, Cozyweb mapping -
// keys render by their device names, never as bare hex; the crown and the spare key render by
// role). Also the granting half of adoption: "invite this computer to be you" - paste the new
// computer's request code, carry the answer back.
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';

import { shortcode } from './persona.js';

const html = htm.bind(h);

async function api(path, options = {}) {
    const res = await fetch(path, {
        credentials: 'same-origin',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        ...options,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(body.message || `request failed (${res.status})`);
        err.status = res.status;
        throw err;
    }
    return body;
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

export const Computers = ({ current }) => {
    const [keys, setKeys] = useState(null);
    const [requestCode, setRequestCode] = useState('');
    const [grantCode, setGrantCode] = useState(null);
    const [delivered, setDelivered] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const load = () =>
        api(`/api/identity/${current.root}/keys`)
            .then((r) => setKeys(r.keys))
            .catch((e) => setError(e.message));
    useEffect(() => {
        load();
    }, [current.root]);

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
                            ${k.status}${' · '}${shortcode(k.pubkey)}
                        </span>
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
        </div>
    `;
};
