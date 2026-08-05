# Ringtome — Next Steps

Companion to PROJECT_PLAN.md: what is owed. The plan says what and why; this says what is not
built yet, what it depends on, and what it must demonstrably do. It does NOT say in what order -
it used to try, and the order was wrong within days of being written (see The directions in
flight). Work runs in several directions at once; dependencies are stated where they are real
and nowhere else. Milestones end in a **demo**, not a merged branch. Rough sizing is relative,
not calendar (solo project, weekends happen). **Forward-looking only:** finished work leaves
this file - one line below, full report in [HISTORY.md](HISTORY.md).

## Where we are

Deliberately not restated here: what is built, and when, is HISTORY.md's job (and the git log's
for the last few days). This file starts at the water line.

## The directions in flight (rewritten 2026-08-04)

This was a numbered route, settled 2026-08-01 and wrong within three days: it put admission
modes first (they are last, if ever), listed the follow as unbuilt (it exists), and had
inter-identity delivery preceding fan-out when delivery is what WAITS on fan-out. The numbering
implied a sequence where there is none, and reading it cost more than it gave. What the work
actually shares is a destination, not an order.

**Public posts and fan-out** - the direction with the most ground under it. Publication, the
public lane, the `/id` surface, fetch-and-serve, Feed and the posts a person's page shows are
all standing. Owed: the subscription table (which also pays the demand-record debt the Three
Funnels asserts), node-level frontier fingerprints as the sweep and fan-out hook, the
cross-identity index, and the feed as a materialized view over identities you actually follow.
Note the standing gap this closes: nothing continuously syncs a followed identity today -
`add_peer` fires only from adoption.

**User-to-user delivery** - the inbox chain as a doorbell rather than a mailbox: self-describing
notices transcribed by your own node behind the Inbound Gate, four anti-flood layers, its own
prunable service. Waits on fan-out, because delivery to someone who never pulls is a message
into a drawer.

**Friends** - the predicate over disclosed-follow receipts, with its staleness bound stated in
the UI's honesty budget. The trust ledger already records the edges; what is missing is the
composition (friendship at the second disclosed follow) and the receipts that disclose one.

**Groups** - the roster-check interface, which the friendship predicate should be shaped to
share rather than parallel.

All four are roads to **friends-gated serving**: the gated lane's first real consumer, and the
one thing that needs all of them at once (the predicate, the per-service lane declaration, and
the blob gate - the three promissory notes below). Trailing deliberately, and named here so it
stops looking like a prerequisite: **admission modes and friend tokens** (registration
closed/invite/open, the mint/redeem ceremony, the vouch payload). They are a growth mechanism,
not a substrate, and nothing above waits on them.

Owed inside those directions, and easy to lose because the surfaces around them are standing:

- **What the frontier map is FOR** (opened 2026-08-04, with the map itself): the table and the
  peer claims exist and are recorded; nothing reads them yet. Owed: (1) the **sweep that acts** -
  chase a claim that has changed since we last chased it (not merely one that differs from what
  we hold, or a broken node is chased forever), backing off sources whose verdict is
  `unresolvable`; (2) the **subscription table** and fan-out, hanging off the edge that
  `frontier::refresh` already returns - its only consumer today is a log line. Note the limit on
  per-source backoff: `endpoint_id` is transport identity and can be minted freely, so it is cost
  control, not a security boundary - the boundary stays the ingest gate.
- **Public divergence semantics** (surfaced 2026-08-04): `send_missing` diffs on seq, so two
  nodes forked at the same seq on a public chain exchange nothing. The anchor that detects it now
  crosses the wire (`Frontier.head_hash`); what an exchange should DO about a public fork is the
  open design.
- **The feed's read half** (opened 2026-08-05, with the push and journal delivered): a post now
  crosses nodes into `feed_journal` unprompted; nothing reads the journal yet. Owed: (1) the
  **feed surface** - an endpoint and UI over the reader's journal rows, ordered at read time by
  their own interest dials (the journal is deliberately unordered); (2) **seen-state** on the
  reader's private chain, distinct from the journal's delivered-state (Two cursors, not one);
  (3) **demand retention** - the table records demand forever, which assembles a readership
  graph for hosted personas; prune to a window before any node hosts strangers; (4)
  **rebroadcast** - the push fires only for personas this node authors, because relaying someone
  else's lane is a consent question; the rebroadcast dial is recorded and unread.
- **The signpost rung** - serving records grow the public-web-URL field.
- **The root-directory backstop** - a real design problem, found 2026-08-02: serving records
  publish under LEAF keys because pkarr requires the publisher's signing key and the root's is
  offline by design, so "resolve a bare root" needs a store-at-derived-key design, not just a
  call. Until then the ladder is origin + via, which every minted address carries.
