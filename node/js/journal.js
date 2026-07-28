// The Journal app: a day book, not a note list. Entries stream newest-first by CREATION date,
// one per day, infinite-scroll style. Today's entry sits at the top waiting to be written - it
// doesn't exist as a document until you start (a nudge, not a commitment). Once a day ends its
// entry locks shut (even mid-edit); a locked entry is editable again only after a deliberate
// 15-second unlock. Journal composes the SHARED editing session (docsession.js) and the live
// marquee surface directly - there's no Notes chrome to strip, so it's its own app, not the
// notes app in a costume.
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';
import { Marquee, parse } from '@cube-drone/marquee-react-renderer';

import { openMirror, useLive } from './cache.js';
import { useDocSession } from './docsession.js';
import { LiveMarquee } from './livemarquee.js';
import { useTurbolinks } from './turbolinks.js';
import { appTypeOf, DEFAULT_STYLE } from './apps.js';
import { Icons } from './icons.js';

const html = htm.bind(h);

async function api(path, options = {}) {
    const res = await fetch(path, {
        credentials: 'same-origin',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        ...options,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(body.message || `request failed (${res.status})`);
    }
    return body;
}

// Local-day helpers. `dayKey` groups entries by the viewer's calendar day (so "today" is the
// user's today); the heading is the entry's creation date, spelled out.
const dayKey = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};
const dateTitle = (ms) =>
    new Date(ms).toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });

const STATUS_TIP = {
    clean: 'Saved',
    dirty: 'Unsaved — saving shortly',
    saving: 'Saving…',
    error: 'Not saved — will retry',
    waiting: 'On its way from another computer',
    opening: 'Opening…',
};

const StatusDot = ({ status }) =>
    html`<span
        class=${status === 'error' ? 'journal-status error' : 'journal-status'}
        title=${STATUS_TIP[status]}
    >${status === 'clean'
        ? html`<${Icons.saved} />`
        : status === 'error'
        ? html`<${Icons.warn} />`
        : html`<span class="status-spin"><${Icons.spinner} /></span>`}</span>`;

// The editable surface for a journal entry: the shared session + the live marquee, and the
// minimum chrome (a save-status dot, a delete once the entry has been unlocked). No title input -
// the date heading belongs to the stream row, not the editor.
const JournalEditor = ({ root, docId, onSeal }) => {
    const s = useDocSession(root, docId, { onDeleted: () => {} });
    const tlProfile = useTurbolinks(s.body, s.format);

    if (s.status === 'opening' && !s.loaded) {
        return html`<p class="null-sub">opening…</p>`;
    }
    if (s.status === 'waiting') {
        return html`<p class="null-sub">
            <span class="waiting-dot"></span> some of this entry's words are still arriving from
            another computer.
        </p>`;
    }
    return html`
        <div class="journal-editor">
            <${LiveMarquee}
                body=${s.body}
                profile=${tlProfile}
                onInput=${(text) => {
                    s.setBody(text);
                    s.touched();
                }}
                onBlur=${s.save}
                onCursor=${() => {}}
            />
            <div class="journal-editor-foot">
                <${StatusDot} status=${s.status} />
                <button
                    class="journal-seal"
                    title="Seal — lock this entry (unlocking takes 15 seconds)"
                    onClick=${async () => {
                        await s.save(); // flush pending edits so the locked view reads them
                        onSeal();
                    }}
                ><${Icons.key} /></button>
                <button
                    class="journal-delete"
                    title="Delete — removes this entry (its history is kept)"
                    onClick=${s.remove}
                ><${Icons.trash} /></button>
            </div>
        </div>
    `;
};

// Read-only display for a locked entry: fetch and render the resolved body (marquee/plaintext).
const JournalReader = ({ root, docId }) => {
    const [doc, setDoc] = useState(null);
    const tlProfile = useTurbolinks(doc?.body ?? '', doc?.format);
    useEffect(() => {
        let alive = true;
        api(`/api/identity/${root}/docs/${docId}`)
            .then((d) => alive && setDoc(d))
            .catch(() => {});
        return () => {
            alive = false;
        };
    }, [root, docId]);
    if (!doc) return html`<p class="null-sub">…</p>`;
    if (doc.body == null) return html`<p class="null-sub">(not on this computer yet)</p>`;
    if (doc.format === 'marquee') {
        let parses = true;
        try {
            parse(doc.body);
        } catch {
            parses = false;
        }
        return parses
            ? html`<div class="reader-marquee"><${Marquee}
                  source=${doc.body}
                  animate="visible"
                  profile=${tlProfile}
              /></div>`
            : html`<pre class="reader-plain">${doc.body}</pre>`;
    }
    return html`<pre class="reader-plain">${doc.body}</pre>`;
};

