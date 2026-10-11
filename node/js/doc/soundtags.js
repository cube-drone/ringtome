// A sound's own fields, under its player (Curtis, 2026-10-11): track, artist, album and the rest,
// read from the file's tags at upload (media/audio.rs `TAG_FIELDS`, written by ingest.rs
// `tag_fields`) or typed here - a description list, a term and its value per field, each value
// editable in place. Every field shows, filled or not, so an empty one can be filled; clearing one
// clears it, as the description does (annotations.js `useField`).
import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';

import { openMirror, useLive } from '../mirror.js';
import { api } from '../net.js';
import { DateInputs, DescInput, TagEditor, dateMeaning, useField } from './annotations.js';
import { ImagePickModal } from './imagepick.js';
import { DrawingThumb, flattenToBlob } from './drawing.js';
import { readBody } from '../pure/drawing.js';
import { playLength } from '../pure/mediakind.js';
import { Icons } from '../icons.js';
import { t } from '../i18n.js';

const html = htm.bind(h);

const FIELD_DEBOUNCE_MS = 1200;

/// The fields, in media/audio.rs `TAG_FIELDS`'s order, each with what it is called on screen.
const SOUND_FIELDS = () => [
    ['track', t('doc.soundtags.track', 'track')],
    ['artist', t('doc.soundtags.artist', 'artist')],
    ['album', t('doc.soundtags.album', 'album')],
    ['album artist', t('doc.soundtags.album-artist', 'album artist')],
    ['composer', t('doc.soundtags.composer', 'composer')],
    ['genre', t('doc.soundtags.genre', 'genre')],
    ['year', t('doc.soundtags.year', 'year')],
    ['track number', t('doc.soundtags.track-number', 'track number')],
];

const SoundField = ({ root, docId, field, label, value, readOnly }) => {
    const shadow = useField(root, docId, field, value, { debounceMs: FIELD_DEBOUNCE_MS });
    const id = `sound-field-${field.replace(/ /g, '-')}`;
    return html`<div class="sound-tag">
        <dt><label for=${id}>${label}</label></dt>
        <dd>
            <input
                id=${id}
                class="sound-tag-value jag-field"
                value=${shadow.value}
                readOnly=${readOnly}
                inputmode=${field === 'year' || field === 'track number' ? 'numeric' : undefined}
                onInput=${shadow.onInput}
                onBlur=${shadow.flush}
            />
        </dd>
    </div>`;
};

/// The sound's cover (Curtis, 2026-10-11): its thumbnail - the art its file carried, or its
/// waveform - and a choice of another. A picture lends its own thumbnail, named as it is (one blob
/// however many sounds wear it); a drawing is flattened here and sent as a picture, as the profile
/// picture does it; "its own" goes back to the one the sound was made with.
const SoundCover = ({ root, docId, row, readOnly }) => {
    const [choosing, setChoosing] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const thumbUrl = `/api/identity/${root}/docs/${docId}/thumb`;
    const send = async (request) => {
        setBusy(true);
        setError(null);
        try {
            await request();
        } catch (err) {
            setError(err.message);
        }
        setBusy(false);
    };
    const pick = (picked) => {
        setChoosing(false);
        return send(async () => {
            if (picked.format !== 'drawing') {
                await api(thumbUrl, {
                    method: 'PUT',
                    body: JSON.stringify({ from_doc: picked.doc }),
                });
                return;
            }
            const detail = await api(`/api/identity/${root}/docs/${picked.doc}`);
            if (detail.body == null)
                throw new Error(
                    t(
                        'doc.soundtags.drawing-not-here-yet',
                        'that drawing has not reached this computer yet - try again in a moment',
                    ),
                );
            await api(thumbUrl, {
                method: 'PUT',
                headers: { 'Content-Type': 'image/png' },
                body: await flattenToBlob(root, readBody(detail.body)),
            });
        });
    };
    const reset = () => send(() => api(thumbUrl, { method: 'DELETE' }));
    const hasThumb = !!(row && row.media && row.media.has_thumb);
    return html`<div class="sound-tag sound-cover">
        <dt>${t('doc.soundtags.cover', 'cover')}</dt>
        <dd>
            <span class="sound-cover-row">
                ${
                    hasThumb &&
                    html`<img class="sound-cover-face" src=${`${thumbUrl}?v=${row.head}`} alt="" />`
                }
                ${
                    !readOnly &&
                    html`<button
                        class="chip chip-button chip-worded"
                        disabled=${busy}
                        title=${t('doc.soundtags.choose-a-picture', 'choose a picture')}
                        onClick=${() => setChoosing(true)}
                    ><${Icons.addImage} /><span class="chip-word">${t('doc.soundtags.choose-a-picture', 'choose a picture')}</span></button>
                    <button
                        class="chip chip-button chip-worded"
                        disabled=${busy}
                        title=${t('doc.soundtags.back-to-the-cover-or-waveform', 'back to the cover or waveform it came with')}
                        onClick=${reset}
                    ><${Icons.back} /><span class="chip-word">${t('doc.soundtags.its-own', 'its own')}</span></button>`
                }
            </span>
            ${error && html`<p class="form-error">${error}</p>`}
            ${
                choosing &&
                html`<${ImagePickModal}
                    root=${root}
                    drawings=${true}
                    DrawingThumb=${DrawingThumb}
                    heading=${t('doc.soundtags.a-cover-for-this-sound', 'a cover for this sound')}
                    onPick=${pick}
                    onClose=${() => setChoosing(false)}
                />`
            }
        </dd>
    </div>`;
};

/// One of every document's own annotations, as a row of the list (Curtis, 2026-10-11: "part of
/// the document system, so we should include them"): the panel's own editor (annotations.js) under
/// a term.
const DocRow = ({ label, title = null, children }) =>
    html`<div class="sound-tag sound-doc-field">
        <dt title=${title}>${label}</dt>
        <dd>${children}</dd>
    </div>`;

export const SoundTags = ({ root, docId, readOnly }) => {
    const row = useLive(() => openMirror(root).docs.get(docId), [root, docId]);
    const fields = (row && row.fields) || {};
    // A built-in sound is nobody's to annotate; it shows its own fields and nothing else.
    const own = !readOnly;
    const length = playLength(row && row.media && row.media.duration_ms);
    return html`<dl class="sound-tags">
        ${
            own &&
            html`<${DocRow} label=${t('doc.soundtags.tags', 'tags')}>
                <${TagEditor} root=${root} docId=${docId} />
            </${DocRow}>`
        }
        <${SoundCover} root=${root} docId=${docId} row=${row} readOnly=${readOnly} />
        ${
            /* Its length (2026-10-11), measured at upload and carried on every version: a fact of
            the sound, so said rather than edited. */ ''
        }
        ${
            length &&
            html`<${DocRow} label=${t('doc.soundtags.length', 'length')}>
                <span class="sound-length">${length}</span>
            </${DocRow}>`
        }
        ${SOUND_FIELDS().map(
            ([field, label]) => html`<${SoundField}
                key=${`${docId}:${field}`}
                root=${root}
                docId=${docId}
                field=${field}
                label=${label}
                value=${fields[field] || ''}
                readOnly=${readOnly}
            />`,
        )}
        ${
            own &&
            html`<${DocRow} label=${t('doc.soundtags.description', 'description')}>
                <${DescInput} root=${root} docId=${docId} />
            </${DocRow}>
            <${DocRow} label=${t('doc.soundtags.date', 'date')} title=${dateMeaning()}>
                <span class="sound-date"><${DateInputs} root=${root} docId=${docId} /></span>
            </${DocRow}>`
        }
    </dl>`;
};
