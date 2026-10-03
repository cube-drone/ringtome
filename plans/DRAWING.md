# DRAWING - the horse-drawing part of Horse Drawing Tycoon 2

Curtis's brief (2026-09-26): a basic drawing application on the console, beside
Writer.

- **The same adjustable columns as Writer**: the main area a canvas; a column
  listing every horse drawing, each row a thumbnail of the drawing as it stands
  now; a column of drawing tools.
- **Tools**: a brush with an adjustable size (the cursor becomes a circle that
  size), a colour for it, and an eraser with its own size. More tools, and more
  columns (layers), later.
- **A drawing is a document**, like a post: it has a title, takes tags, can be
  **copied into a notebook** (as a `.webp` image - the copy is a picture, not a
  drawing), **duplicated** (a new drawing, right here), and **published** - one
  at a time, no taxonomies yet - as a plain image.
- **Strokes are its history**: undo the last stroke, and keep undoing back to a
  blank canvas. Two histories merge by putting both sets of strokes together;
  they should never conflict.
- **Layers** (added 2026-09-26): a column of re-orderable, hideable transparent
  slices, each with a thumbnail of just that layer, and the current layer's
  opacity on top of the stack.

This document is the plan: the model first, because everything else hangs off
it, then the slices.

## The model

### A drawing is a versioned document whose body is its strokes

PROJECT_PLAN's _Versioned Documents_ already is this: a document is a stable
`doc_id` whose versions form a DAG, each version a **whole snapshot** of the
body, with auto-merge a **per-format capability** layered on top. A drawing is a
new **format**, `drawing`, whose body is the complete list of its strokes.
Nothing on the chain changes: a drawing version is a version header like a
note's, and its body lives in the file layer like a note's.

Whole snapshots, not per-stroke entries, and on purpose. A stroke-per-entry log
would be a new wire format inside the conformance boundary for one app's
convenience - exactly what the plan refused text a CRDT for. The body snapshot
rides the machinery every document already has: debounced saves, skip-no-op
saves, head checks, sync, retention.

### The body

```json
{
  "v": 1,
  "width": 800, "height": 600,
  "background": "#ffffff",
  "strokes": [
    { "id": "9f2c41d07a3b6e15", "t": 1790380000000, "tool": "brush",
      "color": "#8a4b1f", "size": 12, "points": [412, 300, 3, -1, 4, 0, 6, 2] }
  ],
  "undone": ["5b0e9d2c11f07a88"]
}
```

- **A fixed canvas**, 800×600: points are canvas coordinates, so a drawing looks
  the same on every screen and the display scales it to fit. 800 because that is
  the most the node keeps of any picture (`media/image.rs`, `MAIN_BOUND`): a
  drawing copied or published as an image loses nothing to a downscale. Resizing
  a canvas is a later tool.
- **`points` are delta-coded integers** - the first point absolute, every later
  one the step from the one before - which keeps a long stroke small: most steps
  are one or two digits.
- **A stroke's `id`** is random (64 bits, hex), minted when the stroke is drawn;
  **`t`** is when. Together they give every device the same order: strokes sort
  by `(t, id)`.
