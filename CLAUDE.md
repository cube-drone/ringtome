# Claude working notes

- **Consult `README.md` before starting** — it is the map: the system's load-bearing ideas,
  the workspace layout, and the role of every document.
- `PROJECT_PLAN.md` is canon but too large to read whole: **grep its headers and read only the
  sections your task touches.**
- For recent status, read **the tail of `HISTORY.md` and the git log**; `NEXT_STEPS.md` for
  what's in motion and the standing residuals.
- Read `STYLE.md` before writing code.
- Do not add history to `NEXT_STEPS.md`: it's only for work that needs to get done, history goes in `HISTORY.md`.
- **HISTORY rides the work, unprompted** (2026-08-08): when a piece of work wraps — gates
  green, NEXT_STEPS item struck — append its `HISTORY.md` entry in the same pass, don't wait
  to be asked.
- Do not commit changes directly unless asked to: I would like to look at the code and the changes on their way in to the codebase.
- **Green before forward** (2026-08-07, after two broken tests sat red under a day of commits
  and nobody noticed until a stash-and-rerun proved they predated the day's work): at the
  start of a coding session, and again before calling any change done, run the cheapest gate
  that covers what moved — `just ui-check` for JS, `cargo test -p ringtome-node` for Rust —
  and full `just ci` before anything lands near sync, storage, or the HTTP surface. A suite
  that is ALREADY red is a finding, not background noise: report it and settle it (fix, or
  Curtis explicitly defers it) before stacking new work on top; prove "unrelated to my
  change" with a clean-tree rerun, never by vibes. Mind the dev-network rule below before
  running `just integration`.
- **Testing beside a running dev network** (2026-08-05, after a broad pkill killed it):
  throwaway nodes come from `just scratch [5297-5299]` and die by `just scratch-kill` — PID-file
  scoped, structurally unable to touch `just start*`'s ports or processes. Never bind 5281-5296
  for testing; never pkill by pattern; point the generator at scratch nodes with
  `RINGTOME_TESTDATA_PORTS=5298,5299`. `just kill` (and `just integration`, which depends on it)
  is machine-wide BY DESIGN — warn before running either while the dev network is up.
