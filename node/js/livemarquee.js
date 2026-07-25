// The interactive Marquee surface: @cube-drone/marquee-codemirror's Obsidian-style live
// preview, wrapped for Preact. The document never stops being plain Marquee source - styling
// is *projected onto* the text as CodeMirror decorations, blocks the cursor isn't in render
// fully, and the block under the cursor opens to its source. There is no rich-text model, so
// the editor's save machinery sees exactly the same thing a textarea would: a string.
//
// The controlled-CodeMirror dance: the view owns its state during typing (recreating it per
// keystroke would trash cursor and undo history), so the `body` prop only *replaces* the doc
// when it disagrees with what the view holds - which, because onInput keeps the parent in
// step, happens exactly when the change came from outside: a load, a lookout reload, a
// conflict presenting itself.
import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import htm from 'htm';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { marquee } from '@cube-drone/marquee-codemirror';

const html = htm.bind(h);

export const LiveMarquee = ({ body, onInput, onBlur }) => {
    const host = useRef(null);
    const view = useRef(null);
    // True while WE are dispatching the external replace - those doc changes are sync, not
    // typing, and must not reach onInput (which arms the dirty flag).
    const syncing = useRef(false);
    // Fresh callbacks every render, stable identity for the extensions (the timer-and-unmount
    // stale-closure lesson from editor.js, applied here).
    const hooks = useRef({});
    hooks.current = { onInput, onBlur };

    useEffect(() => {
        const v = new EditorView({
            parent: host.current,
            state: EditorState.create({
                doc: body,
                extensions: [
                    history(),
                    keymap.of([...defaultKeymap, ...historyKeymap]),
                    EditorView.lineWrapping,
                    marquee(),
                    EditorView.updateListener.of((u) => {
                        if (u.docChanged && !syncing.current) {
                            hooks.current.onInput(u.state.doc.toString());
                        }
                    }),
                    EditorView.domEventHandlers({
                        blur: () => hooks.current.onBlur && hooks.current.onBlur(),
                    }),
                ],
            }),
        });
        view.current = v;
        return () => {
            v.destroy();
            view.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const v = view.current;
        if (v && body !== v.state.doc.toString()) {
            syncing.current = true;
            v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: body } });
            syncing.current = false;
        }
    }, [body]);

    return html`<div class="editor-live" ref=${host}></div>`;
};
