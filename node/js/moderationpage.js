// Content control's moderation tabs (plans/MODERATION.md, 2026-11-02; tabs 2026-11-03): your
// moderators - whose lists you take, and what you take from them - and your blocklist, your own
// public list. Reports are their own tab (reportqueue.js). Its own file because it shows people,
// and person.js imports moderation.js for the controls on a person's page.
import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';

import { t } from './i18n.js';
import { Icons } from './icons.js';
import { nodeHref, personHref } from './links.js';
import { NodeMark } from './nodemark.js';
import { HostedHereNote, useHostedAccount } from './hostedhere.js';
import { PersonInline } from './person.js';
import { KindHead } from './reportqueue.js';
import {
    levelWord,
    listPicture,
    listTarget,
    overrule,
    ReasonInput,
    unlistTarget,
    unlistWord,
    useModeration,
} from './moderation.js';
import { MAX_REASON_BYTES, reasonBytes } from './pure/moderation.js';

const html = htm.bind(h);

/// Someone named in a list: face and name, opening their page - where the box and the form are.
const Who = ({ root, current }) =>
    html`<a class="moderation-who" href=${personHref(root)}><${PersonInline} root=${root} current=${current} /></a>`;

/// The words for an entry that isn't a person, where no card's strip says it.
const kindWords = (kind) =>
    kind === 'picture'
        ? t('moderation.a-picture', 'a picture')
        : t('moderation.a-node', 'a server');

/// What an entry names: a person, a node by its id, or a picture by its hash - never shown here,
/// since it may be one nobody should see. On the reader's own list a picture they listed carries
/// its sketch (sketches.rs, Curtis 2026-11-05): 48 pixels of black and white, enough to remember
/// which picture it was. `titled` is a card whose strip already says the kind, so the words go.
const Target = ({ kind, target, current, sketch, titled }) =>
    kind === 'persona'
        ? html`<${Who} root=${target} current=${current} />`
        : html`<span class="moderation-who">
              ${!titled && kindWords(kind)}
              ${
                  kind === 'picture'
                      ? html`${sketch && html`<img class="moderation-sketch" src=${sketch} alt=${t('moderation.sketch-alt', 'a black-and-white sketch of the picture you listed')} />`}<code class="report-node" title=${target}>${target.slice(0, 12)}…</code>`
                      : html`<a class="report-node" href=${nodeHref(target)} title=${target}><${NodeMark} endpoint=${target} /><code>${target.slice(0, 12)}…</code></a>`
              }
          </span>`;

/// Put a picture on your public list by its address, as anyone copies it.
const PictureForm = ({ root }) => {
    const [address, setAddress] = useState('');
    const [level, setLevel] = useState('block');
    const [reason, setReason] = useState('');
    const [error, setError] = useState(null);
    const add = async () => {
        setError(null);
        try {
            await listPicture(root, address.trim(), level, reason.trim());
            setAddress('');
            setReason('');
        } catch (e) {
            setError(e.message || String(e));
        }
    };
    return html`<div class="moderation-picture-form">
        <p class="null-sub">
            ${t(
                'moderation.list-a-picture-hint',
                'A picture, by its address: copies of the same file are blocked or warned about as you say, wherever they are posted. Similar images get warned.',
            )}
        </p>
        <input
            class="profile-input moderation-address"
            value=${address}
            placeholder=${t('moderation.picture-address-placeholder', "the picture's address")}
            onInput=${(e) => setAddress(e.currentTarget.value)}
        />
        <div class="moderation-add">
            <select class="profile-input" value=${level} onChange=${(e) => setLevel(e.currentTarget.value)}>
                <option value="warn">${levelWord('warn')}</option>
                <option value="block">${levelWord('block')}</option>
            </select>
            <${ReasonInput} value=${reason} onInput=${setReason} />
        </div>
        <div class="report-buttons">
            <button
                class="removal-go"
                disabled=${!address.trim() || reasonBytes(reason) > MAX_REASON_BYTES}
                onClick=${add}
            >${t('moderation.add-to-public-list', 'add to my public list')}</button>
        </div>
        ${error && html`<p class="form-error">${error}</p>`}
    </div>`;
};

/// A list entry's kind, as a report card's strip names it (reportqueue.js `KindHead`).
const LIST_KINDS = { persona: 'user', node: 'node', picture: 'image' };

/// One entry of the reader's own list, as a card like a report's (Curtis, 2026-11-09): what it is
/// and when it was listed across the top, then its level and reason to change, or take it off.
const MineRow = ({ root, current, row }) => {
    // A block on someone this server hosts: the way to their account (account.js).
    const hosted = useHostedAccount(row.target, !!row.hosted_here && row.level === 'block');
    const [level, setLevel] = useState(row.level);
    const [reason, setReason] = useState(row.reason);
    const [error, setError] = useState(null);
    const changed = level !== row.level || reason.trim() !== row.reason;
    const run = async (fn) => {
        setError(null);
        try {
            await fn();
        } catch (e) {
            setError(e.message || String(e));
        }
    };
    return html`<li class="report-row">
        <${KindHead} kind=${LIST_KINDS[row.kind]} when=${row.said_ms} />
        <${Target} kind=${row.kind} target=${row.target} current=${current} sketch=${row.sketch} titled />
        <div class="moderation-add">
            <select class="profile-input" value=${level} onChange=${(e) => setLevel(e.currentTarget.value)}>
                <option value="warn">${levelWord('warn')}</option>
                <option value="block">${levelWord('block')}</option>
            </select>
            <${ReasonInput} value=${reason} onInput=${setReason} />
        </div>
        <div class="report-buttons">
            <button class="removal-option" onClick=${() => run(() => unlistTarget(root, row.kind, row.target))}>
                ${unlistWord(row.level)}
            </button>
            <button
                class="removal-go"
                disabled=${!changed || reasonBytes(reason) > MAX_REASON_BYTES}
                onClick=${() => run(() => listTarget(root, row.kind, row.target, level, reason.trim()))}
            >${t('moderation.save', 'save')}</button>
        </div>
        <${HostedHereNote} account=${hosted} />
        ${error && html`<p class="form-error">${error}</p>`}
    </li>`;
};

