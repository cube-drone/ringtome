// "delete me" (Curtis, 2026-11-01): at the bottom of hrseSettings, the way to delete a persona or
// the whole account from this server (node/src/leaving.rs). Each says, before anything happens,
// that deleting yourself here can't take you off the network - what you published, and what
// your other computers and other people already hold, stays theirs. A persona deleted here is
// this computer retiring from it; one that lives on other computers carries on there and can come
// back here by adoption, and one that lives nowhere else is said to have nothing to come back
// from. Both ask for the password again.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { forgetMirror } from './mirror.js';
import { Modal } from './modal.js';
import { Icons } from './icons.js';
import { shortcode } from './pure/person.js';
import { t } from './i18n.js';

const html = htm.bind(h);

/// The menu row, and the modal it opens.
export const DeleteMe = ({ persona, session }) => {
    const [open, setOpen] = useState(false);
    return html`
        <button class="persona-menu-item persona-menu-danger" onClick=${() => setOpen(true)}>
            <span class="persona-menu-icon"><${Icons.trash} /></span>
            <span class="persona-menu-label">
                <strong>${t('deleteme.delete-me', 'delete me')}</strong>
                <small>${t('deleteme.a-persona-or-the-whole-account', 'a persona, or your whole account, from this server')}</small>
            </span>
        </button>
        ${open && html`<${DeleteMeFlow} persona=${persona} session=${session} onClose=${() => setOpen(false)} />`}
    `;
};

const DeleteMeFlow = ({ persona, session, onClose }) => {
    const [step, setStep] = useState('choose'); // 'choose' | 'persona' | 'account'
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [others, setOthers] = useState(null); // the persona's other computers, once asked
    const current = persona.current;
    const root = current && current.root;
    // Unnamed, a persona goes by its shortcode, as it does everywhere else.
    const name = (current && current.name) || (root ? shortcode(root) : '');

    useEffect(() => {
        if (step !== 'persona' || !root) return;
        api(`/api/identity/${root}/leaving`)
            .then((r) => setOthers(r.other_computers))
            .catch(() => setOthers(null));
    }, [step, root]);

    const deletePersona = async () => {
        setBusy(true);
        setError(null);
        try {
            await api(`/api/identity/${root}/delete`, {
                method: 'POST',
                body: JSON.stringify({ password }),
            });
            onClose();
            await persona.deleted(root);
        } catch (e) {
            setError(e.message);
            setBusy(false);
        }
    };

    const deleteAccount = async () => {
        setBusy(true);
        setError(null);
        try {
            const done = await api('/api/auth/delete-account', {
                method: 'POST',
                body: JSON.stringify({ password }),
            });
            onClose();
            await persona.shutdown();
            await Promise.all((done.personas || []).map((root) => forgetMirror(root)));
            session.logout();
        } catch (e) {
            setError(e.message);
            setBusy(false);
        }
    };

    const network = html`<p class="removal-blast">
        ${t(
            'deleteme.cant-remove-you-from-the-network',
            "Deleting yourself from this server can't remove you from the network: what you published, and what your other computers and the people you know already hold, stays where it is.",
        )}
    </p>`;

    const passwordAndGo = (label, go) => html`
        <label class="deleteme-password">
            ${t('deleteme.your-password', 'your password, to be sure it’s you')}
            <input
                class="jag-field"
                type="password"
                value=${password}
                onInput=${(e) => setPassword(e.currentTarget.value)}
                autocomplete="current-password"
            />
        </label>
        ${error && html`<p class="form-error">${error}</p>`}
        <button class="removal-go" disabled=${busy || !password} onClick=${go}>${busy ? '…' : label}</button>
    `;

    return html`<${Modal} title=${t('deleteme.delete-me', 'delete me')} onClose=${onClose}>
        ${
            step === 'choose' &&
            html`${network}
            ${
                current &&
                html`<button class="removal-option removal-option-forceful" onClick=${() => setStep('persona')}>
                <span class="removal-option-title">${t('deleteme.delete-name', 'delete {name}', { name })}</span>
                <span class="removal-option-sub">
                    ${t('deleteme.this-persona-leaves-this-server', 'This persona leaves this server: its key here retires, and your account lets go of it. Your other personas stay.')}
                </span>
            </button>`
            }
            <button class="removal-option removal-option-forceful" onClick=${() => setStep('account')}>
                <span class="removal-option-title">${t('deleteme.delete-your-entire-account', 'delete your entire account')}</span>
                <span class="removal-option-sub">
                    ${t('deleteme.every-persona-then-the-account', 'Every persona on it leaves this server, then the account itself goes - its name, its password, its sign-in.')}
                </span>
            </button>`
        }
        ${
            step === 'persona' &&
            html`<p class="null-sub">
                ${t('deleteme.name-leaves-this-server', '{name} leaves this server. Its key here retires for good - everything it already wrote stays good - and your account lets go of it.', { name })}
            </p>
            ${
                others === 0
                    ? html`<p class="removal-blast">
                    ${t('deleteme.only-computer', 'This server is the only computer {name} lives on. Once it’s deleted here there is nothing to bring it back from - only the copies other people already hold.', { name })}
                </p>`
                    : others > 0 &&
                      html`<p class="null-sub">
                    ${t('deleteme.other-computers-keep-it', 'Your other computers keep {name}, and it carries on there. It can come back to this server later: bring it here from one of them, as you would to any new computer.', { name })}
                </p>`
            }
            ${network}
            ${passwordAndGo(t('deleteme.delete-name', 'delete {name}', { name }), deletePersona)}`
        }
        ${
            step === 'account' &&
            html`<p class="null-sub">
                ${t('deleteme.every-persona-leaves', 'Every persona on your account leaves this server, each one’s key here retired, and then the account goes: you’re signed out, and your sign-in name is free for anyone. A persona that lives on your other computers carries on there.')}
            </p>
            ${network}
            ${passwordAndGo(t('deleteme.delete-my-account', 'delete my account'), deleteAccount)}`
        }
    </${Modal}>`;
};
