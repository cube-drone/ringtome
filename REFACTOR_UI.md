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

- [ ] **S1. The purity cop.** A `rules/` directory was considered and deferred, not settled - see
  S2: on the Rust side that firewall is not a directory but a separate crate (`ringtome-proto` -
  "values in, `Result` out, no async/storage/clocks"), and the JS analogue of compiler-enforced is
  a test, because architecture cops are tests (STYLE.md). Add one to `just ui-check`, asserting
  two things about the declared pure set (`lookout.js`, `keepalive.js`, `docdate.js`): **(a)**
  each imports nothing from `js/` and mentions no `fetch`, `document`, `window`, `Dexie`, or
  `preact`; **(b)** each has a test file in `integration/test/pure/`. Clause (b) is the one the
  test glob can never provide - a glob finds the tests that exist, so only a cop that enumerates
  the modules can catch a pure module nobody tested. `search.js` is the fourth by intent but
  imports the mirror for `useSearch`; it joins the set once that hook moves to
  `mirror/queries.js`. Land with E5 - same twenty-line script.

- [ ] **S2. Revisit `rules/` once the pure set passes ~8 modules.** The directory was rejected on
  2026-07-29 against a pure set of THREE, where a cop naming them costs less than a tree change.
  The P section below deliberately grows that set; past roughly eight, S1's "declared pure set"
  becomes a hand-maintained list living in a script, and a directory *is* that declaration - which
  is precisely why the Rust side gives its pure core a whole crate rather than a convention. The
  trigger is a count, so it can be checked rather than argued: when `integration/test/pure/` holds
  eight files, reopen this. (It stays a directory question, not a crate question: a second client
  sharing these rules is speculation, and the nameability test says no.)

### What the move changed about the items below

- **B2** (`apps/wiki.js` importing `RightColumn` and `useArrowNav` from `apps/notes.js`) is now
  positioned rather than fixed: both apps sit in `apps/` with `doc/` beneath them, so the fix is a
  three-symbol extraction into `doc/reader.js` and `doc/nav.js` instead of a cross-layer redesign.
  Still open; the sideways import survived the move because splitting a file is not a rename.
- **B3** (`doc/slugs.js` holding three jobs) is unchanged in substance, but its target is now
  named: `doc/slugs.js` splits into `doc/address.js` and `doc/crosslink.js`.
- The **`doc/slugs.js` ↔ `doc/tree.js` cycle** is now internal to `doc/` - still a cycle, but an
  implementation detail of one module rather than a cross-module one.
- **E1** (splitting the stylesheet) should colocate: `doc/editor.css` beside `doc/editor.js`, with
  `index.css` keeping its `@import` list pointed into the tree. That leaves the two-build setup
  alone - CSS stays its own esbuild entry, so `npm run css` remains the separate step it is today
  rather than JS-imported styles quietly changing what `npm run build` emits.

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


- [ ] **A6. Three last-open memories; one restore effect twice verbatim.** `lastDocMemory`
  (`apps/notes.js:30`), `lastPageMemory` (`apps/wiki.js:20`), `lastBucketMemory` (`index.js:32`)
  share the `${root}:${id}` discipline. `apps/wiki.js:63-76` is a character-for-character copy of
  `apps/notes.js:425-438`, comment included; the `nav` object at `apps/notes.js:519` and
  `apps/wiki.js:45` is the same again. A `docnav.js` with `useResumeMemory(…)` and
  `buildNav(order, selected, go, tips)` beside the existing `useArrowNav` closes both.

- [ ] **A7. Eight ad-hoc tree recursions.** `doc/tree.js` has `collect` twice (`:179`, `:542`),
  `walk` (`:565`), `sweep` (`:601`), `find` (`:454`), `flatDocs` (`:317`); `doc/slugs.js` has
  another `walk` (`:158`) and an inline strict-descent loop (`:100`). Four named helpers in a
  `treewalk.js` — `flatDocs(tree)`, `pathToDoc(tree, docId)`, `descendantTaxIds(node)`,
  `eachMember(node, fn)` — replace all eight, and become the natural home for the "lowest id wins"
  tie-break currently re-implemented as an inline `.sort()` in five places.

