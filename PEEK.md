# PEEK - looking at a stranger without adopting their history, and public pins

Curtis's brief (2026-09-05): a first look at a persona nobody here follows must not mirror
their whole public object. Today it does: the lens page's foreign fetch runs the ordinary
sync exchange from empty frontiers, which is sent the entire public lane - identity, posts,
annotations, profile, rebroadcasts, whole - and then the missing-bodies walk fetches every
body those entries name. The page shows twenty recent posts; the mirror holds a lifetime.
The door refuses unsolicited pushes (the responder's consent gate), so nobody can knock
their way in - but the UI makes it very easy to *ask*, and a quietly malicious persona,
peeked or followed once, can fill the disk with nothing standing in its way but bandwidth.

Two things to fix, in this order: **every exchange gets a budget**, so no single ask can be
staggering; and **a peek is a shape, not a mirror** - identity, annotations, the newest
twenty posts and up to twenty pinned ones, carried as fragments that prove themselves, with
a footprint ceiling and an expiry. **Public pins** are the third thing and the arc's
customer (Curtis, same day): the private pin holds a note to the top of the Writer's
finder; the public pin holds a post to the top of the author's page, and a peek must fetch
pinned posts ahead of the window, however deep in the history they sit. PROJECT_PLAN's "Shallow Sync and the Day-Long-Sync
Problem" designed the suffix machinery this leans on; the fragment lane (Rebroadcast) and
the annotation-proof road (ANNOTATIONS.md slice 3) are the parts already built.

## What the exchange bounds today (measured 2026-09-05)

| bound | value | covers |
|---|---|---|
| sync frame | 256 KB | one message, never the stream |
| blob | 16 MB (`max_document_bytes` + framing) | one body, never the count |
| peer pass | 30 s | the caller's WAIT - the exchange detaches and runs to Done |
| entries per exchange | none | |
| bytes per persona | none | |
| free-disk check | none | |
| retention | inbox tiers only | public chains are never pruned; eviction fires only when nobody wants the persona |

Memory is flat (ingest holds one batch behind the per-identity lock, validating every
entry). Disk is not, and an infinite chain never sends Done. Identity chains must linearize
from genesis by design, so a huge one cannot even be truncated; whether any later check
walks it per entry is unmeasured (residual).

## Rulings (proposed 2026-09-05; Curtis's numbers are the default dials)

1. **Three depths, chosen by relationship, never by the peer.** *Hosted*: this node's own
   charge, whole. *Followed*: somebody here turned a dial; chains whole (today), converging
   over budgeted passes, a storage ceiling to come (ruling 8). *Peeked*: nobody here follows
   them; a shape, below. The depth is a fact about OUR relationships, decided at our door -
   what the peer offers never widens it.
2. **Every exchange has a budget** in entries and bytes, at every depth. The requester
   stops at the budget, says Done, and remembers it is behind (a "more" mark on the chain
   memo); the next beat continues from the frontier, exactly as anti-entropy already
   converges. An honest decade arrives over passes; a staggering one arrives at a pace the
   node chose; an infinite one is cut every time. The responder is bounded too: it serves at
   most a budget per exchange, whatever the requester's frontiers claim.
3. **Identity chains: whole, first, and capped.** Authority context is never shallow - but
   no persona has a million devices. Above a hard ceiling (dial; proposal 10k entries or
   16 MB) the persona is refused as malformed, at the gate, before storage. This closes the
   identity variant of the infinite chain with a number rather than a hope.
4. **A peek is: identity whole, profile whole, annotations whole under the ceiling, pins as
   proofs, the newest twenty posts and up to the twenty most recently pinned as fragments,
   bodies on demand.** The posts never come off the posts chain - they come through the
   fragment door, each header its own signed entry with its delegation path, each carrying
   its own annotation proofs (the `Have` answer already does). The annotations chain is
   synced whole because it is small and because a suffix of a last-writer-wins fold is
   silently wrong, not stale; if it exceeds the peek's ceiling it is refused and the labels
   on the visible posts still arrive by proof. Pins are a keyed proof query ("this author's
   `pin` statements"), so they never need the chain either.
5. **Bodies follow the eye.** A peek fetches the words of its posts and their thumbnails;
   media arrives when a reader opens it, within the peek's ceiling. A follow fetches
   newest-first under its own ceiling (ruling 8). The 16 MB blob cap stays.
6. **A peek has a footprint and an expiry.** Per-peek byte ceiling (dial; proposal 64 MB -
   Curtis's arithmetic: forty posts of fifty 10 MB files is twenty gigabytes, which no
   stranger is owed); a node-wide peek budget, evicted least-recently-looked first; and a
   last-look expiry (dial; proposal 7 days). The `foreign_fetches` registry becomes the
   peek registry, carrying last-look and bytes; eviction takes the chain files and the
   fragments; the reaper collects the blobs it already owns.
7. **Promotion is the follow dial.** Turning a dial on a peeked persona is the demand
   signal the doctrine names; the ordinary follow machinery takes over and the peek's
   fragments are superseded by the mirror. Nothing a peek fetched is wasted: fragments
   already sit beside mirrors and the body route reads both.
8. **A follow has a ceiling too (later).** The same attack through the follow dial - "the
   UI makes it very easy to trigger a sync" - is bounded per pass by ruling 2 today, and
   per persona by a storage dial once content chains can be HELD as suffixes: the posts
   chain kept from a floor with the oldest held entry's `prev_hash` committing to the
   prefix (the plan's shallow sync, `service_allows_suffix` widened - "a design act", done
   here on purpose). Fold-based views under a suffix want snapshots; that residual stands.
9. **Render at first entry.** The lens page shows what is in hand and says what it is: a
   peek reads "a look at their newest posts - follow them to keep up" in the house voice,
   never a spinner over a mirror.
10. **Trusted-only is unchanged.** A sealed post peeked shows its title and refuses its
    body, as everywhere.
11. **A public pin is a public annotation.** The author says `pin` about their own post on
    the annotations lane - one signed statement, last-writer-wins per target, retracted to
    unpin - and it travels wherever the author's chains and proofs travel, with no change to
    the wire. Only the AUTHOR's pin is honoured: anyone else's `pin` is a label like any
    other, shown by the display rule or not, never a placement. Books pin like posts; a
    sealed post pins like an open one (its title shows, its body refuses).
12. **Pinned first, in place still.** The author's page opens with the pinned strip - most
    recently pinned first, capped at twenty - above the chronological shelf, which is
    unchanged: a pin is a highlight, not a move, and a pinned post keeps its place in
    history and its date. A pinned post wears a pin chip wherever its card shows. The pin
    itself is set from the post's own page and from the feed card's author affordances
    (beside the note-pencil), never from the Writer: the private pin and the public pin are
    two facts about two different shelves and neither implies the other.
13. **Pinned posts are fetched first, at every depth.** A peek asks for the author's pin
    proofs before anything else and fetches the pinned ids as fragments beside the newest
    twenty (ruling 4). A follow's missing-bodies walk takes pinned ids first, so on a slow
    link the top of the page fills before the backlog. Under the follow ceiling (ruling 8)
    a pinned post below the floor is acquired by id over the fragment road, never by
    deepening the chain.

## Consequences worth saying out loud

- Speculative acquisition (Discovery slice 1) is a fourth road into a mirror and has a
  count budget, not a byte one. It inherits ruling 2 for free and wants ruling 6's ceiling
  as a residual.
- The 30-second pass timeout keeps detaching; with ruling 2 the detached task is bounded
  by bytes rather than by hope.
- A responder's per-exchange budget means a follower of a prolific author sees the shelf
  fill over minutes, newest first. That is the plan's "render at first entry" rule paying
  its bill.

## Invariants

- No exchange, at any depth, transfers more than its budget; no chain grows past its
  ceiling on a node that did not host it.
- A peek never holds a posts chain; every post it holds proves itself alone.
- Depth is decided by this node's relationships and never by anything the peer says.
- Refusal is uniform: a persona over its identity ceiling gets the same silence a stranger
  does.

## Slices

1. **Budgets.** Per-exchange entry and byte budgets on both sides (dials, test knobs), the
   "behind" mark and the beat that continues, the identity-chain ceiling at the gate.
   Acceptance: a five-thousand-entry chain arrives whole over several passes; a stream that
   never ends is cut at the budget every pass and the node stays healthy; an identity chain
   over the ceiling is refused and nothing of it is stored.
2. **The peek.** The foreign fetch becomes a scoped exchange (identity, profile,
   annotations) plus a `Shelf` fragment request answering the newest N post proofs and the
   author's pin proofs, then `Want` per post; the lens page and the profile read merge
   mirror and fragments; bodies on demand. Acceptance: a stranger with two hundred posts is
   looked at, twenty arrive as fragments with their labels, no posts chain exists here, the
   page renders and says it is a peek.
3. **Footprint and expiry.** The peek registry with last-look and bytes; per-peek and
   node-wide ceilings; least-recently-looked eviction and the expiry; media on demand under
   the ceiling. Acceptance: a peek past its ceiling stops fetching media and says so; an
   unlooked-at peek is gone after the expiry; a follow dial promotes a peek to a mirror.
4. **Pins.** The `pin` statement and its retraction (route, button on the post page and the
   feed card, the chip); the pinned strip on the author's page, read from the annotations
   memo; the pin proofs in the `Shelf` answer and the pinned ids fetched beside the window;
   the missing-bodies walk ordered pins-first. Acceptance: an author pins a post two hundred
   deep, a follower's page shows it first and its body arrives before the backlog, a
   stranger's peek fetches it as a fragment with its labels, unpinning drops it from the
   strip everywhere while the post stands.
5. **The follow ceiling.** Content chains held as suffixes from a floor; bodies newest-first
   under a per-persona dial; a pinned post below the floor acquired by id; the snapshot
   residual named where it bites. Acceptance: a follow of a prolific author holds its
   ceiling's worth, the oldest held entry commits to the prefix, a pin below the floor still
   heads the page, and scrollback backfills on demand.

## Residuals named at the start

- Measure whether any check walks an identity chain per entry; the ceiling makes it
  bounded, not cheap.
- The speculative lane's byte ceiling.
- Snapshots for fold-based views under a suffix (IM-AOL open items).
