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

import { api } from './net.js';
import { openMirror, useLive } from './cache.js';
import { usePrefMap, usePref, setPref, sealKey, SEAL_PREFIX, JOURNAL_FONT } from './prefs.js';
import { cachedDoc, rememberDoc } from './doccache.js';
import { useSearch, queryWords } from './search.js';
import { useDocSession } from './docsession.js';
import { useUploadCapture } from './upload.js';
import { emojiCompletions, linkCompletions, mediaCompletions } from './completions.js';
import { DEFAULT_STYLE } from './apps.js';
import { Annotations } from './annotations.js';
import { claimedMs, hasClaimedDate } from './docdate.js';
import { LiveMarquee } from './livemarquee.js';
import { useTurbolinks } from './turbolinks.js';
import { Icons } from './icons.js';

const html = htm.bind(h);

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

// The moment an entry files under: the user's CLAIMED date if one is set (backdating a memory
// to the day it happened), else the entry's real creation. Sorting and the displayed date both
// read this; the day-lock machinery deliberately does not (an entry seals when its REAL day
// ends, whatever day it claims to be about).
const entryMs = (d) => (hasClaimedDate(d) ? claimedMs(d) : d.created_ms || 0);

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

// The entry head: the title row over a smaller date line, with the corner actions (tag button,
// and the lock for sealed entries) at the top right. `children` is the title row - an input for
// an open entry, plain text for a locked one.
const JournalHead = ({ dateMs, tags, actions, children }) => html`
    <header class="journal-entry-head">
        <div class="journal-head-main">
            ${children}
            <div class="journal-date-sub">
                <span>${dateTitle(dateMs)}</span>
                ${(tags || []).map(
                    (t) => html`<span class="journal-tag-chip" key=${t}>${t}</span>`
                )}
            </div>
        </div>
        <span class="journal-head-actions">${actions}</span>
    </header>
`;