- **The shelf disclaimer** - moot until member follows exist.
- **Two consent flags awaiting their consumers**: `trust_public` feeds the graph's publication
  machinery (Tier 5's vouch lane), `blocked` feeds the Inbound Gate. Both are RECORDS today,
  read by nothing. The trust dial's stored numbers are edge INPUTS for the flow engine, never
  the flow.
- **Deferred with the posts era**: public divergence semantics, and public taxonomies (with
  tags-as-published-taxonomy) - which is what would give a public post somewhere to keep a
  bucket.

Rough-edge triage, recorded so it doesn't get relitigated: **blob GC + capacity** are
prerequisites for help-host/rehosting (other people's load), not for follows or tokens; the
**fork-aftermath dragon** is due before any fork-facing UI; **accessibility** is a standing
discipline on new surfaces rather than a pre-4S project; **localization** waits (User-1 rule).

## Standing residuals (owed, with triggers)

Work that survived its milestone lives here until delivered (then it moves to HISTORY):

- **A public reader page, and search over your own posts** (opened 2026-08-04, from Feed's
  display pass; half-delivered 2026-08-04): MEMBERS now read a persona's posts rendered, on
  their `/id` page (js/posts.js) - so what remains is the ANONYMOUS half: a stranger handed a
  link still gets `/id/<root>/docs/<id>/body`, the artifact's bytes, because the anonymous face
  is Rust-rendered HTML while the marquee renderer is JavaScript. The cheapest fix is a small
  public reader page that fetches `/body` and renders it with the marquee bundle (no session, no
  SPA); the static face doesn't list posts yet either. Trigger: the first link to a post sent to
  someone outside. Separately: Feed's header search box was removed rather than wired, because
  the app receives no query; searching your own posts is worth having, and wants the search index
  the documents apps already use.
- **Delete's other half + a visible undo** (opened 2026-07-26, with the delete button): deletion
  ships as a reversible tombstone. Owed: (1) **dropping the content blobs** - a GC pass over
  blobs no live `doc_heads` row references, gated on the deleted set; lands well with
  snapshots/retention, and becomes a prerequisite when rehosting invites others' bytes; (2) a
  **visible restore** - `Documents::restore` exists, no UI calls it; a "recently deleted" tray
  is the small surface owed. Trigger: the first time someone deletes something they wanted.
- **The gated lane's three promissory notes** (settled 2026-08-01 with the lane triad -
  PROJECT_PLAN, Lanes: Public, Gated, Private): (1) lane becomes a **per-service declaration**
  (each service name statically maps to public/gated/private; no dynamic assignment); (2) the
  **friendship predicate** over disclosed-follow receipts, with its staleness bound stated in
  the UI's honesty budget (unfollow is silent; a recently-stale friend is served, same eventual
  bound as the stale-roster admit); (3) the **blob gate, built once and
  predicate-parameterized** - the real authorization check on the blob transport that plaintext
  gated bodies require, shared by group content and friends-gated media, built BEFORE either
  consumer ("must not be discovered late" - The Member Lane). Trigger: the first gated
  consumer - friends-visible posts or group content, whichever lands first.
- **Marquee's span vocabulary, exported upstream** (opened 2026-08-01, with the `[` picker's
  tag completions): the editor's tag list is a hardcoded transcription (`SPAN_TAGS`,
  `doc/completions.js`) of the span switch in `marquee-html-renderer`. The durable home is an
  exported list from the Marquee packages (we own them). Drift meanwhile costs a completion,
  nothing else. Also owed upstream (repo local: ~/code/marqueemarkup): marquee-codemirror's
  `plan()` builds an empty mark decoration for a zero-content effect pair
  (`[rainbow][/rainbow]`), and the RangeError makes the editor refuse the closing `]` -
  ringtome's picker sidesteps it with placeholder text; hand-typing still bricks the keystroke
  until `plan()` skips empty inline spans. Trigger: the next Marquee release, or the first
  time attribute completion (by=, speed=, font= names) is wanted.
- **Fork-aftermath dragon** (owed since M3): schema room for fork *evidence* plus the re-signing
  recovery flow - due before or with whatever first shows a fork to a human (4C's key screens
  are the likely trigger).
