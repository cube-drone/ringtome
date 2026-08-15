// The document editing SESSION - the save engine every editing surface shares (Notes' full
// editor, a Journal entry, whatever comes next). It loads a document, holds its buffer, autosaves
// on a debounce, flushes on blur/unmount/tab-hide, and keeps a lookout on the mirror so an edit
// from another computer fast-forwards a CLEAN buffer (and forks knowingly when the buffer is
// dirty). None of the chrome - title inputs, chips, view modes - lives here; a surface composes
// its own around the values this hook returns.
//
// "Never lose words" is the whole contract, and it has scars (pure/keepalive.js, pure/lookout.js). This is
// moved verbatim from the old Editor; keep it faithful.
import { useState, useEffect, useRef } from 'preact/hooks';
import { api } from '../net.js';
import { openMirror, useLive } from '../mirror.js';
import { cachedDoc, rememberDoc } from '../mirror/doccache.js';
import { needsReload } from '../pure/lookout.js';
import { keepaliveOk } from '../pure/keepalive.js';
import { parse } from '@cube-drone/marquee-react-renderer';
import { overCapTargets, replaceTargets, EMBED_CAP } from '../pure/embedcap.js';
import { t } from '../i18n.js';

const AUTOSAVE_MS = 10_000;

// A live document editing session. Returns the buffer state and the actions a surface needs;
// `onDeleted` is called after a successful delete (a surface uses it to navigate away).
export function useDocSession(root, docId, { onDeleted } = {}) {
    const [loaded, setLoaded] = useState(null); // the fetched detail this session started from
    const [title, setTitle] = useState('');
    const [body, setBody] = useState('');
    const [format, setFormat] = useState('plaintext');
    const [status, setStatus] = useState('opening'); // opening | clean | dirty | saving | error
    const [error, setError] = useState(null);

    // Mutable save-machine state: parents to assert, dirtiness, timers. Refs, not state - the
    // save loop must see current values without re-render races. `buffer` mirrors the rendered
    // state every render, so timers and unmount flushes never save a stale closure.
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
        // Cache-first (mirror/doccache.js): a doc the mirror row still vouches for opens straight from
        // disk - no fetch, no "opening…" flash. The row's fingerprint moving (a save, a sync)
        // is exactly what invalidates it, so parents/heads from the cache are as trustworthy
        // as a fetch under the same row. Misses fetch and remember.
        let doc = await cachedDoc(root, docId);
        if (!doc) {
            doc = await api(`/api/identity/${root}/docs/${docId}`);
            rememberDoc(root, docId, doc); // fire-and-forget; a failed write is a miss later
        }
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

    /// The rescued body, or null when nothing needs (or survives) rescue.
    const rescueOverCap = (source) => {
        let ast;
        try {
            ast = parse(source);
        } catch {
            return null; // unparsable is the renderer's problem, not the cap's
        }
        const { over } = overCapTargets(ast, root, EMBED_CAP);
        if (!over.size) return null;
        const note = (alt) =>
            t('doc.session.embed-removed-over-cap', '(“{alt}” removed — one page holds {cap} embedded files)', {
                alt,
                cap: EMBED_CAP,
            });
        const { source: out } = replaceTargets(source, over, note);
        try {
            if (overCapTargets(parse(out), root, EMBED_CAP).over.size > 0) return null;
        } catch {
            return null;
        }
        return out;
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
        // The paste rescue: a marquee body embedding more than the cap would be REFUSED by
        // the server, and a refusal at autosave is a treadmill - every retry fails until a
        // human edits, while the words live only in this tab. So over-cap embeds (they can
        // only arrive by paste; the upload funnel refuses at the gesture) are replaced with
        // refusal text, which IS saveable, and the rewrite lands in the visible editor -
        // never silently in the payload alone, which would fight the buffer forever. The
        // rewrite is trusted only after re-parsing under the cap; a body the surgery cannot
        // fix saves as-is and wears the server's refusal.
        if (snapshot.format === 'marquee') {
            const rescued = rescueOverCap(snapshot.body);
            if (rescued != null) {
                snapshot.body = rescued;
                setBody(rescued);
                buffer.current = { ...buffer.current, body: rescued };
            }
        }
        const payload = JSON.stringify({
            title: snapshot.title,
            body: snapshot.body,
            format: snapshot.format,
            parents: snapshot.parents,
        });
        // keepalive only on the unload path, only when the body fits its 64 KiB cap - see
        // pure/keepalive.js for the whole painful reason.
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
        // Doc switch / unmount: flush whatever's unsaved, drop timers. Reading the ref AT
        // CLEANUP TIME is the point - flush what is unsaved NOW, not what was unsaved when
        // the effect mounted. The machine is a mutable state machine behind a stable ref,
        // never a DOM node the renderer could have swapped underneath us.
        return () => {
            // eslint-disable-next-line react-hooks/exhaustive-deps
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

    // The lookout: watch this doc's mirror row, reload when the row knows something this buffer
    // hasn't presented. The judgment lives in pure/lookout.js as a pure predicate - field-tested wrong
    // twice (the module's comment is the scar record). Change + dirty → keep typing; the fork is
    // deliberate and presents right after the next save lands.
    const row = useLive(() => openMirror(root).docs.get(docId), [root, docId]);
    useEffect(() => {
        const m = machine.current;
        if (!row || !loaded || m.dirty || m.inflight) return;
        const seen = m.seen || { diverged: false, heads: 1 };
        if (needsReload(row, m.parents, seen)) {
            load().catch(() => {});
        }
        // `status` is a dep so a row update skipped during an inflight save gets re-judged when
        // the save settles - the row may never change again to re-fire this effect.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [row && row.head, row && row.heads, row && row.diverged, status]);

    return {
        loaded,
        status,
        error,
        title,
        setTitle,
        body,
        setBody,
        format,
        setFormat,
        save,
        touched,
        togglePin,
        remove,
        row,
    };
}
