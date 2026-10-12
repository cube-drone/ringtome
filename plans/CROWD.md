# The crowd serves

A popular persona's public lane, served by the nodes of the people who follow
it, so that being popular costs its author's node less, not more. Curtis,
2026-10-11, after cube-drone and the official Horse Drawing Tycoon 2 persona
became every new persona's starter contacts: "followers sharing popular
accounts, that's a neat project and it makes virally popular people much more
hostable on our network... it feels load bearing."

## Why

Today a follower pulls a persona only from that persona's own machinery: the
root's serving record, the address's `?via=` hints, the stored tree's leaves,
`last_via`, and as a last resort its own household (`idface.rs`
`fetch_foreign_with`, the cohort rung). Pushes go out only for personas a node
authors (`fanout.rs`: "relaying someone ELSE's lane onward is rebroadcast - a
consent question, not a routing one - and waits for its own design"). This is
that design.

The cost of that shape, worked out from the constants on 2026-10-11 rather than
measured: 100,000 desktop nodes following the starters, each re-asking whenever
its mirror is 30 minutes stale (`FOLLOW_REFRESH_STALE_MS`), with pushes capped
at 16 per move (`PUSH_DIAL_CAP`). That is about 170 exchanges a second at
horsedrawingtycoon.com, indefinitely, most of them "nothing new". On top of that
comes every newcomer's first feed pulled from the same box. Admission refuses
past 512 connections (`admission.rs`), so the box sheds load rather than falling
over. But the newcomers are the ones it sheds. horsedrawingtycoon.com is meant
to host only Curtis's accounts, so the answer can't be "run a second server".

## What canon already says

- **Serving requires no keys** (PROJECT_PLAN, _Rehosting Policy_ and the
  paragraph before it): content is signed and blobs are content-addressed, so
  any cooperating node can serve an identity's public data without being able to
  author as it.
- **Pull, not push** (_Rehosting Policy: Pull, Not Push_): "Follow is the demand
  signal: when a node's own users follow an identity, the node fronts it." A
  node is never pushed into serving anything. It can only be wanted onto it.
- **No origin server** (_Transport_): "a read is 'ask _some_ replica, verify its
  answer against `root`', not 'fetch from the authority.'"
- **Popularity = replication = availability** (_Rebroadcast: Pointer Plus Pinned
  Replica_), so far only for reposts.
- **Sealed posts are safe to carry** (_Post visibility_): a trusted-only post's
  body, title and labels are ciphertext everywhere, and "every extra carrier
  makes the post harder to lose without making it easier to read".

## What already exists

Half of this is already built.

- **The serve door already answers for followed personas.** `sync.rs` `serve`'s
  `wanted` gate serves any persona that somebody on the node follows or has
  fetched, to anyone who asks, within the public lane and the member proofs. The
  cohort rung relies on it.
- **Bodies are already fetched by hash from anyone.** The healer
  (`net/bodies.rs`) already tries askers, deliverers and device peers, and a
  wrong guess costs one dial.
- **The gate already checks everything against `root`.** It doesn't matter who
  answered.
- **Frontier fingerprints** (`net/frontier.rs`) already compare what two nodes
  hold. They record a verdict per peer: ahead, behind, or unresolvable.
- **Admission already refuses when full.** It closes the connection with `busy`
  (`p2p.rs`), so it never queues.
- **`identity_demand` already lists the crowd**: every node that asked about the
  persona in the last week.

What's missing is the client side and the relay. A follower never learns that
anyone but the author holds the persona, never asks them, and a holder never
passes a move on.

## The rulings to settle

These are proposals. Each one is marked with the question it needs answered.

1. **Who may serve: a published follow, or a crowd to hide in** (settled,
   Curtis, 2026-10-11). A node serves a persona to strangers, and is put forward
   as a holder of it, when either:
   - someone on it follows that persona with `edges_public` on. That has been
     the default tier since 2026-08-09 (PROJECT_PLAN, _Edge-Endpoint
     Visibility_), so most follows count. A rebroadcast counts too, since it is
     public by definition. Or:
   - the node serves more than **10** personas. Past that, "someone here follows
     P" could be any of them (Curtis: "the anonymizing effect of 'well, it could
     be any of these people' should do the trick"). The count is of _served_
     personas (`identity::served_roots`), not hosted ones. A prober can only
     share the suspicion among personas it can see, so a dark persona hides
     nobody. The 10 is a constant, `QUIET_CROWD`.

   Under that, a quiet follow on a small node, a desktop or a household server,
   makes the node neither a source nor a door that answers strangers. This
   narrows a door that already exists. Today `sync.rs` `serve`'s `wanted` gate
   answers anyone about a quietly followed persona, so probing a small node with
   a persona's root reads out whether someone there follows them. Its comment
   argues "only the interest our own fetch already disclosed", but that
   disclosure went to the author's node, not to whoever is probing.

   **Narrowed, not shut.** The door must still answer the nodes that already
   know. That covers the household (member-proven, the cohort rung), and every
   node this node has itself asked about the persona: the author's node pushing
   a new post, a holder relaying one (ruling 5). Without that, a quiet
   follower's own fetch would turn away the push it set up. "Asking is telling"
   (`demand.rs`) runs both ways: a node we asked about P learns nothing new when
   we answer it about P. That means keeping a record of whom we've asked:
   `last_via` covers the author's side, and the holders memo (ruling 2) covers
   the crowd. A stranger asking about a persona we only follow quietly gets the
   polite empty exchange, the same answer as "nobody here has heard of them".

   This narrowing is a privacy fix that stands on its own. It lands as the first
   slice, before anything starts handing out holders.

2. **Finding holders: the author's node refers.** A follower that wants to serve
   says so in its Hello (`holds: true`, a new trailing field: older Hellos
   decode it as false, the way `wanted`, `ceiling` and `instances` arrived).
   The responder records it on the `identity_demand` row. When the author's node
   answers, a new trailing field in its Hello carries up to 8 recent holders for
   the persona. The follower keeps them in a per-persona `holders` memo in
   `node.db`, with the same 7-day retention as demand.

3. **A refusal refers too.** A brand-new node has no memo, and the busy refusal
   is exactly when it needs one. So admission's `busy` close carries holders in
   its reason bytes (a QUIC close reason fits the 8 × 32 bytes easily). It costs
   the refusing node a lookup and no seat. The catch: admission refuses before
   the Hello, so it doesn't yet know which persona was wanted. It can send the
   holders of the personas this node authors and has the most askers for. On
   horsedrawingtycoon.com those are the starters, the only personas a crowd
   forms around. _Open: whether to stop at that, or give the refused a cheap
   "which persona?" frame before closing._

4. **The ladder's new rung: holders, before the household.** The order is the
   persona's own machinery, then holders, then household. The own rung still
   races first and wins when it answers. `last_via` keeps meaning "the author's
   authority" and is never written by a holder (`fetch_foreign_with` explains why
   that matters: replies, the shelf and bodies behind a ceiling ask `last_via`
   next). A fetch won by a holder is recorded as served by the crowd, not as an
   authority.

