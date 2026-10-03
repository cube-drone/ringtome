# Claude working notes

- **Consult `README.md` before starting** — it is the map: the system's
  load-bearing ideas, the workspace layout, and the role of every document.
- `PROJECT_PLAN.md` is canon but too large to read whole: **grep its headers and
  read only the sections your task touches.**
- For recent status, read **the tail of `HISTORY.md` and the git log**;
  `NEXT_STEPS.md` for what's in motion and the standing residuals.
- Read `STYLE.md` before writing code.
- **Two names** (2026-09-25): **Ringtome** is the protocol and its node - wire
  strings, crates, env vars, signature domains, chains. **Horse Drawing Tycoon
  2** is the consumer application - anything a person installs, opens or reads
  on screen. New user-facing copy says Horse Drawing Tycoon 2; never rename a
  protocol string, and never rename the bundle identifier or a storage key
  (PROJECT_PLAN's _Two names_ says why).
- **New plans go in `plans/`** (2026-09-30): a design document for an app, a
  feature or a delivery shape - the `RSS.md` kind - is written in `plans/` and
  listed in README's _The documents_. The standing documents (README,
  PROJECT_PLAN, NEXT_STEPS, HISTORY, STYLE, GLOSSARY, REFACTOR) stay at the
  root, and so does SERVER.md, which is the operators' manual and ships in the
  server tarball. A link from a plan to anything outside `plans/` starts with
  `../`.
- Do not add history to `NEXT_STEPS.md`: it's only for work that needs to get
  done, history goes in `HISTORY.md`.
- **HISTORY rides the work, unprompted** (2026-08-08): when a piece of work
  wraps — gates green, NEXT_STEPS item struck — append its `HISTORY.md` entry in
  the same pass, don't wait to be asked.
- Do not commit changes directly unless asked to: I would like to look at the
  code and the changes on their way in to the codebase.
- **Green before forward** (2026-08-07, after two broken tests sat red under a
  day of commits and nobody noticed until a stash-and-rerun proved they predated
  the day's work): at the start of a coding session, and again before calling
  any change done, run the cheapest gate that covers what moved —
  `just ui-check` for JS, `cargo test -p ringtome-node` for Rust — and full
  `just ci` before anything lands near sync, storage, or the HTTP surface. A
  suite that is ALREADY red is a finding, not background noise: report it and
  settle it (fix, or Curtis explicitly defers it) before stacking new work on
  top; prove "unrelated to my change" with a clean-tree rerun, never by vibes.
  **`just ci` IS the gate**: `.github/workflows/ci.yml` runs that recipe
  verbatim and nothing else, so green locally is green on the action — there is
  no second bar to reason about, and no "CI will probably be fine". Run it
  freely: since 2026-08-08 it no longer disturbs a running dev network (below).
  To iterate on one acceptance file,
  `RINGTOME_TEST_GREP=<title pattern> just integration` runs only the matching
  claims against the full rig (2026-09-05).
- **Gate by tier** (2026-10-02, when ten-to-twenty-minute waits were slowing
  everything down): while iterating, run the gate that covers what moved —
  `just ui-check` for JS, `cargo test -p ringtome-node` for Rust,
  `RINGTOME_TEST_GREP=<area> just integration` for one acceptance area (match
  every top-level `describe` of the files touched: a grep that catches one claim
  of a file without its setup claims fails for that reason alone). Run full
  `just ci` once per batch — before handing work over for review, and before
  anything lands near sync, storage or the HTTP surface — in the background,
  carrying on with other work rather than waiting; never edit source while it
  runs, or its verdict covers neither version. **A change that is only copy, CSS
  or locale wording** (no Rust, no server behaviour, nothing the integration rig
  can see) needs only `just strings-check` and `just ui-check` - they run
  eslint, every pure test and the CSS conventions (dead classes, colour
  literals), which is everything such a change can break; the full gate is not
  owed for it (Curtis, 2026-10-02). At session start, check `gh run list`: a red
  run on `main` is a finding under the rule above, settled before new work.
- **`just format` before handing off** (2026-10-02): the last step before
  telling Curtis work is ready to commit is `just format` (rustfmt, then
  prettier for JS and Markdown, to the configs at the root), so the diff he
  reads carries the change and nothing else. Never pass a formatter options of
  its own - a `cargo fmt` run before the repo had a config rewrapped ninety-five
  files with rustfmt's defaults. Run it after `just strings`, which rewrites
  call sites, and not while `just ci` is running.
- **`just ci` and `just integration` are safe beside a running dev network**
  (2026-08-08). They used to bind the same ports `just start*` did, so
  integration began by killing every ringtome on the machine — which is why this
  file used to demand a warning first. Now each checkout owns a 32-port band,
  split into lanes that cannot overlap: dev (`base+1..16`), scratch
  (`base+17..19`), integration (`base+21..24`). A playground stays up through a
  full ci run; two checkouts run their own everything at once. **Ask
  `just ports`** — never assume a number, because the band is derived from the
  checkout's path and this repo is no longer on 5281. Override with
  `RINGTOME_PORT_SLOT=<0-63>` if two checkouts ever hash to the same slot.
- **Testing beside a running dev network** (2026-08-05, after a broad pkill
  killed it): throwaway nodes come from `just scratch 1|2|3` (an index into the
  scratch lane, not a port) and die by `just scratch-kill` — PID-file scoped,
  and scoped to this checkout, so it can touch neither `just start*` nor another
  checkout. It also deletes the scratch data; to reboot one onto the data it
  holds, stop it by its PID file and `just scratch N 1`. Never bind a port by
  hand; never pkill by pattern; point the generator at scratch nodes with
  `RINGTOME_TESTDATA_PORTS=<ports>`, the ports `just scratch` printed.
- **The two recipes that are still machine-wide** — warn before running either
  while anything is up, including in another checkout. `just kill` shoots every
  ringtome on the machine; it is a panic button for a wedged box and nothing
  depends on it any more. `just clean` depends on it AND destroys this
  checkout's data directories — personas, keys, chains. Schema changes no longer
  ask for it: they are migration rungs, climbed in place
  (`node/migrations/README.md`).
