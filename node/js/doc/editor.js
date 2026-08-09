// The editor - where never-lose-words meets a keyboard. The four client obligations
// (NOTES_APP, The sync model), each with its mechanism here:
//
// 1. **Debounced autosave**: ~10s after the last keystroke, on blur, on tab-hide (keepalive),
//    and on doc switch. A clean buffer never saves; the node's no-op bounce is the floor
//    under us, not the plan.
// 2. **Check the head before saving**: the live mirror row is our lookout. If the head moves
//    while the buffer is CLEAN, the editor quietly reloads (fast-forward). If it moves while
//    dirty, we keep typing and the next save forks knowingly - the server keeps both, and the
//    conflict presents in-document on the next open. Never blind-save, never lose.
// 3. **Conflicts present in the document**: a diverged doc loads its synthesized tangle into
//    the buffer (markers, device labels). Editing it and saving - with every head as parents
//    - IS the resolution. The editor is the merge tool.
// 4. **The synthesized tangle starts clean, not dirty**: `dirty` arms only on real input, so
//    autosave can never commit a tangle the user hasn't touched.
//
// This buffer IS the shadow overlay (PROJECT_PLAN, The Browser Is a View): local state the
// stream must never repaint. The mirror is watched, never rendered into the textarea; the
// save response fast-forwards our parents without a refetch.
import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';

import { readPref, setPref, viewModeKey } from '../mirror/prefs.js';
import { Chip, NavChips } from './chips.js';
import { MarqueeBody, marqueeApology, parseError } from './marqueebody.js';
import { useDocSession } from './session.js';
import { LiveMarquee } from './livemarquee.js';
import { useTurbolinks } from './turbolinks.js';
import { Annotations } from './annotations.js';
import { useUploadCapture } from './upload.js';
import { stripSelfOrigin } from '../pure/portable.js';
import { emojiCompletions, linkCompletions, mediaCompletions } from './completions.js';
import { slugPathFor } from './address.js';
import { featuresOf, editorModes } from '../pure/apps.js';
import { Icons } from '../icons.js';

const html = htm.bind(h);

// The view modes. Modes are a VIEW choice, format is a DOCUMENT property - they meet in
// modesFor: a Marquee doc offers all four, a plaintext doc only the two that make sense
// without a renderer. Defaults per format, chosen when the user hasn't picked.
const MODES = {
    interactive: 'interactive', // live preview: styling projected onto the source in place
    side: 'side by side', // source pane + rendered pane
    plain: 'plaintext', // the raw source in a plain textarea
    read: 'read only', // the rendered document, nothing editable
};
// (The availability computation itself lives in pure/apps.js `editorModes`, vectored - it
// carries the house rules: side-by-side hides the plain tab, an empty app list falls back.)
const defaultMode = (format) => (format === 'marquee' ? 'interactive' : 'plain');

// The mode tabs show icons, not words; the words (MODES) live in each tab's tooltip.
const MODE_ICONS = {
    interactive: Icons.modeInteractive,
    side: Icons.modeSide,
    plain: Icons.modePlain,
    read: Icons.modeRead,
};

// Where you were in each document - shared by every editing surface, so switching modes (or
// leaving and returning to a doc) lands the cursor where it last sat. Deliberately a module
// Map, NOT the mirror's prefs table: a cursor is incidental working state, not a choice -
// cross-tab storage would make two tabs on one doc clobber each other, and a stale cursor
// is noise. Per tab, per session, like scroll positions everywhere else on the web.
const cursorMemory = new Map();
const rememberCursor = (root, docId, start, end) =>
    cursorMemory.set(`${root}:${docId}`, { start, end });
const recallCursor = (root, docId) => cursorMemory.get(`${root}:${docId}`) || null;

