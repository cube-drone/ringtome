# Ringtome — Next Steps

Companion to PROJECT_PLAN.md: the delivery ladder. The plan says what and why; this says *in what
order*, and — because there's a lot of stuff to deliver — what each rung must demonstrably do
before climbing to the next. Milestones end in a **demo**, not a merged branch: something you can
run and show. Rough sizing is relative, not calendar (solo project, weekends happen).

## Where we are: M0 — the skeleton (done)

- Axum node with `/health`, `/api/config`, tracing + correlation IDs, config-from-env with the
  node/desktop seams (`Tenancy`, bind address).
- `node.db` + per-identity databases with real sqlx migrations; moka-capped `UserDbManager`.
- Accounts and sessions: register/login/logout/whoami, Argon2 (minimal params in local-test mode),
  opaque server-side tokens, tag system with `node_admin`/`admin` and grant/revoke routes.
- Keystore: XChaCha20-Poly1305 envelope encryption, key files with pubkey-as-AAD, unattended-boot
  envelope key.
- Identity creation: root ed25519 keypair, sealed private key, per-user DB materialized.
- Test rig: Rust unit tests + mocha integration suite over real HTTP (~0.3s), local-test mode.

What M0 identities cannot do: **anything**. They exist; they don't sign. Everything below fixes
that, in dependency order.

---

## M1 — Entries that sign (the IM-AOL core, single node)

**Goal:** the canonical byte format and the append-only chain machinery — the substrate every
other feature writes to. This is PROJECT_PLAN's entry schema v0 made real.

- Canonical CBOR encode/decode (RFC 8949 §4.2 deterministic mode), NFC string normalization,
  unknown-field carry-through.
- Entry type registry v0 (`chain-entry`, `authorize`, `revoke`, `profile-set`, `post`, ...) and
  version tags.
- BLAKE3-256 entry hashing; **store-the-author's-original-bytes** discipline in the per-user DB
  (bytes column is the truth; never re-serialize).
- Domain-separated ed25519 signing (`ringtome-v1/chain-entry` etc.) using the keystore's keys.
- Per-(key, service) chains: dense seqs, `prev_hash` links, append + full-chain validation.
- Header/blob split from day one (plan: retrofitting is a protocol break). The *format* carries
  both payload kinds now; node-side blob storage arrives with its first real consumer
  (`iroh-blobs`, M3 - nothing in M1 produces a blob worth storing).
- **First consumer: `profile-set`** (display name, bio) with LWW materialization into the per-user
  DB — chosen because it exercises sign → append → validate → materialize end to end with the
  simplest possible semantics.
- **Test vectors published** (`spec/test-vectors/`): logical entry → exact bytes → hash →
  signature. These are the conformance boundary; start the habit now.
- `ringtome inspect <entry>` debug tool (the plan's promised readability escape hatch).

**Exit demo:** set a display name through the API; watch a signed entry land on a chain; wipe the
materialized view tables and rebuild them by replaying the entries log (re-validating every
signature and hash link as it goes) and get the same state back. The log and the views share the
per-user `.db` file - the log is the part that replicates in M3; the views are the part that's
disposable. That rebuild *is* the materialized-view promise, proven in miniature.

**Status: COMPLETE (2026-07-06).** `ringtome-proto` crate (strict canonical CBOR, envelope
`[body, sig]`, BLAKE3, domain-separated ed25519, chain validation; 30 unit tests), published
vectors in `spec/test-vectors/entry-v0.json` (bless-pattern guarded), per-user `entries` +
`profile_view` schema, LWW materialization with `(timestamp, seq, hash)` tiebreak, owner-gated
profile/rebuild/entries API, `ringtome inspect`. Suite: 44 Rust + 43 integration tests. The exit
demo runs as the `profile.cjs` "rebuilds an identical profile" test.

**Sizing:** the largest purely-local milestone; fiddly, zero research risk.

**Design notes (settled at implementation start):**

- **The protocol code lives in a separate workspace crate, `proto/` (`ringtome-proto`).** Why a
  crate and not a module: (1) *compiler-enforced dependency firewall* - its manifest lists blake3,
  ed25519-dalek, thiserror, unicode-normalization and nothing else (no tokio/sqlx/axum), so the
  layer that third-party implementations must reproduce bit-for-bit physically cannot grow a
  dependency on node state; in a module that purity is a convention that erodes one convenient
  import at a time. (2) *The conformance boundary gets a name*: "the protocol is `ringtome-proto`,
  the node is one consumer" is the artifact you hand a future client author, and its rustdoc
  accompanies the test vectors. (3) *The fast test loop lands where the hard tests live* -
  `cargo test -p ringtome-proto` skips the tokio/sqlx/axum build, and M2's key tree (the most
  property-test-heavy code in the project) lives in this same crate; it is also where fuzz targets
  for the strict decoder attach. (4) Cost is ~15 lines of TOML; multi-crate workspaces are the
  Rust idiom (iroh itself is protocol crates around a node crate), and the root Cargo.toml was
  already a workspace.
