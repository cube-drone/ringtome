# Ringtome — Style

* If we've taken on tech debt, record it in [REFACTOR.md](./REFACTOR.md).
* Write all code defensively under the assumption that _context will disappear rapidly_: Curtis is forgetful
    and LLMs don't maintain it at all.

## Names

- **Blunt, descriptive, useful. No clever names.** A module that parses pubkeys is `pubkey`; a
  clock is `clock`; the keystore is `keystore`. If a name needs a decoder ring or a backstory, it
  is wrong.
  - (Humor is welcome — in test data, fixtures, comments, and commit messages, not in the code itself)
- **Words are free.** Reading is more expensive than writing, forever. `epoch_entry` beats `ke`;
  `recovery_seed` beats `rs`. Tolerated shorthand: `i`/`j` in loops, `x` in lambdas, and
  pervasive tightly-local idiom (`w`/`r` in the CBOR codec, `e` for an entry in a loop over
  entries). Two-letter abbreviations for domain types are not in the tolerated set.
- **Never assemble a name at runtime.** `chip-${tone}`, `format!("{}_id", table)` - a name built
  from fragments is invisible to grep, to a reader, and to every architecture cop, which is how a
  check quietly stops guarding the thing it was written for. Spell the whole name at every use
  site; the repetition is the searchability.
- **Name the tuple.** A function returning `(SqlitePool, SigningKey, EpochKeys)` should return a
  struct whose field names document it (`PrivateStore`). Interfaces are documentation.
- Shared vocabulary gets written down ( [GLOSSARY.md](./GLOSSARY.md)). Words
  cost nothing and drift costs plenty.

## Comments

- **Comments carry context, not narration.** The module doc argues *why this design*; a function
  doc states the contract and its non-obvious constraints; nothing restates what the next line
  does. If a comment explains a decision, cite the source (PROJECT_PLAN section, API_OLD lesson).
