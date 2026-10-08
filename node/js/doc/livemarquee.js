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
import { vim as vimKeys, Vim } from '@replit/codemirror-vim';
import { smallestChange } from '../pure/caret.js';

const html = htm.bind(h);

/// A completion's colour swatch, when it carries one (`swatch`, a hex), else nothing.
const swatchOf = (completion) => {
    if (!completion.swatch) return null;
    const dot = document.createElement('span');
    dot.className = 'completion-swatch';
    dot.style.background = completion.swatch;
    return dot;
};

// Vim keys, whole (Curtis, 2026-10-07). Vim hides the browser's own selection and draws nothing
// in its place: CodeMirror's `drawSelection` must, or a visual selection doesn't show at all (the
// vim package's README: "make sure you include drawSelection... to correctly render the selection
// in visual mode"). And block-visual (Ctrl-V) is one range per line, which CodeMirror collapses to
// one unless the state allows several - `basicSetup` does, and this editor doesn't use it.
const vimMode = () => [vimKeys(), drawSelection(), EditorState.allowMultipleSelections.of(true)];

// Vim's ex commands, as this app means them (Curtis, 2026-10-08). The vim package's commands are
// global, so each surface files its host's handlers under its own view (`vimHosts`), and a command
// finds the one it was typed in (`cm6`, the view behind vim's CodeMirror adapter). A command the
// host has no handler for does nothing.
//
//   :w            save now, rather than waiting out the autosave's debounce
//   :wq :x :q     save, and close the app - autosave means there are no changes to lose, so
//                 :q is :wq here; :q! and :e!, which exist to throw changes away, are left out
//   :f[ile] name  rename the note
//   :ene[w]       a new note in this notebook
//   :e[dit] name  the note of that name in this notebook - exact, then ignoring case, the newest
//                 of several (pure/bytitle.js) - or a new one by that name; bare :e does nothing
//   :vs[plit]     source beside preview (the side-by-side mode, which is a plain text box -
//                 vim stays behind in the interactive one)
//   :bn :bp       the next and previous note, as the editor's arrows walk them - and gt / gT
const vimHosts = new WeakMap();
const vimCommand = (name) => (cm, params) => {
    const run = vimHosts.get(cm.cm6)?.()?.[name];
    if (!run) return;
    if (MOVING.has(name)) focusHandoff = Date.now();
    run(params);
};

// A command that moves to another note hands the focus on (Curtis, 2026-10-08: "start with focus
// in the text window in that file"): the note opens in a fresh editor (doc/reader.js keys it by
// document), which focuses itself only when it remembers a caret - and a new note has none. The
// next editor to mount takes the hand-off, if it's fresh: ten seconds covers `:e` and `:enew`
// waiting on the node to make the note.
const MOVING = new Set(['open', 'newNote', 'next', 'prev']);
const HANDOFF_MS = 10_000;
let focusHandoff = 0;
Vim.defineEx('write', 'w', vimCommand('save'));
Vim.defineEx('wq', 'wq', vimCommand('quit'));
Vim.defineEx('xit', 'x', vimCommand('quit'));
Vim.defineEx('quit', 'q', vimCommand('quit'));
Vim.defineEx('file', 'f', vimCommand('rename'));
Vim.defineEx('enew', 'ene', vimCommand('newNote'));
Vim.defineEx('edit', 'e', vimCommand('open'));
Vim.defineEx('vsplit', 'vs', vimCommand('side'));
Vim.defineEx('bnext', 'bn', vimCommand('next'));
Vim.defineEx('bprevious', 'bp', vimCommand('prev'));
Vim.map('gt', ':bnext<CR>', 'normal');
Vim.map('gT', ':bprevious<CR>', 'normal');

// CodeMirror's own chrome in the colourway's tokens (Curtis, 2026-10-07/08). The app never tells
// CodeMirror it is dark, so it wears its light theme's fixed colours everywhere it draws for
// itself - a grey selection, and a near-white panel under vim's `:` line, which a dark colourway's
// light ink made white on white. `&.cm-editor`: one class more than the base theme's light/dark-
// scoped rules, so these win.
const houseTheme = EditorView.theme({
    // The drawn selection (vim's, and the placeholder surfaces'): the accent, washed out.
    '&.cm-editor .cm-selectionBackground, &.cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground':
        { background: 'color-mix(in srgb, var(--teal) 30%, transparent)' },
    // The panels (vim's command line and its messages): the colourway's field and ink.
    '&.cm-editor .cm-panels': { backgroundColor: 'var(--field)', color: 'var(--ink)' },
    '&.cm-editor .cm-panels-bottom': { borderTop: '1px solid var(--border)' },
    '&.cm-editor .cm-vim-panel, &.cm-editor .cm-vim-panel input': {
        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
        color: 'var(--ink)',
    },
    // Vim's search hits: the highlighter every search here uses.
    '&.cm-editor .cm-searchMatch': { backgroundColor: 'var(--marker)' },
});

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
    // What vim's ex commands do here (`vimHosts` above): `{ save, quit, rename(params), newNote,
    // side, next, prev }`, any of them absent. Read at the moment of the command. Optional.
    vimCommands,
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
    hooks.current = { onInput, onBlur, onCursor, vimCommands };

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
                    vimConf.current.of(vim ? vimMode() : []),
                    houseTheme,
                    history(),
                    ...(keys && keys.length ? [keymap.of(keys)] : []),
                    keymap.of([...defaultKeymap, ...historyKeymap]),
                    ...(placeholder ? [cmPlaceholder(placeholder), drawSelection()] : []),
                    EditorView.lineWrapping,
                    // The pickers ride CodeMirror's own autocompletion: filter-as-you-type,
                    // arrows + Enter to pick, Escape (or just typing past) to wave it off.
                    ...(completions && completions.length
                        ? [
                              autocompletion({
                                  override: completions,
                                  icons: false,
                                  // A colour option's swatch (doc/completions.js COLORS), ahead of
                                  // its name - the colour itself, so picking is by eye.
                                  addToOptions: [{ render: swatchOf, position: 20 }],
                              }),
                          ]
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
        vimHosts.set(v, () => hooks.current.vimCommands);
        if (Date.now() - focusHandoff < HANDOFF_MS) {
            focusHandoff = 0;
            v.focus();
        }
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
        if (v) v.dispatch({ effects: vimConf.current.reconfigure(vim ? vimMode() : []) });
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
