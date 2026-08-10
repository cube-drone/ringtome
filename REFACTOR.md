# Ringtome — Refactor Log

The forward-looking ledger of known compromises and queued cleanups. Tech debt is a mortgage
(STYLE.md): taking it on to ship is correct, as long as the balance is recorded here rather than
in anyone's memory. **Completed entries are deleted, not checked off** — git history is the
archive; this file is only ever the current balance.

Judge entries against STYLE.md; when one gets picked up, work it as its own commit-sized fix.

## Open items

### The full-chain audit's remaining items (2026-08-10)

`sync::local_frontiers` is done (see HISTORY). The rest of the audit, in the order I would
take them:

1. **`documents::materialize` on the save path.** Reads every row of `doc_versions` — one per
   doc-header entry ever written, across all documents — and threads every document's DAG in
   memory, on `save_version` and `retitle`. Every save re-materializes your whole edit
   history. Needs design thought, not a swap: the callers want a *document's* DAG, and
   `doc_heads` memoizes only the resolved head.
2. **`imaol::rebuild_views` is reachable from ingest** (`sync::ingest_batch`, when eviction
   happened) — a peer can trigger a whole-log replay, decoded and re-validated, into memory.
3. **`imaol::list_entries` is an unbounded HTTP response** (`/api/identity/{root}/entries`) —
   wants the keyset paging `entries_page` already has.
4. **`sync::missing_plan`'s `SELECT DISTINCT author_pubkey, service FROM entries`** — full
   scan per sync exchange, answering a question `chain_heads` also holds.
5. **`imaol::all_entry_bytes`** — whole log into memory for journal backfill at open; fine as
   a one-time recovery path, worth streaming if journals get large.
6. **`imaol::entries_of_type` is a footgun**: no watermark, no bound. Every caller today is an
   identity chain (exempt), but it reads as general-purpose, and the next content-chain caller
   gets a full replay for free.