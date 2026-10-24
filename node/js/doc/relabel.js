// A renamed note's links follow it (Curtis, 2026-10-23: "if I'd created a link [JEFF KAPLAN], I
// probably _would_ want it renamed"). The node does the following (store `relabel_links`): every
// note whose links or pictures name this one in its old title's words takes the new one. This is
// the asking: on letting go of the title, never per keystroke - a title box autosaves as it is
// typed, and each letter would be an edit to every linking note.
import { useRef } from 'preact/hooks';

import { api } from '../net.js';
import { t } from '../i18n.js';
import { toast } from '../toasts.js';

/// `loaded` is the session's opened document, `title` its title now. Returns `relabel(settledOn?)`:
/// call it when the title lets go (blur, a vim `:file`), with the title it settled on if that's
/// newer than the render's.
export function useRelabel(root, docId, loaded, title) {
    // The title the links last wore: the note's as it opened, then each one it settled on.
    const wore = useRef({ docId: null, title: '' });
    if (loaded && loaded.doc_id === docId && wore.current.docId !== docId) {
        wore.current = { docId, title: loaded.title || '' };
    }
    return async (settledOn = title) => {
        const was = wore.current;
        const now = (settledOn || '').trim();
        // An emptied title is a title being rewritten, not one the links should wear.
        if (was.docId !== docId || !was.title.trim() || !now || now === was.title.trim()) return;
        wore.current = { docId, title: now };
        try {
            const { changed } = await api(`/api/identity/${root}/docs/${docId}/relabel`, {
                method: 'POST',
                body: JSON.stringify({ from: was.title, to: now }),
            });
            if (changed === 1) {
                toast(
                    t('doc.relabel.one', 'the link to it in 1 note now says “{title}”', {
                        title: now,
                    }),
                );
            } else if (changed) {
                toast(
                    t('doc.relabel.n', 'the links to it in {n} notes now say “{title}”', {
                        n: changed,
                        title: now,
                    }),
                );
            }
        } catch {
            wore.current = was; // the next letting-go asks again
        }
    };
}
