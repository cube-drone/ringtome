# Ringtome — UI Refactor Log

The forward-looking ledger for the **embedded UI** (`node/js`) — same contract as
[`REFACTOR.md`](REFACTOR.md), which holds the Rust side: known compromises and queued cleanups,
recorded here rather than in anyone's memory. **Completed entries are deleted, not checked off**;
git history is the archive and this file is only ever the current balance.

Judge entries against [`STYLE.md`](STYLE.md). Item ids (A1, B2, …) are stable handles for
conversation; when one gets picked up, work it as its own commit-sized fix.

Opened 2026-07-29 from a full read of the 27 UI modules and the stylesheet. The order below is
by category, not priority; the suggested working order is at the bottom.

## What is already right (protect these)

Named first because it calibrates the rest. `doc/session.js`, `lookout.js`, `keepalive.js`,
`mirror/doccache.js`, and `icons.js` are the patterns the rest of the UI should be measured
against: the save engine extracted from its chrome and shared by two surfaces; the two predicates
that cost real debugging living as pure functions with unit tests (`integration/test/pure/`) and
comments that are scar records rather than narration; one place mapping *meaning* → glyph. Several
fixes below are "do what that module did."

## Structure — the directory layout (decided 2026-07-29)

`node/js` was flat: 29 files in one namespace. The layout below is not imported from anywhere; it
is derived from two facts about this repo.

**One: the Rust side already answers the question, and the answer is neither layers nor slices.**
`node/src` is *flat* - 23 loose `.rs` files - with exactly six directories, every one of them a
named module that grew subparts (`net.rs` beside `net/{adopt,discovery,p2p,resync,sync,unfurl}.rs`;
`record.rs` beside `record/{documents,imaol,journal,private,rank,store}.rs`). No `data/`, no
`view/`, no per-feature slice. The house convention is **`x.rs` plus a sibling `x/` when one
concept outgrows one file**, which is STYLE.md's "many small, loosely-coupled systems, composed in
`main.rs`" and "self-similarity between files is the feature" expressed as directories. The JS side
being flat was the house style; it had simply grown past the point where the Rust side would have
nested.

**Two: the flat directory was hiding a layering that already existed.** Fan-in ran as a clean
gradient - `cache 13, net 12, icons 9, apps 8, slugs 7, doccache 5`, down to `1` for every app file
and `0` for `index.js` - with fan-out its mirror image (`journal 14, notes 13, index 12,
editor 11`). Substrate at the bottom, composers at the top. The structure did not need inventing,
only writing down.

Layers (`data/`/`view/`/`components/`) were rejected because this app's data layer is neither
per-feature nor large: one Dexie mirror, one `docs` table, one stream, and Notes and Journal read
the same rows - `data/` would be five files that everything imports (which the fan-in numbers
already say) and the other two directories would become drawers. Slices (`notes/`, `journal/`,
`wiki/`) were rejected harder, because the apps are not independent: Notes, Recipes and Wikibook
are the same document machinery with different feature flags (B5), so slicing yields three thin
slices and one enormous `shared/`.

    node/js/
      index.js          the composition root - wiring only (B1)
      net.js  icons.js  modal.js  panes.js            single-purpose; stay flat
      auth.js  persona.js  computers.js  console.js   the shell; flat until it grows
      lookout.js  keepalive.js  docdate.js  search.js the pure core (see the cop)
      mirror.js  + mirror/{prefs,doccache}.js         the Dexie side
      doc/      session, editor, tree, slugs, annotations, upload,
                completions, turbolinks, livemarquee
      apps.js   + apps/{notes,journal,wiki}.js        registry beside its apps

`doc/` is `record/`; `mirror.js` + `mirror/` is `db.rs` grown parts; `apps.js` + `apps/` is
precisely `media.rs` + `media/{audio,image,video}.rs` - a registry beside a family of same-shaped
things. The old `cache.js` was renamed on the way in, because `cache/prefs.js` would have been a
lie (prefs are not a cache) while `mirror/prefs.js` is exactly right - they live in the mirror
database, which is what `openMirror` has always called it. Filenames
stay squashed-lowercase with no hyphens, as `doccache`/`docdate`/`livemarquee`/`keepalive` already
were.

**No barrel files.** The Rust side has `record.rs` because the language requires a module
declaration; that is a language tax, not a design choice, so the faithful translation is a
directory with nothing re-exporting it. Import the file you want.

