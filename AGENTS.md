# Agent working notes

- **Consult `README.md` before starting** — it is the map: the system's load-bearing ideas,
  the workspace layout, and the role of every document.
- `PROJECT_PLAN.md` is canon but too large to read whole: **grep its headers and read only the
  sections your task touches.**
- For recent status, read **the tail of `HISTORY.md` and the git log**; `NEXT_STEPS.md` for
  what's in motion and the standing residuals.
- Read `STYLE.md` before writing code. Update `HISTORY.md` after writing code.
- Do not add history to `NEXT_STEPS.md`: it's only for work that needs to get done, history goes in `HISTORY.md`.
- Do not commit changes directly unless asked to: I would like to look at the code and the changes on their way in to the codebase.
- **`just ci` and `just integration` are safe beside a running dev network** (2026-08-08).
  Each checkout owns a 32-port band split into lanes that cannot overlap: dev (`base+1..16`),
  scratch (`base+17..19`), integration (`base+21..24`). A playground stays up through a full ci
  run; two checkouts run their own everything at once. **Ask `just ports`** — never assume a
  number, because the band is derived from the checkout's path and this repo is no longer on
  5281. Override with `RINGTOME_PORT_SLOT=<0-63>` if two checkouts hash to the same slot.
- **Testing beside a running dev network** (2026-08-05, after a broad pkill killed it):
  throwaway nodes come from `just scratch 1|2|3` (an index into the scratch lane, not a port)
  and die by `just scratch-kill` — PID-file scoped, and scoped to this checkout, so it can touch
  neither `just start*` nor another checkout. Never bind a port by hand; never pkill by pattern;
  point the generator at scratch nodes with `RINGTOME_TESTDATA_PORTS=<the ports `just scratch`
  printed>`.
- **The two recipes that are still machine-wide** — warn before running either while anything is
  up, including in another checkout. `just kill` shoots every ringtome on the machine; it is a
  panic button and nothing depends on it any more. `just clean` depends on it AND destroys this
  checkout's data directories — personas, keys, chains.