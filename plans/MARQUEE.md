# Marquee, upstream

**What we've found in Marquee - the markup language and its libraries, our own
(`~/code/marqueemarkup`) but released on its own schedule - and handed over.**
Started 2026-10-08. Each open item is written to be handed over as it stands:
where, what, why it matters to Horse Drawing Tycoon 2, and a suggested fix.
Curtis routes them; when a release fixes one, it moves to _Fixed_ with the
version, and the version bump lands in HISTORY as usual.

We are on **0.9.3** in Rust (2026-10-09): the pinned crates
(`cube-drone-marquee-parser`, `-markup`, `-markdown`, and `-html-renderer`
beneath them), in the node's and the desktop shell's lockfiles. The npm packages
(`@cube-drone/marquee-*`) are on **0.9.2**, the newest npm has - 0.9.3 was
published to crates.io only; nothing the browser draws needs it yet.

## Open

### Not upstream: the ePub's own rules

For the record, so nobody hands them over: what an ePub may embed is ours to
decide, through the profile the renderer already asks. **No embedded sound** -
`Profile::media` returns `None` for audio, and the renderer's inert fallback
stands in. **Limited turbolink expansion** - `Profile::turbolink_level` caps it,
and `turbolink` returning `None` is the plain link. **Pictures inside the
book** - `media`'s `url` points at the copy in the zip. **Emoji as text** -
`Profile::emoji` returns `Text`. All of it is an ePub profile on our side.

## Fixed

- **An XHTML output mode** (asked 2026-10-09 for the ePub): in **0.9.3**,
  `render_marquee_with(source, profile, Output::Xhtml)` - void elements close
  themselves, every attribute has a value, and only XML's own entities appear. A
  profile used with it must return XHTML from its own hooks too.
- **A hook that rewrites where a link goes** (asked 2026-10-09, for the ePub's
  chapter links and the export's `.md` files): in **0.9.3**,
  `Profile::link_target(target) -> Option<String>`, asked after `link_allowed`
  for links, turbolinks and an embed's fallback link - the visible text stays
  the author's - and `marquee_markdown::Options::link_target` for the Markdown
  bridge.

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
