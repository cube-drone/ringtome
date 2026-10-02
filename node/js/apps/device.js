// The place's own settings: "Device" in the desktop app, "Server" in a browser (Curtis,
// 2026-09-25). Administrators only - the registry hides the tile from everyone else, and the node
// refuses them at every door regardless. Two pages for now:
//
// - Registration (servers only): who may sign up - open, a shared sign-up password, or closed
//   (node/src/registration.rs). A desktop app is its owner's alone, and what it would mean for one
//   to host other people is not settled yet, so the Device app does not offer the page.
// - Backups: make one and watch it go, and see the ones already made - downloaded from a server,
//   shown in the file manager on a desktop, where they are already on this disk
//   (node/src/backup.rs). Restoring is not here yet.
// - Server customization (servers only, 2026-09-30): the front page's name and its marquee's
//   taglines (node/src/frontdoor.rs). A desktop app has no front page for strangers.
//
// The word "node" never appears on these pages: it is the protocol's word, not the person's.
import { h } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api, isDevice } from '../net.js';
import { t } from '../i18n.js';
import { backupTime, sizeLabel } from '../pure/backups.js';
import { appHref } from '../links.js';
import { defaultName, defaultTaglines, refreshFront } from '../frontdoor.js';
import { formatWhen } from '../pure/when.js';
import { BANDS } from '../pure/contact.js';
import { speakable, wordsFor } from '../speakable.js';

const html = htm.bind(h);

/// The pages this app offers here: a desktop app has no Registration page (see above).
// A desktop app's owner has the same sign-up choices a server's has (Curtis, 2026-09-28: every
// desktop app is a localhost multi-user server now).
const pages = () => (isDevice() ? ['registration', 'backups'] : ['registration', 'backups', 'customization']);

/// Each page's name and what it's for, as the landing lists them.
const PAGE_WORDS = () => ({
    registration: [t('device.registration', 'Registration'), t('device.who-may-sign-up-here', 'who may sign up here')],
    backups: [t('device.backups', 'Backups'), t('device.copies-of-everything-to-keep-safe', 'copies of everything here, to keep somewhere safe')],
    customization: [t('device.server-customization', 'Server customization'), t('device.the-front-pages-name-and-taglines', "the front page's name, and the taglines scrolling under it")],
});

export const DeviceApp = ({ page, admin }) => {
    if (!admin) {
        return html`<div class="device">
            <p class="null-sub">${t('device.only-for-the-people-who-look-after-this', 'These settings are only for the people who look after this place.')}</p>
        </div>`;
    }
    if (page === 'registration') return html`<${Registration} />`;
    if (page === 'backups') return html`<${Backups} />`;
    if (page === 'customization' && !isDevice()) return html`<${Customization} />`;
    return html`<${Landing} />`;
};

const Landing = () => html`
    <div class="device">
        <nav class="device-menu">
            ${pages().map(
                (page) => html`<a class="removal-option" href=${`${appHref('device')}/${page}`} key=${page}>
                    <span class="removal-option-title">${PAGE_WORDS()[page][0]}</span>
                    <span class="removal-option-sub">${PAGE_WORDS()[page][1]}</span>
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
    // The mode as picked, saved or not: the group's section shows only while it is `password`
    // (Curtis, 2026-10-02) - a group exists only behind a password.
    const [mode, setMode] = useState(null);
    const load = useCallback(() => {
        api('/api/admin/registration')
            .then((s) => {
                setStatus(s);
                setMode((m) => m || s.mode);
            })
            .catch((e) => setError(e.message));
    }, []);
    useEffect(load, [load]);

    if (!status) {
        return html`<div class="device">${error ? html`<p class="form-error">${error}</p>` : html`<p class="null-sub">${t('device.looking', 'looking…')}</p>`}</div>`;
    }
    return html`
        <div class="device">
            <h2 class="computers-title">${t('device.registration', 'Registration')}</h2>
            <${Policy} status=${status} mode=${mode || status.mode} setMode=${setMode} onSaved=${load} />
            <${Limits} status=${status} mode=${mode || status.mode} onSaved=${load} />
            <${AutoFollowList} status=${status} onSaved=${load} />
        </div>
    `;
};

