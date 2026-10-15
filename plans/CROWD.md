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
   know. Without that, a quiet follower's own follow would turn away the push it
   set up. The nodes that already know are:
   - the household, the cohort rung's machines, bound to one of our personas by
     a ceremony;
   - the persona's own nodes, proven by the member proof every requester already
     sends for a persona it agents. This covers the author's node pushing a new
     post.
   - later, the holders this node has asked about the persona, when relays
     arrive (ruling 5). "Asking is telling" (`demand.rs`) runs both ways: a node
     we asked about P learns nothing new when we answer it about P. The holders
     memo (ruling 2) is the record of whom we asked.

   A stranger asking about a persona we only follow quietly gets the polite
   empty exchange, the same answer as "nobody here has heard of them". The same
   rule holds at the fragment door: its shelf question and its one-document
   question, which would otherwise answer the same probe. One exception there: a
   document a persona here _shares_ is answered to anyone. The share is public,
   and its readers come to the sharer for the words.

   This narrowing is a privacy fix that stands on its own. It lands as the first
   slice, before anything starts handing out holders.

2. **Finding holders: the author's node refers.** A follower that wants to serve
   says so in its Hello (`holds: true`, a new trailing field: older Hellos
   decode it as false, the way `wanted`, `ceiling` and `instances` arrived). The
   responder records it on the `identity_demand` row. When the author's node
   answers, a new trailing field in its Hello carries up to 8 recent holders for
   the persona. The follower keeps them in a per-persona `holders` memo in
   `node.db`, with the same 7-day retention as demand.

3. **A refusal refers too.** A brand-new node has no memo, and the busy refusal
   is exactly when it needs one. So admission's `busy` close carries holders in
   its reason bytes. It costs the refusing node a lookup and no seat. Admission
   refuses before the Hello, so it doesn't yet know which persona was wanted.
   **The reason therefore carries one short list per persona** (settled
   2026-10-11): the 3 personas this node authors that have the most askers, with
   up to 4 holders each. That is about 480 bytes, well within one close frame.
   The refused node takes the list for the persona it wanted and ignores the
   rest. On horsedrawingtycoon.com the 3 are the starters, which are the only
   personas a crowd forms around.

   Reading a "which persona?" frame before closing was turned down. Waiting for
   that frame holds a seat open for a stranger, and an open seat is what a flood
   is after. A single list shared by every persona was turned down too: on a
   node with two popular personas, it sends half the refused to the wrong crowd.

4. **The ladder's new rung: holders, before the household.** The order is the
   persona's own machinery, then holders, then household. The own rung still
   races first and wins when it answers. `last_via` keeps meaning "the author's
   authority" and is never written by a holder (`fetch_foreign_with` explains
   why that matters: replies, the shelf and bodies behind a ceiling ask
   `last_via` next). A fetch won by a holder is recorded as served by the crowd,
   not as an authority.

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
   retraction it hasn't heard of stays visible a little longer. **So once the
   author has gone 6 hours unasked, give or take a quarter, the pull goes to the
   persona's own machinery** (settled 2026-10-11). That caps how long a mirror
   can go without the author's word.

   It is measured in time, not passes, because the cadence of passes follows how
   long a laptop sleeps, while the thing worth promising is how long a
   retraction can stay visible. The random quarter matters more than the 6: a
   burst of newcomers who all joined in the same minute would otherwise come
   back to the author together, every 6 hours, for good. At 100,000 followers of
   3 starters it works out to about 14 exchanges a second at the author's node,
   against today's 170.

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
   this switch. A person doesn't get one of their own, at least for now (Curtis,
   2026-10-11: "I don't think that a personal off switch is worth building
   yet").

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

1. **The narrowed door** (ruling 1). **Built 2026-10-11.** The rule lives in
   `crowd.rs`. `subscriptions.public` (rung 82) marks the published follows. The
   sync door's `wanted` gate and the fragment door's shelf and document answers
   apply the rule. The claims are in `integration/test/crowd.cjs`, on a node
   made small by `test/quiet-crowd`, probed by `test/door-probe`:
   - a stranger hears nothing about a quiet follow;
   - the author's push still lands;
   - a published follow opens the door;
   - a crowd opens it too.

   The first two were each shown failing with their mechanism removed.

2. **The wire.** **Built 2026-10-11.** The Hello gains one slot, `crowd`
   (`Crowd { holds, holders }`, arity 10, at most 8 holders). Its tests check
   the round trip, an arity-9 Hello reading as the default, and both caps.
   `identity_demand.holds` keeps each asker's word (node rung 83).
   `RINGTOME_SERVE_CROWD` (ruling 9) is built too: off, a node neither answers
   strangers about what it follows nor says it holds anything.
3. **The memo and the rung.** **Built 2026-10-11.** `crowd_holders` (rung 83)
   keeps referrals, believed only when the member proof shows they come from one
   of the persona's own nodes. That check runs after the ingest, because a first
   fetch has no key tree to check the proof against until the identity chain has
   arrived. The fetch ladder asks the holders after the persona's own nodes and
   before the household. A crowd win never writes `last_via`.

   Three claims in `crowd.cjs`:
   - the author's node keeps B's `holds`;
   - it names B to C;
   - with A unplugged, C gets ada's new post from B, and `last_via` is
     unchanged.

   Unplugging stood in for the admission knob. C's inbound door is shut while
   ada posts, because her own push otherwise carries the post to C at once,
   which is how the first version passed with the crowd round taken out.