**The growth rule**, which is the part that has to outlive this commit: *an app is one file until
it needs two, then it becomes `apps/journal.js` plus a sibling `apps/journal/`.* Journal at ~580
lines is nearly there; the tiers ahead (chat, boards, pages, webrings) will arrive past it. Same
rule `net.rs` followed.


- [ ] **S2. Revisit `rules/` once the pure set passes eight modules.** The directory was rejected on
  2026-07-29 against a pure set of THREE, where a cop naming them costs less than a tree change. The
  P section deliberately grows that set - it is at **seven** (`lookout`, `keepalive`, `docdate`,
  `swatch`, `apps`, `doc/naming`, `doc/treewalk`), so ONE more trips it - and past roughly eight, the declared list living inside
  `conventions.cjs` stops being worth maintaining by hand, at which point a directory *is* the
  declaration. That is why the Rust side gives its pure core a whole crate rather than a convention.
  `conventions.cjs` asserts the count, so this reopens itself as a failing test rather than waiting
  for anyone to remember. (Two earlier versions of this trigger measured the wrong thing - test
  files in `test/pure/`, then zero-import modules - and are recorded in git; the declared set is the
  faithful measure because it is the thing that gets unwieldy.) It stays a directory question, not a
  crate question: a second client sharing these rules is speculation, and the nameability test says
  no.

## A — Simplification

- [ ] **A3. Three copies of the shadow-buffer field hook.** `persona.js:463 useProfileField`,
  `doc/annotations.js:38 useField`, `doc/annotations.js:94 useClaimedDate` are the same ~50-line
  machine: local value, `dirty` ref, `valueRef` mirror, debounce, flush on blur + unmount, adopt
  the mirror when clean. One `useShadowField(mirrorValue, { save, debounceMs })`; the claimed-date
  variant passes a composite through `joinClaimed`. ~110 lines out.

- [ ] **A4. Three copies of marquee-render-with-honest-fallback.** `apps/notes.js:265`,
  `apps/journal.js:219`, `doc/editor.js:273` each do `try { parse(body) } catch { degrade }`, two
  with near-identical apology prose. A `<MarqueeBody source= profile= onUnparsable= />` owns the
  parse gate and the "(body not on this computer yet)" state once.


- [ ] **A8. The two XHR uploaders.** `doc/upload.js:41 uploadBinary` and `doc/upload.js:66
  uploadVideoParts` are 27-line twins differing only in URL and body shape (a `File` vs a
  `FormData`); progress, onload, onerror, and the error prose are identical. One `xhrUpload(url,
  body, onPct)` in `net.js` beside the shared `api()`, and both callers become three-liners. (XHR
  stays: `fetch` still has no upload-progress event.)

## B — Modularity

- [ ] **B4. `DocsApp` is ~290 lines doing six jobs** (`apps/notes.js`): scope filter, search
  filter, tag filter + cloud, sort, nav order, create, and a four-column render with a 50-line
  inlined list-row template. The tag column and the list row are each a clean component
  extraction. While in there: the `.pane-head` markup (label + tuck button) is written out twice,
  in `apps/notes.js`'s `paneHead` and again inline in `doc/tree.js`'s toolbar — one `<PaneHead
  label= onTuck= />` in `panes.js` (which now owns the tuck state) serves both, and the `Rail`
  component in `apps/notes.js` belongs there too.

- [ ] **B6. `fmtBytes` lives in `modal.js`** (`:48`). Byte formatting isn't modal chrome; it's an
  upload-flow display helper. Small, but it's the drift that makes a module's name stop predicting
  its contents.

## C — Readability

- [ ] **C1. The six-branch nested ternary in the editor's body render** (`doc/editor.js:428-460`),
  32 lines across `dump` / `waiting` / `read` / `interactive` / `side` / default — the least
  readable block in the UI. A `renderBody()` with early returns, or a `switch (mode)` after the
  two special cases, reads in one pass.

- [ ] **C2. Icon-only chip buttons copy-pasted 11 times** in `doc/editor.js:327-410` and again in
  `apps/notes.js:304-349`; the prev/next nav pair is byte-identical between the two files. A
  `<Chip icon= title= on= onClick= />` plus a `<NavChips nav= />` halves both headers and makes
  the chip row scannable as a list of capabilities.


*(The untested-pure-logic item that used to sit here is now P1/P2, under the principle that
explains it.)*

## P — Purity: how much logic belongs in testable files

