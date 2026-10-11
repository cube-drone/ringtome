// A sound's own fields, under its player (Curtis, 2026-10-11): track, artist, album and the rest,
// read from the file's tags at upload (media/audio.rs `TAG_FIELDS`, written by ingest.rs
// `tag_fields`) or typed here - a description list, a term and its value per field, each value
// editable in place. Every field shows, filled or not, so an empty one can be filled; clearing one
// clears it, as the description does (annotations.js `useField`).
import { h } from 'preact';
import htm from 'htm';

import { openMirror, useLive } from '../mirror.js';
import { useField } from './annotations.js';
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

export const SoundTags = ({ root, docId, readOnly }) => {
    const row = useLive(() => openMirror(root).docs.get(docId), [root, docId]);
    const fields = (row && row.fields) || {};
    return html`<dl class="sound-tags">
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
    </dl>`;
};