/// One target the reader takes: its sources and reasons, and the reader's overrule.
const TakenRow = ({ root, current, entry }) => html`<li
    class=${entry.overruled ? 'moderation-row moderation-overruled' : 'moderation-row'}
>
    <${Target} kind=${entry.kind} target=${entry.target} current=${current} />
    <span class="moderation-level">${levelWord(entry.level)}</span>
    <ul class="moderation-sources">
        ${entry.sources.map(
            (s) => html`<li key=${s.author}>
                <${Who} root=${s.author} current=${current} />
                <span class="moderation-said">${levelWord(s.level)}${s.reason ? html`: ${s.reason}` : ''}</span>
            </li>`,
        )}
    </ul>
    <label class="moderation-overrule">
        <input
            type="checkbox"
            checked=${entry.overruled}
            onChange=${(e) => overrule(root, entry.kind, entry.target, e.currentTarget.checked)}
        />
        ${t('moderation.ill-judge-this-myself', "I'll judge this myself")}
    </label>
</li>`;

/// The moderators tab: whose lists you take, and what you take from them.
export const ModeratorsTab = ({ current }) => {
    const root = current && current.root;
    const view = useModeration(root);
    if (!root) return null;
    const taken = (view.taken || []).filter((e) => !e.sources.every((s) => s.author === root));
    return html`<div class="moderation">
        <section class="moderation-section">
            <h2 class="settings-section-title">${t('moderation.whose-lists', 'Your Community Moderators')}</h2>
            <p class="null-sub">
                ${t('moderation.whose-lists-hint', 'People you trust to moderate for you.')}
            </p>
            ${
                view.moderators.length
                    ? html`<ul class="moderation-people">
                          ${view.moderators.map(
                              (m) =>
                                  html`<li key=${m}><${Who} root=${m} current=${current} /></li>`,
                          )}
                      </ul>`
                    : html`<p class="null-sub">${t('moderation.nobody-yet', "nobody - you're judging everything yourself")}</p>`
            }
        </section>
        <section class="moderation-section">
            <h2 class="settings-section-title">${t('moderation.what-you-take', 'From Your Moderators')}</h2>
            ${
                taken.length
                    ? html`<ul class="moderation-rows">
                          ${taken.map(
                              (e) =>
                                  html`<${TakenRow} key=${e.kind + e.target} root=${root} current=${current} entry=${e} />`,
                          )}
                      </ul>`
                    : html`<p class="null-sub">${t('moderation.nothing-taken', 'nothing yet')}</p>`
            }
        </section>
    </div>`;
};

/// The blocklist's own tabs (Curtis, 2026-11-10): one kind of entry at a time.
const LIST_TABS = () => [
    ['persona', Icons.persona, t('moderation.tab-users', 'users')],
    ['node', Icons.server, t('moderation.tab-nodes', 'nodes')],
    ['picture', Icons.mediaImage, t('moderation.tab-pictures', 'pictures')],
];

/// The blocklist tab: your own public list a kind at a time, and on pictures, one to add.
export const BlocklistTab = ({ current }) => {
    const root = current && current.root;
    const view = useModeration(root);
    const [kind, setKind] = useState('persona');
    if (!root) return null;
    const mine = view.mine || [];
    const shown = mine.filter((row) => row.kind === kind);
    return html`<div class="moderation">
        <section class="moderation-section">
            <h2 class="settings-section-title">${t('moderation.public-list-title', 'Public')}</h2>
            <nav class="welcome-tabs moderation-list-tabs">
                ${LIST_TABS().map(
                    ([to, Icon, words]) =>
                        html`<button
                            key=${to}
                            class=${kind === to ? 'tab active' : 'tab'}
                            aria-pressed=${kind === to}
                            onClick=${() => setKind(to)}
                        >
                            <${Icon} /> ${words}
                            <span class="moderation-tab-count">${mine.filter((row) => row.kind === to).length}</span>
                        </button>`,
                )}
            </nav>
            ${
                shown.length
                    ? html`<ul class="report-queue">
                          ${shown.map(
                              (row) =>
                                  html`<${MineRow}
                                      key=${row.kind + row.target + row.said_ms}
                                      root=${root}
                                      current=${current}
                                      row=${row}
                                  />`,
                          )}
                      </ul>`
                    : html`<p class="null-sub">${t('moderation.list-empty', 'empty')}</p>`
            }
            ${kind === 'picture' && html`<${PictureForm} root=${root} />`}
        </section>
    </div>`;
};
