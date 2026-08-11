# Ringtome — Refactor Log

The forward-looking ledger of known compromises and queued cleanups. Tech debt is a mortgage
(STYLE.md): taking it on to ship is correct, as long as the balance is recorded here rather than
in anyone's memory. **Completed entries are deleted, not checked off** — git history is the
archive; this file is only ever the current balance.

Judge entries against STYLE.md; when one gets picked up, work it as its own commit-sized fix.

## Open items

### `an undeliverable notice waits` flakes about once in thirty runs (2026-08-11)

Observed failing once, on the FIRST assertion - no `outbound_notices` row existed at all - then
passing in 323ms on a rerun with an unchanged binary. Everything between the last green run and
the red one was JavaScript, CSS and the string catalog, so the outbox could not have been
touched.

The shape is a `settle` with a fixed try count in front of a multi-stage background pipeline:
dial interest → subscription refresh → `publish::reconcile` mints a public-edge → `outbox::queue`.
Four hops, each on its own beat, and the test polls for the end of the chain. On a loaded machine
(this session ran CI back to back for hours) one hop slipping past the window is enough.

Not worth chasing as a product bug, worth fixing as a test: the assertion wants a longer settle,
or - better - a wait on the *subscription* row landing before it starts polling for the notice,
so it is timing one hop rather than four. Left as-is because a rare flake with a known cause is
cheaper than a wrong fix, but it will waste somebody's afternoon eventually if nobody writes it
down.

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