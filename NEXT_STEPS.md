# Ringtome — Next Steps

Companion to PROJECT_PLAN.md: the delivery ladder. The plan says what and why; this says *in
what order*, and what each rung must demonstrably do before climbing to the next. Milestones end
in a **demo**, not a merged branch. Rough sizing is relative, not calendar (solo project,
weekends happen). **Forward-looking only:** finished work leaves this file - one line below,
full report in [HISTORY.md](HISTORY.md).

## Where we are

The sequential ladder (M0-M3.5) is complete, and so - in substance - is Tier 4's client track:
the cozy OS boots, and the notes app inside it is a real product. Delivery reports with their
design notes are in HISTORY.md; the ledger here is deliberately one line per era.

- **M0 — the skeleton** (done): Axum node, accounts/sessions, keystore, per-identity DBs, test rig.
- **M1 — entries that sign** (2026-07-06): canonical CBOR, signed chains, LWW profile, published
  test vectors, `ringtome inspect`.
- **M2 — the key tree** (2026-07-06): rank-path authority, retirement/repudiation with anchors,
  recovery key minted at creation.
- **M3 — two nodes, one identity** (2026-07-07): iroh sync behind the validation gate, the
  add-a-node ceremony, cross-node revocation.
- **M3.5 — discovery** (2026-07-07): signed serving records, the Directory (local stub /
  mainline), dial-by-key everywhere.
- **Private chains** (2026-07-08): epoch keys, sealed membership, member-proven sync - Tier 5's
  prerequisite, pulled forward.
- **The data layer** (2026-07-08 → 07-22): the store layer's typed CRDT handles, the file layer
  (encrypted content-addressed bodies; the hash is the capability), versioned documents with
  keep-both divergence, the media crush pipeline (AVIF/APNG/WebM/Opus), the Turso substrate with
  journal + materialized views, doc-meta annotations, taxonomies and trees as composition.
- **Identity in the UI** (2026-07-23 → 07-24): the front door, personas with the spare-key
  moment, one-trip adoption, junior grants (invitations daisy-chain), device names, password
  reset (Flow A scratch + re-homing), codes in QR-ready costume.
- **The live cache + the notes flagship** (2026-07-24 → 07-25): the WebSocket stream + Dexie
  mirror, the editor with all four NOTES_APP client obligations, the write nudge (~1s
  write-to-peer), private-document search (the `doc_search` materialized view, matched locally).
- **The merge era** (2026-07-25): the recursive virtual base for criss-cross histories, N-way
  per-hunk alignment, Marquee conflict vocabulary, the lookout's pure-predicate hardening,
  caret memory, side-by-side scroll sync, turbolink unfurling behind the SSRF envelope.
- **Apps and organization** (2026-07-26 → 07-31): buckets + the app registry (Notes, Recipes,
  Journal, Wiki, TurboNotes, All), cozy addressing (the path is the address, the origin is the
  lens; `ringtome://` dissolved), search-kind filters, sidebar thumbnails, media byte-URLs,
  ingest progress meters, the audio fit-to-cap loop.
- **CROWN meets the UI** (2026-07-30 → 08-01): groups moved to the member lane + the Inbound
  Gate + the minter rule (doctrine); self-retirement sync survival, `revocation_of`, the gate
  sweeps (code); removal flows in cozy language ("lock out this computer" / "leave this
  persona"), the farewell flow for revoked nodes, the composite repudiation suite.
- **The QA hardening pass** (2026-08-01): the eslint gate, the jsdom harness family
  (boot/drive/state/ui/thumbs/pickers), port-suffixed session cookies, the completion-picker
  fixes, the mixed-dialect conflict fix (presentation from merge structure, never marker text),
  the lane triad settled (public / gated / private).

## The route from here (settled 2026-08-01)

The notes flagship is relatively complete, so the next arc is **the bottom rungs of the
relationship graph, then publication** - relationships first because the graph must grow before
the features that read it (PROJECT_PLAN, Sequencing), and because publication's visibility
tiers consume the gated lane's predicates (friends, groups) rather than the other way around.
The rungs, each independently shippable:

1. **Admission modes + friend tokens** (node-local, zero new protocol - PROJECT_PLAN, Friend
   Tokens and the Bootstrap Problem; design rules all settled): registration
   `closed`/`invite`/`open` with invite as default, the token mint/redeem ceremony in the
   registration screens, `{admission, auto_follow, vouch}` flags with the **vouch payload live
   from day one** - every IRL handoff quietly writes a trust edge. The seed crystal.
2. **The follow type, quiet tier**: a private-chain write; the carrying mechanism has existed
   since private chains shipped. Follow UI rides the contact surfaces.
3. **"Tell them" receipts**: the first real inter-identity delivery, passing the Inbound Gate.
   Friendship needs no new object - it composes at the second disclosed follow.
4. **Public serving + the publication act** (the heart of 4S): the `/id/<root>` surface,
   foreign-identity resolution, monotonic memory for remote identities, the default-on gateway
   rungs, and publication as copy-don't-flip (NOTES_APP, Publication - the notes editor is
   already the post composer).
