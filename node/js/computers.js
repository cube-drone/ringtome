// "Your computers": the persona's key tree in domestic clothing (GLOSSARY, Cozyweb mapping -
// keys render by their device names, never as bare hex; the crown and the spare key render by
// role), each computer with how it is syncing. Three tabs, each its own address (2026-10-09): add
// a computer - the granting half of adoption, "invite this computer to be you": paste the new
// computer's request code, carry the answer back - which is the page's default; all computers;
// and this computer.
import { h } from 'preact';
import { useState, useEffect, useCallback } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import htm from 'htm';

import { api } from './net.js';
import { shortcode } from './persona.js';
import { Modal } from './modal.js';
import { Icons } from './icons.js';
import { blastRadius } from './pure/removal.js';
import { t, tNodes } from './i18n.js';
import { SyncActs, SyncLine, SyncReport, ThisComputer, useSyncStatus } from './syncpage.js';
import { computersHref } from './links.js';
import { DownloadPanel } from './downloads.js';

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
                body: JSON.stringify(cutChoice ? { disposition, cut: cutChoice } : { disposition }),
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
        ${t('computers.this-computers-key', "this computer's key: {p0}", { p0: shortcode(target.pubkey) })}
    </p>`;

    const title = isSelf
        ? 'leave this persona'
        : step === 'lockout'
          ? `lock out ${d.label}`
          : `remove ${d.label}`;

    return html`<${Modal} title=${title} onClose=${onClose}>
        ${
            step === 'choose' &&
            html`<p class="null-sub">${t('computers.how-should-go', 'How should {label} go?', { label: d.label })}</p>
            <button class="removal-option" onClick=${() => setStep('leave')}>
                <span class="removal-option-title">${t('computers.have-this-computer-leave', 'have this computer leave')}</span>
                <span class="removal-option-sub">
                    ${t('computers.a-graceful-goodbye-everything-it', 'A graceful goodbye. Everything it wrote stays good, and any computers it invited stay too.')}
                </span>
            </button>
            <button class="removal-option removal-option-forceful" onClick=${() => setStep('lockout')}>
                <span class="removal-option-title">${t('computers.lock-this-computer-out', 'lock this computer out')}</span>
                <span class="removal-option-sub">
                    ${t('computers.for-a-computer-you-dont', "For a computer you don't trust anymore. It is shut out - and every computer it invited is shut out with it.")}
                </span>
            </button>`
        }
        ${
            step === 'leave' &&
            html`<p class="null-sub">
                ${
                    isSelf
                        ? `This computer stops being you. Everything it already wrote stays good,
                       your other computers carry on without it - and this one is left out of
                       everything new, for keeps.`
                        : `${d.label} stops being you, gracefully. Everything it wrote stays good,
                       and any computers it invited stay too.`
                }
            </p>
            ${fingerprint}
            <button class="removal-go" disabled=${busy} onClick=${() => revoke('retirement')}>
                ${busy ? '…' : isSelf ? t('computers.leave-this-persona', 'leave this persona') : t('computers.have-it-leave', 'have it leave')}
            </button>`
        }
        ${
            step === 'lockout' &&
            html`<p class="null-sub">${t('computers.was-this-computer-really-you', 'Was this computer really you?')}</p>
            <button
                class="removal-option ${cut === 'now' ? 'removal-option-picked' : ''}"
                onClick=${() => setCut('now')}
            >
                <span class="removal-option-title">${t('computers.it-was-me-until-now', 'it was me, until now')}</span>
                <span class="removal-option-sub">
                    ${t('computers.it-was-mine-but-it', "It was mine, but it isn't safe anymore. What it already wrote stands; nothing new gets in.")}
                </span>
            </button>
            <button
                class="removal-option ${cut === 'genesis' ? 'removal-option-picked' : ''}"
                onClick=${() => setCut('genesis')}
            >
                <span class="removal-option-title">${t('computers.it-was-never-me', 'it was never me')}</span>
                <span class="removal-option-sub">
                    ${t('computers.an-impostor-all-along-everything', 'An impostor all along. Everything it ever wrote is struck from the record.')}
                </span>
            </button>
            ${
                cut &&
                html`${
                    radius.length > 0 &&
                    html`<p class="removal-blast">
                    ${t('computers.locked-out-with-it', 'locked out with it:')}${' '}
                    ${radius.map((k) => describe(k).label).join(', ')}
                </p>`
                }
                ${fingerprint}
                <button
                    class="removal-go"
                    disabled=${busy}
                    onClick=${() => revoke('repudiation', cut)}
                >
                    ${busy ? '…' : t('computers.lock-it-out', 'lock it out')}
                </button>`
            }`
        }
        ${error && html`<p class="form-error">${error}</p>`}
    <//>`;
};

