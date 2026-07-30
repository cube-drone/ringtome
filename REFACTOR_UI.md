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

Named first because it calibrates the rest. `docsession.js`, `lookout.js`, `keepalive.js`,
`doccache.js`, and `icons.js` are the patterns the rest of the UI should be measured against: the
save engine extracted from its chrome and shared by two surfaces; the two predicates that cost
real debugging living as pure functions with unit tests (`integration/test/lookout.cjs`,
`keepalive.cjs`) and comments that are scar records rather than narration; one place mapping
*meaning* → glyph. Several fixes below are "do what that module did."

## A — Simplification

- [ ] **A3. Three copies of the shadow-buffer field hook.** `persona.js:463 useProfileField`,
  `annotations.js:38 useField`, `annotations.js:94 useClaimedDate` are the same ~50-line machine:
  local value, `dirty` ref, `valueRef` mirror, debounce, flush on blur + unmount, adopt the
  mirror when clean. One `useShadowField(mirrorValue, { save, debounceMs })`; the claimed-date
  variant passes a composite through `joinClaimed`. ~110 lines out.

- [ ] **A4. Three copies of marquee-render-with-honest-fallback.** `notes.js:265`,
  `journal.js:219`, `editor.js:273` each do `try { parse(body) } catch { degrade }`, two with
  near-identical apology prose. A `<MarqueeBody source= profile= onUnparsable= />` owns the parse
  gate and the "(body not on this computer yet)" state once.

- [ ] **A5. Two copies of cache-first doc loading — already diverged, and it's a bug.**
  `docsession.js:55`, `notes.js:227`, `journal.js:195` all do `cachedDoc → fetch → rememberDoc`.
  But `notes.js:234` retries every 2s while the body is null and `journal.js` does not — so a
  sealed journal entry whose blobs are still travelling shows "(not on this computer yet)"
  *permanently* until you navigate away. Fix it **by** extracting `useDocDetail(root, docId)`, the
  read-only sibling of `useDocSession`.

- [ ] **A6. Three last-open memories; one restore effect twice verbatim.** `lastDocMemory`
  (`notes.js:30`), `lastPageMemory` (`wiki.js:20`), `lastBucketMemory` (`index.js:32`) share the
  `${root}:${id}` discipline. `wiki.js:63-76` is a character-for-character copy of
  `notes.js:425-438`, comment included; the `nav` object at `notes.js:519` and `wiki.js:45` is the
  same again. A `docnav.js` with `useResumeMemory(…)` and `buildNav(order, selected, go, tips)`
  beside the existing `useArrowNav` closes both.

- [ ] **A7. Eight ad-hoc tree recursions.** `tree.js` has `collect` twice (`:179`, `:542`), `walk`
  (`:565`), `sweep` (`:601`), `find` (`:454`), `flatDocs` (`:317`); `slugs.js` has another `walk`
  (`:158`) and an inline strict-descent loop (`:100`). Four named helpers in a `treewalk.js` —
  `flatDocs(tree)`, `pathToDoc(tree, docId)`, `descendantTaxIds(node)`, `eachMember(node, fn)` —
  replace all eight, and become the natural home for the "lowest id wins" tie-break currently
  re-implemented as an inline `.sort()` in five places.

- [ ] **A8. The two XHR uploaders.** `upload.js:41 uploadBinary` and `upload.js:66
  uploadVideoParts` are 27-line twins differing only in URL and body shape (a `File` vs a
  `FormData`); progress, onload, onerror, and the error prose are identical. One
  `xhrUpload(url, body, onPct)` in `net.js` beside the shared `api()`, and both callers become
  three-liners. (XHR stays: `fetch` still has no upload-progress event.)

## B — Modularity

- [ ] **B1. `index.js` is not a composition root.** STYLE.md: main "wires modules together and
  starts loops; it implements nothing." Today it implements the Swatch-time clock (`:143-165`),
  the whole `BucketSwitcher` including `prompt`/`confirm`/`alert`, its own API calls, and a
  delete-every-document loop (`:173-285`), and — the dense part — a four-effect bucket state
  machine (`:336-378`) juggling `bucketPick`, `lastBucketMemory`, `cozyBucketRow`, and a
  deep-link correction guarded by a ref. Extracting `buckets.js` (the switcher +
  `useBucketChoice(root, appHere, cozyBucketRow)` returning `{ bucket, switchBucket }`) and
  `clock.js` takes `index.js` from 537 lines to ~200 of pure wiring, and lets the four effects be
  read as one story.