4. **Relay.** **Built 2026-10-12.** The push in `fanout.rs` now runs for
   personas the node authors or holds (`crowd::holds`, the slice-1 rule). Two
   door changes make it work:
   - The sync door answers a node in `crowd_holders` for that persona however
     quiet the follow is (`crowd::is_holder`). That's the third "nodes that
     already know" in ruling 1.
   - A push from one of the persona's own nodes, proven by member proof, is no
     longer recorded as an ask about a persona this node only holds. Without
     that, every holder would push every move straight back to the author.

   Two claims in `crowd.cjs`. In the first, cy follows quietly on a node made
   small, and ada posts while C is off the network, so her push reaches B alone.
   C then comes back with inbound connections only, so it can't pull, and B's
   fold carries the post in. In the second, B has no demand row for A. Each was
   shown failing with its mechanism removed. Without cutting C's outbound, the
   first claim passed with no relay at all: the rig runs the wake pass every two
   seconds. Slice 3's crowd-round claim was tightened the same way.

   One known cost: a relay push is recorded as an ask at the receiving holder,
   so that holder's next relay echoes one empty exchange back to it. It's
   bounded by the push cap and converges, because an exchange with a node that
   already has the move transfers nothing. A Hello that told a push from a pull
   would remove it.

5. **The wake pass's order** (ruling 6). **Built 2026-10-13.**
   `foreign_fetches.author_due_ms` (node rung 84) records when the persona's own
   machinery is next owed the pull. Two events set it to six hours from now,
   give or take a quarter, drawn fresh each time (`crowd::next_author_due`):
   - a fetch won by the own round;
   - a push proven by member proof.

   A revalidation asks two holders first, drawn at random from the memo, until
   that time comes. Then it asks the author. Revalidation here means the wake
   pass's pull and a page view's alike, since both go through
   `spawn_revalidate`. Two holders, not the fallback's eight: this pull is the
   steady state, and every holder raced is an exchange someone serves. First
   fetches and peeks keep the author-first order.

   Two claims in `crowd.cjs`:
   - hearing from the author sets its turn between 4.5 and 7.5 hours off;
   - with B behind (off the network while ada posts, then unable to dial), C's
     wake pass keeps asking B and stays behind. Once `author_due_ms` is written
     back to zero, standing in for the six hours, the next pull goes to A and
     brings the post.

   The second claim fails both with revalidation always author-first and with
   the author never owed.

6. **Bodies** (ruling 7). **Built 2026-10-13.** The holders memo, one referral's
   worth and freshest first, is a candidate list in `net/bodies.rs`. It sits
   after the deliverer rung in both the sweep and `heal_from`. The sweep skips
   it for a persona held only on a hunch (`speculative_only`), whose only
   author-side candidate stays the introducer: asking a holder for the bytes
   would tell it about the hunch. Nothing new crosses the wire.

   The claim in `crowd.cjs` uses a post's words rather than an image. They're a
   blob like any other, and an image needs the ingest pipeline for nothing the
   claim tests. The reader's blob door is shut while ada posts and while it
   pulls her header from A, so the words are owed. Then A goes dark, the
   reader's blob door opens, and its sweep heals the words from B. The reader is
   chosen to have no household tie to B, because the household is the healer's
   last rung and would answer for the wrong reason. The claim fails with the
   holders rung empty. `heal_from` (fragment intake) gets the same rung with no
   claim of its own.

7. **The busy referral** (ruling 3). **Built 2026-10-13.** Admission's close
   reason is now `busy` followed by a CBOR list (`encode_busy` / `decode_busy`
   in `proto/src/sync.rs`). It names up to 3 personas, 4 holders each, about 480
   bytes at most. A bare `busy`, which is what every older node sends, decodes
   as no referrals.
   - **Which personas:** the 3 hosted personas the most nodes asked about,
     counting only personas that have holders to name and breaking ties by the
     most recent ask (`demand::most_asked`).
   - **One lookup per 30 seconds:** `crowd::busy_reason` builds the reason once,
     and refusals in the meantime wait on that one lookup rather than each
     making their own.
   - **The requester:** a refused dial becomes a typed `sync::Busy` error. The
     fetch ladder keeps its holders only in the persona's own round, where the
     dialed endpoint was chosen as the persona's machinery, and reads the memo
     again before the crowd round. That is how a brand-new node, with no memo,
     reaches the crowd at all.

   This is a weaker belief than slice 3's member proof. A refusal comes before
   any Hello, so nothing can be proven. The referral is believed as far as the
   dial was. It costs at most a few wasted dials, since every holder's answer is
   checked against the root.

   `RINGTOME_SERVE_CROWD=false` sends a bare `busy`.

   The claim in `crowd.cjs`:
   - `test/admission-full` makes A refuse every unproven connection, as a flood
     would.
   - Twelve planted askers, which hold nothing, make ada A's most-asked persona.
   - A newcomer's node that has never heard of ada opens her page. It gets her
     from B: B is in its memo, and `last_via` is empty.

   With the own round's referrals ignored, the page fails with "none of the
   address's computers answered".

The two-node rig can't show load. What it can show is the fallback working when
the author refuses, which is the behaviour that matters. The load figures in
_Why_ stay arithmetic until the network is big enough to measure.
