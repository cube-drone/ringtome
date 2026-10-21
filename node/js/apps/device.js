// The place's own settings: "Device" in the desktop app, "Server" in a browser (Curtis,
// 2026-09-25). Everyone's since 2026-10-17 (plans/NETWORK.md, ruling 5), page by page: a regular
// user sees the Network page alone; administrators every page, and the node refuses anyone else at
// every admin door regardless.
//
// - Network (everyone): every machine this place talks to, by name, how reliably each answers,
//   and the viewer's own links to them. An administrator renames this machine there.
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
import { AccountPage } from '../account.js';
import { Icons } from '../icons.js';
import { t } from '../i18n.js';
import { backupTime, sizeLabel } from '../pure/backups.js';
import { appHref, groupHref, personHref } from '../links.js';
import { defaultName, defaultTaglines, refreshFront } from '../frontdoor.js';
import { formatWhen } from '../pure/when.js';
import { BANDS } from '../pure/contact.js';
import { speakable, wordsFor } from '../speakable.js';
import { agoUnit, agoWords } from '../pure/ago.js';
import { machineLabel, machineStatus, machinesShown, reliabilityPct } from '../pure/machines.js';

const html = htm.bind(h);

/// The pages this app offers this person: the Network page to everyone, and the rest to an
/// administrator. A desktop app has no front page for strangers, so no Customization there. (A
/// desktop app's owner has the same sign-up choices a server's has - Curtis, 2026-09-28: every
/// desktop app is a localhost multi-user server now.)
const pages = (admin) =>
    !admin
        ? ['network']
        : isDevice()
          ? ['network', 'registration', 'backups']
          : ['network', 'registration', 'backups', 'customization'];

/// Each page's name and what it's for, as the landing lists them.
const PAGE_WORDS = () => ({
    network: [
        t('device.network', 'Network'),
        t(
            'device.the-machines-this-place-talks-to',
            'the machines this place talks to, and how well each answers',
        ),
    ],
    registration: [
        t('device.registration', 'Registration'),
        t('device.who-may-sign-up-here', 'who may sign up here'),
    ],
    backups: [
        t('device.backups', 'Backups'),
        t(
            'device.copies-of-everything-to-keep-safe',
            'copies of everything here, to keep somewhere safe',
        ),
    ],
    customization: [
        t('device.server-customization', 'Server customization'),
        t(
            'device.the-front-pages-name-and-taglines',
            "the front page's name, and the taglines scrolling under it",
        ),
    ],
});

export const DeviceApp = ({ page, account, admin, current }) => {
    // Someone who isn't an administrator has one page, so they land on it.
    if (page === 'network' || (!admin && !page)) {
        return html`<${Network} current=${current} admin=${admin} />`;
    }
    if (!admin) {
        return html`<div class="device">
            <p class="null-sub">${t('device.only-for-the-people-who-look-after-this', 'These settings are only for the people who look after this place.')}</p>
        </div>`;
    }
    if (page === 'registration') return html`<${Registration} />`;
    if (page === 'backups') return html`<${Backups} />`;
    if (page === 'account' && account)
        return html`<${AccountPage} id=${account} current=${current} />`;
    if (page === 'customization' && !isDevice()) return html`<${Customization} />`;
    return html`<${Landing} admin=${admin} />`;
};

const Landing = ({ admin }) => html`
    <div class="device">
        <nav class="device-menu">
            ${pages(admin).map(
                (
                    page,
                ) => html`<a class="removal-option" href=${`${appHref('device')}/${page}`} key=${page}>
                    <span class="removal-option-title">${PAGE_WORDS()[page][0]}</span>
                    <span class="removal-option-sub">${PAGE_WORDS()[page][1]}</span>
                </a>`,
            )}
        </nav>
    </div>
`;

// ---------------------------------------------------------------------------------------------
// Registration

