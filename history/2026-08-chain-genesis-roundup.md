# Reads That Grow With History: the full-chain audit

*2026-08-09 to 2026-08-10. Extracted from [`../HISTORY.md`](../HISTORY.md) because the seven
entries only mean anything in sequence: the audit was provoked by a wrong answer, its first
fix could not be measured, its middle fixes kept finding bugs that had nothing to do with
scanning, and the rule it ended on is worth more than any individual patch.*

*Read the section titled "The thief was never caught" first. The CPU symptom that started all
this was never attributed, and one entry below claims otherwise in its title.*

## What it was

Curtis, after an idle three-node dev network was found sitting at 23-34% CPU per node:
*"I'm looking for a list of every place in our system that does something to a full chain from
genesis, exempting identity chains because they're very small and very correctness sensitive:
almost all of the time, our YAGNI instincts don't hold here: we're targeting tens of thousands
of entries and long term usage, even from the get-go."*

Twelve sites were found. Seven needed fixing; the rest were either identity chains (exempt by
that rule) or already watermarked. The prologue below is the entry that provoked the audit -
a fold memoized on suspicion, and a profile that immediately proved the suspicion had named
the wrong function.

## What shipped

`local_frontiers` and `missing_plan` read the chain-heads memo instead of scanning the log on
every sync exchange. `documents::materialize` left the save path, so saving one note stops
threading the whole notebook. The ingest path's whole-log revalidating rebuild became a scoped
view drop, so a stranger's revocation no longer buys N signature verifications. The raw-log
endpoint pages. Journal backfill streams. `entries_of_type` refuses services that have no
bound, instead of trusting its callers.

## The thief was never caught (2026-08-10, added after the fact)

The audit was provoked by three idle dev nodes at 23-34% CPU, and it is worth being blunt in
the durable record: **that CPU was never attributed, and nothing here is known to have fixed
it.** An entry below is titled "the real CPU thief gets caught". It should not have been.

What the evidence actually was: one three-second `sample` of one node, with 399 of 400 samples
inside `resync::eager_pass → eager_root → local_frontiers → fetch_all`. Three problems with
reading that as a conviction, all visible at the time:

- `sample` is a **wall-clock** stack sampler, not a CPU-time profiler. A thread awaiting
  `stmt_lock` - the mutex serializing every statement on a shared connection - or waiting on
  IO looks exactly like one computing.
- A sample of a *different* node minutes earlier showed every thread **parked**. That
  contradiction was explained away as burstiness rather than treated as a reason to doubt the
  method.
- The dev databases are **tiny**: 6 MB across all personas, largest single file 909 KB. A
  `GROUP BY` over a table that size cannot cost 30% of a core, however often it runs.

Checked afterwards, with the fixes in: an **empty** node on the new binary idles at **0.3%**,
while the (still un-restarted, still old-binary) dev nodes sit at 43-58%. So the cost is real,
is per-persona rather than structural, and is not scan volume - which is the one thing this
audit removed. The suspect had motive and no means.

That does not make the seven fixes wrong; they were justified by asymptote and doctrine, and
two genuine bugs fell out of making them. It makes the *headline* wrong, and the honest next
step is a CPU-time profile of a node with personas on it, or a bisect from that 0.3% floor by
adding one persona and one background loop at a time.

## What it cost, and what it did not buy

Two bugs that had nothing to do with scanning, both mine, both found by doing this work: an
`inbox_notices` view that no rebuild ever cleared, and a view/watermark mismatch that let an
eviction on one document lane destroy the other lane's rows and sweep an honest post out of
its author's own feed - live through two green CI runs before the repudiation suite caught it.

And no measurable wall-time. Both A/B runs came back flat against baseline, because the
benchmark starts from empty databases and spends its time on HTTP round-trips. Every fix here
is justified by an asymptote and one profile, not by a number. The decisive measurement -
a dev network with a day of real data, restarted, watched - remains untaken.

## The rule it left behind

**A read whose cost grows with an identity's history needs a watermark, a cursor, or a named
reason it is bounded.** The first two are mechanical. The third used to be a comment and is
now a function that returns an error (`imaol::service_reads_whole`).

