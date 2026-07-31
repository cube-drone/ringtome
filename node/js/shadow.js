// A shadow buffer over a live value: local while you type, saved on your terms, adopting the mirror
// again once it's clean. This is the shadow overlay of PROJECT_PLAN's *The Browser Is a View* at
// form-field scale - the stream is always right about what's stored, and must never be allowed to
// repaint a field mid-edit.
//
// Three copies of this machine existed (the profile fields, the annotation fields, the claimed
// date), agreeing on every subtle part and differing only in what a save does. The subtle parts, all
// of them load-bearing:
//
//   - the value rides a REF as well as state, so a debounced timer or an unmount flush reads what is
//     on screen now rather than what was there when the closure was made;
//   - a failed save goes back to DIRTY, so the next blur or keystroke retries it rather than
//     silently dropping the edit;
//   - the adopt-the-mirror effect is gated on `dirty`, which is the whole point: an echo of someone
//     else's save lands in the field, an echo arriving mid-edit does not.
import { useState, useEffect, useRef } from 'preact/hooks';

/**
 * @param mirrorValue  the stored value, live from the mirror - adopted whenever the buffer is clean
 * @param save         async (value) => void; throwing leaves the buffer dirty to retry
 * @param debounceMs   wait this long after the last edit before saving; omit to save on every edit
 * @param key          the identity this buffer belongs to (a doc id, a field name). Changing it
 *                     flushes the old one - switching documents must not strand an unsaved edit.
 */
export function useShadowValue(mirrorValue, { save, debounceMs, key } = {}) {
    const [value, setValue] = useState(mirrorValue);
    const valueRef = useRef(value);
    valueRef.current = value;
    const dirty = useRef(false);
    const timer = useRef(null);
    const saveRef = useRef(save);
    saveRef.current = save;

    useEffect(() => {
        if (!dirty.current) setValue(mirrorValue);
         
    }, [mirrorValue]);

    const flush = async () => {
        if (!dirty.current) return;
        const v = valueRef.current;
        dirty.current = false;
        try {
            await saveRef.current(v);
        } catch {
            dirty.current = true; // a failed write stays dirty; blur or the next edit retries
        }
    };

    const set = (v) => {
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
         
        [key]
    );

    return { value, set, flush, onInput: (e) => set(e.currentTarget.value) };
}