**The principle (adopted 2026-07-29):** logic that can be a value-in, value-out function should
live in a file that is one, so it can be tested aggressively without a browser or a node. This is
the client-side echo of the proto/node split - STYLE.md already calls `ringtome-proto` "the
conformance boundary", and the UI's pure core is the same idea at a smaller scale.

**The boundary, because this principle has a failure mode.** STYLE.md's default is the opposite of
"maximise purity": integration tests against the real thing, and **no database mocks** - "the
queries are where the risk lives". Both can be true because there are two different things here:

- **Pure by nature** - a decision or transformation over values the caller already holds:
  ordering, matching, formatting, arithmetic, predicates. `resolveSlugPath` is pure matching with
  a Dexie fetch stapled on the front. Extract freely; the function was always in there.
- **Pure by extraction** - logic that IS the effect sequence: what to write first so a failure
  leaves a visible duplicate rather than a lost page; what to await; what invalidates what. You
  *can* "purify" these by injecting every effect as a callback, and then you are testing your
  mocks. The save machine's `dirty`/`inflight`/`parents` dance, the tree drag's
  place-before-remove ordering, and the upload's rename-vs-worker race all belong to the
  integration suite and its three real nodes.

**The tell:** if extracting something requires inventing a parameter that is a *callback*, stop -
you are building a mock harness. If it only requires passing in data the caller already has,
extract it.

**Calibration, from the scar record.** Of the field reports that earned comments in this codebase,
two were purity-shaped and pure extraction was the right cure (`lookout`'s predicate, `keepalive`'s
byte cap - both now tested). The others were not: A5's missing retry is a duplicated effect
sequence, `index.js`'s document flash was render timing, the journal's duplicate entries were a
ref-vs-state race. Purity would have caught none of those three. Extract what is genuinely a
function; do not contort the rest to reach a coverage number.

The pleasant surprise is that most of the work below is a **move, not a rewrite** - these are
already pure functions living inside component files, where nothing can see or test them. Thinning
those components is also most of B4 by another route.

- [ ] **P3. The app surfaces' decision logic.** Two extractions, both of which also thin a fat
  component: from `apps/notes.js`, the list pipeline (`orderDocs(docs, { bucket, appStyle, hits,
  tags })` - bucket scope, then search hits, then every active tag, then pinned-float →
  claimed-date → id tiebreak, including the rule that only the DEFAULT app's home bucket gathers
  unbucketed documents); and from `apps/journal.js`, the stream shape (`journalStack(entries,
  seals, now)` - `entryMs`, `dayKey`, the seal-override-vs-day-boundary rule, and the phantom
  rule, which needs six lines of comment today because it is subtle).

## D — Stale context in comments and in-app text

Empty, and worth keeping as a heading so the distinction survives: the **field-report** comments are
excellent and must be protected - `lookout.js`'s scar history, `keepalive.js`'s 64 KiB story,
`index.js`'s note on the flash the ref prevents, `apps/journal.js`'s on why the create guard is a
ref. The build-narration kind ("v0", "phase two", the gear that no longer exists) is what got swept,
along with the two in-app wording decisions - the debug chip is deleted and every app now names its
own things (`itemNoun`).


## E — The stylesheet

`index.css` is now a 33-line table of contents over 13 partials, each sitting beside the module it
dresses. The split was cut on the section markers the file had already drawn for itself, so the
cascade is unchanged - proven by diffing the built bundle, which came out identical once esbuild's
own filename markers were stripped. **The import order IS the cascade**, and it matters wherever a
host re-dresses a borrowed component (`apps/journal.css` flattens `.editor-live`, so it must land
after `doc/editor.css`); `index.css` says so at the top.

The cop that keeps it honest is `integration/test/pure/conventions.cjs` - dead classes, colour
literals outside `tokens.css`, and every partial imported exactly once. It found `.persona-badge`
on its first run, orphaned when C3 deleted the component it dressed.

- [ ] **E2. Make the prefix convention a rule** - and finish the two partials that knowingly hold
  rules belonging elsewhere (recorded at the top of `index.css`): `apps/notes.css` carries the
  shared reader/chip/annotation rules, which want `doc/surface.css` and `doc/annotations.css`, and
  `apps/wiki.css` carries the tree ROWS that `doc/tree.js` draws - whose `wiki-` prefix spans two
  modules and should become `tree-`. Both were left alone because moving them changes the cascade,
  which the splitting commit deliberately did not do. There is already a module system in the class
  names — `journal-*`, `wiki-*`, `upload-*`, `annot-*`, `note-row-*`, `bucket-*`, `app-header-*`,
  `pane-*`. Promoting it to "one prefix per file, prefix names the file" makes it greppable and
  enforceable, and it names the exceptions: the cross-prefix rules (`.journal .editor-live`,
  `.editor-side-preview .reader-marquee`, `.notes-columns .tag-column`) are all "a host
  re-dressing a borrowed component," and belong in the *host's* file with that said once.