/// The page's tabs, in order (2026-10-09): add a computer (the default), every computer and how
/// each is syncing, and what this one holds. `report` is the sync report, under `all`.
const TABS = ['new', 'all', 'mine'];

/// `/ringtome/settings/computers` and `/ringtome/settings/computers/:tab` - a bare or unknown tab lands
/// on `new`.
export const Computers = ({ current, tab }) => {
    const loc = useLocation();
    const known = TABS.includes(tab) || tab === 'report';
    useEffect(() => {
        if (!known) loc.route(computersHref('new'), true);
    }, [known, loc]);
    if (!known) return null;
    const on = tab === 'report' ? 'all' : tab;
    const tabLink = (to, icon, words) =>
        html`<a class=${on === to ? 'tab active' : 'tab'} href=${computersHref(to)}>
            <${icon} /> ${words}
        </a>`;
    return html`
        <div class="computers">
            <h2 class="computers-title">${t('computers.your-computers', 'your computers')}</h2>
            <nav class="welcome-tabs">
                ${tabLink('new', Icons.plus, t('computers.tab-new', 'add computer'))}
                ${tabLink('all', Icons.syncIdle, t('computers.tab-computers', 'all computers'))}
                ${tabLink('mine', Icons.computers, t('computers.tab-this', 'this computer'))}
            </nav>
            ${tab === 'new' && html`<${AddComputer} current=${current} />`}
            ${tab === 'all' && html`<${AllComputers} current=${current} />`}
            ${
                tab === 'report' &&
                html`<a class="skip-link" href=${computersHref('all')}>
                        ${t('computers.back-to-all', 'back to all computers')}
                    </a>
                    <${SyncReport} root=${current.root} />`
            }
            ${tab === 'mine' && html`<${ThisComputer} root=${current.root} />`}
        </div>
    `;
};

/// The persona's computers as its key tree - each sitting under whoever invited it - and, under
/// each, how it is syncing with this one (plans/SYNC_STATUS.md, piece 4). The spare key and this
/// computer have no sync of their own to show.
const AllComputers = ({ current }) => {
    const [keys, setKeys] = useState(null);
    const [error, setError] = useState(null);
    const [removing, setRemoving] = useState(null); // the key whose removal flow is open
    const sync = useSyncStatus(current.root);

    const load = useCallback(
        () =>
            api(`/api/identity/${current.root}/keys`)
                .then((r) => setKeys(r.keys))
                .catch((e) => setError(e.message)),
        [current.root],
    );
    useEffect(() => {
        load();
    }, [load]);

    const running = (sync.status && sync.status.running) || [];
    const syncs = (sync.status && sync.status.computers) || [];
    const syncOf = new Map(syncs.filter((c) => c.leaf).map((c) => [c.leaf, c]));
    // A computer the ledger knows by its address but not (yet) by its key still says how it's doing.
    const unnamed = keys
        ? syncs.filter((c) => !c.leaf || !keys.some((k) => k.pubkey === c.leaf))
        : [];
    // On one computer only (Curtis, 2026-10-09): nothing to list and nothing to sync - the tab is
    // the case for a second computer instead. Counted from the tree, which knows every computer,
    // where the sync ledger knows only those reached since the server started.
    const alone =
        keys &&
        unnamed.length === 0 &&
        keys.filter((k) => roleOf(k) !== 'spare' && k.status === 'active').length <= 1;
    if (alone)
        return html`<div class="null-state computers-alone">
            <span class="null-glyph"><${Icons.computerNode} /></span>
            <p class="null-sub">
                ${t(
                    'computers.only-on-this-computer',
                    "This persona only exists on this computer! If something happens to this computer, your persona and all of your files, dreams, and horses will be lost forever! Nobody is backing it up for you - that's your responsibility. For safety, I recommend you add a few extra computers to the network - so long as they come online every once in a while, they'll keep a full backup of your identity.",
                )}
            </p>
            <a class="welcome-go" href=${computersHref('new')}>${t('computers.tab-new', 'add computer')}</a>
        </div>`;

    return html`<div>
        ${!keys && !error && html`<p class="null-sub">${t('computers.looking-around', 'looking around…')}</p>`}
        ${
            keys &&
            html`<ul class="computer-list">
                ${keys.map((k) => {
                    const d = describe(k);
                    const synced = syncOf.get(k.pubkey);
                    // The server sends responsibility order (rank paths); the indent makes the
                    // chain of vouching visible - each computer sits under whoever invited it.
                    const depth = k.rank_path.length;
                    return html`<li
                        class="computer-row"
                        key=${k.pubkey}
                        style="margin-left: ${depth * 0.9}rem"
                    >
                        <span class="computer-name">
                            <${Icons.computerNode} /> ${d.label}
                            ${d.detail && html` <span class="computer-detail">— ${d.detail}</span>`}
                        </span>
                        <span class="computer-facts" title=${k.pubkey}>
                            ${cozyStatus(k.status) && html`<span class="computer-status">${cozyStatus(k.status)}${' · '}</span>`}${shortcode(k.pubkey)}
                        </span>
                        ${
                            k.removal &&
                            html`<button
                            class="computer-remove"
                            title=${
                                k.removal === 'self'
                                    ? t('computers.leave-this-persona-2', 'leave this persona')
                                    : t('computers.remove-this-computer', 'remove this computer')
                            }
                            onClick=${() => setRemoving(k)}
                        >
                            <${Icons.trash} />
                        </button>`
                        }
                        ${synced && html`<${SyncLine} computer=${synced} running=${running} />`}
                    </li>`;
                })}
                ${unnamed.map(
                    (c) => html`<li class="computer-row" key=${c.endpoint}>
                        <span class="computer-name">
                            <${Icons.computerNode} /> ${t('syncpage.another-computer', 'another computer')}
                        </span>
                        <${SyncLine} computer=${c} running=${running} />
                    </li>`,
                )}
            </ul>`
        }
        ${sync.status && html`<${SyncActs} root=${current.root} status=${sync.status} look=${sync.look} />`}
        ${(error || sync.error) && html`<p class="form-error">${error || sync.error}</p>`}
        ${
            removing &&
            html`<${RemovalFlow}
                current=${current}
                target=${removing}
                keys=${keys || []}
                onDone=${() => {
                    setRemoving(null);
                    load(); // the tree changed; show the new status
                }}
                onClose=${() => setRemoving(null)}
            />`
        }
    </div>`;
};

