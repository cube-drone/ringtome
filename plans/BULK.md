# Bulk actions

Doing one thing to many documents at once, in Writer, Drawing and hrseFiles
(Curtis, 2026-10-11): select several, then delete them all, move them all, tag
them all, take a tag off all of them, date them all, and, for sounds, set their
artist, album and the rest, or their cover.

## Selecting

- **Shift-click adds, or takes away.** A row (or a tile in hrseFiles) clicked
  with Shift held joins the selection, or leaves it if it was already in. The
  first Shift-click while a note is open takes the open one along with it, so
  "open one, Shift-click another" is two selected.
- **Select all** sits beside the count at the head of the list ("12 of 120 notes
  · select all"). It selects what the list shows now: whatever search, tags,
  notebook or kind are narrowing it. hrseFiles gets a count line of its own to
  carry the link.
- **A plain click clears and opens** (Curtis, 2026-10-11): the selection goes,
  and the clicked document opens on its own. So do Escape and the panel's
  "clear".
- **Selected rows wear the open row's highlight**, so the selection is what you
  see.
- A selected document that leaves the list (deleted, or moved out of the
  notebook in view) leaves the selection with it.

The selection is the list's own: it lives in the app's state, never in the
address. It disappears with a reload, the way an unsaved selection in a file
manager does.

## The panel

While anything is selected, the place a single document would open shows the
bulk panel instead: "_n_ selected", a clear button, and each action as a
section.

- **Delete all.** One confirmation naming the count, then every document
  tombstoned, as the single delete does (a reversible tombstone; out of every
  list at once).
- **Move all** (Curtis: "both"): the other notebooks of the app, and a name box
  that makes a new notebook and moves everything into it. In a notebook app each
  document leaves the notebook in view. In hrseFiles each leaves the notebook it
  opens in, but only for a notebook of the same app, the single-note move's rule
  (`doc/annotations.js` `NotebookMove`); otherwise the move just files it. Its
  tree follows, as the single move's does.
- **Tag all**: a tag box, which applies the single tag editor's rules
  (lowercase, 32 characters, no emoji tag on your own document).
- **Remove a tag from all**: every tag any selected document carries, with how
  many carry it. Choosing one takes it off each of them.
- **Date all**: a date, an optional time, and "set", or "clear" to drop the
  claimed date.
- **Sounds**, when any selected document is one: artist, album, album artist,
  composer, genre and year, each with its own "set". Track number is per track,
  and the song's name (`track`) is too (Curtis: left out), so neither is
  offered. There's also a cover to choose for all of them. These touch the
  sounds only; anything else selected is left alone.

Tag sections show only when tagging is unlocked (`useUnlocked(root, 'tags')`),
as the tag editor's do.

**Built-in documents are left alone.** The app's own pictures and sounds
(`builtin`) are nobody's to delete, move or annotate. They can be selected,
since select-all takes what's shown, but every action skips them and says how
many it skipped.

## How an action runs

Each action is one request per document, on the routes the single-document
surfaces already use: the delete, the bucket and taxonomy members, the tag and
field annotations, the thumbnail. They run four at a time, and the panel counts
them ("tagging… 12 of 40"). When an action finishes it raises a toast
(plans/TOASTS.md): "tagged 40", or, on failures, an error saying how many failed
and the first reason. A document that failed stays selected so the action can be
tried again; the rest leave the selection once a delete or move takes them out
of view.

**No bulk endpoint, on purpose.** Every write is a chain entry either way, and a
hundred requests four at a time take a few seconds. That is inside the annoyance
threshold (STYLE, _Good-enough speed_) for something done to a hundred things,
and one route per write keeps one code path per write. If selections of
thousands become ordinary, a batch route is the change to make.

## Where it lives

- `node/js/pure/bulk.js`: the decisions as values. Toggling, select-all, pruning
  what left the list, the combined tags, which notebooks a move offers, what a
  move takes each document out of, which documents an action touches. Vectors
  are in `node/integration/test/pure/bulk.cjs`.
- `node/js/doc/bulk.js`: the panel and the runner.
- `node/js/apps/notes.js`: the selection state, Shift-click, select-all, and the
  panel in the right column's place.
