# DRAWING - the horse-drawing part of Horse Drawing Tycoon 2

Curtis's brief (2026-09-26): a basic drawing application on the console, beside Writer.

- **The same adjustable columns as Writer**: the main area a canvas; a column listing every horse
  drawing, each row a thumbnail of the drawing as it stands now; a column of drawing tools.
- **Tools**: a brush with an adjustable size (the cursor becomes a circle that size), a colour for
  it, and an eraser with its own size. More tools, and more columns (layers), later.
- **A drawing is a document**, like a post: it has a title, takes tags, can be **copied into a
  notebook** (as a `.webp` image - the copy is a picture, not a drawing), **duplicated** (a new
  drawing, right here), and **published** - one at a time, no taxonomies yet - as a plain image.
- **Strokes are its history**: undo the last stroke, and keep undoing back to a blank canvas. Two
  histories merge by putting both sets of strokes together; they should never conflict.
- **Layers** are a column still to come.

This document is the plan: the model first, because everything else hangs off it, then the slices.

## The model

### A drawing is a versioned document whose body is its strokes

PROJECT_PLAN's *Versioned Documents* already is this: a document is a stable `doc_id` whose versions
form a DAG, each version a **whole snapshot** of the body, with auto-merge a **per-format
capability** layered on top. A drawing is a new **format**, `drawing`, whose body is the complete
list of its strokes. Nothing on the chain changes: a drawing version is a version header like a
note's, and its body lives in the file layer like a note's.

Whole snapshots, not per-stroke entries, and on purpose. A stroke-per-entry log would be a new wire
format inside the conformance boundary for one app's convenience - exactly what the plan refused
text a CRDT for. The body snapshot rides the machinery every document already has: debounced saves,
skip-no-op saves, head checks, sync, retention.

### The body

```json
{
  "v": 1,
  "width": 800, "height": 600,
  "background": "#fffefb",
  "strokes": [
    { "id": "9f2c41d07a3b6e15", "t": 1790380000000, "tool": "brush",
      "color": "#8a4b1f", "size": 12, "points": [412, 300, 3, -1, 4, 0, 6, 2] }
  ],
  "undone": ["5b0e9d2c11f07a88"]
}
```

- **A fixed canvas**, 800×600: points are canvas coordinates, so a drawing looks the same on every
  screen and the display scales it to fit. 800 because that is the most the node keeps of any
  picture (`media/image.rs`, `MAIN_BOUND`): a drawing copied or published as an image loses nothing
  to a downscale. Resizing a canvas is a later tool.
- **`points` are delta-coded integers** - the first point absolute, every later one the step from
  the one before - which keeps a long stroke small: most steps are one or two digits.
- **A stroke's `id`** is random (64 bits, hex), minted when the stroke is drawn; **`t`** is when.
  Together they give every device the same order: strokes sort by `(t, id)`.
- **The eraser is a stroke** with `tool: "eraser"`: drawn as `destination-out`, it removes whatever
  is under it from the strokes before it. That is what makes merge safe to be simple (below).

### Undo is a recorded removal, so a merge cannot bring a stroke back

Undo takes the newest stroke out of `strokes` and puts its id in `undone`. Undo again takes the next:
all the way back to a blank canvas, which is Curtis's "undo back to the beginning of the history".

Why record it rather than just delete it: a merge unions the strokes of two versions. If device A
undid a stroke that device B's older version still has, a plain union would resurrect it. With
`undone` carried along, the merge is **strokes of both, minus the undone of both** - an undo is a
fact that survives syncing, like a deletion anywhere else in this system.

Redo is not in the brief, and `undone` would allow it later (the stroke's id is recorded; its body
would have to be kept, which is a decision about size).

### Merge: put both sets of strokes together

Two heads merge deterministically, with no conflict to present, **on the node, at read time** - where
text's merge already happens (`record/documents.rs`, `resolve`: the per-format hook). The editor
then opens the merged body, and its next save lists every head as a parent, which heals the fork
through an ordinary write: the same path a text conflict takes, with nothing new on the client.

```
strokes = union of both heads' strokes, by id
undone  = union of both heads' undone
result  = strokes whose id is not in undone, sorted by (t, id)
```

Painting is order-sensitive only where strokes overlap, and the `(t, id)` order is when they were
drawn - so two people drawing on one horse on two computers get both sets of marks, interleaved in
time. That is Curtis's "just smash the strokes of both together". It is the drawing format's
per-format merge rule, in exactly the place text's three-way merge sits; the plan's "images simply
keep both" was about media bytes, and a drawing is not bytes, it is strokes.

