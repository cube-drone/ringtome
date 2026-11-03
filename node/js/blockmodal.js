// "Block this user", on someone's page (Curtis, 2026-11-02): the private block and the public list
// entries (plans/MODERATION.md) in one modal, three ways, each with its reason:
//
// - **Private Block**: the `blocked` fact on the contact, and its reason (`blocked_reason`, a
//   private fact like the rest) - only the reader's own computers ever see either.
// - **Public Block**: the same private block, plus a `block` entry on the reader's public list, so
//   the people who trust them to moderate block this user too.
// - **Public Warning**: a `warn` entry on the public list, and no block - the reader and the people
//   who trust them see this user's posts behind a click-through.
//
// The three are one choice: saving one undoes whatever the others had said. Nothing is written
// until Save; an existing block or warning opens selected, with its reason, and can be lifted.
import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { t } from './i18n.js';
import { Modal } from './modal.js';
import { listTarget, ReasonInput, unlistTarget, useModeration } from './moderation.js';
import { MAX_REASON_BYTES, blockState, reasonBytes } from './pure/moderation.js';

const html = htm.bind(h);

/// `administers`: the reader runs this node, so their public blocks are the node's too
/// (moderation.rs) - the Public Block says so.
const CHOICES = (administers) => [
    [
        'private',
        t('block.private-block', 'Private Block'),
        t('block.private-block-hint', "Only you know you've blocked this user."),
    ],
    [
        'public-block',
        t('block.public-block', 'Public Block'),
        administers
            ? t(
                  'block.public-block-hint-admin',
                  'People who trust you to moderate, and this entire node, will block this user, too.',
              )
            : t(
                  'block.public-block-hint',
                  'People who trust you to moderate will block this user, too.',
              ),
    ],
    [
        'public-warn',
        t('block.public-warning', 'Public Warning'),
        t(
            'block.public-warning-hint',
            "People who trust you to moderate will see this user's content behind a warning.",
        ),
    ],
];

export const BlockModal = ({ myRoot, theirRoot, facts, put, onClose }) => {
    const view = useModeration(myRoot);
    const listed = (view.mine || []).find((m) => m.kind === 'persona' && m.target === theirRoot);
    const was = blockState(facts, listed);
    const [choice, setChoice] = useState(was);
    // One reason, whichever way: the one standing now, to start from.
    const [draft, setDraft] = useState(() =>
        was === 'private' ? facts.blocked_reason || '' : (listed && listed.reason) || '',
    );
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const reason = draft.trim();

    const run = async (fn) => {
        setError('');
        setBusy(true);
        try {
            await fn();
            onClose();
        } catch (e) {
            setError(e.message || String(e));
        } finally {
            setBusy(false);
        }
    };
    // Public first: a list entry can be refused (a reason too long), and then nothing private moved.
    const save = () =>
        run(async () => {
            if (choice === 'private') {
                if (listed) await unlistTarget(myRoot, 'persona', theirRoot);
            } else {
                const level = choice === 'public-block' ? 'block' : 'warn';
                await listTarget(myRoot, 'persona', theirRoot, level, reason);
            }
            const blocking = choice !== 'public-warn';
            await put('blocked', blocking ? 'yes' : 'no');
            await put('blocked_reason', blocking ? reason : '');
        });
    const lift = () =>
        run(async () => {
            if (listed) await unlistTarget(myRoot, 'persona', theirRoot);
            await put('blocked', 'no');
            await put('blocked_reason', '');
        });

    return html`<${Modal} title=${t('block.block-this-user', 'Block this user')} onClose=${onClose}>
        <div class="block-form">
            ${CHOICES(view.administers).map(
                ([key, name, hint]) => html`<label
                    key=${key}
                    class=${choice === key ? 'block-choice block-chosen' : 'block-choice'}
                >
                    <input
                        type="radio"
                        name="block-choice"
                        checked=${choice === key}
                        onChange=${() => setChoice(key)}
                    />
                    <span class="block-choice-words">
                        <strong>${name}</strong>
                        <small class="block-choice-hint">${hint}</small>
                    </span>
                </label>`,
            )}
            <${ReasonInput}
                wide
                value=${draft}
                placeholder=${choice === 'private' ? t('block.private-reason-placeholder', 'why - only you ever see this') : null}
                onInput=${setDraft}
            />
            ${error && html`<p class="form-error">${error}</p>`}
            <div class="block-actions">
                ${
                    was &&
                    html`<button class="removal-option" disabled=${busy} onClick=${lift}>
                        ${was === 'public-warn' ? t('block.lift-the-warning', 'Lift the Warning') : t('block.unblock', 'Unblock')}
                    </button>`
                }
                <button class="removal-option" disabled=${busy} onClick=${onClose}>${t('block.cancel', 'Cancel')}</button>
                <button
                    class="removal-go"
                    disabled=${busy || !choice || reasonBytes(reason) > MAX_REASON_BYTES}
                    onClick=${save}
                >${t('block.save', 'Save')}</button>
            </div>
        </div>
    </${Modal}>`;
};

const STANDING_WORDS = () => ({
    private: t('block.you-blocked-them-privately', 'You blocked this user privately.'),
    'public-block': t(
        'block.you-blocked-them-publicly',
        'You blocked this user publicly: people who trust you to moderate block them too.',
    ),
});

/// A blocked person's page when nothing of theirs can be reached (idpage.js; Curtis, 2026-11-02):
/// a block clears them off your computers, so their page would otherwise be an error with no way
/// back. Says so, with your reason, and opens the block modal to change or lift it.
export const BlockedCard = ({ myRoot, theirRoot, facts, listed, name }) => {
    const [open, setOpen] = useState(false);
    const standing = blockState(facts, listed);
    const reason = standing === 'public-block' ? listed.reason : facts.blocked_reason || '';
    // The contact's registers, written as the ledger writes them; the mirror shows the result.
    const put = (key, value) =>
        api(
            `/api/identity/${myRoot}/private/kv/${encodeURIComponent(`contact:${theirRoot}`)}/${key}`,
            {
                method: 'PUT',
                body: JSON.stringify({ value }),
            },
        );
    return html`<div class="blocked-card">
        <h1 class="persona-page-title">${name}</h1>
        <p><strong>${t('block.this-user-is-blocked', 'This user is blocked.')}</strong></p>
        <p>${STANDING_WORDS()[standing]}</p>
        ${
            reason
                ? html`<blockquote class="report-reason">${reason}</blockquote>`
                : html`<p class="null-sub">${t('block.no-reason-given', 'You gave no reason.')}</p>`
        }
        <p class="null-sub">
            ${t('block.nothing-of-theirs-here', 'Nothing of theirs is kept on your computers while they are blocked.')}
        </p>
        <button class="ledger-block ledger-blocked" onClick=${() => setOpen(true)}>
            ${t('block.change-or-unblock', 'change or unblock')}
        </button>
        ${
            open &&
            html`<${BlockModal}
                myRoot=${myRoot}
                theirRoot=${theirRoot}
                facts=${facts}
                put=${put}
                onClose=${() => setOpen(false)}
            />`
        }
    </div>`;
};
