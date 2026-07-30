# ringtome

A cozy p2p retro-web social network: IRC-flavored chat, bulletin boards, geocities-style pages,
webrings, hit counters, MIDI files. Identities are cryptographic key trees that roam between
nodes; content lives in signed append-only logs replicated over [iroh](https://iroh.computer/);
trust is modeled explicitly instead of moderated retroactively. Private by default, lightly
federated, unapologetically Old Internet.

> This README is the **map**. The full design — with every decision's reasoning — is
> [`PROJECT_PLAN.md`](PROJECT_PLAN.md), which is canon; if the two disagree, this file is the one
> that's wrong. Don't read the plan cover-to-cover: grep its headers and read the sections you
> need (see *The documents*, below).

## The shape of the system

Seven load-bearing ideas; everything else hangs off one of them. Each pointer names a
PROJECT_PLAN section.

1. **Identity is a tree of keys** (the CROWN): a root keypair authorizes children, children
   authorize grandchildren; authority is ordered by rank-path, never by time. Revocation
   (retirement / repudiation-with-anchors) and a recovery key minted at creation make key loss
   and key theft survivable. → *The CROWN Identity*.
2. **All content is signed append-only chains**, one per `(key, service)` — dense sequence
   numbers, hash links, canonical CBOR, store-the-author's-original-bytes. Merge semantics live
   above the log and are stated once: LWW for scalars, set-merge for collections, rank-path for
   authority. → *The Identity-Managed Append-Only Log (IM-AOL)*, *Canonical Encoding*.
3. **Private by default**: private chains are epoch-key ciphertext, membership is key
   possession, and a revoked device reads its era and nothing after. Anything public is a
   deliberate signing act that *copies* content across the membrane — there is no
   "make public" flip anywhere in the system. → *Private Chains*, *Doctrine* (Copy, Don't Flip).
4. **Databases are disposable views of the log.** Per-identity Turso databases (encrypted at
   rest), incrementally-folded materialized views, and a raw-entry journal file per identity;
   the signed entries are the only source of truth and everything else rebuilds by replay.
   → *Data Layer*, *The Substrate*, *The Store Layer*.
5. **Files are content-addressed blobs; mutable content is versioned documents.** One
   iroh-blobs store for every file-shaped byte (private = encrypt-then-hash, random nonce, no
   dedup by design); a document is a stable `doc_id` whose versions form a DAG of whole-file
   snapshots — divergence is detected and kept-both, never silently merged. Organization
   (tags, trees, annotations) lives *outside* documents. → *The File Layer*, *Versioned
   Documents*, *Taxonomies*, *Annotations*.
6. **Sync is a custom protocol over iroh QUIC** with a validation gate: every entry is checked
   against the key tree before it is stored, which is what makes revocation real (and why
   iroh-docs wasn't usable). Chains can be held as suffixes (git-shallow-clone style);
   discovery is pkarr signed records on the Mainline DHT. → *Iroh Protocol Mapping*,
   *Shallow Sync*, *Discovery*.
7. **Trust is explicit and flow-computed**: signed vouches from real-world invites seed a
   graph; an Advogato-style joint-flow computation prices Sybils out; moderation stays
   node-operator policy, never protocol. → *Trust, Credibility, Interest, and Taste*,
   *Moderation and Operator Liability*.

## Workspace

| path | what |
|---|---|
| `proto/` | **ringtome-proto** — the protocol layer: canonical bytes, signing, chains, the key tree, sync messages, serving records. Pure (no IO); the conformance boundary. See [`proto/README.md`](proto/README.md). |
| `node/` | **ringtome-node** — the connector node: HTTP server, accounts, storage, iroh sync, discovery, ingest, and the embedded Preact UI (`node/js`, `node/html`, baked into the binary). The one binary. See [`node/README.md`](node/README.md). |
| `node/integration/` | The JS integration suite: boots real nodes, drives real HTTP, proves multi-node scenarios (`just integration`). |
| `spec/` | Test vectors ("this logical value MUST produce exactly these bytes"). Prose specs land here too, eventually. |
| `video-ingest/` | Spike (kept deliberately): browser-side video normalization to safe intermediary formats — the reference implementation and input contract for the upload UI. See its README. |
| `sample_media/` | Fixture media for exercising the ingest pipeline. |
| `api_old/` | The previous-generation codebase. Reference only; see the autopsy ([`API_OLD.md`](API_OLD.md)). |

(`data/` and `scratch/` are runtime output from local test runs, not source.)

## Quickstart

```sh
cd node && just start       # server + UI watchers in one terminal (Ctrl-C stops everything)
```

Other useful commands (from `node/`, unless cargo):

```sh
cargo build                 # everything
cargo test                  # all Rust tests (proto is the fast loop: cargo test -p ringtome-proto)
just integration            # boot two throwaway nodes, run the full JS integration suite
just ci                     # check + lint + unit + integration — what the GitHub action runs
just mainline-smoke         # OPT-IN live test against the real Mainline DHT (publishes throwaway records)
cargo run --bin ringtome    # run a node (see node/README.md for configuration)
./target/debug/ringtome inspect <hex>   # pretty-print any signed entry
```

## Where things stand (as of 2026-07-22)

The sequential ladder is complete — signed canonical entries, the key tree, two-node sync behind
the validation gate, discovery (pkarr/mainline, field-tested against the real DHT), private
chains, the typed store layer, the file layer, versioned documents with divergence handling, the
media ingest pipeline, the Turso substrate with journal + persisted materialized views, the
embedded UI, and background sync with eager push. Current work is Tier 4's client/notes lane
(annotations shipped; taxonomies next). The authoritative version of this paragraph is
[`NEXT_STEPS.md`](NEXT_STEPS.md) ("Where we are") — if the date above looks old, trust that file.

## The documents

- [`PROJECT_PLAN.md`](PROJECT_PLAN.md) — the doctrine: architecture, identity model, trust model,
  threat model, every load-bearing design decision with its reasoning. Edited in place; always
  current. **Too big to read whole — that's accepted**: grep the `##`/`###` headers, read the
  sections your task touches, and follow its cross-references by header name.
- [`NEXT_STEPS.md`](NEXT_STEPS.md) — the trajectory: where the ladder stands, the standing
  residuals, and the unordered tiers ahead. Forward-looking only.
- [`HISTORY.md`](HISTORY.md) — the delivery log: what shipped when, with status notes and
  residuals as recorded at the time. New work appends at the bottom in full detail; when the tail
  grows unwieldy it is folded into the era narrative above it (last compressed 2026-07-29, with the
  per-unit originals left in git). Read the tail for recent status.
- [`NOTES_APP.md`](NOTES_APP.md) — the first application spec: multi-device encrypted notes on
  the private store (mutable documents on an immutable spine; git-for-notes divergence handling).
  Also the discovery narrative for the file layer, versioned documents, and taxonomies — the
  canonical statements graduated to PROJECT_PLAN's Data Layer.
- [`GLOSSARY.md`](GLOSSARY.md) — the vocabulary: protocol terms, plus the engine-room ↔ cozy-UI
  language mapping.
- [`STYLE.md`](STYLE.md) — the house style: naming, comments, module shape, testing doctrine, and
  the pragmatism rules; the patterns every new file is expected to hold.
- [`REFACTOR.md`](REFACTOR.md) — the ledger: known compromises and queued cleanups (tech debt is
  a mortgage; this is the current balance). Completed entries are deleted — git is the archive.
  [`REFACTOR_UI.md`](REFACTOR_UI.md) is the same ledger for the embedded UI (`node/js`).
- [`API_OLD.md`](API_OLD.md) — salvage report on the prior codebase: patterns kept, patterns cut,
  cautionary tales.

**Suggested first hour:** this file top to bottom; PROJECT_PLAN's *Vision* and *Doctrine*
sections; GLOSSARY skimmed for unfamiliar terms; then NEXT_STEPS to see what's in motion.