---

## 2026-08-09 — the edge fold gets its memo, and the real CPU thief gets caught

Two findings for the price of one fix.

**The fix, as ledgered**: `imaol::published_edges` replayed every public-edge entry ever
written, on every call, on two hot paths - fine when "these chains are tiny" was true,
repealed the same day by public-by-default, whose every dial turn appends a statement
forever. It is now memo-backed: a `published_edges` view per persona (user schema gen 10),
folded incrementally past a watermark with the `apply_profile_set` stamp-compare upsert,
retractions kept as both-bands-NULL rows because the tombstone is what stops a resurrected
older statement from winning. `rebuild_views` clears it; the read refolds it whole; the
public-facing signature is unchanged so neither consumer moved. The Data Layer's own rule,
applied at last: the fold writes a memo, and reads never fold.

**The attribution, corrected in public**: before building, a `sample` of a busy dev node -
step zero, per the ledger entry's own advice - caught the idle-CPU burst red-handed, and it
was NOT this fold. 399 of 400 samples sat inside `resync::eager_pass → local_frontiers`: a
full-table GROUP BY over the entries log, per persona, inside the ONE-SECOND eager tick, on
databases fat enough that the scan outlasts the tick scheduling it. That finding replaced
this one on the REFACTOR ledger, with its caveats named (one sample, one node, the older
binary, testdata-sized data) and the candidate fix sketched (serve frontiers from the
chain_heads memo, which exists precisely to answer head questions without opening the log).

**The measurement, honest**: test-data, three scratch nodes, seed 424242 - 174s against the
176s baseline. No wall-time change at current scale, exactly as the corrected attribution
predicts; this fix's justification is the unbounded asymptote and the doctrine, not a
benchmark. The benchmark's job was keeping the claim honest, and it did.

A bonus bug the memo work flushed out: `rebuild_views` validated every chain from genesis,
and a PRUNED inbox chain legitimately starts above zero - so the first forgery eviction to
trigger a rebuild against a pruned database would have died on "genesis entry must have seq
0". Retention left that trap; the replay now takes the suffix arm for exactly the services
whose holders prune (signature-checked standalone head, ordinary chaining after), with a test
that prunes then rebuilds.

Gates: full `just ci` green, 598 passing, exit code read before any pipe.

## 2026-08-10 — frontiers stop reading the log

Curtis asked for an audit: every place that walks a full chain from genesis, identity chains
exempted, on the stated grounds that our YAGNI instincts do not hold here - the target is tens
of thousands of entries from the outset. Twelve sites; the list lives in REFACTOR. This is the
first one fixed, and it is the one the profiler had already caught.

`sync::local_frontiers` was a `GROUP BY` over the entire entries table with a correlated
subquery per group, and it is one of the hottest reads in the node: both sides of every sync
exchange, the live-cache stream stamp, and `resync::eager_root`, whose tick is one SECOND. It
now reads `chain_heads` by primary-key prefix.

**The correctness argument, because this goes on the wire.** Over-reporting is the fatal
direction: claim a head you do not hold and the peer never offers it again - silent, permanent
loss. Under-reporting is free (the peer re-offers, the gate deduplicates). The memo can only
lag: `note_head` runs *after* the row lands, in both write paths, and is monotone on seq;
eviction calls `forget_chain`; retention prunes below the floor and leaves the head. The one
way it could lead - a database that lost entries while node.db kept its rows - is closed by
reconciling the memo against the log **once per persona per process at database open**, beside
the journal's torn-tail validation, for the same reason: open is where a file's invariants get
established once instead of re-checked forever. So the scan did not vanish; it moved from
per-second to per-process. A test pins the claim directly - ingest a fixture, then assert
`memo_chains` and `chain_ranges` return identical rows: every chain, floor, head and hash.

