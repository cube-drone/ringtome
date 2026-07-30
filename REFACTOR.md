# Ringtome — Refactor Log

The forward-looking ledger of known compromises and queued cleanups. Tech debt is a mortgage
(STYLE.md): taking it on to ship is correct, as long as the balance is recorded here rather than
in anyone's memory. **Completed entries are deleted, not checked off** — git history is the
archive; this file is only ever the current balance.

Covers the whole tree. The UI carried its own ledger through a long refactor (opened and emptied
2026-07-29/30, `git log --diff-filter=D -- REFACTOR_UI.md`); what outlived it are the rules now in
STYLE.md, and the architecture cops in `node/integration/test/pure/conventions.cjs`.

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
  `identity_peers` to. Deliberately deferred: not yet earning its churn. The revisit condition
  has now fired: NEXT_STEPS' "Peer set derived from the key tree" residual (2026-07-25) is
  exactly peer management growing real behavior - do the split as part of that unit.
- [ ] **Rotation liveness watcher** (owed by the minter rule, 2026-07-30; PROJECT_PLAN, Private
  Chains "Rotation rules"): self-retirement no longer mints its own excluding epoch (an epoch
  you mint is an epoch you know) and nothing else mints one yet, so a self-retired key's era
  currently never closes - members keep writing under the epoch the trashed device holds. The
  design is settled: on observing an ejection with no matching rotation (a revoked leaf still
  in the newest epoch's recipient list), any Active member's node mints; rank-scaled delay is
  an optimization, duplicates are absorbed by the existing try-all-keys reader. Land alongside
  it: sort each epoch's key list by (minter rank, entry hash) - `EpochKeys` currently returns
  insertion order - so writers converge on one key and readers try in write-preference order.
- [ ] **`key-epoch` recipient verification** (rule stated in PROJECT_PLAN, Private Chains
  "Rotation rules"; verified-never-asserted is also what makes who-mints-doesn't-matter true):
  today any well-formed `key-epoch` passes the gate and readers just trial-decrypt their own
  boxes, so a mint that smuggles a non-Active recipient or silently drops a member is accepted
  without complaint. Enforce at the gate/fold: smuggled recipient = hard refusal; omitted
  member = loud flag whose remedy is a re-seal; completeness binds only the newest epoch
  (adoption re-seals are legitimately recipient-lists-of-one for historical epochs). Grows
  teeth the day any epoch seals to a second person (DMs); do it with the watcher above.
  digit per 18 appends / per same-spot insert hit; a bloated list is repaired by rewriting its
  ranks as a burst of ordinary LWW writes. Deferred until a real list bloats - machinery ahead
  of need otherwise. The compact-append `after()` already keeps the common bulk-import case
  cheap.

## Reviewed and left alone (standing decisions, not history)

Re-litigating these costs more than reading this list:

- `ingest_batch`'s three phases in one function: the phase comments are load-bearing.
- The `.context(...).map_err(AppError::Internal)` chains: heavy but perfectly uniform —
  boilerplate signposting the error architecture.
- anyhow in leaf modules / `AppError` at the HTTP boundary: a consistent convention.
- `seq` stays `u64` end to end: a counter compared only to other counters, never to a clock;
  its sign casts at the SQL boundary would need a 9-quintillion-entry chain to misbehave.
- No memoized per-root taxonomy-tree view: the doc-meta view is already persisted and
  incremental, and tree expansion is an in-memory walk over human-scale lists - well inside
  good-enough speed. A baked tree would buy recursive invalidation machinery (every descendant
  write dirtying every ancestor's row) for a read that is one view + one query. Revisit if 4S
  ever serves trees to strangers at volume.