/// The granting half of adoption: paste the new computer's request code, and either it moves right
/// in or there is an invite to carry back. And the app, for a person already signed in - who had
/// nowhere to get it from but the front page they no longer see (Curtis, 2026-10-09).
const AddComputer = ({ current }) => {
    const [requestCode, setRequestCode] = useState('');
    const [grantCode, setGrantCode] = useState(null);
    const [delivered, setDelivered] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

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
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    };

    return html`<div>
        <h3 class="computers-subtitle">${t('computers.invite-another-computer-to-be', 'invite another computer to be you')}</h3>
        ${
            delivered &&
            html`<p class="field-note ok">
                    ${t('computers.it-moved-right-in--', 'It moved right in - nothing to carry back. It should be itself over there already.')}
                </p>
                <button class="skip-link" onClick=${() => setDelivered(false)}>
                    ${t('computers.invite-another-computer', 'invite another computer')}
                </button>`
        }
        ${
            grantCode
                ? html`<p class="null-sub">
                          ${t('computers.couldnt-reach-the-new-computer', "Couldn't reach the new computer directly - carry this invite back and paste it there. Keep this computer awake while it moves in.")}
                      </p>
                      <code class="spare-key">${grantCode}</code>
                      <button class="skip-link" onClick=${() => setGrantCode(null)}>
                          ${t('computers.invite-a-different-computer', 'invite a different computer')}
                      </button>`
                : !delivered &&
                  html`<p class="null-sub">
                          ${tNodes(
                              'computers.on-the-new-computer-sign',
                              'On the new computer, sign in and choose {action} - it will give you a code to paste here.',
                              {
                                  action: html`<strong
                                      >${t(
                                          'computers.bring-your-persona-from-another',
                                          'bring your persona from another computer',
                                      )}</strong
                                  >`,
                              },
                          )}
                      </p>
                      <form class="welcome-form" onSubmit=${invite}>
                          <textarea
                              class="spare-paste jag-field"
                              rows="4"
                              placeholder=${t('computers.paste-the-new-computers-code', "paste the new computer's code here")}
                              value=${requestCode}
                              onInput=${(e) => setRequestCode(e.currentTarget.value)}
                              required
                          ></textarea>
                          <button class="welcome-go" type="submit" disabled=${busy}>
                              ${busy ? '…' : t('computers.invite-this-computer-to-be', 'invite this computer to be you')}
                          </button>
                      </form>`
        }
        ${error && html`<p class="form-error">${error}</p>`}
        <hr class="computers-rule" />
        <h3 class="computers-subtitle">${t('computers.get-the-app', 'get the app')}</h3>
        <${DownloadPanel} />
    </div>`;
};
