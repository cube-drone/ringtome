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

## Standing residuals (owed, with triggers)

Work that survived its milestone lives here until delivered (then it moves to HISTORY):

- **Fork-aftermath dragon** (owed since M3): schema room for fork *evidence* plus the re-signing
  recovery flow - due before or with whatever first shows a fork to a human (4C's key screens
  are the likely trigger).
- **Background sync + eager push** (owed since M3): sync is manual + adoption-time today. Now
  cheap - the loops.rs registry exists, so this is a one-pass function and a registration line.
- **Monotonic memory for remote identities** (owed since M2's status note): for *synced*
  identities the append-only entries table is structurally sufficient; for stranger resolution
  it does not exist yet. Lands with 4S's public serving surface.
- **Root-only adoption grants** (M3 trim): v1 only the root's node can authorize new nodes;
  relax when a real multi-node household hits it.
- **Mainline field test** (M3.5 residual; also a Tier 6 item): `RINGTOME_DISCOVERY=mainline`
  has never touched the real DHT.
- **PrivatePlain size caps** (4 KiB value / 6 KiB ciphertext): likely resolution - the caps are
  *correct*, because note/post bodies ride blobs, never inline records (NOTES_APP.md). Confirm
  and close when the blob lane lands; until then the caps stay unshipped-soft.
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
a UI instead of curl.

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

## Tier 5 — Trust (re-prioritized 2026-07-09: launch-critical, not post-launch)

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
- **Mainline field test** (deps: none, startable any weekend): two internet-connected nodes on
  `RINGTOME_DISCOVERY=mainline` - the first genuinely-distributed run, and the opt-in live test
  tier it leaves behind.
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