5. **Friends-gated serving**: the gated lane's first consumer - the predicate over receipts,
   the per-service lane declaration, and the blob gate (all three promissory notes below).
   Groups trail into the same roster-check interface when they land.

**The `/id` endpoint - v1 SHIPPED 2026-08-01** (same-day design and first delivery; reports
in HISTORY): route recognition in both spellings, the audience split (session → the SPA's
lens page; anonymity → a server-rendered static face under the hardened headers), and three
of the anonymous shapes - the shelf (hosted personas' public profiles, escaped and
CSP-fenced), the warm tombstone, and the checksum refusal with "did you mean". Speakable
addresses mint everywhere humans see a root. **Fetch-and-serve shipped 2026-08-02**: a
member asking about an off-shelf root triggers a request-time sync of its public lane
through the address's own `?via=` hints (the ordinary exchange, from empty, gate-validated;
the fetch registry is ON DISK - durable knowledge, member-scoped serving, amended 2026-08-02:
the identities table never learns, so the anonymous face still tombstones, but a reboot
never orphans chains the node still holds). **Still owed:** the **signpost rung** (serving records grow the
public-web-URL field), the **root-directory backstop** (a real design problem, found
2026-08-02: serving records publish under LEAF keys because pkarr requires the publisher's
signing key and the root's is offline by design - so "resolve a bare root" needs a
store-at-derived-key design, not just a call; until then the ladder is origin + via, which
every minted address carries), the **shelf disclaimer** (moot until member follows exist),
and the **`/home/people` rolodex**. The graph rungs (steps 1-3) ride alongside - the follow
edge is what converts a lens visit into shelf.

