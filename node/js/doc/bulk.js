// The bulk panel (plans/BULK.md): what the right column shows while documents are selected, in
// place of the one open document - delete them all, move them all, tag and untag them all, date
// them all, and for the sounds among them their fields and cover.
//
// Every action is one request per document on the routes the single-document surfaces use, four at
// a time (`runEach`), counted on the panel as it goes and summed up in a toast at the end. The
// decisions - what each action touches, what a move leaves - are values in pure/bulk.js; this module
// is the writes and the drawing.
import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';

import { api } from '../net.js';
import { openMirror, optimisticDoc, useLive } from '../mirror.js';
import { toast } from '../toasts.js';
import { useUnlocked } from '../unlocks.js';
import { fileIntoTree, unfileFromTree } from './tree.js';
import { ImagePickModal } from './imagepick.js';
import { DrawingThumb, flattenToBlob } from './drawing.js';
import { readBody } from '../pure/drawing.js';
import { DISPLAY_DATE_FIELD, joinClaimed } from '../pure/docdate.js';
import { normalTag } from '../pure/annotations.js';
import { DEFAULT_STYLE } from '../pure/apps.js';
import {
    BULK_SOUND_FIELDS,
    actionable,
    carrying,
    combinedTags,
    lacking,
    moveOutOf,
    moveTargets,
    newNotebookName,
    soundsAmong,
} from '../pure/bulk.js';
import { Icons } from '../icons.js';
import { t } from '../i18n.js';

const html = htm.bind(h);

/// How many requests an action keeps in flight: enough that forty documents take a moment, few
/// enough that the node isn't asked for a hundred chain writes at once.
const AT_ONCE = 4;

/// The sound fields' words, as the sound's own list says them (doc/soundtags.js).
const SOUND_FIELD_NAMES = {
    artist: () => t('doc.soundtags.artist', 'artist'),
    album: () => t('doc.soundtags.album', 'album'),
    'album artist': () => t('doc.soundtags.album-artist', 'album artist'),
    composer: () => t('doc.soundtags.composer', 'composer'),
    genre: () => t('doc.soundtags.genre', 'genre'),
    year: () => t('doc.soundtags.year', 'year'),
};

/// Write to every one of `docs`, `AT_ONCE` at a time, calling `onStep(done)` after each; resolves
/// to the ones that failed, each with its error. Never rejects: one failure doesn't stop the rest.
async function runEach(docs, write, onStep) {
    let next = 0;
    let done = 0;
    const failed = [];
    const worker = async () => {
        while (next < docs.length) {
            const d = docs[next++];
            try {
                await write(d);
            } catch (e) {
                failed.push({ doc: d, error: e });
            }
            onStep(++done);
        }
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, docs.length) }, worker));
    return failed;
}

const fieldUrl = (root, docId, field) =>
    `/api/identity/${root}/docs/${docId}/annotations/fields/${encodeURIComponent(field)}`;
/// An empty value clears the field: an absent value is how LWW says "no longer set".
const writeField = (root, docId, field, value) =>
    value === ''
        ? api(fieldUrl(root, docId, field), { method: 'DELETE' })
        : api(fieldUrl(root, docId, field), { method: 'PUT', body: JSON.stringify({ value }) });

/**
 * @param docs      the selected documents' mirror rows
 * @param bucket    the notebook in view ('' in hrseFiles, which views them all)
 * @param onClear   drop the selection
 * @param onDeleted after a delete, with the ids that went (the open one among them closes)
 * @param moves     whether "move all to" shows: hrseAmp leaves it out (Curtis, 2026-10-12: notebooks
 *                  are another app's business there, and it confused)
 * @param deletes   whether "delete all" shows: hrseAmp puts its own at the panel's head
 * @param head      whether its own count and "clear" show: hrseAmp's panel says them once, for its
 *                  songs and other people's together
 * @param ruled     hrseAmp's (Curtis, 2026-10-12): every one is a sound there, so a rule parts the
 *                  sound fields from the rest instead of words counting the sounds, and another
 *                  parts the tags from the date
 */
