# Ringtome — Refactor Log

The forward-looking ledger of known compromises and queued cleanups. Tech debt is a mortgage
(STYLE.md): taking it on to ship is correct, as long as the balance is recorded here rather than
in anyone's memory. **Completed entries are deleted, not checked off** — git history is the
archive; this file is only ever the current balance.

Judge entries against STYLE.md; when one gets picked up, work it as its own commit-sized fix.

## Open items

### The full-chain audit's remaining items (2026-08-10)

Four done (see HISTORY): `sync::local_frontiers`, `documents::materialize` on the save path,
the ingest path's whole-log rebuild, and the unbounded `/entries` response. The rest, in the
order I would take them:

1. **`sync::missing_plan`'s `SELECT DISTINCT author_pubkey, service FROM entries`** — full
   scan per sync exchange, answering a question `chain_heads` also holds. The obvious swap,
   but note the gate reads `entries` for a reason elsewhere in that function; do it with the
   same "memo lags, never leads" argument `local_frontiers` now carries.
2. **`imaol::all_entry_bytes`** — whole log into memory for journal backfill at open; fine as
   a one-time recovery path, worth streaming if journals get large.
3. **`imaol::entries_of_type` is a footgun**: no watermark, no bound. Every caller today is an
   identity chain (exempt), but it reads as general-purpose, and the next content-chain caller
   gets a full replay for free.