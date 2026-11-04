// Content control's moderation tabs (plans/MODERATION.md, 2026-11-02; tabs 2026-11-03): your
// moderators - whose lists you take, and what you take from them - and your blocklist, your own
// public list. Reports are their own tab (reportqueue.js). Its own file because it shows people,
// and person.js imports moderation.js for the controls on a person's page.
import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';

import { t } from './i18n.js';
import { personHref } from './links.js';
import { PersonInline } from './person.js';
import {
    levelWord,
    listPicture,
    listTarget,
    overrule,
    ReasonInput,
    unlistTarget,
    useModeration,
} from './moderation.js';
import { MAX_REASON_BYTES, reasonBytes } from './pure/moderation.js';

const html = htm.bind(h);

/// Someone named in a list: face and name, opening their page - where the box and the form are.
const Who = ({ root, current }) =>
    html`<a class="moderation-who" href=${personHref(root)}><${PersonInline} root=${root} current=${current} /></a>`;

/// What an entry names: a person, a node by its id, or a picture by its hash - never shown here,
/// since it may be one nobody should see.
const Target = ({ kind, target, current }) =>
    kind === 'persona'
        ? html`<${Who} root=${target} current=${current} />`
        : html`<span class="moderation-who">
              ${kind === 'picture' ? t('moderation.a-picture', 'a picture') : t('moderation.a-node', 'a server')}
              <code class="report-node" title=${target}>${target.slice(0, 12)}…</code>
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
                'A picture, by its address: copies of the same file are blocked or warned about as you say, wherever they are posted. One that only looks like it gets a warning, never more.',
            )}
        </p>
        <div class="moderation-add">
            <input
                class="profile-input"
                value=${address}
                placeholder=${t('moderation.picture-address-placeholder', "the picture's address")}
                onInput=${(e) => setAddress(e.currentTarget.value)}
            />
            <select class="profile-input" value=${level} onChange=${(e) => setLevel(e.currentTarget.value)}>
                <option value="warn">${levelWord('warn')}</option>
                <option value="block">${levelWord('block')}</option>
            </select>
            <${ReasonInput} value=${reason} onInput=${setReason} />
            <button
                class="removal-option"
                disabled=${!address.trim() || reasonBytes(reason) > MAX_REASON_BYTES}
                onClick=${add}
            >${t('moderation.add-to-public-list', 'add to my public list')}</button>
        </div>
        ${error && html`<p class="form-error">${error}</p>`}
    </div>`;
};

/// One row of the reader's own list: change its level or reason, or take it off.
const MineRow = ({ root, current, row }) => {
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
    return html`<li class="moderation-row">
        <${Target} kind=${row.kind} target=${row.target} current=${current} />
        <select class="profile-input" value=${level} onChange=${(e) => setLevel(e.currentTarget.value)}>
            <option value="warn">${levelWord('warn')}</option>
            <option value="block">${levelWord('block')}</option>
        </select>
        <${ReasonInput} value=${reason} onInput=${setReason} />
        <button
            class="removal-option"
            disabled=${!changed || reasonBytes(reason) > MAX_REASON_BYTES}
            onClick=${() => run(() => listTarget(root, row.kind, row.target, level, reason.trim()))}
        >${t('moderation.save', 'save')}</button>
        <button class="removal-option" onClick=${() => run(() => unlistTarget(root, row.kind, row.target))}>
            ${t('moderation.take-off', 'take off')}
        </button>
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

/// The blocklist tab: your own public list, and a picture to add to it.
export const BlocklistTab = ({ current }) => {
    const root = current && current.root;
    const view = useModeration(root);
    if (!root) return null;
    const mine = view.mine || [];
    return html`<div class="moderation">
        <section class="moderation-section">
            <p class="null-sub">
                ${t(
                    'moderation.your-public-list-hint',
                    "Public: anyone can read it, including the people on it. Add someone from their own page. Blocking someone privately doesn't put them here.",
                )}
            </p>
            ${
                mine.length
                    ? html`<ul class="moderation-rows">
                          ${mine.map(
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
            <${PictureForm} root=${root} />
        </section>
    </div>`;
};
