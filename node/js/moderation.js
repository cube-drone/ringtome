// Moderation lists (plans/MODERATION.md, 2026-11-02): the reader's own public list, whose lists
// they take, and what they take - one GET (moderation.rs), read once per page load into one
// shared store and refreshed after every edit, as the content-warning lists are. The judgment a
// post meets lives in pure/moderation.js; the content control page's sections in
// moderationpage.js, which can show people (person.js imports this file).
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { t } from './i18n.js';
import { MAX_REASON_BYTES, overruleKey, reasonBytes } from './pure/moderation.js';

const html = htm.bind(h);

const OVERRULES = 'moderation_overrules';
const EMPTY = { mine: [], moderators: [], taken: [] };
const store = new Map(); // root -> the view
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

async function load(root) {
    try {
        store.set(root, await api(`/api/identity/${root}/moderation`));
    } catch {
        if (!store.has(root)) store.set(root, EMPTY);
    }
    notify();
}

/// What `root` takes: nothing until the node answers, then the folded view.
export function useModeration(root) {
    const [, bump] = useState(0);
    useEffect(() => {
        if (!root) return undefined;
        const fn = () => bump((n) => n + 1);
        listeners.add(fn);
        if (!store.has(root)) load(root);
        return () => listeners.delete(fn);
    }, [root]);
    return (root && store.get(root)) || EMPTY;
}

/// Something changed elsewhere (a moderator ticked on a person's page): read it again.
export const moderationMoved = (root) => root && load(root);

const entryPath = (root, kind, target) => `/api/identity/${root}/moderation/${kind}/${target}`;

export async function listTarget(root, kind, target, level, reason) {
    await api(entryPath(root, kind, target), {
        method: 'PUT',
        body: JSON.stringify({ level, reason }),
    });
    await load(root);
}

export async function unlistTarget(root, kind, target) {
    await api(entryPath(root, kind, target), { method: 'DELETE' });
    await load(root);
}

export async function overrule(root, kind, target, on) {
    const element = overruleKey(kind, target);
    await (on
        ? api(`/api/identity/${root}/private/set/${OVERRULES}`, {
              method: 'POST',
              body: JSON.stringify({ element }),
          })
        : api(`/api/identity/${root}/private/set/${OVERRULES}/${encodeURIComponent(element)}`, {
              method: 'DELETE',
          }));
    await load(root);
}

export const levelWord = (level) =>
    level === 'block' ? t('moderation.level-block', 'block') : t('moderation.level-warn', 'warn');

/// A reason box that counts what the node counts: bytes.
export const ReasonInput = ({ value, onInput }) => {
    const used = reasonBytes(value);
    return html`<span class="moderation-reason">
        <input
            class="profile-input"
            value=${value}
            placeholder=${t('moderation.reason-placeholder', 'why - everyone who reads your list sees this')}
            onInput=${(e) => onInput(e.currentTarget.value)}
        />
        <small class=${used > MAX_REASON_BYTES ? 'moderation-count moderation-over' : 'moderation-count'}>
            ${used}/${MAX_REASON_BYTES}
        </small>
    </span>`;
};

/// On a person's page: trust them to moderate for you, and put them on your public list.
export const ModerationControls = ({ myRoot, theirRoot, facts, put }) => {
    const view = useModeration(myRoot);
    const listed = (view.mine || []).find((m) => m.kind === 'persona' && m.target === theirRoot);
    const [level, setLevel] = useState('warn');
    const [reason, setReason] = useState('');
    const [error, setError] = useState(null);
    const moderates = facts.moderates === 'yes';
    const add = async () => {
        setError(null);
        try {
            await listTarget(myRoot, 'persona', theirRoot, level, reason.trim());
            setReason('');
        } catch (e) {
            setError(e.message || String(e));
        }
    };
    return html`<div class="moderation-controls">
        <label class="moderation-overrule">
            <input
                type="checkbox"
                checked=${moderates}
                onChange=${async (e) => {
                    await put('moderates', e.currentTarget.checked ? 'yes' : 'no');
                    moderationMoved(myRoot);
                }}
            />
            ${t('moderation.trust-to-moderate', 'trust them to moderate for me')}
        </label>
        ${
            listed
                ? html`<p class="null-sub">
                      ${t('moderation.on-your-list', 'on your public list: {level}', { level: levelWord(listed.level) })}
                      ${listed.reason ? html` - ${listed.reason}` : ''}
                  </p>`
                : html`<div class="moderation-add">
                      <select class="profile-input" value=${level} onChange=${(e) => setLevel(e.currentTarget.value)}>
                          <option value="warn">${levelWord('warn')}</option>
                          <option value="block">${levelWord('block')}</option>
                      </select>
                      <${ReasonInput} value=${reason} onInput=${setReason} />
                      <button
                          class="removal-option"
                          disabled=${reasonBytes(reason) > MAX_REASON_BYTES}
                          onClick=${add}
                      >${t('moderation.add-to-public-list', 'add to my public list')}</button>
                  </div>`
        }
        ${error && html`<p class="form-error">${error}</p>`}
    </div>`;
};