5. **Holders pass moves on.** A holder whose public frontier for a persona moves
   pushes to its own askers, as the author does: capped at 16, recent askers
   first, devices excluded, on the fold's frontier edge. It converges because an
   exchange with an up-to-date node transfers nothing. Relays ride the lazy tick
   and never the write bell (the resync damping). With 16 per hop, 100,000
   followers are four or five hops from the author. This is the freshness half:
   most mirrors hear of a post through the crowd before their 30-minute wake
   pass would have asked.

6. **The wake pass asks a holder first, and the author now and then.** For a
   persona with a holders memo, the staleness pull goes to a holder. Holders can
   only hold back, never forge. A holder that is behind gives you less, and a
   retraction it hasn't heard of stays visible a little longer. So every Nth pass
   (or once the author has gone a few hours unasked) goes to the persona's own
   machinery. That puts a ceiling on how long a mirror can go without the
   author's word. _Open: N, or a time._

7. **Bodies.** The holders memo becomes a candidate source in `bodies.rs` (the
   healer and `heal_from`), after the deliverer rung. That needs nothing new on
   the wire: a blob fetch is a hash, so any holder that has the bytes serves
   them.

8. **What a holder serves is what it holds.** That's the follow ceiling's suffix
   (5,000 posts), not genesis. It never includes a private chain (member proofs,
   unchanged), and sealed posts go out as ciphertext. A peeked persona is never
   served from the crowd. Peek depth is "nobody here dials them", so ruling 1
   already excludes it. A requester that wants history beneath a holder's floor
   asks the author (scrollback's backfill already does that).

9. **An operator's switch.** `RINGTOME_SERVE_CROWD` (default on) turns holding
   off for a node: it stops sending `holds` and its door stops answering
   strangers for personas it only follows. The household path is unaffected. A
   node on a metered link or a phone may want it off. Only the operator gets
   this switch. A person doesn't get one of their own, at least for now
   (Curtis, 2026-10-11: "I don't think that a personal off switch is worth
   building yet").

## What it costs

- **Serving nodes.** Under the cap, a holder answers the strangers referred to
  it: up to 8 of them get its endpoint per referral, spread across the most
  recent holders. A popular persona's load lands on its followers in proportion
  to how recently each asked. Admission bounds each holder exactly as it bounds
  the author.
- **Disclosure.** A holder's endpoint id goes to strangers as "this node serves
  P". The follow is already public (ruling 1). What's new is that this node is
  linked to that follow. On a multi-tenant node that says little. On a
  single-person desktop node it says "this computer belongs to a follower of P".
  That's the colocation trade PROJECT_PLAN already names (_crowd of the nodes
  serving it_), and it's why ruling 9 exists.
- **Staleness.** Bounded by ruling 6's author pass, and shortened in practice by
  ruling 5's relay.

## Slices

1. **The narrowed door** (ruling 1). `serve`'s `wanted` gate answers for a
   persona that is followed only quietly when the node serves more than
   `QUIET_CROWD` personas, or when the asker is household or a node we asked
   about that persona. Two claims, on a node serving fewer than 10 personas.
   First, a stranger probing a persona someone there follows quietly gets the
   empty exchange. Second, the author's push still lands. Before it starts,
   Curtis settles the open questions in 3, 6 and 9.
2. **The wire.** `holds` and the holders list as trailing Hello fields in
   `proto/src/sync.rs`, with round-trip tests including the old arity. The
   demand row gains `holds`, as a migration rung.
3. **The memo and the rung.** Store referrals, then add the holders rung to
   `fetch_foreign_with` with its own source record. The acceptance claim: A
   authors, B follows (published), and C follows through A's address with A's
   admission held at zero (a test knob, like `shelf-stall`). C still gets A's
   posts, from B.
4. **Relay.** Lift the authored-only push in `fanout.rs` to "authored, or held
   under ruling 1". The claim: A posts, A's push reaches B only (cap 1 in the
   test), and C has the post from B without a wake pass.
5. **The wake pass's order** (ruling 6). The claim: a holder that is behind
   doesn't keep C behind past the author pass.
6. **Bodies** (ruling 7). The claim: A is dark, and C still gets an image body
   from B.
7. **The busy referral** (ruling 3). The claim: a brand-new D refused by A
   reaches B through the close reason.

The two-node rig can't show load. What it can show is the fallback working when
the author refuses, which is the behaviour that matters. The load figures in
_Why_ stay arithmetic until the network is big enough to measure.
