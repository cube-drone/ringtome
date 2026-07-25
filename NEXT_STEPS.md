# Ringtome — Next Steps

Companion to PROJECT_PLAN.md: the delivery ladder. The plan says what and why; this says *in
what order*, and what each rung must demonstrably do before climbing to the next. Milestones end
in a **demo**, not a merged branch. Rough sizing is relative, not calendar (solo project,
weekends happen). **Forward-looking only:** finished work leaves this file - one line below,
full report in [HISTORY.md](HISTORY.md).

## Where we are

The sequential ladder (M0-M3.5) is complete; delivery reports with their design notes are in
HISTORY.md.

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
- **The store layer** (2026-07-08): the data map + typed CRDT handles; application code stopped
  touching chains directly.
- **Doctrine interlude + license** (2026-07-09 → 07-14): NOTES_APP.md born, slugs/address-bar
  designed, groups sketched; AGPL-3.0.
- **The file layer + CI** (2026-07-15): encrypted content-addressed bodies over iroh-blobs
  (holding the hash is the capability); CI runs `just ci` verbatim.
- **Versioned documents** (2026-07-15 → 07-17): the notes lane - stable `doc_id`, version DAG,
  keep-both divergence, per-format merge with conflicts presented in-document.
- **Media ingest** (2026-07-18 → 07-20): the async quarantine → transcode pipeline; AVIF
  stills, WebM video/audio through one crush, thumbnails and micro-previews.
- **Crown hardening** (2026-07-20): revocation anchors enforced by hash - sealed-prefix-as-unit
  crediting, seal-or-nothing admission, proven-forgery eviction.
- **The substrate** (2026-07-20 → 07-21): Turso with at-rest encryption, the raw-entry journal,
  persisted materialized views with per-chain watermarks.
- **The embedded UI** (2026-07-21): the Preact SPA baked into the binary; `just start`.
- **Mainline field test** (2026-07-22): the real DHT touched - publish/resolve/adopt/re-sync,
  same-box; `just mainline-smoke` + dispatch-only action.
- **Background sync + eager push** (2026-07-22): sync stopped being manual - debounced eager
  push plus periodic anti-entropy, epidemic relay across the peer graph.
- **Annotations - the doc-meta chain** (2026-07-22): service 7; per-doc fields and tags on
  `PrivatePlain`, both read directions, the `doc_heads` docs-list memo. Completes the
  data-layer rewrite sequence (substrate → doc-meta → materializer).
- **Taxonomies, v1 lists** (2026-07-22): ordered document lists as per-element ranked facts
  (`tax:` collections, fractional ranks, roster existence); place-is-add-and-move over HTTP.
- **Taxonomy trees as composition** (2026-07-23): nesting a list in a list IS the tree -
  local cycle refusal at `place`, visited-set stubs in the tree read, the `parent` slot and
  its fold-time cycle rule retired unused. The published form is still designed-ahead.
- **The front door** (2026-07-23): node login + registration in the embedded UI - cookie
  sessions, live username availability, cozy language. First 4C rung past hello-world.
- **Device names** (2026-07-23): keys carry private human labels ("macbook-curtis", never
  fingerprints) - the `devices` register collection, node names from config/hostname, birth
  writes at creation and adoption, names joined into the keys endpoint.
- **Personas in the UI** (2026-07-23 → 07-24): the null state ("Nobody lives here yet"), the
  create flow with the minimal spare-key moment (secret shown once, download, confirm gate),
  the name picker (pre-filled with the account username, skippable), auto-open of the first
  persona, the persona badge in the bar. "Persona" confirmed as the UI's single taught
  concept; the account never gets a noun.
- **Password floor follows the bind address** (2026-07-24): loopback-only nodes accept short
  PINs (physical access is the gate there); any network-facing bind keeps 8+ regardless of
  tenancy; unparseable binds fail closed.
- **Spare-key password reset, Flow A scratch** (2026-07-24): the seed as reset factor -
  designated-recovery-key-only, uniform refusals, session purge, "lost your password?" on the
  front door. Scoping split by account shape: single-persona resets in place (keeps the
  sign-in name); multi-persona **re-homes** the proven persona into a fresh account, old
  account untouched. Challenge signing / rotation / cooling-off stay owed. Proven tree-level
  by the two-node test: the day-one spare key rescues accounts on any node that is the persona.