## Reviewed and left alone (standing decisions, not history)

Re-litigating these costs more than reading this list.

- **`WikiApp` and `DocsApp` stay separate components** (B5, done 2026-07-29 by extracting
  `doc/docapp.js` rather than merging them). The spine they shared - live documents, URL-held
  selection, resume-where-you-left-off, the tree-reload bump, prev/next plus arrow keys - is two
  hooks now, in that order because an app computes its own document ORDER out of `docs`, so the
  order is an output of the app rather than an input to the spine. What is left in each app is its
  own honest arrangement: four tuckable columns against one tree. Merging them would have meant a
  render full of feature flags, which is what the ledger's own no-inner-platforms rule forbids.
- **The field-report comments** (`lookout.js`, `keepalive.js`, `index.js:70-76`,
  `apps/journal.js:529-531`): long, and load-bearing. D is not a licence to thin these.
- **The stylesheet's absolute size**: proportionate to the JS. E is about seams and namespacing,
  not line count; splitting for its own sake would buy nothing.
- **`htm` + `preact` over JSX**: no build-step transform for templates, and the tagged-template
  form is uniform across every module. Not revisited.
- **XHR for uploads** (A8): `fetch` still has no upload-progress event. The duplication goes; the
  XHR stays.
- **No house primitives for the bare icon buttons, fields, or pills** (was E4, closed 2026-07-29
  after measuring it). The review counted 7 near-identical icon buttons, 6 fields and 3 pills by
  eyeballing their shape. Extracting each class's EFFECTIVE declarations per state from the built
  bundle told a different story: a `.icon-btn` primitive would need **five of its seven consumers
  to undo part of it** - `bucket-btn` and `journal-delete` cancelling the hover colour (a delete
  stays coral; a button on the ink band does not go teal), `pane-min` and `wiki-act` cancelling the
  opacity, `journal-font` cancelling `border: 0`. What is genuinely universal is
  `display: inline-flex; background: none; cursor: pointer` - three boilerplate declarations, which
  is exactly what STYLE.md blesses over "one parameterized engine". `.field` is worse: its six
  consumers span three backgrounds, two border weights, four paddings and two focus treatments, all
  of which look deliberate. `.pill` shares three declarations across three consumers. A primitive
  its consumers fight is a wrong average, and flattening the properties that carry the meaning is
  not a saving. `--panel-clip` and `.chip` + its modifiers remain the two places the shape really
  IS shared, and they are the examples to copy if a fourth ever appears.
- **`console.js`'s `chunk` stays untested** (the one P5 target skipped). Four lines of
  `for (i += n) push(slice(i, i + n))`, in an impure module; moving it somewhere testable to prove
  that array slicing works is ceremony, and STYLE.md's unit-test rule says *isolated boundaries and
  pure logic*, not every expression.
- **`doc/session.js` keeps its own loader** rather than sharing `doc/detail.js`. A5 consolidated
  the two READ-ONLY loaders; the session's `load()` also sets the save machine's `parents` and its
  divergence fingerprint, and drives the status transitions including the waiting room whose
  comment records a swallowed paragraph. Sharing it would mean threading the save machine through
  a hook to save perhaps fifteen lines, against the file STYLE.md's own header says to keep
  faithful. Three loaders became two on purpose, not two became one and a leftover.
- **The editor's view mode READS its pref once instead of watching it** (`doc/editor.js`, via
  `readPref`). `mirror/prefs.js` now offers a live `usePref` that would also sync the mode across
  tabs, and it was deliberately not used: the mode is a local buffer whose "a click that beats the
  read wins" rule is load-bearing, and two tabs on one document silently re-moding each other is
  the cursor-memory mistake in a different coat. Revisit only if someone actually wants it.

## Suggested working order

1. **A3**, **A4**, **A8**, **C1**, **C2**, and **B4 + P3** together - all small and mechanical.
   **P3** is the one that trips S2: it makes the pure set eight.
2. **E2** — finish the two mis-homed CSS partials the split left, and make the prefix rule a rule.
3. **S2** — not scheduled: `conventions.cjs` asserts the trigger, so it arrives on its own as a
   failing test when the pure set reaches eight modules.
