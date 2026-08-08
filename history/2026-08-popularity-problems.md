# Popularity Problems: the 50k-follow investigation

*2026-08-07 to 2026-08-08. Extracted from [`../HISTORY.md`](../HISTORY.md) when the arc
outgrew its tail - ten entries kept whole rather than folded, because the interesting part is
the sequence: nearly every fix here was made smaller and better by a question asked after the
first version of it was proposed.*

## What it was

A thought experiment - *"let's create a hypothetical, super popular user: 50,000 incoming
follows, 50,000 outgoing ones: where does the platform get very slow?"* - answered by audit
rather than by guess. The finding that framed everything after it: the follow ledger was
assumed small in about nine distinct places (`subscriptions.rs` said so in as many words),
one path was genuinely O(F squared), and every mitigation the codebase had was on the
read-a-page or dial-a-peer axis, with none on the follow-list axis.

## What shipped

Read-path arithmetic: the O(F squared) contacts scan became a primary-key range walk; the
private view gained per-collection readers so a feed page stops folding the whole store; the
`feed_journal` gained the author-side index its reconcile always needed.

Write-path bounds: fan-out journaling writes the delta instead of the page, in chunked
multi-row upserts; the subscription memo's two megabyte-scale `NOT IN` literals became a
stamp sweep and a delta; the post-ingest memo refresh learned to fire only when a ledger
entry actually arrived.

Network bounds: pushes cap at 16 dials per move with a free recency round-robin; demand rows
age out on a 7-day window, both in the read and on disk; the sync sender pages and the
receiver ingests in bounded batches, so neither end holds a transfer.

Client bounds: the live-cache stream ships per-kind stamps and per-row deltas instead of
everything on every change; the rolodex went search-first with a bounded shelf.

And two real bugs the audit surfaced that were not about popularity at all: databases being
MINTED for personas the node had never synced (~96 KB each, one per contact on a big
adoption), and the API shape that made that mistake easy - `get` now returns `Option`, and
minting is its own verb.

## What it cost, honestly

Two integration tests were found already red and fixed; one fix was reverted the same hour
when its own probe proved the lag it removed was load-bearing (a revocation needs its
delivery window); one "hole" was asserted, written into three documents, and retracted two
days later after a closer read found the gate that had been there all along.

## What is left

Nothing acute. See NEXT_STEPS, Popularity Problems: wake-pass rotation tiering is the last
popularity-shaped gap; paced backfill on a memo rebuild is narrow; the rest is parked on
measurements with its triggers named. Shallow sync (suffix-first content chains) is
adjacent but predates this and belongs to the Sync arc.

---

## 2026-08-07: popularity problems - the 50k-follow audit and the fan-out diet

The prompt was a thought experiment: a user with fifty thousand followers and fifty thousand
follows - where does the platform get slow? The audit found the follow ledger assumed small
in about nine distinct places (subscriptions.rs said so in as many words), one of them
genuinely O(F squared), and every existing mitigation sitting on the read-a-page or
dial-a-peer axis with none on the follow-list axis. The full list lives in NEXT_STEPS under
"Popularity Problems"; what shipped today, worst-first
(fd6dea1..070e851):

**The easy wins.** `Store::contacts()` was quadratic - `registers_in` filtered the ENTIRE
registers map once per contact collection; the map was already keyed `(collection, key)`, so
a `range()` + take_while made each lookup a contiguous walk (both set readers had the same
shape - the second copy is the finding). `feed_journal` had no author-side index, so
`retract_vanished` full-scanned every reader's rows on every public move (schema generation
9 -> 10). And `askers_of` gained a 7-day freshness window mirroring `PEER_FORGET_MS`: a
week of silence is demand that LEFT, not demand at rest - safe because the wake pass re-asks
on every staleness beat.

**The push cap.** `push_to_askers` dialed every node that EVER asked, sequentially, no cap -
50k followers meant 50k QUIC dials per post. Now `PUSH_DIAL_CAP = 16` per move, and the cap
costs promptness, never data ("pushes are latency; the pull on re-contact is correctness").
The part worth remembering: most-recent-first under a cap is a FREE round-robin. A pushed
node stays fresh, stops dialing, and ages down the recency order; an un-pushed node goes
stale, pulls, and re-stamps itself to the top - successive posts sweep the whole asker set
with zero rotation bookkeeping. Known sawtooth, accepted unbuilt: a follower kept
perpetually fresh by pushes never dials, falls out of the 7-day window, misses one push,
pulls, re-enters - one cadence of latency, once a week, for the hottest followers.