- **Context rots; scars do not.** A comment recording a decision and its evidence ("field-found
  2026-07-25 pasting a ~600KB document, which never saved") stays true forever and is worth
  paragraphs. A comment recording *where the build was* ("v0", "phase two adds…", "comes later")
  is false within the month and lies to whoever trusts it next. Write the first kind; when you
  catch the second, it is not tidying, it is a fix.
- **A stale context comment is a bug.** These comments are load-bearing, so they are maintained
  like code: a change that falsifies a header updates the header in the same pass.
- Config structs use the commented-field style (every field: inline purpose + default). It is the
  one place per-line commentary is the point.
- **Citation Needed**. Example: "Will add full encryption when we get to Part 3" -
  what is Part 3? That may be something we're talking about in the current conversation but
  if the context doesn't live with the code, it will be lost.
  If we can, link this to a document explaining what Part 3 is - if no such document
  can be found, consider rewriting without "Part 3" and simply writing in more detail locally,
  or creating the document where whatever rollout plan was discussed lives now.

## Modules and composition

- **Many small, loosely-coupled systems, composed in `main.rs`.** Main is the composition root:
  it wires modules together and starts loops; it implements nothing. Modules take what they need
  as plain arguments (usually `&AppState` pieces).
- **No event buses, no service registries, no two-phase init.** If module A needs module B, call
  B's function — it was always one `await` away (API_OLD, Cut #1–2). Security-relevant effects
  happen synchronously inside the action, never as a hoped-for echo.
- **Flat modules; a directory only when one concept outgrows one file** - `net.rs` beside
  `net/{sync,discovery,…}.rs`, `apps.js` beside `apps/{notes,journal}.js`. The sibling keeps its
  name, so a module's home stays where the reader already looked. Layered directories
  (`data/`, `view/`) and per-feature slices are both refused: this codebase's layers are its
  dependency graph, which is readable from the imports, and its features are not independent.
- **A table has one owner.** Raw SQL naming a table lives only in that table's module; everyone
  else calls its functions. Enforced by `node/tests/conventions.rs` — architecture cops are
  tests, not runtime machinery.
- **`module.rs` holds the logic; `module/routes.rs` holds thin handlers** (parse, gate, call,
  shape the response). 800-line handlers were an api_old disease; don't reinfect.
- The proto/node crate split is a compiler-enforced firewall: `ringtome-proto` is the conformance
  boundary — values in, `Result` out, no async/storage/clocks — and the node is one consumer.

## File ordering

- Important concepts live high in the file; the reader should meet the module's main idea first.
- The same arc every time: module doc → constants → types → private helpers → **creation →
  modification → view/queries** → tests at the bottom, mirroring that order. Self-similarity
  between files is the feature: knowing one module's shape means knowing them all.

## Boundaries

- **Explain and design at the boundary: inputs, outputs, signatures.** Types encode requirements
  so misuse fails at compile time — auth as extractor types (a handler's signature *is* its
  authorization), internal vs. API-facing structs (password hashes cannot leak through a typed
  boundary), typed `AppError` variants choosing HTTP statuses (never sniff error strings).
- Wire formats encode *value domains* (a timestamp is "a CBOR uint ≤ i64::MAX"); host types are
  chosen for cast-free arithmetic and storage. One unit per concept system-wide (time is `i64`
  milliseconds, everywhere).
- Errors: typed `AppError` at the HTTP boundary, `anyhow` + `.context()` in leaf modules, every
  fallible call annotated. Internal detail is logged, never sent to the client.
- **One question, one database** (added 2026-08-05, after the contacts join shipped the
  violation and ran unnoticed): opening a user database is a per-file act - decryption,
  migration check, journal validation. A loop over personas that calls `user_dbs.get` per item
  is the fan-in thrash the Data Layer warns about, and it will pass every test, because thrash
  is slow, not wrong. Cross-persona questions read a **node-level memo** written at fold time
  (`persona_frontiers`, `subscriptions`, `persona_profiles`, `feed_journal`); the conventions
  test pins every `get` call site so a new one is a deliberate act.

## Testing

- **Code that is not tested is assumed not to work.** A feature exists when its test passes, not
  when it compiles. Working, demonstrable software over spec.
- **Integration tests against the real thing are the default.** Real HTTP, real iroh streams,
  real SQLite files, two real node processes. **No database mocks** — the queries are where the
  risk lives, so the tests run the actual queries against actual data (the local-test SQL
  passthrough and throwaway nodes exist to make this cheap).
- **Unit tests are reserved for isolated boundaries and pure logic:** codecs, chain validation,
  key-tree resolution, LWW folds, crypto round-trips.
- **Logic that can be a value-in, value-out function belongs in a file that is one** - gathered
  where it can be interrogated without a node, a browser, or a fixture (`ringtome-proto`;
  `node/js/pure/`). Extract freely when the logic is a *decision over values the caller already
  holds* - ordering, matching, formatting, arithmetic, predicates. **The tell that you have gone
  too far: extracting it requires a new parameter that is a callback.** At that point the logic
  IS the effect sequence - what to write first so a failure leaves a duplicate rather than a
  loss, what to await, what invalidates what - and a "pure" version of it only tests your mocks.
  Those belong to the integration suite and its real nodes.
- **Prefer an invariant to an example where one exists.** The pure corners are where property
  tests and fuzz targets attach, and a round trip is the cheapest invariant going: generate a
  document's derived address, resolve it, and you must land back on that document. That test
  found a link that silently opened the wrong page; no example-based case would have thought to.
- **A cop that cannot fail is decoration.** After writing one, plant the violation and watch it
  go red. Architecture cops are tests, not runtime machinery - but an untested test is just a
  comment with a runtime cost.
- **Published test vectors are the conformance boundary**: exact bytes, hash, signature, grown
  with every wire format. They are what makes a second implementation possible and regression a
  tripwire.
- **No automated UI testing.** Selenium-class suites are brittle and end up ignored. The
  integration suite drives the API; humans drive the UI.
  - encourage UI-based flows to lean even more heavily into "pure" testing.
  - (edit: this is a rule derived from human-based workflows, Curtis is increasingly
    concerned that this may be tying his poor LLM's hands, especially given they struggle
    to interact directly with the UI)
- Test mode can tune work factors (minimal Argon2 params, for example) to speed up CI.
- **The lint gate covers test code too** (added 2026-08-08, on finding sixteen lint failures
  aged quietly in test modules): `just lint` is `cargo clippy --all-targets -- -D warnings`,
  so the code that PROVES the system is held to the bar the system is. Warnings-as-errors on
  production code beside an unlinted test suite is a seam, and the tests are exactly where
  quick-and-dirty accretes.
- **A lint that is wrong for one case earns an inline `#[allow]` with its reason; never a
  loosened gate.** An allow with a stated reason is a decision on the record - the next
  reader learns why - while an ungated lint is a silence nobody can date or argue with. The
  bar is that the lint is wrong HERE, not that obeying it is inconvenient: `documents.rs`'s
  `save`/`save_fmt` take the `Save` struct's fields positionally because being a terse
  shorthand for a struct literal is the whole job of those helpers at ~40 call sites, so the
  arity lint is measuring the wrong thing. "This would take a refactor" is not that.

## Abstraction and pragmatism

- **Build the specific, concrete product. No inner platforms.** No generalized frameworks for
  *imagined* futures; do the first thing that works and keep it shippable. Boilerplate is fine —
  often good, because it signposts a clear modular structure; four similar-but-honest decode
  functions beat one parameterized decode engine.
- **YAGNI applies to speculation, not to the plan.** With the build plan in hand (NEXT_STEPS is
  one), laying an abstraction slightly ahead of its consumers is thinking ahead, not sinning —
  the store layer may precede the features that will land on it. The test is **nameability**:
  every capability the abstraction carries must name a planned consumer (a tier, a track, a
  ledger item), never "someone might want." Shape it against its first real consumer; add
  breadth when the second one actually arrives.
- The other earned exception: **abstraction that makes a required check structural rather than
  disciplinary** (the COSE-style envelope that makes re-serialization impossible; a map reader
  that makes canonicality unforgettable). Security invariants may buy machinery; convenience may
  not.
- **Until User 1, there is no install base — and no ceremony for one.** Before anything ships,
  there is no data to lose and nobody to migrate: breaking changes are always on the table,
  schema changes squash into `0001` (rebuild, never migrate-in-place), file formats may churn,
  and safe-update machinery — migration paths, compat shims, upgrade gates — is deferred until
  an install base exists to be safe *for*. Any invariant whose justification quietly assumes
  active users ("upgrades must round-trip", "we can't change that column") should be challenged
  on sight. Two things this rule does **not** license: sloppy *design* of formats (they are
  still designed to last, because ship day freezes them — the wire format gets test vectors
  precisely so it can survive its own success), and forgetting that **ship day flips this rule
  permanently** — the same discipline that squashes migrations today writes them forever after.
- **The second copy is the finding.** Every deduplication worth doing in this codebase announced
  itself the same way: the same code written twice, the copies drifting, and *one of them missing
  a clause* - a reader that never retried a pending body, a filter silently lacking its
  catch-all, three fetch wrappers disagreeing about whether an error carries its status. The bug
  lives in the drift, not the repetition, which is why "I am writing this a second time" is the
  moment to stop rather than a tidying task for later.
- **But measure before you consolidate: a shared thing its consumers must undo is a wrong
  average.** Seven near-identical buttons turned out to disagree on colour, opacity and hover -
  five of seven would have had to cancel part of any primitive covering them, and what was
  genuinely shared came to three lines of boilerplate. Compare the *effective* behaviour of the
  copies, not their shape. Honest boilerplate beats a wrong abstraction; this is the nameability
  test's other half.
- **Prove a behaviour-preserving change by comparing output, not by reading it.** A mechanical
  refactor - splitting a stylesheet, renaming across files, moving rules between modules - gets
  verified by diffing what it builds: the bundle byte-for-byte, or the effective declarations of
  every selector before and after. That is what makes a 47-line rename safe to do without eyes
  on the result, and it is the difference between "should be identical" and "is".
- **Tech debt is a mortgage**: taking it on to ship is correct and normal, as long as the balance
  is recorded and serviced. REFACTOR.md is the mortgage statement — known compromises live there
  with reasons, not in anyone's memory. Purity is not a goal; *managed* imperfection is.
- **Good-enough speed.** Fast enough not to annoy a human (~100–500ms for interactions) is fast
  enough. Architecture may be chosen for model fit (per-identity DB files, recompute-on-read
  views); functions are not optimized below the annoyance threshold without a measurement.
- **There's a Widget for that.** Examples include "Person" and the document-editor: we like to build
  complex display objects that can own rendering for a wide variety of shapes of a concept.

## Working on it together

- **Expand, don't replace.** The LLM's job includes explaining errors, summarizing the complex
  parts, and reasoning through problems out loud — so Curtis can meaningfully hold and contribute
  to code he didn't type. A change nobody can explain is a regression even if the tests pass.
- Plans and docs move in the same commit as the code that changes them (NEXT_STEPS status,
  PROJECT_PLAN sections, this file). The documents are load-bearing; see Comments.
- Preserve the humor you find. Nobody is required to generate any.

