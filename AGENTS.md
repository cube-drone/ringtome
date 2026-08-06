# AGENTS.md

Working notes for coding agents. This repo's docs are load-bearing and maintained like code:
when a change falsifies a doc or a module-header comment, update it in the same change (a stale
context comment counts as a bug here).

## Read first

- `README.md` is the map (system shape, workspace layout, role of every document). Read
  `STYLE.md` before writing code.
- `PROJECT_PLAN.md` is canon but deliberately too big to read whole: grep its `##`/`###`
  headers, read only the sections your task touches.
- Recent status: tail of `HISTORY.md` + `git log`. What's in motion and the standing residuals:
  `NEXT_STEPS.md`.
- `NEXT_STEPS.md` is forward-looking only — finished work leaves it, history goes in
  `HISTORY.md`. Never add history to it.
- Do not commit or push unless explicitly asked — the user reviews changes on the way in.

## Verify your work

Run `just` recipes from `node/`; cargo from the repo root. The full local gate is `just ci`
(ui-check → check → clippy `-D warnings` → unit tests → integration), and the GitHub action runs
exactly that — run it, or the relevant prefix, before declaring done.

- **`just ui-check` comes first, always.** `src/ui.rs` embeds the JS/CSS bundles via
  `include_str!` and `node/js/target/` is gitignored: on a fresh clone nothing Rust compiles
  before this runs, and on an old one a stale bundle compiles silently.
- Fast loops: `cargo test -p ringtome-proto` (seconds, no tokio/turso build); single Rust test
  `cargo test -p ringtome-node <name>`; the UI's pure-module tests run in ~2s inside
  `just ui-check` and need no node, no browser.
- One integration file: after `just integration-install`, boot nodes, then in
  `node/integration` run `npx mocha --no-config test/<file>.cjs`. **`--no-config` is
  mandatory** — `.mocharc.json`'s spec glob *merges* with CLI args instead of yielding, so
  without it you run the whole suite against nodes nobody booted.
- Toolchain: Rust 1.96 (workspace `rust-version`), Node 18+ (harness needs global fetch; CI
  uses 22). Justfiles run under bash and stay portable — the repo is also developed under Git
  Bash on Windows.
- `RINGTOME_BLESS=1 cargo test -p ringtome-proto --test vectors` regenerates the protocol test
  vectors — a protocol-breaking act, never routine.
- Debugging a signed entry: `./target/debug/ringtome inspect <hex|file>` decodes + verifies it.

## Live-process safety (hard rules; born from the 2026-08-05 incident)

- Ports 5281–5283 belong to the dev network (`just start`, `start-two`, `start-three`). Never
  bind them for testing.
- Never `pkill` by pattern. `just kill` is machine-wide **by design**, and `just integration`
  depends on it — warn the user before running either while a dev network may be up.
- Agent/harness testing uses scratch nodes: `just scratch [5297-5299]` boots a throwaway node
  in `/tmp` and waits for health; `just scratch-kill` removes them by PID file and structurally
  cannot touch the dev network.
- Point the fake-network generator at scratch nodes:
  `RINGTOME_TESTDATA_PORTS=5298,5299 just test-data` — its default ports are the dev network's.
- `just clean` destroys every dev database and key (accounts, personas, chains) — it is the
  schema-generation-bump wipe, not a build clean. Confirm before running.
- `just mainline-smoke` talks to the real public DHT and publishes throwaway records including
  this machine's public IP — opt-in only, never part of `just ci`, never run unprompted.
- `RINGTOME_LOCAL_TEST=1` arms raw-SQL-over-HTTP, weak Argon2, and no rate limits. Test nodes
  only; never on a reachable node.

## Architecture rules the tests enforce

- `proto/` (ringtome-proto) is pure: no IO, async, clocks, or storage — values in, `Result`
  out; the dependency list is the enforcement. Byte-exact vectors in `spec/test-vectors/` are
  the conformance spec.
- `node/` is the one binary (`ringtome`); `src/main.rs` is the composition root and implements
  nothing. Flat modules: `x.rs` gains a sibling `x/` directory only when one concept outgrows
  one file.
- **Table ownership**: raw SQL naming a table lives only in that table's owner module.
  `node/tests/conventions.rs` is the cop (a grep test) with a hardcoded `owners()` map — a new
  table fails the build until its owner is listed there. `entries` rows appear only via
  `imaol::append` (local authorship) or the sync gate (validated arrival).
- **One question, one database**: never loop `user_dbs.get` across personas. Cross-persona
  reads use node-level memo tables written at fold time (`persona_frontiers`, `subscriptions`,
  `feed_journal`, `persona_profiles`); the conventions test pins the call sites.
- UI (`node/js`, Preact + esbuild, no tsc): `index.js` is the composition root, `net.js` is the
  only fetch caller, no barrel files. `js/pure/` is values-in/values-out only (no browser APIs,
  no imports from outside `pure/`) and mirrors `integration/test/pure/` file-for-file — a pure
  module exists when its test file exists; the glob picks it up. `test/pure/conventions.cjs`
  also enforces: acyclic imports, no app importing another app, no dead CSS, no color literals
  outside `tokens.css`.
- **No automated UI testing** is doctrine. Instead, `node/harness/*.mjs` probes boot the real
  bundle in jsdom against a scratch node (e.g. `just scratch 5299`, then
  `node harness/feed-probe.mjs`) — use them to verify UI behavior changes end to end.
- Pre-launch data policy: schema changes squash into migration `0001` and dev data is deleted
  (`just clean`); no in-place migrations or compat shims until an install base exists. Wire
  formats are still designed to last and get test vectors.

`STYLE.md` holds the rest of the house style (naming, comments, module shape, testing doctrine)
and is expected of every new file; the bullets above are the parts that fail the build.