**The fan-out diet.** Journaling wrote the author's whole newest page per reader per move -
one awaited INSERT each, inline in the frontier sweep, so a popular author's post was a
million serial statements that also froze the node's change detection. Two independent
fixes: a per-author high-water mark (`sweep_marks`, domain "journal", in-memory and
boot-reset - the first move after restart re-journals one page and the upsert makes it a
no-op) so only the DELTA writes; and chunked multi-row upserts (100 rows/statement, under
the classic 999-bind floor), with turso's multi-row `ON CONFLICT ... excluded.` behavior
proven by a unit test against a real db rather than trusted from docs. The boundary filter
is `>=` not `>`: two posts sharing the boundary millisecond across two exchanges would slip
a strict filter forever, and a re-upserted boundary row costs a fraction of a chunk.
Arithmetic: celebrity posts once, 50k local followers - 1,000,000 statements before, 50,000
after the delta, ~500 after both. `backfill_follow` ignores the mark on purpose: it records
what CURRENT followers have, and a new follower has none of it.

**Fix that CI.** Two integration tests had been red since the discovery arc landed at 00:38
and a day of commits stacked on top unnoticed (a stash-and-rerun proved they predated the
day's work - hence the new "Green before forward" rule in CLAUDE.md). The serving test was
asserting retired doctrine - "dark at birth" died when universal publication shipped - so it
now asserts the new contract: locatable from birth, within the pkarr budget, `/serve` as the
HTTP-face flag it remains. peerderive needed a derive pass inside its 30-second patience
against a 600-second beat; the `RINGTOME_TEST_PEER_DERIVE_MS` hatch existed but nothing
armed it. The catch worth its ink came from the first fix attempt: a synchronous re-derive
in `revoke_key` passed peerderive and broke repudiation.cjs and the twonode eviction test,
because **the lag between a revocation and its routing eviction is the strike's delivery
window, not slack** - prune the struck node's row in the same breath and, when that node is
your only peer, the revocation strands on your side forever. Reverted with a scar comment;
the fix is a local-test-gated `POST /test/derive` the probe rings on demand, which also
avoids a fast global beat racing every other strike test's choreography. Plus the two
clippy warnings that were failing `just lint`'s `-D warnings`.

Residuals, all in NEXT_STEPS: journaling still runs inline in the sweep (now cheap enough
that moving it waits on a measurement); dials within the push cap are still sequential;
`identity_demand` still never prunes its rows (the read side windows); and the rest of the
Popularity Problems list - the whole-store private fold, the whole-mirror websocket
snapshot, the unvirtualized People page - stands open.

## 2026-08-07: the memo answers directly - per-collection reads for the private view

Follow-through on the Popularity Problems list's deepest item, which Curtis's questions
reframed into something better than a popularity fix. The private view had the fold doctrine
NEARLY finished: incremental catch-up on a watermark, folded state persisted in indexed SQL
(`private_registers` / `private_set_elements`, primary-keyed by exactly what readers filter
on) - and then every read tipped the ENTIRE folded result into a fresh BTreeMap to consult
three rows of it. Loading a feed page's `feed_seen` marks folded the whole store; so did one
document's tags. The in-memory view wasn't a needed structure at all - it was a second copy
of an index SQLite was already maintaining, rebuilt per read, and building the copy cost a
full scan of the original. And the cost scales with the LIFETIME of the account (seen marks,
per-doc annotations), not its relationships: the 50k-follow user was just the stress test
that found what year-three of ordinary journaling would have found anyway.

The fix extends an idiom the module already had (`collections_with_element`: catch up, then
ask SQL the filtered question): four per-collection readers - registers, set elements, the
LWW-stamp insertion order twin, and a prefix sweep for `contact:` - each a catch-up plus a
primary-key SEEK, rows proportional to the answer. Eleven store read paths converted; the
whole-view door survives only for the five genuine sweeps (search indexing, the mirror's
bulk annotation read, bucket roster/all, the taxonomy graph walks), and general-private no
longer has a whole-view production caller at all. Two details worth their ink: the prefix
query is bound arithmetic (`>= 'contact:' AND < 'contact;'`) rather than LIKE, because LIKE
is case-insensitive by default and the planner won't drive it through the index; and the
undecryptable count now rides `catch_up`'s return into the per-collection tuples, keeping
the "records you hold but cannot open" honesty without the view.

The regression guard is the part built to outlive the change: turso supports `EXPLAIN QUERY
PLAN`, so the parity test asserts the per-collection SELECTs plan as an index SEARCH and
never a SCAN - "proportional to the question, not the store" pinned as a cop that goes red
on any rewrite into a table scan, whatever the collection count, rather than as a comment
hoping to be believed.

## 2026-08-08: the stream stops shouting - per-kind stamps and roster deltas

The live-cache stream had the popularity list's most user-visible offender: one cursor over
everything, so ANY movement regathered all six kinds ("everything the mirror holds,
refreshed whole") - a contact dial re-ran the search indexer over every document, a note
save re-serialized the whole roster, and at 50k contacts every dial turn shipped tens of MB
of JSON to every open browser, which then cleared and rewrote its entire IndexedDB contacts
table. Under it all, the per-second tick ran a whole-entries-table GROUP BY per open socket
to discover, almost always, that nothing had happened. Three layers, outermost first:

**The tick got the sweeps' stat-guard.** mtime + view epoch checked before stamping,
recorded BEFORE the stamp so a mid-stamp write re-runs one round instead of being skipped -
a quiet persona's tick is now two syscalls. A write-nudge always re-stamps; the guard exists
only to spare quiet ticks.

**The cursor split into per-kind stamps.** One frontier read now feeds four group
fingerprints (profile / documents+search / organizers / contacts) through a service map
that is conservative by construction - identity chains and unknown services touch
everything, because a wrong "nothing" is a stale mirror while a wrong "everything" is one
extra gather. Updates carry only the kinds whose chains moved; absent means "unchanged",
never "empty". The wire needed NOTHING for this: every kind was already optional and the
client already applied per-kind - the v1 shape had left the door open without knowing it.
The public cursor token hashes all four stamps, so reconnect semantics are exactly the old
single cursor's.

**The roster ships as diffs.** The server holds the socket, so it holds the roster it last
shipped and diffs against it: updates carry changed rows and removed roots; snapshots still
carry the roster whole; any cursor doubt still collapses to snapshot, so a missed delta
cannot outlive a reconnect. Two catches worth their ink. A "live" reconnect must PRIME the
diff baseline (a read, nothing sent): an empty baseline could never name a contact removed
after the connect, and the client would have kept the row until its next snapshot - found in
design review, not in the field, which is what design review is for. And a general-private
write that isn't roster-shaped (a seen mark, a device name) moves the contacts stamp but
diffs to nothing and ships nothing - the diff is the filter the fingerprint is too coarse to
be. Client-side, deltas upsert and delete without clearing, in the same transaction as the
cursor, so the mirror stays a consistent frame.

Scoping and deltas are pinned by livecache.cjs (a profile write ships no docs; a dial turn
ships one row and never the roster). Residual, recorded in NEXT_STEPS: docs + search still
re-ship whole when any document moves - the per-socket diff generalizes to them if
note-hoarders ever feel it, and that curve is account lifetime, not popularity.

## 2026-08-08: docs and search join the delta stream

The residual from the morning's stream diet, closed the same day on Curtis's call
("thousands of documents aren't hard to rack up - first-hand experience"): docs and search
rows now ship as per-socket diffs like the roster does, so saving one note among five
thousand sends one changed row and its search tokens, not the library. Two design upgrades
over the roster's first draft, both of which then simplified the roster itself:

* **Baselines hold fingerprints, never rows.** A blake3 of each serialized row, keyed by
  doc_id/root - search token bags are the stream's biggest rows, and a socket must not hold
  a second copy of the store to know what it shipped. One generic `ship_kind` now serves all
  three keyed kinds.
* **An unprimed baseline ships whole.** Yesterday's live-reconnect fix primed the roster
  baseline with a read at connect; today's shape deletes that: a fresh socket's baseline is
  simply None, and a kind's FIRST movement ships the kind whole (which the client already
  applies as clear-and-replace, so removals are carried without any baseline) and primes it.
  Zero connect cost, removals sound, less code than the fix it replaced - the better shape
  was a day behind the working one, which is the usual distance.

Deletion rides the same wire: tombstoning a doc arrives as `docs_removed`/`search_removed`
naming the one id, with the surviving rows unshipped. livecache.cjs pins all three shapes -
delta on a primed socket, whole-kind on a fresh one, removal naming one doc. The honest
residual moved from the wire to the compute and is recorded in NEXT_STEPS: producing that
one-row diff still recomputes `search_rows` and the annotation sweep whole; a doc-scoped
refresh waits for a profile to name it.

## 2026-08-08: demand retention - the doorbell, never the archive

The schema comment's stated debt ("retention deliberately deferred... owed before any node
hosts strangers"), paid in the small pass it always wanted to be: `identity_demand` rows
quieter than the 7-day freshness window are now DELETED on the derive beat
(`demand::prune_quiet_askers`, beside `prune_forgotten_peers`), completing the window whose
read half `askers_of` already applied. Almost no performance angle - the reads were already
windowed and indexed - and that was never the point: the table is the one place the
network's most deliberately-protected relationship data (who READS whom - the quiet-follow
graph the disclosure tiers exist to keep non-public, reproducible from no DHT) condenses as
a routing side effect, and without retention a popular persona's node accumulated a
permanent timestamped roster of everyone who ever peeked. The already-assembled object is
now bounded to current demand. Safe because the wake pass re-asks on every staleness beat;
the unit test pins both halves - a quiet row leaves the TABLE, and a re-ask re-enters.

