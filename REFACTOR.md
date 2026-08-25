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


## The stale fold-read (open, 2026-08-25): entries land, the fold reads the past

The flake family's root, cornered twice and INVERTED by its own instrument: the "stale
serve" theory died when the serve's log showed its heads advancing (10:1 -> 10:3) while it
sent 0 - the requester's claims covered the entries, meaning the PULLING node has them.
The stale read is on the reader's side: charlie ingests the sharer's entries (claims prove
it), the frontier memo moves (hooks fire), and the share fold's read of the sharer's USER
database returns the pre-write state - stale pointer counts in fold narrations all along -
until "the next write" to that db resets whatever view is pinned. Suspect space: two
connections on one encrypted file (the 2026-08-22 coalescing fixed CREATE, but any second
handle would explain cross-connection WAL invisibility), or a pinned read snapshot on the
shared connection (fetch error paths now drain-then-fail; the CANCELLATION hole remains -
a dropped fetch future skips the drain; don't wrap `fetch_*` in timeouts). The instrument
now logs BOTH sides' heads on every empty serve ("served nothing - our heads at serve
time", claimed= vs ours=): next occurrence, read that line, then check whether the reader's
fold narration shows a stale pointer count against its own claimed head - that one
comparison names the guilty connection. The journalable fold ceiling and the want ladder
keep suites green meanwhile.