export const Editor = ({ root, docId, features, onDeleted, nav, bucket, foot }) => {
    const feat = features || featuresOf();
    // The save engine - loading, the buffer, autosave, divergence lookout - is the shared
    // document session; the Editor just composes chrome around it.
    const {
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
    } = useDocSession(root, docId, { onDeleted });

    const [chosenMode, setChosenMode] = useState(null); // null = follow the format's default
    const [showMeta, setShowMeta] = useState(false); // the tags/date/description dropdown
    // The copy-a-cozy-link chip: computes this doc's derived address (doc/address.js) and puts it on
    // the clipboard - the crosslink you paste into another document.
    const [linkCopied, setLinkCopied] = useState(false);
    const copyLink = async () => {
        const p = await slugPathFor(root, docId, bucket);
        if (!p) return;
        try {
            await navigator.clipboard.writeText(p);
        } catch {
            return; // clipboard denied: no false "copied!"
        }
        setLinkCopied(true);
        setTimeout(() => setLinkCopied(false), 1600);
    };

    // File upload + crosslink drops: the shared capture hook (doc/upload.js) - placeholders at the
    // cursor, the modal, the reference swap, and the dragged-document cozy dressing. The chip
    // opens the picker; drop and paste land on the surface handlers below.
    const {
        catchDrop,
        allowFileDrag,
        catchPaste,
        pickFiles,
        extras: uploadExtras,
    } = useUploadCapture({
        root,
        bucket,
        intoTree: !!feat.tree,
        format,
        body,
        setBody,
        touched,
        cursorPos: () => {
            const c = recallCursor(root, docId);
            return c ? (typeof c.end === 'number' ? c.end : c.start) || 0 : null;
        },
    });

    // The remembered view mode: hydrate this doc's last pick from prefs, then let the local
    // buffer own it. READ once rather than watched, deliberately - the functional set means a
    // click that beats the read wins, so hydration never clobbers a human. A remembered mode the
    // current format can't offer just sits clamped (the effective-mode rule below) and resurfaces
    // if the doc converts back.
    useEffect(() => {
        let alive = true;
        readPref(root, viewModeKey(docId)).then((value) => {
            if (alive && value && MODES[value]) setChosenMode((cur) => cur ?? value);
        });
        return () => {
            alive = false;
        };
    }, [root, docId]);

    const pickMode = (m) => {
        setChosenMode(m);
        setPref(root, viewModeKey(docId), m);
    };

    // Every hook stays ABOVE the two early returns below - hooks are counted by call order,
    // and a hook list that grows once `loaded` flips is correct only by accident (field-found
    // by the lint gate, 2026-07-30). Guards inside each hook carry the not-yet-loaded case.

    // Turbolink cards for whatever the buffer holds - resolves via the node's unfurl
    // endpoint; the profile's identity changes as cards land, re-rendering every surface.
    const tlProfile = useTurbolinks(body, format);

    // The scroll-sync/caret ref quartet (their story is with the sync closures, below).
    const previewRef = useRef(null); // MarqueeHandle
    const sourceRef = useRef(null); // the side-by-side textarea
    const markedRef = useRef(null); // the currently-outlined preview element
    const echoRef = useRef(false);

    // The effective mode: the user's pick if the format still offers it, else the format's
    // default (a marquee doc opens interactive; converting it to plaintext clamps an
    // interactive/side pick back to the plain textarea). The app narrows the offered modes
    // (the Feed drops the read tab); if its list leaves nothing for this format, fall back
    // to the format's full set rather than trapping the doc.
    const available = editorModes(format, feat.modes);
    const mode =
        chosenMode && available.includes(chosenMode)
            ? chosenMode
            : available.includes(defaultMode(format))
            ? defaultMode(format)
            : available[0];

    // Caret restoration for the textarea surfaces: when one (re)appears - a mode switch, or
    // a return to this doc - put the caret back where it last sat in this document, clamped
    // to the current body, focused so it's visibly home. (The interactive surface does the
    // same itself, via LiveMarquee's initialSelection.)
    useEffect(() => {
        if (mode !== 'plain' && mode !== 'side') return;
        const ta = sourceRef.current;
        const at = recallCursor(root, docId);
        if (!ta || !at || !loaded) return;
        const len = ta.value.length;
        // Selection BEFORE focus: browsers scroll a focused textarea to its caret, so this
        // order gets "back where I was" to also mean scrolled there.
        ta.setSelectionRange(Math.min(at.start, len), Math.min(at.end, len));
        ta.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, loaded && docId]);

    if (status === 'opening' && !loaded) {
        return html`<div class="reader"><p class="null-sub">opening…</p></div>`;
    }
    if (status === 'error' && !loaded) {
        return html`<div class="reader"><p class="form-error">${error}</p></div>`;
    }

    const statusTip = {
        clean: 'Saved — every change is stored',
        dirty: 'Unsaved — your edits will save on their own in a moment',
        saving: 'Saving…',
        error: 'Not saved — the last save failed; it will keep retrying',
        waiting: 'On its way — some words are still arriving from another computer',
        opening: 'Opening…',
    }[status];

    // Side-by-side scroll sync, both directions - the pattern from marquee-react-renderer's
    // own demo ("the honest prototype of the editor we're heading toward"). Forward: the
    // textarea cursor centers the nearest rendered node and outlines it. Reverse: clicking
    // a rendered node puts the cursor on its source span. The echo guard is load-bearing:
    // setSelectionRange fires `select`, which would run the forward sync and yank the very
    // node you clicked out from under you; cleared on a timeout so a `select` that never
    // arrives can't leave it stuck.
    const syncToCursor = () => {
        const handle = previewRef.current;
        const ta = sourceRef.current;
        if (!handle || !ta || echoRef.current) return;
        if (markedRef.current) markedRef.current.classList.remove('editor-cursor-node');
        markedRef.current = null;
        // NEAREST, not "containing": a cursor on the blank line between two paragraphs is
        // contained only by the document, and centering *that* is a trip to nowhere.
        const el = handle.elementNear(ta.selectionStart);
        if (!el) return;
        handle.scrollToSource(ta.selectionStart);
        el.classList.add('editor-cursor-node');
        markedRef.current = el;
    };
    const syncToNode = (_node, span) => {
        const ta = sourceRef.current;
        if (!ta || !span) return;
        echoRef.current = true;
        ta.focus();
        ta.setSelectionRange(span.start, span.end);
        setTimeout(() => {
            echoRef.current = false;
        }, 0);
        if (markedRef.current) markedRef.current.classList.remove('editor-cursor-node');
        markedRef.current = null;
        rememberCursor(root, docId, span.start, span.end);
    };

    // Every caret movement in the textarea is noted (and forwards to the scroll sync);
    // restoration happens when a textarea surface (re)appears - a mode switch or a return
    // to this doc - clamped to the current body, focused so the caret is visibly home.
    const noteCaret = (e) => {
        rememberCursor(root, docId, e.currentTarget.selectionStart, e.currentTarget.selectionEnd);
        syncToCursor();
    };

    // The rendered document, shared by side-by-side and read-only (doc/marqueebody.js owns the
    // parse gate). The side pane wants the parse ERROR - you are editing, so the reason is the
    // useful thing - while read-only degrades to the source with an apology.
    const rendered =
        format === 'marquee' && (mode === 'side' || mode === 'read')
            ? html`<${MarqueeBody}
                  source=${body}
                  profile=${tlProfile}
                  handle=${previewRef}
                  onNodeClick=${syncToNode}
                  onUnparsable=${mode === 'read' ? marqueeApology : parseError}
              />`
            : null;

    const sourcePane = html`<textarea
        class="editor-body"
        ref=${sourceRef}
        value=${body}
        onInput=${(e) => {
            setBody(e.currentTarget.value);
            touched();
        }}
        onPaste=${(e) => {
            // Pasted absolute self-URLs land in their portable relative form (the interactive
            // surface does the same via CodeMirror's clipboard filter). Text only, and only
            // when the transform changes something - file pastes and ordinary text fall
            // through untouched, so the upload capture upstream still gets its turn.
            const text = e.clipboardData && e.clipboardData.getData('text/plain');
            if (!text) return;
            const fixed = stripSelfOrigin(text, window.location.origin);
            if (fixed === text) return;
            e.preventDefault();
            const ta = e.currentTarget;
            ta.setRangeText(fixed, ta.selectionStart, ta.selectionEnd, 'end');
            setBody(ta.value);
            touched();
        }}
        onBlur=${save}
        onSelect=${noteCaret}
        onClick=${noteCaret}
        onKeyUp=${noteCaret}
        spellcheck="true"
    ></textarea>`;

    // Which surface you write on. Five cases, read as five early returns rather than a nested
    // ternary: the waiting room preempts everything (there are no words to edit yet), then the
    // mode, and a mode the format cannot honour falls through to the plain textarea. That last
    // fall-through is why this is not a switch - `interactive` and `side` are marquee-only, and
    // clamping them here means the mode tabs never have to.
    const writingSurface = () => {
        if (status === 'waiting') {
            return html`<div class="editor-waiting">
                <p class="null-sub">
                    <span class="waiting-dot"></span> Some of this document's words are still on
                    their way from another computer. They'll appear here on their own - nothing is
                    lost.
                </p>
            </div>`;
        }
        if (mode === 'read') {
            return format === 'marquee' ? rendered : html`<pre class="reader-plain">${body}</pre>`;
        }
        if (mode === 'interactive' && format === 'marquee') {
            return html`<${LiveMarquee}
                body=${body}
                profile=${tlProfile}
                completions=${[
                    emojiCompletions,
                    linkCompletions(root, bucket),
                    mediaCompletions(root, bucket),
                ]}
                initialSelection=${recallCursor(root, docId)}
                onCursor=${(start, end) => rememberCursor(root, docId, start, end)}
                onInput=${(text) => {
                    setBody(text);
                    touched();
                }}
                onBlur=${save}
            />`;
        }
        if (mode === 'side' && format === 'marquee') {
            return html`<div class="editor-side">
                <div class="editor-side-source">${sourcePane}</div>
                <div class="editor-side-preview">${rendered}</div>
            </div>`;
        }
        return sourcePane;
    };

    return html`
        <div class="reader" onDrop=${catchDrop} onDragOver=${allowFileDrag} onPaste=${catchPaste}>
            <header class="reader-head">
                ${mode === 'read'
                    ? html`<span class="editor-title editor-title-read">${title || 'untitled'}</span>`
                    : html`<input
                          class="editor-title"
                          value=${title}
                          onInput=${(e) => {
                              setTitle(e.currentTarget.value);
                              touched();
                          }}
                          onBlur=${() => save()}
                          placeholder="untitled"
                      />`}
                <span class="reader-chips">
                    ${onDeleted &&
                    html`<${Chip}
                        icon=${Icons.trash}
                        modifier="chip-delete"
                        title="Delete — removes this document from every list (its history is kept)"
                        onClick=${remove}
                    />`}
                    ${loaded.diverged &&
                    (loaded.resolution === 'conflict'
                        ? html`<${Chip}
                              icon=${Icons.conflict}
                              modifier="chip-diverged"
                              title="Conflict — edited in the same place on two computers; tidy the versions below and save to settle it"
                          />`
                        : html`<${Chip}
                              icon=${Icons.merged}
                              modifier="chip-merged"
                              title="Merged — changes from two computers woven together cleanly; your next save seals the weave"
                          />`)}
                    ${feat.format &&
                    html`<${Chip}
                        icon=${format === 'marquee' ? Icons.formatMarquee : Icons.formatPlain}
                        title=${format === 'marquee'
                            ? 'Marquee — click to convert this document to plaintext'
                            : 'Plaintext — click to convert this document to Marquee'}
                        onClick=${() => {
                            setFormat(format === 'plaintext' ? 'marquee' : 'plaintext');
                            touched();
                        }}
                    />`}
                    <${Chip}
                        icon=${Icons.upload}
                        title="Upload — attach a file to this document (drop or paste works too)"
                        onClick=${pickFiles}
                    />
                    <${Chip}
                        icon=${Icons.link}
                        on=${linkCopied}
                        title=${linkCopied
                            ? 'Copied!'
                            : 'Copy a link to this document (paste it into another document to crosslink)'}
                        onClick=${copyLink}
                    />
                    <${Chip} modifier=${status === 'error' ? 'chip-diverged' : null} title=${statusTip}>
                        ${status === 'clean'
                            ? html`<${Icons.saved} />`
                            : status === 'error'
                            ? html`<${Icons.warn} />`
                            : html`<span class="status-spin"><${Icons.spinner} /></span>`}
                    </${Chip}>
                    <${Chip}
                        icon=${Icons.tag}
                        on=${showMeta}
                        title="tags, date & description"
                        onClick=${() => setShowMeta((v) => !v)}
                    />
                    ${feat.pin &&
                    html`<${Chip}
                        icon=${Icons.pin}
                        modifier=${row && row.pinned ? 'chip-pinned' : null}
                        title=${row && row.pinned
                            ? 'Pinned — click to unpin it from the top of the list'
                            : 'Not pinned — click to pin it to the top of the list'}
                        onClick=${() => togglePin(row && row.pinned)}
                    />`}
                    <${NavChips} nav=${nav} />
                </span>
                ${showMeta &&
                html`<div class="editor-meta">
                    <${Annotations} root=${root} docId=${docId} features=${feat} />
                </div>`}
            </header>
            ${available.length > 1 &&
            html`<div class="editor-tabs">
                ${available.map(
                    (m) => html`<button
                        key=${m}
                        class=${mode === m ? 'tab active' : 'tab'}
                        title=${MODES[m]}
                        onClick=${() => pickMode(m)}
                    ><${MODE_ICONS[m]} /></button>`
                )}
            </div>`}
            ${status === 'error' && html`<p class="form-error">${error}</p>`}
            ${writingSurface()}
            ${/* A host's own footer (the Feed composer's Post button): a render-prop so the
                host can flush the save and take the confirmed words - the editor owns the
                session, the host owns what happens at the end. */ ''}
            ${foot && foot({ save, status, body, title })}
            ${uploadExtras}
        </div>
    `;
};