## 2026-08-08: the rolodex goes search-first

The last hard breakage on the popularity list: the People page mounted one PersonRow per
contact, unconditionally - at 50k contacts that is 50k DOM subtrees and ~200k Dexie
liveQuery subscriptions all re-evaluating on every mirror write, plus an unbounded
/api/directory rendered in full underneath. A dead tab. The shape question (virtualize?
paginate? search?) went to Curtis; search-first won: **the filter is how you find someone;
the slice is only what idle browsing shows.** The shelf renders the top PEOPLE_SHELF_SLICE
(100) by the active sort, "show more" extends it, and a filter box in the shelf head narrows
against the full mirror by every spelling a person is known by - nickname, self-claimed
name, root-hex prefix, and the speakable words. The DOM never holds more than a slice
regardless of ledger size, no virtualization machinery ever, and the filter doubles as the
"Search my people" NEXT_STEPS wish. Server side, /api/directory is capped (200,
hosted-first, BEFORE the byline join - so a mirror-rich node neither builds a 50k-root IN
clause nor ships one); which fetched personas make the cut is arbitrary past hosted-first,
and honest for a discovery shelf.

A cop earned its keep: filterContacts first imported speakable.js, and the pure-set
conventions test refused it - pure modules import only pure modules. The forced fix was
better than the sin: callers annotate rows with their words once per LIST change (the
directory rows already carry theirs from the server), so the filter stays value-in/value-out
AND stops recomputing base58 per keystroke. Filter behavior pinned in test/pure/people.cjs;
the UI itself is human-verified per the no-automated-UI rule - Curtis, kick the tires.

