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
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import htm from 'htm';
import {
    EditorView,
    keymap,
    placeholder as cmPlaceholder,
    drawSelection,
    tooltips,
} from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { stripSelfOrigin, pastedPicture } from '../pure/portable.js';
import { autocompletion } from '@codemirror/autocomplete';
import { marquee } from '@cube-drone/marquee-codemirror';
import { vim as vimKeys } from '@replit/codemirror-vim';
import { smallestChange } from '../pure/caret.js';

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
    // Extra key bindings (CodeMirror keymap entries), ahead of the default keymap and behind
    // the pickers' own (Enter with a picker open still picks) - the chat composer's
    // Enter-sends, Shift-Enter-breaks (CHAT.md, ruling 7). Bind through a ref: the map is
    // built once, at mount. Optional.
    keys,
    // Hint text shown while the surface is empty. Optional. A surface with a hint also draws
    // its own cursor (CodeMirror's drawSelection): the hint is an inline widget in the empty
    // line, and Firefox puts the NATIVE caret beside such a widget above the line, half
    // hidden (Curtis, 2026-09-18) - a drawn cursor sits where the measured text is, in every
    // browser.
    placeholder,
    // A caret the host asks for: `{ at, focus, seq }` - put the caret at `at` (a new `seq` is a
    // new ask), and focus the surface only when `focus` says so (Curtis, 2026-09-27: after an
    // image goes in, the caret lands right after it). Optional.
    caret,
    // Vim keys (Curtis, 2026-10-07, Writer's application setting): @replit/codemirror-vim, in a
    // Compartment of its own so the switch takes effect without remounting. Optional.
    vim,
}) => {
    const host = useRef(null);
    const view = useRef(null);
    // The marquee extension takes its profile at configure time; a Compartment lets a new
    // profile (turbolink data arriving) swap it live, rebuilding decorations in place.
    const marqueeConf = useRef(new Compartment());
    // Vim's keymap must come FIRST to win key precedence (marquee-codemirror's README); it draws its
    // own block cursor and its `:` line, superseding the extension's cursor while on.
    const vimConf = useRef(new Compartment());
    // True while WE are dispatching the external replace - those doc changes are sync, not
    // typing, and must not reach onInput (which arms the dirty flag).
    const syncing = useRef(false);
    // Fresh callbacks every render, stable identity for the extensions (the timer-and-unmount
    // stale-closure lesson from doc/editor.js, applied here).
    const hooks = useRef({});
    hooks.current = { onInput, onBlur, onCursor };

    // Built at commit, like the body and caret effects below - which run in declaration order
    // and so find the view already there.
    useLayoutEffect(() => {
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
                    vimConf.current.of(vim ? vimKeys() : []),
                    history(),
                    ...(keys && keys.length ? [keymap.of(keys)] : []),
                    keymap.of([...defaultKeymap, ...historyKeymap]),
                    ...(placeholder ? [cmPlaceholder(placeholder), drawSelection()] : []),
                    EditorView.lineWrapping,
                    // The pickers ride CodeMirror's own autocompletion: filter-as-you-type,
                    // arrows + Enter to pick, Escape (or just typing past) to wave it off.
                    ...(completions && completions.length
                        ? [autocompletion({ override: completions, icons: false })]
                        : []),
                    // The pickers live at the page's root, not inside the editor (Curtis,
                    // 2026-09-25: the feed composer's edges cut the emoji and people pickers
                    // off). CodeMirror draws tooltips inside its own DOM by default, so any
                    // ancestor that clips its overflow - a composer, a panel, a scroller -
                    // clips them too; parented on <body> they are positioned against the
                    // viewport, which CodeMirror also keeps them inside. Their styling
                    // survives the move: doc/completions.css is unscoped, and every token it
                    // reads is defined on :root (tokens.css).
                    tooltips({ parent: document.body }),
                    marqueeConf.current.of(marquee({ profile })),
                    EditorView.updateListener.of((u) => {
                        if (u.docChanged && !syncing.current) {
                            hooks.current.onInput(u.state.doc.toString());
                        }
                        if ((u.selectionSet || u.docChanged) && !syncing.current) {
                            const sel = u.state.selection.main;
                            hooks.current.onCursor?.(
                                Math.min(sel.anchor, sel.head),
                                Math.max(sel.anchor, sel.head),
                            );
                        }
                    }),
                    EditorView.domEventHandlers({
                        blur: () => hooks.current.onBlur && hooks.current.onBlur(),
                    }),
                    // Pasted absolute self-URLs arrive as their portable relative form, and a paste
                    // that is one picture's address arrives as the picture (pure/portable.js) - the
                    // transform happens at paste, never under the user's cursor at save time.
                    EditorView.clipboardInputFilter.of(
                        (text) =>
                            pastedPicture(text, window.location.origin) ||
                            stripSelfOrigin(text, window.location.origin),
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

    // A body changed from outside (an upload's placeholder, its swap for the reference, a
    // reload) goes in as the smallest change - the stretch between what the two share at the
    // start and at the end - so CodeMirror carries the caret, the scroll and the undo history
    // through it, rather than replacing everything and losing where you were.
    //
    // A LAYOUT effect, judged at commit, never a passive one (Curtis, 2026-10-02, Firefox: the
    // caret stopped behind letters just typed - "a blank page" came out "a lkan pageb"). A
    // passive effect waits for the next frame, and a keystroke landing inside that wait
    // re-renders the component, which first runs the waiting effect with ITS render's body -
    // one keystroke behind the view. That stale body read as an outside edit and took the new
    // letters out; the next render's effect put them back as an outside edit, which CodeMirror
    // maps the caret in FRONT of. At commit the body is the newest state there is, because a
    // keystroke's setBody re-renders in a microtask, before the next input event can arrive.
    useLayoutEffect(() => {
        const v = view.current;
        if (!v) return;
        const was = v.state.doc.toString();
        if (body === was) return;
        syncing.current = true;
        v.dispatch({ changes: smallestChange(was, body) });
        syncing.current = false;
    }, [body]);

    // After the body (and, like it, at commit), so the caret lands in the text it names.
    useLayoutEffect(() => {
        const v = view.current;
        if (!v || !caret) return;
        const at = Math.min(caret.at, v.state.doc.length);
        v.dispatch({ selection: { anchor: at }, scrollIntoView: true });
        if (caret.focus) v.focus();
    }, [caret && caret.seq]); // eslint-disable-line react-hooks/exhaustive-deps

    // The vim switch, flipped in the settings while a document is open, takes effect in place.
    useEffect(() => {
        const v = view.current;
        if (v) v.dispatch({ effects: vimConf.current.reconfigure(vim ? vimKeys() : []) });
    }, [vim]);

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
