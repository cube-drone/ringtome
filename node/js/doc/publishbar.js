// The publish bar (PUBLISH.md slice 3; Curtis, 2026-09-03: "its own row, a whole bar between title
// and editor"): wears the document's standing - gray private, teal live, peach scheduled - and holds
// the verbs: publish, update (while the post's edit window is open), unpublish (a takedown; for a
// schedule, cancelling the plan). The same door the feed uses, with the same two wishes at first
// publish.
//
// Shared by Writer's editor and the drawing surface (Curtis, 2026-09-26: "the publication bar should
// work and look the same in both"), so it knows nothing of what is being published. Each surface
// brings its own:
//
//   `publish(extra, setBaking)` - save, then publish through its door; resolves to the door's answer
//                                 (`scheduled_for` when the date was a future one)
//   `differs`                   - whether the private version has changed since the public one,
//                                 which is what offers "update" (and "diff", given `diffHref`)
//   `onPublished()`             - told after every publish, to re-read whatever `differs` reads
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';

import { t } from '../i18n.js';
import { BakeModal } from './publish.js';
import { docStatus, isScheduled, publishedState } from '../pure/feed.js';
import { Modal } from '../modal.js';
import { api } from '../net.js';
import { Icons } from '../icons.js';

const html = htm.bind(h);

