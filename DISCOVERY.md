# Discovery: the second-order feed

*The working plan for trust-driven discovery — how content a reader never asked for, but
plausibly wants, gets found, fetched, journaled, and shown. Settled design graduates to
[`PROJECT_PLAN.md`](PROJECT_PLAN.md) (the *Feed selectivity* and *Implicit edges* sections
are already canon); in-motion slices are mirrored in [`NEXT_STEPS.md`](NEXT_STEPS.md); this
file holds the whole arc in one place: what's built, what's next, what's far, and the
arguments that bind them.*

Design conversations 2026-08-15 → 2026-08-17; the speculative pass (one handshake, two
depths) merged in 2026-08-21.

## The problem

Fan-out delivers what was asked for. Every byte a node holds arrived because one of its
own users expressed demand — a follow, a rebroadcast-follow, a share fetched on a
followed sharer's say-so. Discovery is, by definition, the content that was *not* asked
for: the friend-of-a-friend's posts, the stranger three vouches deep whose taste keeps
being vouched for. Two gaps stand between the reader and that content:

1. **The names gap** — who are the candidates even? Solved (2026-08-16): the
   `edge_graph` / `implicit_edges` pair, below.
2. **The bytes gap** — knowing a candidate's name does not put their chains on this
   node, and nothing pushes them here: fan-out only ever pushes to nodes that asked.
   This is the pipeline this document plans.

## Foundations already built

- **First-order memos.** The contact ledger (each persona's own dials, private, chain-
  authored) → `subscriptions` (node-level routing memo, trust column consent-gated).
- **`edge_graph`** (node.db, 2026-08-16) — the assembled second-order graph: what synced
  personas say *publicly* about each other, one row per published statement, mirrored from
  each persona's `published_edges` view on the FOLLOWS_PUBLIC frontier-move edge.
  Second-order where `subscriptions` is first-order; consented by construction; a cache of
  public speech, not a new disclosure.
