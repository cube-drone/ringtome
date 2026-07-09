# Ringtome — Refactor Log

The forward-looking ledger of known compromises and queued cleanups. Tech debt is a mortgage
(STYLE.md): taking it on to ship is correct, as long as the balance is recorded here rather than
in anyone's memory. **Completed entries are deleted, not checked off** — git history is the
archive; this file is only ever the current balance.

Judge entries against STYLE.md; when one gets picked up, work it as its own commit-sized fix.

## Open items

- [ ] **Suffix sync for append-only chains** (consumer: Posts, Tier 4S; PROJECT_PLAN, Shallow
  Sync). The wire already carries `[floor..head]` frontiers (committed in M3 for exactly this)
  and the store's `page()` reads tolerate missing prefixes; what remains is the gate: accept a
  non-genesis chain start for suffix-eligible services, validate backfill downward against the
  held floor's `prev_hash`, and a fetch policy (how much tail on first contact). Land it with
  the first real paginated consumer.
- [ ] **`sync.rs`'s peer-bookkeeping tail** (`add_peer` / `peers_for` / `mark_synced` /
  `dial_addr`) could split into its own module; it's also what `conventions.rs` maps
  `identity_peers` to. Deliberately deferred: not yet earning its churn. Revisit when background
  sync / eager push (the M3 residual) makes peer management grow real behavior.

## Reviewed and left alone (standing decisions, not history)

Re-litigating these costs more than reading this list:

- `ingest_batch`'s three phases in one function: the phase comments are load-bearing.
- The `.context(...).map_err(AppError::Internal)` chains: heavy but perfectly uniform —
  boilerplate signposting the error architecture.
- anyhow in leaf modules / `AppError` at the HTTP boundary: a consistent convention.
- `seq` stays `u64` end to end: a counter compared only to other counters, never to a clock;
  its sign casts at the SQL boundary would need a 9-quintillion-entry chain to misbehave.
