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
- Header/blob split from day one (plan: retrofitting is a protocol break). Blobs are local files
  for now; `iroh-blobs` arrives in M3.
- **First consumer: `profile-set`** (display name, bio) with LWW materialization into the per-user
  DB — chosen because it exercises sign → append → validate → materialize end to end with the
  simplest possible semantics.
- **Test vectors published** (`spec/test-vectors/`): logical entry → exact bytes → hash →
  signature. These are the conformance boundary; start the habit now.
- `ringtome inspect <entry>` debug tool (the plan's promised readability escape hatch).

**Exit demo:** set a display name through the API; watch a signed entry land on a chain; delete
the per-user `.db` file; rebuild it from the chain and get the same state. That rebuild *is* the
materialized-view promise, proven in miniature.

**Sizing:** the largest purely-local milestone; fiddly, zero research risk.

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

## M3 — Two nodes, one identity (iroh + sync)

**Goal:** the network exists. The plan's custom sync protocol, first contact with iroh.

- Iroh endpoint in the node; ringtome-node keys distinct from identity keys (signature domains
  already enforce this).
- Sync protocol v1 over iroh bidi streams: version-vector/frontier exchange, entry transfer,
  **validation gate at the protocol boundary** (identity chains first, then content; revoked
  authors rejected before storage).
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
