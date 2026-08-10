# Ringtome — Refactor Log

The forward-looking ledger of known compromises and queued cleanups. Tech debt is a mortgage
(STYLE.md): taking it on to ship is correct, as long as the balance is recorded here rather than
in anyone's memory. **Completed entries are deleted, not checked off** — git history is the
archive; this file is only ever the current balance.

Judge entries against STYLE.md; when one gets picked up, work it as its own commit-sized fix.

## Open items

### The full-chain audit's remaining items (2026-08-10)

Five done (see HISTORY): `sync::local_frontiers`, `documents::materialize` on the save path,
the ingest path's whole-log rebuild, the unbounded `/entries` response, and `missing_plan`'s
chain enumeration. What is left is the tail, and neither item is urgent:

1. **`imaol::all_entry_bytes`** — whole log into memory for journal backfill at open; fine as
   a one-time recovery path, worth streaming if journals get large.
2. **`imaol::entries_of_type` is a footgun**: no watermark, no bound. Every caller today is an
   identity chain (exempt), but it reads as general-purpose, and the next content-chain caller
   gets a full replay for free. Cheapest fix is a rename or a doc that says "identity chains
   only"; the real one is a bounded variant.