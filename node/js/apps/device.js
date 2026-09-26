// The place's own settings: "Device" in the desktop app, "Server" in a browser (Curtis,
// 2026-09-25). Administrators only - the registry hides the tile from everyone else, and the node
// refuses them at every door regardless. Two pages for now:
//
// - Registration: who may sign up - open, a shared sign-up password, or closed. In the desktop
//   app it is also where multi-user mode is switched: the owner's account gets a name and a
//   password of their own, and the app restarts listening on the local network
//   (node/src/registration.rs).
// - Backups: make one and watch it go, and see the ones already made - downloaded from a server,
//   shown in the file manager on a desktop, where they are already on this disk
//   (node/src/backup.rs). Restoring is not here yet.
//
// The word "node" never appears on these pages: it is the protocol's word, not the person's.
import { h } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api, isDevice } from '../net.js';
import { t } from '../i18n.js';
import { backupTime, sizeLabel } from '../pure/backups.js';

const html = htm.bind(h);

const PAGES = ['registration', 'backups'];

export const DeviceApp = ({ page, admin }) => {
    if (!admin) {
        return html`<div class="device">
            <p class="null-sub">${t('device.only-for-the-people-who-look-after-this', 'These settings are only for the people who look after this place.')}</p>
        </div>`;
    }
    if (page === 'registration') return html`<${Registration} />`;
    if (page === 'backups') return html`<${Backups} />`;
    return html`<${Landing} />`;
};

const Landing = () => html`
    <div class="device">
        <nav class="device-menu">
            ${PAGES.map(
                (page) => html`<a class="removal-option" href=${`/home/device/${page}`} key=${page}>
                    <span class="removal-option-title">${page === 'registration' ? t('device.registration', 'Registration') : t('device.backups', 'Backups')}</span>
                    <span class="removal-option-sub">
                        ${page === 'registration'
                            ? isDevice()
                                ? t('device.let-other-people-use-this-computer', 'let other people have accounts here, and choose who may sign up')
                                : t('device.who-may-sign-up-here', 'who may sign up here')
                            : t('device.copies-of-everything-to-keep-safe', 'copies of everything here, to keep somewhere safe')}
                    </span>
                </a>`
            )}
        </nav>
    </div>
`;

// ---------------------------------------------------------------------------------------------
// Registration

const MODE_WORDS = () => ({
    open: [t('device.mode-open', 'open'), t('device.mode-open-sub', 'anyone who can reach this place may sign up')],
    password: [t('device.mode-password', 'password-protected'), t('device.mode-password-sub', 'signing up asks for a password you choose and share')],
    closed: [t('device.mode-closed', 'closed'), t('device.mode-closed-sub', 'nobody new')],
});

/// Pick open / password / closed, and the sign-up password when it is `password`.
const ModePicker = ({ modes, mode, setMode, password, setPassword, hasPassword }) => {
    const words = MODE_WORDS();
    return html`
        <div class="device-modes">
            ${modes.map(
                (m) => html`<button
                    type="button"
                    key=${m}
                    class=${`removal-option ${mode === m ? 'removal-option-picked' : ''}`}
                    onClick=${() => setMode(m)}
                >
                    <span class="removal-option-title">${words[m][0]}</span>
                    <span class="removal-option-sub">${words[m][1]}</span>
                </button>`
            )}
            ${mode === 'password' &&
            html`<label class="device-field">
                <span>${t('device.sign-up-password', 'sign-up password')}</span>
                <input
                    type="password"
                    autocomplete="new-password"
                    value=${password}
                    placeholder=${hasPassword ? t('device.leave-empty-to-keep-the-one-you-set', 'leave empty to keep the one you set') : ''}
                    onInput=${(e) => setPassword(e.currentTarget.value)}
                />
            </label>`}
        </div>
    `;
};

const Registration = () => {
    const [status, setStatus] = useState(null);
    const [error, setError] = useState('');
    const load = useCallback(() => {
        api('/api/admin/registration')
            .then(setStatus)
            .catch((e) => setError(e.message));
    }, []);
    useEffect(load, [load]);

    if (!status) {
        return html`<div class="device">${error ? html`<p class="form-error">${error}</p>` : html`<p class="null-sub">${t('device.looking', 'looking…')}</p>`}</div>`;
    }
    return html`
        <div class="device">
            <h2 class="computers-title">${t('device.registration', 'Registration')}</h2>
            ${status.device && !status.listening
                ? html`<${MultiUserOn} status=${status} />`
                : html`
                      ${status.device && html`<${MultiUserIsOn} status=${status} />`}
                      <${Policy} status=${status} onSaved=${load} />
                  `}
        </div>
    `;
};

