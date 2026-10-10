# Text helpers

Buttons in Writer's tool row that write Marquee for people who don't know
markup: select some words, press a button, and they're styled. A design draft
(2026-10-10); nothing built.

## The ask (Curtis, 2026-10-10)

> Marquee is a pretty vibrant language. [...] give me a quick recommendation on
> the highest value "helpful buttons" we could add to the editor for folks who
> are less, uh, experienced with markup? I'm imagining a font selector, an emoji
> applier, maybe a > quote, ...

The recommendation was four buttons and a stretch; Curtis agreed, cutting emoji:

> agreed: emoji can get cut. If a user selects any of these options with no text
> highlighted, just drop the word "text" in a the current cursor location,
> auto-highlighted, with the selected property. What's a little awkward is if a
> user jumps through six fonts: should it nest six different font selectors, or
> remember what the last thing changed was [...]

## Why buttons, when the autocomplete exists

The editor already knows most of the vocabulary (`doc/completions.js`): `[`
offers every span tag - each font by name, the colours, the size dial, the
effects' recipes - `:::` the block directives, `!` the media picker, `:` emoji.
None of it is found by someone who doesn't already know to type `[`. The buttons
are the way in for everyone else, and they read the **same tables** the
completions do (fonts, colours, sizes, effects), moved out of completions.js
into a pure module both use, so the two can never disagree about what Marquee
has.

## The buttons

In the tool row (doc/editor.js `tools`), after image and before the format chip;
in a narrow window, in the **edit** menu with the rest. Each opens a small menu.
Marquee documents only, as the row's other rich-text tools are.

1. **Effects** ✨ - the thing that makes Marquee Marquee, and that nobody
   guesses: rainbow, wave, bounce, blink, jitter, rubber, marquee, typewriter,
   fadein, spoiler. Each entry previews itself, animated, in its own name. The
   `by=letter` / `by=word` recipes the completions offer are a second line of
   the same menu.
2. **Text style** (Aa) - three sections in one menu:
   - **font**: every family Marquee draws, each name in its own face (the
     completions' `FONTS`);
   - **size**: the 1-7 dial by its names - teeny, tiny, normal, big, huge,
     enormous;
   - **colour**: the palette's swatches (`pure/markcolors.js`).
3. **Link** 🔗 - wraps the words as `[words](address)`: paste an address, or
   pick one of the persona's own notes (the `[` picker's documents). The link is
   the markup beginners get wrong most.
4. **Blocks** ¶ - for the lines the selection touches:
   - **quote**: `>` on _every_ line - Marquee has no lazy continuation, so a
     quote a beginner types by hand ends at the first wrapped line. This alone
     earns the button;
   - **heading** (1-3), **list** (bulleted, numbered), **divider** (`---`);
   - **centre** (`:::center`), **spoiler** (`:::spoiler`);
   - **table**: a starter `:::table header=row` with two columns and two rows of
     `[c]` cells to edit - syntax nobody guesses.

**Stretch: page theme** - `:::page scheme=…` wrapping the whole document, one
pick reskinning it. Delightful, and a different kind of thing (the document, not
the selection), so after the four.

**Cut**: emoji (Curtis, 2026-10-10 - phones have their own, and `:` already
picks); code blocks, sidenotes and `:::stack` (power tools, for now).

## The rules

### No selection: "text", selected

A button pressed with nothing selected inserts the word **text** at the caret,
already wearing the style - `[font=lobster]text[/font]` - with _text_ selected,
so the next keystroke replaces it (Curtis, 2026-10-10). A block button with
nothing selected acts on the caret's line; on an empty line it inserts its
starter (a quote's `> text`, the table).

### Six fonts in a row: change it, don't nest it

Remembering "what was changed last" breaks the moment the person clicks away,
undoes, or comes back tomorrow. The rule is about what is **selected**, so it
needs no memory:

- After any button, **the styled words stay selected** - the words inside the
  span, not its tags.
- If the selection is **exactly the inside of a span of the same kind**, the
  button changes that span instead of wrapping a new one: `[font=lobster]`
  becomes `[font=orbitron]`. Picking six fonts in a row edits one span six
  times. It works the same after an undo, after clicking back onto the words, or
  a week later - wherever the selection lands inside a span's whole contents.

"The same kind" is by attribute:

- **font, size, colour** - one value each: a pick replaces the value. (A span
  carrying the default - `size=3`, plain text - is removed rather than kept.)
- **effects** - Marquee nests them on purpose ("marquee and blink at the same
  time is not an edge case, it is the point"), so a _different_ effect wraps
  inside the one there; the _same_ effect again takes it off - the button
  toggles.
- **blocks** - a quote, a heading or a list on lines that already are one takes
  it off (toggle); a heading of another level changes the level.

### Across paragraphs: each one

Marquee's spans don't cross blocks, so an inline button over a selection that
spans paragraphs styles **each paragraph's part** with a span of its own
(Curtis, 2026-10-10: "each one, then"), never one span that would break.
Headings and list items are blocks too, so each gets its own; a blank line or a
divider in the selection is left as it is. The six-fonts rule applies the same
way: a selection whose every paragraph is exactly the inside of a same-kind span
changes them all.

### Undo is one step

Each press is one edit, undone by one Cmd/Ctrl+Z - a CodeMirror transaction in
interactive mode; in the textareas (side by side, the source tab) an
`insertText` the browser's own undo stack records, never a value assignment that
wipes it.

## The machine

- **`pure/markuphelp.js`** - pure functions over `(source, from, to)` returning
  `{ source, from, to }`: `wrapSpan(kind, value)`, `toggleEffect(name)`,
  `linesAs(block)`, `insertStarter(block)`. Every rule above is one of these,
  and pure means the vectors run in `just ui-check` - nested spans, a selection
  that is exactly a span's inside versus one that straddles its tags, the
  default size, `>` on every line, toggling off.
- **The vocabulary tables** move from completions.js to a pure module both read:
  fonts, colours, sizes, effects and their recipes.
- **Two surfaces, one adapter**: CodeMirror (interactive) and the textarea (side
  by side, source) each read the selection, call the pure function, and write
  the result back as one undoable edit with the new selection.
- **Read-only and plaintext** get none of them, as now.

## Not yet

- Page themes (the stretch).
- Custom emoji, if they come: the case that would bring an emoji button back.
