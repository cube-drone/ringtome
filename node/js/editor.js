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

export const Editor = ({ root, docId }) => {
    const [loaded, setLoaded] = useState(null); // the fetched detail this session started from
    const [title, setTitle] = useState('');
    const [body, setBody] = useState('');
    const [format, setFormat] = useState('plaintext');
    const [chosenMode, setChosenMode] = useState(null); // null = follow the format's default
    const [status, setStatus] = useState('opening'); // opening | clean | dirty | saving | error
    const [error, setError] = useState(null);
    const [dump, setDump] = useState(null); // TEMPORARY: the merge-debug history dump

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

    const save = async () => {
        const m = machine.current;
        if (!m.dirty || m.inflight) return;
        if (m.parents.length === 0) return; // waiting room: nothing loaded to save against
        m.inflight = true;
        setStatus('saving');
        // Snapshot what we're saving (from the ref, never a closure); edits during the
        // request keep the buffer dirty.
        const snapshot = { ...buffer.current, parents: m.parents };
        try {
            const res = await api(`/api/identity/${root}/docs/${docId}`, {
                method: 'PUT',
                body: JSON.stringify({
                    title: snapshot.title,
                    body: snapshot.body,
                    format: snapshot.format,
                    parents: snapshot.parents,
                }),
                keepalive: true, // survives tab-hide saves
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

    // Tab hidden (close, switch away): flush with keepalive - the words leave the building
    // even if the tab doesn't come back.
    useEffect(() => {
        const onHide = () => {
            if (document.visibilityState === 'hidden') saveRef.current();
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

    const statusWord = {
        clean: 'saved',
        dirty: 'unsaved',
        saving: 'saving…',
        error: 'not saved!',
        waiting: 'on its way…',
        opening: '…',
    }[status];

    // The effective mode: the user's pick if the format still offers it, else the format's
    // default (a marquee doc opens interactive; converting it to plaintext clamps an
    // interactive/side pick back to the plain textarea).
    const available = modesFor(format);
    const mode =
        chosenMode && available.includes(chosenMode) ? chosenMode : defaultMode(format);

    // The rendered document, shared by side-by-side and read-only. Strict parse first: a
    // broken document (usually a conflict that split a block) degrades honestly - the side
    // pane shows the parse error, read-only falls back to source, and nothing is lost.
    let rendered = null;
    if (format === 'marquee' && (mode === 'side' || mode === 'read')) {
        try {
            parse(body);
            rendered = html`<div class="reader-marquee"><${Marquee} source=${body} animate="visible" /></div>`;
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
        value=${body}
        onInput=${(e) => {
            setBody(e.currentTarget.value);
            touched();
        }}
        onBlur=${save}
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
                          placeholder="untitled"
                      />`}
                <span class="reader-chips">
                    ${loaded.diverged &&
                    (loaded.resolution === 'conflict'
                        ? html`<span class="chip chip-diverged" title="edited in the same place on two computers - both versions are below; tidy and save to settle it">conflict</span>`
                        : html`<span class="chip chip-merged" title="changes from two computers, woven together cleanly - your next save seals the weave">merged</span>`)}
                    <button
                        class="chip chip-button"
                        title="how this document reads; converting is an ordinary save"
                        onClick=${() => {
                            setFormat(format === 'plaintext' ? 'marquee' : 'plaintext');
                            touched();
                        }}
                    >${format}</button>
                    <span class=${status === 'error' ? 'chip chip-diverged' : 'chip'}>
                        ${statusWord}
                    </span>
                    <button
                        class="chip chip-button"
                        title="TEMPORARY: dump this document's full version history for debugging"
                        onClick=${async () => {
                            if (dump) return setDump(null);
                            try {
                                const d = await api(`/api/identity/${root}/docs/${docId}/debug`);
                                setDump(JSON.stringify(d, null, 2));
                            } catch (e) {
                                setDump(`debug dump failed: ${e.message}`);
                            }
                        }}
                    >${dump ? 'close debug' : 'debug'}</button>
                </span>
            </header>
            <div class="editor-tabs">
                ${available.map(
                    (m) => html`<button
                        key=${m}
                        class=${mode === m ? 'tab active' : 'tab'}
                        onClick=${() => pickMode(m)}
                    >${MODES[m]}</button>`
                )}
            </div>
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
