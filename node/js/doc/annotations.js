// The annotations panel: a document's tags, description, and claimed display date - the
// things you can assert about a document without minting a version (NOTES_APP, Annotations).
// Title is a header field and lives in the editor; these are LWW private facts on a separate
// chain (`doc-meta`).
//
// Reads live from the mirror's docs row (which carries `tags` and `fields` - joined onto the
// summary at the stream boundary) and writes through the annotation HTTP routes. Writes echo
// back down the stream within a second or so; until they do, a local overlay keeps the UI
// from lagging its own clicks. Text/date fields are shadow buffers over the mirror value
// (local while dirty, adopt the mirror when clean); tags use an optimistic pending overlay.
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';
import { api } from '../net.js';
import { useShadowValue } from '../shadow.js';
import { openMirror, useLive } from '../mirror.js';
import { DISPLAY_DATE_FIELD, splitClaimed, joinClaimed } from '../pure/docdate.js';
import { t } from '../i18n.js';

const html = htm.bind(h);

const DESC_DEBOUNCE_MS = 1200;

// A named annotation field as a shadow buffer (shadow.js). An EMPTY value clears the field, since
// an absent value is how LWW says "no longer set" - so the save picks its own verb.
function useField(root, docId, field, mirrorValue, { debounceMs } = {}) {
    const url = `/api/identity/${root}/docs/${docId}/annotations/fields/${field}`;
    return useShadowValue(mirrorValue, {
        debounceMs,
        key: docId,
        save: (value) =>
            value.trim() === ''
                ? api(url, { method: 'DELETE' })
                : api(url, { method: 'PUT', body: JSON.stringify({ value }) }),
    });
}

// The claimed display date is TWO controls over ONE stored field, so the shadow buffer holds the
// stored form and the controls split and rejoin it at the edges - which puts `joinClaimed`'s rule (a
// time without a date is meaningless and clears) in exactly one place. Saves immediately: a date
// picker has no keystrokes to debounce.
function useClaimedDate(root, docId, mirrorValue) {
    const url = `/api/identity/${root}/docs/${docId}/annotations/fields/${DISPLAY_DATE_FIELD}`;
    const shadow = useShadowValue(mirrorValue, {
        key: docId,
        save: (value) =>
            value === ''
                ? api(url, { method: 'DELETE' })
                : api(url, { method: 'PUT', body: JSON.stringify({ value }) }),
    });
    const parts = splitClaimed(shadow.value);
    return {
        date: parts.date,
        time: parts.time,
        onDate: (e) => shadow.set(joinClaimed(e.currentTarget.value, parts.time)),
        onTime: (e) => shadow.set(joinClaimed(parts.date, e.currentTarget.value)),
        flush: shadow.flush,
    };
}