/// A server's (or an opened-up desktop app's) sign-up policy.
const Policy = ({ status, onSaved }) => {
    const [mode, setMode] = useState(status.mode);
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [saved, setSaved] = useState(false);
    const save = async () => {
        setBusy(true);
        setError('');
        setSaved(false);
        try {
            await api('/api/admin/registration', { method: 'PUT', body: JSON.stringify({ mode, password: password || null }) });
            setPassword('');
            setSaved(true);
            onSaved();
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };
    return html`
        <p class="null-sub">${t('device.who-may-make-an-account-here', 'Who may make an account here:')}</p>
        <${ModePicker}
            modes=${['open', 'password', 'closed']}
            mode=${mode}
            setMode=${setMode}
            password=${password}
            setPassword=${setPassword}
            hasPassword=${status.has_password}
        />
        ${error && html`<p class="form-error">${error}</p>`}
        ${saved && html`<p class="null-sub">${t('device.saved', 'saved')}</p>`}
        <button class="removal-go" disabled=${busy} onClick=${save}>${busy ? '…' : t('device.save', 'save')}</button>
    `;
};

/// The desktop app, still only its owner's: the switch into hosting other people.
const MultiUserOn = ({ status }) => {
    const [username, setUsername] = useState(status.username === 'me' ? '' : status.username);
    const [password, setPassword] = useState('');
    const [again, setAgain] = useState('');
    const [mode, setMode] = useState('password');
    const [signupPassword, setSignupPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [restarting, setRestarting] = useState(false);
    const go = async () => {
        if (password !== again) {
            setError(t('device.the-two-passwords-dont-match', "the two passwords don't match"));
            return;
        }
        setBusy(true);
        setError('');
        try {
            await api('/api/admin/device/multi-user', {
                method: 'POST',
                body: JSON.stringify({ username, password, mode, registration_password: signupPassword || null }),
            });
            setRestarting(true);
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };
    if (restarting) {
        return html`<p class="null-sub">${t('device.restarting-to-open-up', 'Restarting to let your network in…')}</p>`;
    }
    return html`
        <p class="null-sub">
            ${t('device.only-you-use-this', 'Right now only you, on this computer, use Horse Drawing Tycoon 2 here. Multi-user mode lets other people on your network have accounts on this computer too - and lets you sign in to yours from their devices.')}
        </p>
        <p class="null-sub">
            ${t('device.your-account-gets-a-name', 'Your account gets a sign-in name and a password, since other people can reach the sign-in screen from now on:')}
        </p>
        <label class="device-field">
            <span>${t('device.your-sign-in-name', 'your sign-in name')}</span>
            <input autocomplete="username" value=${username} onInput=${(e) => setUsername(e.currentTarget.value)} />
        </label>
        <label class="device-field">
            <span>${t('device.your-password', 'your password')}</span>
            <input type="password" autocomplete="new-password" value=${password} onInput=${(e) => setPassword(e.currentTarget.value)} />
        </label>
        <label class="device-field">
            <span>${t('device.your-password-again', 'your password, again')}</span>
            <input type="password" autocomplete="new-password" value=${again} onInput=${(e) => setAgain(e.currentTarget.value)} />
        </label>
        <p class="null-sub">${t('device.who-else-may-sign-up', 'Who else may make an account:')}</p>
        <${ModePicker}
            modes=${['password', 'open']}
            mode=${mode}
            setMode=${setMode}
            password=${signupPassword}
            setPassword=${setSignupPassword}
            hasPassword=${status.has_password}
        />
        <p class="device-warning">
            ${t('device.the-network-can-reach-this-computer', "Your network will be able to reach this computer, and the connection between them isn't encrypted - so turn this on at home, not on a café's wifi.")}
        </p>
        ${error && html`<p class="form-error">${error}</p>`}
        <button class="removal-go" disabled=${busy} onClick=${go}>
            ${busy ? '…' : t('device.turn-on-multi-user-mode', 'turn on multi-user mode and restart')}
        </button>
    `;
};

/// The desktop app, opened up: where people reach it, and the way back.
const MultiUserIsOn = ({ status }) => {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [restarting, setRestarting] = useState(false);
    const off = async () => {
        if (!confirm(t('device.turn-multi-user-mode-off-confirm', "Turn multi-user mode off? Nobody new can sign up, and only this computer can reach it after a restart. Accounts people already made stay, but they can't reach them from their own devices."))) return;
        setBusy(true);
        setError('');
        try {
            await api('/api/admin/device/multi-user', { method: 'DELETE' });
            setRestarting(true);
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };
    if (restarting) {
        return html`<p class="null-sub">${t('device.restarting-to-close-up', 'Restarting for this computer only…')}</p>`;
    }
    return html`
        <p class="null-sub">${t('device.multi-user-mode-is-on', 'Multi-user mode is on. People on your network reach this computer at:')}</p>
        ${status.addresses.length
            ? html`<ul class="device-addresses">${status.addresses.map((a) => html`<li key=${a}><code>${a}</code></li>`)}</ul>`
            : html`<p class="null-sub">${t('device.no-network-right-now', "(no network connection right now)")}</p>`}
        ${error && html`<p class="form-error">${error}</p>`}
        <button class="removal-option" disabled=${busy} onClick=${off}>
            <span class="removal-option-title">${t('device.turn-multi-user-mode-off', 'turn multi-user mode off')}</span>
        </button>
    `;
};

// ---------------------------------------------------------------------------------------------
// Backups

const Backups = () => {
    const [archives, setArchives] = useState(null);
    const [ticket, setTicket] = useState(null);
    const [error, setError] = useState('');
    const refresh = useCallback(() => {
        api('/api/admin/backups')
            .then(setArchives)
            .catch((e) => setError(e.message));
    }, []);
    useEffect(refresh, [refresh]);

    // A running backup reports through its ticket; this polls it until it settles.
    useEffect(() => {
        if (!ticket || ticket.status !== 'running') return undefined;
        const timer = setTimeout(() => {
            api(`/api/admin/backup/${ticket.id}`)
                .then((next) => {
                    setTicket(next);
                    if (next.status === 'done') refresh();
                })
                .catch((e) => {
                    // A failed backup answers 500 with its ticket; anything else is a lost thread.
                    setTicket({ ...ticket, status: 'failed', log: [...(ticket.log || []), e.message] });
                });
        }, 1000);
        return () => clearTimeout(timer);
    }, [ticket, refresh]);

    const start = async () => {
        setError('');
        try {
            setTicket(await api('/api/admin/backup', { method: 'POST' }));
        } catch (e) {
            setError(e.message);
        }
    };
    const reveal = async (name) => {
        try {
            await api(`/api/admin/backups/${name}/reveal`, { method: 'POST' });
        } catch (e) {
            setError(e.message);
        }
    };
    const running = ticket && ticket.status === 'running';
    const finished = ticket && ticket.status === 'done';
    const failed = ticket && ticket.status === 'failed';
    return html`
        <div class="device">
            <h2 class="computers-title">${t('device.backups', 'Backups')}</h2>
            <p class="null-sub">
                ${t('device.a-backup-holds-everything', 'A backup is a copy of everything here - every account, and the keys that unlock them. Whoever has one has all of it, so keep it as safe as this place itself.')}
            </p>
            <button class="removal-go" disabled=${running} onClick=${start}>
                ${running ? t('device.backing-up', 'backing up…') : t('device.make-a-backup-now', 'make a backup now')}
            </button>
            ${ticket &&
            html`<div class="device-ticket">
                <p class="null-sub">
                    ${finished
                        ? t('device.backup-done', 'done')
                        : failed
                        ? t('device.backup-failed', 'the backup failed')
                        : t('device.backup-running', 'working…')}
                </p>
                <ol class="device-log">${(ticket.log || []).map((line, i) => html`<li key=${i}>${line}</li>`)}</ol>
            </div>`}
            ${error && html`<p class="form-error">${error}</p>`}
            <h3 class="computers-subtitle">${t('device.backups-made', 'made so far')}</h3>
            ${!archives
                ? html`<p class="null-sub">${t('device.looking', 'looking…')}</p>`
                : archives.length === 0
                ? html`<p class="null-sub">${t('device.no-backups-yet', 'none yet')}</p>`
                : html`<ul class="computer-list">
                      ${archives.map((a) => {
                          const when = backupTime(a.name);
                          return html`<li class="computer-row" key=${a.name}>
                              <span class="computer-name">
                                  ${when ? new Date(when).toLocaleString() : a.name}
                                  <span class="computer-detail"> — ${sizeLabel(a.bytes)}</span>
                              </span>
                              ${isDevice()
                                  ? html`<button class="computer-remove" onClick=${() => reveal(a.name)}>${t('device.show-in-folder', 'show in folder')}</button>`
                                  : html`<a class="computer-remove" href=${`/api/admin/backups/${a.name}`} download=${a.name}>${t('device.download', 'download')}</a>`}
                          </li>`;
                      })}
                  </ul>`}
            <p class="null-sub">${t('device.restoring-is-not-here-yet', "Restoring from a backup isn't here yet.")}</p>
        </div>
    `;
};
