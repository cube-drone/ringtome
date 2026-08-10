# Ringtome — Refactor Log

The forward-looking ledger of known compromises and queued cleanups. Tech debt is a mortgage
(STYLE.md): taking it on to ship is correct, as long as the balance is recorded here rather than
in anyone's memory. **Completed entries are deleted, not checked off** — git history is the
archive; this file is only ever the current balance.

Judge entries against STYLE.md; when one gets picked up, work it as its own commit-sized fix.

## Open items

### The delivery door answers its own failures as the sender's (2026-08-10)

`net::deliver::judge` maps a transcription `Err` - our keystore open failed, our database was
busy - to `Refused(GATE)`, and the sender's outbox correctly retires a refusal forever. So a
transient fault on the recipient's node silently destroys a notice that nobody refused. The
right answer is the one that already exists for this: `Unreachable`, which is the only outcome
the outbox retries. There is no wire word for it (the sender infers it from silence), so the
fix is either to drop the connection without answering or to add a `Busy` message - the first
is smaller and honest, the second is kinder to an operator reading logs.

Left open rather than folded into the block-oracle fix (same file, same day) because it is a
durability question, not a disclosure one, and it wants its own decision about the wire.

**Residual on the same surface, deliberately unfixed: the door has a timing side channel.** A
blocked sender is now told `Accepted`, but the blocked path returns after the epoch unseal
while the accepted path also appends an entry and folds it - so a sender who times the answer
can distinguish them. Much weaker than the one-bit oracle that was closed (it needs repeated
probes and a quiet network) and not worth a constant-time door yet, but it is the reason the
block-oracle fix is "no cheap signal" rather than "no signal".

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