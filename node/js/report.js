// Reporting a post (plans/MODERATION.md, _Reports_; node/src/reports.rs): a chip on anyone else's
// post, and the form it opens.
//
// 1. **Protect at once.** The post is hidden on this persona's own devices, and its author blocked
//    if they ask, before anything is sent - the part of "timely" that can always be kept.
// 2. **Send to the moderators you trust**: the people ticked to moderate for you, @official unless
//    you unticked it. The report carries the author's own signed version of the post, never words
//    or pictures of yours.
// 3. **Say what happened**, moderator by moderator: sent, doesn't take reports, couldn't be
//    reached. A bounce is the whole answer.
//
// "A child is being sexually abused or exploited" is its own choice, because sending the picture
// would be distributing it: it sends only where the post is, and says where to report it. Only
// moderators who trust the reporter take it (reports.rs): to everyone else it bounces, so the
// hotlines come first.
import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { t } from './i18n.js';
import { Icons } from './icons.js';
import { Chip } from './doc/chips.js';
import { Modal } from './modal.js';
import { PersonInline } from './person.js';
import { copyLink } from './links.js';
import { ReasonInput, moderationMoved, useModeration } from './moderation.js';
import { Hotlines } from './servermoderation.js';
import { MAX_REASON_BYTES, hiddenKey, reasonBytes } from './pure/moderation.js';

const html = htm.bind(h);

const HIDDEN = 'hidden_posts';

/// What each moderator's node said, in words.
const OUTCOME_WORDS = () => ({
    sent: t('report.sent-to', 'sent to'),
    'not-taking': t('report.doesnt-take-reports', "doesn't take reports:"),
    refused: t('report.refused-by', 'refused by the server of'),
    unreachable: t('report.couldnt-reach', "couldn't reach, right now:"),
});

/// A child-abuse report bounces from anyone who doesn't trust the reporter (reports.rs), so a
/// bounce there says that, not that they take no reports.
const CHILD_OUTCOME_WORDS = () => ({
    ...OUTCOME_WORDS(),
    'not-taking': t(
        'report.takes-this-only-from-people-they-trust',
        'takes this only from people they trust:',
    ),
});

/// Hide the post here, and block its author if asked: never waits on anyone else.
async function protect(root, item, block) {
    await api(`/api/identity/${root}/private/set/${HIDDEN}`, {
        method: 'POST',
        body: JSON.stringify({ element: hiddenKey(item.author, item.doc_id) }),
    });
    if (block) {
        await api(`/api/identity/${root}/private/kv/contact:${item.author}/blocked`, {
            method: 'PUT',
            body: JSON.stringify({ value: 'yes' }),
        });
    }
    moderationMoved(root);
}

const Results = ({ sent, current, child }) =>
    sent.length
        ? html`<ul class="report-results">
              ${sent.map(
                  (s) => html`<li key=${s.moderator}>
                      ${(child ? CHILD_OUTCOME_WORDS() : OUTCOME_WORDS())[s.outcome] || s.outcome}
                      <${PersonInline} root=${s.moderator} current=${current} />
                  </li>`,
              )}
          </ul>`
        : html`<p class="null-sub">
              ${t('report.nobody-to-send-it-to', "You don't trust anyone to moderate for you, so it went nowhere - the post is hidden here, which no one else can undo.")}
          </p>`;

const ChildAbuse = ({ item }) => {
    const [copied, setCopied] = useState(false);
    const path = `/ringtome/user/${item.author}/post/${item.doc_id}`;
    return html`<div class="report-child">
        <p><strong>${t('report.dont-send-it', "Don't screenshot, save or forward it - not even to report it. Sending a picture of a child being abused is distributing it.")}</strong></p>
        <p>${t('report.where-to-report', "Report it where you live. Send the post's address, not the picture:")}</p>
        <${Hotlines} />
        <button
            class="removal-option"
            onClick=${async () => {
                try {
                    await copyLink(path);
                    setCopied(true);
                } catch {
                    /* clipboard denied: no false "copied" */
                }
            }}
        >${copied ? t('chips.copied', 'copied') : t('report.copy-the-posts-address', "copy the post's address")}</button>
        <p class="null-sub">${t('report.child-sends-only-the-reference', 'A hotline can look at it, and nobody here can. It will be hidden here and the author blocked. Moderators who trust you get the location of the post, not the picture, and take it down on their own servers.')}</p>
    </div>`;
};

