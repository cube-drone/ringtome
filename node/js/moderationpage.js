// The content control page's moderation sections (plans/MODERATION.md, 2026-11-02): whose lists
// you take, what you take from them, and your own public list. Its own file because it shows
// people, and person.js imports moderation.js for the controls on a person's page.
import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';

import { t } from './i18n.js';
import { personHref } from './links.js';
import { PersonInline } from './person.js';
import {
    levelWord,
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
        <${Who} root=${row.target} current=${current} />
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
    <${Who} root=${entry.target} current=${current} />
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

/// The content control page's sections: whose lists you take, what you take, and your own.
export const ModerationSections = ({ current }) => {
    const root = current && current.root;
    const view = useModeration(root);
    if (!root) return null;
    const mine = view.mine || [];
    const taken = (view.taken || []).filter((e) => !e.sources.every((s) => s.author === root));
    return html`<div class="moderation">
        <section class="moderation-section">
            <h2 class="settings-section-title">${t('moderation.whose-lists', 'Whose lists you take')}</h2>
            <p class="null-sub">
                ${t(
                    'moderation.whose-lists-hint',
                    'People you trust to moderate for you: what they block or warn about, you do too. Tick or untick anyone on their own page. Only their own word counts - never what they take from others.',
                )}
            </p>
            ${
                view.administers &&
                html`<p class="null-sub">
                    ${t(
                        'moderation.administers-hint',
                        'You run this server, so what you block - on your own list or from the lists you take - it refuses to carry for everyone here, and clears off. Warnings stay yours. Its own users are never refused: remove an account instead.',
                    )}
                </p>`
            }
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
            <h2 class="settings-section-title">${t('moderation.what-you-take', 'What you take')}</h2>
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
        <section class="moderation-section">
            <h2 class="settings-section-title">${t('moderation.your-public-list', 'Your public list')}</h2>
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
        </section>
    </div>`;
};