**The measurement, and it did not move.** test-data, same seed, same rig: 178s against 174s -
no improvement, arguably worse, and within the noise of a single run either way. Reported as
found. The benchmark cannot see this fix, and it is worth saying why: scratch nodes start
empty, so the scan it removes was cheap there, while wall time is dominated by 2700 sequential
HTTP actions rather than background CPU - and the change ADDS one scan per persona per process
at open, which a benchmark full of fresh database opens is unusually good at noticing. The
workload that produced the 399-of-400 profile was a dev network carrying a day of accumulated
data against a one-second tick, which is not what test-data simulates.

So the justification here is the asymptote and the profile, not this number. The decisive test
is cheap and belongs to whoever next restarts that dev network on this binary: if idle CPU
drops from 23-34% per node, the profile was right; if it does not, the profile named the wrong
frame and the audit's remaining entries are where to look next.

## 2026-08-10 — saving one note stops resolving the whole notebook

The audit's second entry, and it was smaller than advertised. I had told Curtis this one
"needs design thought, not a swap" - wrong, and wrong because I had not read far enough.

`documents::materialize` does three things: catch the fold up (incremental, watermarked -
fine), rehydrate every version of every document, then **thread each document's DAG**. The
threading is the expensive part and the reason the function exists: versions form a graph
rather than a line, so it computes the true heads, then the read-time mop-up that decides
which of them carry distinct words - collapsing identical twins, folding ancestor echoes, the
latter walking maximal common ancestors per head pair. That judgment is what the UI shows as
"this note diverged", and it is deterministic over chain data so every device agrees without
writing anything down.

All three production callers want ONE document: `save_version` (the parent, for the no-op
bounce; that doc's versions, for blob reuse), `retitle` (its display head and logical heads),
and `search_rows` (one doc per stale index row). So saving a single note threaded the entire
corpus, on the path a human waits on.

And the memo already existed, twice over: `doc_versions` carries `doc_versions_by_doc`, and
`load_doc` - already used by `refresh_doc_heads` - reads one document's rows through it and
runs the same resolver, its own doc comment promising "identical to `materialize`'s slice for
that doc (same rows, same resolver)". The fix was to call it: `catch_up` explicitly (which
`materialize` had been doing implicitly, and dropping it would have left saves reading a stale
fold), then `load_doc`. The `Option<&Doc>` shape became "an unknown document loads empty",
which answers every lookup the old code made exactly as before - a genesis save has no parent
to bounce against and no history to reuse a blob from.

`search_rows` changed shape slightly and for the better: it materialized once for all stale
documents, and now loads per stale document inside a loop that was already paying a body
decrypt each time round. A re-index of two changed notes stops threading two thousand
unchanged ones.

Pinned by a new test in the resolver's own suite, in the same discipline as the frontier
swap's: build a corpus with an unrelated document plus a genuinely diverged one, then assert
`load_doc` and `materialize` agree on versions, DAG heads, logical heads and display head -
so any future drift between the narrow and wide resolvers fails a test instead of quietly
changing what a save is parented on. `materialize` stays: it is the honest whole-view read,
and the tests and any genuine corpus reader still want it.

Gates: full `just ci` green, exit code read before any pipe.

## 2026-08-10 — a stranger's revocation stops buying a whole-log replay

The audit's third entry, and the one with an adversarial flavour rather than a scaling one.

When an ingest evicts rows - a proven forgery, or history beyond a revocation's anchored cut -
the views those rows fed are stale, so `ingest_batch` called `rebuild_views`. That function
clears every view and then walks the ENTIRE entries log, decoding and **re-validating** each
entry: one ed25519 verification apiece. It is the right ritual for an operator asking "prove
the views are caches, not truth" (it is the M1 exit demo, and the admin endpoint still runs
it). It is exactly the wrong thing to hang off a peer-facing edge, where a stranger's
revocation buys N signature verifications and a whole log in memory.

Two things were wrong, and they came apart cleanly:

**The re-validation was never the point.** Entries that survive eviction were validated when
they were admitted; the rebuild re-litigates them only because the ritual's *purpose* is
re-litigation. The ingest path only needs correct views. So `refold_after_eviction` drops the
stale views and lets each refold itself from its watermark - which is how every encrypted view
in this codebase has always worked ("the drop half": `documents::catch_up`,
`private::catch_up`, `catch_up_published_edges`, `inbox::catch_up`). The single exception is
`profile_view`, whose fold happens inline at ingest and so has no catch-up to lean on; it is
replayed, bounded by the persona's own profile history - a handful of entries, and nothing an
attacker can inflate.

