# Marquee, upstream

**What we've found in Marquee - the markup language and its libraries, our own
(`~/code/marqueemarkup`) but released on its own schedule - and handed over.**
Started 2026-10-08. Each open item is written to be handed over as it stands:
where, what, why it matters to Horse Drawing Tycoon 2, and a suggested fix.
Curtis routes them; when a release fixes one, it moves to _Fixed_ with the
version, and the version bump lands in HISTORY as usual.

We are on **0.9.1** everywhere: the npm packages (`@cube-drone/marquee-*`) and
the pinned crates (`cube-drone-marquee-parser`, `-markup`).

## Open

### The editor's block cache keys on position

_Handed over 2026-10-08; still so in 0.9.1._

`marquee-codemirror`, `src/marquee.ts`, `renderBlock`: rendered HTML is cached
by `` `${span.start}:${source.slice(span.start, span.end)}` ``. The file's own
header says the cache is keyed by a block's source text, so an unedited block
hits it - but `span.start` is in the key too, and typing one character shifts
the start of every block below the caret. Every one of those misses on every
keystroke and re-renders; only `BlockWidget.eq` comparing the HTML keeps
CodeMirror from rebuilding their DOM, so nothing flails, it just costs. In a
long note, typing near the top re-renders the whole document per keystroke - one
of the costs in the Firefox typing profile (NEXT_STEPS, the frontend audit: "the
editor parses each keystroke three times").

**Suggested fix:** key on the source text alone. If a block's output can depend
on where it sits (a footnote's number, a heading's id), put _that_ in the key
rather than the offset - the block's ordinal among its kind, say - so moving
text above a block doesn't evict it.

### The React renderer drops alt text on video and audio

_Found 2026-10-08, not yet handed over._

`marquee-react-renderer`, `src/render.ts`, `embed()`: an image gets
`alt: node.alt`, but audio and video get nothing - the alt text in
`![a horse galloping](clip.webm)` is parsed and then discarded. The HTML
renderer (`marquee-html-renderer`, `src/render.ts`, `embed()`) labels both with
`aria-label`, including the silent looping video. So the same post is labelled
for a screen reader on its published page and unlabelled inside the app, which
renders with the React renderer. It matters more now that uploads ask for a
description and use it as alt text: a described video loses it in the app.

**Suggested fix:** match the HTML renderer -
`"aria-label": node.alt || undefined` on the `audio` element and on both `video`
branches.

## Fixed

- **The live preview ignored `by=letter` and `by=word`** (rainbow, bounce, and
  the rest of the per-unit effects), which the side-by-side view drew. Handed
  over 2026-10-08; fixed in **0.9.1**, where the preview draws them with the
  renderer's own code and carries `direction` and `speed` too.