export const BulkPanel = ({
    root,
    app,
    bucket,
    docs,
    onClear,
    onDeleted,
    onMoved,
    moves = true,
    deletes = true,
    head = true,
    ruled = false,
}) => {
    const roster = useLive(() => openMirror(root).buckets.toArray(), [root]);
    const tagging = useUnlocked(root, 'tags');
    // The action under way, and how far: `{ label, done, of }`, or null when idle.
    const [running, setRunning] = useState(null);
    const [tagDraft, setTagDraft] = useState('');
    const [tagRefused, setTagRefused] = useState(null);
    const [newNotebook, setNewNotebook] = useState('');
    const [date, setDate] = useState('');
    const [time, setTime] = useState('');
    const [soundDrafts, setSoundDrafts] = useState({});
    const [choosingCover, setChoosingCover] = useState(false);

    const mine = actionable(docs);
    const sounds = soundsAmong(docs);
    const leftAlone = docs.length - mine.length;
    const busy = !!running;

    /// Run one action over `targets`, and say how it went: `done` on success ("tagged {n}"), and on
    /// any failure how many and the first reason - those stay selected, to try again.
    const run = async (label, targets, write, done) => {
        if (busy) return [];
        if (!targets.length) {
            toast(
                t(
                    'doc.bulk.nothing-to-change',
                    'nothing to change - every one is that way already',
                ),
            );
            return [];
        }
        setRunning({ label, done: 0, of: targets.length });
        const failed = await runEach(targets, write, (n) =>
            setRunning({ label, done: n, of: targets.length }),
        );
        setRunning(null);
        const ok = targets.length - failed.length;
        if (failed.length) {
            toast(
                t('doc.bulk.some-failed', '{failed} of {of} failed: {message}', {
                    failed: failed.length,
                    of: targets.length,
                    message: failed[0].error.message || String(failed[0].error),
                }),
                { kind: 'error' },
            );
        }
        if (ok) toast(done(ok));
        return failed;
    };

    // --- delete --------------------------------------------------------------------------------
    const deleteAll = async () => {
        if (
            !confirm(
                t(
                    'doc.bulk.delete-confirm',
                    'Whoa there - delete {n} documents? They leave every list right away.',
                    { n: mine.length },
                ),
            )
        )
            return;
        const failed = await run(
            t('doc.bulk.deleting', 'deleting'),
            mine,
            // Out of every list at once, back if the node refuses (pure/optimistic.js), as one
            // delete does it.
            (d) =>
                optimisticDoc(
                    root,
                    d.doc_id,
                    () => null,
                    (r) => !r,
                    () => api(`/api/identity/${root}/docs/${d.doc_id}`, { method: 'DELETE' }),
                ),
            (n) => t('doc.bulk.deleted', 'deleted {n}', { n }),
        );
        const gone = new Set(failed.map((f) => f.doc.doc_id));
        onDeleted(mine.map((d) => d.doc_id).filter((id) => !gone.has(id)));
    };

    // --- move ----------------------------------------------------------------------------------
    const moveTo = async (to, toType = null) => {
        await run(
            t('doc.bulk.moving', 'moving'),
            mine,
            async (d) => {
                const out = moveOutOf(d, roster, to, { inView: bucket || null, toType });
                // Into the new one first, so a failure between the two leaves it in both, never
                // in neither; its tree follows, as tidying - a failure there leaves it moved.
                await api(
                    `/api/identity/${root}/docs/${d.doc_id}/buckets/${encodeURIComponent(to)}`,
                    {
                        method: 'PUT',
                    },
                );
                if (out) {
                    await api(
                        `/api/identity/${root}/docs/${d.doc_id}/buckets/${encodeURIComponent(out)}`,
                        { method: 'DELETE' },
                    );
                }
                await fileIntoTree(root, to, d.doc_id).catch(() => {});
                if (out) await unfileFromTree(root, out, d.doc_id).catch(() => {});
            },
            (n) => t('doc.bulk.moved', 'moved {n} to {bucket}', { n, bucket: to }),
        );
        onMoved && onMoved();
    };
    const moveToNew = async (e) => {
        e.preventDefault();
        const { name, refused } = newNotebookName(newNotebook);
        if (refused === 'empty') return;
        if (refused === 'reserved') {
            toast(
                t(
                    'buckets.name-is-reserved',
                    '"{name}" is kept for another app - choose another name',
                    {
                        name,
                    },
                ),
                { kind: 'error' },
            );
            return;
        }
        // A notebook of this app - hrseFiles makes a writing one - unless one by that name is
        // already there, which the move simply uses.
        const style = app.everything ? DEFAULT_STYLE : app.style;
        const exists = (roster || []).some((b) => b.name === name);
        if (!exists) {
            try {
                await api(`/api/identity/${root}/buckets`, {
                    method: 'POST',
                    body: JSON.stringify({ name, app: style }),
                });
            } catch (err) {
                toast(
                    t('buckets.couldnt-create-it', "couldn't create it: {message}", {
                        message: err.message,
                    }),
                    { kind: 'error' },
                );
                return;
            }
        }
        setNewNotebook('');
        await moveTo(name, exists ? null : style);
    };

    // --- tags ----------------------------------------------------------------------------------
    const tagUrl = (d, tag) =>
        `/api/identity/${root}/docs/${d.doc_id}/annotations/tags/${encodeURIComponent(tag)}`;
    const tagAll = async (e) => {
        e.preventDefault();
        const { tag, refused } = normalTag(tagDraft);
        if (refused === 'empty') return;
        if (refused === 'emoji') {
            setTagRefused(
                t(
                    'doc.annotations.no-reacting-to-your-own',
                    "a reaction is for somebody else's post",
                ),
            );
            return;
        }
        setTagRefused(null);
        setTagDraft('');
        await run(
            t('doc.bulk.tagging', 'tagging'),
            lacking(mine, tag),
            (d) => api(tagUrl(d, tag), { method: 'PUT' }),
            (n) => t('doc.bulk.tagged', 'tagged {n} "{tag}"', { n, tag }),
        );
    };
    const untagAll = (tag) =>
        run(
            t('doc.bulk.untagging', 'untagging'),
            carrying(mine, tag),
            (d) => api(tagUrl(d, tag), { method: 'DELETE' }),
            (n) => t('doc.bulk.untagged', 'took "{tag}" off {n}', { n, tag }),
        );

    // --- date ----------------------------------------------------------------------------------
    const dateAll = (value) =>
        run(
            t('doc.bulk.dating', 'dating'),
            mine,
            (d) => writeField(root, d.doc_id, DISPLAY_DATE_FIELD, value),
            (n) =>
                value
                    ? t('doc.bulk.dated', 'dated {n}', { n })
                    : t('doc.bulk.undated', 'cleared the date on {n}', { n }),
        );

    // --- sounds --------------------------------------------------------------------------------
    const setSoundField = (field) => {
        const value = (soundDrafts[field] || '').trim();
        return run(
            t('doc.bulk.setting', 'setting'),
            sounds,
            (d) => writeField(root, d.doc_id, field, value),
            (n) =>
                t('doc.bulk.set-field', 'set {field} on {n} sounds', {
                    n,
                    field: SOUND_FIELD_NAMES[field](),
                }),
        );
    };
    // A picture lends its own thumbnail to each, by name (one blob however many wear it); a drawing
    // is flattened once, here, and the same picture sent to each - as one sound's cover does it.
    const coverAll = async (picked) => {
        setChoosingCover(false);
        let send;
        if (picked.format === 'drawing') {
            const detail = await api(`/api/identity/${root}/docs/${picked.doc}`).catch(() => null);
            if (!detail || detail.body == null) {
                toast(
                    t(
                        'doc.soundtags.drawing-not-here-yet',
                        'that drawing has not reached this computer yet - try again in a moment',
                    ),
                    { kind: 'error' },
                );
                return;
            }
            const png = await flattenToBlob(root, readBody(detail.body));
            send = (d) =>
                api(`/api/identity/${root}/docs/${d.doc_id}/thumb`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'image/png' },
                    body: png,
                });
        } else {
            send = (d) =>
                api(`/api/identity/${root}/docs/${d.doc_id}/thumb`, {
                    method: 'PUT',
                    body: JSON.stringify({ from_doc: picked.doc }),
                });
        }
        await run(t('doc.bulk.covering', 'setting covers'), sounds, send, (n) =>
            t('doc.bulk.covered', 'a new cover on {n} sounds', { n }),
        );
    };

    const targets = moveTargets(app, roster, bucket);
    const tags = combinedTags(mine);
    const progress =
        running &&
        t('doc.bulk.progress', '{label}… {done} of {of}', {
            label: running.label,
            done: running.done,
            of: running.of,
        });

    return html`<section class="reader bulk">
        ${
            head &&
            html`<header class="bulk-head">
            <h2 class="bulk-count">${t('doc.bulk.n-selected', '{n} selected', { n: docs.length })}</h2>
            <button class="bulk-clear" onClick=${onClear} title=${t('doc.bulk.clear-title', 'clear the selection (Escape)')}>
                <${Icons.close} /> ${t('doc.bulk.clear', 'clear')}
            </button>
        </header>`
        }
        ${
            leftAlone > 0 &&
            html`<p class="bulk-note">
                ${t('doc.bulk.builtin-left-alone', '{n} of them came with the app, and are left alone', { n: leftAlone })}
            </p>`
        }
        ${progress && html`<p class="bulk-progress" role="status">${progress}</p>`}

        ${
            moves &&
            html`<div class="bulk-group">
            <h3 class="bulk-heading">${t('doc.bulk.move-all', 'move all to')}</h3>
            <div class="copy-buckets">
                ${targets.map(
                    (name) =>
                        html`<button key=${name} class="copy-bucket" disabled=${busy || !mine.length} onClick=${() => moveTo(name)}>
                            ${name}
                        </button>`,
                )}
                <form class="copy-new-bucket" onSubmit=${moveToNew}>
                    <input
                        class="copy-new-input"
                        value=${newNotebook}
                        placeholder=${t('doc.bulk.a-new-notebook', '+ a new notebook')}
                        onInput=${(e) => setNewNotebook(e.currentTarget.value)}
                    />
                    <button class="copy-bucket" disabled=${busy || !newNotebook.trim() || !mine.length}>
                        ${t('doc.bulk.move', 'move')}
                    </button>
                </form>
            </div>
        </div>`
        }

        ${
            tagging &&
            html`<div class="bulk-group">
                <h3 class="bulk-heading">${t('doc.bulk.tag-all', 'tag all')}</h3>
                <form class="bulk-row" onSubmit=${tagAll}>
                    <input
                        class="bulk-input jag-field"
                        value=${tagDraft}
                        placeholder=${t('doc.bulk.a-tag', 'a tag')}
                        onInput=${(e) => setTagDraft(e.currentTarget.value)}
                    />
                    <button class="bulk-button jag-line" disabled=${busy || !tagDraft.trim()}>
                        ${t('doc.bulk.tag', 'tag')}
                    </button>
                    ${tagRefused && html`<span class="annot-tag-refused">${tagRefused}</span>`}
                </form>
            </div>`
        }
        ${
            tagging &&
            tags.length > 0 &&
            html`<div class="bulk-group">
                <h3 class="bulk-heading">${t('doc.bulk.remove-a-tag', 'remove a tag from all')}</h3>
                <div class="annot-tags">
                    ${tags.map(
                        ([tag, n]) => html`<button
                            key=${tag}
                            class="annot-tag annot-tag-active jag-line"
                            disabled=${busy}
                            title=${t('doc.bulk.remove-tag-title', 'take "{tag}" off the {n} that carry it', { tag, n })}
                            onClick=${() => untagAll(tag)}
                        >${tag} <span class="bulk-tag-count">${n}</span> ×</button>`,
                    )}
                </div>
            </div>`
        }

        <div class="bulk-group">
            ${ruled && html`<hr class="bulk-rule" />`}
            <h3 class="bulk-heading">${t('doc.bulk.date-all', 'date all')}</h3>
            <div class="bulk-row">
                <input class="annot-date jag-field" type="date" value=${date} onInput=${(e) => setDate(e.currentTarget.value)} />
                <input
                    class="annot-time jag-field"
                    type="time"
                    value=${time}
                    disabled=${!date}
                    title=${t('doc.annotations.time-optional', 'time (optional)')}
                    onInput=${(e) => setTime(e.currentTarget.value)}
                />
                <button class="bulk-button jag-line" disabled=${busy || !date || !mine.length} onClick=${() => dateAll(joinClaimed(date, time))}>
                    ${t('doc.bulk.set', 'set')}
                </button>
                <button class="bulk-button jag-line" disabled=${busy || !mine.length} onClick=${() => dateAll('')}>
                    ${t('doc.bulk.clear-dates', 'clear')}
                </button>
            </div>
        </div>

        ${
            sounds.length > 0 &&
            html`<div class="bulk-group">
                ${
                    ruled
                        ? html`<hr class="bulk-rule" />`
                        : html`<h3 class="bulk-heading">
                    ${t('doc.bulk.sounds', 'the {n} sounds among them', { n: sounds.length })}
                </h3>`
                }
                <dl class="sound-tags">
                    ${BULK_SOUND_FIELDS.map(
                        (field) => html`<div class="sound-tag" key=${field}>
                            <dt><label for=${`bulk-sound-${field.replace(/ /g, '-')}`}>${SOUND_FIELD_NAMES[field]()}</label></dt>
                            <dd class="bulk-row">
                                <input
                                    id=${`bulk-sound-${field.replace(/ /g, '-')}`}
                                    class="sound-tag-value jag-field"
                                    value=${soundDrafts[field] || ''}
                                    inputmode=${field === 'year' ? 'numeric' : undefined}
                                    placeholder=${t('doc.bulk.empty-clears', 'empty clears it')}
                                    onInput=${(e) => setSoundDrafts({ ...soundDrafts, [field]: e.currentTarget.value })}
                                />
                                <button class="bulk-button jag-line" disabled=${busy} onClick=${() => setSoundField(field)}>
                                    ${t('doc.bulk.set', 'set')}
                                </button>
                            </dd>
                        </div>`,
                    )}
                    <div class="sound-tag">
                        <dt>${t('doc.soundtags.cover', 'cover')}</dt>
                        <dd>
                            <button
                                class="chip chip-button chip-worded"
                                disabled=${busy}
                                onClick=${() => setChoosingCover(true)}
                            ><${Icons.addImage} /><span class="chip-word">${t('doc.soundtags.choose-a-picture', 'choose a picture')}</span></button>
                        </dd>
                    </div>
                </dl>
                ${
                    choosingCover &&
                    html`<${ImagePickModal}
                        root=${root}
                        drawings=${true}
                        DrawingThumb=${DrawingThumb}
                        heading=${t('doc.bulk.a-cover-for-them-all', 'a cover for all {n}', { n: sounds.length })}
                        onPick=${coverAll}
                        onClose=${() => setChoosingCover(false)}
                    />`
                }
            </div>`
        }

        ${
            deletes &&
            html`<div class="bulk-group bulk-danger">
            <button class="bulk-button bulk-delete jag-line" disabled=${busy || !mine.length} onClick=${deleteAll}>
                <${Icons.trash} /> ${t('doc.bulk.delete-all', 'delete all {n}', { n: mine.length })}
            </button>
        </div>`
        }
    </section>`;
};