const MODE_WORDS = () => ({
    open: [
        t('device.mode-open', 'open'),
        t('device.mode-open-sub', 'anyone who can reach this place may sign up'),
    ],
    password: [
        t('device.mode-password', 'password-protected'),
        t('device.mode-password-sub', 'signing up asks for a password you choose and share'),
    ],
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
                </button>`,
            )}
            ${
                mode === 'password' &&
                html`<label class="device-field">
                <span>${t('device.sign-up-password', 'sign-up password')}</span>
                <input
                    type="password"
                    autocomplete="new-password"
                    value=${password}
                    placeholder=${hasPassword ? t('device.leave-empty-to-keep-the-one-you-set', 'leave empty to keep the one you set') : ''}
                    onInput=${(e) => setPassword(e.currentTarget.value)}
                />
            </label>`
            }
        </div>
    `;
};

const Registration = () => {
    const [status, setStatus] = useState(null);
    const [error, setError] = useState('');
    // The mode as picked, saved or not: the limits and the sign-up group wait while it is `closed`.
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
            <${SignupGroup} status=${status} mode=${mode || status.mode} onSaved=${load} />
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
            await api('/api/admin/registration', {
                method: 'PUT',
                body: JSON.stringify({ mode, password: password || null }),
            });
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
        ${
            isDevice() &&
            html`<p class="null-sub">${t('device.only-this-computer', 'This app only answers this computer, so "anyone" means anyone who uses it.')}</p>`
        }
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

/// The limits on sign-ups (registration.rs; Curtis, 2026-10-02): each empty for none. Saved
/// together - the node keeps them as one.
const Limits = ({ status, mode, onSaved }) => {
    const l = status.limits || {};
    const [maxAccounts, setMaxAccounts] = useState(
        l.max_accounts == null ? '' : String(l.max_accounts),
    );
    const [diskPct, setDiskPct] = useState(l.disk_max_pct == null ? '' : String(l.disk_max_pct));
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
                body: JSON.stringify({
                    max_accounts: number(maxAccounts),
                    disk_max_pct: number(diskPct),
                }),
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
    // that has some.
    return html`
        ${
            mode !== 'closed' &&
            html`<hr class="device-rule" />
        <h3 class="computers-title">${t('device.limits', 'Limits')}</h3>
        <label class="device-field">
            <span>${t('device.most-accounts', 'the number of accounts that can exist before we stop accepting registrations (currently we have {n} accounts on this server) - leave empty for no limit', { n: status.accounts })}</span>
            <input type="number" min="1" value=${maxAccounts} onInput=${(e) => setMaxAccounts(e.currentTarget.value)} />
        </label>
        <label class="device-field">
            <span>
                ${
                    status.disk_used_pct == null
                        ? t(
                              'device.disk-limit-unknown',
                              "stop accepting sign-ups once the disk is fuller than this percentage (we can't read how full it is right now); leave empty for no limit",
                          )
                        : t(
                              'device.disk-limit',
                              "currently the disk is {pct}% full, stop accepting sign-ups once we've gone past this percentage; leave empty for no limit",
                              { pct: status.disk_used_pct },
                          )
                }
            </span>
            <input type="number" min="1" max="100" value=${diskPct} onInput=${(e) => setDiskPct(e.currentTarget.value)} />
        </label>
        <button class="removal-go" disabled=${busy} onClick=${save}>${busy ? '…' : t('device.save', 'save')}</button>`
        }
        ${error && html`<p class="form-error">${error}</p>`}
        ${saved && html`<p class="null-sub">${t('device.saved', 'saved')}</p>`}
    `;
};

/// The sign-up group (groups.rs; Curtis, 2026-10-20): a real group every persona made here joins,
/// chosen among the groups this administrator's own personas own - that owner's key invites each
/// newcomer, and the sign-up form names the group first. Replaces the old "group server" name.
const SignupGroup = ({ status, mode, onSaved }) => {
    const current = status.signup_group;
    const choices = [...(status.signup_group_choices || [])];
    const key = (c) => `${c.group}:${c.owner}`;
    // Chosen by another administrator, it isn't among this one's own: listed anyway, to keep.
    if (current && !choices.some((c) => key(c) === key(current))) choices.unshift(current);
    const [pick, setPick] = useState(current ? key(current) : '');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [saved, setSaved] = useState(false);
    if (mode === 'closed') return null;
    const save = async () => {
        setBusy(true);
        setError('');
        setSaved(false);
        const [group, owner] = pick ? pick.split(':') : [null, null];
        try {
            await api('/api/admin/registration/group', {
                method: 'PUT',
                body: JSON.stringify({ group, owner }),
            });
            setSaved(true);
            onSaved();
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };
    const ownerName = (c) => c.owner_name || speakable(c.owner).split('-').slice(0, 2).join('-');
    const label = (c) =>
        c.public
            ? t('device.signup-group-public', '{name} (public), invited by {owner}', {
                  name: c.name,
                  owner: ownerName(c),
              })
            : t('device.signup-group-private', '{name} (private), invited by {owner}', {
                  name: c.name,
                  owner: ownerName(c),
              });
    const picked = choices.find((c) => key(c) === pick);
    // A private group behind open sign-ups: anyone who signs up joins and reads its roster.
    const strangersSeeIt = picked && !picked.public && mode === 'open';
    return html`<hr class="device-rule" />
        <h3 class="computers-title">${t('device.signup-group', 'Sign-up group')}</h3>
        <p class="null-sub">
            ${t(
                'device.signup-group-explained',
                "Every persona made on this server joins this group - the sign-up page tells people so before they sign up. Choose one of the groups your personas own: that persona sends each newcomer's invite, and they're in. Anyone can leave it later, like any group. Nobody already here is added.",
            )}
        </p>
        ${
            choices.length === 0
                ? html`<p class="null-sub">
                      ${t('device.signup-group-none-owned', "None of your personas owns a group yet. Found one in hrseNeighbors™'s Groups tab, then come back to choose it.")}
                  </p>`
                : html`<label class="device-field">
                      <span>${t('device.signup-group-which', 'the group new personas join')}</span>
                      <select value=${pick} onChange=${(e) => setPick(e.currentTarget.value)}>
                          <option value="">${t('device.signup-group-no-group', 'no group')}</option>
                          ${choices.map((c) => html`<option key=${key(c)} value=${key(c)}>${label(c)}</option>`)}
                      </select>
                  </label>`
        }
        ${
            current &&
            !current.owner_owns &&
            html`<p class="form-error">
                ${t('device.signup-group-owner-gone', '{owner} no longer owns {name}, so nobody new is joining it. Choose another of its owners, or another group.', { owner: ownerName(current), name: current.name })}
            </p>`
        }
        ${
            strangersSeeIt &&
            html`<p class="null-sub">
                ${t('device.signup-group-open-private', "Sign-ups here are open, so anyone who signs up joins this private group and can see who's in it.")}
            </p>`
        }
        ${error && html`<p class="form-error">${error}</p>`}
        ${saved && html`<p class="null-sub">${t('device.saved', 'saved')}</p>`}
        ${choices.length > 0 && html`<button class="removal-go" disabled=${busy} onClick=${save}>${busy ? '…' : t('device.save', 'save')}</button>`}`;
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
            await api('/api/admin/auto-follow', {
                method: 'POST',
                body: JSON.stringify({ address, ...dials }),
            });
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
        ${
            list.length > 0 &&
            html`<ul class="device-follows">
            ${list.map(
                (a) => html`<li key=${a.root}>
                    <span class="device-follow-who" title=${speakable(a.root)}>${a.name || wordsFor(a.root).join('-')}</span>
                    <span class="device-follow-dials">${t('device.dials', 'trust {trust} · interest {interest} · shares {rebroadcasts}', a)}</span>
                    <button class="device-follow-x" title=${t('device.take-off-the-list', 'take them off the list')} onClick=${() => remove(a.root)}>×</button>
                </li>`,
            )}
        </ul>`
        }
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

/// Whether people here may import a persona's zip (import.rs, plans/EXPORT.md): off on a server
/// until its administrator says - Curtis, 2026-10-09: the way is out of servers, to people's own
/// computers - and always on in the desktop app, which doesn't ask.
const ImportPolicy = () => {
    const [allowed, setAllowed] = useState(null);
    const [error, setError] = useState('');
    useEffect(() => {
        api('/api/admin/import-policy')
            .then((r) => setAllowed(r.allowed))
            .catch((e) => setError(e.message));
    }, []);
    const change = async (on) => {
        setError('');
        try {
            setAllowed(
                (
                    await api('/api/admin/import-policy', {
                        method: 'PUT',
                        body: JSON.stringify({ allowed: on }),
                    })
                ).allowed,
            );
        } catch (e) {
            setError(e.message);
        }
    };
    if (allowed === null) return error ? html`<p class="form-error">${error}</p>` : null;
    return html`<label class="profile-setting">
            <input type="checkbox" checked=${allowed} onChange=${(e) => change(e.currentTarget.checked)} />
            ${t('device.allow-imports', 'allow users to import')}
        </label>
        <p class="null-sub">
            ${t('device.allow-imports-why', "An import brings a whole persona's zip onto this server - every note and picture, and the work of reading them in. Leave it off and people can still export from here to a computer of their own, which is the way things should flow.")}
        </p>
        ${error && html`<p class="form-error">${error}</p>`}`;
};

/// Whether search engines are welcome on this server (plans/CRAWLING.md, ruling 2): yes until its
/// administrator says no. Only on a server with a public URL - anywhere else, nothing is indexed.
const SearchPolicy = () => {
    const [policy, setPolicy] = useState(null);
    const [error, setError] = useState('');
    useEffect(() => {
        api('/api/admin/search-policy')
            .then(setPolicy)
            .catch((e) => setError(e.message));
    }, []);
    const change = async (on) => {
        setError('');
        try {
            const r = await api('/api/admin/search-policy', {
                method: 'PUT',
                body: JSON.stringify({ indexed: on }),
            });
            setPolicy((p) => ({ ...p, indexed: r.indexed }));
        } catch (e) {
            setError(e.message);
        }
    };
    if (!policy) return error ? html`<p class="form-error">${error}</p>` : null;
    if (!policy.public) return null;
    return html`<label class="profile-setting">
            <input type="checkbox" checked=${policy.indexed} onChange=${(e) => change(e.currentTarget.checked)} />
            ${t('device.let-search-engines-in', 'let search engines index this server')}
        </label>
        <p class="null-sub">
            ${t('device.search-engines-why', 'Off, every page asks search engines to stay away, and the sitemap is empty. Each person can also keep themselves out, in their own settings.')}
        </p>
        ${error && html`<p class="form-error">${error}</p>`}`;
};

/// Whether this server publishes songs that name their artist or album (plans/AUDIO.md, section 8,
/// ruling 17 - the fence): yes until its administrator says no. Off, a post carrying one is refused
/// at publish, for everyone here, agents included.
const AudioPolicy = () => {
    const [policy, setPolicy] = useState(null);
    const [error, setError] = useState('');
    useEffect(() => {
        api('/api/admin/audio-policy')
            .then(setPolicy)
            .catch((e) => setError(e.message));
    }, []);
    const change = async (on) => {
        setError('');
        try {
            const r = await api('/api/admin/audio-policy', {
                method: 'PUT',
                body: JSON.stringify({ tagged: on }),
            });
            setPolicy({ tagged: r.tagged });
        } catch (e) {
            setError(e.message);
        }
    };
    if (!policy) return error ? html`<p class="form-error">${error}</p>` : null;
    return html`<label class="profile-setting">
            <input type="checkbox" checked=${policy.tagged} onChange=${(e) => change(e.currentTarget.checked)} />
            ${t('device.publish-tagged-audio', 'publish songs that name their artist or album')}
        </label>
        <p class="null-sub">
            ${t('device.tagged-audio-why', "Off, nobody on this server can publish a song whose artist or album is set - their own, or someone else's copied into a post. A song without them still goes out: this is your word on what you'll host, not a detector.")}
        </p>
        ${error && html`<p class="form-error">${error}</p>`}`;
};

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
                    setTicket({
                        ...ticket,
                        status: 'failed',
                        log: [...(ticket.log || []), e.message],
                    });
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
            ${
                ticket &&
                html`<div class="device-ticket">
                <p class="null-sub">
                    ${
                        finished
                            ? t('device.backup-done', 'done')
                            : failed
                              ? t('device.backup-failed', 'the backup failed')
                              : t('device.backup-running', 'working…')
                    }
                </p>
                <ol class="device-log">${(ticket.log || []).map((line, i) => html`<li key=${i}>${line}</li>`)}</ol>
            </div>`
            }
            ${error && html`<p class="form-error">${error}</p>`}
            <h3 class="computers-subtitle">${t('device.backups-made', 'made so far')}</h3>
            ${
                !archives
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
                              ${
                                  isDevice()
                                      ? html`<button class="computer-remove" onClick=${() => reveal(a.name)}>${t('device.show-in-folder', 'show in folder')}</button>`
                                      : html`<a class="computer-remove" href=${`/api/admin/backups/${a.name}`} download=${a.name}>${t('device.download', 'download')}</a>`
                              }
                          </li>`;
                      })}
                  </ul>`
            }
            <p class="null-sub">${t('device.restoring-is-not-here-yet', "Restoring from a backup isn't here yet.")}</p>
            ${!isDevice() && html`<h3 class="computers-subtitle">${t('device.imports', 'imports')}</h3><${ImportPolicy} />`}
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
            <h3 class="computers-subtitle">${t('device.search-engines', 'search engines')}</h3>
            <${SearchPolicy} />
            <h3 class="computers-subtitle">${t('device.tagged-audio', 'tagged songs')}</h3>
            <${AudioPolicy} />
        </div>
    `;
};

// ---------------------------------------------------------------------------------------------
// Network (plans/NETWORK.md)

/// How often the page asks again: the table moves with every connection.
const NETWORK_EVERY_MS = 10_000;

const since = (ms, now) => {
    if (!ms) return null;
    const unit = agoUnit(ms, now);
    return unit ? agoWords(unit.value, unit.unit) : t('device.just-now', 'just now');
};

/// A machine's standing, in words.
const STATUS_WORDS = () => ({
    dark: t('device.machine-dark', 'not answering'),
    answering: t('device.machine-answering', 'answering'),
    unanswered: t('device.machine-unanswered', "didn't answer last time"),
    'dials-in': t('device.machine-dials-in', 'calls in, never called'),
    unknown: t('device.machine-unknown', 'never tried'),
});

/// Each standing's class, spelled out so the CSS cop can find them.
const STATUS_CLASS = {
    dark: 'machine-status machine-status-dark',
    answering: 'machine-status machine-status-answering',
    unanswered: 'machine-status machine-status-unanswered',
    'dials-in': 'machine-status',
    unknown: 'machine-status',
};

/// One of the viewer's own links to a machine, in words, and where it goes.
const LinkChip = ({ link }) => {
    const name = link.name || t('device.someone', 'someone');
    if (link.kind === 'own') {
        return html`<span class="machine-link">${t('device.your-computer', 'your computer')}</span>`;
    }
    if (link.kind === 'group') {
        return html`<a class="machine-link" href=${groupHref(link.group)}>${t('device.in-group', 'in {group}', { group: name })}</a>`;
    }
    const words =
        link.kind === 'holds'
            ? t('device.holds-person', 'holds {name}', { name })
            : t('device.serves-person', 'serves {name}', { name });
    return html`<a class="machine-link" href=${personHref(link.root)}>${words}</a>`;
};

/// What a machine says of itself, in one line: its client and version, its kind of device, and
/// how many accounts and personas it carries (the Hello's about slot).
const aboutLine = (m) =>
    [
        m.version && (m.client ? `${m.client} ${m.version}` : m.version),
        m.device,
        m.users != null && t('device.accounts-count', 'accounts: {n}', { n: m.users }),
        m.personas != null && t('device.personas-count', 'personas: {n}', { n: m.personas }),
    ]
        .filter(Boolean)
        .join(' · ');

const MachineRow = ({ m, now }) => {
    const status = machineStatus(m, now);
    const pct = reliabilityPct(m);
    const facts = [
        m.last_ok_ms &&
            t('device.answered-when', 'answered {when}', { when: since(m.last_ok_ms, now) }),
        m.last_fail_ms &&
            t('device.failed-when', 'failed {when}', { when: since(m.last_fail_ms, now) }),
        m.last_inbound_ms &&
            t('device.called-in-when', 'called in {when}', { when: since(m.last_inbound_ms, now) }),
    ].filter(Boolean);
    const dark =
        status === 'dark' &&
        t('device.asking-again-when', 'asking again {when}', {
            when: formatWhen(m.dark_until_ms, now),
        });
    // Not answering, or didn't last time: the card fades, so the answering ones read first.
    const quiet = status === 'dark' || status === 'unanswered';
    return html`<li class=${quiet ? 'machine-row machine-row-quiet' : 'machine-row'}>
        <span class="machine-icon"><${Icons.machine} /></span>
        <div class="machine-body">
        <div class="machine-head">
            <span class="machine-name" title=${m.endpoint}>${machineLabel(m)}</span>
            <span class=${STATUS_CLASS[status]}>${STATUS_WORDS()[status]}</span>
        </div>
        ${m.name && m.words && html`<span class="machine-words">${m.words}</span>`}
        ${facts.length > 0 && html`<span class="machine-facts">${facts.join(' · ')}</span>`}
        ${dark && html`<span class="machine-facts">${dark}</span>`}
        ${
            pct !== null &&
            html`<div class="machine-reliability" title=${m.last_error || ''}>
                <span class="machine-bar"><span class="machine-bar-fill" style=${`width: ${pct}%`}></span></span>
                <span class="machine-facts">${t('device.answers-pct', 'answers {pct}%', { pct })}${m.connect_ms != null ? ` · ${t('device.connect-ms', '{ms} ms to connect', { ms: m.connect_ms })}` : ''}</span>
            </div>`
        }
        ${aboutLine(m) && html`<span class="machine-facts">${aboutLine(m)}</span>`}
        <span class="machine-facts">${Object.keys(m.lanes || {}).join(', ')}</span>
        ${
            (m.links || []).length > 0 &&
            html`<div class="machine-links">${m.links.map((link, i) => html`<${LinkChip} key=${i} link=${link} />`)}</div>`
        }
        </div>
    </li>`;
};

/// This machine's name, renamed by an administrator: the next Hello says it.
const ThisMachine = ({ me, admin, onSaved }) => {
    const [name, setName] = useState(me.chosen ? me.name : '');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => setName(me.chosen ? me.name : ''), [me.name, me.chosen]);
    const save = async (value) => {
        setBusy(true);
        setError('');
        try {
            await api('/api/admin/machine-name', {
                method: 'PUT',
                body: JSON.stringify({ name: value }),
            });
            onSaved();
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };
    return html`<section class="machine-this">
        <h3 class="computers-subtitle">${t('device.this-machine', 'this machine')}</h3>
        <div class="machine-head">
            <span class="machine-name" title=${me.endpoint}>${me.name}</span>
            <span class="machine-facts">${aboutLine(me)}</span>
        </div>
        <span class="machine-words">${me.words}</span>
        ${
            admin &&
            html`<label class="device-field">
                <span>${t('device.what-other-machines-call-this-one', 'what other machines call this one')}</span>
                <input type="text" maxlength="120" value=${name} placeholder=${me.name} onInput=${(e) => setName(e.currentTarget.value)} />
            </label>
            ${error && html`<p class="form-error">${error}</p>`}
            <div class="device-actions">
                <button class="removal-go" disabled=${busy} onClick=${() => save(name)}>${busy ? '…' : t('device.save', 'save')}</button>
                ${
                    me.chosen &&
                    html`<button class="computer-remove" disabled=${busy} onClick=${() => save(null)}>
                        ${t('device.back-to-its-own-name', 'back to its own name')}
                    </button>`
                }
            </div>`
        }
    </section>`;
};

const Network = ({ current, admin }) => {
    const root = current && current.root;
    const [answer, setAnswer] = useState(null);
    const [error, setError] = useState('');
    const [mine, setMine] = useState(false);
    const load = useCallback(() => {
        if (!root) return;
        api(`/api/identity/${root}/machines`)
            .then((a) => {
                setAnswer(a);
                setError('');
            })
            .catch((e) => setError(e.message));
    }, [root]);
    useEffect(() => {
        load();
        const again = setInterval(load, NETWORK_EVERY_MS);
        return () => clearInterval(again);
    }, [load]);
    if (!answer) {
        return html`<div class="device">${error ? html`<p class="form-error">${error}</p>` : html`<p class="null-sub">${t('device.looking', 'looking…')}</p>`}</div>`;
    }
    const now = Date.now();
    const shown = machinesShown(answer.machines, mine);
    return html`
        <div class="device">
            <h2 class="computers-title">${t('device.network', 'Network')}</h2>
            <p class="null-sub">${t('device.network-explained', 'Every machine this place has talked to, either way: what it calls itself, and how reliably it answers. Anyone on the network learns this much by calling, so everyone here sees it. Which of them carry your own computers, the people you follow and your groups is yours alone.')}</p>
            <${ThisMachine} me=${answer.this} admin=${admin} onSaved=${load} />
            <nav class="welcome-tabs">
                <button class=${mine ? 'tab' : 'tab active'} onClick=${() => setMine(false)}>${t('device.all-machines', 'all machines ({n})', { n: answer.machines.length })}</button>
                <button class=${mine ? 'tab active' : 'tab'} onClick=${() => setMine(true)}>${t('device.linked-to-you', 'linked to you')}</button>
            </nav>
            ${error && html`<p class="form-error">${error}</p>`}
            ${
                shown.length === 0
                    ? html`<p class="null-sub">${mine ? t('device.none-linked-to-you', 'None of these machines carry anything of yours yet.') : t('device.no-machines-yet', "No machines yet - this place hasn't talked to any.")}</p>`
                    : html`<ul class="machine-list">${shown.map((m) => html`<${MachineRow} key=${m.endpoint} m=${m} now=${now} />`)}</ul>`
            }
        </div>
    `;
};