export const ReportModal = ({ item, current, onClose }) => {
    const root = current && current.root;
    const moderators = useModeration(root).moderators || [];
    const [child, setChild] = useState(false);
    const [reason, setReason] = useState('');
    const [block, setBlock] = useState(false);
    const [busy, setBusy] = useState(false);
    const [sent, setSent] = useState(null);
    const [error, setError] = useState('');
    const send = async () => {
        setError('');
        setBusy(true);
        try {
            await protect(root, item, block || child);
            const r = await api(`/api/identity/${root}/reports`, {
                method: 'POST',
                body: JSON.stringify({
                    kind: 'persona',
                    target: item.author,
                    reason: reason.trim(),
                    child_abuse: child,
                    item: { author: item.author, doc_id: item.doc_id },
                }),
            });
            setSent(r.sent || []);
        } catch (e) {
            setError(e.message || String(e));
        } finally {
            setBusy(false);
        }
    };
    return html`<${Modal} title=${t('report.report-this-post', 'Report this post')} onClose=${onClose}>
        ${
            sent
                ? html`${child && html`<${ChildAbuse} item=${item} />`}
                      <${Results} sent=${sent} current=${current} child=${child} />
                      <button class="removal-go" onClick=${onClose}>${t('report.done', 'done')}</button>`
                : html`<div class="report-form">
                      <p class="null-sub">
                          ${t('report.what-a-report-does', 'The post is hidden from you at once. Then the people you trust to moderate for you are asked to consider it for their list, with the post exactly as its author signed it:')}
                      </p>
                      ${
                          moderators.length
                              ? html`<ul class="report-moderators">
                                    ${moderators.map((m) => html`<li key=${m}><${PersonInline} root=${m} current=${current} /></li>`)}
                                </ul>`
                              : html`<p class="null-sub">${t('report.you-trust-nobody-to-moderate', "You don't trust anyone to moderate for you - it will only be hidden here.")}</p>`
                      }
                      <label class="profile-setting">
                          <input type="radio" name="report-kind" checked=${!child} onChange=${() => setChild(false)} />
                          ${t('report.something-else', "it's spam, abuse, or something else that shouldn't be here")}
                      </label>
                      <label class="profile-setting">
                          <input type="radio" name="report-kind" checked=${child} onChange=${() => setChild(true)} />
                          ${t('report.a-child-is-being-abused', 'a child is being sexually abused or exploited')}
                      </label>
                      ${
                          child
                              ? html`<${ChildAbuse} item=${item} />`
                              : html`<${ReasonInput}
                                        wide
                                        value=${reason}
                                        placeholder=${t('report.reason-placeholder', 'why - your moderators see this')}
                                        onInput=${setReason}
                                    />
                                    <label class="profile-setting">
                                        <input type="checkbox" checked=${block} onChange=${(e) => setBlock(e.currentTarget.checked)} />
                                        ${t('report.block-them-too', 'block them too')}
                                    </label>`
                      }
                      ${error && html`<p class="form-error">${error}</p>`}
                      <button
                          class="removal-go"
                          disabled=${busy || reasonBytes(reason) > MAX_REASON_BYTES}
                          onClick=${send}
                      >${busy ? t('report.sending', 'sending…') : t('report.report-it', 'report it')}</button>
                  </div>`
        }
    </${Modal}>`;
};

/// Report a whole server to the moderators you trust (plans/NODE_PAGE.md): from its page, with a
/// reason. Nothing to hide here first - a server isn't a post - and no child-abuse choice: that's
/// about a post, from the post.
export const NodeReportModal = ({ endpoint, name, current, onClose }) => {
    const root = current && current.root;
    const moderators = useModeration(root).moderators || [];
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    const [sent, setSent] = useState(null);
    const [error, setError] = useState('');
    const send = async () => {
        setError('');
        setBusy(true);
        try {
            const r = await api(`/api/identity/${root}/reports`, {
                method: 'POST',
                body: JSON.stringify({ kind: 'node', target: endpoint, reason: reason.trim() }),
            });
            setSent(r.sent || []);
        } catch (e) {
            setError(e.message || String(e));
        } finally {
            setBusy(false);
        }
    };
    return html`<${Modal} title=${t('report.report-this-server', 'Report {name}', { name })} onClose=${onClose}>
        ${
            sent
                ? html`<${Results} sent=${sent} current=${current} />
                      <button class="removal-go" onClick=${onClose}>${t('report.done', 'done')}</button>`
                : html`<div class="report-form">
                      <p class="null-sub">
                          ${t('report.what-a-server-report-does', 'The people you trust to moderate for you are asked to consider this whole server for their list:')}
                      </p>
                      ${
                          moderators.length
                              ? html`<ul class="report-moderators">
                                    ${moderators.map((m) => html`<li key=${m}><${PersonInline} root=${m} current=${current} /></li>`)}
                                </ul>`
                              : html`<p class="null-sub">${t('report.you-trust-nobody-so-nowhere', "You don't trust anyone to moderate for you, so this has nowhere to go.")}</p>`
                      }
                      <${ReasonInput}
                          wide
                          value=${reason}
                          placeholder=${t('report.reason-placeholder', 'why - your moderators see this')}
                          onInput=${setReason}
                      />
                      ${error && html`<p class="form-error">${error}</p>`}
                      <button
                          class="removal-go"
                          disabled=${busy || !moderators.length || reasonBytes(reason) > MAX_REASON_BYTES}
                          onClick=${send}
                      >${busy ? t('report.sending', 'sending…') : t('report.report-it', 'report it')}</button>
                  </div>`
        }
    </${Modal}>`;
};

/// The chip on someone else's post.
export const ReportChip = ({ item, current }) => {
    const [open, setOpen] = useState(false);
    return html`<${Chip}
            icon=${Icons.report}
            title=${t('report.report-this-post', 'Report this post')}
            word=${t('chips.report', 'report')}
            onClick=${(e) => {
                if (e) e.preventDefault();
                setOpen(true);
            }}
        />
        ${open && html`<${ReportModal} item=${item} current=${current} onClose=${() => setOpen(false)} />`}`;
};