// The lock: a click starts a 15-second fill; when the bar completes, the entry unlocks.
const LockButton = ({ onUnlocked }) => {
    const [unlocking, setUnlocking] = useState(false);
    return html`
        <button
            class=${unlocking ? 'journal-lock unlocking' : 'journal-lock'}
            title="Locked — click, then wait 15 seconds, to unlock this entry for editing"
            onClick=${() => setUnlocking(true)}
            disabled=${unlocking}
        >
            <span class="journal-lock-face"><${Icons.lock} /></span>
            ${unlocking &&
            html`<span class="journal-unlock-bar" onAnimationEnd=${onUnlocked}></span>`}
        </button>
    `;
};

// One row in the stack: the date heading, plus the editor (today / unlocked) or the reader
// (locked, with the lock button).
// Seal/unlock overrides persist in Dexie's local `prefs` table (keyed `seal:<doc_id>` ->
// 'open' | 'locked'; absent = follow the day). Local-only - never synced to the node, but durable
// across reloads and live across tabs of this browser (via `useLive`), which is the right weight:
// "this page is closed" is a personal, per-device gesture, not a document fact.
const sealKey = (docId) => `seal:${docId}`;

// The page's writing hand: one font override for the WHOLE journal, chosen from three moods -
// typewriter (Special Elite), handwritten (Caveat), or plain-legible (Atkinson Hyperlegible).
// Stored in Dexie prefs alongside the seals (local, durable, live across tabs); it flows in as
// the CSS var `--journal-font` on `.journal`, which every entry heading, reader, and editor
// inherits. A per-page default (not per-entry) - the journal reads in one voice.
// `scale` normalizes each face's optical size to the others (the same factors as the global
// `mq-font-*` normalization in index.css): Special Elite is the reference, Atkinson runs a touch
// small, Caveat a lot. It rides on top of the journal's own 1.5x size-up as `--journal-font-scale`.
const FONTS = [
    { id: 'special-elite', family: '"Special Elite", monospace', scale: 1, icon: Icons.fontTypewriter, label: 'Typewriter — Special Elite' },
    { id: 'caveat', family: '"Caveat", cursive', scale: 1.5, icon: Icons.fontHand, label: 'Handwritten — Caveat' },
    { id: 'atkinson', family: '"Atkinson Hyperlegible", sans-serif', scale: 1.15, icon: Icons.fontLegible, label: 'Legible — Atkinson Hyperlegible' },
];
const DEFAULT_FONT = 'special-elite';
const fontOf = (id) => FONTS.find((f) => f.id === id) || FONTS[0];

const JournalFonts = ({ value, onPick }) => html`
    <div class="journal-fonts">
        ${FONTS.map(
            (f) => html`<button
                key=${f.id}
                class=${value === f.id ? 'journal-font active' : 'journal-font'}
                title=${f.label}
                onClick=${() => onPick(f.id)}
            ><${f.icon} /></button>`
        )}
    </div>
`;

const JournalEntry = ({ root, entry, open, onOverride }) => html`
    <article class=${open ? 'journal-entry open' : 'journal-entry locked'}>
        <header class="journal-entry-head">
            <h2 class="journal-date">${dateTitle(entry.created_ms)}</h2>
            ${!open && html`<${LockButton} onUnlocked=${() => onOverride('open')} />`}
        </header>
        ${open
            ? html`<${JournalEditor}
                  key=${entry.doc_id}
                  root=${root}
                  docId=${entry.doc_id}
                  onSeal=${() => onOverride('locked')}
              />`
            : html`<${JournalReader} key=${entry.doc_id} root=${root} docId=${entry.doc_id} />`}
    </article>
`;

// The phantom today entry: an inviting blank page. It creates the real document on first
// engagement - the entry doesn't exist until you start writing.
const JournalPhantom = ({ now, onStart, busy }) => html`
    <article class="journal-entry open journal-phantom">
        <header class="journal-entry-head">
            <h2 class="journal-date">${dateTitle(now)}</h2>
        </header>
        <button class="journal-phantom-start" disabled=${busy} onClick=${onStart}>
            <p class="null-sub">
                ${busy ? 'opening today’s page…' : 'Today’s page is blank. Click to start writing…'}
            </p>
        </button>
    </article>
`;

