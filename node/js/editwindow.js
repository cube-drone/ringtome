// Is a post still inside its edit window (Curtis, 2026-09-27: past it, the feed stops offering the
// unlock)? A post can be improved for a day after it is first said (record/documents.rs,
// EDIT_WINDOW_MS); after that a re-publication is refused, so an unlock-and-edit would lead
// nowhere. The node is the one who knows - its window can be shortened for tests - and says so
// on every post it serves (`edit_window_open`). Where an item arrived with that answer it is used
// as is; otherwise the post's permalink is asked, once per post per few minutes.
import { useState, useEffect } from 'preact/hooks';

import { api } from './net.js';

const asked = new Map(); // `${author}/${postId}` -> { at, answer: Promise<boolean | null> }
/// A window that was open can close; an answer is trusted this long.
const FRESH_MS = 5 * 60 * 1000;

/// true while the post can still be edited, false once it cannot, null while unknown (and on a
/// failed ask - unknown is treated as open, as Writer's publish bar treats it). `known` is the
/// item's own `edit_window_open`, when it came with one; no `postId`, no question.
export function useEditWindowOpen(author, postId, known) {
    const [open, setOpen] = useState(typeof known === 'boolean' ? known : null);
    useEffect(() => {
        if (typeof known === 'boolean') {
            setOpen(known);
            return undefined;
        }
        if (!author || !postId) return undefined;
        const key = `${author}/${postId}`;
        let held = asked.get(key);
        if (!held || performance.now() - held.at > FRESH_MS) {
            held = {
                at: performance.now(),
                answer: api(`/api/id/${author}/posts/${postId}`)
                    .then((head) => head.edit_window_open !== false)
                    .catch(() => null),
            };
            asked.set(key, held);
        }
        let live = true;
        held.answer.then((answer) => live && setOpen(answer));
        return () => {
            live = false;
        };
    }, [author, postId, known]);
    return open;
}
