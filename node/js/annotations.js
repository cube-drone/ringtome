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
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';
import { openMirror, useLive } from './cache.js';
import { DISPLAY_DATE_FIELD, splitClaimed, joinClaimed } from './docdate.js';

const html = htm.bind(h);

const DESC_DEBOUNCE_MS = 1200;

async function api(path, options = {}) {
    const res = await fetch(path, {
        credentials: 'same-origin',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        ...options,
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `request failed (${res.status})`);
    }
    return res.json().catch(() => ({}));
}

// A named annotation field bound as a shadow buffer: local while dirty so the stream never
// repaints mid-edit, adopts the mirror when clean, flushes on debounce/blur/unmount. Empty
// value clears the field (an absent value is an LWW clear). A custom hook - called once per
// field, unconditionally, so hook order is stable.
function useField(root, docId, field, mirrorValue, { debounceMs } = {}) {
    const [value, setValue] = useState(mirrorValue);
    const valueRef = useRef(value);
    valueRef.current = value;
    const dirty = useRef(false);
    const timer = useRef(null);
    const url = `/api/identity/${root}/docs/${docId}/annotations/fields/${field}`;

    useEffect(() => {
        if (!dirty.current) setValue(mirrorValue);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mirrorValue]);

    const flush = async () => {
        if (!dirty.current) return;
        const v = valueRef.current;
        dirty.current = false;
        try {
            if (v.trim() === '') {
                await api(url, { method: 'DELETE' });
            } else {
                await api(url, { method: 'PUT', body: JSON.stringify({ value: v }) });
            }
        } catch {
            dirty.current = true; // a failed write stays dirty; blur/next edit retries
        }
    };

    const onInput = (e) => {
        const v = e.currentTarget.value;
        setValue(v);
        valueRef.current = v;
        dirty.current = true;
        if (debounceMs) {
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(flush, debounceMs);
        } else {
            flush();
        }
    };

    useEffect(
        () => () => {
            if (timer.current) clearTimeout(timer.current);
            if (dirty.current) flush();
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [docId]
    );

    return { value, onInput, flush };
}

// The claimed display date is a composite of two controls (date + time) over ONE field. Same
// shadow-buffer discipline as useField, but the stored value is `joinClaimed(date, time)`:
// date alone, date+time, or empty (clear). A time without a date is meaningless and clears.
function useClaimedDate(root, docId, mirrorValue) {
    const [parts, setParts] = useState(() => splitClaimed(mirrorValue));
    const partsRef = useRef(parts);
    partsRef.current = parts;
    const dirty = useRef(false);
    const url = `/api/identity/${root}/docs/${docId}/annotations/fields/${DISPLAY_DATE_FIELD}`;

    useEffect(() => {
        if (!dirty.current) setParts(splitClaimed(mirrorValue));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mirrorValue]);

    const flush = async () => {
        if (!dirty.current) return;
        const value = joinClaimed(partsRef.current.date, partsRef.current.time);
        dirty.current = false;
        try {
            if (value === '') {
                await api(url, { method: 'DELETE' });
            } else {
                await api(url, { method: 'PUT', body: JSON.stringify({ value }) });
            }
        } catch {
            dirty.current = true;
        }
    };

    const set = (patch) => {
        const next = { ...partsRef.current, ...patch };
        setParts(next);
        partsRef.current = next;
        dirty.current = true;
        flush();
    };

    useEffect(
        () => () => {
            if (dirty.current) flush();
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [docId]
    );

    return {
        date: parts.date,
        time: parts.time,
        onDate: (e) => set({ date: e.currentTarget.value }),
        onTime: (e) => set({ time: e.currentTarget.value }),
        flush,
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
    }, [mirrorTags.join(' ')]);

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
        const tag = raw.trim().toLowerCase();
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
                <label class="annot-label" title="the date and time this document should be filed and sorted under - your claim, authoritative over the real save date">date</label>
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
                    title=${claimed.date ? 'time (optional)' : 'set a date first'}
                />
            </div>`}
            <div class="annot-tags">
                ${shownTags.map(
                    (t) => html`<span class="annot-tag" key=${t}>
                        ${t}
                        <button
                            class="annot-tag-x"
                            title="remove tag"
                            onClick=${() => removeTag(t)}
                        >×</button>
                    </span>`
                )}
                <input
                    class="annot-tag-input"
                    placeholder="+ tag"
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
                placeholder="a short description (optional)"
                value=${desc.value}
                onInput=${desc.onInput}
                onBlur=${desc.flush}
                rows="2"
            ></textarea>`}
        </div>
    `;
};