- **COSE-style envelope instead of sig-as-a-map-field.** The wire object is `[body: bstr,
  sig: bstr]`; the signature covers `domain-tag || body-bytes`, so verification slices the
  received bytes and *never re-serializes*. Re-encoding during verification is exactly where
  canonical-encoding bugs become forgery bugs; this makes the store-original-bytes rule structural
  rather than disciplinary. (Deviates from the plan's PROVISIONAL v0 field layout, which put `sig`
  inside the entry map - PROJECT_PLAN.md to be updated when M1 lands.)
- **Hand-rolled strict canonical CBOR subset, not a serde library.** ~250 lines. The encoder is
  the spec (test vectors promise exact bytes; a derive macro's choices shouldn't be load-bearing),
  and - the part libraries don't offer - the *reader rejects non-canonical input*: non-minimal
  integer heads, indefinite lengths, unsorted map keys, non-NFC text, tags/floats. Entries are
  hostile network input; one logical value = exactly one accepted byte encoding. v0 subset:
  uints, byte strings, text, arrays, maps; depth-limited.

## M2 — The key tree (authority, still single node)

**Goal:** the identity model — everything in the plan's "Identity System" section becomes code
that consumes M1 entries.

- `authorize` statements with cumulative usurper lists; chain-to-root validation (rule 4: full
  chain or nothing).
- Rank-path total ordering; equivocation detection (un-orderable siblings) + deterministic
  tiebreaker.
- Retirement and repudiation revocations, with `(chain_id, seq, head_hash)` anchors across the
  key's whole bundle; quarantine semantics on the materialized view.
- **Recovery key minted at identity creation** as the early child of the root, offered for
  download (file first; QR later). Identity creation now writes its first real chain entries.
- Monotonic memory: the node remembers the highest-authority statement seen per identity.

**Exit demo (tests, not UI):** property tests generating arbitrary honest trees and asserting
total order; forced equivocations detected and resolved convergently; a repudiation retroactively
quarantining a hostile key's post-cut entries; the recovery key outranking everything minted after
it. This milestone is pure logic — the most unit-testable code in the project, and the code that
most deserves it.

