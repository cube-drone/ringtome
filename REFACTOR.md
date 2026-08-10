# Ringtome — Refactor Log

The forward-looking ledger of known compromises and queued cleanups. Tech debt is a mortgage
(STYLE.md): taking it on to ship is correct, as long as the balance is recorded here rather than
in anyone's memory. **Completed entries are deleted, not checked off** — git history is the
archive; this file is only ever the current balance.

Judge entries against STYLE.md; when one gets picked up, work it as its own commit-sized fix.

## Open items

### The journal keeps every pruned inbox frame forever (2026-08-09)

Inbox retention prunes the `entries` table and everything downstream — the database, the
sync, the view — but the per-identity journal deliberately never deletes (`journal ⊇ database`
is the recovery invariant, and replay re-runs the gate). So a transcribing node's disk still
accretes one dead frame per notice ever accepted, ciphertext and all. Retention therefore
bounds what a node *serves and holds live*, not what it has *ever written down*.

Fine at present volumes; wrong at flood volumes, where the journal becomes the one unbounded
artifact a stranger can still grow. The fix is journal compaction — rewrite the file keeping
only frames whose entries survive, atomically, with the torn-tail rule intact — which is its
own careful project because the journal is the recovery root: get compaction wrong and
"database is derived state" stops being true. Pair it with the snapshot work if possible;
both are "replace a prefix with something smaller" with the same failure modes.

### `imaol::published_edges` is an un-memoized full fold on a hot path (2026-08-09)

It reads and decodes **every** `public-edge` entry the persona has ever written, folds them
LWW per subject, and returns the lot. That was fine when almost nothing was published; since
publication became the resting state (Edge-Endpoint Visibility, same day) every relationship
has a statement, so the fold is O(all your relationships) — and it runs on hot paths:
`publish::reconcile` calls it on every subscriptions refresh, and `notifications::refresh_from`
calls it on every public frontier move.

Measured symptom, not yet attributed with certainty: an idle three-node dev network sitting at
23–34% CPU per node. A `sample` caught every thread parked, so it is bursty rather than a spin —
consistent with a periodic O(n) fold rather than a runaway loop.

This is the fan-in-at-read-time mistake the Data Layer names, and the codebase already has the
answer twice (`doc_heads`, `feed_journal`): the fold writes a memo and reads never fold. The
fix is a materialized `published_edges` view in the persona's own database keyed by subject,
advanced by a watermark like every other fold, with `reconcile` and the notification pass
reading rows instead of replaying the chain. Do it before the edge count gets interesting.