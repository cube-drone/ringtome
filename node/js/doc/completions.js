// Contextual pop-up helpers while typing (CodeMirror autocompletion sources): type the tag's
// first character and a searchable picker hovers at the caret - pick to fill the whole tag, or
// just keep typing and it steps aside (Escape also dismisses; it never blocks the keys).
//
// The trio, complete: `:` emoji, `[` a link picker over the current bucket's documents, `!` a
// media picker over the bucket's files - each a source in this module, handed to LiveMarquee
// by the hosting editor.
import { nameToEmoji } from 'gemoji';

import { openMirror } from '../mirror.js';
import { slugPathFor } from './address.js';
import { slugify, MEDIA_EXT } from '../pure/naming.js';

/// Plain membership - the app rule (`bucketHolds`) mirrored for the pickers, ONE copy for
/// both (the link and media pickers each carried their own and one drifted - the second copy
/// was the finding). The unbucketed live only in the everything-view now (settled 2026-08-01),
/// so no picker offers strays.
const inBucket = (d, bucket) => (d.buckets || []).includes(bucket);

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
/// document in the current bucket, read live off the mirror per pop (async sources are the
/// contract; Dexie answers in a beat). Picking fills the whole `[title](link)` tag - the
/// id-form immediately (always valid), dressed in its cozy address the moment that computes,
/// exactly like the drag-a-document drop. Typing the closing `]` yourself folds the picker
/// away: a hand-written link is never interfered with.
export function linkCompletions(root, bucket) {
    return async (context) => {
        const word = context.matchBefore(/\[[^\]\n]*$/);
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
        return { from: word.from + 1, options, validFor: /^[^\]\n]*$/ };
    };
}

// The kind a media format reads as, for the picker's detail column.
const MEDIA_KIND = { avif: 'image', apng: 'image', webm: 'video', opus: 'audio' };

/// The `!` picker, also a factory: a searchable list of the bucket's MEDIA (images, video,
/// audio). Picking fills the whole embed - `![title](…/body/name.ext)`, the byte-URL form
/// with the extension the renderer's kind sniff needs (the same reference uploads and drags
/// write), so the media renders inline immediately. Pops on a bare `!` (word characters keep
/// it filtering; a space folds it - "wow! " never holds it open) and on the `![` opener; no
/// `validFor`, so the region re-derives per keystroke as `!` grows into `![`.
export function mediaCompletions(root, bucket) {
    return async (context) => {
        const word = context.matchBefore(/!(\[[^\]\n]*|[\w-]*)$/);
        if (!word) return null;
        const prefixLen = word.text.startsWith('![') ? 2 : 1;
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
                        const embed = `![${label}](/api/identity/${root}/docs/${d.doc_id}/body/${slug}.${MEDIA_EXT[d.format]})`;
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
