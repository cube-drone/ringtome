# Ringtome — Refactor Log

The forward-looking ledger of known compromises and queued cleanups. Tech debt is a mortgage
(STYLE.md): taking it on to ship is correct, as long as the balance is recorded here rather than
in anyone's memory. **Completed entries are deleted, not checked off** — git history is the
archive; this file is only ever the current balance.

Judge entries against STYLE.md; when one gets picked up, work it as its own commit-sized fix.

## Open items

### The strings tool misreads JavaScript, and can silently drop copy (2026-09-27)

`node/tools/strings.mjs` reads the UI's source with two hand-rolled scanners, and neither knows
JavaScript's strings and comments together:

- `htmlTemplates` does not skip comments, so an apostrophe in a `//` comment ("this browser's")
  opens a phantom string that swallows code up to the next quote - and the templates in between.
- `stripComments` blanks `/* ... */` with a regex that does not know strings, so `accept="image/*"`
  opened a "comment" that ran to the next `*/` and hid every `t()` call between.

A third blind spot, of scope rather than scanning: the tool reads templates and message sinks, so
user-facing words kept as data in a PURE module (which may not import `t`) are invisible to it - the
feed's curiosity stops, the search kind dial and People's sorts all shipped untranslated that way
until 2026-09-27. The pattern that holds: a pure module keeps KEYS, and the rendering module maps
them to words through `t` (facets.js `KIND_NAMES`, feed.js `STOP_WORDS`).

The first mis-flags copy (or hides it from the cop); the second made `just strings` DELETE five live
phrases from en.js (the profile's name, bio and Save labels) while `strings-check` reported all
well. Both were worked around in place (HISTORY, 2026-09-27). The fix is one scanner that tokenizes
strings, template literals and both comment forms before anything else looks - teaching the
template scanner comments alone surfaced 52 flags across six files it had been misreading (Writer,
the reader, the notes list, buckets, upload, postentry), which come with the fix. Until then: after
`just strings`, check that no live `t()` key went missing from en.js (the app-wide check is a
dozen lines of Python in the 2026-09-27 session), and keep apostrophes and `/*` out of comments in
templated files.

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
block-oracle fix should be described as _no cheap signal_ rather than _no signal_ - if that
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
suspect by frequency alone, but _what_ it does per persona per tick is the open question, and
page-level AEGIS decryption on every query is a candidate nobody has ruled in or out.

Wants a CPU-time profiler rather than `sample`.

The full-chain audit of 2026-08-10 is closed — all seven items, see HISTORY. The rule it left
behind, for anything new that touches the log: **a read whose cost grows with an identity's
history needs a watermark, a cursor, or a named reason it is bounded.** `imaol` now enforces
the third case rather than trusting it (`service_reads_whole`).

## Storage read visibility (open, 2026-08-25): one narrated occurrence still wanted

What remains of the stale fold-read dig after the fold lane (fold.rs) landed. The verdict
race - one arrival's true-getter folding a stale snapshot while racers stayed silent - is
structurally gone: folds are serialized per root and every ingest guarantees a fold that
STARTS after it. That also means a genuine storage-visibility bug (a pinned read snapshot
on the shared handle, or cross-connection WAL invisibility - the two suspects the
instrument narrowed to) would now be MASKED rather than fixed: the fold lane re-reads
after every write by construction. The mint-window evidence (a refresh 1ms behind a
committed dial reading the pre-write ledger, subscriptions.rs gate doc) says something
real was there. Standing ask: if any "read the past" line ever shows again - a fold
narration's stale pointer count against its own claimed head, a beat that read pre-write
state - capture the window; the drain-then-fail rules remain the constraint on any storage-layer
dig. (The CANCELLATION hole that stood beside them is settled, 2026-10-02: turso 0.7 runs a
statement inside one poll and resets a dropped one cleanly - `db.rs`'s
`a_statement_dropped_mid_stream_leaves_the_connection_clean` - so timeouts are safe.)