## 2026-08-08: the subscription memo diet - two questions delete two megabytes

Curtis asked two questions about the memo refresh ("why ARE we looking for a subscription
that's not in a set? why on every post ingest?") and both answers turned out to be "no good
reason", which made the fix smaller and better than the batching pass originally planned:

* **The NOT IN literal was doing a job a timestamp already does.** The refresh is
  clear-and-replace, and its removal half deleted the complement of an inlined keep-list -
  megabytes of quoted hex, re-parsed per call (giant constant IN-lists cost at PREPARE, not
  probe), and doomed anyway: SQLite refuses statements past its 1MB default length ceiling,
  so past ~15k contacts the old form would have simply errored. But every kept row was
  already stamped `updated_at_ms = now` by its own upsert, so the withdrawn set IS "rows
  this rewrite didn't touch": one indexed DELETE on the stamp, no list anywhere.
  `excise_unfollowed`'s twin literal fell to the same question sharpened once more: the
  rewrite computes eager_before for backfill detection, so it KNOWS who crossed out of the
  eager set - the excise now takes that delta (almost always one name) instead of deleting
  the complement of everything.
* **The post-ingest refresh fired blind.** The hook exists so a dial turned on your phone
  reaches your laptop's memo by event rather than the ten-minute backstop - but it fired on
  ANY batch, and a batch of posts cannot carry a dial. Entry services ride in the clear, so
  the gate now reports whether a general-private entry was actually STORED
  (`IngestOutcome.ledger_moved`, retiring the bare `(u64, u64)` return), and the celebrity's
  post-heavy ingests stop triggering full memo rewrites at all. The cross-device dial probe
  still passes, which is the gate proven from the letting-through side.

What remained of the original plan: the F rows a genuine refresh still writes now land as
chunked multi-row upserts (the fanout pattern, 150 rows a statement). The lesson worth the
ink is the shape of the whole exchange: both megabyte strings were compensation for
discarding information the code already held - a stamp it had just written, a delta it had
just computed - and the performance fix was remembering, not optimizing.

## 2026-08-08: sync stops swallowing the transfer whole

The audit line was "missing_for_peer buffers everything"; reading the code found the same
shape on BOTH sides of the wire and a third copy in journal replay, with the worst instance
the one nobody had listed. Per-message caps existed (entries 16 KiB, frames 256 KiB) and no
aggregate cap did, which is the whole bug in one sentence.

**The receiver was the urgent half.** The read loop pushed every arriving frame into an
unbounded Vec and only then called the gate - so validation happened after residency, and
any node that speaks our ALPN could stream entries until the process died. QUIC flow control
is no help when the reader consumes eagerly. `ingest_stream` now flushes every 2048 entries,
which bounds a stranger's leverage and shortens the per-identity ingest lock from "the whole
transfer" to "one batch" as a bonus. The safety argument for batching, since the gate makes
cross-batch judgments: the first branch of a fork is STORED by the time the second arrives,
so `Crown::build`'s `stored ∪ arriving` input still sees both; a revocation in a later batch
still evicts what earlier ones admitted (that path exists already - it is the raced-in-
forgery case); and the one real cost is that content whose authorizing identity entry lands
in a LATER batch is rejected rather than admitted - a re-send next exchange, never a wrong
admission, and honest peers send identity chains first. The existing equivocation test
turned out to already pin the cross-batch fork case, because it ingests the second branch in
a separate call - which IS a batch boundary.

**The sender pages.** `missing_for_peer` became `missing_plan` (which chains, from which seq,
plus the fork proof to lead with) plus `MissingEntries`, a hand-rolled async walk that holds
at most one 512-entry page. First cut had the paging loop written twice - once writing
frames, once collecting for tests - and the tests would then have proven the collector's
seam, not the wire's. Rewritten so `next()` is the only copy and both sinks are four-line
loops around it; the collecting form survives `#[cfg(test)]`-only, deliberately not sitting
one call away from the send path.

Both plants went red before going green: truncating chains at one page (513 of 516) and
advancing the seam by two (515 of 516). Plus a batch-invariance test asserting the gate's
verdict and stored chain are identical whole vs. cut in twos.

The residual is now honest and differently shaped: paging fixed the RESIDENCY, not the
POLICY - a first sync still sends dense-from-their-head, i.e. the whole history, just never
all at once. "Content chains: suffix-first, backfill lazy" is still unbuilt, and NEXT_STEPS
now says so in those words rather than as a memory complaint.

## 2026-08-08: exists, not get - the stampede was minting, not opening

The audit line read "first-sync backfill stampede: 50k user-DB opens through a 128-slot
LRU". Reading the code found something worse and then the disk proved it: `user_dbs.get`
CREATES on open, so backfilling a persona this node has never synced did not open a database,
it WROTE one - and `data/test/users/` was already carrying `abababab….db` from the test
suite's own stranger root, 4 KB of database plus 86 KB of WAL plus a journal, ~96 KB per
contact nobody here has ever met. A device adopting a 50k-follow ledger does that for every
contact at once (the memo's first refresh sees an empty `eager_before`, so all of them are
"newly eager"), inside the adoption exchange that triggered it: ~4.5 GB and 150,000 files
before the newcomer has read a single post.

The codebase had already named this hazard and built the guard - `UserDbs::exists` exists
"without `get`'s create-on-open minting empty databases for every stranger a contact list
mentions" - and was using it in exactly one place, the anonymous doc-bytes probe. Two more
call sites needed it, and the second one only surfaced because the first fix's test went
red on a rerun after passing once:

* **`fanout::backfill_follow`** - whose own doc comment had always claimed a persona "not
  here yet" was skipped, which `get`'s create-on-open meant it never was. The doc described
  the intent; the code did the opposite.
* **`idface::stored_tree_leaves`** - the real minter behind the flake, caught in the node log
  (`generated new database encryption key` for the stranger root, thirteen milliseconds
  before `background revalidation reached nobody`). Its doc said "callers must hold a reason
  to believe the mirror exists" - but one caller is the WAKE PASS, whose entire job is
  chasing followed personas we may never have synced, so it structurally cannot hold that
  reason. The precondition moved into the callee: no mirror, no stored leaves, no
  database - structural rather than disciplinary, per STYLE.

Pinned by an integration test (a dial for a stranger mints nothing), which needed the
harness to export its data directory - `RINGTOME_TEST_DATA_DIR`, beside the discovery dir it
already exported for the same kind of filesystem assertion. The plant went red before green,
and the second minting site is exactly why the plant matters: the first version of this fix
passed CI once and failed the rerun, because whether the wake pass's 60-second beat landed
inside the suite's runtime was luck.

Two things demoted on the way past. The frontier sweep's "stat storm" (~100k syscalls a
pass) came off the list entirely: that sweep is 600s and stat-guarded, which is the cheap
thing the guard was introduced to substitute for opens. And what remains of the stampede is
narrower and honestly stated in NEXT_STEPS: a MEMO REBUILD (node.db is disposable by design)
makes every mirror this node actually holds newly-eager at once, which wants pacing - and
pacing needs a pending-backfill marker, because "newly eager" is edge-triggered and a capped
loop would drop the remainder forever.

