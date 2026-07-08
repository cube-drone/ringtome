# Ringtome — Style

The patterns we hold across the whole codebase. Sibling documents: API_OLD.md is the *why*
(autopsy of the last system), REFACTOR.md is the ledger of known violations, PROJECT_PLAN.md is
what we're building. This one is *how we write it* — and the acceptance test for everything below
is the same: **the codebase must remain holdable by a human who did not write most of it.** Code
is written under the assumption that its author (robot or Curtis) will forget how it works within
weeks; every rule here is a defense against that prison of context.

## Names

- **Blunt, descriptive, useful. No clever names.** A module that parses pubkeys is `pubkey`; a
  clock is `clock`; the keystore is `keystore`. If a name needs a decoder ring or a backstory, it
  is wrong. (Humor is welcome — in test data, fixtures, and commit messages, where `EVIL TWIN`
  and `hotdog-stand` live — never in the names code must be read through.)
- **Words are free.** Reading is more expensive than writing, forever. `epoch_entry` beats `ke`;
  `recovery_seed` beats `rs`. Tolerated shorthand: `i`/`j` in loops, `x` in lambdas, and
  pervasive tightly-local idiom (`w`/`r` in the CBOR codec, `e` for an entry in a loop over
  entries). Two-letter abbreviations for domain types are not in the tolerated set.
- **Name the tuple.** A function returning `(SqlitePool, SigningKey, EpochKeys)` should return a
  struct whose field names document it (`PrivateStore`). Interfaces are documentation.
- Shared vocabulary gets written down (api_old's `nomenclature.md`; here, GLOSSARY.md). Words
  cost nothing and drift costs plenty.

## Comments

- **Comments carry context, not narration.** The module doc argues *why this design*; a function
  doc states the contract and its non-obvious constraints; nothing restates what the next line
  does. If a comment explains a decision, cite the source (PROJECT_PLAN section, API_OLD lesson).
- **A stale context comment is a bug.** These comments are load-bearing, so they are maintained
  like code: a change that falsifies a header updates the header in the same pass.
- Config structs use the commented-field style (every field: inline purpose + default). It is the
  one place per-line commentary is the point.

## Modules and composition

- **Many small, loosely-coupled systems, composed in `main.rs`.** Main is the composition root:
  it wires modules together and starts loops; it implements nothing. Modules take what they need
  as plain arguments (usually `&AppState` pieces).
- **No event buses, no service registries, no two-phase init.** If module A needs module B, call
  B's function — it was always one `await` away (API_OLD, Cut #1–2). Security-relevant effects
  happen synchronously inside the action, never as a hoped-for echo.
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

## Testing

- **Code that is not tested is assumed not to work.** A feature exists when its test passes, not
  when it compiles. Working, demonstrable software over spec.
- **Integration tests against the real thing are the default.** Real HTTP, real iroh streams,
  real SQLite files, two real node processes. **No database mocks** — the queries are where the
  risk lives, so the tests run the actual queries against actual data (the local-test SQL
  passthrough and throwaway nodes exist to make this cheap).
- **Unit tests are reserved for isolated boundaries and pure logic:** codecs, chain validation,
  key-tree resolution, LWW folds, crypto round-trips — the proto crate and the node's pure
  corners. That's also where the hard tests (property tests, fuzz targets) attach.
- **Published test vectors are the conformance boundary**: exact bytes, hash, signature, grown
  with every wire format. They are what makes a second implementation possible and regression a
  tripwire.
- **No automated UI testing.** Selenium-class suites are brittle and end up ignored. The
  integration suite drives the API; humans drive the UI.
- Test mode tunes work factors (minimal Argon2 params), it never forks a security code path
  (api_old's dev-plaintext-passwords lesson). Enforcement paths run in development.

## Abstraction and pragmatism

- **Build the specific, concrete product. No inner platforms.** No generalized frameworks for
  theoretical futures; do the first thing that works and keep it shippable. Boilerplate is fine —
  often good, because it signposts a clear modular structure; four similar-but-honest decode
  functions beat one parameterized decode engine.
- The one earned exception: **abstraction that makes a required check structural rather than
  disciplinary** (the COSE-style envelope that makes re-serialization impossible; a map reader
  that makes canonicality unforgettable). Security invariants may buy machinery; convenience may
  not.
- **Tech debt is a mortgage**: taking it on to ship is correct and normal, as long as the balance
  is recorded and serviced. REFACTOR.md is the mortgage statement — known compromises live there
  with reasons, not in anyone's memory. Purity is not a goal; *managed* imperfection is.
- **Good-enough speed.** Fast enough not to annoy a human (~100–500ms for interactions) is fast
  enough. Architecture may be chosen for model fit (per-identity DB files, recompute-on-read
  views); functions are not optimized below the annoyance threshold without a measurement.

## Working on it together

- **Expand, don't replace.** The robot's job includes explaining errors, summarizing the complex
  parts, and reasoning through problems out loud — so Curtis can meaningfully hold and contribute
  to code he didn't type. A change nobody can explain is a regression even if the tests pass.
- Plans and docs move in the same commit as the code that changes them (NEXT_STEPS status,
  PROJECT_PLAN sections, this file). The documents are load-bearing; see Comments.
- Preserve the humor you find. Nobody is required to generate any.