/// A server's sign-up policy.
const Policy = ({ status, mode, setMode, onSaved }) => {
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
        ${isDevice() &&
        html`<p class="null-sub">${t('device.only-this-computer', 'This app only answers this computer, so "anyone" means anyone who uses it.')}</p>`}
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

/// The limits on sign-ups, and the group (registration.rs, groups.rs; Curtis, 2026-10-02): each
/// empty for none. Saved together - the node keeps them as one.
const Limits = ({ status, mode, onSaved }) => {
    const l = status.limits || {};
    const [maxAccounts, setMaxAccounts] = useState(l.max_accounts == null ? '' : String(l.max_accounts));
    const [diskPct, setDiskPct] = useState(l.disk_max_pct == null ? '' : String(l.disk_max_pct));
    const [group, setGroup] = useState(l.group_name || '');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [saved, setSaved] = useState(false);
    const number = (v) => (v.trim() === '' ? null : Number(v));
    const save = async () => {
        setBusy(true);
        setError('');
        setSaved(false);
        try {
            await api('/api/admin/registration/limits', {
                method: 'PUT',
                body: JSON.stringify({ max_accounts: number(maxAccounts), disk_max_pct: number(diskPct), group_name: group.trim() || null }),
            });
            setSaved(true);
            onSaved();
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };
    // Closed, there are no sign-ups to limit (Curtis, 2026-10-02): the limits wait, kept, for a mode
    // that has some. (The group shows only under `password`, below.)
    return html`
        ${mode !== 'closed' &&
        html`<hr class="device-rule" />
        <h3 class="computers-title">${t('device.limits', 'Limits')}</h3>
        <label class="device-field">
            <span>${t('device.most-accounts', 'the number of accounts that can exist before we stop accepting registrations (currently we have {n} accounts on this server) - leave empty for no limit', { n: status.accounts })}</span>
            <input type="number" min="1" value=${maxAccounts} onInput=${(e) => setMaxAccounts(e.currentTarget.value)} />
        </label>
        <label class="device-field">
            <span>
                ${status.disk_used_pct == null
                    ? t('device.disk-limit-unknown', "stop accepting sign-ups once the disk is fuller than this percentage (we can't read how full it is right now); leave empty for no limit")
                    : t('device.disk-limit', "currently the disk is {pct}% full, stop accepting sign-ups once we've gone past this percentage; leave empty for no limit", { pct: status.disk_used_pct })}
            </span>
            <input type="number" min="1" max="100" value=${diskPct} onInput=${(e) => setDiskPct(e.currentTarget.value)} />
        </label>
        ${/* Each section its own save, though both send the three together (the node keeps them as one). */ ''}
        <button class="removal-go" disabled=${busy} onClick=${save}>${busy ? '…' : t('device.save', 'save')}</button>`}
        ${mode === 'password' &&
        html`<hr class="device-rule" />
        <h3 class="computers-title">${t('device.group', 'Group')}</h3>
        <p class="null-sub">
            ${t(
                'device.group-explained',
                "A group server: whoever signs up with the password joins the group. Their first persona and every other member - and you, and every administrator - begin knowing each other, low trust and low interest, tagged with the group's name. Nobody who was already here is added, and nobody's settings change later."
            )}
        </p>
        <label class="device-field">
            <span>${t('device.group-name', "the group's name - empty for none")}</span>
            <input maxlength="32" value=${group} onInput=${(e) => setGroup(e.currentTarget.value)} />
        </label>
        <button class="removal-go" disabled=${busy} onClick=${save}>${busy ? '…' : t('device.save', 'save')}</button>`}
        ${error && html`<p class="form-error">${error}</p>`}
        ${saved && html`<p class="null-sub">${t('device.saved', 'saved')}</p>`}
    `;
};

/// Whom every persona made here begins knowing (starters.rs, 2026-10-02): an address, and the
/// dials to begin on. Taking somebody off changes nobody who already began with them.
const AutoFollowList = ({ status, onSaved }) => {
    const [address, setAddress] = useState('');
    const [dials, setDials] = useState({ trust: 'low', interest: 'medium', rebroadcasts: 'low' });
    const [error, setError] = useState('');
    const add = async () => {
        setError('');
        try {
            await api('/api/admin/auto-follow', { method: 'POST', body: JSON.stringify({ address, ...dials }) });
            setAddress('');
            onSaved();
        } catch (e) {
            setError(e.message);
        }
    };
    const remove = async (root) => {
        setError('');
        try {
            await api(`/api/admin/auto-follow/${root}`, { method: 'DELETE' });
            onSaved();
        } catch (e) {
            setError(e.message);
        }
    };
    const dialPick = (key, label) => html`<label class="device-field device-dial">
        <span>${label}</span>
        <select value=${dials[key]} onChange=${(e) => setDials({ ...dials, [key]: e.currentTarget.value })}>
            ${BANDS.map((b) => html`<option key=${b} value=${b}>${b}</option>`)}
        </select>
    </label>`;
    const list = status.auto_follow || [];
    return html`
        <hr class="device-rule" />
        <h3 class="computers-title">${t('device.auto-follow', 'Starter Friends')}</h3>
        <p class="null-sub">${t('device.auto-follow-explained', 'Every persona made here starts out knowing these people, with these dials - as if they had set them.')}</p>
        ${list.length > 0 &&
        html`<ul class="device-follows">
            ${list.map(
                (a) => html`<li key=${a.root}>
                    <span class="device-follow-who" title=${speakable(a.root)}>${a.name || wordsFor(a.root).join('-')}</span>
                    <span class="device-follow-dials">${t('device.dials', 'trust {trust} · interest {interest} · shares {rebroadcasts}', a)}</span>
                    <button class="device-follow-x" title=${t('device.take-off-the-list', 'take them off the list')} onClick=${() => remove(a.root)}>×</button>
                </li>`
            )}
        </ul>`}
        <label class="device-field">
            <span>${t('device.their-address', "their address - a page's link, or the address words")}</span>
            <input value=${address} onInput=${(e) => setAddress(e.currentTarget.value)} />
        </label>
        <div class="device-dials">
            ${dialPick('trust', t('device.dial-trust', 'trust'))}
            ${dialPick('interest', t('device.dial-interest', 'interest'))}
            ${dialPick('rebroadcasts', t('device.dial-shares', 'their shares'))}
        </div>
        ${error && html`<p class="form-error">${error}</p>`}
        <button class="removal-go" disabled=${!address.trim()} onClick=${add}>${t('device.add', 'add')}</button>
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
                                  ${when ? formatWhen(when) : a.name}
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

// ---------------------------------------------------------------------------------------------
// Server customization

/// The front page's name and taglines (Curtis, 2026-09-30). Left as the app's own, they stay the
/// app's own - saved as nothing, so they read in each stranger's language and follow later
/// releases; "back to the app's own" forgets whatever was chosen.
const Customization = () => {
    const [loaded, setLoaded] = useState(false);
    const [name, setName] = useState('');
    const [lines, setLines] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [saved, setSaved] = useState(false);
    const ownLines = defaultTaglines().join('\n');
    useEffect(() => {
        api('/api/node/front')
            .then((f) => {
                setName(f.name || '');
                setLines(f.taglines && f.taglines.length ? f.taglines.join('\n') : ownLines);
                setLoaded(true);
            })
            .catch((e) => setError(e.message));
    }, [ownLines]);
    const save = async (body) => {
        setBusy(true);
        setError('');
        setSaved(false);
        try {
            const f = await api('/api/admin/front', { method: 'PUT', body: JSON.stringify(body) });
            setName(f.name || '');
            setLines(f.taglines && f.taglines.length ? f.taglines.join('\n') : ownLines);
            setSaved(true);
            refreshFront();
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };
    if (!loaded) {
        return html`<div class="device">${error ? html`<p class="form-error">${error}</p>` : html`<p class="null-sub">${t('device.looking', 'looking…')}</p>`}</div>`;
    }
    return html`
        <div class="device">
            <h2 class="computers-title">${t('device.server-customization', 'Server customization')}</h2>
            <label class="device-field">
                <span>${t('device.front-page-name', "the front page's name")}</span>
                <input type="text" maxlength="80" value=${name} placeholder=${defaultName()} onInput=${(e) => setName(e.currentTarget.value)} />
            </label>
            <label class="device-field">
                <span>${t('device.taglines-one-per-line', 'taglines, one to a line, scrolling under the sign-in')}</span>
                <textarea class="device-taglines" rows="10" value=${lines} onInput=${(e) => setLines(e.currentTarget.value)}></textarea>
            </label>
            ${error && html`<p class="form-error">${error}</p>`}
            ${saved && html`<p class="null-sub">${t('device.saved', 'saved')}</p>`}
            <div class="device-actions">
                <button
                    class="removal-go"
                    disabled=${busy}
                    onClick=${() => save({ name, taglines: lines.trim() === ownLines.trim() ? null : lines.split('\n') })}
                >${busy ? '…' : t('device.save', 'save')}</button>
                <button class="computer-remove" disabled=${busy} onClick=${() => save({ name: null, taglines: null })}>
                    ${t('device.back-to-the-apps-own', "back to the app's own")}
                </button>
            </div>
        </div>
    `;
};