- **A pen stroke carries its pressure** (Curtis, 2026-09-26):
  `"pressure": [20, 55, 90]`, one whole number 0-100 per point, after `points`;
  a mouse or finger stroke has none and is one width. The stroke's `size` is its
  width at full pressure, and at pressure p it is `size × (0.15 + 0.85·p)` - the
  lightest touch still leaves a line. A list that does not fit its points (the
  wrong length, a value out of range or not whole) is dropped and the stroke
  kept; the node reads it by the same rule, and the shared vectors hold both to
  it. Added without a body version: one drawing predated it. The page reads
  `pressure` only from a pen (`pointerType`), and takes every coalesced sample,
  so a fast pen curve stays a curve. The pressure is **smoothed as it is drawn**
  (2026-09-28, Curtis: the line's width was "a little... shaky"): each sample
  moves the stroke's running pressure 30% of the way to what the pen reported
  (`smoothPressure`, pure/drawing.js), and the smoothed value is what the stroke
  stores - so every computer repaints the steady line that was drawn, and
  nothing about the body changes.
- **The eraser is a stroke** with `tool: "eraser"`: drawn as `destination-out`,
  it removes whatever is under it from the strokes before it. That is what makes
  merge safe to be simple (below).

### Layers

A layer is an entry in the body's `layers`:
`{ "id", "n", "name"?, "z", "opacity", "hidden", "t" }` - its number (for "layer
2"), the name it was given if any, its place in the stack, a whole-percent
opacity, whether it is hidden, and when it last changed. A stroke names its
layer (`"layer": "<id>"`, right after its `t`); a stroke that names none is on
the **base layer** (id sixteen zeros), which every drawing has, fully opaque and
shown until an entry says otherwise. `layers` is written only when there are
entries, so a drawing with none is the bytes it was before layers existed (no
body version, by Curtis's word).

**Merging** keeps every layer from every version; where two versions changed one
layer, the later change (`t`) wins, and a tie breaks on (z, opacity, hidden, n,
name) - any fixed order, so long as the browser and the node share it (the
vectors hold them to it). Names compare by their UTF-8 bytes, which is Rust's
order; JavaScript's own `<` compares UTF-16 units and disagrees about some pairs
(`～` against `🐴`), so the page compares bytes too. Strokes merge as ever, each
keeping its layer. Moving a layer renumbers the stack's `z`s and touches only
the layers whose place changed.

**Names** (Curtis, 2026-09-26): a layer is "layer N" until it is renamed -
double-click its name, or the pencil under it. A name is trimmed; a blank one
gives the number back. A name is a free string - the one in the body - so it is
narrowed to where the two languages cannot disagree about its bytes: at most 120
UTF-8 bytes, no control characters (their JSON escapes differ between writers),
no lone surrogate (JavaScript holds one; Rust refuses it). A name outside that
is never written by the page, and dropped by the node - the layer kept, with its
number. A duplicate keeps its source's name.

In the layers column each row is the layer's thumbnail beside its name, with
what can be done to it - hide, rename, duplicate, trash - on a line under the
name, "to give the name some room to breathe".

**Painting**: each layer on a canvas of its own - so an eraser stroke erases
within its own layer - then stacked bottom-first at their opacities, the hidden
ones left out. The white a drawing starts on (`background`, `#ffffff` for a new
one) is the **base layer's own fill**, not paper under everything (Curtis,
2026-09-26): hide the base layer, fade it, or erase on it, and what shows is the
**transparency floor** - the grey checkerboard every image editor uses for
"nothing is here". The floor is only ever the stage's background: a picture of
the drawing (a thumbnail, a copy, a publication) is the visible layers alone,
transparent wherever they leave nothing - webp and png keep that, and so does
the node's AVIF. A hidden layer takes no strokes.

**Canvas settings in a merge** (width, height, `background`) come only from
versions that parsed, and among those the least by that order - not from
whichever version is read first, which made a merge with an unreadable head
order-dependent until a changed default exposed it (2026-09-26).

### Grabbing

The grab tool moves a whole layer (Curtis, 2026-09-26), and had to stay as
trivially mergeable as a stroke. So a grab is neither a setting on the layer -
two computers moving one layer at once would have one move win and the other
vanish - nor a rewrite of the layer's strokes - one stroke id with two sets of
points is a real conflict. It is an **entry in the history**, beside the
strokes:

```json
{ "id": "…", "t": 1790380000000, "layer": "…", "tool": "move", "dx": 12, "dy": -30 }
```

Unioned by id like any stroke, so concurrent grabs both apply (moves are
additions, and additions commute); undone like any stroke. A move shifts
everything on its layer drawn **before** it in the one `(t, id)` order - each
entry is painted offset by the sum of the moves after it (`offsetsOf`), and the
base layer's white fill by all of them - so what is drawn after a grab lands
where it was drawn, and a layer grabbed off the edge and back loses nothing. A
stroke another computer drew at the same moment moves with the layer exactly
when it was drawn before the grab: decided by time, the same everywhere.

### Transforming

The transform tool (Curtis, 2026-09-27) turns, stretches and slants the whole
current layer. A dashed frame sits round what the layer has painted, a handle at
each corner, and where a drag begins decides what it does - with **shift**
making it "perfect":

| drag from                                 | does                                                                                                                                | with shift                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| a corner                                  | slants: sideways leans the top or bottom edge, up or down the side edge; the opposite corner stays, the frame stays a parallelogram | scales the whole, about the opposite corner |
| an edge                                   | stretches across it, the opposite edge staying                                                                                      | scales the whole, evenly                    |
| inside                                    | moves                                                                                                                               | -                                           |
| outside (the stage round the drawing too) | turns about the frame's middle                                                                                                      | in 15-degree steps                          |

The pointer says what a press would do: resize arrows on the corners and edges,
the move cross inside, and outside Phosphor's clockwise arrow as a custom cursor
(CSS has no rotate cursor; the crosshair is its fallback). After a drag the
frame follows it (a slanted frame stays slanted for the next drag); an undo, a
sync or another layer draws it afresh round what is painted.

One entry per drag: `{ "tool": "transform", "m": [a, b, c, d, e, f] }` - an
affine matrix (`x' = a x

- c y + e`, `y' = b x + d y +
  f`) that **everything before it on the layer passes through**, as a grab's `move`
  shifts it (a move is the translation-only case). The six numbers are fixed
  point, times 1,000,000, whole - as every number in a body is.

* **It merges** like every entry, by the union. Two computers' transforms apply
  in the one `(t, id)` order - matrices do not commute, but every computer
  composes them the same way round, so every computer paints the same picture. A
  stroke drawn elsewhere meanwhile is transformed exactly when it came earlier
  in that order - the grab's rule.
* **It stays sharp**: the layer is redrawn through the matrices (`matricesOf`),
  never warped as a picture. (Hence no free-corner distort - Curtis, 2026-09-27:
  a corner that lands exactly where it is dropped needs a perspective warp,
  which could only be an approximation of the picture, compounding with every
  warp and drifting from the pour's walls.)
* **Pours** meet the lines through the same matrices. A turned, stretched or
  slanted line's wall is its points through the matrix, as wide as the line
  times the matrix's average stretch (the square root of its area scale): a
  slanted line is not evenly wide, so this is the one place a pour and what is
  painted can part by a hair - the same hair on every computer.

### Cropping

The crop tool (Curtis, 2026-09-27) cuts the canvas down. Taking it up lays a box
on the drawing, in from its edges, with everything outside it under a light
black shade - "this gonna get cut out". Drag a corner or an edge to resize the
box, the inside to move it, or outside it to draw a fresh one; the **crop**
button (where a size would be) cuts. Nothing is recorded until then.

A crop is an entry, `{ "tool": "crop", "points": [left, top, right, bottom] }`,
on **no layer** - it cuts them all. The box is in the canvas as the crop found
it; everything before the crop shifts by (-left, -top), as a grab would shift it
(`matricesOf` treats it as that shift, and `effectiveOps` deals every crop into
every layer), and the canvas becomes the box.

- **The body's `width` and `height` stay the canvas the drawing began as.**
  Changing them would have been the rat's nest: they merge "least wins", so two
  crops would have fought. The canvas now - `sizeOf` - is that, cut by every
  crop in turn; `sizeAfter` gives the canvas at any point in the history, which
  is what a pour before a crop spread over.
- **Nothing cut away is lost**: it is still in the history, only outside the
  canvas. Undo the crop and it is all back.
- **Two computers cropping at once** both apply, the later on the earlier's
  result, in the one order - surprising, perhaps, but the same on every
  computer, and an undo away from either.
- The base layer's white covers the canvas the drawing began as, wherever the
  crops leave it.

### Set as profile, set as banner

Two cousins of the crop (Curtis, 2026-09-28), after it in the tools: **set as
profile** (the user-circle) and **set as banner** (the identification card).
Each lays the crop's box down, but held to a shape - a square for the picture
(the heptagon covers it), 800 by 250 for the banner, the shape of a person's
page head - as large as fits the middle of the canvas. A corner grows the box
toward the pointer by whichever way it went further, the opposite corner still;
an edge grows it about its middle, the opposite edge still; the inside moves it;
outside draws a fresh one. It never leaves the canvas: it shrinks to fit instead
(`dragBoxAt`, pure/transform.js).

The button where the crop's would be - **Set as Profile** or **Set as Banner** -
flattens the drawing as every picture of it is flattened (its visible layers,
pictures and faces waited for), cuts out the box at the canvas's backing
resolution, and sends it to the persona's avatar or banner door, which launders
it as it does a picture picked on the profile page. **Nothing is recorded in the
drawing**: it is not an entry, so it neither merges nor undoes; the drawing is
exactly as it was.

### Text

Text layers (Curtis, 2026-09-27) - scoped down on purpose, since text is where a
drawing could have grown text conflicts. **One text per layer**: the text tool's
click places a new layer at the top holding a text anchored there - the word
"horse", so it is plain where it landed, selected in the words field so the
first keystroke replaces it - and its words are typed in the tools column, not
on the canvas, beside its font, size, alignment (left, centre, right) and
colour. While a text layer is current the tools it cannot take are greyed out:
it takes **text, transform, grab and crop** - so it turns, stretches, slants and
moves as any layer does, and stays editable throughout, because its words are
the layer's first step (as the base layer's white is): every grab and transform
after it carries them, and an edit after a transform is still transformed.

- **The record**:
  `texts: [{ "layer", "t", "text", "font", "size", "color", "align", "x", "y" }]`,
  one per layer, beside `layers` - written only when there is one, so a drawing
  without text is the bytes it always was. It merges as layer entries do: the
  later change wins, whole, ties broken by a fixed order (numbers, then strings
  by UTF-8 bytes). Not on the layer entry, because a layer entry changes
  whenever the stack is reordered, and a reorder on one computer would then
  throw away words typed on another (the vectors hold both standing).
- **The one lossy merge**: two computers editing one text at the same moment -
  the later keeps its words, the other's are gone. Chosen over merging text
  character by character.
- **Words**: up to 4000 UTF-8 bytes; line breaks are how lines are made (no
  wrapping); no other control characters and no lone surrogates, for the same
  reason as layer names.
- **Fonts: the Marquee font list** (`FONTS`, from the Marquee renderer) - the
  four standard stacks and the 31 faces the node serves from its own binary. The
  body keeps a font's token, checked only for its shape, so it need not change
  when the list does; a token the page does not know paints in `sans`, as
  Marquee degrades. The faces load lazily, and a canvas never waits for one, so
  the page asks for a drawing's faces and repaints when they arrive; a picture
  of the drawing waits for them.
- **Not a wall to a pour**: glyphs are drawn by each machine's font machinery,
  so, like a picture, text is left out of a pour's walls - every computer's pour
  still agrees.
- A copy of a text layer is a text layer with words of its own. A text layer
  with no name of its own is listed by its first line.
- Placing a text or editing it is not in the undo history (as layer changes are
  not); a text layer goes by its trash button.

### Deleting and duplicating layers

Per-layer trash and duplicate buttons (Curtis, 2026-09-26), built the way
grabbing is - as entries in the history, so they merge by the union and undo
like a stroke:

- **Trash** is `{ "tool": "delete", "layer": … }`. While it stands, the layer
  and everything on it are gone; undo takes the entry back and the layer returns
  whole. Deleted on one computer and drawn on at another, the union keeps both -
  the layer stays deleted, the new stroke hidden with it and recoverable by
  undo. The base layer can go too, and the floor shows.
- **Duplicate** adds a layer just above its source, with its opacity and
  visibility, beginning with
  `{ "tool": "copy", "layer": <new>, "from": <source> }` - which paints the
  source **as it stood at that moment** (its entries before the copy, in the one
  order), not copies of each stroke under new ids. So one undo takes the copied
  content back (the new, empty layer stays until thrown away); later strokes on
  the source do not leak into the copy; and a copy outlives its source being
  thrown away. What a layer paints is `effectiveOps`: the base layer's fill
  first (so a copy of the base layer carries its white), then its entries, each
  copy replaced by its source's earlier steps - and the grab offsets apply to
  all of it. A copy only ever reaches strictly earlier entries, so even two
  layers copying each other cannot loop.

### Pouring

The paint bucket (Curtis, 2026-09-26): press and paint drops where you pressed;
hold, and it pours outward - at the **pour speed** the tools column offers in
place of a size - stopping at the lines on the same layer; let go and it stops.
One entry records it:
`{ "tool": "bucket", "color", "points": [x, y], "reach" }` - the point it was
dropped at and how far, in canvas units, it had spread. Merged by the union,
undone like a stroke; nothing new can conflict.

The pixels are never stored. What a pour covers is worked out again from the
body (`pure/pour.js`), so it must come out the same on every computer - which is
why it never asks a canvas: the lines are rasterised by plain arithmetic on the
drawing's own 800×600 grid (a cell is a **wall** when its centre lies within a
line's core - its width less half a cell, never under 0.75 - so the antialiased
rim is painted over and no pale seam shows), and the paint spreads through open
cells by a whole-number distance (3 a straight step, 4 a diagonal: a rough
circle), never diagonally between two walls. It covers every cell within its
reach.

- **Only lines hold paint back**: brush strokes, less what an eraser took out.
  An earlier pour, or the base layer's white, does not - a second pour spreads
  straight over the first.
- **The lines as they stood when it was poured**: only entries before it on its
  layer, where they stood then (grabs between applied); a line drawn after a
  pour does not change it, and a grab after it moves it like anything else. A
  copy of a layer carries its pours, as it carries its strokes.
- **A merge can change what a pour covers**: a stroke from another computer,
  earlier in the one order, is a wall the pour now meets; an undone one a wall
  it no longer does. Every computer still agrees, because every computer works
  it out from the same entries.
- The pour is **how far the paint went**, not where it ended - held long enough
  to fill the space, it records a reach past the space's far end, so an undone
  wall lets it spread further.

### Shapes

Line, rectangle and ellipse (Curtis, 2026-09-27): press, drag, let go - the drag
shows the shape from where it began to the pointer, and letting go records it.
They share a **line width** (the size slider, when a shape is in hand, 1-80).
Nothing keeps a rectangle square or an ellipse round - which is why they are not
called square and circle.

- **A line is a brush stroke** of two points - round-ended, as every stroke is.
  It needs no entry of its own, so everything a stroke does it already did:
  merge, undo, erase, grab, hold a pour back.
- **A rectangle or an ellipse** is
  `{ "tool": "rect" | "ellipse", "color", "size", "points": [l, t, r, b] }` -
  the box it was dragged out in, absolute, left-top then right-bottom. A
  rectangle's corners are mitred: sharp.
- **They hold a pour back** as lines do. A rectangle's walls are exact - the box
  grown and shrunk by the line's core, square at the corners as it is painted.
  An ellipse's walls are its outline as 256 segments from the circle's rational
  parametrisation, which needs only adding, multiplying and dividing: `Math.cos`
  and `Math.sin` may differ in their last digit from browser to browser, and a
  pour must come out the same everywhere.
- A drag that went nowhere records nothing.

### Images

A picture from the person's own media (Curtis, 2026-09-27): **add an image** in
the tools column opens a picker - every picture, newest added first (a claimed
date wins, as everywhere), narrowed by a title search, a notebook and tags - and
the chosen one lands on **a new layer at the top**, named for the picture and
made current, so a grab moves it straight away. One entry records it:
`{ "tool": "image", "points": [x, y], "doc": <picture's document id>, "w", "h" }` -
its top-left and its size in canvas units: one pixel to a unit, centred, shrunk
(never grown) to fit the canvas.

- **A drawing can be chosen too** (Curtis, 2026-09-27): it comes in as a single
  flat layer - a COPY. The chosen drawing is flattened as it stands (its own
  pictures and fonts waited for), saved as a new picture in the person's media
  titled for it, and that picture is placed like any other. Never a live link: a
  drawing that painted other drawings would repaint whatever they had since
  become, and a chain of them could loop; a snapshot is one more picture, merged
  like any. The page holds the flattened picture it just made, so the layer
  paints at once rather than when the node has taken it in. The copy stays in
  the person's files, as copy-into-a-notebook's picture does. **One copy per
  version** (Curtis, 2026-09-27: "wasteful to keep cutting the same image out of
  the same drawing"): the copy carries two private annotations -
  `flattened_from` (the drawing) and `flattened_version` (its heads, sorted) -
  and picking the same unchanged drawing again, into a drawing, a note or a chat
  line, finds that copy rather than cutting another (`pure/flatcopy.js`). A
  drawing changed since is a new version and gets a new copy; the old one stays
  wherever it was used.
- **A reference, not the pixels.** The body names the picture's document;
  whoever paints the drawing fetches the picture's body, as the person's own
  media is fetched anywhere. A picture not here yet - still syncing, or
  deleted - paints as nothing until it arrives. A picture OF the drawing (the
  list thumbnail, a copy into a notebook, a publication) waits for every picture
  first, so it is never made without them. **Publishing a drawing publishes its
  pictures' pixels** inside the flattened picture - which is what adding them
  asked for.
- It is an entry like a stroke: merged by the union, undone (the picture goes;
  its layer stays, as a duplicate's does), moved by a grab, cut by the eraser,
  carried by a layer's copy.
- **A picture is not a line**: a pour runs over it rather than stopping at its
  edges (`pure/pour.js` rasterises only strokes, which keeps every computer's
  pour the same without knowing the picture's pixels).
- An animated picture draws as its first frame.

### Stickers

A sticker (Curtis, 2026-09-28) is any picture or drawing of the person's tagged
**`sticker`**. The **stickers** tool shows them inline in the tools column -
newest first, narrowed by their other tags (pure/imagepick.js `stickersOf`) -
and choosing one puts it in hand: the cursor over the canvas becomes the sticker
itself, at its own size on screen but never past 128 pixels on its longer side,
which is as big as a browser lets a cursor be (`stickerCursorSize`). **A click
stamps a copy** - on the current layer, centred on the click, exactly as big as
the cursor showed it - and every click is another stamp.

- **A stamp is an `image` entry** (`stampImage`): the one adding a picture
  makes, on the current layer rather than a new one. So there is nothing new on
  the wire or in the merge: stamps are undone, grabbed, erased and carried like
  any stroke, and a pour runs over them as over a picture.
- **A drawing sticker is flattened once, when chosen** (`drawingAsPicture`, one
  copy per version), and the stamp names that picture - a snapshot, never a live
  link, as adding a drawing is.
- **The cursor is painted from the stamp's own picture** (Curtis, 2026-09-28),
  not shown as an image element: an animated sticker shows, frozen, the one
  frame a stamp takes (a picture is painted as its first frame), rather than
  playing and stamping something else; and a drawing sticker shows from the copy
  the page holds, before the node could serve it. Stamping the frame currently
  playing would need a new picture per stamp, and is not done.
- A text layer takes no stamps (only its own tools), and neither does a hidden
  one.

### Undo is a recorded removal, so a merge cannot bring a stroke back

Undo takes the newest stroke out of `strokes` and puts its id in `undone`. Undo
again takes the next: all the way back to a blank canvas, which is Curtis's
"undo back to the beginning of the history".

Why record it rather than just delete it: a merge unions the strokes of two
versions. If device A undid a stroke that device B's older version still has, a
plain union would resurrect it. With `undone` carried along, the merge is
**strokes of both, minus the undone of both** - an undo is a fact that survives
syncing, like a deletion anywhere else in this system.

Redo is not in the brief, and `undone` would allow it later (the stroke's id is
recorded; its body would have to be kept, which is a decision about size).

### Merge: put both sets of strokes together

Two heads merge deterministically, with no conflict to present, **on the node,
at read time** - where text's merge already happens (`record/documents.rs`,
`resolve`: the per-format hook). The editor then opens the merged body, and its
next save lists every head as a parent, which heals the fork through an ordinary
write: the same path a text conflict takes, with nothing new on the client.

```
strokes = union of both heads' strokes, by id
undone  = union of both heads' undone
result  = strokes whose id is not in undone, sorted by (t, id)
```

Painting is order-sensitive only where strokes overlap, and the `(t, id)` order
is when they were drawn - so two people drawing on one horse on two computers
get both sets of marks, interleaved in time. That is Curtis's "just smash the
strokes of both together". It is the drawing format's per-format merge rule, in
exactly the place text's three-way merge sits; the plan's "images simply keep
both" was about media bytes, and a drawing is not bytes, it is strokes.

The browser writes bodies (`pure/drawing.js`) and the node merges them
(`drawing.rs`), so the two must agree on the canonical form byte for byte - the
same drawing is the same bytes, or every merge would look like a change and save
again. `spec/test-vectors/drawing-v1.json` holds the cases, and both sides'
tests read it.

### What the rest of the system sees

- **A new format, `drawing`** (wire id 8 in `proto`'s `doc_format`), stored as
  JSON. Not "mergeable text" - it is not line-merged, not searched by its body
  (the title is), and never a book page - and not "media": its row has no
  `media` object, and its body rides inline in the document's JSON like text's
  does.
- **Private only.** A drawing never crosses the membrane as a drawing:
  publishing makes a picture of it (below), the way a draft becomes a post.
- **Its own app and bucket.** The registry gets a Drawing app with the style
  `drawing`, so the eponymous `drawing` bucket holds every drawing, and Lost &
  Found lists them with the rest.

## The app

Its own surface, not a branch of Writer's (`apps/drawing.js`, routed at
`/home/drawing` and `/home/drawing/<doc>`), built from Writer's parts:
`panes.js` for the adjustable, tuckable columns, `doc/docapp.js` for the list,
`doc/session.js` for loading and autosaving (a drawing body is a string like any
other), `doc/annotations.js` for tags.

- **The list column**: every drawing, newest first, each row a thumbnail and the
  title. Thumbnails are drawn **in the browser** from each drawing's strokes and
  kept per head: the node's thumbnails come only from its image ingest, which a
  JSON save never passes through. Fine for dozens of drawings; a list in the
  hundreds would want the node to keep a thumbnail, and that is a later change.
- **The tools column**: brush, eraser, line, rectangle, ellipse, paint bucket,
  text, transform, grab and crop (last, away from the transform it resembles),
  then add an image and undo - icons, each named in its tooltip - a size for the
  brush and the eraser and a line width for the shapes (1-80 canvas units), a
  pour speed for the bucket (1-10, 20 canvas units a second at the slowest and
  half again each step), the colour - each shown only with a tool that uses it
  (Curtis, 2026-09-27: "tool options are contextual and live with their
  associated tool"), under the icons; a tool a text layer cannot take is greyed
  out rather than explained. The drawing's own actions - duplicate, copy into a
  notebook, publish - are in its header. The colour is a hue ring with an HSV
  triangle inside it and a hex field (`doc/colourpicker.js`, Curtis 2026-09-26 -
  it replaced the browser's native colour input), with a row of swatches
  beneath: white and black, then the last ten colours this drawing's strokes
  used, newest first (`recentColours`, read off the strokes, so the row follows
  the drawing everywhere and an undo takes its colour with it).
- **Wherever it is listed** - the Drawing app, or Lost & Found - a drawing opens
  on its canvas: the documents app's right-hand column hands the `drawing`
  format to the drawing surface (`doc/drawing.js`), which brings its tools
  column with it.
- **The canvas**: fills the main area at the drawing's proportions. The cursor
  is a circle the size of the current brush or eraser, at the current zoom. A
  stroke is a pointer-down-to-up; a pointer (mouse, pen, touch) is a pointer,
  with `touch-action: none` so a finger draws rather than scrolls. Each finished
  stroke is added to the body and the save is scheduled - a stroke is the unit
  of undo and of saving.
- **The title**: the header above the canvas, like Writer's.
- **The navigator** (Curtis, 2026-09-27): atop the right-hand column, now
  **layers & map** - a minimap of the whole drawing with a red square over the
  part the stage shows, and under it (where Photoshop keeps it) zoom out, a zoom
  slider, zoom in and the zoom as a percent (click it to fit again). Below the
  navigator, a rule, then **new layer**, the current layer's **opacity**, and
  the stack. Drag the square, or press anywhere on the map, to look there. 100%
  is the size that just fits the stage; zoom runs from 75% (a margin round it -
  Curtis, 2026-09-27) to 800%, the slider evenly in ratio and snapping to 100%
  as it passes, the buttons half again or two-thirds per press and landing on
  100% rather than stepping over it, and a zoom keeps the point at the stage's
  middle where it was. The stage is an ordinary scrolling box, so a wheel or a
  trackpad pans a zoomed drawing too, and the square follows. Zoom is the
  view's, never the body's: not saved, not synced, back to fit when the drawing
  is opened again. The arithmetic is `pure/viewport.js`. The canvas stays backed
  at twice the drawing's units - past about 200% on a 1x screen it is enlarged
  smoothly - which loses nothing real, since a stroke's points are whole canvas
  units.

## Copy, duplicate, publish

- **Download as a .png** (Curtis, 2026-09-27): a chip beside copy and duplicate
  saves the drawing as a PNG - the visible layers stacked, transparent where
  they leave nothing, at the resolution the canvas is drawn at (twice the
  drawing's units: 1600 x 1200 uncropped), named for the title less what a file
  system refuses (`pictureFileName`). It waits for its pictures and fonts, as a
  publication does, and saves as the spare key does: a link to the file,
  clicked. Nothing reaches the node.
- **Duplicate** is a copy of the drawing, strokes and all, as a new drawing in
  the Drawing app: the node's own private copy door (`docs/copy`,
  `private: true` - the one Writer's duplicate uses), which today copies only
  text and gains drawings. Tags and provenance come along as they do for notes.
- **Copy into a notebook**: the browser flattens the canvas to a `.webp` and
  uploads it into the chosen notebook through the ordinary image door
  (`docs/binary`). The node keeps every picture as AVIF (`media/image.rs`), so
  what lands in the notebook is an AVIF image document - a picture, not a
  drawing, which is what Curtis asked for; webp is only how it travels.
- **Publish**: one drawing at a time, as a plain image. The node has no way to
  publish a lone image today - posts are words, and pictures travel inside
  them - so a drawing gets its own door, `POST /docs/<drawing>/publish/drawing`,
  which takes the flattened `.webp`, crushes it inline (as the avatar door
  does), mints its public twin, and posts a Marquee post whose title is the
  drawing's and whose body is the picture. The drawing remembers its post
  (`published_as`, as a draft does) and wears the same private/public icon on
  its row.
- **The publish bar is Writer's** (`doc/publishbar.js`, shared - Curtis
  2026-09-26: "work and look the same in both"): the same standing colours, the
  two wishes (turn off comments, trusted only - which seals the picture under
  the post's key too), a past claimed date dating the post, view, update while
  the post's day lasts, and unpublish through the same takedown modal. Where
  Writer compares words to know the draft has changed, a drawing compares
  versions: the door stamps the drawing with the version it published
  (`published_head`, private bookkeeping like `published_as`), and any stroke
  since moves the head past it. A future date is refused - drawings have no
  schedule yet.
- **Duplicate and copy-into-a-notebook are chips beside the title**, with tags,
  delete and the save status - the same row Writer's chips live in.

## Slices

Slices 1-4 built 2026-09-26; `drawing.cjs` is their acceptance,
`pure/drawing.cjs` and `drawing.rs`'s tests hold the model to the shared
vectors. Nobody has drawn with it in a browser yet.

1. **The format.** `doc_format::DRAWING`, `Format::Drawing`, inline bodies, the
   node's stroke merge in `resolve`, `drawing.rs` and its tests against the
   shared vectors. Acceptance: two devices draw on one drawing apart; the
   document reads back with both sets of strokes, minus an undone one, and a
   save heals the fork.
2. **The app.** Registry entry (a documents app: Writer's list and columns,
   `newFormat: 'drawing'`), the tools column, brush / eraser / sizes / colour /
   undo (and Cmd/Ctrl+Z), the size-circle cursor, title, autosave, the thumbnail
   list, tags.
3. **Duplicate and copy into a notebook.**
4. **Publish, view, unpublish.**
5. **Layers** (built 2026-09-26): the column, the model, the merge; grab, trash,
   duplicate, names.
6. **The paint bucket** (built 2026-09-26): pours, worked out from the body
   (`pure/pour.js`). **The navigator** and **images** followed (2026-09-27).
7. **Later, named so they are not forgotten**: more tools, redo, resizing the
   canvas, node-kept thumbnails for long lists, publishing a set of drawings
   together, and reordering layers by touch (dragging rows is mouse and pen only
   today).
