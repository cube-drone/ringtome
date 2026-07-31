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
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { stripSelfOrigin } from '../pure/portable.js';
import { autocompletion } from '@codemirror/autocomplete';
import { marquee } from '@cube-drone/marquee-codemirror';

const html = htm.bind(h);

export const LiveMarquee = ({
    body,
    profile,
    initialSelection,
    onInput,
    onBlur,
    onCursor,
    // Contextual pop-up helpers (doc/completions.js sources): pickers that hover at the caret when
    // their trigger character is typed. Optional; absent means no autocompletion extension.
    completions,
}) => {
    const host = useRef(null);
    const view = useRef(null);
    // The marquee extension takes its profile at configure time; a Compartment lets a new
    // profile (turbolink data arriving) swap it live, rebuilding decorations in place.
    const marqueeConf = useRef(new Compartment());
    // True while WE are dispatching the external replace - those doc changes are sync, not
    // typing, and must not reach onInput (which arms the dirty flag).
    const syncing = useRef(false);
    // Fresh callbacks every render, stable identity for the extensions (the timer-and-unmount
    // stale-closure lesson from doc/editor.js, applied here).
    const hooks = useRef({});
    hooks.current = { onInput, onBlur, onCursor };

    useEffect(() => {
        // Land where the host remembers the caret sitting (clamped: the body may have
        // changed shape since), and scroll it home so "return to a doc" means returning.
        const at = initialSelection
            ? {
                  anchor: Math.min(initialSelection.start, body.length),
                  head: Math.min(initialSelection.end, body.length),
              }
            : undefined;
        const v = new EditorView({
            parent: host.current,
            state: EditorState.create({
                doc: body,
                selection: at,
                extensions: [
                    history(),
                    keymap.of([...defaultKeymap, ...historyKeymap]),
                    EditorView.lineWrapping,
                    // The pickers ride CodeMirror's own autocompletion: filter-as-you-type,
                    // arrows + Enter to pick, Escape (or just typing past) to wave it off.
                    ...(completions && completions.length
                        ? [autocompletion({ override: completions, icons: false })]
                        : []),
                    marqueeConf.current.of(marquee({ profile })),
                    EditorView.updateListener.of((u) => {
                        if (u.docChanged && !syncing.current) {
                            hooks.current.onInput(u.state.doc.toString());
                        }
                        if ((u.selectionSet || u.docChanged) && !syncing.current) {
                            const sel = u.state.selection.main;
                            hooks.current.onCursor?.(
                                Math.min(sel.anchor, sel.head),
                                Math.max(sel.anchor, sel.head)
                            );
                        }
                    }),
                    EditorView.domEventHandlers({
                        blur: () => hooks.current.onBlur && hooks.current.onBlur(),
                    }),
                    // Pasted absolute self-URLs arrive as their portable relative form
                    // (pure/portable.js) - the transform happens at paste, never under the
                    // user's cursor at save time.
                    EditorView.clipboardInputFilter.of((text) =>
                        stripSelfOrigin(text, window.location.origin)
                    ),
                ],
            }),
        });
        if (at) {
            v.dispatch({ effects: EditorView.scrollIntoView(at.anchor, { y: 'center' }) });
            v.focus();
        }
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

    // A new profile identity (freshly resolved turbolink cards) reconfigures the extension;
    // decorations rebuild against the same untouched source.
    useEffect(() => {
        const v = view.current;
        if (v) {
            v.dispatch({ effects: marqueeConf.current.reconfigure(marquee({ profile })) });
        }
         
    }, [profile]);

    return html`<div class="editor-live" ref=${host}></div>`;
};