Rough-edge triage, recorded so it doesn't get relitigated: **blob GC + capacity** are
prerequisites for help-host/rehosting (other people's load), not for follows or tokens; the
**fork-aftermath dragon** is due before any fork-facing UI; **accessibility** is a standing
discipline on new surfaces rather than a pre-4S project; **localization** waits (User-1 rule).

## Standing residuals (owed, with triggers)

Work that survived its milestone lives here until delivered (then it moves to HISTORY):

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
  exist yet. Lands with 4S's public serving surface (route step 4).
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

## The tiers (restructured 2026-07-07; statuses updated 2026-08-01)

M1-M3.5 were genuinely sequential. What remains is not - work is grouped into **tiers of
unordered tracks**; a tier is done when its tracks are, and tracks can be taken in any order or
abandoned mid-stream for a more motivating one. For a solo project, motivation is the scarcest
resource. Real cross-track dependencies are listed explicitly. The recommended route through
what remains is **The route from here**, above.

## Tier 4 — The product (three tracks)

**4C — The client shell ("the cozy OS boots"). Delivered in substance** (2026-07-23 → 08-01):
login, personas, adoption, key screens with removal and farewell flows, the live cache, and the
notes flagship with its apps, buckets, and search - all in cozy language, no JSON visible.
Remaining tail: the **recovery-key photo ceremony** (labeled QR, blocked-until-captured - the
spare-key moment ships as download/confirm today), **friend tokens** (promoted to route step 1),
and the key-screen residuals above (Flow A's bells, spare-key succession).

**4M — The markup language ("pages have a language"). Substantially delivered as Marquee** -
the language grew into its own project (~/code/marqueemarkup: spec, Rust + JS strict parsers
kept honest by shared vectors, HTML + React renderers, the live-preview editor) and the notes
app ships all of it. Remaining *in Ringtome*: the `page`/`post` **payload types** (stable
`doc_id`, the **labels field** for consent machinery - organizational tags stay external
taxonomy, never on the payload), **proto-side validation** wiring at the serving boundary, and
formalizing the **media-type admission test** the crush pipeline already implements in practice
(strict parse in a sandboxed decoder, EXIF stripping as an authoring-client concern).

**4S — The social layer ("other people exist"). Started 2026-08-01 with the `/id` design.**
Everything that crosses the inter-identity boundary: the **`/id/<root>` surface** (the public
serving face and the lens page in one URL - PROJECT_PLAN, Addressing, "The prefix gets its
name"), the `follow` type with its three disclosure tiers (quiet / tell-them / help-host -
PROJECT_PLAN, Edge-Endpoint Visibility), serving-follows, **foreign-identity resolution** (the
ladder consuming M3.5's directory), identicons + contact names, **monotonic memory for remote
identities**, and the **default-on gateway in three rungs** (shelf / signpost / warm
tombstone - PROJECT_PLAN, The Web Gateway, amended 2026-08-01; the old dual-opt-in role
survives only as the curated "magazine" tier). Route steps 2-5 are this track's build order,
with the `/id` endpoint as its front door.
*Track demo:* curl a stranger's profile (as an authenticated member of a node that serves
them), resolved from an identity-rooted URL minted on the other node.

**Leaf dependencies (land in whichever track finishes last):** page-authoring UI = 4C + 4M;
reading view/feed = 4C + 4S; rendering a *stranger's* page = all three. **Tier exit demo:** two
users on two nodes follow each other and read each other's marquee-infested pages through the
fake OS. The project becomes showable to a non-nerd.

## Tier 5 — Trust

Trust is the thesis, not a feature to retrofit - a social launch without at least the floor is
a different, worse product. Only the final *wiring* step depends on 4S; the pure core is known
math, buildable any time; and the graph starts growing with route step 1 (PROJECT_PLAN, Trust:
"The Graph Grows Before the Features Arrive").

- **Vouch statements** (deps: none; ships with the invite tokens - route step 1): the signed
  "I met this human" payload, public v1, retractable. Graph-privacy refinements stay later;
  they are subtle, the payload is not.
- **Flow computation engine** (deps: none): the Advogato-style **joint-flow** calculation
  (never per-person; that detail is the whole Sybil defense), bounded horizon, pure crate
  code, property-tested. Known, decades-old math - not research.
- **Adversary-simulation harness** (deps: none): a **calibration instrument and standing
  tripwire, never a launch gate**. Sanity-checks the joint-flow property before wiring, tunes
  the knobs, then runs forever hoping to break things.
- **Private chains** (COMPLETE 2026-07-08): the substrate, delivered.
- **Contact names** (deps: none remaining): the private-register annotation and its UI; the
  vouch shares the screen, forked in the UI, never coupled in the data.
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

## Deliberately not yet

Passkeys/WebAuthn, recovery helpers (email/social), iroh-gossip real-time + DMs (*designed* -
PROJECT_PLAN, The Sealed Pair; unscheduled, not undesigned), the scripting rung of the markup
ladder, Godot anything, phones (PWA rides along for free), the push-gateway role,
snapshots/checkpoints, ActivityPub bridges, localization. All named in the plan; none on the
critical path through Tier 6.

## Sequencing rationale, in one paragraph

Everything writes entries, so the entry format went first (M1); authority statements are entries
and sync validates against the tree, so the tree preceded the network (M2 before M3); sync needed
somewhere to find peers (M3.5). That's where hard sequencing *ends*: the product tier's three
tracks touch different layers and meet only at their leaves, trust needs the social layer only at
its final wiring step, and shipping is a checklist with a single gate (the security pass) rather
than an order. The ladder got us a correct substrate; the tiers spend motivation wherever it
lands - and every stopping point still leaves a runnable node behind.
