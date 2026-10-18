// The publish bar (PUBLISH.md slice 3; Curtis, 2026-09-03: "its own row, a whole bar between title
// and editor"): wears the document's standing - gray private, teal live, peach scheduled - and holds
// the verbs: publish, update (whenever the words differ - posts edit forever), unpublish (a takedown; for a
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
//
// Bought in the Market (plans/UNLOCKS.md): publishing is Social's, an update to a published post
// is Public post editing's, and choosing who a sealed post is for is Sealed posts & audiences'.
// Taking a post down,
// or cancelling a schedule, is never for sale - so a published post's bar shows whatever is owned.
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';

import { t } from '../i18n.js';
import { holdDoc, openMirror, optimisticDoc, useLive } from '../mirror.js';
import { BakeModal } from './publish.js';
import {
    docStatus,
    isScheduled,
    publishedState,
    publishedSettled,
    scheduledSettled,
    unpublishedSettled,
    unscheduledSettled,
    withoutPublication,
    withoutSchedule,
    withPublished,
    withScheduled,
} from '../pure/feed.js';
import { Modal } from '../modal.js';
import { api } from '../net.js';
import { Icons } from '../icons.js';
import { groupPostHref, postHref } from '../links.js';
import { groupFeeds } from '../pure/groups.js';
import { choiceOfDraft, groupOfChoice, publishWishes } from '../pure/audience.js';
import { tagCounts } from '../pure/contacttags.js';
import { AudienceSelect } from '../audience.js';
import { formatWhen } from '../pure/when.js';
import { useUnlocked } from '../unlocks.js';

const html = htm.bind(h);

