// The editor - where never-lose-words meets a keyboard. The four client obligations
// (NOTES_APP, The sync model), each with its mechanism here:
//
// 1. **Debounced autosave**: ~10s after the last keystroke, on blur, on tab-hide (keepalive),
//    and on doc switch. A clean buffer never saves; the node's no-op bounce is the floor
//    under us, not the plan.
// 2. **Check the head before saving**: the live mirror row is our lookout. If the head moves
//    while the buffer is CLEAN, the editor quietly reloads (fast-forward). If it moves while
//    dirty, we keep typing and the next save forks knowingly - the server keeps both, and the
//    conflict presents in-document on the next open. Never blind-save, never lose.
// 3. **Conflicts present in the document**: a diverged doc loads its synthesized tangle into
//    the buffer (markers, device labels). Editing it and saving - with every head as parents
//    - IS the resolution. The editor is the merge tool.
// 4. **The synthesized tangle starts clean, not dirty**: `dirty` arms only on real input, so
//    autosave can never commit a tangle the user hasn't touched.
//
// This buffer IS the shadow overlay (PROJECT_PLAN, The Browser Is a View): local state the
// stream must never repaint. The mirror is watched, never rendered into the textarea; the
// save response fast-forwards our parents without a refetch.
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';
import { Marquee, parse } from '@cube-drone/marquee-react-renderer';

import { openMirror, useLive } from './cache.js';
import { needsReload } from './lookout.js';
import { LiveMarquee } from './livemarquee.js';
import { useTurbolinks } from './turbolinks.js';
import { keepaliveOk } from './keepalive.js';
import { Annotations } from './annotations.js';
import { featuresOf } from './apps.js';
import { Icons } from './icons.js';

const html = htm.bind(h);

const AUTOSAVE_MS = 10_000;

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

// The view modes. Modes are a VIEW choice, format is a DOCUMENT property - they meet in
// modesFor: a Marquee doc offers all four, a plaintext doc only the two that make sense
// without a renderer. Defaults per format, chosen when the user hasn't picked.
const MODES = {
    interactive: 'interactive', // live preview: styling projected onto the source in place
    side: 'side by side', // source pane + rendered pane
    plain: 'plaintext', // the raw source in a plain textarea
    read: 'read only', // the rendered document, nothing editable
};
const modesFor = (format) =>
    format === 'marquee' ? ['interactive', 'side', 'plain', 'read'] : ['plain', 'read'];
const defaultMode = (format) => (format === 'marquee' ? 'interactive' : 'plain');

// The mode tabs show icons, not words; the words (MODES) live in each tab's tooltip.
const MODE_ICONS = {
    interactive: Icons.modeInteractive,
    side: Icons.modeSide,
    plain: Icons.modePlain,
    read: Icons.modeRead,
};

// Where you were in each document - shared by every editing surface, so switching modes (or
// leaving and returning to a doc) lands the cursor where it last sat. Deliberately a module
// Map, NOT the mirror's prefs table: a cursor is incidental working state, not a choice -
// cross-tab storage would make two tabs on one doc clobber each other, and a stale cursor
// is noise. Per tab, per session, like scroll positions everywhere else on the web.
const cursorMemory = new Map();
const rememberCursor = (root, docId, start, end) =>
    cursorMemory.set(`${root}:${docId}`, { start, end });
const recallCursor = (root, docId) => cursorMemory.get(`${root}:${docId}`) || null;

