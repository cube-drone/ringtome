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

## The body-arrival race tail (noted 2026-08-23, residual)

What remains after the deliverer rung: roughly one red per two suite runs, a different test
each time, one shape - a fold or publish racing body arrival under load. Faces seen:
`cascade.cjs seedToCleo` (share fold latency to the third hop), `publish` 400 "this note's
words haven't arrived" (also journalfill.cjs on CI). Down from the pre-fix rate and no
longer clustered; the diagnosis idiom that cracked the cascade bug (speak-on-failure logs +
the outside-the-suite /test/sql probe) applies directly when this earns its dig.

## Exchanges to a live node can hang for the full 30s peer ceiling (noted 2026-08-23)

Read straight from the trust.cjs CI artifact: alpha's three vouch-pushes to charlie - alive,
serving other exchanges the whole time - each hung until `PEER_PASS_TIMEOUT` detached them,
29.7s apiece, and the vouches never arrived by push at all. The wake-pass backstop was
disabled by the missing `RINGTOME_TEST_FOLLOW_STALE_MS` (fixed the same day: the rig now
sets 2000, so a pull road exists beside every push), which is what let a hung-push window
become a red test - but the hangs themselves are unexplained and production-real: something
on a loaded node lets an accepted-or-accepting QUIC exchange sit half-open for tens of
seconds. Same family as the zombie-mint findings (HISTORY 2026-08-22). When it earns its
dig: the artifact idiom applies, and `push_to_askers` still reports only reached counts -
per-peer errors from `sync_peers` are dropped there, worth a debug line when one fails.