## 2026-08-08: get returns Option - minting becomes a verb you have to mean

Curtis's question on the previous fix ("does it make sense to guard every call site, or is it
more practical to change `get`?") was the right one: two guards had just been added to two
paths whose doc comments ALREADY asserted the precondition they failed to enforce, which is
a rule living in prose losing to the next caller who doesn't read it. So the API changed
instead of the callers.

`UserDbManager::get` now returns `Result<Option<Db>>`, and the create-on-open half became
its own verb. Three doors where there was one:

* **`get` -> `Option`** - read if held. Absence is a value the compiler makes you handle.
* **`held`** - read, where absence is a BUG (a persona this node hosts, whose database was
  minted at creation). Never mints, so the worst a misuse does is fail loudly.
* **`create`** - mint if absent. The rare, deliberate half: identity creation, and both ends
  of a sync exchange, where a first arrival is the point.

Twenty-nine call sites, compiler-driven, and the per-file totals came out IDENTICAL to
before - no opens added or removed, only their intent made explicit. The two `exists()`
stopgaps from the morning were deleted; the type does that job now. The conventions cop
learned to count all three verbs (thrash is about opening a file per item and does not care
which door), and gained a sibling, `create_sites_stay_rare`, pinning the minting sites at
three - because a read path must never quietly become one.

