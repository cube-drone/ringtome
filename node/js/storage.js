// What a persona's files take (storage.rs, 2026-10-02): per file, and the persona's cost to move.
// One answer per persona, shared by the files browser, its footing row and the open file's chip,
// asked again only when the persona's documents change - and then after a breath, so a run of
// saves is one ask. The node retallies only when the files moved, so an ask is cheap either way.
import { useEffect, useState } from 'preact/hooks';

import { api } from './net.js';

const answers = new Map(); // root -> the last answer
const listeners = new Map(); // root -> Set of setters
const timers = new Map(); // root -> the pending ask

/// How long after the documents change before asking again.
const SETTLE_MS = 2000;

function ask(root) {
    api(`/api/identity/${root}/storage`)
        .then((answer) => {
            answers.set(root, answer);
            for (const set of listeners.get(root) || []) set(answer);
            // Answered from a tally older than the files (the node retallies at most so often): ask
            // once more when it may - a file still arriving at the last tally gets its size then.
            if (answer && answer.stale) {
                clearTimeout(timers.get(root));
                timers.set(root, setTimeout(() => ask(root), (answer.retally_ms || 15000) + 500));
            }
        })
        .catch(() => {});
}

/**
 * The persona's storage: `{ files_bytes, db_bytes, move_bytes, evict_bytes, docs: { doc_id: bytes } }`,
 * or null until it lands. `changed` is anything that moves when the documents do (the list's
 * length and newest stamp); a new value asks again, settled.
 */
export function useStorage(root, changed) {
    const [answer, setAnswer] = useState(() => (root ? answers.get(root) || null : null));
    useEffect(() => {
        if (!root) return undefined;
        const set = listeners.get(root) || new Set();
        set.add(setAnswer);
        listeners.set(root, set);
        if (answers.has(root)) setAnswer(answers.get(root));
        else ask(root);
        return () => set.delete(setAnswer);
    }, [root]);
    useEffect(() => {
        if (!root || changed === undefined || !answers.has(root)) return;
        clearTimeout(timers.get(root));
        timers.set(root, setTimeout(() => ask(root), SETTLE_MS));
    }, [root, changed]);
    return answer;
}