export const Annotations = ({ root, docId, features }) => {
    // Which annotations this app surfaces; absent = show them all (the default app).
    const showDate = !features || features.date !== false;
    const showDesc = !features || features.description !== false;
    const row = useLive(() => openMirror(root).docs.get(docId), [root, docId]);
    const mirrorTags = (row && row.tags) || [];
    const mirrorDesc = (row && row.fields && row.fields.description) || '';
    const mirrorDate = (row && row.fields && row.fields[DISPLAY_DATE_FIELD]) || '';

    const desc = useField(root, docId, 'description', mirrorDesc, {
        debounceMs: DESC_DEBOUNCE_MS,
    });
    const claimed = useClaimedDate(root, docId, mirrorDate);

    // Tags: render the mirror set, overlaid with in-flight optimistic changes so a click shows
    // immediately. A pending entry clears once the mirror reflects it (echo arrived).
    const [pending, setPending] = useState({}); // tag -> 'adding' | 'removing'
    const [tagInput, setTagInput] = useState('');
    const mirrorTagsKey = mirrorTags.join(' ');
    useEffect(() => {
        setPending((p) => {
            let changed = false;
            const next = {};
            for (const [tag, op] of Object.entries(p)) {
                const present = mirrorTags.includes(tag);
                const settled = (op === 'adding' && present) || (op === 'removing' && !present);
                if (settled) changed = true;
                else next[tag] = op;
            }
            return changed ? next : p;
        });
        // Keyed on the joined VALUE, not the array: the mirror hands back a fresh array
        // identity every poll, and re-running this settle pass on identical contents would
        // still be harmless - the key just spares the churn. `mirrorTags` itself is
        // deliberately not a dep for exactly that identity-churn reason.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mirrorTagsKey]);

    // Insertion order: the mirror already delivers tags oldest-first (the server sorts by LWW
    // stamp), and optimistic adds append at the end - so a new tag lands where you'd expect it,
    // not alphabetically reshuffled.
    const shownTags = [
        ...mirrorTags.filter((t) => pending[t] !== 'removing'),
        ...Object.entries(pending)
            .filter(([t, op]) => op === 'adding' && !mirrorTags.includes(t))
            .map(([t]) => t),
    ];

    const tagUrl = (tag) =>
        `/api/identity/${root}/docs/${docId}/annotations/tags/${encodeURIComponent(tag)}`;

    const addTag = async (raw) => {
        // 32 characters, the public tag's cap (2026-08-31), so a draft never carries a
        // tag that publish would have to leave behind.
        const tag = raw.trim().toLowerCase().slice(0, 32);
        setTagInput('');
        if (!tag || shownTags.includes(tag)) return;
        setPending((p) => ({ ...p, [tag]: 'adding' }));
        try {
            await api(tagUrl(tag), { method: 'PUT' });
        } catch {
            setPending((p) => {
                const { [tag]: _, ...rest } = p;
                return rest;
            });
        }
    };
    const removeTag = async (tag) => {
        setPending((p) => ({ ...p, [tag]: 'removing' }));
        try {
            await api(tagUrl(tag), { method: 'DELETE' });
        } catch {
            setPending((p) => {
                const { [tag]: _, ...rest } = p;
                return rest;
            });
        }
    };

    return html`
        <div class="annotations">
            ${showDate &&
            html`<div class="annot-row">
                <label class="annot-label" title=${t('doc.annotations.the-date-and-time-this', 'the date and time this document should be filed and sorted under - your claim, authoritative over the real save date')}>${t('doc.annotations.date', 'date')}</label>
                <input
                    class="annot-date"
                    type="date"
                    value=${claimed.date}
                    onInput=${claimed.onDate}
                    onBlur=${claimed.flush}
                />
                <input
                    class="annot-time"
                    type="time"
                    value=${claimed.time}
                    onInput=${claimed.onTime}
                    onBlur=${claimed.flush}
                    disabled=${!claimed.date}
                    title=${claimed.date ? t('doc.annotations.time-optional', 'time (optional)') : t('doc.annotations.set-a-date-first', 'set a date first')}
                />
            </div>`}
            <div class="annot-tags">
                ${/* `tag`, never `t`: the map's parameter once shadowed the i18n t(), so the
                    remove button's title called the TAG STRING as a function and the whole
                    panel threw the moment a tag existed - a new tag never "confirmed"
                    (Curtis, 2026-08-29; the strings migration wrapped the literal without
                    seeing the shadow). */ ''}
                ${shownTags.map(
                    (tag) => html`<span class="annot-tag" key=${tag}>
                        ${tag}
                        <button
                            class="annot-tag-x"
                            title=${t('doc.annotations.remove-tag', 'remove tag')}
                            onClick=${() => removeTag(tag)}
                        >×</button>
                    </span>`
                )}
                <input
                    class="annot-tag-input"
                    maxlength="32"
                    placeholder=${t('doc.annotations.tag', '+ tag')}
                    value=${tagInput}
                    onInput=${(e) => setTagInput(e.currentTarget.value)}
                    onKeyDown=${(e) => {
                        if (e.key === 'Enter' || e.key === ',') {
                            e.preventDefault();
                            addTag(tagInput);
                        }
                    }}
                    onBlur=${() => addTag(tagInput)}
                />
            </div>
            ${showDesc &&
            html`<textarea
                class="annot-desc"
                placeholder=${t('doc.annotations.a-short-description-optional', 'a short description (optional)')}
                value=${desc.value}
                onInput=${desc.onInput}
                onBlur=${desc.flush}
                rows="2"
            ></textarea>`}
        </div>
    `;
};