**Sizing:** medium; high subtlety, low plumbing. Resolve the plan's open **recovery-key UX**
question here (minimally: download-or-you-can't-continue?).

**Status: COMPLETE (2026-07-06).** `proto::keytree` (chain linearization with deterministic fork
resolution + evidence, usurper-stamp cross-check, rank-path total order, seniority-sorted
retirement/repudiation with anchored ceilings; 11 scenario tests + a 25-seed property test
covering totality/antisymmetry/transitivity, recovery-position-outranks-all, and shuffled-arrival
convergence). `Authorize`/`Revoke` codecs with two new appended test vectors. Node side: identity
creation mints the recovery key and writes the identity chain's genesis authorize; the recovery
secret is returned exactly once and never persisted; `GET /api/identity/{root}/keys` exposes the
resolved tree; `ringtome inspect` decodes authorize/revoke payloads. Notes: (a) monotonic memory
needs no mechanism for *own* identities in a single-node world - the append-only entries table is
it; it becomes a real component at M3's sync boundary for *remote* identities. (b) The
recovery-key UX question is half-resolved: the API contract (secret appears once, in the creation
response) is settled; the human ceremony (download-or-blocked, print, QR) lands with the first
client in M4. (c) Design review flagged two dragons for later milestones: fork-aftermath re-signing
(promoted to an M3-adjacent design obligation) and the recovery-key-as-permanent-skeleton-key UX
weight (the Cozyweb ceremony must carry it).

## M3 — Two nodes, one identity (iroh + sync)

**Goal:** the network exists. The plan's custom sync protocol, first contact with iroh.

- Iroh endpoint in the node; ringtome-node keys distinct from identity keys (signature domains
  already enforce this).
- Sync protocol v1 over iroh bidi streams: version-vector/frontier exchange, entry transfer,
  **validation gate at the protocol boundary** (identity chains first, then content; revoked
  authors rejected before storage).
- **Frontiers are `[floor..head]` ranges from day one** (PROJECT_PLAN: Shallow Sync). Identity
  chains always sync full; content chains suffix-first with lazy backfill. Even if M3's two-node
  demo always syncs full chains in practice, the *protocol messages* must express held ranges -
  retrofitting shallowness into a dense-from-zero wire format is a protocol break.
- The "Adding a New Node" flow end to end: Node B generates a keypair, its pubkey travels to Node
  A (copy-paste is fine for now), A's key signs the authorization, B receives its chain and starts
  syncing.
- pkarr: each node publishes its record (addresses + chain-to-root) under its own node key on the
  republish schedule; resolution path for known node keys.
- `iroh-blobs` replaces local-file blob storage.

**Exit demo:** create an identity on node A; authorize node B; set the display name on B; read it
from A. Kill A; B keeps serving. Repudiate B's key from A; B's later writes are rejected
everywhere. (Run two nodes on one machine — different ports/data dirs; the integration harness
already knows how to boot throwaway nodes.)

**Sizing:** the big one. First milestone with genuine research risk (NAT traversal behavior, pkarr
liveness in practice). Keep scope brutal: two nodes, one identity, no gossip, no discovery UX.

**Status: COMPLETE (2026-07-07), with two deliberate scope trims and honest residuals.**
Shipped: iroh 1.0 endpoint per node (persistent node key sealed in the keystore;
`presets::Minimal` - zero external infrastructure), `proto::sync` wire messages (Hello with
`[floor..head]` frontiers as committed, Entry, Done; version in the ALPN), the symmetric-exchange
sync engine with the validation gate ahead of storage (strict decode -> signature -> chain
contiguity -> key-tree membership -> revocation ceilings; anchored history of retired/repudiated
keys honored, everything beyond refused), the add-a-node ceremony (request code / grant code, two
copy-pastes; adopted nodes sign with granted leaf keys), the revocation API, and the full exit
demo as a two-node integration test: adopt, write-on-B-read-on-A, full-copy resilience, and
repudiation with A's gate refusing the evicted key's writes ("EVIL TWIN" stays on B).
*Trims:* iroh-blobs deferred to M4 (no blob producer exists until posts); pkarr deferred (direct
addressing rides in the adoption codes; `presets::N0` is the one-line path to relays + pkarr when
a public network exists). *Residuals:* (a) sync is manually triggered (`POST .../sync`) +
adoption-time - background interval + eager-push land with gossip; (b) v1 grants adoption only
from the root's node; (c) **fork evidence cannot yet be *stored*** - the entries PK
`(author, service, seq)` means a conflicting entry arriving over sync is rejected at the gate
(safe, convergent) but its bytes are dropped rather than kept as equivocation proof, and the
fork-aftermath re-signing flow remains undesigned. That dragon is still owed; schema room for
fork evidence should come before or with M4's client, which is where a user would first *see* a
fork.

## M3.5 — Discovery (added 2026-07-07; pulled forward because M4's `ringtome://` resolution needs it)

**Goal:** dial-by-key everywhere; addresses stop being our data. Two layers, one trait, one stub.

- **Serving records** (proto surface): a signed statement published under an identity **leaf key**
  - "this leaf serves root R, reachable at endpoint E" - domain `ringtome-v0/serving-record`,
  canonical CBOR, test-vectored. Trust never comes from the record (chain-to-root verification
  happens at sync time, per the plan); records are pointers + liveness only, so they fit pkarr's
  1000-byte budget trivially. Keyed by leaf keys so they never collide with iroh's own
  per-endpoint pkarr records.
- **The `Directory` trait** with two implementations: `MainlineDirectory` (pkarr crate, real DHT)
  and `LocalDirectory` - a shared-folder fake storing the *same signed bytes*, honoring the same
  one-record-per-key + TTL semantics, spanning the two test-node processes. The stub is also the
  future attack harness (eclipse, staleness, wrong-key records on demand).
- **Config seam:** discovery mode selects the iroh preset too - local mode = `presets::Minimal` +
  `LocalDirectory` (which also simulates iroh's endpoint-address layer via unsigned endpoint
  records); mainline mode = `presets::N0` (relays + iroh's own discovery) + `MainlineDirectory`.
- **Publication is an act:** serving records publish only for identities explicitly marked
  served (a `served_at_ms` flag + API), never as a side effect of creation or adoption. Endpoint
  records (transport plumbing, not identity-linked) publish whenever networked, like every iroh
  app.
- **The `addrs` column dies.** Peers are endpoint ids; addresses come from the directory at dial
  time. Adoption codes keep carrying bootstrap addresses (ephemeral, single-use - allowed to be
  addresses precisely because they don't live long enough to rot).
- Republish task on an interval (pkarr TTL-scale); the two-node suite runs entirely on the stub;
  live-DHT behavior gets an opt-in test tier later, not a CI dependency.

**Status: COMPLETE (2026-07-07).** `proto::directory` serving records (signed, `ringtome-v0/serving-record`
domain, well under the pkarr budget), `discovery::Directory` (Off / Local shared-folder stub with
TTL-as-liveness + key-binding checks / Mainline via pkarr 5), config seam `RINGTOME_DISCOVERY`
selecting the iroh preset, dial-by-id throughout (`sync::dial_addr`), the `addrs` column dropped
(migration 0006), `served_at_ms` + `POST .../serve` as the publication act, and a 15-minute
republish loop. The M3 exit demo passes entirely on directory-based dialing; a new integration
test proves dark-at-birth / signed-record-after-serve. *Untested residual:* `Mainline` mode
compiles against pkarr 5.0.3 but has never touched the real DHT - that's the opt-in live tier /
first field test, still owed. (pkarr 6 was blocked by an ed25519 release-candidate conflict with
iroh 1.0; revisit when the ecosystem settles.)

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
product ("come for the tool, stay for the network") that makes identity sync *felt*; **(3) 4S +
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
the Bootstrap Problem) - and **the notes app**, the shell's flagship: personal, E2E-encrypted,
multi-device notes on the private store. Immediate single-player value, a daily dogfood loop,
and the store layer already carries it server-side (one data-map row). Settle `PrivatePlain`'s
4 KiB value / 6 KiB ciphertext caps before anything real deploys - free now, a compatibility
question later. The Cozyweb language budget is enforced from the first screen. *Track demo:* create
an identity, photograph the spare key, set your name, adopt a second node - all in a browser, no
JSON visible. *Advisory:* highest motivation-ROI track - it makes all subsequent work visible in
a UI instead of curl.

**4M — The markup language ("pages have a language").** The security-critical content boundary,
given the undivided attention the key tree got. Vocabulary spec (resolving the open question),
the `page`/`post` payload types, the **strict parser twice** - Rust in proto (validation), JS in
the client (rendering) - kept honest by published markup test vectors, exactly the discipline
that guards the entry format. Safe renderer (AST -> DOM construction, never innerHTML),
blob-hash-only embeds enforced at the grammar. Two obligations from the plan's Moderation and
Operator Liability section: reserve a **labels field** on `page`/`post` payloads (content labels
are consent machinery; retrofitting label semantics into signed content is a protocol break in
miniature), and the first blob types pass the **media-type admission test** (strict parse in a
sandboxed decoder, scanning story, metadata-privacy story - EXIF stripping is an authoring-client,
pre-sign concern). *Track demo:* a page with a tiled background and a
marquee, parsed by both implementations to identical ASTs.

**4S — The social layer ("other people exist").** Everything that crosses the inter-identity
boundary: the **public serving surface** (`/public/*` reads for non-owners - deliberately
deferred since M1), the `follow` type with its three disclosure tiers (quiet / tell-them / help-host -
PROJECT_PLAN, Edge-Endpoint Visibility), serving-follows, **`ringtome://` resolution** (the
ladder consuming M3.5's directory), identicons + contact names, and the **serving-boundary
defaults** from the plan's Moderation and Operator Liability section (the web-gateway question is
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
- **Private chains** (deps: none; newly surfaced prerequisite): vouches and contact names live on
  *encrypted* chains synced only among an identity's own nodes - infrastructure no milestone has
  built yet (encryption scheme, key distribution within the tree, the never-serve-across-the-
  identity-boundary rule at the sync gate).

  **Status: COMPLETE (2026-07-08).** The full scheme is written up in PROJECT_PLAN's new "Private
  Chains: Epoch Keys and the Membership Boundary" section. Proto: `key-epoch` / `private-record`
  payloads + `PrivatePlain` (register / set-add / set-remove), `enc_pubkey` on authorize
  (additive field 2), channel-bound `MemberProof` in the sync Hello - all vectored. Node:
  `seal.rs` (dryoc sealed boxes + photo-seed recovery derivation, under the crypto byte-boundary
  policy), `private.rs` (epoch unseal/mint/rotate, XChaCha record crypto, in-memory LWW register
  + set views), identity creation mints the root enc key + epoch 0 and derives recovery from a
  seed, adoption re-seals the epoch history + a second member-proven sync pulls the private
  chains, every revocation rotates the epoch, and the sync gate withholds private entries *and
  frontiers* from unproven peers in both directions. Owner-gated `/private/kv/*` +
  `/private/set/*` API. Proven end to end by `private.cjs`: adoption carries private state to the
  new node, private writes flow both ways, and a revoked node keeps reading its era while the
  post-rotation record never even reaches it. *Residuals:* (a) concurrent rotations can twin an
  epoch number - readers try all keys for an epoch and the AEAD tag disambiguates; convergent but
  unlovely; (b) the epoch boundary is eventual under partition (a not-yet-informed member writes
  under the old epoch; readable by all, by design); (c) the `identity-private` service is gated
  but writer-less; (d) requesters re-offer private chains every exchange (duplicate-skip absorbs
  it) - revisit if private chains ever get big.
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
- **Fork-aftermath dragon** (owed since M3): schema room for fork *evidence* plus the re-signing
  recovery flow - due before or with whatever first shows a fork to a human (4C's key screens are
  the likely trigger).

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