**The clearing was indiscriminate.** Evicting one forged posts chain cleared the private
registers, the documents, the published edges - every view - so the next read of each refolded
from genesis. The eviction paths now report which SERVICES lost rows, and the drop is scoped to
the views those lanes feed. That mapping ("which service feeds which view") now lives in
exactly one function with the comment it deserves, because it is precisely the sort of thing
that rots in someone's head.

A gap of my own turned up while writing it: `inbox_notices` was never cleared by
`rebuild_views` at all - the table arrived on the 9th and was not wired into the rebuild - so a
rebuild left notices standing whose entries had been evicted. `inbox::clear_view` closes it,
and the mapping is now the one place that has to stay complete.

Pinned by a test asserting both halves: a profile-lane eviction rebuilds the profile view AND
leaves an untouched lane's view standing; a follows-lane eviction drops its view, and the next
read refolds it from the reset watermark.

Gates: full `just ci` green, 278 node unit tests, exit code read before any pipe.

## 2026-08-10 — the raw log stops being one response

The audit's fourth, and the smallest: `/api/identity/{root}/entries` handed back every entry a
persona had ever written, hex envelopes included. A fine demo surface, a bad promise at the
scale this system targets - and the thing an operator reaches for precisely when something has
gone wrong and the log is large.

It pages now, and **explicitly**: `{ items, more, next }`. The temptation was a silent cap - keep
the array shape, add a limit, break nothing - and that is the trap the doctrine names ("no
silent caps"). An inspection tool that shows the first hundred of fifty thousand and says
nothing is how someone spends an afternoon debugging the wrong thing. So callers were changed
instead; there are ten, all in the integration suite, and none in the UI.

The cursor is the `entries` PRIMARY KEY - `(author_pubkey, service, seq)` - which makes the walk
an index-ordered seek with no sort, and makes the cursor unique by construction. That last part
is not decoration: `(service, seq)` collides across devices, and a colliding cursor either skips
rows or loops forever. The test pages a two-device log three at a time and asserts the walk
reassembles the whole log exactly once, in the same order, with both devices present.

`StoredEntry` gained `author` while it was being touched - the cursor needs it, and a raw-log
view that could not say WHICH device wrote a row was quietly missing the most useful column on a
multi-device persona.

Gates: full `just ci` green, exit code read before any pipe.

## 2026-08-10 — the send plan stops enumerating the log

The audit's fifth, and the last cheap one. `sync::missing_plan` opened with
`SELECT DISTINCT author_pubkey, service FROM entries` - a full scan of the log, on every sync
exchange, to learn a list `chain_heads` already keeps. It reads from the memo now. (The
targeted lookup further down the same function - our entry at the peer's claimed head, the
equivocation check - was always a primary-key seek and is untouched.)

The trust argument is gentler than the one `local_frontiers` carries, and worth writing down
because the two look identical and are not: this list decides what we SEND, not what we claim
to hold. A memo naming a chain we lack costs one empty page; a memo missing a chain delays it
to the next exchange, against a memo that is reconciled against the log at every database open
and healed by the frontier sweep. Neither direction can lose history - which is exactly why
`local_frontiers` needed the open-time reconciliation and this did not.

The trap in the swap was the ORDER BY. The old query said `ORDER BY service, author_pubkey`,
which looks cosmetic and is not: the module promises **identity chains strictly first**, so the
authority context reaches a peer before the content it validates, and IDENTITY_PUBLIC being
service 0 is what made that ordering true. A memo read hands rows back in its own order. The
sort is now explicit, with the reason beside it, and a test asserts the plan leads with the
identity chain - a property whose loss would only surface on somebody's first sync.

Pinned the same way as the other two swaps: two databases holding identical logs, one memoed
and one bare, must produce the same plan.

**And the run went red - on the PREVIOUS commit's bug, not this one.** Yesterday's
eviction-scoping change (already merged, already twice-green) had a hole:
`documents::clear_view` wipes `doc_versions`, `doc_heads` and `doc_search` for BOTH lanes -
the public POSTS one and the private one - but the watermark reset only covered the evicted
service. Evicting one lane therefore destroyed the other lane's rows while leaving its
watermark saying "already folded", so that content never refolded, `public_docs` came back
empty, and the feed retraction running on the same edge swept an honest post out of its own
author's feed as collateral. Whether an eviction happened to touch both lanes was luck of the
fixture, which is how it passed CI twice while being live.

The invariant the code was missing, now written where it can be read:
**a view and its watermarks are dropped together, over every service that feeds it.** Several
views are multi-lane (`doc_versions` from both document lanes, the private registers from
general-private and doc-meta) and every one of those clears is whole-table, so the reset has to
cover exactly the ground the clear did. A unit test asserts it directly - evict POSTS alone,
and both document lanes reset while every untouched lane keeps its progress - so the next
regression fails in seconds rather than inside a three-node repudiation scenario.

Worth noting which test caught it: `repudiation.cjs`'s "a repudiation reaches the feeds",
whose comment is about `feed_journal` being a delivery memo that must not launder disproven
content. Written for a different bug, and it caught this one because it is the only test that
watches an eviction all the way through to what a human sees.

Gates: full `just ci` green, 598 passing, exit code read before any pipe.

## 2026-08-10 — the audit closes: the last two, and the rule it leaves behind

**Journal backfill streams.** When a database opens beside an empty journal, the backfill walks
the identity's whole log handing each frame to a file - and it used to read all of it into
memory first, which is a strange amount of RAM to spend on a path whose entire job is to pour
its input straight back out. It pages now (`entry_bytes_page`, 256 at a time, on the same
primary-key cursor the raw-log endpoint uses). One detail earned its comment: the cursor
advances by the last row **read**, not the last row kept. Ephemeral chains are filtered out of
the payload (the journal never holds inbox cargo, on any path), and a cursor advancing by kept
rows would step over a page of pure inbox entries and walk it forever.

**`entries_of_type` stops being a footgun.** No watermark, no limit - so calling it on a content
chain is a full replay with no tell, and it read like a general-purpose helper. It now refuses
any service not named in `service_reads_whole`: identity-public (tiny, security-critical, and
`Crown::build` must linearize it from genesis anyway) and profile-public (a handful of
`profile-set` entries, bounded by the persona's own ceremony rather than by anything a peer can
inflate - which is what makes the eviction refold safe to do eagerly). Same shape as
`private::aad_for_service`: a service earns the capability by being named, never by default. The
test plants the violation and watches it go red, per STYLE's rule that a cop which cannot fail
is decoration.

**Seven items, closed.** The audit found: `local_frontiers` (a full GROUP BY inside a
one-second tick), `documents::materialize` on the save path (every save threading the whole
corpus), the ingest path's whole-log validating rebuild (a stranger's revocation buying N
signature verifications), the unbounded `/entries` response, `missing_plan`'s chain enumeration,
and these two. It also flushed out two bugs nobody was looking for: an `inbox_notices` view that
no rebuild ever cleared, and - the sharp one - a view/watermark mismatch that let an eviction on
one document lane silently destroy the other lane's rows and sweep an honest post out of its
author's own feed.

Worth recording what the audit did NOT deliver: measurable wall-time. Both A/B runs came back
flat (174s, then 178s, against a 174s baseline), because test-data starts from empty scratch
databases and spends its time on HTTP round-trips rather than background CPU. Every fix here is
justified by an asymptote and, in one case, a profile - not by a benchmark. The decisive
measurement is still the one nobody has taken: a dev network with a day of real data, restarted
on this binary, watched for whether idle CPU drops from the 23-34% per node that started all
this.

The rule worth keeping, now in REFACTOR where the next reader meets it: **a read whose cost
grows with an identity's history needs a watermark, a cursor, or a named reason it is bounded.**
Two of those are mechanical. The third used to be a comment and is now a function that returns
an error.

Gates: full `just ci` green, exit code read before any pipe.