export const Editor = ({ root, docId, features, onDeleted }) => {
    const feat = features || featuresOf();
    const [loaded, setLoaded] = useState(null); // the fetched detail this session started from
    const [title, setTitle] = useState('');
    const [body, setBody] = useState('');
    const [format, setFormat] = useState('plaintext');
    const [chosenMode, setChosenMode] = useState(null); // null = follow the format's default
    const [status, setStatus] = useState('opening'); // opening | clean | dirty | saving | error
    const [error, setError] = useState(null);
    const [dump, setDump] = useState(null); // TEMPORARY: the merge-debug history dump
    const [showMeta, setShowMeta] = useState(false); // the tags/date/description dropdown

    // Mutable save-machine state: parents to assert, dirtiness, timers. Refs, not state -
    // the save loop must see current values without re-render races. `buffer` mirrors the
    // rendered state every render, so timers and unmount flushes never save a stale closure.
    const machine = useRef({
        parents: [],
        dirty: false,
        timer: null,
        waitTimer: null,
        inflight: false,
    });
    const buffer = useRef({});
    buffer.current = { title, body, format };
    const saveRef = useRef(() => {});

    const load = async () => {
        setStatus('opening');
        setError(null);
        const doc = await api(`/api/identity/${root}/docs/${docId}`);
        // A null body means blobs this resolution needs haven't reached this computer yet
        // (headers travel ahead of bodies). This is a WAITING ROOM, never an empty buffer:
        // pouring null into the textarea as "" is how a divergence once ate a paragraph -
        // the user typed into the void and saved, resolving the fork with nothing.
        if (doc.body == null) {
            setLoaded(doc);
            setTitle(doc.title);
            setFormat(doc.format);
            setStatus('waiting');
            machine.current.dirty = false;
            if (machine.current.waitTimer) clearTimeout(machine.current.waitTimer);
            machine.current.waitTimer = setTimeout(() => load().catch(() => {}), 2000);
            return;
        }
        if (machine.current.waitTimer) clearTimeout(machine.current.waitTimer);
        machine.current.parents = doc.save_parents;
        machine.current.dirty = false;
        machine.current.seen = { diverged: doc.diverged, heads: doc.heads.length };
        setLoaded(doc);
        setTitle(doc.title);
        setBody(doc.body);
        setFormat(doc.format);
        setStatus('clean');
    };

    const save = async ({ unloading = false } = {}) => {
        const m = machine.current;
        if (!m.dirty || m.inflight) return;
        if (m.parents.length === 0) return; // waiting room: nothing loaded to save against
        m.inflight = true;
        setStatus('saving');
        // Snapshot what we're saving (from the ref, never a closure); edits during the
        // request keep the buffer dirty.
        const snapshot = { ...buffer.current, parents: m.parents };
        const payload = JSON.stringify({
            title: snapshot.title,
            body: snapshot.body,
            format: snapshot.format,
            parents: snapshot.parents,
        });
        // keepalive only on the unload path, only when the body fits its 64 KiB cap - see
        // keepalive.js for the whole painful reason.
        const keepalive = keepaliveOk(unloading, new TextEncoder().encode(payload).length);
        try {
            const res = await api(`/api/identity/${root}/docs/${docId}`, {
                method: 'PUT',
                body: payload,
                keepalive,
            });
            m.parents = [res.version];
            const b = buffer.current;
            const unchanged =
                b.title === snapshot.title &&
                b.body === snapshot.body &&
                b.format === snapshot.format;
            m.dirty = !unchanged;
            setStatus(m.dirty ? 'dirty' : 'clean');
        } catch (e) {
            setError(e.message);
            setStatus('error'); // still dirty; the next trigger retries
        } finally {
            m.inflight = false;
        }
    };
    saveRef.current = save;

    // Any real input arms the shadow and re-debounces the autosave clock.
    const touched = () => {
        const m = machine.current;
        m.dirty = true;
        setStatus('dirty');
        if (m.timer) clearTimeout(m.timer);
        m.timer = setTimeout(() => saveRef.current(), AUTOSAVE_MS);
    };

    // Pin / unpin this document (a doc-meta flag that floats it to the top of the list). The
    // current state comes from the live row at click time, so the button always toggles right.
    const togglePin = async (isPinned) => {
        try {
            await api(`/api/identity/${root}/docs/${docId}/pin`, {
                method: isPinned ? 'DELETE' : 'PUT',
            });
        } catch (e) {
            setError(e.message);
            setStatus('error');
        }
    };

    // Delete this document: a reversible tombstone (the version chain stays; the doc drops out
    // of every list). Disarm the buffer FIRST - otherwise the doc-switch unmount flush would
    // save a fresh version onto the doc we're deleting. Then navigate away via onDeleted.
    const remove = async () => {
        if (!confirm('Delete this document? It leaves the list right away.')) return;
        const m = machine.current;
        m.dirty = false;
        if (m.timer) clearTimeout(m.timer);
        try {
            await api(`/api/identity/${root}/docs/${docId}`, { method: 'DELETE' });
            onDeleted && onDeleted();
        } catch (e) {
            setError(e.message);
            setStatus('error');
        }
    };

    useEffect(() => {
        load().catch((e) => {
            setError(e.message);
            setStatus('error');
        });
        // Doc switch / unmount: flush whatever's unsaved, drop timers.
        return () => {
            const m = machine.current;
            if (m.timer) clearTimeout(m.timer);
            if (m.waitTimer) clearTimeout(m.waitTimer);
            if (m.dirty) saveRef.current();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [root, docId]);

    // Tab hidden (close, switch away): flush with keepalive so the words leave the building
    // even if the tab doesn't come back. This is the ONE save that passes unloading - a
    // React unmount (doc switch) doesn't abort fetches, so only a real page-away needs it.
    useEffect(() => {
        const onHide = () => {
            if (document.visibilityState === 'hidden') saveRef.current({ unloading: true });
        };
        document.addEventListener('visibilitychange', onHide);
        return () => document.removeEventListener('visibilitychange', onHide);
    }, []);

    // The remembered view mode: hydrate this doc's last pick from the mirror's local-only
    // prefs table; picking writes it back. The functional set means a click that beats the
    // read wins - hydration never clobbers a human. A remembered mode the current format
    // can't offer just sits clamped (the effective-mode rule below) and resurfaces if the
    // doc converts back.
    useEffect(() => {
        let alive = true;
        openMirror(root)
            .prefs.get(`mode:${docId}`)
            .then((row) => {
                if (alive && row && MODES[row.value]) {
                    setChosenMode((cur) => cur ?? row.value);
                }
            })
            .catch(() => {});
        return () => {
            alive = false;
        };
    }, [root, docId]);

    const pickMode = (m) => {
        setChosenMode(m);
        openMirror(root)
            .prefs.put({ key: `mode:${docId}`, value: m })
            .catch(() => {});
    };

    // The lookout: watch this doc's mirror row, reload when the row knows something this
    // buffer hasn't presented. The judgment lives in lookout.js as a pure predicate - it has
    // been field-tested wrong twice (the module's comment is the scar record), so it earns
    // tests of its own. Change + dirty → keep typing; the fork is deliberate and presents
    // right after the next save lands.
    const row = useLive(() => openMirror(root).docs.get(docId), [root, docId]);
    useEffect(() => {
        const m = machine.current;
        if (!row || !loaded || m.dirty || m.inflight) return;
        const seen = m.seen || { diverged: false, heads: 1 };
        if (needsReload(row, m.parents, seen)) {
            load().catch(() => {});
        }
        // `status` is a dep so a row update skipped during an inflight save gets re-judged
        // when the save settles - the row may never change again to re-fire this effect.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [row && row.head, row && row.heads, row && row.diverged, status]);

    if (status === 'opening' && !loaded) {
        return html`<div class="reader"><p class="null-sub">opening…</p></div>`;
    }
    if (status === 'error' && !loaded) {
        return html`<div class="reader"><p class="form-error">${error}</p></div>`;
    }

    const statusTip = {
        clean: 'Saved — every change is stored',
        dirty: 'Unsaved — your edits will save on their own in a moment',
        saving: 'Saving…',
        error: 'Not saved — the last save failed; it will keep retrying',
        waiting: 'On its way — some words are still arriving from another computer',
        opening: 'Opening…',
    }[status];

    // Turbolink cards for whatever the buffer holds - resolves via the node's unfurl
    // endpoint; the profile's identity changes as cards land, re-rendering every surface.
    const tlProfile = useTurbolinks(body, format);

    // Side-by-side scroll sync, both directions - the pattern from marquee-react-renderer's
    // own demo ("the honest prototype of the editor we're heading toward"). Forward: the
    // textarea cursor centers the nearest rendered node and outlines it. Reverse: clicking
    // a rendered node puts the cursor on its source span. The echo guard is load-bearing:
    // setSelectionRange fires `select`, which would run the forward sync and yank the very
    // node you clicked out from under you; cleared on a timeout so a `select` that never
    // arrives can't leave it stuck.
    const previewRef = useRef(null); // MarqueeHandle
    const sourceRef = useRef(null); // the side-by-side textarea
    const markedRef = useRef(null); // the currently-outlined preview element
    const echoRef = useRef(false);
    const syncToCursor = () => {
        const handle = previewRef.current;
        const ta = sourceRef.current;
        if (!handle || !ta || echoRef.current) return;
        if (markedRef.current) markedRef.current.classList.remove('editor-cursor-node');
        markedRef.current = null;
        // NEAREST, not "containing": a cursor on the blank line between two paragraphs is
        // contained only by the document, and centering *that* is a trip to nowhere.
        const el = handle.elementNear(ta.selectionStart);
        if (!el) return;
        handle.scrollToSource(ta.selectionStart);
        el.classList.add('editor-cursor-node');
        markedRef.current = el;
    };
    const syncToNode = (_node, span) => {
        const ta = sourceRef.current;
        if (!ta || !span) return;
        echoRef.current = true;
        ta.focus();
        ta.setSelectionRange(span.start, span.end);
        setTimeout(() => {
            echoRef.current = false;
        }, 0);
        if (markedRef.current) markedRef.current.classList.remove('editor-cursor-node');
        markedRef.current = null;
        rememberCursor(root, docId, span.start, span.end);
    };

    // Every caret movement in the textarea is noted (and forwards to the scroll sync);
    // restoration happens when a textarea surface (re)appears - a mode switch or a return
    // to this doc - clamped to the current body, focused so the caret is visibly home.
    const noteCaret = (e) => {
        rememberCursor(root, docId, e.currentTarget.selectionStart, e.currentTarget.selectionEnd);
        syncToCursor();
    };

    // The effective mode: the user's pick if the format still offers it, else the format's
    // default (a marquee doc opens interactive; converting it to plaintext clamps an
    // interactive/side pick back to the plain textarea). The app narrows the offered modes
    // (Recipes offers only interactive); if its list leaves nothing for this format, fall back
    // to the format's full set rather than trapping the doc.
    let available = modesFor(format).filter((m) => feat.modes.includes(m));
    if (available.length === 0) available = modesFor(format);
    const mode =
        chosenMode && available.includes(chosenMode)
            ? chosenMode
            : available.includes(defaultMode(format))
            ? defaultMode(format)
            : available[0];

    // Caret restoration for the textarea surfaces: when one (re)appears - a mode switch, or
    // a return to this doc - put the caret back where it last sat in this document, clamped
    // to the current body, focused so it's visibly home. (The interactive surface does the
    // same itself, via LiveMarquee's initialSelection.)
    useEffect(() => {
        if (mode !== 'plain' && mode !== 'side') return;
        const ta = sourceRef.current;
        const at = recallCursor(root, docId);
        if (!ta || !at || !loaded) return;
        const len = ta.value.length;
        // Selection BEFORE focus: browsers scroll a focused textarea to its caret, so this
        // order gets "back where I was" to also mean scrolled there.
        ta.setSelectionRange(Math.min(at.start, len), Math.min(at.end, len));
        ta.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, loaded && docId]);

    // The rendered document, shared by side-by-side and read-only. Strict parse first: a
    // broken document (usually a conflict that split a block) degrades honestly - the side
    // pane shows the parse error, read-only falls back to source, and nothing is lost.
    let rendered = null;
    if (format === 'marquee' && (mode === 'side' || mode === 'read')) {
        try {
            parse(body);
            rendered = html`<div class="reader-marquee"><${Marquee}
                ref=${previewRef}
                source=${body}
                animate="visible"
                profile=${tlProfile}
                onNodeClick=${syncToNode}
            /></div>`;
        } catch (e) {
            rendered =
                mode === 'read'
                    ? html`<div>
                          <p class="null-sub">
                              this marquee doesn't parse right now (likely a conflict split a
                              block) - showing the source; edit to tidy it
                          </p>
                          <pre class="reader-plain">${body}</pre>
                      </div>`
                    : html`<p class="form-error">marquee doesn't parse: ${e.message}</p>`;
        }
    }

    const sourcePane = html`<textarea
        class="editor-body"
        ref=${sourceRef}
        value=${body}
        onInput=${(e) => {
            setBody(e.currentTarget.value);
            touched();
        }}
        onBlur=${save}
        onSelect=${noteCaret}
        onClick=${noteCaret}
        onKeyUp=${noteCaret}
        spellcheck="true"
    ></textarea>`;

    return html`
        <div class="reader">
            <header class="reader-head">
                ${mode === 'read'
                    ? html`<span class="editor-title editor-title-read">${title || 'untitled'}</span>`
                    : html`<input
                          class="editor-title"
                          value=${title}
                          onInput=${(e) => {
                              setTitle(e.currentTarget.value);
                              touched();
                          }}
                          onBlur=${() => saveRef.current()}
                          placeholder="untitled"
                      />`}
                <span class="reader-chips">
                    ${loaded.diverged &&
                    (loaded.resolution === 'conflict'
                        ? html`<span class="chip chip-diverged" title="Conflict — edited in the same place on two computers; tidy the versions below and save to settle it"><${Icons.conflict} /></span>`
                        : html`<span class="chip chip-merged" title="Merged — changes from two computers woven together cleanly; your next save seals the weave"><${Icons.merged} /></span>`)}
                    ${feat.format &&
                    html`<button
                        class="chip chip-button"
                        title=${format === 'marquee'
                            ? 'Marquee — click to convert this document to plaintext'
                            : 'Plaintext — click to convert this document to Marquee'}
                        onClick=${() => {
                            setFormat(format === 'plaintext' ? 'marquee' : 'plaintext');
                            touched();
                        }}
                    ><${format === 'marquee' ? Icons.formatMarquee : Icons.formatPlain} /></button>`}
                    <span
                        class=${status === 'error' ? 'chip chip-diverged' : 'chip'}
                        title=${statusTip}
                    >${status === 'clean'
                        ? html`<${Icons.saved} />`
                        : status === 'error'
                        ? html`<${Icons.warn} />`
                        : html`<span class="status-spin"><${Icons.spinner} /></span>`}</span>
                    ${feat.debug &&
                    html`<button
                        class="chip chip-button"
                        title=${dump
                            ? 'Debug — click to close the version-history dump'
                            : 'Debug — click to dump this document’s full version history'}
                        onClick=${async () => {
                            if (dump) return setDump(null);
                            try {
                                const d = await api(`/api/identity/${root}/docs/${docId}/debug`);
                                setDump(JSON.stringify(d, null, 2));
                            } catch (e) {
                                setDump(`debug dump failed: ${e.message}`);
                            }
                        }}
                    ><${Icons.debug} /></button>`}
                    <button
                        class=${showMeta ? 'chip chip-button chip-open' : 'chip chip-button'}
                        title="tags, date & description"
                        onClick=${() => setShowMeta((v) => !v)}
                    ><${Icons.tag} /></button>
                    <button
                        class=${row && row.pinned ? 'chip chip-button chip-pinned' : 'chip chip-button'}
                        title=${row && row.pinned
                            ? 'Pinned — click to unpin it from the top of the list'
                            : 'Not pinned — click to pin it to the top of the list'}
                        onClick=${() => togglePin(row && row.pinned)}
                    ><${Icons.pin} /></button>
                    ${onDeleted &&
                    html`<button
                        class="chip chip-button chip-delete"
                        title="Delete — removes this document from every list (its history is kept)"
                        onClick=${remove}
                    ><${Icons.trash} /></button>`}
                </span>
                ${showMeta &&
                html`<div class="editor-meta">
                    <${Annotations} root=${root} docId=${docId} features=${feat} />
                </div>`}
            </header>
            ${available.length > 1 &&
            html`<div class="editor-tabs">
                ${available.map(
                    (m) => html`<button
                        key=${m}
                        class=${mode === m ? 'tab active' : 'tab'}
                        title=${MODES[m]}
                        onClick=${() => pickMode(m)}
                    ><${MODE_ICONS[m]} /></button>`
                )}
            </div>`}
            ${status === 'error' && html`<p class="form-error">${error}</p>`}
            ${dump != null
                ? html`<pre class="reader-plain debug-dump">${dump}</pre>`
                : status === 'waiting'
                ? html`<div class="editor-waiting">
                      <p class="null-sub">
                          <span class="waiting-dot"></span> Some of this document's words are
                          still on their way from another computer. They'll appear here on
                          their own - nothing is lost.
                      </p>
                  </div>`
                : mode === 'read'
                ? format === 'marquee'
                    ? rendered
                    : html`<pre class="reader-plain">${body}</pre>`
                : mode === 'interactive' && format === 'marquee'
                ? html`<${LiveMarquee}
                      body=${body}
                      profile=${tlProfile}
                      initialSelection=${recallCursor(root, docId)}
                      onCursor=${(start, end) => rememberCursor(root, docId, start, end)}
                      onInput=${(text) => {
                          setBody(text);
                          touched();
                      }}
                      onBlur=${save}
                  />`
                : mode === 'side' && format === 'marquee'
                ? html`<div class="editor-side">
                      <div class="editor-side-source">${sourcePane}</div>
                      <div class="editor-side-preview">${rendered}</div>
                  </div>`
                : sourcePane}
        </div>
    `;
};
