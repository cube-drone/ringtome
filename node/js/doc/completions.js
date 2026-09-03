// Contextual pop-up helpers while typing (CodeMirror autocompletion sources): type the tag's
// first character and a searchable picker hovers at the caret - pick to fill the whole tag, or
// just keep typing and it steps aside (Escape also dismisses; it never blocks the keys).
//
// The trio, complete: `:` emoji, `[` links AND Marquee's span tags (one bracket, two grammars -
// the picker offers both and your next keystrokes disambiguate), `!` a media picker over the
// bucket's files - each a source in this module, handed to LiveMarquee by the hosting editor.
import { nameToEmoji } from 'gemoji';

import { openMirror } from '../mirror.js';
import { slugPathFor } from './address.js';
import { slugify, MEDIA_EXT } from '../pure/naming.js';
import { OWN_MEDIA_KINDS, loopSuffix } from '../pure/mediakind.js';

/// Plain membership - the app rule (`bucketHolds`) mirrored for the pickers, ONE copy for
/// both (the link and media pickers each carried their own and one drifted - the second copy
/// was the finding). The unbucketed live only in the everything-view now (settled 2026-08-01),
/// so no picker offers strays.
const inBucket = (d, bucket) => (d.buckets || []).includes(bucket);

// Marquee's inline span tags - the OTHER thing a `[` can open (the parser decides span-vs-link
// by what follows, so at the bracket the intent is unknowable and the picker offers both). A
// hardcoded transcription of the spec's closed vocabulary (the span switch in
// marquee-html-renderer's render.js); if Marquee grows a tag this list won't know it, which
// costs a completion and nothing else. `value: true` marks the three that are inert without a
// `name=value` attribute, so the fill parks the cursor after the `=` instead of inside the pair.
const SPAN_TAGS = [
    { name: 'sup' },
    { name: 'sub' },
    { name: 'small' },
    { name: 'big' },
    { name: 'teeny' },
    { name: 'tiny' },
    { name: 'huge' },
    { name: 'enormous' },
    { name: 'size', value: true, hint: 'size=1-7' },
    { name: 'font', value: true, hint: 'font=name' },
    { name: 'color', value: true, hint: 'color=#rgb' },
    { name: 'spoiler' },
    { name: 'sidenote' },
    { name: 'aside' },
    { name: 'footnote' },
    { name: 'marquee' },
    { name: 'blink' },
    { name: 'rainbow' },
    { name: 'bounce' },
    { name: 'jitter' },
    { name: 'wave' },
    { name: 'rubber' },
    { name: 'typewriter' },
    { name: 'fadein' },
];

// Built once: every span tag as a completion. Picking fills the whole pair from the opening
// bracket, with placeholder text INSIDE it: `[wave]text[/wave]` with "text" selected so the
// next keystroke replaces it, or `[color=]text[/color]` with the cursor after the `=` for the
// value tags. The placeholder is not just affordance: an EMPTY effect pair crashes the live
// preview's decoration build ("Mark decorations may not be empty" - the effect mark has no
// text to cover), which silently aborts the very transaction that tried to insert it
// (field-found 2026-08-01: Enter and click on the picker both dead for every effect tag).
// The pair this fill writes is never empty, so the fill always lands; the hand-typed empty
// pair remains marquee-codemirror's bug to fix upstream.
const TAG_OPTIONS = SPAN_TAGS.map(({ name, value, hint }) => ({
    label: name,
    detail: hint || 'effect',
    apply: (view, _completion, from, to) => {
        const open = value ? `[${name}=]` : `[${name}]`;
        const start = from - 1;
        view.dispatch({
            changes: { from: start, to, insert: `${open}text[/${name}]` },
            selection: value
                ? { anchor: start + open.length - 1 }
                : { anchor: start + open.length, head: start + open.length + 'text'.length },
        });
    },
}));

// Built once: every gemoji as a completion - the label is the marquee source form (`:smile:`,
// what filling inserts; marquee renders it via the profile's emoji table), the detail shows
// the glyph itself so picking is visual.
const EMOJI_OPTIONS = Object.entries(nameToEmoji).map(([name, ch]) => ({
    label: `:${name}:`,
    detail: ch,
    boost: 0,
}));

/// The `:` picker. Matches a partial `:slug` behind the caret; CodeMirror filters the option
/// list as the slug grows. A completed `:slug:` stops matching, so the picker folds away the
/// moment an emoji is whole.
export function emojiCompletions(context) {
    const word = context.matchBefore(/:[\w+-]*$/);
    if (!word) return null;
    // Bare `:` only pops explicitly-adjacent to typing (it always is, when live), but never
    // fires on a colon inside a completed pair - the trailing-`:` case above.
    return {
        from: word.from,
        options: EMOJI_OPTIONS,
        validFor: /^:[\w+-]*$/,
    };
}