export const JournalApp = ({ current }) => {
    const root = current.root;
    const docs = useLive(() => openMirror(root).docs.toArray(), [root]);
    const roster = useLive(() => openMirror(root).buckets.toArray(), [root]);
    const [busy, setBusy] = useState(false);
    const creating = useRef(false); // synchronous guard against duplicate today-entry creation

    // Seal/unlock overrides, live from Dexie (across reloads and tabs). Read here too so the
    // phantom can key off whether an OPEN today entry exists.
    const seals = useLive(
        () => openMirror(root).prefs.where('key').startsWith('seal:').toArray(),
        [root]
    );
    const sealMap = new Map((seals || []).map((r) => [r.key.slice(5), r.value])); // 'seal:'.length
    const setOverride = (docId, v) => {
        openMirror(root).prefs.put({ key: sealKey(docId), value: v }).catch(() => {});
    };
    const openOf = (e, todayKey) => {
        const o = sealMap.get(e.doc_id);
        return o !== undefined ? o === 'open' : dayKey(e.created_ms) === todayKey;
    };

    // The page font override (same durable Dexie home as the seals). Read with the same
    // `.where().equals().toArray()` shape the seals use - which reliably re-fires - rather than a
    // bare `.get()`. An optimistic `pick` makes the click land instantly (no wait on the Dexie
    // round-trip); once the write echoes back through the live query, the pick is dropped so a
    // change from another tab can take over again.
    const fontRows = useLive(
        () => openMirror(root).prefs.where('key').equals('journal:font').toArray(),
        [root]
    );
    const persistedFont = fontRows && fontRows[0] && fontRows[0].value;
    const [fontPick, setFontPick] = useState(null);
    const font = fontPick || persistedFont || DEFAULT_FONT;
    useEffect(() => {
        if (fontPick && persistedFont === fontPick) setFontPick(null);
    }, [persistedFont, fontPick]);
    const setFont = (f) => {
        setFontPick(f);
        openMirror(root).prefs.put({ key: 'journal:font', value: f }).catch(() => {});
    };

    // A minute tick re-checks the day boundary, so today's entry locks shut when the day ends.
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 60000);
        return () => clearInterval(id);
    }, []);

    const inJournal = (d) => {
        const names = d.buckets || [];
        const types = names.length ? names.map((n) => appTypeOf(n, roster)) : [DEFAULT_STYLE];
        return types.includes('journal');
    };

    // Newest first by CREATION (not update); ties broken stably by id.
    const entries = (docs || [])
        .filter(inJournal)
        .sort((a, b) => (b.created_ms || 0) - (a.created_ms || 0) || (a.doc_id < b.doc_id ? 1 : -1));

    const todayKey = dayKey(now);
    // The phantom trigger: no UNSEALED entry for today. A today entry that's been sealed doesn't
    // count - so once you seal today's page, you're prompted to start a fresh one.
    const openTodayExists = entries.some(
        (e) => dayKey(e.created_ms) === todayKey && openOf(e, todayKey)
    );
    const stack = openTodayExists ? entries : [{ phantom: true, created_ms: now }, ...entries];

    // Once an open today entry exists (a create landed, or the day rolled over), free the create
    // guard and drop the "opening…" state.
    useEffect(() => {
        if (openTodayExists) {
            creating.current = false;
            setBusy(false);
        }
    }, [openTodayExists]);

    // Windowed render (infinite scroll): grow when the sentinel scrolls into view.
    const [count, setCount] = useState(6);
    const sentinel = useRef(null);
    useEffect(() => {
        const el = sentinel.current;
        if (!el) return;
        const io = new IntersectionObserver((es) => {
            if (es[0].isIntersecting) setCount((c) => c + 6);
        });
        io.observe(el);
        return () => io.disconnect();
    }, [stack.length]);
    const shown = stack.slice(0, count);

    const startToday = async () => {
        // A REF, not the `busy` state: rapid clicks all fire before a re-render, so the state
        // guard reads a stale `false` and lets several through - that is how a fistful of empty
        // duplicates got made. The ref flips synchronously, so the second click is already blocked.
        if (creating.current) return;
        creating.current = true;
        setBusy(true);
        try {
            const made = await api(`/api/identity/${root}/docs`, {
                method: 'POST',
                body: JSON.stringify({ title: dateTitle(now), body: '', format: 'marquee' }),
            });
            await api(`/api/identity/${root}/docs/${made.doc_id}/buckets/journal`, {
                method: 'PUT',
            });
            // Success: stay "opening…" (guard held) until the new entry shows via the mirror - the
            // openTodayExists effect clears both - so a click during that catch-up beat can't duplicate.
        } catch (e) {
            creating.current = false;
            setBusy(false); // failed: let them try again
        }
    };

    const face = fontOf(font);
    return html`
        <div
            class="journal"
            style=${`--journal-font: ${face.family}; --journal-font-scale: ${face.scale}`}
        >
            <${JournalFonts} value=${font} onPick=${setFont} />
            ${shown.map((e) =>
                e.phantom
                    ? html`<${JournalPhantom} key="today" now=${now} onStart=${startToday} busy=${busy} />`
                    : html`<${JournalEntry}
                          key=${e.doc_id}
                          root=${root}
                          entry=${e}
                          open=${openOf(e, todayKey)}
                          onOverride=${(v) => setOverride(e.doc_id, v)}
                      />`
            )}
            ${count < stack.length && html`<div ref=${sentinel} class="journal-sentinel"></div>`}
        </div>
    `;
};