- **`implicit_edges`** (per-persona db, 2026-08-16) — the composition: my dial toward a
  friend × their published band toward a stranger, min of the two, per
  `(target, lane, introducer)`. Trust lane through my trust dial; taste lane through my
  REBROADCAST dial (an implicit follow is a taste judgment). Raw ingredients on every row
  (depth, level, introducer, introducer's vouch count) so promiscuity discounts and
  rollups happen at read time. Lives in the *user* database because the reader's side of
  the composition legitimately uses their private trust dial, and a level derived from a
  withheld dial must not leave their own file. Served raw at
  `GET /api/identity/{root}/implicit`.
- **The introducer door.** Two standing facts make acquisition cheap: a friend's node
  *fronts everyone that friend follows* (pull-not-push: follow is the demand signal), and
  the sync door already answers **anonymous** asks for any persona somebody at the
  answering node follows (`serve`'s `wanted` gate). So a friend-of-a-friend's chains are
  one dial away — to a node we already dial. The demand tree is the discovery tree. The
  cohort slice (2026-08-15) proved this exact pattern one hop closer to home.

## The pipeline: four stages

### 1. Demand — the speculative rollup

A node-level rollup over hosted readers' `implicit_edges`: top-K targets per reader by
composed level (promiscuity-discounted, MAX across introducers, never sums), capped by an
**acquisition budget** — the bound on how many strangers' chains this node will hold on a
reader's behalf, no matter how bushy the friends' vouching gets. A memo like every other:
disposable, stamp-swept, and decay is free — when the implicit inputs recede (vouch
withdrawn, dial dropped, budget squeezed), the rollup row recedes and the mirror stops
being refreshed.

The rollup carries the *best introducer* per target alongside the score, because the
introducer is the dial target in stage 2 and the byline in stage 3.

### 2. Acquisition — quiet pulls through the introducer

For each speculative root, the wake-pass ladder (idface) runs with the candidate order:
**introducer's endpoints first** — their node provably fronts the target, and asking a
friend discloses only to that friend — then the target's own serving records as fallback.
Same `sync_with_peer`, same gate validating everything, same mint-only-on-substance
behavior (the shelf is minted only when the peer's Hello claims something to put on it).

The mirror is **quiet**: no serving record published, no fronting, no entry in anyone's
peer mesh. And it stays *polled*: `push_to_askers` fires only for personas a node
authors, so the introducer's node will never push the target's updates onward — freshness
for speculative content is our own cadence, on a slow beat with a small per-beat cap
(the `FOLLOW_REFRESH_CAP` discipline at lower priority than real follows). Speculative
content is allowed to be hours stale; that is part of what makes it cheap.

The dialer itself — the lanes, the reciprocal door, the headers tier it shares — is
specified in *The speculative pass* below (2026-08-21): this stage is that pass running at
posts depth.

### 3. Journaling — speculative rows with provenance

`journal_for` gains a third reader criterion beside followers and share-followers: readers
whose speculative rollup admits this author. Rows are marked speculative and carry the
introducer as provenance (`via_root`'s sibling — "suggested via Mara"), which the UI
needs for the explanation line and the slider needs as a filter key. History for
speculative pairs is the newest page only — the burst-to-bound with no year dig; the
history courtesy belongs to chosen relationships.

### 4. Attention — the slider reads, and only reads

The feed-selectivity slider (PROJECT_PLAN, *one slider, two budgets*) filters journaled
speculative rows at read time: Explorer shows the pool, stricter stops hide it, and moving
the slider re-fetches nothing because acquisition (what we hold) and attention (what we
show) were split on purpose. Effective-interest precedence as designed: explicit author
dial → sharer dial → path score → floor.

## The speculative pass: one handshake, two depths

*(Merged design, 2026-08-21. One mechanism replaces two would-be schedulers — stage-2
acquisition for posts, and a separate slow header sync for tier-2 legibility.)*

Two appetites want the same door. The pipeline spends its acquisition budget on content —
recent posts for the top-K strangers a reader plausibly wants to *read*. But most of
tier-2 will never crack the top-K, and the node knows nothing about them beyond an edge
row: no claimed name, no avatar, no follows of their own. The people page's "suggested
via…" renders identicons and hex; search over visible people has nothing to match; the
rollup picks its top-K knowing nothing about candidates but their edge rows. The fix is
cheap by the chain-per-service split's own design — identity-public, PROFILE_PUBLIC, and
follows-public are kilobytes per persona — and it wants exactly the same introducer
ladder, the same quiet-mirror rules, and the same slow beat as the posts appetite. So: one
pass, one dialer, and the only per-target question is **depth**.

**The unit of work is the introducer, not the edge.** The pass groups the work queue by
introducer node — one connection to a friend's node services every vouched stranger
behind it, up to the per-visit cap. A weighted draw picks which friend to visit; the visit
drains that friend's slice of the queue. Weights are per *target* — deduped, MAX across
introducers — never per raw edge, and visits are capped per introducer per beat, so an
edge-minting adversary buys neither tickets nor monopolies.

**Depth comes from the memo, never the dice.** For each target serviced, the speculative
rollup row answers the only policy question: admitted under the acquisition budget →
headers plus the newest posts page; otherwise → headers only. The dice order visits; the
memo decides what is held and refreshed. (If the draw also chose whose posts survive the
budget, sampling weight proportional to edges would be a sum in disguise — a thousand
Sybil vouches, a thousand lottery tickets.)

**Two lanes inside the one pass.** Speculative content is allowed to be hours stale — but
under a pure weighted walk over a growing tier-2 pile, "hours" quietly becomes weeks:
expected revisit time scales with pile size. So the per-beat quota splits: a small
deterministic lane round-robins the top-K by staleness (the `FOLLOW_REFRESH_CAP`
discipline, below real follows), and the weighted-random lane services the long tail's
headers. Same protocol, same ladder, one dialer — the lanes are only how the quota is
split.

**The wire is the scoped sync Hello.** "Only these services" — the additive protocol
change shallow-sync and the depth-3 appetite already want; this pass is its first
consumer. Asks go through the standing anonymous door (`serve`'s `wanted` gate),
introducer's endpoints first, the target's own serving records as fallback. One honesty
note on "anonymous": iroh authenticates both endpoints' node keys, so the answering node
always knows *which node* asked. What stays undisclosed is everything above the node — no
subscription, no persona, no serving relationship — and answers come only from what the
answerer already publicly fronts.

**The knock is the peer's opportunity — symmetric pull, nothing volunteered.** The visited
node likely has its own edge pile pointing back at us; an open connection lets it service
its own queue in the same session — its asks, chosen from its own memo, at its own depth.
That is not the exchange we decline: no node ever *offers* its inventory or its interest
list, because a speculative pile volunteered is a shadow of readers' implicit edges pushed
outward. Each side discloses only its own asks, each ask its own choice. Three guardrails
hold it:

- **Answered from the fronted set only.** Reciprocal asks pass the same `wanted` gate as a
  cold knock; speculative and non-resident mirrors are never behind that door. This is the
  invariant reciprocity actually tests: if "do you hold X?" could be answered from the
  quiet pile, the pile stops being quiet — a peer could probe out the very interest shadow
  we refused to volunteer.
- **Every ask is queue-derived.** "Everything you carry that I want" means everything *in
  my memo-derived queue routed through you*, up to the per-visit cap — never an
  opportunistic hoover of whatever a warm connection makes reachable.
- **An open connection is an opportunity, not an obligation.** Caps hold in both
  directions: reciprocal asks are served under the same budget as cold knocks (dialing
  first buys no extra work from the answerer), and the knocked-on node piggybacks at most
  its per-visit quota, deferring the rest to its own beat.

**Non-resident: a fetch is not a membership ceremony.** Headers-depth targets land in a
new mirror state — chains held, no fronting, no serving record, no push participation,
invisible to the peer mesh, excluded from hosted-persona counts, no freshness promise,
freely evictable. Three dividends per kilobyte: *legibility* (names, avatars, bios for
everyone the implicit edges can surface), *depth-3 fuel* (their follows-public chain feeds
`edge_graph` another persona's published edges — the farther-horizon edges-only appetite
arriving early), and *proof* (the stranger's own identity chain verifies their signed
statements, rotations, and revocations directly, instead of through the introducer's
mirror — the "hints are dirty, proofs are signed" discipline needs this anyway). When the
supporting edge recedes, the refresh row recedes and the mirror ages toward eviction —
"non-resident with no supporting tier-2 edge" is slice 4's easiest predicate.

**"Last seen" is a local observation** — the last successful sync and via whom, never
presence. A mirror refreshed only through the introducer speaks to the friend's freshness,
not the stranger's.

**Promotion is the same clean exit.** A real dial flips non-resident (or speculative) to
an ordinary subscription; the persona leaves this regime entirely.

Two build-time honesty notes: the `wanted` gate answering a *scoped* Hello is new code
(the gate exists, the scoping does not), and "excluded from hosted-persona counts" states
intent against storage-management surfaces that do not exist yet.

## Invariants (the doctrine, restated as checks)

- **No fronting, no push participation.** Speculative and non-resident mirrors serve
  nobody and announce nothing. Promotion to fronting requires a human dial. Reciprocity is
  the test: a peer's ask against the quiet pile returns nothing, or the pile isn't quiet.
- **The dice order visits; the memo decides retention.** Weighted randomness paces the
  pass and nothing else — membership of every held-and-refreshed set derives from the
  current edges, top-K by best composed level, and recedes with them.
- **Disclosure stays in-relationship.** The introducer learns we asked; the stranger
  learns nothing until their own machinery is dialed as fallback. Never dial the target
  first when an introducer path exists.
- **MAX across introducers, never sums** — per-introducer rows all the way down; a
  thousand Sybil vouches are worth one best path.
- **Explicit beats implicit; blocked beats everything** — at read, and at the fold.
- **Budgets are caps, not pacing suggestions.** Acquisition budget bounds mirrors;
  attention floor bounds rows shown; both hold under adversarial vouching.
- **Promotion is clean.** The moment a reader turns a real dial on a surfaced persona, the
  pair leaves this pipeline entirely: ordinary follow, ordinary push demand, ordinary
  history dig (the year), ordinary fronting rules.

## Slices, in order

1. ~~**Rollup + the pass at posts depth.**~~ Built 2026-08-22 (`speculative.rs`, node gen
   25; acceptance green in `speculative.cjs`, red-first). The build's field findings, now
   doctrine: **outward surfaces speak with a held chain's authority only under a freshness
   contract** — hosted, member-fetched, or followed; a hunch-held mirror (orphans included)
   is invisible to the fragment door and fragment-first on the member surfaces, or a stale
   mirror shadows truths the node already holds. **Beat-driven machinery never dials an
   unresolved identity key**, and **deadlines detach, never cancel** — an aborted exchange
   leaves zombie connection state that starves the fan-out behind it. Full ledger in
   HISTORY, 2026-08-21/22.
2. ~~**Speculative journal rows + provenance column.**~~ Built 2026-08-24
   (`feed_journal.suggested_via`, node gen 27; acceptance green in `speculative.cjs`,
   red-first, the conversion cop planted-red in `fanout::tests`). The third reader
   criterion rides `journal_for` beside followers and share-followers; speculative rows
   take the NEWEST PAGE ONLY (the history courtesy belongs to chosen relationships);
   `ON CONFLICT DO NOTHING` is the whole precedence ladder one way and
   `suggested_via = NULL` in the real upsert is the other - any real arrival converts in
   place, speculation never downgrades, and between two introducers the first keeps the
   byline (via_root's own first-sighting rule). The feed shows the rows with a
   "vouches for this author" line pending the slider; withdrawn vouches leave rows
   standing for slices 3-4 to hide and evict.
3. ~~**The slider.**~~ Built 2026-08-24 (`pure/selectivity.js`, spec-first in the pure
   suite; the six stops verbatim, Explorer default; position a persona-level private
   register - `feed_selectivity/stop` - so selectivity syncs with the person). Pure
   attention: client-side floor over the journaled rows, network-silent both ways. The
   effective-interest precedence (author dial → sharer dial → path band → floor) filters
   AND sets emphasis - speculative rows arrive small and quiet whatever their path score -
   and the feed ships `suggested_level` (the rollup's discounted band, read-time joined)
   as the path rung's input. Today's one speculative pool means 'highly speculative' and
   'Explorer' differ from 'speculative' only by path strength; the deeper stops light up
   as their pools land, as designed.
4. **Mirror eviction.** The retention edge this pipeline makes real for the first time:
   nothing today evicts a mirrored persona, ever. Scoped sweep: a mirror with no
   subscription, no fragment ledger row, and no rollup row is holding chains nobody wants.
   Predates this work as a gap; becomes load-bearing here. First customer: "non-resident
   with no supporting tier-2 edge."
5. **The headers depth** (order-independent of 2–3; pairs with 4; gates on the scoped sync
   Hello). Non-resident mirrors, the weighted-random lane, the reciprocal door.
   Acceptance: a friend-of-a-friend cora never dialed shows a claimed name and avatar on
   the people page; their published follows land in `edge_graph`; a reciprocal ask against
   a speculative or non-resident mirror returns nothing; withdrawing the friend's vouch
   ages the mirror out; at no point does the stranger's node learn cora's node exists.

## The farther horizon

- **Depth 3+: the edges-only appetite.** Friend-of-friend-of-friend needs FOLLOWS_PUBLIC
  chains of people nobody here syncs. Two candidate shapes, both precedented: a scoped
  sync Hello ("only these services" — additive protocol change, also what shallow-sync
  wants, and what the speculative pass's headers depth builds first), or an *edges door*
  in the fragment-door style (one-shot anonymous ask, signed entries verified at the
  edge, no subscription). Kilobytes per hop either way; the
  introducer-relay logic unchanged (the friend holds the FoF's edge chain too).
- **Same-network detection at depth ~6.** Bidirectional search halves the exponent;
  published neighborhood sketches (a Bloom of "roots within k hops", minted onto the
  chain like PublicEdge statements, union-merged by gossip) make "are we connected at
  all?" a one-fetch intersection, with witness candidates falling out of the overlap.
  Hints are dirty, proofs are signed: any claimed path verifies as a walk of signed
  FOLLOWS_PUBLIC statements, so poisoned sketches buy nothing. Sociological caveat that
  reshapes the feature: connectivity *saturates* (small-world giant component — nearly
  everyone is within six hops of nearly everyone), so the boolean is mostly useful as its
  negative ("no known connection" on a stranger's knock is the strong signal), and the
  real question is **path quality and independence** — min-band along the path,
  vertex-disjoint path count — which is advogato joint flow over the small subgraph the
  bidirectional walk already gathered. Natural first consumer: the first-contact inbox
  kind ("distantly vouched: three independent paths, weakest link medium, nearest witness
  someone you know").
- **Adversarial simulation** (NEXT_STEPS, Trust): the budgets and discounts above hold by
  argument; a simulated hostile graph is what turns the argument into a regression test.

## What this deliberately is not

Not a recommendation engine: no engagement signals, no popularity inputs, no per-person
sums anywhere — every surfaced item traces to *named humans the reader chose to trust*,
with the chain of vouches printed on the row. The system can always explain a suggestion
in one sentence, and the sentence names people, not scores.