/// The `[` picker, as a FACTORY (it needs the notebook in view): a searchable list of every
/// document in the current bucket PLUS Marquee's span tags (TAG_OPTIONS above), because a `[`
/// legitimately opens either and only what you type next says which. Documents read live off
/// the mirror per pop (async sources are the contract; Dexie answers in a beat); picking one
/// fills the whole `[title](link)` tag - the id-form immediately (always valid), dressed in
/// its cozy address the moment that computes, exactly like the drag-a-document drop. Picking
/// a tag fills the open/close pair. Typing the closing `]` yourself folds the picker away: a
/// hand-written link (or tag) is never interfered with.
export function linkCompletions(root, bucket) {
    return async (context) => {
        // The interior class excludes `[` so the match anchors at the LAST bracket before the
        // caret, not the first: with `[` allowed inside, one stray unclosed bracket earlier in
        // the line swallowed every later one - the filter string became " b [rai", nothing
        // matched, and the picker silently refused to open for the rest of the line
        // (field-found 2026-08-01: "[rai wouldn't unfold"). A fresh `[` now restarts the
        // region, and validFor matches, so typing one re-queries instead of filtering on.
        const word = context.matchBefore(/\[[^[\]\n]*$/);
        if (!word) return null;
        // `![` belongs to the MEDIA picker (the embed opener) - the link picker steps aside.
        if (word.from > 0 && context.state.sliceDoc(word.from - 1, word.from) === '!') {
            return null;
        }
        const docs = await openMirror(root).docs.toArray();
        const options = docs
            .filter((d) => inBucket(d, bucket))
            .map((d) => {
                const label = (d.title || 'untitled').replace(/[[\]()]/g, '') || 'untitled';
                const isText = d.format === 'plaintext' || d.format === 'marquee';
                return {
                    label,
                    detail: isText ? undefined : d.format,
                    apply: (view, _completion, from, to) => {
                        // Replace from the opening bracket (one before the match region CM
                        // hands us - the region starts after `[` so titles filter cleanly).
                        const idText = `[${label}](/home/${slugify(bucket)}/${d.doc_id})`;
                        view.dispatch({
                            changes: { from: from - 1, to, insert: idText },
                            selection: { anchor: from - 1 + idText.length },
                        });
                        slugPathFor(root, d.doc_id, bucket).then((cozy) => {
                            if (!cozy) return;
                            const cozyText = `[${label}](${cozy})`;
                            try {
                                const cur = view.state.doc.toString();
                                const at = cur.indexOf(idText);
                                if (at === -1) return; // edited away meanwhile: their call
                                view.dispatch({
                                    changes: { from: at, to: at + idText.length, insert: cozyText },
                                });
                            } catch {
                                /* the view closed before the cozy form arrived - harmless */
                            }
                        });
                    },
                };
            });
        return { from: word.from + 1, options: [...options, ...TAG_OPTIONS], validFor: /^[^[\]\n]*$/ };
    };
}

// The kind a media format reads as, for the picker's detail column - the one table
// (pure/mediakind.js), shared with the renderer profile.
const MEDIA_KIND = OWN_MEDIA_KINDS;

/// The `!` picker, also a factory: a searchable list of the bucket's MEDIA (images, video,
/// audio). Picking fills the whole embed - `![title](…/body/name.ext)`, the byte-URL form
/// with the extension the renderer's kind sniff needs (the same reference uploads and drags
/// write), so the media renders inline immediately. A bare `!` pops only at the START of a
/// line (leading whitespace allowed): everywhere else it's ordinary punctuation, and Enter
/// with the picker open ACCEPTS - "Hello!" then a newline once embedded a donut (field-found
/// 2026-08-01). The explicit `![` opener still pops anywhere, because typing markdown's own
/// embed syntax is never an accident. No `validFor`, so the region re-derives per keystroke
/// as `!` grows into `![`.
export function mediaCompletions(root, bucket) {
    return async (context) => {
        // Interior excludes `[` for the same last-bracket anchoring as the link picker above.
        const word = context.matchBefore(/!(\[[^[\]\n]*|[\w-]*)$/);
        if (!word) return null;
        const explicit = word.text.startsWith('![');
        if (!explicit) {
            const line = context.state.doc.lineAt(word.from);
            if (context.state.sliceDoc(line.from, word.from).trim() !== '') return null;
        }
        const prefixLen = explicit ? 2 : 1;
        const docs = await openMirror(root).docs.toArray();
        const options = docs
            .filter((d) => MEDIA_EXT[d.format])
            .filter((d) => inBucket(d, bucket))
            .map((d) => {
                const label = (d.title || 'untitled').replace(/[[\]()]/g, '') || 'untitled';
                return {
                    label,
                    detail: MEDIA_KIND[d.format] || d.format,
                    apply: (view, _completion, from, to) => {
                        const slug =
                            slugify(label).replace(/-/g, '_').replace(/\.[^.]*$/, '') || 'file';
                        // A silent animation is spelled `-loop` (pure/mediakind.js), so the
                        // renderer draws it looping rather than with a player.
                        const embed = `![${label}](/api/identity/${root}/docs/${d.doc_id}/body/${slug}${loopSuffix(d.media && d.media.animation)}.${MEDIA_EXT[d.format]})`;
                        view.dispatch({
                            changes: { from: from - prefixLen, to, insert: embed },
                            selection: { anchor: from - prefixLen + embed.length },
                        });
                    },
                };
            });
        return { from: word.from + prefixLen, options };
    };
}