- **Adoption in the UI** (2026-07-24): the null state's second door ("bring your persona from
  another computer") and the "your computers" screen ("invite this computer to be you") -
  request/grant codes over the M3 ceremony, key tree rendered with device names and roles.
  Identity wiring in the UI is complete: create, name, recover, re-home, adopt.
- **One-trip adoption** (2026-07-24): the grant travels by wire (dedicated adopt ALPN,
  channel pinned to the requested endpoint, no bearer secrets), carried code demoted to
  fallback, completion idempotent. One human trip; the persona "walks in on its own."
- **Codes wear a costume** (2026-07-24): `rt1.` + base64url(deflate(JSON)) - opaque,
  ~40% shorter, envelope-versioned, QR-ready. The gubbins are gone.
- **Junior grants** (2026-07-24): the M3 root-only trim un-trimmed - any Active key extends
  the tree (`Crown::usurper_stamp_for_new_child`, any depth), so invitations daisy-chain and
  rank paths record who vouched for whom. Three-node harness (`alpha`/`bravo`/`charlie`) +
  `just start_three`; proven by daisychain.cjs end to end. The keys endpoint returns
  responsibility order (lexicographic rank paths: root, spare, then each inviter directly
  above its invitees), and "your computers" indents by depth to show the chain.
- **The live cache, Stage 1** (2026-07-24 → 07-25): the read-only WebSocket stream + Dexie
  mirror - whole-kind refreshes, frontier-fingerprint cursor (match → live, doubt →
  snapshot), mirror dropped on logout, badge reads live (a rename on any computer lands in
  every browser in seconds). Shadow overlay ships with the notes editor. The 4C order is now:
  ~~login~~ → ~~identity management~~ → ~~stream + mirror~~ → **notes**.

## Standing residuals (owed, with triggers)

Work that survived its milestone lives here until delivered (then it moves to HISTORY):

- **Fork-aftermath dragon** (owed since M3): schema room for fork *evidence* plus the re-signing
  recovery flow - due before or with whatever first shows a fork to a human (4C's key screens
  are the likely trigger).