// The editable surface for a journal entry: the shared session + the live marquee, plus the
// minimum chrome - the head (an editable title over the date), the annotations panel when the
// tag button has it open, and a foot with the save-status dot, seal, and delete.
const JournalEditor = ({ root, docId, bucket, onSeal, dateMs, tags, actions, meta }) => {
    const s = useDocSession(root, docId, { onDeleted: () => {} });
    const tlProfile = useTurbolinks(s.body, s.format);

    // Where the caret last sat in THIS entry (the marquee reports every move) - so a dropped or
    // pasted image lands where you were writing, not at the end.
    const caret = useRef(null);
    // Drop-and-paste uploads, via the shared capture hook. The bucket is DELIBERATELY not the
    // journal's: media records file into TurboNotes' home, where they're findable as documents -
    // the journal shows finished entries, never loose image records. The embed lands here in
    // the entry either way (the reference is by id, bucket-independent).
    const up = useUploadCapture({
        root,
        bucket: DEFAULT_STYLE,
        intoTree: false,
        format: s.format,
        body: s.body,
        setBody: s.setBody,
        touched: s.touched,
        cursorPos: () => caret.current,
    });

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
        <div
            class="journal-editor"
            onDrop=${up.catchDrop}
            onDragOver=${up.allowFileDrag}
            onPaste=${up.catchPaste}
        >
            <${JournalHead} dateMs=${dateMs} tags=${tags} actions=${actions}>
                <input
                    class="journal-title"
                    value=${s.title}
                    placeholder="untitled"
                    onInput=${(e) => {
                        s.setTitle(e.currentTarget.value);
                        s.touched();
                    }}
                    onBlur=${() => s.save()}
                />
            </${JournalHead}>
            ${meta}
            <${LiveMarquee}
                body=${s.body}
                profile=${tlProfile}
                completions=${[
                    emojiCompletions,
                    linkCompletions(root, bucket),
                    // `!` searches TurboNotes' home - where journal-borne media records live.
                    mediaCompletions(root, DEFAULT_STYLE),
                ]}
                onInput=${(text) => {
                    s.setBody(text);
                    s.touched();
                }}
                onBlur=${s.save}
                onCursor=${(start, end) => {
                    caret.current = typeof end === 'number' ? end : start;
                }}
            />
            ${up.extras}
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
        // Cache-first (doccache.js): a sealed entry the mirror row still vouches for paints
        // straight from disk; only a genuinely new copy fetches.
        cachedDoc(root, docId).then((hit) => {
            if (!alive) return;
            if (hit) {
                setDoc(hit);
                return;
            }
            api(`/api/identity/${root}/docs/${docId}`)
                .then((d) => {
                    if (!alive) return;
                    rememberDoc(root, docId, d);
                    setDoc(d);
                })
                .catch(() => {});
        });
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
// (locked, with the lock button). A seal/unlock override is a local pref (prefs.js owns the key
// and its 'open' | 'locked' domain; absent = follow the day) - never synced, but durable across
// reloads and live across this browser's tabs, which is the right weight: "this page is closed"
// is a personal, per-device gesture, not a document fact.
const EMPTY_SEALS = new Map(); // stands in while the prefs load: no overrides, follow the day

// The page's writing hand: one font override for the WHOLE journal, chosen from three moods -
// typewriter (Special Elite), handwritten (Caveat), or plain-legible (Atkinson Hyperlegible).
// A local pref like the seals; it flows in as the CSS var `--journal-font` on `.journal`, which
// every entry heading, reader, and editor
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

const JournalEntry = ({ root, entry, bucket, open, onOverride }) => {
    // The corner tag button opens the same annotations panel as every other document - tags,
    // claimed date, description. Annotations are decoupled from the version lifecycle, so a
    // SEALED entry can still be tagged and dated: the seal locks the words, not the filing.
    const [showMeta, setShowMeta] = useState(false);
    const dateMs = entryMs(entry);
    const tagBtn = html`<button
        class=${showMeta ? 'journal-tag active' : 'journal-tag'}
        title="tags, date & description"
        onClick=${() => setShowMeta((v) => !v)}
    ><${Icons.tag} /></button>`;
    const meta = showMeta
        ? html`<div class="journal-meta">
              <${Annotations} root=${root} docId=${entry.doc_id} />
          </div>`
        : null;
    return html`
        <article class=${open ? 'journal-entry open' : 'journal-entry locked'} data-doc=${entry.doc_id}>
            ${open
                ? html`<${JournalEditor}
                      key=${entry.doc_id}
                      root=${root}
                      docId=${entry.doc_id}
                      bucket=${bucket}
                      onSeal=${() => onOverride('locked')}
                      dateMs=${dateMs}
                      tags=${entry.tags}
                      actions=${tagBtn}
                      meta=${meta}
                  />`
                : html`<${JournalHead}
                      dateMs=${dateMs}
                      tags=${entry.tags}
                      actions=${html`${tagBtn}<${LockButton} onUnlocked=${() => onOverride('open')} />`}
                  >
                      <div class="journal-title-read">${entry.title || 'untitled'}</div>
                  </${JournalHead}>
                  ${meta}
                  <${JournalReader} key=${entry.doc_id} root=${root} docId=${entry.doc_id} />`}
        </article>
    `;
};

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

// Paint the search hits across whatever is on screen, using the CSS Custom Highlight API: we
// register text ranges, we don't rewrite the DOM - so it lays cleanly over the marquee readers and
// the live editor alike, and a re-render (or an entry's body arriving async) can't leave orphaned
// <mark> tags behind. A MutationObserver re-scans as the stream fills in; unsupported browsers just
// get the filter with no paint. Keyed off `elRef` + the query string.
function useSearchHighlight(elRef, query) {
    useEffect(() => {
        const el = elRef.current;
        const ok =
            typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
        if (!ok || !el) return;
        const words = queryWords(query);
        if (!words.length) {
            CSS.highlights.delete('journal-search');
            return;
        }
        const paint = () => {
            const ranges = [];
            const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            for (let n = walk.nextNode(); n; n = walk.nextNode()) {
                const hay = n.nodeValue.toLowerCase();
                for (const w of words) {
                    for (let i = hay.indexOf(w); i !== -1; i = hay.indexOf(w, i + w.length)) {
                        const r = document.createRange();
                        r.setStart(n, i);
                        r.setEnd(n, i + w.length);
                        ranges.push(r);
                    }
                }
            }
            CSS.highlights.set('journal-search', new Highlight(...ranges));
        };
        paint();
        const mo = new MutationObserver(paint);
        mo.observe(el, { childList: true, subtree: true, characterData: true });
        return () => {
            mo.disconnect();
            CSS.highlights.delete('journal-search');
        };
    }, [elRef, query]);
}

export const JournalApp = ({ current, searchQuery, bucket = 'journal' }) => {
    const root = current.root;
    const docs = useLive(() => openMirror(root).docs.toArray(), [root]);
    const [busy, setBusy] = useState(false);
    const creating = useRef(false); // synchronous guard against duplicate today-entry creation

    // Seal/unlock overrides, live (across reloads and tabs). Read here too so the phantom can key
    // off whether an OPEN today entry exists. An ABSENT override means "follow the day", so this
    // is a map of what's present - never a set of flags.
    const sealMap = usePrefMap(root, SEAL_PREFIX) || EMPTY_SEALS;
    const setOverride = (docId, v) => setPref(root, sealKey(docId), v);
    const openOf = (e, todayKey) => {
        const o = sealMap.get(e.doc_id);
        return o !== undefined ? o === 'open' : dayKey(e.created_ms) === todayKey;
    };

    // The page font override. `usePref` makes the click land instantly and then defers to the
    // stored value, so another tab's change can still take over.
    const [font, setFont] = usePref(root, JOURNAL_FONT, DEFAULT_FONT);

    // A minute tick re-checks the day boundary, so today's entry locks shut when the day ends.
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 60000);
        return () => clearInterval(id);
    }, []);

    // This journal is ONE bucket - the header's switcher picks which (several journals can sit
    // on the same shelf). Every entry is filed into its bucket at creation, so membership is
    // most of the test - plus TEXT format: the journal shows finished entries, never loose
    // media records (an embedded image's record files into TurboNotes, but even one that lands
    // in this bucket some other way stays out of the stream).
    const inJournal = (d) =>
        (d.buckets || []).includes(bucket) &&
        (d.format === 'plaintext' || d.format === 'marquee');

    // Newest first by the entry's date - the user-claimed date when one is set, else CREATION
    // (never update); ties broken stably by id. Backdate an entry and it files itself into the
    // past, exactly like the Notes list.
    const entries = (docs || [])
        .filter(inJournal)
        .sort((a, b) => entryMs(b) - entryMs(a) || (a.doc_id < b.doc_id ? 1 : -1));

    // Search: the same top-level header box as Notes/Recipes, but here it FILTERS the day book to
    // matching entries (and the hit words get painted in place, below). No phantom while searching -
    // "start today's page" isn't a search result.
    const hits = useSearch(root, searchQuery);
    const searching = queryWords(searchQuery).length > 0;
    const matched = searching ? entries.filter((e) => hits && hits.has(e.doc_id)) : entries;

    const todayKey = dayKey(now);
    // The phantom trigger: the only time NOT to offer a fresh page is when the TOP of the
    // stream is an unsealed entry - the page you're mid-writing. An unsealed entry buried in
    // the past (unlocked for repairs, or backdated away by a claimed date) shouldn't suppress
    // the prompt: the book's open spot is at the top, or it's nowhere.
    const topOpen = entries.length > 0 && openOf(entries[0], todayKey);
    const stack = searching
        ? matched
        : topOpen
        ? entries
        : [{ phantom: true, created_ms: now }, ...entries];

    // Free the create guard when the roster of entries changes size - the click's new document
    // landing in the mirror is exactly such a change, WHEREVER it sorts (a backdated or
    // future-dated neighbor can't strand the guard the way a "did today's entry appear" test
    // could). Deliberately not keyed on topOpen: the guard's job is only to bridge the gap
    // between the click and the mirror echo.
    useEffect(() => {
        creating.current = false;
        setBusy(false);
    }, [entries.length]);

    // Follow a re-dated entry. Claiming a date re-sorts the stream, and the entry you were just
    // annotating skitters away - maybe below the render window, where it doesn't even exist on
    // the page. Detect the move (an entry whose effective date changed since the last look),
    // widen the window past its new position, and scroll its card back to you.
    const prevMs = useRef(new Map());
    const [follow, setFollow] = useState(null); // { id } - fresh object per move, to retrigger
    const orderKey = entries.map((e) => `${e.doc_id}:${entryMs(e)}`).join(',');
    useEffect(() => {
        const prev = prevMs.current;
        let moved = null;
        for (const e of entries) {
            const ms = entryMs(e);
            const was = prev.get(e.doc_id);
            if (was !== undefined && was !== ms) moved = e.doc_id;
            prev.set(e.doc_id, ms);
        }
        if (moved) {
            const idx = entries.findIndex((e) => e.doc_id === moved);
            setCount((c) => (idx >= c ? idx + 3 : c)); // make sure its new home is rendered
            setFollow({ id: moved });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [orderKey]);
    useEffect(() => {
        if (!follow) return;
        // Runs after the widened window has rendered, so the card exists to scroll to.
        const el = stageRef.current && stageRef.current.querySelector(`[data-doc="${follow.id}"]`);
        if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, [follow]);

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
            // An empty title, not the date: the head shows the date on its own line now, and
            // the title row is the entry's own to name (or leave blank).
            const made = await api(`/api/identity/${root}/docs`, {
                method: 'POST',
                body: JSON.stringify({ title: '', body: '', format: 'marquee' }),
            });
            await api(`/api/identity/${root}/docs/${made.doc_id}/buckets/${encodeURIComponent(bucket)}`, {
                method: 'PUT',
            });
            // Success: stay "opening…" (guard held) until the new entry shows via the mirror -
            // the entries-count effect clears both - so a click during that catch-up beat can't
            // duplicate.
        } catch (e) {
            creating.current = false;
            setBusy(false); // failed: let them try again
        }
    };

    const face = fontOf(font);
    const stageRef = useRef(null);
    useSearchHighlight(stageRef, searchQuery);
    return html`
        <div
            class="journal"
            ref=${stageRef}
            style=${`--journal-font: ${face.family}; --journal-font-scale: ${face.scale}`}
        >
            <${JournalFonts} value=${font} onPick=${setFont} />
            ${searching && !matched.length
                ? html`<p class="null-sub journal-empty">
                      no entries match “${searchQuery}”.
                  </p>`
                : shown.map((e) =>
                      e.phantom
                          ? html`<${JournalPhantom} key="today" now=${now} onStart=${startToday} busy=${busy} />`
                          : html`<${JournalEntry}
                                key=${e.doc_id}
                                root=${root}
                                entry=${e}
                                bucket=${bucket}
                                open=${openOf(e, todayKey)}
                                onOverride=${(v) => setOverride(e.doc_id, v)}
                            />`
                  )}
            ${count < stack.length && html`<div ref=${sentinel} class="journal-sentinel"></div>`}
        </div>
    `;
};