- [ ] **A8. The two XHR uploaders.** `doc/upload.js:41 uploadBinary` and `doc/upload.js:66
  uploadVideoParts` are 27-line twins differing only in URL and body shape (a `File` vs a
  `FormData`); progress, onload, onerror, and the error prose are identical. One `xhrUpload(url,
  body, onPct)` in `net.js` beside the shared `api()`, and both callers become three-liners. (XHR
  stays: `fetch` still has no upload-progress event.)

## B — Modularity

- [ ] **B1. `index.js` is not a composition root.** STYLE.md: main "wires modules together and
  starts loops; it implements nothing." Today it implements the Swatch-time clock (`:143-165`),
  the whole `BucketSwitcher` including `prompt`/`confirm`/`alert`, its own API calls, and a
  delete-every-document loop (`:173-285`), and — the dense part — a four-effect bucket state
  machine (`:336-378`) juggling `bucketPick`, `lastBucketMemory`, `cozyBucketRow`, and a deep-link
  correction guarded by a ref. Extracting `buckets.js` (the switcher + `useBucketChoice(root,
  appHere, cozyBucketRow)` returning `{ bucket, switchBucket }`) and `clock.js` takes `index.js`
  from 537 lines to ~200 of pure wiring, and lets the four effects be read as one story.

- [ ] **B2. `apps/wiki.js` imports two things from `apps/notes.js`** (`apps/wiki.js:12`:
  `RightColumn`, `useArrowNav`). Both are shared surfaces, not notes surfaces — `RightColumn` to a
  `docsurface.js` next to the editor/reader pair, `useArrowNav` to `docnav.js` (A6). Right now the
  dependency graph says "the wiki is downstream of notes," which isn't the design.

- [ ] **B3. `doc/slugs.js` holds three jobs**: the address rules (slugify / resolve / generate),
  the drag-and-drop wire protocol (`startDocDrag`, `takeDocDropSwap`), and the in-flight swap
  registry (`dragSwaps` + its 60s leak sweep). The drag protocol is only there because it needs
  `slugPathFor`; a `crosslink.js` importing `doc/slugs.js` states that dependency instead of
  merging the concepts, and gives the `application/x-ringtome-doc` / `-section` MIME strings a
  single owner (currently spelled out in `doc/tree.js:175`, `doc/upload.js:455,462`,
  `doc/slugs.js:214`).

- [ ] **B4. `DocsApp` is ~290 lines doing six jobs** (`apps/notes.js`): scope filter, search
  filter, tag filter + cloud, sort, nav order, create, and a four-column render with a 50-line
  inlined list-row template. The tag column and the list row are each a clean component
  extraction. While in there: the `.pane-head` markup (label + tuck button) is written out twice,
  in `apps/notes.js`'s `paneHead` and again inline in `doc/tree.js`'s toolbar — one `<PaneHead
  label= onTuck= />` in `panes.js` (which now owns the tuck state) serves both, and the `Rail`
  component in `apps/notes.js` belongs there too.

- [ ] **B5. `WikiApp` is `DocsApp` minus two columns**, but **do not merge the components** —
  STYLE.md's "four similar-but-honest decode functions beat one parameterized decode engine"
  applies and should win. Both apps run the same spine: `useSlugDocId` → `select` →
  `useCozyAddress` → `treeReload` → `useColWidths` → `treeOrder`/`nav` → `useArrowNav` →
  resume-memory → `RightColumn`. Extract that as `useDocApp(root, app, docId, bucket)` returning
  `{ selected, select, nav, treeOrder, setTreeOrder, treeReload, bumpTree }`; both keep their own
  honest render and ~80 lines of duplicated plumbing go.

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

- [ ] **P1. The cozy-address rules (the highest-value bite).** Split `doc/slugs.js` into a pure
  matcher - `matchSlugPath(segs, { roster, docs, tree })` and the path *generator* beside it - and
  a thin shell that fetches those three things from the mirror. Then vector the rules that are
  currently load-bearing and unexercised: strict-walk-then-forgiving-fallback, lowest-id ties
  throughout, the "would this slug resolve back to US?" check, and `slugify`'s Unicode property
  escapes (no vector anywhere today). **Then the property test**, which is the real prize:
  *`slugPathFor` followed by `resolveSlugPath` must return the document you started from*, for any
  roster/tree/title shape - the client-side echo of proto's test vectors, and a test that catches
  breakage no example-based case would think to check. Land with B3 (the same file is splitting).
