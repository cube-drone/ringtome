# Discovery: the second-order feed

*The working plan for trust-driven discovery — how content a reader never asked for, but
plausibly wants, gets found, fetched, journaled, and shown. Settled design graduates to
[`PROJECT_PLAN.md`](PROJECT_PLAN.md) (the *Feed selectivity* and *Implicit edges* sections
are already canon); in-motion slices are mirrored in [`NEXT_STEPS.md`](NEXT_STEPS.md); this
file holds the whole arc in one place: what's built, what's next, what's far, and the
arguments that bind them.*

Design conversations 2026-08-15 → 2026-08-17.

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

## Invariants (the doctrine, restated as checks)

- **No fronting, no push participation.** Speculative mirrors serve nobody and announce
  nothing. Promotion to fronting requires a human dial.
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

1. **Rollup + acquisition.** The speculative-demand memo and the introducer-laddered
   quiet pull. Acceptance: a friend vouches for an author cora never dialed; the author's
   post appears on cora's node without cora following anyone; the author goes dark and the
   post still serves (the mirror came through the friend). Red-first, the armed-skip
   discipline if the slice waits.
2. **Speculative journal rows + provenance column.** The third reader criterion, the
   marked rows, the introducer byline. Acceptance: the row exists, is marked, names the
   introducer; an explicit dial converts it in place.
3. **The slider.** UI + read-time filtering (the six stops, Explorer default for new
   users). Depends on 1–2 for anything to show.
4. **Mirror eviction.** The retention edge this pipeline makes real for the first time:
   nothing today evicts a mirrored persona, ever. Scoped sweep: a mirror with no
   subscription, no fragment ledger row, and no rollup row is holding chains nobody wants.
   Predates this work as a gap; becomes load-bearing here.

## The farther horizon

- **Depth 3+: the edges-only appetite.** Friend-of-friend-of-friend needs FOLLOWS_PUBLIC
  chains of people nobody here syncs. Two candidate shapes, both precedented: a scoped
  sync Hello ("only these services" — additive protocol change, also what shallow-sync
  wants), or an *edges door* in the fragment-door style (one-shot anonymous ask, signed
  entries verified at the edge, no subscription). Kilobytes per hop either way; the
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