- **Sync-request flooding bounds** (opened with background sync's ship): exchange initiation is
  open by default, so a malicious operator can spray sync requests. Today's bounds:
  `is_agented` short-circuits unknown identities, an up-to-date exchange is a kilobyte frontier
  swap, the gate validates before any write - exposure is connection/CPU churn, not data. Owed:
  accept-side rate limiting (the HTTP limiter doesn't cover iroh); per-identity refusal of
  contact is the adjacent operator policy hook. Trigger: before any hosted deployment.
- **Peer set derived from the key tree** (opened 2026-07-25; no trigger - worth doing while we
  remember): the doctrine exists (the chain frontier *is* the peer list) but the implementation
  still dials only `identity_peers` rows written at adoption - a daisy-chained node provably
  knows its cousins yet never dials them (field-observed as loose sync latency). The work:
  derive the dial list from the key-tree frontier + dial-by-key discovery, demoting
  `identity_peers` to an address cache. NOT peer-list gossip - no new wire surface. REFACTOR's
  `sync.rs` peer-bookkeeping note names the code seam.
- **Monotonic memory for remote identities** (owed since M2): for *synced* identities the
  append-only entries table is structurally sufficient; for stranger resolution it does not
  exist yet. Lands with the fan-out direction.
- **Mainline NAT rung** (what remains of M3.5 after the 2026-07-22 same-box field test): NAT
  traversal between two real houses (the Tier 6 distributed run) and the raw-DHT fallback
  (pkarr relays down), which the smoke test budgets for but has never hit.
- **Live cache, Stage 2: row-level deltas** (pressure recorded at search's ship, 2026-07-25):
  Stage 1's whole-kind refresh re-ships the corpus on every save, and the search index - a
  token bag over ~the whole corpus - is now the real customer. Adjacent owed search work:
  **ranking** (today's match is boolean; waits for a corpus that needs it) and the **federated
  bloom pre-filter** sketch for cross-identity search (full sketch in HISTORY, 2026-07-25).
- **The decrypt-and-dump export tool** (a ship gate; re-scoped 2026-07-22 by the User-1 rule):
  stock SQLite cannot read an encrypted Turso file, so real users need the tool and its CI
  dump/restore upgrade gate - but until User 1 a Turso bump may simply wipe and rebuild. Lands
  with Tier 6, alongside the security pass. Turso stays pinned (`=0.7.0`) meanwhile.
- **Flow A's bells** (deferred at the scratch ship, 2026-07-24): browser-side challenge signing
  (the pasted seed currently transits to the node - unacceptable once nodes host strangers),
  post-use spare-key rotation, the cooling-off window with logged-in cancel. Trigger: before
  any hosted/multi-tenant deployment; natural home is the key screens alongside Flow B.
- **Spare-key succession ceremony** (designed 2026-07-24 - PROJECT_PLAN, Recovery Flows): a
  sole-surviving junior rebuilds recovery by minting its successor spare *first*. A small
  out-of-the-way flow in the key screens; forces the designation upgrade to ship WITH Flow B.
- **Client-side annotation prefill** (deferred 2026-07-22): the authoring client may read
  artist/album/title *before* the pipeline launders the bytes and offer them as pre-filled
  annotations - persisting is a deliberate user act. Rides whichever surface uploads media next.
- *Minor, watched:* concurrent epoch rotations can twin an epoch number (readers try all keys;
  convergent but unlovely); requesters re-offer private chains each exchange (duplicate-skip
  absorbs it; revisit if private chains get big).

## The tiers (restructured 2026-07-07)

M1-M3.5 were genuinely sequential. What remains is not - work is grouped into **tiers of
unordered tracks**; a tier is done when its tracks are, and tracks can be taken in any order or
abandoned mid-stream for a more motivating one. For a solo project, motivation is the scarcest
resource. Real cross-track dependencies are listed explicitly. What is actually in motion is
**The directions in flight**, above.

## Tier 4 — The product (three tracks)

**4C — The client shell ("the cozy OS boots"). Delivered in substance.** Remaining tail: the
**recovery-key photo ceremony** (labeled QR, blocked-until-captured - the spare-key moment ships
as download/confirm today), **friend tokens** (trailing, by decision), and the key-screen
residuals above (Flow A's bells, spare-key succession).

**4M — The markup language ("pages have a language"). Substantially delivered as Marquee**,
which lives in its own repo (~/code/marqueemarkup). Remaining *in Ringtome*: the `page`/`post`
**payload types** (stable
`doc_id`, the **labels field** for consent machinery - organizational tags stay external
taxonomy, never on the payload), **proto-side validation** wiring at the serving boundary, and
formalizing the **media-type admission test** the crush pipeline already implements in practice
(strict parse in a sandboxed decoder, EXIF stripping as an authoring-client concern).

**4S — The social layer ("other people exist"). In flight.** Everything that crosses the
inter-identity boundary. Still owed here: the `follow` type's three disclosure tiers (quiet /
tell-them / help-host - PROJECT_PLAN, Edge-Endpoint Visibility) and serving-follows,
**monotonic memory for remote identities**, and the remaining gateway rungs (signpost / warm
tombstone - PROJECT_PLAN, The Web Gateway, amended 2026-08-01; the old dual-opt-in role
survives only as the curated "magazine" tier). The directions above are what is being built.
*Track demo:* curl a stranger's profile (as an authenticated member of a node that serves
them), resolved from an identity-rooted URL minted on the other node.

**Leaf dependencies (land in whichever track finishes last):** page-authoring UI = 4C + 4M;
reading view/feed = 4C + 4S; rendering a *stranger's* page = all three. **Tier exit demo:** two
users on two nodes follow each other and read each other's marquee-infested pages through the
fake OS. The project becomes showable to a non-nerd.

## Tier 5 — Trust

Trust is the thesis, not a feature to retrofit - a social launch without at least the floor is
a different, worse product. Only the final *wiring* step depends on 4S; the pure core is known
math, buildable any time; and the graph starts growing with the admission/token work whenever
it comes (PROJECT_PLAN, Trust: "The Graph Grows Before the Features Arrive").

- **Published trust edges - né "vouch statements"** (deps: the contact ledger, shipped
  2026-08-02; ships with the invite tokens, whenever those come): the vouch dissolved into the
  ledger (PROJECT_PLAN, The Vouch Dissolved - a vouch IS a positive trust edge its author
  chose to publish). What ships here is the MINT: the signed public trust statement built
  from a consented edge (copy-don't-flip; retractable; discloses a rounded tier, never the
  raw integer). Token redemption writes the met-in-person edge with sharing consent asked at
  the handoff - every IRL invite quietly writes a shared edge, the seed crystal. Deeper
  graph-privacy refinements stay later.
- **Flow computation engine** (deps: none): the Advogato-style **joint-flow** calculation
  (never per-person; that detail is the whole Sybil defense), bounded horizon, pure crate
  code, property-tested. Known, decades-old math - not research.
- **Adversary-simulation harness** (deps: none): a **calibration instrument and standing
  tripwire, never a launch gate**. Sanity-checks the joint-flow property before wiring, tunes
  the knobs, then runs forever hoping to break things.
- **Wiring trust into the product** (deps: 4S + the above): lands *with* the social launch -
  the coarse floor on the first low-stakes surfaces (feed ordering, a bot floor).
- **Deferred with honest labels**: credibility (needs track records that don't exist yet),
  interest/taste recommenders, graph-privacy resolution controls, knob refinement.

## Tier 6 — Ship (unordered tasks; one gate, not an order)

- **Hosted deploy story** (deps: none): Dockerfile, `testnode-N.ringtome.ca`, ops docs.
- **Self-hosting documentation** (deps: deploy story): first-class artifact, per the plan's
  guard against hosted-first calcifying.
- **Desktop packaging** (deps: 4C, weakly): tray sidecar, autostart, app-mode window, single
  installer, signing/notarization. The Ollama shape.
- **Mainline field test, distributed rung** (deps: none, startable any weekend): two
  internet-connected nodes on `RINGTOME_DISCOVERY=mainline` - the first genuinely-distributed
  run, exercising the NAT rung. `just mainline-smoke` + the dispatch-only action already exist.
- **Abuse tooling for public roles** (deps: none to build; **gates open/gateway modes**): the
  blob-layer scanner trait with the Shield backend, quarantine + preserve + report, hardened
  blob-serving defaults. Denunciation statements land with Tier 5's wiring; this bullet is
  only what public-facing roles may not ship without.
- **Security pass** (deps: none to *do*; but it **gates public exposure**): a hostile review of
  the whole HTTP + sync surface. The one hard rule in this tier: no publicly-reachable node
  before it happens.

---

## Standing disciplines (all tiers)

- **Test vectors + spec fragments** grow with every wire format (entries, records, markup).
- **Integration suite**: every track extends it; the two-node harness is the default proving
  ground.
- **Accessibility** (added 2026-08-01): new surfaces build it in rather than bolt it on;
  retrofitting the existing shell is deliberately not a scheduled project yet.
- **Take the widget, don't roll your own** (added 2026-08-03 with the Person family): surfaces
  that show a human - posts, comments, group rosters, the feed - wear a shape from js/person.js.
  Shape differs, component; size differs, prop.

## Deliberately not yet

Passkeys/WebAuthn, recovery helpers (email/social), iroh-gossip real-time + DMs (*designed* -
PROJECT_PLAN, The Sealed Pair; unscheduled, not undesigned), the scripting rung of the markup
ladder, Godot anything, phones (PWA rides along for free), the push-gateway role,
snapshots/checkpoints, ActivityPub bridges, localization. All named in the plan; none on the
critical path through Tier 6.

## Why nothing here is ordered

Hard sequencing ended with the substrate. The product tier's tracks touch different layers and
meet only at their leaves, trust needs the social layer only at its final wiring step, and
shipping is a checklist with a single gate (the security pass) rather than an order. So this
file spends motivation wherever it lands - and every stopping point still leaves a runnable node
behind.
