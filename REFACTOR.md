# Ringtome — Refactor Log

The forward-looking ledger of known compromises and queued cleanups. Tech debt is a mortgage
(STYLE.md): taking it on to ship is correct, as long as the balance is recorded here rather than
in anyone's memory. **Completed entries are deleted, not checked off** — git history is the
archive; this file is only ever the current balance.

Judge entries against STYLE.md; when one gets picked up, work it as its own commit-sized fix.

## Open items

### `sync::local_frontiers` is a full-table GROUP BY inside the one-second eager tick (2026-08-09)

Found while attributing idle dev-node CPU to the `published_edges` fold — which turned out to
be the WRONG suspect. A `sample` of a busy dev node caught the actual burst: 399 of 400
samples inside `resync::eager_pass → eager_root → local_frontiers → fetch_all`, meaning one
`SELECT author_pubkey, service, MIN(seq), MAX(seq) … GROUP BY` over the whole entries table
occupied the entire three-second window. That query runs per persona inside the eager-sync
machinery, whose tick is one second — and on databases fattened by test-data runs, the scan
takes longer than the tick that schedules it. The three idle dev nodes sitting at 23–34% CPU
are (at least in the caught sample) this, not the edge fold.

Caveats, honestly: one sample, one node, the pre-checkpoint binary, testdata-sized databases.
Attribute properly before building — but the shape is already suspicious on paper: frontiers
are recomputed from the full log on an edge that fires constantly, while `chain_heads` (the
node.db memo fed at every append and ingest) exists precisely to answer head questions without
opening the log. Candidate fixes, in rising order of effort: serve `local_frontiers` from the
memo (it must then be trusted for floors too, which retention already made reconcile-healed);
or keep the scan but hoist it out of the per-peer path so one recompute serves a whole pass.