Both plants went red before green, and the first is the one worth keeping:

* Deleting an absence check (`let db = ...get(x).await?` used as a `Db`) now **fails to
  compile** - `expected &Db, found &Option<Db>`. The bug that shipped twice in one afternoon
  and cost ~96 KB of empty database per stranger is now unwritable, not merely discouraged.
* An added `create` in a read module turns the new cop red with the file named.

Two things surfaced on the way past, and the first one was WRONG - corrected here the same
day, in place, because a false claim in the log is worse than an ugly one. This entry
originally said the responder (`sync::serve`) let a stranger name any root and get a database
minted for it: unsolicited hosting arriving through the back door, with adoption's grant
delivery named as the reason it couldn't simply be refused. Neither half survived Curtis
asking "tell me more about that". `serve` opens with a `wanted` gate - hosted, or followed by
someone here, or fetched before - and anything else gets a deliberately uniform empty
exchange and goes home; THAT gate is the Pull-Not-Push enforcement, sitting exactly where
doctrine says. The only branch that mints is a followed persona whose content has never
arrived, where a mirror appearing is the demand signal working as designed. And adoption
turns out to run on its own ALPN (`ringtome/adopt/0`) with its own responder, so it never
touches this door at all.

Worth keeping the shape of the error: a real minting bug was found, correctly traced to the
wake pass, and fixed - and then `create` in an unrelated function got pattern-matched to the
same bug without reading the twenty lines above it. Extrapolating from one confirmed instance
is exactly the failure mode as the two doc comments that asserted preconditions nobody
enforced; the only difference is this one was written today rather than inherited. The
NEXT_STEPS "safety" item it produced was removed, and the call-site comment now says what the
gate actually does.

The second thing was real: `cargo clippy --all-targets` had 16 pre-existing lint failures in
test code on main (this change made it 15) - `just lint` didn't pass `--all-targets`, so
test-code lints had never been gated. Decided and acted on the same day - that one
stayed in the main log, as a build-gate policy change rather than popularity work:
[`../HISTORY.md`](../HISTORY.md), "the lint gate learns about test code".