- **Sync-request flooding bounds** (opened with background sync's ship): exchange initiation is
  open by default (sync triggering is network maintenance, not a hosting decision), so a
  malicious operator can spray sync requests. Today's bounds: `is_agented` short-circuits
  unknown identities with an empty Hello, an up-to-date exchange is a kilobyte frontier swap,
  and the gate validates before any write - exposure is connection/CPU churn, not data. No
  accept-side rate limiting exists (the HTTP limiter doesn't cover iroh). Explore per-endpoint
  accept throttling / cost caps; per-identity refusal of contact is the adjacent operator
  policy hook.
- **Monotonic memory for remote identities** (owed since M2's status note): for *synced*
  identities the append-only entries table is structurally sufficient; for stranger resolution
  it does not exist yet. Lands with 4S's public serving surface.
- **Mainline NAT rung** (what remains of the M3.5 mainline residual after the 2026-07-22
  same-box field test - see HISTORY): the relay-assisted discovery path is proven against the
  real DHT; still owed are NAT traversal (two real houses, the Tier 6 distributed run) and the
  raw-DHT fallback (pkarr relays down), which the smoke test budgets for but has never hit.
- **PrivatePlain size caps** (4 KiB value / 6 KiB ciphertext): likely resolution - the caps are
  *correct*, because note/post bodies ride blobs, never inline records (NOTES_APP.md). Confirm
  and close when the blob lane lands; until then the caps stay unshipped-soft.
- **The decrypt-and-dump export tool** (a ship gate; re-scoped 2026-07-22 by the User-1 rule,
  STYLE.md): stock SQLite cannot read an encrypted Turso file, so real users need the tool and
  its CI dump/restore upgrade gate - but until User 1 there is no data to protect, and a Turso
  bump may simply wipe and rebuild (the journal replays; worst case, test data dies). Lands
  with Tier 6, alongside the security pass in the "gates ship" family. Turso stays pinned
  (`=0.7.0`) for reproducibility meanwhile.
- **FTS over titles + descriptions** (trimmed from the materializer's ship): the data-layer
  plan named it; nothing consumes it yet. Lands with whichever 4C surface first offers search.
- **Flow A's bells** (deferred at the scratch ship, 2026-07-24): browser-side challenge
  signing (the pasted seed currently transits to the node - unacceptable once nodes host
  strangers), post-use spare-key rotation, and the cooling-off window with logged-in cancel.
  Trigger: before any hosted/multi-tenant deployment; natural build home is 4C's key screens
  alongside Flow B. (Re-homing shipped 07-24 and left this list.)
- **Spare-key succession ceremony** (designed 2026-07-24 - PROJECT_PLAN, Recovery Flows): a
  sole-surviving junior rebuilds recovery by minting its successor spare *first* (seniority
  over the identity's entire reachable future; lost seniors stay dormant-senior forever). A
  small out-of-the-way flow in the key screens, and it forces the designation upgrade (`role`
  attribute or strictly-senior reset rule) to ship WITH Flow B - v1's all-zeros-spine rule
  can't see an off-spine spare.
- **Client-side annotation prefill** (deferred at annotations' ship, 2026-07-22): the authoring
  client may read artist/album/title *before* the pipeline launders the bytes and offer them as
  pre-filled annotations - persisting is a deliberate user act (bulk import consents once per
  batch, never silently per file). Rides whichever 4C/4M surface uploads media; the pipeline
  itself never keeps embedded metadata (PROJECT_PLAN, Annotations: the ingest membrane).
- *Minor, watched:* concurrent epoch rotations can twin an epoch number (readers try all keys;
  convergent but unlovely); requesters re-offer private chains each exchange (duplicate-skip
  absorbs it; revisit if private chains get big).

## The ladder becomes tiers (restructured 2026-07-07)

M1-M3.5 were genuinely sequential: each rung consumed the previous one's output. What remains is
not - so from here down, work is grouped into **tiers of unordered tracks**. A tier is done when
its tracks are; tracks within a tier can be taken in any order, interleaved, or abandoned
mid-stream for a more motivating one. For a solo project, motivation is the scarcest resource,
and the structure should let it be spent where it lands. Real cross-track dependencies are listed
explicitly; everything unlisted is genuinely independent.

**Re-prioritized (2026-07-09) — the recommended route through the tiers.** Motivation still
rules, but the default path is now: **(1) admission modes + invite tokens** (registration
`closed`/`invite`/`open`, default invite - PROJECT_PLAN, Registration Modes) with the **vouch
payload live from day one**, so every IRL invite writes a trust edge and the graph grows before
the features that read it; **(2) 4C with the notes app as flagship** - the single-player
product ("come for the tool, stay for the network") that makes identity sync *felt*, and now a
hard dependency of posts: drafts are notes, and publication is an explicit crossing of the
private/public membrane (NOTES_APP.md, Publication); **(3) 4S +
the trust floor as one launch** - social ships wearing its thesis. Each stage independently
shippable; each makes the next one's demo better.

## Tier 4 — The product (three unordered tracks)

**4C — The client shell ("the cozy OS boots").** The retro-OS web client over the *existing* API
- zero new protocol. Toolchain (Preact + htm + esbuild, versioned asset serving), login, desktop
shell, identity switcher, profile editor, key/device management in cozy language - and the two
ceremonies that currently exist as raw JSON: the **recovery-key photo ceremony** (labeled QR,
blocked-until-captured; retires M2's residual) and the **add-a-node ceremony** (request/grant
codes as QR). Newly in scope (2026-07-09): **friend tokens / open server invites** - the
admission + redemption ceremony (node-local, no new protocol; PROJECT_PLAN, Friend Tokens and
the Bootstrap Problem) - and **the notes app**, the shell's flagship (spec: NOTES_APP.md): personal,
E2E-encrypted, multi-device notes - chain-spine headers + encrypted droppable blobs, version-DAG
divergence handling ("never silently lose words"). Its prerequisite is the **private blob lane**
(blob frames on the member-proven sync connection; NOTES_APP.md, Prerequisite), which 4M's media
reuses. The Cozyweb language budget is enforced from the first screen. *Track demo:* create
an identity, photograph the spare key, set your name, adopt a second node - all in a browser, no
JSON visible. *Advisory:* highest motivation-ROI track - it makes all subsequent work visible in
a UI instead of curl. *Amended 2026-07-23:* the client's substrate is the **live cache**
(PROJECT_PLAN, The Browser Is a View): a per-identity WebSocket view-delta stream into a
Dexie/IndexedDB mirror, optimistic shadow writes over the existing HTTP POSTs - websocket out,
POST in, browser never a device. It precedes the notes app, which then reduces to mostly
rendering; the build order inside 4C is therefore login (done 07-23) → identity management in
the UI → the stream + mirror → notes.

**4M — The markup language ("pages have a language").** The security-critical content boundary,
given the undivided attention the key tree got. First deployment target: the notes renderer
(friendly-content debut before the 4S stranger boundary; the plaintext era's real-note corpus
feeds the vocabulary cut - NOTES_APP.md, Markup). Vocabulary spec (resolving the open question),
the `page`/`post` payload types, the **strict parser twice** - Rust in proto (validation), JS in
the client (rendering) - kept honest by published markup test vectors, exactly the discipline
that guards the entry format. Safe renderer (AST -> DOM construction, never innerHTML); links out
left alone, embeds baked into local blobs at authoring time with their origin URL kept as
provenance (PROJECT_PLAN, An Embed Is an Ingest). Three payload obligations: a stable **`doc_id`**
on `page`/`post` (references target identities, never version hashes - NOTES_APP.md, Taxonomy),
a **labels field** (consent machinery rides the payload because strangers' servers filter on it;
organizational *tags* deliberately do NOT ride the payload - they are external taxonomy, same
doc), and no tags field ever, and the first blob types pass the **media-type admission test** (strict parse in a
sandboxed decoder, scanning story, metadata-privacy story - EXIF stripping is an authoring-client,
pre-sign concern). *Track demo:* a page with a tiled background and a
marquee, parsed by both implementations to identical ASTs.

**4S — The social layer ("other people exist").** Everything that crosses the inter-identity
boundary: the **public serving surface** (`/public/*` reads for non-owners - deliberately
deferred since M1), the `follow` type with its three disclosure tiers (quiet / tell-them / help-host -
PROJECT_PLAN, Edge-Endpoint Visibility), serving-follows, **`ringtome://` resolution** (the
ladder consuming M3.5's directory), identicons + contact names, **monotonic memory for remote identities** (the
residual owed since M2: returning-relying-party revocation memory belongs to this surface), and
the **serving-boundary defaults** from the plan's Moderation and Operator Liability section (the web-gateway question is
now settled - distinct dual-opt-in role, no anonymous HTTP by default; 4S builds the
member/peer-facing `/public/*` surface accordingly, gateway role deferred past Tier 6's gate).
*Track demo:* curl a stranger's profile (as an authenticated member of a node that serves them),
resolved from a `ringtome://` URL.

**Leaf dependencies (land in whichever track finishes last):** page-authoring UI = 4C + 4M;
reading view/feed = 4C + 4S; rendering a *stranger's* page = all three. **Tier exit demo:** two
users on two nodes follow each other and read each other's marquee-infested pages through the
fake OS. The project becomes showable to a non-nerd.

## Tier 5 — Trust

Trust is the thesis, not a feature to retrofit - a social launch without at least the floor is
a different, worse product. The corrected read: only the final *wiring* step depends on 4S; the
pure core is known math, buildable any time; and the graph should start growing before the
features that read it exist (PROJECT_PLAN, Trust: "The Graph Grows Before the Features
Arrive"). What stays later is refinements of a running system, labeled honestly.

- **Vouch statements** (deps: none; **promoted** - ships with the invite tokens, not after 4S):
  the signed "I met this human" payload, public v1 (the public-follows chain's first writer),
  retractable. Friend tokens carry the vouch flag from day one: every IRL invite quietly writes
  an edge - the seed crystal. Graph-privacy refinements (rounded scores, hidden nodes,
  resolution by closeness) stay later; they are subtle, the payload is not.
- **Flow computation engine** (deps: none - develops against the harness's synthetic graphs):
  the Advogato-style **joint-flow** calculation (never per-person; that detail is the whole
  Sybil defense), bounded horizon, as pure crate code, property-tested. Known, decades-old
  math - not research.
- **Adversary-simulation harness** (deps: none): a **calibration instrument and standing
  tripwire, never a launch gate**. It sanity-checks the joint-flow property before wiring (a
  week, not a program), tunes the budget/horizon/fade/floor knobs, then runs forever hoping to
  break things. Shipping ahead of exhaustive validation is covered by the plan's low-payoff
  principle: v1 trust gates only annoyance-priced, reversible surfaces.
- **Private chains** (COMPLETE 2026-07-08 - full report in HISTORY.md): the encrypted-chain
  infrastructure this tier needed, pulled forward and delivered. Vouches and contact names have
  their substrate.
- **Contact names** (deps: private chains - done): the private-register annotation and its UI;
  the "I know this person for real" ceremony belongs to 4C's language budget, on the same
  screen as the vouch (fork in the UI, never a coupling in the data).
- **Wiring trust into the product** (deps: 4S + the above): lands *with* the social launch, not
  after it - the coarse floor applied to the first low-stakes surfaces (feed ordering, a bot
  floor) as part of 4S's exit demo.
- **Deferred with honest labels** (refinements of a running system, not prerequisites renamed):
  credibility (needs track records that don't exist yet), interest/taste recommenders,
  graph-privacy resolution controls, harness-driven knob refinement.

## Tier 6 — Ship (unordered tasks; one gate, not an order)

- **Hosted deploy story** (deps: none): Dockerfile, `testnode-N.ringtome.ca`, ops docs - "some
  guy running infra in their spare time" made real.
- **Self-hosting documentation** (deps: deploy story): first-class artifact, per the plan's guard
  against hosted-first calcifying.
- **Desktop packaging** (deps: 4C, weakly - the tray needs a UI to open): tray sidecar, autostart,
  app-mode window, single installer, signing/notarization. The Ollama shape.
- **Mainline field test, distributed rung** (deps: none, startable any weekend): two
  internet-connected nodes on `RINGTOME_DISCOVERY=mainline` - the first genuinely-distributed
  run, exercising the NAT rung the 2026-07-22 same-box smoke test (see HISTORY) cannot. The
  opt-in live tier already exists: `just mainline-smoke` + the dispatch-only GitHub action.
- **Abuse tooling for public roles** (deps: none to build; **gates open/gateway modes** the same
  way the security pass gates exposure): the blob-layer scanner trait with the Shield by Project
  Arachnid backend (PDQ computed locally, hash-only queries, per-operator API keys), the
  quarantine + preserve + report flow, and hardened blob-serving defaults (validated
  Content-Type, nosniff, CSP sandbox, separate port). Denunciation statements and trust-weighted
  subscription land with Tier 5's trust wiring; this bullet is only what public-facing roles may
  not ship without.
- **Security pass** (deps: none to *do*; but it **gates public exposure**): a hostile review of
  the whole HTTP + sync surface. The one hard rule in this tier: no publicly-reachable node
  before it happens.

---

## Standing disciplines (all tiers)

- **Test vectors + spec fragments** grow with every wire format (entries, records, markup); they
  are what makes third-party clients and future-self debugging possible.
- **Integration suite**: every track extends it; the two-node harness is the default proving
  ground.

## Deliberately not yet

Passkeys/WebAuthn, recovery helpers (email/social), iroh-gossip real-time + DMs, the scripting
rung of the markup ladder, Godot anything, phones (PWA rides along for free), the push-gateway
role, snapshots/checkpoints, ActivityPub bridges. All named in the plan; none on the critical
path through Tier 6.

## Sequencing rationale, in one paragraph

Everything writes entries, so the entry format went first (M1); authority statements are entries
and sync validates against the tree, so the tree preceded the network (M2 before M3); sync needed
somewhere to find peers (M3.5). That's where hard sequencing *ends*: the product tier's three
tracks touch different layers and meet only at their leaves, trust needs the social layer only at
its final wiring step, and shipping is a checklist with a single gate (the security pass) rather
than an order. The ladder got us a correct substrate; the tiers spend motivation wherever it
lands - and every stopping point still leaves a runnable node behind.