export const PublishBar = ({ root, docId, row, publish, differs, diffHref, onPublished }) => {
    const [wishes, setWishes] = useState({ settled: false, trusted_only: false });
    // A draft's own seal wish - a copy of a sealed post (copyinto.js) - ticks the box before the
    // first publish; unticking it is the word, sent outright below.
    const wishedSeal = !!(row && row.fields && row.fields.seal === 'yes');
    useEffect(() => {
        if (wishedSeal) setWishes((w) => ({ ...w, trusted_only: true }));
    }, [wishedSeal]);
    const [publishing, setPublishing] = useState(false);
    const [baking, setBaking] = useState(null);
    const [publishNote, setPublishNote] = useState(null); // { kind: 'published' | 'scheduled' | 'unpublished' | 'unscheduled', at }
    const [publishError, setPublishError] = useState(null);
    const [askingTakedown, setAskingTakedown] = useState(false);
    const standing = docStatus(row);
    const postId = publishedState(row).postId;
    const scheduledAt = (() => {
        if (!isScheduled(row)) return null;
        try {
            return JSON.parse(row.fields.publish_plan).at;
        } catch {
            return null;
        }
    })();
    // The post's edit window, asked of the permalink (the server is the one who knows): "update" is
    // offered only while a re-publication would still be honoured.
    const [windowOpen, setWindowOpen] = useState(null);
    const [published, setPublished] = useState(0);
    useEffect(() => {
        if (standing !== 'public' || !postId) {
            setWindowOpen(null);
            return undefined;
        }
        let live = true;
        api(`/api/id/${root}/posts/${postId}`)
            .then((head) => live && setWindowOpen(head.edit_window_open !== false))
            .catch(() => live && setWindowOpen(true)); // unknown: offer it, the door refuses honestly
        return () => {
            live = false;
        };
    }, [root, postId, standing, published]);

    const publishNow = async () => {
        setPublishing(true);
        setPublishError(null);
        setPublishNote(null);
        try {
            const extra =
                standing === 'private' && (wishes.settled || wishes.trusted_only)
                    ? {
                          ...(wishes.settled ? { settled: true } : {}),
                          trusted_only: wishes.trusted_only,
                      }
                    : undefined;
            const made = await publish(extra, setBaking);
            setPublishNote(made && made.scheduled_for ? { kind: 'scheduled', at: made.scheduled_for } : { kind: 'published' });
            setPublished((n) => n + 1);
            if (onPublished) onPublished();
        } catch (e) {
            setPublishError(e.message);
        } finally {
            setPublishing(false);
        }
    };
    const takeDown = async () => {
        setPublishing(true);
        setPublishError(null);
        try {
            await api(`/api/identity/${root}/posts/${postId}`, { method: 'DELETE' });
            setPublishNote({ kind: 'unpublished' });
        } catch (e) {
            setPublishError(e.message);
        } finally {
            setPublishing(false);
            setAskingTakedown(false);
        }
    };
    const cancelSchedule = async () => {
        setPublishing(true);
        setPublishError(null);
        try {
            await api(`/api/identity/${root}/docs/${docId}/annotations/fields/publish_plan`, { method: 'DELETE' });
            setPublishNote({ kind: 'unscheduled' });
        } catch (e) {
            setPublishError(e.message);
        } finally {
            setPublishing(false);
        }
    };

    // The words for the bar's standing and its last note, chosen out here: inside the template, a
    // string comparison reads to the strings cop as copy.
    const standingWords = () =>
        standing === 'scheduled'
            ? t('doc.editor.scheduled-for', 'scheduled for {when}', {
                  when: scheduledAt ? new Date(scheduledAt).toLocaleString() : '…',
              })
            : standing === 'public'
              ? t('doc.editor.live-on-your-public-feed', 'live on your public feed')
              : t('doc.editor.private', 'private');
    const noteWords = (note) =>
        note.kind === 'scheduled'
            ? t('doc.editor.scheduled-for-2', 'scheduled for {when}', { when: new Date(note.at).toLocaleString() })
            : note.kind === 'unpublished'
              ? t('doc.editor.taken-down---it-leaves', 'taken down')
              : note.kind === 'unscheduled'
                ? t('doc.editor.schedule-cancelled', 'schedule cancelled')
                : t('doc.editor.published', 'published');

    return html`<div
        class=${standing === 'scheduled'
            ? 'publish-bar publish-bar-scheduled'
            : standing === 'public'
              ? 'publish-bar publish-bar-public'
              : 'publish-bar publish-bar-private'}
    >
        <span class="publish-bar-standing">
            <${standing === 'scheduled' ? Icons.scheduled : standing === 'public' ? Icons.docPublic : Icons.docPrivate} />
            ${standingWords()}
        </span>
        <span class="publish-bar-acts">
        ${standing === 'private' &&
        html`<label class="publish-bar-wish" title=${t('doc.editor.settled-means', 'turn off comments')}>
                <input
                    type="checkbox"
                    checked=${wishes.settled}
                    onChange=${(e) => setWishes((w) => ({ ...w, settled: e.currentTarget.checked }))}
                />
                ${t('doc.editor.turn-off-rebroadcast-and-comment', 'turn off comments')}
            </label>
            <label class="publish-bar-wish" title=${t('doc.editor.trusted-only-means', 'the words go only to readers you have published trust for - everyone else sees the title, the date, and that a post exists')}>
                <input
                    type="checkbox"
                    checked=${wishes.trusted_only}
                    onChange=${(e) => setWishes((w) => ({ ...w, trusted_only: e.currentTarget.checked }))}
                />
                ${t('doc.editor.trusted-only', 'trusted only')}
            </label>`}
            ${standing === 'private' &&
            html`<button
                class="publish-bar-publish"
                disabled=${publishing}
                title=${t('doc.editor.publish---makes-this-content', 'publish')}
                onClick=${publishNow}
            ><${Icons.docPublic} /> ${publishing ? t('doc.editor.publishing', 'publishing…') : t('doc.editor.publish', 'publish')}</button>`}
            ${standing === 'public' &&
            html`<a
                class="publish-bar-view"
                href=${`/id/${root}/post/${postId}`}
                title=${t('doc.editor.open-the-public-version', 'open the public version')}
            ><${Icons.docPublic} /> ${t('doc.editor.view', 'view')}</a>`}
            ${standing === 'public' &&
            differs &&
            diffHref &&
            html`<a
                class="publish-bar-diff"
                href=${diffHref}
                title=${t('doc.editor.what-differs-between-these-words', 'what differs between these words and the public version')}
            ><${Icons.conflict} /> ${t('doc.editor.diff', 'diff')}</a>`}
            ${standing === 'public' &&
            differs &&
            windowOpen !== false &&
            html`<button
                class="publish-bar-update"
                disabled=${publishing}
                title=${t('doc.editor.make-your-changes-public', 'make your changes public')}
                onClick=${publishNow}
            ><${Icons.update} /> ${publishing ? t('doc.editor.publishing', 'publishing…') : t('doc.editor.update', 'update')}</button>`}
            ${standing === 'public' &&
            differs &&
            windowOpen === false &&
            html`<button
                class="publish-bar-update"
                disabled=${true}
                title=${t('doc.editor.this-document-was-published-over', 'posts can only be edited for a day')}
            ><${Icons.update} /> ${t('doc.editor.update', 'update')}</button>`}
            ${standing === 'public' &&
            html`<button
                class="publish-bar-unpublish"
                disabled=${publishing}
                title=${t('doc.editor.take-this-post-back-off', 'take this post back off the network')}
                onClick=${() => setAskingTakedown(true)}
            ><${Icons.unpublish} /> ${t('doc.editor.unpublish', 'unpublish')}</button>`}
            ${standing === 'scheduled' &&
            html`<button
                    class="publish-bar-update"
                    disabled=${publishing}
                    title=${t('doc.editor.re-read-the-date-and', 'publish, or reschedule')}
                    onClick=${publishNow}
                ><${Icons.update} /> ${publishing ? t('doc.editor.publishing', 'publishing…') : t('doc.editor.update', 'update')}</button>
                <button
                    class="publish-bar-unpublish"
                    disabled=${publishing}
                    title=${t('doc.editor.cancel-the-schedule---the', 'cancel the schedule - the words stay private')}
                    onClick=${cancelSchedule}
                ><${Icons.unpublish} /> ${t('doc.editor.cancel', 'cancel')}</button>`}
        </span>
        ${publishNote &&
        html`<span class="publish-bar-note">
            ${noteWords(publishNote)}
        </span>`}
        ${publishError && html`<span class="publish-bar-error">${publishError}</span>`}
        ${askingTakedown &&
        html`<${Modal}
            title=${t('doc.editor.take-it-down', 'take it down')}
            onClose=${() => {
                if (!publishing) setAskingTakedown(false);
            }}
        >
            <p class="feed-unpublish-warn">
                ${t('doc.editor.this-removes-it-from-other', 'It may take a while to disappear everywhere.')}
            </p>
            <div class="feed-unpublish-acts">
                <button class="feed-unpublish-go" disabled=${publishing} onClick=${takeDown}>
                    ${publishing ? t('doc.editor.taking-it-down', 'taking it down…') : t('doc.editor.yes-take-it-down', 'yes, take it down')}
                </button>
                <button class="feed-unpublish-no" disabled=${publishing} onClick=${() => setAskingTakedown(false)}>
                    ${t('doc.editor.keep-it', 'keep it')}
                </button>
            </div>
        </${Modal}>`}
        <${BakeModal} items=${baking} />
    </div>`;
};
