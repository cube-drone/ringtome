// The annotations display register, read once per persona and shared by every card: a
// persona-level private register (`annotations_display/stop`) - the choice syncs with the
// person, like feed selectivity - cached in the module so thirty cards cost one read.
import { useState, useEffect } from 'preact/hooks';
import { api } from './net.js';
import { ANNOTATION_STOPS, DEFAULT_ANNOTATION_STOP } from './pure/annotations.js';

const cache = new Map(); // root -> stop
const listeners = new Set();

const notify = () => {
    for (const fn of listeners) fn();
};

async function load(root) {
    try {
        const r = await api(`/api/identity/${root}/private/kv/annotations_display`);
        const saved = ((r && r.values) || []).find((v) => v.key === 'stop');
        const known = saved && ANNOTATION_STOPS.some((s) => s.key === saved.value);
        cache.set(root, known ? saved.value : DEFAULT_ANNOTATION_STOP);
    } catch {
        cache.set(root, DEFAULT_ANNOTATION_STOP);
    }
    notify();
}

export function useAnnotationStop(root) {
    const [, bump] = useState(0);
    useEffect(() => {
        if (!root) return undefined;
        const fn = () => bump((n) => n + 1);
        listeners.add(fn);
        if (!cache.has(root)) load(root);
        return () => listeners.delete(fn);
    }, [root]);
    return root ? cache.get(root) || null : null;
}

export function setAnnotationStop(root, stop) {
    cache.set(root, stop);
    notify();
    api(`/api/identity/${root}/private/kv/annotations_display/stop`, {
        method: 'PUT',
        body: JSON.stringify({ value: stop }),
    }).catch(() => {});
}
