# ringtome

A cozy p2p retro-web social network: IRC-flavored chat, bulletin boards, geocities-style pages,
webrings, hit counters, MIDI files. Identities are cryptographic key trees that roam between
nodes; content lives in signed append-only logs replicated over [iroh](https://iroh.computer/);
trust is modeled explicitly instead of moderated retroactively. Private by default, lightly
federated, unapologetically Old Internet.

## Workspace

| path | what |
|---|---|
| `proto/` | **ringtome-proto** — the protocol layer: canonical bytes, signing, chains, the key tree, sync messages, serving records. Pure (no IO); the conformance boundary. See [`proto/README.md`](proto/README.md). |
| `node/` | **ringtome-node** — the connector node: HTTP server, accounts, storage, iroh sync, discovery. The one binary. See [`node/README.md`](node/README.md). |
| `spec/` | Test vectors ("this logical value MUST produce exactly these bytes"). Prose specs land here too, eventually. |
| `api_old/` | The previous-generation codebase. Reference only; see the autopsy. |

## Quickstart

```sh
cargo build                 # everything
cargo test                  # all Rust tests (proto is the fast loop: cargo test -p ringtome-proto)
cd node && just integration # boot two throwaway nodes, run the full JS integration suite
cargo run --bin ringtome    # run a node (see node/README.md for configuration)
./target/debug/ringtome inspect <hex>   # pretty-print any signed entry
```

## The documents

- [`PROJECT_PLAN.md`](PROJECT_PLAN.md) — the doctrine: architecture, identity model, trust model,
  threat model, every load-bearing design decision with its reasoning. Edited in place; always
  current.
- [`NEXT_STEPS.md`](NEXT_STEPS.md) — the trajectory: where the ladder stands, the standing
  residuals, and the unordered tiers ahead. Forward-looking only.
- [`HISTORY.md`](HISTORY.md) — the delivery log: what shipped when, with status notes and
  residuals as recorded at the time. Append-only; the past holds still.
- [`NOTES_APP.md`](NOTES_APP.md) — the first application spec: multi-device encrypted notes on
  the private store (mutable documents on an immutable spine; git-for-notes divergence handling).
- [`GLOSSARY.md`](GLOSSARY.md) — the vocabulary: protocol terms, plus the engine-room ↔ cozy-UI
  language mapping.
- [`STYLE.md`](STYLE.md) — the house style: naming, comments, module shape, testing doctrine, and
  the pragmatism rules; the patterns every new file is expected to hold.
- [`REFACTOR.md`](REFACTOR.md) — the ledger: known compromises and queued cleanups (tech debt is
  a mortgage; this is the current balance). Completed entries are deleted — git is the archive.
- [`API_OLD.md`](API_OLD.md) — salvage report on the prior codebase: patterns kept, patterns cut,
  cautionary tales.
