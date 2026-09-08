// The content-warning lists, on the persona (2026-09-07): two private registers in the
// `content_warnings` collection - `blur` and `hide`, each a JSON array of tags - so they
// travel to every computer the persona signs in on, like the rest of the ledger. Read once
// per page load into one shared store, refreshed when the profile page saves; the pure
// judgment lives in pure/warnings.js.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { t } from './i18n.js';
import { DEFAULT_BLUR, DEFAULT_HIDE, parseTagList, serializeTagList, normalizeTag } from './pure/warnings.js';

const html = htm.bind(h);

const COLLECTION = 'content_warnings';
const store = new Map(); // root -> { blur, hide }
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

async function load(root) {
    try {
        const r = await api(`/api/identity/${root}/private/kv/${COLLECTION}`);
        const val = (key) => ((r.values || []).find((v) => v.key === key) || {}).value;
        store.set(root, { blur: parseTagList(val('blur'), DEFAULT_BLUR), hide: parseTagList(val('hide'), DEFAULT_HIDE) });
    } catch {
        store.set(root, { blur: [...DEFAULT_BLUR], hide: [...DEFAULT_HIDE] });
    }
    notify();
}

/// The lists for `root`: defaults until the registers answer, then theirs.
export function useWarnings(root) {
    const [, bump] = useState(0);
    useEffect(() => {
        if (!root) return undefined;
        const fn = () => bump((n) => n + 1);
        listeners.add(fn);
        if (!store.has(root)) load(root);
        return () => listeners.delete(fn);
    }, [root]);
    return (root && store.get(root)) || { blur: DEFAULT_BLUR, hide: DEFAULT_HIDE };
}

async function save(root, key, list) {
    await api(`/api/identity/${root}/private/kv/${COLLECTION}/${key}`, {
        method: 'PUT',
        body: JSON.stringify({ value: serializeTagList(list) }),
    });
    const have = store.get(root) || { blur: [...DEFAULT_BLUR], hide: [...DEFAULT_HIDE] };
    store.set(root, { ...have, [key]: [...new Set(list.map(normalizeTag).filter(Boolean))] });
    notify();
}

/// One editable list: chips with a remove, and a box to add (Enter or a comma).
const TagList = ({ root, which, label, hint }) => {
    const lists = useWarnings(root);
    const [draft, setDraft] = useState('');
    const [error, setError] = useState(null);
    const list = lists[which] || [];
    const commit = async (next) => {
        setError(null);
        try {
            await save(root, which, next);
        } catch (e) {
            setError(e.message || String(e));
        }
    };
    const add = () => {
        const tags = draft.split(',').map(normalizeTag).filter(Boolean);
        if (!tags.length) return;
        setDraft('');
        commit([...list, ...tags.filter((g) => !list.includes(g))]);
    };
    return html`<div class="warn-list">
        <span class="profile-label">${label}</span>
        <p class="null-sub">${hint}</p>
        <div class="warn-chips">
            ${list.map(
                (tag) => html`<span key=${tag} class="warn-chip">
                    ${tag}
                    <button
                        class="warn-chip-x"
                        title=${t('warnings.remove', 'remove')}
                        onClick=${() => commit(list.filter((g) => g !== tag))}
                    >×</button>
                </span>`
            )}
            <input
                class="warn-add"
                value=${draft}
                placeholder=${t('warnings.add-a-tag', 'add a tag…')}
                onInput=${(e) => setDraft(e.currentTarget.value)}
                onKeyDown=${(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault();
                        add();
                    }
                }}
                onBlur=${add}
            />
        </div>
        ${error && html`<p class="form-error">${error}</p>`}
    </div>`;
};

/// The profile page's section: the two lists.
export const WarningLists = ({ root }) => html`<div class="warn-lists">
    <${TagList}
        root=${root}
        which="blur"
        label=${t('warnings.blurred-tags', 'blurred')}
        hint=${t('warnings.blurred-hint', 'posts tagged with these are partially hidden but still accessible')}
    />
    <${TagList}
        root=${root}
        which="hide"
        label=${t('warnings.hidden-tags', 'hidden')}
        hint=${t('warnings.hidden-hint', 'posts tagged with these will not be displayed on your feed at all')}
    />
</div>`;
