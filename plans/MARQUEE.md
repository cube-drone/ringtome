# Marquee, upstream

**What we've found in Marquee - the markup language and its libraries, our own
(`~/code/marqueemarkup`) but released on its own schedule - and handed over.**
Started 2026-10-08. Each open item is written to be handed over as it stands:
where, what, why it matters to Horse Drawing Tycoon 2, and a suggested fix.
Curtis routes them; when a release fixes one, it moves to _Fixed_ with the
version, and the version bump lands in HISTORY as usual.

We are on **0.9.2** everywhere (2026-10-09): the npm packages
(`@cube-drone/marquee-*`) and the pinned crates (`cube-drone-marquee-parser`,
`-markup`, and `-markdown`, which export uses). Neither request below is in it
yet.

## Open

### An XHTML output mode for the HTML renderer

_Asked for 2026-10-09; Curtis is adding it._

`marquee-html-renderer` (the crate, `src/render.rs`, and the npm package to
match) writes HTML5: void elements unclosed - `<br>` and `<hr>` (`render.rs`
lines 167 and 202 in 0.9.1), `<img …>` for emoji and embeds (194, 266) - and
nothing stops a named entity like `&nbsp;` reaching the output. That's right for
a web page and wrong for an **ePub**, whose pages must be well-formed XML: a
strict reader refuses the book, a lenient one guesses. Horse Drawing Tycoon 2
wants to download a notebook or a public book as an ePub (2026-10-09), its pages
rendered by this renderer.

**Suggested fix:** an output mode - an option beside `render_marquee`
(`render_marquee_with(source, profile, Output::Xhtml)`, or a field on a render
options struct) - in which every void element closes itself (`<br/>`, `<hr/>`,
`<img …/>`), attributes are always quoted, and only XML's own five entities
appear, everything else as itself or a numeric reference. Embedder vocabulary
(`Profile::directive`, `turbolink`) returns HTML the renderer can't rewrite, so
the contract should say a profile used in XHTML mode must return XHTML too.

### A hook that rewrites where a link goes

_Asked for 2026-10-09._

`marquee-html-renderer`, `Profile::link_allowed`: a profile may say whether a
target becomes a link, but not where it points. Embeds already have this -
`Profile::media` returns a `MediaResolution` whose `url` the renderer uses - but
links don't. Horse Drawing Tycoon 2 needs it twice over:

- **An ePub** (above): a link from one note to another must point at the other's
  chapter inside the book (`chapter-07.xhtml#…`), not at the app's address,
  which a reader offline can't follow.
- **An export** (plans/EXPORT.md, _Not yet_): the `.md` files keep app addresses
  for links between notes, where the zip's own paths would do.

Without the hook, both have to rewrite targets in the Marquee source before
rendering, which means a second parse and a serializer round trip.

**Suggested fix:** `fn link_target(&self, target: &str) -> Option<String>`
beside `link_allowed`, defaulting to `None` (keep the target as written): `Some`
is the address the anchor uses. Asked after `link_allowed` says yes, so a
refused link stays refused. The Markdown bridge (`marquee_markdown`) would want
the same hook for the export's `.md` files.

### Not upstream: the ePub's own rules

For the record, so nobody hands them over: what an ePub may embed is ours to
decide, through the profile the renderer already asks. **No embedded sound** -
`Profile::media` returns `None` for audio, and the renderer's inert fallback
stands in. **Limited turbolink expansion** - `Profile::turbolink_level` caps it,
and `turbolink` returning `None` is the plain link. **Pictures inside the
book** - `media`'s `url` points at the copy in the zip. **Emoji as text** -
`Profile::emoji` returns `Text`. All of it is an ePub profile on our side.

## Fixed

- **The editor's block cache keyed on position** (`marquee-codemirror`,
  `renderBlock`): typing one character shifted every block below the caret and
  missed the cache for all of them. Handed over 2026-10-08; fixed in **0.9.2**,
  which keys on the node's type and its source text alone.
- **The React renderer dropped alt text on video and audio**: an image got
  `alt`, but a described clip lost its description inside the app. Found
  2026-10-08; fixed in **0.9.2**, where audio and every video branch carry
  `aria-label` from the alt text, as the static renderer does.

- **The live preview ignored `by=letter` and `by=word`** (rainbow, bounce, and
  the rest of the per-unit effects), which the side-by-side view drew. Handed
  over 2026-10-08; fixed in **0.9.1**, where the preview draws them with the
  renderer's own code and carries `direction` and `speed` too.