- [ ] **B2. `wiki.js` imports two things from `notes.js`** (`wiki.js:12`: `RightColumn`,
  `useArrowNav`). Both are shared surfaces, not notes surfaces — `RightColumn` to a
  `docsurface.js` next to the editor/reader pair, `useArrowNav` to `docnav.js` (A6). Right now the
  dependency graph says "the wiki is downstream of notes," which isn't the design.

- [ ] **B3. `slugs.js` holds three jobs**: the address rules (slugify / resolve / generate), the
  drag-and-drop wire protocol (`startDocDrag`, `takeDocDropSwap`), and the in-flight swap registry
  (`dragSwaps` + its 60s leak sweep). The drag protocol is only there because it needs
  `slugPathFor`; a `crosslink.js` importing `slugs.js` states that dependency instead of merging
  the concepts, and gives the `application/x-ringtome-doc` / `-section` MIME strings a single
  owner (currently spelled out in `tree.js:175`, `upload.js:455,462`, `slugs.js:214`).

- [ ] **B4. `DocsApp` is ~290 lines doing six jobs** (`notes.js`): scope filter, search filter, tag
  filter + cloud, sort, nav order, create, and a four-column render with a 50-line inlined
  list-row template. The tag column and the list row are each a clean component extraction. While
  in there: the `.pane-head` markup (label + tuck button) is written out twice, in `notes.js`'s
  `paneHead` and again inline in `tree.js`'s toolbar — one `<PaneHead label= onTuck= />` in
  `panes.js` (which now owns the tuck state) serves both, and the `Rail` component in `notes.js`
  belongs there too.

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

- [ ] **C1. The six-branch nested ternary in the editor's body render** (`editor.js:428-460`), 32
  lines across `dump` / `waiting` / `read` / `interactive` / `side` / default — the least readable
  block in the UI. A `renderBody()` with early returns, or a `switch (mode)` after the two special
  cases, reads in one pass.

- [ ] **C2. Icon-only chip buttons copy-pasted 11 times** in `editor.js:327-410` and again in
  `notes.js:304-349`; the prev/next nav pair is byte-identical between the two files. A
  `<Chip icon= title= on= onClick= />` plus a `<NavChips nav= />` halves both headers and makes
  the chip row scannable as a list of capabilities.

- [ ] **C3. Dead exports and vocabulary** (all free to delete): `PersonaBadge`
  (`persona.js:398`, no consumers); `Icons.gear`, `Icons.blog`, `Icons.book`
  (`icons.js:72,67,68`, none); `docApps` (`apps.js:101`, exported but used only in its own file);
  `app.soon`, handled in `console.js:37` and styled at `index.css:1004-1011` but carried by no
  app.

- [ ] **C4. Untested pure logic that has earned tests.** The pattern exists —
  `integration/test/lookout.cjs` imports the ESM module from mocha and interrogates it. Two
  modules deserve it: `slugs.js`'s resolution rules (strict-walk-then-forgiving-fallback,
  lowest-id ties, the "would this slug resolve back to us?" check at `:180-194`) are load-bearing,
  pure, and subtle, and `slugify` does Unicode property escapes with no vector anywhere; and
  `apps.js`'s `appTypeOf` / `bucketsForApp`, which decide what appears in every list.

## D — Stale context in comments and in-app text

There is a clear split here, and it matters for how this category gets worked. The **field-report**
comments are excellent and must be protected: `lookout.js`'s scar history, `keepalive.js`'s 64 KiB
story, `index.js:70-76` on the flash the ref prevents, `journal.js:529-531` on why the guard is a
ref. What follows is the other kind — "where we were in the build," which a reader trusts and is
then wrong about the file's shape.

- [ ] **D1. `notes.js:1-5`** — "The notes app, v0: two columns and honesty… The editor, taxonomies
  in the left column, tag filters, and the flexible cozy-OS window all come later; this is the
  skeleton they hang on." Every one of those has landed; the file now describes four columns and
  an editor. Worst offender.
- [ ] **D2. `upload.js:1-10`** — "File upload, **phase two** … **Phase three** adds the
  in-document placeholder and the final file reference." Phase three is in this same file
  (`useUploadCapture`, `:392`).
