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
      index.js       the composition root - wiring only
      net.js  icons.js  modal.js  panes.js  search.js  clock.js  buckets.js
      auth.js  persona.js  computers.js  console.js     the shell; flat until it grows
      pure/          the conformance boundary: apps (the registry), naming, treewalk,
                     lookout, keepalive, docdate, swatch
      mirror.js  + mirror/{prefs,doccache}.js           the Dexie side
      doc/           session, detail, editor, reader, tree, address, crosslink,
                     annotations, upload, completions, turbolinks, livemarquee, docapp
      apps/          notes, journal, wiki - the app surfaces

`doc/` is `record/` and `mirror.js` + `mirror/` is `db.rs` grown parts. The old `cache.js` was
renamed on the way in, because `cache/prefs.js` would have been a lie (prefs are not a cache) while
`mirror/prefs.js` is exactly right - they live in the mirror database, which is what `openMirror`
has always called it. Filenames stay squashed-lowercase with no hyphens, as
`doccache`/`docdate`/`livemarquee`/`keepalive` already were.

**`pure/` (decided 2026-07-30).** A directory for the pure core was rejected on 2026-07-29 against a
set of three, on the grounds that the Rust side's equivalent firewall is a CRATE rather than a
folder and the JS analogue of compiler-enforced is a test - so the cop came first and the modules
stayed scattered. Two things settled it the other way once the set reached seven. First, the cop's
membership list was a hand-written array inside `conventions.cjs`, and purity cannot be derived to
replace it (`icons.js` has no local imports and touches no DOM API, but it is a table of React
components - "that package renders" is invisible from an import path). So the declaration must be
explicit, and the only question was list-in-a-script versus location-in-the-tree. Second - the
argument that actually decided it - `integration/test/pure/` already existed, so the tests were
collocated while the modules were not: `js/pure/x.js` tested by `test/pure/x.cjs` makes the
declaration self-evident on BOTH sides, and neither half can drift. The cost, accepted knowingly, is
that `pure/naming.js` and `pure/treewalk.js` now sit away from the `doc/` code that consumes them,
and the app registry sits away from `apps/`.

**No barrel files.** The Rust side has `record.rs` because the language requires a module
declaration; that is a language tax, not a design choice, so the faithful translation is a
directory with nothing re-exporting it. Import the file you want.

**The growth rule**, which is the part that has to outlive this commit: *an app is one file until
it needs two, then it becomes `apps/journal.js` plus a sibling `apps/journal/`.* Journal at ~580
lines is nearly there; the tiers ahead (chat, boards, pages, webrings) will arrive past it. Same
rule `net.rs` followed.



## A — Simplification

Empty. Every entry here was the same finding wearing a different hat: the same code written a second
time, the copies then drifting apart, and one of them missing a clause. That is where the real bug
was each time - the journal reader that never retried a pending body, the wiki that silently lacked
the unbucketed catch-all, three `api()` variants disagreeing about `err.status`. When you catch
yourself writing something a second time, that is the finding, not the tidying.

## B — Modularity

Empty. What the section was about, kept because the shape is the point: `index.js` composes and
implements nothing, an app composes what is BELOW it in `doc/` and never a sibling app, the two
document apps share a spine (`doc/docapp.js`) without sharing a render, and every module's name
predicts its contents. `conventions.cjs` holds the two rules that can regress - an acyclic graph and
no app importing another app.


## C — Readability

Empty. The chip row is `doc/chips.js`, the editor's body render is five early returns, and the
shadow-buffer machine is `shadow.js`. Watch for the pattern that produced all three: a block of
markup or state written out a second time "just for now".


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

The set is at nine (`pure/`): the app registry, the cozy-address rules, the tree walks, the list
order, the day book's shape, the divergence lookout, the keepalive cap, claimed dates, and Swatch
time. Most of getting there was a **move, not a rewrite** - they were already pure functions living
inside component files, where nothing could see or test them. Two real bugs fell out of writing the
vectors (a forgeable cache fingerprint, and a cozy link that opened the wrong document), which is
the argument for the whole exercise.


## D — Stale context in comments and in-app text

Empty, and worth keeping as a heading so the distinction survives: the **field-report** comments are
excellent and must be protected - `lookout.js`'s scar history, `keepalive.js`'s 64 KiB story,
`index.js`'s note on the flash the ref prevents, `apps/journal.js`'s on why the create guard is a
ref. The build-narration kind ("v0", "phase two", the gear that no longer exists) is what got swept,
along with the two in-app wording decisions - the debug chip is deleted and every app now names its
own things (`itemNoun`).


## E — The stylesheet

`index.css` is a table of contents over 18 partials, each sitting beside the module it dresses. The split was cut on the section markers the file had already drawn for itself, so the
cascade is unchanged - proven by diffing the built bundle, which came out identical once esbuild's
own filename markers were stripped. **The import order IS the cascade**, and it matters wherever a
host re-dresses a borrowed component (`apps/journal.css` flattens `.editor-live`, so it must land
after `doc/editor.css`); `index.css` says so at the top.

**A rule's home is its class prefix, and the prefix names the file** - `journal-*` in
`apps/journal.css`, `annot-*` in `doc/annotations.css`, `tree-*` in `doc/tree.css`. Two partials
knowingly held other modules' rules until 2026-07-30; both were emptied out, and the tree's rows were
renamed `wiki-*` → `tree-*` in the same pass, because a class called `wiki-row` inside a TurboNotes
notebook was a lie the stylesheet told. `.wiki`, `.wiki-columns` and `.wiki-main` stayed behind:
those really are the Wikibook's own two-column arrangement. Cross-prefix rules are the stated
exception - `.journal .editor-live`, `.editor-side-preview .reader-marquee`,
`.notes-columns .tree-pane` - and each lives in the HOST's file, because "a host re-dressing a
borrowed component" is whose business it is.

The cop that keeps it honest is `integration/test/pure/conventions.cjs` - dead classes, colour
literals outside `tokens.css`, and every partial imported exactly once. It found `.persona-badge` on
its first run, orphaned when C3 deleted the component it dressed, and later caught a `chip-${tone}`
constructed class name - which is invisible to a literal search, so building one silently switches
the check off for that rule.


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

Nothing queued. The balance is zero for the first time since this file was opened on 2026-07-29.

What to do instead, when the UI next gets worked on: read `node/README.md`'s layout section first,
put decision-shaped logic in `pure/` with vectors beside it, and let `just ui-check` tell you when
you have broken one of the house rules. The sections above that are "empty" are kept deliberately -
each one records what the category was about, so a future entry has somewhere obvious to land.