// Where it goes (Curtis, 2026-10-16: "post to", everyone or any of the feed's lists or groups): one
// select, the feed composer's own (audience.js), in place of the "trusted only" box. A group as a
// destination (plans/GROUPS.md, slice 4c): a surface that can post its words to a group passes
// `publishToGroup(group, wishes)` - save, then post - and the bar offers your groups beside the
// rest, says which group a draft went to, and updates or takes it down there. `mentions`: the
// surface publishes words, which can mention people - a drawing can't.
export const PublishBar = ({
    root,
    docId,
    row,
    publish,
    differs,
    diffHref,
    onPublished,
    publishToGroup,
    mentions = false,
}) => {
    const [wishes, setWishes] = useState({ settled: false });
    // Where it goes, starting where the draft stands: the list its last publish named, or a copy
    // of a sealed post's seal (copyinto.js). Whatever the select shows is the word, sent below.
    const fields = row && row.fields;
    const standingChoice = choiceOfDraft(fields);
    const [choice, setChoice] = useState(standingChoice);
    useEffect(() => setChoice(standingChoice), [standingChoice]);
    const [publishing, setPublishing] = useState(false);
    const [baking, setBaking] = useState(null);
    const [publishNote, setPublishNote] = useState(null); // { kind: 'published' | 'scheduled' | 'date-kept' | 'unpublished' | 'unscheduled', at }
    const [publishError, setPublishError] = useState(null);
    const [askingTakedown, setAskingTakedown] = useState(false);
    const social = useUnlocked(root, 'social');
    const editing = useUnlocked(root, 'post-editing');
    const sealing = useUnlocked(root, 'sealing');
    // A sealed draft without the unlock keeps its own seal and no other (UNLOCKS.md).
    const fixed = sealing ? '' : standingChoice;
    const contacts = useLive(() => (root ? openMirror(root).contacts.toArray() : []), [root]);
    const tags = tagCounts(contacts || []).map((c) => c.value);
    const standing = docStatus(row);
    // Your groups, and the ones this draft is already posted in.
    const [groups, setGroups] = useState([]);
    const [postedIn, setPostedIn] = useState([]);
    const [groupTurn, setGroupTurn] = useState(0);
    const dest = groupOfChoice(choice);
    // Whether this surface posts to groups at all - never the function itself, a new one each
    // render, which as a dependency would ask again on every one.
    const canGroup = !!publishToGroup;
    useEffect(() => {
        if (!canGroup || !root || !docId) return undefined;
        let live = true;
        api(`/api/identity/${root}/groups`)
            .then((rows) => live && setGroups(groupFeeds(rows)))
            .catch(() => {});
        api(`/api/identity/${root}/docs/${docId}/groups`)
            .then((rows) => live && setPostedIn(rows || []))
            .catch(() => {});
        return () => {
            live = false;
        };
    }, [canGroup, root, docId, groupTurn]);
    // A schedule to a group names it on the plan.
    const plannedGroup = (() => {
        try {
            return (row && row.fields && JSON.parse(row.fields.publish_plan || '{}').group) || null;
        } catch {
            return null;
        }
    })();
    const inGroup = postedIn[0] || null;
    const toGroup = (inGroup && inGroup.group) || plannedGroup || dest || null;
    const postId = publishedState(row).postId;
    // Why the draft's last plan wasn't posted, when its day refused it.
    const refusedPlan = (row && row.fields && (row.fields.publish_refused || '').trim()) || null;
    // What a publish's answer says, for the bar's note: scheduled, published, or published with
    // the date it already carried (a live post, which a future date can't take back).
    const noteOf = (made) =>
        made && made.scheduled_for
            ? { kind: 'scheduled', at: made.scheduled_for }
            : made && made.date_kept
              ? { kind: 'date-kept' }
              : { kind: 'published' };
    const scheduledAt = (() => {
        if (!isScheduled(row)) return null;
        try {
            return JSON.parse(row.fields.publish_plan).at;
        } catch {
            return null;
        }
    })();
    // "update" whenever the words differ from the public version: posts edit forever (2026-10-02;
    // it was offered only for a day after publication).

    const publishNow = async () => {
        setPublishing(true);
        setPublishError(null);
        setPublishNote(null);
        if (toGroup && publishToGroup) {
            try {
                const made = await publishToGroup(toGroup, { settled: wishes.settled });
                setPublishNote(noteOf(made));
                setChoice('');
                setGroupTurn((n) => n + 1);
                if (onPublished) onPublished();
            } catch (e) {
                setPublishError(e.message);
            } finally {
                setPublishing(false);
            }
            return;
        }
        try {
            const asked =
                standing === 'private'
                    ? {
                          ...(wishes.settled ? { settled: true } : {}),
                          ...publishWishes(choice, fields),
                      }
                    : {};
            const extra = Object.keys(asked).length > 0 ? asked : undefined;
            const made = await publish(extra, setBaking);
            // The bar turns at once (2026-10-01): the answer said what the mirror will, so the row
            // wears it now and the stream settles it (pure/optimistic.js).
            if (made && made.scheduled_for) {
                await holdDoc(
                    root,
                    docId,
                    (r) => withScheduled(r, made.scheduled_for),
                    scheduledSettled,
                );
            } else if (made && made.post_id) {
                await holdDoc(
                    root,
                    docId,
                    (r) => withPublished(r, made.post_id),
                    publishedSettled(made.post_id),
                );
            }
            setPublishNote(noteOf(made));
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
            await optimisticDoc(root, docId, withoutPublication, unpublishedSettled, () =>
                api(`/api/identity/${root}/posts/${postId}`, { method: 'DELETE' }),
            );
            setPublishNote({ kind: 'unpublished' });
        } catch (e) {
            setPublishError(e.message);
        } finally {
            setPublishing(false);
            setAskingTakedown(false);
        }
    };
    const takeDownFromGroup = async () => {
        setPublishing(true);
        setPublishError(null);
        try {
            await api(
                `/api/identity/${root}/groups/${inGroup.group}/docs/${inGroup.post}/retract`,
                {
                    method: 'POST',
                },
            );
            setPublishNote({ kind: 'unpublished' });
            setGroupTurn((n) => n + 1);
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
            await optimisticDoc(root, docId, withoutSchedule, unscheduledSettled, () =>
                api(`/api/identity/${root}/docs/${docId}/annotations/fields/publish_plan`, {
                    method: 'DELETE',
                }),
            );
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
                  when: scheduledAt ? formatWhen(scheduledAt) : '…',
              })
            : standing === 'public'
              ? t('doc.editor.live-on-your-public-feed', 'live on your public feed')
              : inGroup
                ? t('doc.editor.posted-in-group', 'posted in {group}', { group: inGroup.name })
                : t('doc.editor.private', 'private');
    const noteWords = (note) =>
        note.kind === 'date-kept'
            ? t(
                  'doc.editor.date-kept',
                  'published - it was already live, so it keeps its date rather than waiting for a future one',
              )
            : note.kind === 'scheduled'
              ? t('doc.editor.scheduled-for-2', 'scheduled for {when}', {
                    when: formatWhen(note.at),
                })
              : note.kind === 'unpublished'
                ? t('doc.editor.taken-down---it-leaves', 'taken down')
                : note.kind === 'unscheduled'
                  ? t('doc.editor.schedule-cancelled', 'schedule cancelled')
                  : t('doc.editor.published', 'published');

    // Nothing published and nothing to publish with: no bar at all.
    if (standing === 'private' && !social && !inGroup && !(publishToGroup && groups.length > 0))
        return null;
    return html`<div
        class=${
            standing === 'scheduled'
                ? 'publish-bar publish-bar-scheduled'
                : standing === 'public'
                  ? 'publish-bar publish-bar-public'
                  : 'publish-bar publish-bar-private'
        }
    >
        <span class="publish-bar-standing">
            <${standing === 'scheduled' ? Icons.scheduled : standing === 'public' ? Icons.docPublic : Icons.docPrivate} />
            ${standingWords()}
        </span>
        <span class="publish-bar-acts">
        ${
            standing === 'private' &&
            inGroup &&
            html`<a
                class="publish-bar-view jag-line"
                href=${groupPostHref(inGroup.group, inGroup.post)}
                title=${t('doc.editor.open-the-group-post', 'open the post, in the group it was posted in')}
            ><${Icons.group} /> ${t('doc.editor.view', 'view')}</a>
            <button
                class="publish-bar-update jag-line"
                disabled=${publishing}
                title=${t('doc.editor.post-your-changes-to-the-group', 'post your changes to the group')}
                onClick=${publishNow}
            ><${Icons.update} /> ${publishing ? t('doc.editor.publishing', 'publishing…') : t('doc.editor.update', 'update')}</button>
            <button
                class="publish-bar-unpublish jag-line"
                disabled=${publishing}
                title=${t('doc.editor.take-it-down-from-the-group', 'take it down from the group')}
                onClick=${() => setAskingTakedown(true)}
            ><${Icons.unpublish} /> ${t('doc.editor.unpublish', 'unpublish')}</button>`
        }
        ${
            standing === 'private' &&
            !inGroup &&
            (sealing || fixed || groups.length > 0) &&
            html`<label class="publish-bar-wish">
                ${t('doc.editor.post-to', 'post to')}
                <${AudienceSelect}
                    className="publish-bar-dest jag-field"
                    title=${t('doc.editor.where-it-goes-2', 'who it goes to: everyone, the people you choose, or one of your groups')}
                    value=${choice}
                    onChange=${setChoice}
                    sealing=${sealing}
                    fixed=${fixed}
                    tags=${tags}
                    groups=${groups}
                    mentions=${mentions}
                />
            </label>`
        }
        ${
            standing === 'private' &&
            !inGroup &&
            html`<label class="publish-bar-wish" title=${t('doc.editor.settled-means', 'turn off comments')}>
                <input
                    type="checkbox"
                    checked=${wishes.settled}
                    onChange=${(e) => setWishes((w) => ({ ...w, settled: e.currentTarget.checked }))}
                />
                ${t('doc.editor.turn-off-rebroadcast-and-comment', 'turn off comments')}
            </label>`
        }
            ${
                standing === 'private' &&
                !inGroup &&
                html`<button
                class="publish-bar-publish jag-line"
                disabled=${publishing}
                title=${t('doc.editor.publish---makes-this-content', 'publish')}
                onClick=${publishNow}
            ><${Icons.docPublic} /> ${publishing ? t('doc.editor.publishing', 'publishing…') : t('doc.editor.publish', 'publish')}</button>`
            }
            ${
                standing === 'public' &&
                html`<a
                class="publish-bar-view jag-line"
                href=${postHref(root, postId)}
                title=${t('doc.editor.open-the-public-version', 'open the public version')}
            ><${Icons.docPublic} /> ${t('doc.editor.view', 'view')}</a>`
            }
            ${
                standing === 'public' &&
                editing &&
                differs &&
                diffHref &&
                html`<a
                class="publish-bar-diff jag-line"
                href=${diffHref}
                title=${t('doc.editor.what-differs-between-these-words', 'what differs between these words and the public version')}
            ><${Icons.conflict} /> ${t('doc.editor.diff', 'diff')}</a>`
            }
            ${
                standing === 'public' &&
                editing &&
                differs &&
                html`<button
                class="publish-bar-update jag-line"
                disabled=${publishing}
                title=${t('doc.editor.make-your-changes-public', 'make your changes public')}
                onClick=${publishNow}
            ><${Icons.update} /> ${publishing ? t('doc.editor.publishing', 'publishing…') : t('doc.editor.update', 'update')}</button>`
            }
            ${
                standing === 'public' &&
                html`<button
                class="publish-bar-unpublish jag-line"
                disabled=${publishing}
                title=${t('doc.editor.take-this-post-back-off', 'take this post back off the network')}
                onClick=${() => setAskingTakedown(true)}
            ><${Icons.unpublish} /> ${t('doc.editor.unpublish', 'unpublish')}</button>`
            }
            ${
                standing === 'scheduled' &&
                html`${
                    social &&
                    html`<button
                    class="publish-bar-update jag-line"
                    disabled=${publishing}
                    title=${t('doc.editor.re-read-the-date-and', 'publish, or reschedule')}
                    onClick=${publishNow}
                ><${Icons.update} /> ${publishing ? t('doc.editor.publishing', 'publishing…') : t('doc.editor.update', 'update')}</button>`
                }
                <button
                    class="publish-bar-unpublish jag-line"
                    disabled=${publishing}
                    title=${t('doc.editor.cancel-the-schedule---the', 'cancel the schedule - the words stay private')}
                    onClick=${cancelSchedule}
                ><${Icons.unpublish} /> ${t('doc.editor.cancel', 'cancel')}</button>`
            }
        </span>
        ${
            publishNote &&
            html`<span class="publish-bar-note">
            ${noteWords(publishNote)}
        </span>`
        }
        ${publishError && html`<span class="publish-bar-error">${publishError}</span>`}
        ${
            /* A plan its day refused (plans/ONE_PUBLISH.md, ruling 3): spent, and the draft says
            why until it's published or scheduled again. */ ''
        }
        ${
            refusedPlan &&
            !publishError &&
            html`<span class="publish-bar-error">
                ${t('doc.editor.not-posted-on-its-day', 'not posted on its day: {why}', { why: refusedPlan })}
            </span>`
        }
        ${
            askingTakedown &&
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
                <button class="feed-unpublish-go jag-line" disabled=${publishing} onClick=${inGroup ? takeDownFromGroup : takeDown}>
                    ${publishing ? t('doc.editor.taking-it-down', 'taking it down…') : t('doc.editor.yes-take-it-down', 'yes, take it down')}
                </button>
                <button class="feed-unpublish-no" disabled=${publishing} onClick=${() => setAskingTakedown(false)}>
                    ${t('doc.editor.keep-it', 'keep it')}
                </button>
            </div>
        </${Modal}>`
        }
        <${BakeModal} items=${baking} />
    </div>`;
};
