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

export const Editor = ({ root, docId }) => {
    const [loaded, setLoaded] = useState(null); // the fetched detail this session started from
    const [title, setTitle] = useState('');
    const [body, setBody] = useState('');
    const [format, setFormat] = useState('plaintext');
    const [tab, setTab] = useState('write'); // 'write' | 'preview' (marquee only)
    const [status, setStatus] = useState('opening'); // opening | clean | dirty | saving | error
    const [error, setError] = useState(null);

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
        setLoaded(doc);
        setTitle(doc.title);
        setBody(doc.body);
        setFormat(doc.format);
        setTab('write');
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

    // The lookout: watch this doc's mirror row. Head moved + clean buffer → another computer
    // saved and we have nothing at stake: fast-forward by reloading. Head moved + dirty →
    // keep typing; the fork is deliberate and presents itself next open.
    const row = useLive(() => openMirror(root).docs.get(docId), [root, docId]);
    useEffect(() => {
        const m = machine.current;
        if (!row || !loaded || m.dirty || m.inflight) return;
        if (!m.parents.includes(row.head)) {
            load().catch(() => {});
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [row && row.head]);

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

    let preview = null;
    if (format === 'marquee' && tab === 'preview') {
        try {
            parse(body); // strict parse first: a broken document previews as its error
            preview = html`<div class="reader-marquee"><${Marquee} source=${body} animate="visible" /></div>`;
        } catch (e) {
            preview = html`<p class="form-error">marquee doesn't parse: ${e.message}</p>`;
        }
    }

    return html`
        <div class="reader">
            <header class="reader-head">
                <input
                    class="editor-title"
                    value=${title}
                    onInput=${(e) => {
                        setTitle(e.currentTarget.value);
                        touched();
                    }}
                    placeholder="untitled"
                />
                <span class="reader-chips">
                    ${loaded.diverged &&
                    html`<span class="chip chip-diverged" title="edited on two computers - the versions are shown below; tidy and save to resolve">diverged</span>`}
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
                </span>
            </header>
            ${format === 'marquee' &&
            html`<div class="editor-tabs">
                <button
                    class=${tab === 'write' ? 'tab active' : 'tab'}
                    onClick=${() => setTab('write')}
                >write</button>
                <button
                    class=${tab === 'preview' ? 'tab active' : 'tab'}
                    onClick=${() => setTab('preview')}
                >preview</button>
            </div>`}
            ${status === 'error' && html`<p class="form-error">${error}</p>`}
            ${status === 'waiting'
                ? html`<div class="editor-waiting">
                      <p class="null-sub">
                          <span class="waiting-dot"></span> Some of this document's words are
                          still on their way from another computer. They'll appear here on
                          their own - nothing is lost.
                      </p>
                  </div>`
                : tab === 'preview' && format === 'marquee'
                ? preview
                : html`<textarea
                      class="editor-body"
                      value=${body}
                      onInput=${(e) => {
                          setBody(e.currentTarget.value);
                          touched();
                      }}
                      onBlur=${save}
                      spellcheck="true"
                  ></textarea>`}
        </div>
    `;
};
