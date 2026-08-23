# Ringtome — Refactor Log

The forward-looking ledger of known compromises and queued cleanups. Tech debt is a mortgage
(STYLE.md): taking it on to ship is correct, as long as the balance is recorded here rather than
in anyone's memory. **Completed entries are deleted, not checked off** — git history is the
archive; this file is only ever the current balance.

Judge entries against STYLE.md; when one gets picked up, work it as its own commit-sized fix.

## Open items

### A suppressed inbox notice still holds its ring slot (2026-08-10)

`undelivered_twice` hides a delivered notice once the fold derives the same fact, but the chain
entry behind it stays until it ages off the stranger tier's floor - so a row nobody will ever
see occupies one of 512 slots in the pool that IS the flood surface. Not fixable by deleting:
a chain entry cannot be surgically removed (only pruned below a floor), and the view row would
return on the next rebuild anyway, which is exactly why the rule lives at read time. The real
fix, if this ever bites, is for the fold to skip notices whose sender the reader now follows -
rebuild-stable, and it reclaims the slot at the next retention pass rather than immediately.

Small companion: the dedup compares one page of each list (100), so a delivered row whose
derived twin sits beyond that page survives. At that depth neither row is news.

### The delivery door has a timing side channel (2026-08-10)

A blocked sender is told `Accepted`, but the blocked path returns right after the epoch unseal
while an accepted path also appends an entry and folds it - so a sender who times the answer
can still separate the two. Much weaker than the one-bit oracle that was closed the same day
(it needs repeated probes and a quiet network, and the fold's cost varies for honest reasons),
and a constant-time door is not worth building yet. Recorded because it is the reason the
block-oracle fix should be described as *no cheap signal* rather than *no signal* - if that
distinction ever stops being good enough, the fix is to pad the blocked path to the shape of a
transcription, not to answer differently.

### The idle-node CPU is still unexplained (2026-08-10)

Three dev nodes, idle, 30-58% CPU each, for hours. This provoked the full-chain audit and
**survived it**: the audit's suspect (`local_frontiers` scanning the log) cannot be the cause,
because the databases involved are 6 MB total with a 909 KB largest file, and a `GROUP BY` at
that size does not cost a third of a core however often it runs. The one profile that named it
was a wall-clock sampler, which cannot tell computing from waiting on a mutex.

The useful measurement made while writing this up: **an empty node on the current binary idles
at 0.3%.** So the cost is per-persona, not structural (networking, discovery, the runtime), and
there is a clean floor to bisect from — add one persona, then one background loop at a time,
and watch where 0.3% becomes 30%. The one-second `resync::EAGER_TICK` is the obvious first
suspect by frequency alone, but *what* it does per persona per tick is the open question, and
page-level AEGIS decryption on every query is a candidate nobody has ruled in or out.

Wants a CPU-time profiler rather than `sample`.

The full-chain audit of 2026-08-10 is closed — all seven items, see HISTORY. The rule it left
behind, for anything new that touches the log: **a read whose cost grows with an identity's
history needs a watermark, a cursor, or a named reason it is bounded.** `imaol` now enforces
the third case rather than trusting it (`service_reads_whole`).
## The visit ladder still cancels exchanges mid-flight (noted 2026-08-22)

The slice-1 build established that aborting a sync mid-exchange mints zombie connection
state a later dial trips over, and that starved fan-out pushes for minutes at a time (the
detach-never-cancel rule, HISTORY 2026-08-22). The beat-driven machinery was converted -
`speculative::acquire_one` and `sync::sync_peers` detach at their deadlines - but
`idface::fetch_foreign` still runs the old shape: parallel candidates in a JoinSet,
`abort_all()` on first success, `FETCH_TIMEOUT` cancellation per task. Left alone
deliberately: it fires on human visits (request-time, not a loop), the winner's exchange is
never the one aborted, and months of green suites say the also-ran aborts are tolerable at
that rate. The compromise is that every abort is still a potential zombie against the very
node the winner just used. If mirror-fetch flakiness ever clusters around busy personas
with many live candidates, convert the also-rans to detach (drop the JoinSet without
abort_all, let them run out) before suspecting anything deeper.

## The edge re-mirror fires at posting cadence, not dial-mint cadence (noted 2026-08-23)

`edgegraph::refresh_from` rides `after_public_move`, which fires on EVERY public move - and
the hook cannot see which service moved. So any post by a persona with a follows-public
chain re-mirrors their whole published edge set and then re-runs the full memo choreography
(`subscriptions::refresh_root`: ledger read, subscriptions rewrite, implicit fold, demand
rollup, publish reconcile - a user-db open per reader) for every local reader holding any
dial on them. The function's own header argues "a friend's follows-public chain moves at
dial-mint cadence", which is true of the chain and false of the trigger: the trigger is the
posts chain too. Costed 2026-08-23 while diagnosing CI: the busy-suite churn this generates
was a contributor to the keyset-cursor test crossing its 5s budget on CI hardware (the
publish.cjs scar). The fix shape, when it's earned: a fold mark per author (the
`journal_marks` idiom) storing the FOLLOWS_PUBLIC frontier last mirrored, so a posts-only
move costs one primary-key read and the choreography runs only when the edges chain
actually moved.

## "Any sharer will do" can only name sharers the reader follows (diagnosed 2026-08-23)

The cascade intermittent ("any sharer will do", red in roughly half of runs since 2026-08-22),
run to ground with per-candidate sweep logging and a live ledger probe: at four hops, Rae
follows exactly one sharer, the recorded origin IS that sharer, and when the test darkens
that node the heal candidate union - `fragments.origins_of` + `fanout::sharers_of_author`,
both derived from what Rae's own ledger names - resolves to dark endpoints only. The node
that PHYSICALLY DELIVERED the revised header (Sam's, alive, holding the bytes, provably one
connection away) is remembered nowhere: in the caught red run the sweep tried the dark
endpoint 165 times and the eager heal fired 431 times at the dark origin's three endpoints,
while charlie's endpoint appears in neither list even once. Green runs are the attribution
path getting lucky at intake. Production shape of the same gap: a reader one follow away
from a share tree cannot heal bodies from sharers they don't follow, exactly when the one
they do follow goes dark - the case the doctrine was written for.

The fix shape (slice 1's own idiom, `speculative_fetches.last_via` applied to fragments):
stamp the endpoint that served each fragment at intake, make it a heal rung in
`net::bodies::sweep` and the eager `heal_soon` target. Whoever handed over the header holds,
or knows who holds, the bytes it names. Costs a schema gen bump (fragments table).
Related smaller findings from the same hunt: journalfill.cjs and trust.cjs flake in the same
silent-failure-under-load family; the sweep's per-root `tries+1` ages fresh rows for old
rows' failures; a persona-leaf hex can still reach the sweep's candidate list and be dialed
as an endpoint (the garbage-dial rule, not yet applied to this walk).