- [ ] **P2. `apps.js` vectors - no refactor at all.** `appTypeOf`, `bucketsForApp`, `featuresOf`
  and `appForStyle` are already pure and decide what appears in every list in the product. They
  need tests, not surgery: the implicit "a bucket named `recipes` IS a recipes bucket" rule, the
  registry fallback, and the unknown-style-never-strands-you default.
- [ ] **P3. The app surfaces' decision logic.** Two extractions, both of which also thin a fat
  component: from `apps/notes.js`, the list pipeline (`orderDocs(docs, { bucket, appStyle, hits,
  tags })` - bucket scope, then search hits, then every active tag, then pinned-float →
  claimed-date → id tiebreak, including the rule that only the DEFAULT app's home bucket gathers
  unbucketed documents); and from `apps/journal.js`, the stream shape (`journalStack(entries,
  seals, now)` - `entryMs`, `dayKey`, the seal-override-vs-day-boundary rule, and the phantom
  rule, which needs six lines of comment today because it is subtle).
- [ ] **P4. The tree's walks and drag arithmetic.** `flatDocs` (book order, first occurrence
  only), descendant collection, `deleteSection`'s inside/outside sort, and the drop-index
  arithmetic - which is counted *without* the dragged member and is exactly the kind of off-by-one
  that a vector pins forever. Land with A7, which is already extracting these into
  `doc/treewalk.js`; the only addition is that the extracted module takes data and returns data.
- [ ] **P5. The strays.** Small, pure, and untested: `mirror/doccache.js`'s `docFingerprint` and
  `rosterFingerprint` (they *are* the read-your-cache freshness contract), `doc/upload.js`'s
  `refFor` (extension guess + label sanitising), `index.js`'s `beats` (Swatch time, with
  hand-rolled UTC+1 arithmetic), and `console.js`'s `chunk`. Each is a handful of assertions.

## D — Stale context in comments and in-app text

The **field-report** comments are excellent and must be protected: `lookout.js`'s scar history,
`keepalive.js`'s 64 KiB story, `index.js`'s note on the flash the ref prevents,
`apps/journal.js`'s on why the create guard is a ref. The build-narration kind ("v0", "phase two",
the removed gear) has been swept; what is left below needs a decision from Curtis, not a cleanup.

- [ ] **D9. The item noun disagrees across three surfaces of one app.** The list button says "+
  new item", the tree toolbar says "page", and the bucket switcher builds its labels from
  `bucketNoun` ("New Recipe Book"). A recipe book's list button should probably say "+ new recipe"
  — which wants an `itemNoun` beside `bucketNoun` in the registry, so it is a small feature rather
  than a copy fix, which is why it wasn't swept with the rest of D.
- [ ] **D10. The debug dump has no gate.** `doc/editor.js`'s version-history dump is a development
  tool reached by a chip, and `features.debug` defaults ON for every app. The word TEMPORARY is
  gone from the code and the honest condition is written there instead ("off at ship day") — but
  the condition is now only a comment. Either gate it on a dev flag or drop the chip; it must not
  be the thing a first user finds behind a skull icon.

## E — The stylesheet (`index.css`, ~2600 lines)

Size isn't the problem — 2.6k lines of CSS against ~6.6k of JS is proportionate. The problem is
that **one flat file with one flat namespace has no seams**, so ordering has already drifted and
dead rules can't be found. Evidence: `.chip` at `:1591` and its `.chip-merged` modifier at
`:2598`, the last line of the file; `--- your computers ---` (`:739`) immediately followed by
`--- persona management pages ---` (`:741`) with the computers rules actually at `:851`;
`.skip-link` at `:713` and `.skip-link:hover` at `:1863`; `.editor-waiting` at `:1880`, *after*
the mobile `@media` at `:1867`; three dead rules (`.marquee-page` `:417`, `.reader-title` `:1529`,
`.modal-note` `:2481`). The token block at the top is now complete and authoritative - a colour
literal anywhere below it is a bug, which E5's cop can check for free.

