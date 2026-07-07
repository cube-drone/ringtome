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

## M4 — Someone can actually use it (first social features + the client)

**Goal:** the answer to the plan's "what social features first?" open question, proposed here as:
**profiles, pages, posts, follows** — the geocities-shaped minimum. Plus the client to see them in.

- Content types: `post` (markup blob), `page` (markup blob at a stable path), public `follow`.
- **Markup v1, static rung** (Content Markup section): strict grammar → AST → safe renderer;
  blob-hash-only embeds; the shameless tags. This is where the open **markup vocabulary v1**
  question gets settled — spec the tags alongside the types that carry them.
- `ringtome://` URL resolution (root + nodeID + hints → pkarr → verify-against-root), at least for
  identities the node can reach.
- **Retro-OS web client v0** (Preact + htm + esbuild, served by the node): login, persona
  switcher, profile page, page authoring with the markup, a followed-identities reading view.
  Identicons from root pubkeys. Cozy comes incrementally; correct comes first.
- Settle the plan's open **web gateway** decision (it gates how public resource addressing must
  be — needed before the content types calcify).

**Exit demo:** two users on two different nodes follow each other, author pages, and read each
other's stuff through the fake-OS UI. Screenshot-able. This is the milestone where the project
becomes showable to a non-nerd.

**Sizing:** wide but shallow; mostly product work on top of M1–M3 machinery.

## M5 — Trust (vouches + the adversary harness)

**Goal:** the trust substrate, before the network is big enough to need it.

- Vouch statements (private chain), the network-flow trust computation over a bounded horizon,
  the coarse floor gate; contact names (private chain) with the render rule.
- **Adversary-simulation harness**: generate honest graphs, inject Sybil clusters in nasty
  topologies, measure trust extracted per attack vouch. Run it hoping it breaks. (See background
  tracks — this can and should start earlier; M5 is where it must exist.)
- Wire trust into something deliberately low-stakes first (feed ordering or a DM floor), per the
  plan's low-payoff principle.

## M6 — Ship it (delivery + operations)

**Goal:** other people can run this without talking to us.

- `testnode-N.ringtome.ca`: Dockerfile, deploy story, ops docs; the "some guy running infra in
  their spare time" path made real.
- Desktop packaging: tray sidecar (tray icon, autostart, app-mode window), single installer,
  signing/notarization. The Ollama shape from the plan's Client Story.
- Self-hosting documentation as a first-class artifact (the plan's explicit guard against
  hosted-first calcifying).
- A security pass over the whole HTTP + sync surface before the first public node.

---

## Background tracks (parallel to everything)

- **Adversary-sim harness** (pure math, zero dependencies on the node): start whenever the trust
  design needs thinking-through; it doubles as the design tool for budget/horizon/fade knobs.
- **Test vectors + spec fragments**: grow with M1/M2; they're what makes third-party clients and
  future-self debugging possible.
- **Markup vocabulary spec**: draft during M2/M3 so M4 starts with a reviewed tag list.
- **Integration suite**: every milestone extends it; two-node scenarios join at M3.

## Deliberately not yet

Passkeys/WebAuthn, recovery helpers (email/social), iroh-gossip real-time + DMs, the scripting
rung of the markup ladder, Godot anything, phones (PWA rides along for free), the push-gateway
role, snapshots/checkpoints, ActivityPub bridges. All named in the plan; none on the critical
path through M6.

## Sequencing rationale, in one paragraph

Everything writes entries, so the entry format goes first (M1). Authority statements are entries,
and sync must validate against the key tree, so the tree precedes the network (M2 before M3).
Social features are just more entry types once sync works, and the client renders what sync
delivers (M4). Trust arrives before scale makes it load-bearing (M5), and packaging comes last
because a delightful installer for a network with no people in it helps nobody (M6). Each
milestone's demo is the next one's foundation — and every one of them leaves a runnable node
behind.