- [ ] **D4. The gear that no longer exists**, in three places: `index.js:290` ("reached by the
  dock gear"), `persona.js:411` ("reached by the gear in the dock"), `apps.js:19` ("Also
  reachable from the footer gear"). `index.js:383-385` explains the gear's *removal* — so the
  codebase both documents the removal and points at the removed thing.
- [ ] **D5. `persona.js:384-389`** — two stacked doc comments saying the same thing; the first
  describes `PersonaBadge` but sits above `usePersonaName`, left behind by a move.
- [ ] **D6. `index.css:77`** — "Every colour in the app is one of these tokens, so the whole
  scheme re-tunes from here." Eight hard-coded colours say otherwise (E3). By STYLE.md's own rule
  ("a stale context comment is a bug") this is load-bearing-false, not just untidy.
- [ ] **D7. `editor.js:104`** — `// TEMPORARY: the merge-debug history dump`, with
  `features.debug` defaulting true for every app. Either it's permanent (drop the word) or it
  gets a line here with a removal condition.
- [ ] **D8. `apps.js:57-62`** — the Wikibook rename explains itself for six lines. That id ≠
  label is worth one line; the changelog belongs in git.
- [ ] **D9. In-app text.** The persona null state (`persona.js:220-224`) ends mid-thought —
  "That's what happens when you..." trailing into a button — reading as unfinished rather than as
  a deliberate sentence-completing link. And the noun vocabulary disagrees across three surfaces
  of the same app: `notes.js:591` says "+ new item", `tree.js:708` says "page", `apps.js` names
  them by `bucketNoun`.

## E — The stylesheet (`index.css`, 2604 lines)

Size isn't the problem — 2.6k lines of CSS against ~6.6k of JS is proportionate. The problem is
that **one flat file with one flat namespace has no seams**, so ordering has already drifted and
dead rules can't be found. Evidence: `.chip` at `:1594` and its `.chip-merged` modifier at
`:2601`, the last line of the file; `--- your computers ---` (`:733`) immediately followed by
`--- persona management pages ---` (`:735`) with the computers rules actually at `:845`;
`.skip-link` at `:707` and `.skip-link:hover` at `:1866`; `.editor-waiting` at `:1883`, *after*
the mobile `@media` at `:1870`; three dead rules (`.marquee-page` `:411`, `.reader-title` `:1532`,
`.modal-note` `:2484`).

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
- [ ] **E3. Finish the token story.** Eight hard-coded colours remain: `#f3e08c` twice (`:1311`
  snippet-hit, `:1949` `::highlight`) — the *same* marker colour in two places, exactly the drift
  tokens exist to prevent; `rgba(43,38,34,0.35)` twice; `rgba(51,40,20,0.28)` twice; plus the
  scrim and one shadow variant. Add `--marker`, `--scrim`, `--shadow-drop`, `--shadow-punch` and
  D6's comment becomes true again.
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
- [ ] **E5. A dead-class cop in `just ci`.** ~20 lines intersecting `^\.[a-z-]+` in the CSS
  against string literals in the JS, allowlisting the external contracts (`mq-*`, `cm-*`, `ph`).
  It found three dead rules in about two seconds. STYLE.md: "architecture cops are tests, not
  runtime machinery"; `node/tests/conventions.rs` is the precedent.

## Reviewed and left alone (standing decisions, not history)

Re-litigating these costs more than reading this list.

- **Merging `WikiApp` into `DocsApp`** (see B5): the duplication is real but the two honest
  renders are the point. Share the spine as a hook; leave the components apart.
- **The field-report comments** (`lookout.js`, `keepalive.js`, `index.js:70-76`,
  `journal.js:529-531`): long, and load-bearing. D is not a licence to thin these.
- **The stylesheet's absolute size**: proportionate to the JS. E is about seams and namespacing,
  not line count; splitting for its own sake would buy nothing.
- **`htm` + `preact` over JSX**: no build-step transform for templates, and the tagged-template
  form is uniform across every module. Not revisited.
- **XHR for uploads** (A8): `fetch` still has no upload-progress event. The duplication goes; the
  XHR stays.
- **The editor's view mode READS its pref once instead of watching it** (`editor.js`, via
  `readPref`). `prefs.js` now offers a live `usePref` that would also sync the mode across tabs,
  and it was deliberately not used: the mode is a local buffer whose "a click that beats the read
  wins" rule is load-bearing, and two tabs on one document silently re-moding each other is the
  cursor-memory mistake in a different coat. Revisit only if someone actually wants it.

## Suggested working order

1. **D1, D2, D4–D9** and **C3** — one sweep, no behaviour change, and it stops the docs lying
   while we refactor underneath them.
2. **A5** — an actual bug, fixed by extracting the hook.
3. **E1 + E3 + E5** as one commit (mechanical; verifiable by diffing the built bundle
   byte-for-byte), then **E4** on its own.
4. **A6 / B2 / B5** (`docnav.js`, `docsurface.js`, `useDocApp`), then **B1** (`buckets.js`,
   `clock.js` out of `index.js`).
5. **A3**, **A4**, **A7**, **A8**, **B3**, **C1**, **C2**, **B4**.
6. **C4** — vectors for `slugs.js` and `apps.js`.