The browser writes bodies (`pure/drawing.js`) and the node merges them (`drawing.rs`), so the two must
agree on the canonical form byte for byte - the same drawing is the same bytes, or every merge would
look like a change and save again. `spec/test-vectors/drawing-v1.json` holds the cases, and both
sides' tests read it.

### What the rest of the system sees

- **A new format, `drawing`** (wire id 8 in `proto`'s `doc_format`), stored as JSON. Not "mergeable
  text" - it is not line-merged, not searched by its body (the title is), and never a book page -
  and not "media": its row has no `media` object, and its body rides inline in the document's JSON
  like text's does.
- **Private only.** A drawing never crosses the membrane as a drawing: publishing makes a picture of
  it (below), the way a draft becomes a post.
- **Its own app and bucket.** The registry gets a Drawing app with the style `drawing`, so the
  eponymous `drawing` bucket holds every drawing, and Lost & Found lists them with the rest.

## The app

Its own surface, not a branch of Writer's (`apps/drawing.js`, routed at `/home/drawing` and
`/home/drawing/<doc>`), built from Writer's parts: `panes.js` for the adjustable, tuckable columns,
`doc/docapp.js` for the list, `doc/session.js` for loading and autosaving (a drawing body is a
string like any other), `doc/annotations.js` for tags.

- **The list column**: every drawing, newest first, each row a thumbnail and the title. Thumbnails
  are drawn **in the browser** from each drawing's strokes and kept per head: the node's thumbnails
  come only from its image ingest, which a JSON save never passes through. Fine for dozens of
  drawings; a list in the hundreds would want the node to keep a thumbnail, and that is a later
  change.
- **The tools column**: brush, eraser, a size for each (1-80 canvas units), the brush's colour
  (the browser's own colour picker - locale-aware native widgets win - with a few swatches beside
  it), undo, and the drawing's own actions: duplicate, copy into a notebook, publish.
- **Wherever it is listed** - the Drawing app, or Lost & Found - a drawing opens on its canvas: the
  documents app's right-hand column hands the `drawing` format to the drawing surface
  (`doc/drawing.js`), which brings its tools column with it.
- **The canvas**: fills the main area at the drawing's proportions. The cursor is a circle the size
  of the current brush or eraser, at the current zoom. A stroke is a pointer-down-to-up; a pointer
  (mouse, pen, touch) is a pointer, with `touch-action: none` so a finger draws rather than scrolls.
  Each finished stroke is added to the body and the save is scheduled - a stroke is the unit of
  undo and of saving.
- **The title**: the header above the canvas, like Writer's.

## Copy, duplicate, publish

- **Duplicate** is a copy of the drawing, strokes and all, as a new drawing in the Drawing app: the
  node's own private copy door (`docs/copy`, `private: true` - the one Writer's duplicate uses),
  which today copies only text and gains drawings. Tags and provenance come along as they do for
  notes.
- **Copy into a notebook**: the browser flattens the canvas to a `.webp` and uploads it into the
  chosen notebook through the ordinary image door (`docs/binary`). The node keeps every picture as
  AVIF (`media/image.rs`), so what lands in the notebook is an AVIF image document - a picture, not
  a drawing, which is what Curtis asked for; webp is only how it travels.
- **Publish**: one drawing at a time, as a plain image. The node has no way to publish a lone
  image today - posts are words, and pictures travel inside them - so a drawing gets its own door,
  `POST /docs/<drawing>/publish/drawing`, which takes the flattened `.webp`, crushes it inline (as
  the avatar door does), mints its public twin, and posts a Marquee post whose title is the
  drawing's and whose body is the picture. The drawing remembers its post (`published_as`, as a
  draft does), wears the same private/public icon on its row, and offers "view" and "unpublish". A
  changed drawing can be published again, which replaces the old post.

## Slices

Slices 1-4 built 2026-09-26; `drawing.cjs` is their acceptance, `pure/drawing.cjs` and
`drawing.rs`'s tests hold the model to the shared vectors. Nobody has drawn with it in a browser yet.

1. **The format.** `doc_format::DRAWING`, `Format::Drawing`, inline bodies, the node's stroke merge
   in `resolve`, `drawing.rs` and its tests against the shared vectors. Acceptance: two devices
   draw on one drawing apart; the document reads back with both sets of strokes, minus an undone
   one, and a save heals the fork.
2. **The app.** Registry entry (a documents app: Writer's list and columns, `newFormat: 'drawing'`),
   the tools column, brush / eraser / sizes / colour / undo (and Cmd/Ctrl+Z), the size-circle
   cursor, title, autosave, the thumbnail list, tags.
3. **Duplicate and copy into a notebook.**
4. **Publish, view, unpublish.**
5. **Later, named so they are not forgotten**: layers (a column), more tools, redo, resizing the
   canvas, node-kept thumbnails for long lists, publishing a set of drawings together.