- [ ] **E1. Split into partials, one per JS module family, bundled by esbuild.** The mechanism is
  already proven — `index.css:2` `@import`s `marquee-css`, `--bundle` inlines local imports, and
  `--watch` tracks the import graph, so `just csswatch` keeps working. The split mirrors the JS
  layout (the self-similarity STYLE.md prizes): `tokens.css`, `fonts.css` (the 30 `@font-face` +
  optical normalization — ~65 lines nobody ever needs to read), `base.css`, `shell.css`,
  `console.css`, `auth.css`, `persona.css`, `chips.css`, `docs.css`, `editor.css`, `reader.css`,
  `tree.css`, `journal.css`, `modal.css`, `upload.css`. `index.css` becomes ~16 `@import` lines: a
  table of contents, and the one place a section header can't drift from its section.
- [ ] **E2. Make the prefix convention a rule.** There is already a module system in the class
  names — `journal-*`, `wiki-*`, `upload-*`, `annot-*`, `note-row-*`, `bucket-*`, `app-header-*`,
  `pane-*`. Promoting it to "one prefix per file, prefix names the file" makes it greppable and
  enforceable, and it names the exceptions: the cross-prefix rules (`.journal .editor-live`,
  `.editor-side-preview .reader-marquee`, `.notes-columns .tag-column`) are all "a host
  re-dressing a borrowed component," and belong in the *host's* file with that said once.
- [ ] **E4. Four house primitives, and no more than four.** The repetition is concentrated and
  countable: **the bare icon button** — `.bucket-btn`, `.pane-min`, `.wiki-act`, `.journal-tag`,
  `.journal-seal`, `.journal-delete`, `.journal-font` (7 near-copies of `inline-flex` /
  `background:none` / `border:0` / `color:muted` / `cursor:pointer` / `opacity:.75` + hover-teal);
  **the field** — `.welcome-form input`, `.name-input`, `.spare-paste`, `.profile-bio`,
  `.annot-desc`, `.upload-name` (6 copies of surface + `1px solid border-strong` + `radius:6px` +
  `font:inherit`); **the pill** — `.note-row-tag`, `.annot-tag`, `.journal-tag-chip` (3 copies of
  `radius:999px` + surface-2 + border); **the panel** — already done right via `--panel-clip`,
  which is the proof the approach works. STYLE.md's "no inner platforms" applies and its test is
  nameability: each of these has 3–7 *existing, named* consumers, so each passes. This is the CSS
  analogue of `icons.js` — one place maps meaning→look, as one place maps meaning→glyph. **Hold
  the line at four**; the moment anyone writes `.u-flex-gap-2` the rule has been broken.
- [ ] **E5. A dead-class cop in `just ui-check`.** ~20 lines intersecting `^\.[a-z-]+` in the CSS
  against string literals in the JS, allowlisting the external contracts (`mq-*`, `cm-*`, `ph`).
  It found three dead rules in about two seconds. STYLE.md: "architecture cops are tests, not
  runtime machinery"; `node/tests/conventions.rs` is the precedent.

## Reviewed and left alone (standing decisions, not history)

Re-litigating these costs more than reading this list.

- **Merging `WikiApp` into `DocsApp`** (see B5): the duplication is real but the two honest
  renders are the point. Share the spine as a hook; leave the components apart.
- **The field-report comments** (`lookout.js`, `keepalive.js`, `index.js:70-76`,
  `apps/journal.js:529-531`): long, and load-bearing. D is not a licence to thin these.
- **The stylesheet's absolute size**: proportionate to the JS. E is about seams and namespacing,
  not line count; splitting for its own sake would buy nothing.
- **`htm` + `preact` over JSX**: no build-step transform for templates, and the tagged-template
  form is uniform across every module. Not revisited.
- **XHR for uploads** (A8): `fetch` still has no upload-progress event. The duplication goes; the
  XHR stays.
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

1. **P2** then **P5** — pure vectors with no refactor attached, so `integration/test/pure/` and the
   habit of adding to it both grow before the bigger extractions land on top.
2. **E1 + E5** as one commit (mechanical; the split is verifiable by diffing the built bundle
   byte-for-byte), then **E4** on its own.
3. **P1 + B3** together (the same file splits), and **S1** alongside — the cop wants the pure set
   to have stopped moving.
4. **A6 / B2 / B5** (`docnav.js`, `docsurface.js`, `useDocApp`), then **B1** (`buckets.js`,
   `clock.js` out of `index.js`).
5. **A7 + P4** together, then **A3**, **A4**, **A8**, **C1**, **C2**, and **B4 + P3** together.
6. **S2** — count `integration/test/pure/`; if it holds eight files, decide on `rules/`.
