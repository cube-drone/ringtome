# Ringtome — Delivery History

The append-only delivery log: what shipped, when, with the honest status notes and residuals
**as recorded at the time**. The other documents stay lean because this one exists -
NEXT_STEPS.md is forward-looking only (one line per finished rung, pointing here), and
PROJECT_PLAN.md carries the design with `(IMPLEMENTED)` markers. History holds still, so this
file only grows at the bottom and never rots.

Live residuals are tracked in NEXT_STEPS ("Standing residuals"); the residual notes below are
snapshots of what was owed on each ship date.

---

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
  rather than disciplinary. (Deviates from the plan's original provisional field layout, which put `sig`
  inside the entry map; the plan's schema section was updated to match. Canonical rationale
  lives in `proto/src/entry.rs`'s module doc.)
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

---

## Private chains (2026-07-08)

Pulled forward from Tier 5 as a newly-surfaced prerequisite, and delivered:

**The ask:** vouches and contact names live on
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

---

## The store layer (2026-07-08)

`node/src/store.rs`: the application data map (one table declaring every variable's chain, merge
rule, visibility, materialization, and sync policy) plus typed handles exposing exactly each
CRDT's legal operations - profile LWW register, private registers/sets, the posts `AppendLog`
(append/page, suffix-tolerant reads), and read-only `PublicView` for 4S. Routes went on a diet;
application code stopped touching `imaol`/`private` directly. Same day: timestamps unified to
`i64` end to end (strict decoder rejects the absurd range), `received_at_ms` per replica, and
the authoring clamp closing the fast-clock LWW wedge.

---

## Doctrine interlude + a license (2026-07-09 → 07-14)

A documentation stretch between build pushes: NOTES_APP.md born (07-09) - the first application
spec, multi-device encrypted notes as the proving tenant for the private store. Slug/address-bar
resolution designed into the plan (07-11), groups planning sketched (07-14), and the PROJECT_PLAN
rewritten in place up through Recovery Planning (07-14). License settled: **AGPL-3.0 for now**
(07-12).

---

## The file layer + CI (2026-07-15)

`files.rs`: encrypted, content-addressed file bodies, stored and transferred by iroh-blobs over
a second ALPN on the same endpoint. A "file" is XChaCha ciphertext under the epoch key with a
random nonce, content-addressed by the BLAKE3 of the *ciphertext* - unlinkable, which is why
serving needs no gate: holding the hash is the capability. One content-agnostic layer for note
bodies, posts, and media alike.

Same day, **CI**: a GitHub Actions workflow that runs `just ci` verbatim - the push gate is
byte-identical to the local gate, so the two cannot drift.

---

## Versioned documents - the notes lane (2026-07-15 → 07-17)

The notes app's storage, per NOTES_APP: a document is a stable `doc_id` whose versions form a
DAG. Each save appends one encrypted `doc-header` entry to the notes chain (the version's
identity is the entry's own hash; `parents` are the hashes it was edited from) with the body as
an encrypted file in the file layer. The materializer folds headers into per-document DAGs and
**detects** divergence rather than resolving it - keep-both is the universal never-lose answer;
merge is a per-format capability dispatched on the document's type. Shipped across "basic note
merging machinery" → "merging behaviors" → the DAG proper (07-16), then two text formats -
marquee AND plaintext - with the conflict format dispatching on type (07-17).

---

## Media ingest (2026-07-18 → 07-20)

The binary-documents lane, one weekend of escalation: WebP as the first media format (binary
body endpoints, keep-both divergence, nosniff+sandbox isolation on serving; `notes.rs` renamed
`documents.rs`) → stills AVIF-ified (animated exempt) → size caps split into their two honest
meanings (the pre-crunch upload ceiling vs. the ~10MB nothing-bigger-moves-on-the-network
distribution cap) → a single deliberately-low output quality tier → video ("IT IS TIME TO
CRUSHA DA VIDEO"): browser playback verified, WebM canonical output with poster frame and
silent micro-preview, then audio through the same crush. Ingest became one async pipeline for
all of it: raw upload lands in a disposable quarantine directory, a `pending` row goes into
`ingest_job`, the caller gets a version-less `doc_id` back immediately (version-less IS the
pending state), and a background worker drains the queue FIFO, transcoding on `spawn_blocking`;
terminal failures surface as tombstones in the queue, never ghost documents. Capped by "give it
pretty much anything" unification, video thumbnails, and a structural pass enforcing parallels
across the audio/video/media modules (07-20).

---

## Crown hardening: revocation anchors by hash (2026-07-20)

A revoked-but-still-held key could forge an alternative under-ceiling prefix that fresh or
late-syncing nodes would accept - enforcement was seq-only, because the crown discarded the
anchor's `head_hash` and every test used zeroed hashes. Now: **sealed-prefix-as-unit** crediting
in the crown, **seal-or-nothing** admission at the sync gate (the prefix walked by hash-link
from the anchor down to `ZERO_HASH`), and **proven-forgery eviction** for the race where the
forged prefix arrived first. The adversarial tests were verified to fail against the old
seq-only behavior before the fix landed.

---

## The substrate: Turso, the journal, materialized views (2026-07-20 → 07-21)

The data-layer rewrite, in the order the plan sequenced it so nothing interim was built to be
thrown away:

- **Turso** (07-20): the database engine swap, with page-level at-rest encryption (AEGIS-256) -
  every database gets its own random key sealed in the node keystore, and there is no
  unencrypted mode (a database file with no key file refuses to open rather than minting a key
  over the tell). Schema policy pre-launch: squash into `0001`, generation-stamped, rebuild
  never migrate-in-place.
- **The journal** (07-20): the insurance that lets a beta database engine sit under the views.
  One append-only flat file per identity - length-framed signed envelopes, no checksums, no
  timestamps, because replay re-runs the full validation gate and integrity rides the
  signatures. Write-ahead at both entry-insert sites; journal ⊇ database is the invariant.
- **Materialized views** (07-21): the private register/set views moved from in-memory to
  persistent tables with per-chain watermarks, catch-up-on-read, and the stall rule (a
  watermark never passes an entry this key-set can't decrypt). Everything in a per-user DB
  outside `entries` is now a disposable projection, rebuildable by replay - and the conventions
  cop's table-ownership map grew to enforce the new tables' single owners.

---

## The embedded UI (2026-07-21)

The Preact SPA, served by the node itself: esbuild bundles and the HTML shell baked into the
binary at compile time (`include_str!`, fonts and all), versioned static asset paths, so the
deployed binary is fully self-contained. `just start` boots server + JS/CSS watchers in one
terminal with one Ctrl-C teardown.

---

## Mainline field test (2026-07-22)

`RINGTOME_DISCOVERY=mainline` touched the real DHT for the first time - the M3.5 "untested
residual" closed. Two nodes on one box against the actual public infrastructure: a serving
record published under the leaf key and resolved back out of the DHT through the *other* node's
pkarr client (via a LOCAL_TEST-gated resolve passthrough - notably the first caller the mainline
resolve path has ever had), the adoption ceremony, then both nodes restarted - address caches
gone, fresh UDP ports - and a re-sync driven by nothing but a bare endpoint id through iroh's N0
discovery (n0 DNS + pkarr publishing; the preset contains no same-box shortcut, verified in
iroh's source). Healthy-infrastructure runs complete in ~7 seconds because pkarr relays and
`iroh.link` answer in one round trip; the test budgets minutes as retry ceilings for when they
don't. Shipped as `just mainline-smoke` plus a dispatch-only GitHub action ("Mainline smoke")
that uploads per-node logs win or lose. *Residuals:* what's been observed passing is the
relay-assisted path - the raw-DHT fallback (relays down) has never been exercised; and same-box
means the NAT-traversal rung stays owed to the eventual two-real-houses run. Each run publishes
throwaway records (and the runner's IP) to the public DHT, by design.

---

## Background sync + eager push (2026-07-22)

The M3 residual delivered: sync stops being manual. `net/resync.rs`, two registered passes over
the existing point-to-point exchange - **eager push** (2s tick: per-root frontier fingerprints
compared across ticks, a debounce that waits for the write burst to quiet plus a 30s
max-latency cap, then a full exchange with every known peer) and **anti-entropy**
(5-minute default: up to 3 randomly chosen peers per identity, dirty or not, first pass at
boot). Entries *received* by sync re-dirty the frontier and relay onward next tick - epidemic
spread over the peer graph, converging because an up-to-date exchange moves nothing. Privacy
needed zero new logic: member proofs inside the exchange decide disclosure regardless of who
dials. Doctrine clarified along the way: "Rehosting: Pull, Not Push" governs *hosting*, not
sync initiation - hosts holding tradeable information SHOULD sync unprompted (scope note now in
the plan). Knobs: `RINGTOME_SYNC_DEBOUNCE_MS` (3000), `RINGTOME_RESYNC_INTERVAL_SECS` (300).
Proven by `eagersync.cjs`: public and private writes surface on the peer node in ~4s with the
sync route never called, both directions.

The feature flushed out two latent concurrency defects, both fixed:

- **Turso connections refuse overlapping statements** ("concurrent use forbidden") - every `Db`
  clone shares one connection, a race that stayed theoretical while traffic was request-driven
  and became constant under a 2s poll. Fix: a per-statement async lock inside `Db` (safe
  because every helper drains its statement before returning).
- **Concurrent sync-gate ingests raced between head-read and insert**: eager push makes
  simultaneous bidirectional exchanges routine, both carrying the same re-offered private
  entries; the losing batch died on the `entry_hash` UNIQUE constraint instead of
  duplicate-skipping, and the spurious failure armed the retry backoff. Fix: a per-identity
  ingest gate (`Db::lock_ingest`) held across each validate-and-store batch.

*Design note:* the tracker seeds newly-observed roots **dirty** - seeding clean was empirically
shown to swallow writes landing between adoption's peer-add and the loop's first look; the
price is one no-op frontier exchange per root per boot. *Residuals:* offline peers get one warn
+ a 30s lazy retry (anti-entropy is the reliability layer); a slow-failing dial can stall one
eager pass (bounded, `tokio::time::timeout` is the follow-up if it bites); the "requesters
re-offer private chains each exchange" watched-item is now load-bearing on every eager cycle -
its "revisit if private chains get big" may come due sooner; and open-by-default sync
initiation opens the sync-request-flooding question, now a NEXT_STEPS exploration item.

---

## Annotations: the doc-meta chain (2026-07-22)

The data-layer rewrite's remaining step, and the first tenant of the substrate the sequence was
built around: `doc-meta-private` (service 7), the pre-graduated chain for private facts about
documents (PROJECT_PLAN, Annotations). `annot:<root>/<doc_id>` collections on the existing
`PrivatePlain` codec - LWW registers for fields (`description`, `artist`, ...; absent *or
empty* reads as cleared), set-elements for tags, the 2 KiB value cap enforced at the handle
with the refusal naming the alternative (a description that big is becoming another document -
write one and reference it). The mandatory mechanics all present: a fresh AAD
(`ringtome-v0/doc-meta-record`, with unknown-service-is-an-error dispatch), the
`is_private_service()` line at the sync gate, and the withheld-from-strangers test cloned
(`doc_meta_chains_are_withheld_from_unproven_peers`). The persisted view tables absorbed the
new service with zero schema change - `service` rode their primary keys from day one, exactly
as the migration comment promised - and the docs-list read gained `doc_heads`, a memoized
per-document display row (not judgment-in-SQL: it remembers the Rust resolver's latest answer,
recomputed for exactly the documents whose inputs changed; disposable like every view). Tags
answer in both directions off the same table - all of D's tags, all docs tagged X - with
`summaries`/`summaries_for` serving the docs-list and docs-by-tag reads as one query after
catch-up. Proven by store unit tests plus `annotations.cjs` over HTTP: LWW convergence, both
read directions, created/modified ordering (claimed stamps only), the oversized refusal, and
annotations riding adoption's member-proven sync onto a second node.

Same day, the taxonomies design was **amended in place** (PROJECT_PLAN, Taxonomies): ordered
structure decomposed to per-element facts on the same doc-meta machinery - `tax:` collections
whose set elements carry `(parent, rank)` values, order assembled by the materializer -
retiring "a taxonomy is a document" for the private working form (taxonomy documents remain as
the publication form). Same grounds as the 07-20 tags amendment: the wire shape is chosen on
merge grounds alone, and two devices each adding to a list must union, not conflict.

---

## Taxonomies, v1 lists (2026-07-22)

The amended design built, same day: ordered document lists as per-element ranked facts on the
doc-meta chain - zero new wire format, zero new tables (the service-keyed set table absorbs
`tax:` collections as it absorbed `annot:`). The pieces:

- **`record/rank.rs`** - fractional base-36 ranks, a client-of-the-store convention. `between`
  for inserts, compact-append `after` (~one digit per 18 appends, so a bulk import stays
  cheap). Review caught two real bugs before they shipped: gapless intervals (`"a" < x <
  "a0"` has no base-36 solution) and same-digit-collapsing hostile bytes could each hang the
  midpoint walk - both now terminate as deliberate rank duplicates, regression-tested, with
  the module doc stating the contract (termination on arbitrary input; order only for
  well-formed ranks). Rebalancing bloated lists is a named REFACTOR.md deferral.
- **The `Taxonomies` store handle** - existence is a roster fact (`taxonomies` set: empty
  lists exist, deletion is one remove, the member facts stay on the chain unsurfaced);
  members are set elements in `tax:<id>` carrying rank values; **place is add AND move** (a
  set re-add updates the value under the same LWW stamp - one write, drag-and-drop index
  semantics, a mover is never transiently absent); titles are ordinary annotations on the
  taxonomy's own id, so rename/describe needed no machinery and no routes. A foreign
  identity's document is representable as a member from day one (third-party curation).
- **Routes** - create/list/get/delete plus member put/delete; the get joins members against
  the memoized `doc_heads` rows in list order (own docs get summaries, a stranger's doc rides
  as `doc: null` until 4S serves it).

Proven by the rank property tests, four store tests (order through the CRDT, empty-exists /
deleted-does-not / same-id-resurrects, foreign-root members, rebuild survival), and six
integration tests over HTTP (`taxonomies.cjs`), including rename-via-annotations and the auth
boundary. *Residuals:* trees (the deterministic fold-time cycle rule) and the published
taxonomy document stay designed-ahead in the plan; rank rebalancing deferred (REFACTOR.md);
concurrent same-spot placement across devices converges adjacent-in-tiebreak-order by design
but has no two-node integration test yet - the chain-level set semantics it rides on are
covered by `private.cjs` adoption.

---

## Taxonomy trees as composition (2026-07-23)

The trees residual closed a day after the lists shipped, by a design comparison instead of a
build: the planned formal structure (a `parent` slot in the member value, a deterministic
fold-time cycle rule) versus composition (a taxonomy placed as a member of another taxonomy -
a capability the lists ship had already created by accident). Composition won on one decisive
ground: parent pointers put a merge-created cycle IN the storage structure, broken until an
algorithm silently rewrites someone's move - exactly what the notes design refused - while
composition cycles are independent membership facts that never corrupt anything and reduce to
a render concern. The plan's Taxonomies section carries the full comparison (amendment three);
the `parent` slot retired unused, the cycle-rule dragon retired unslain.

What actually shipped, because "trees are free" still owed two pieces:

- **Local cycle refusal in `place`**: placing one of our own taxonomies is refused when the
  destination is already reachable inside it (BFS over the local view, self-placement
  included; foreign taxonomies aren't walkable and aren't refused). A courtesy, not a
  guarantee - two locally-innocent placements can still merge into a loop.
- **The tree read**: `Taxonomies::tree` expands nested own-taxonomies depth-first in list
  order under a visited set; the second encounter of any taxonomy - a diamond's other parent
  or a merge-created cycle - is a titled stub (`members: null`), never re-expanded, which also
  bounds the walk linearly. The GET-one-taxonomy route now returns this shape (a flat list is
  the depth-1 degenerate case), with every reachable own document joined against `doc_heads`
  in one query - `get`, not `remove`, on the summary map, because composition legitimately
  shows one document in two sections.

Deliberately NOT built: the memoized per-root tree view (REFACTOR.md, reviewed-and-left-alone:
the doc-meta view is already persisted + incremental and expansion is an in-memory walk;
baking it buys recursive invalidation machinery for a read that is one view + one query).
Proven by three new store tests (refusal names the cycle; nests expand and diamonds stub; a
forced merge-created loop renders as a stub, not a hang) and two integration tests (nested
expansion over HTTP; the 400 that names the cycle). *Residuals:* the published taxonomy
document (now folding a tree closure, visited-set included) stays designed-ahead; roster-aware
reads (a tagged taxonomy is invisible in docs-by-tag; sub-lists appear at top level in the
roster listing) are UI-adjacent and unowned.

---

## The front door (2026-07-23)

The first real UI rung past hello-world: node login and registration - deliberately
bargain-basement (username + password against the existing M0 auth API, no identity ceremony,
no email, no recovery). `auth.js`: a `useSession` hook over the HttpOnly-cookie session
(whoami on first paint so the sign-in screen never flashes at someone already in),
register-then-login in one motion (register alone doesn't set the cookie), live debounced
username availability off `check-username` with the server's slug errors shown verbatim, and
one two-mood Welcome component ("sign in" / "new here?"). The signed-in state is the old
marquee demo page plus a session bar ("hi, curtis" / "head out") - cozy language budget
honored from the first screen. Verified against a live scratch node end to end: page → bundle
→ register → cookie → whoami → wrong-password message → logout. ~330 lines total, sized to be
reviewed without losing the plot.

---

## Device names (2026-07-23)

The self-contained "how we name nodes" unit, start to finish: a key tree rendered as
fingerprints is a statement for the utterly deranged, so keys now carry private human labels
(PROJECT_PLAN, Device Names - the fourth member of the naming family). One register collection
(`devices`) on general-private, so labels sync to all your own nodes and are structurally
invisible to strangers. Nodes carry a configured name (`RINGTOME_NODE_NAME`, defaulting to the
machine's hostname, clamped once in config to the 120-byte label cap); identity creation labels
the founding key as the identity's first private record, and an adopting node labels its own
new key as its first authored write - both best-effort by design, because a label must never
doom a ceremony. The recovery key stays unlabeled (a role, rendered by rank). The keys endpoint
joins names beside pubkeys (best-effort: a store that won't open degrades to unnamed keys,
never a failed read); rename is the ordinary private KV route - zero new write surface.
Disambiguation is derived at render (pubkey shortcode on collision), never stored. Proven by a
store unit test (label/rename/clear/cap), the two-node integration test (B names itself
"bravo" during adoption, sees A's "alpha" off the synced chain, and A learns "bravo" back via
eager push in ~3s), and the keytree/profile expectation updates that double as coverage (the
founding label is entry six, replayed and re-validated on rebuild like everything else).

---

## Personas in the UI: the null state and the spare-key moment (2026-07-23 → 07-24)

The second 4C rung: signing in now lands somewhere. An account with personas auto-opens the
first (adding more is a future inside-the-house action, never a pre-login menu); an account
with none gets the null state - "Nobody lives here yet" - and the create flow. Two language
rulings settled on the way and recorded in the Cozyweb mapping: **the persona is the single
taught concept** ("identity" was already banned from the UI; "persona" confirmed as its
costume), and **the account never gets a noun** - "sign in" / "new here?" are verbs, and once
a persona opens, the session bar shows the persona (color chip + name, shortcode fallback -
a persona never renders as bare hex) while the username recedes to a hover title. Creation
runs the minimal honest spare-key moment: the recovery secret rendered once, downloadable as
a labeled text file, continue-gated behind "I put my spare key somewhere safe" - the full
photo/QR ceremony stays a later 4C rung, but the secret is never silently droppable. Two-step
onboarding (account, then persona) was interrogated and kept: the join flow needs the
identity-less state and the ceremony must not live in registration's first ten seconds - the
friction is dissolved by sequencing (registration flows straight into "who are you going to
be?"), not by merging the model. Field-testing immediately caught the missing last step of
being born: a fresh persona rendered as "persona 7db0" because nobody had picked a display
name - so the ceremony now flows into the **name picker** ("What should people call you?"),
pre-filled with the account username (the one name this human already chose today), skippable
("maybe later" - the shortcode fallback stands), writing the profile's ordinary `name` field.
Verified against a live node: bundle → register → login → empty list → create (32-byte
secret, once) → list of one → profile write and badge read-back → device names riding the
keys response. UI-only change (~300 lines: persona.js, index.js gate, CSS).

---

## Spare-key password reset: Flow A, scratch (2026-07-24)

"Give me your spare key and I'll let you reset your password" - the plan's Flow A (Recovery
Flows: Passwords vs. Keys), built as the scratch version with the bells named and deferred
but the lattice fully enforced. `identity::recover_password`: the pasted seed derives the
recovery keypair (`seal::derive_recovery`), the pubkey must match the identity's **designated
recovery key** (new `designated_recovery` helper: the unique Active key on the all-zeros rank
path, failing closed if the leftmost-spine convention is ever violated) - an ordinary leaf,
even a valid one, proves nothing. Per-identity scoping shipped fully, split by account shape
after a design conversation worth its HISTORY sentence: "you've proven you're fairly likely
to be the account creator" is true in the median case, but recovery is a credential-authority
operation, not identity verification - the account is a bundle of authorities, spare keys are
stolen individually, and the account's persona-list is itself the most sensitive linkage
record the node holds. So: a single-persona account resets **in place** (keeping its sign-in
name); a multi-persona account **re-homes** - a 409 asks for a new sign-in name (post-proof
only; count-not-names, the accepted disclosure), then the proven persona moves to a freshly
minted account while the old account is left entirely alone - password, sessions, siblings
all intact, because if the key was stolen, the victim keeps everything except the persona the
stolen key already owned outright. Every unprovable failure - wrong seed, unknown username,
malformed hex, persona-less account - is the same uniform "recovery failed". In-place reset
purges every session; rate-limited at 5/hour/IP (every attempt is a guess at a 256-bit
secret). auth.rs stays identity-agnostic - it gained only `set_password` / `purge_sessions` /
`account_id_by_username`; the evidence question lives in identity.rs. UI: "lost your
password?" on the front door - username, spare key (paste the whole file; the client plucks
the 64-hex seed out), new password; the new-name field appears only when the 409 asks for it,
and login lands under whichever name applies. *Deferred, named in the plan text:*
browser-side challenge signing (the seed currently transits to the node - fine for your own
node, the hosted-operator exposure is why the challenge flow exists), post-use rotation, the
cooling-off window. Proven by `recovery.cjs`: in-place reset + session purge, uniform
refusals, and the full re-home story - fresh account holds exactly the proven persona, old
account keeps its password, sessions, and sibling, and a taken new name moves nothing.

---

## The password floor follows the bind address (2026-07-24)

Short PINs for local devices: a node bound to loopback relaxes the 8-character password
minimum to a 1-character floor ("password can't be empty" is the only refusal left), because
reaching that login prompt already required physical access - breaching the machine is the
rare case, and the lock should be priced accordingly. The load-bearing signal is
**reachability, not tenancy**: `Config::password_min_len()` parses the bind address and
relaxes only for loopback (v4 or v6) - a single-tenant node on `0.0.0.0` keeps the strict
floor (remotely brute-forceable is remotely brute-forceable), and an unparseable bind
(`localhost`) fails closed to strict. Threaded as an explicit `min_password_len` parameter
through `register` and `set_password`, so the policy is decided once in config and the auth
layer stays mechanism. Covered by a unit test (both floors, the empty-password refusal, and
the config derivation including the fail-closed case) and the integration suite's loopback
nodes, whose "rejects short passwords" test inverted into "allows short PINs" - the test
suite updating to describe the new world is the change working as intended.

---

## Adoption in the UI: "invite this computer to be you" (2026-07-24)

The cluster gets its front door: the null state's long-promised second path is real. On a new
computer, "bring your persona from another computer" mints a leaf and shows the request code
(keys are born where they live - only signed codes travel, never key material); on a computer
that is already you, the new "your computers" screen renders the key tree in domestic clothing
- device names where we labeled them, "the crown / your first computer" and "the spare key" by
role, shortcodes beside everything because names are never authority - and "invite this
computer to be you" turns a pasted request code into a grant code to carry back. Completion
pulls the persona across and opens it. Design answers settled on the way, recorded where they
belong: two nodes on one machine are simply two peers (the harness's daily shape - an identity
never syncs "with itself"); adoption is a synchronous ceremony (both computers awake - the
grant code's addresses are deliberately ephemeral, and completion dials the granter directly),
with complete-via-any-peer as named headroom, not built; there is NO per-leaf recovery key -
the spare key is tree-level, proven by the new two-node recovery test (a persona born on A,
adopted to B, rescued on B by A's day-one seed, which B verifies purely from the synced tree);
and spare-key succession after catastrophe is now settled doctrine (PROJECT_PLAN, Recovery
Flows: the survivor mints its successor spare FIRST and owns the reachable future; the lost
past stays dormant-senior forever; the designation upgrade must ship WITH Flow B). Root-only
grants (the M3 trim) surface as the server's honest error on non-founding nodes. UI-only
change plus one integration test; the ceremony endpoints were M3's, untouched.

Field-tested immediately and caught red-handed: running both halves of the ceremony on one
node sailed through grant and died at completion with iroh's raw "Connecting to ourself is
not supported" - after authorizing a stray leaf per attempt. The guard now lives at the
GRANT step (request endpoint == our endpoint → a clear 400 in words, zero tree pollution;
"a second account on this node joining the same persona" is named as future account-linking,
not adoption), with a belt-and-braces twin at complete for a grant pasted back where it was
minted. The junior-grant test gained fidelity in passing (its request now comes from a
genuinely different endpoint), and the phantom unit flake's FOURTH escape finally bought the
promised capture wrapper: `just test-unit` tees full `--no-fail-fast` output to
/tmp/ringtome-test-unit.log, so sighting five cannot vanish.

---

## One-trip adoption (2026-07-24)

The ceremony's second courier trip deleted: only the request code travels by human now; the
grant goes over the wire. A dedicated adoption ALPN (`ringtome/adopt/0`) on the existing
endpoint - after authorizing, the granter dials the requester (endpoint id + address hints
from the request code) and hands the grant straight to the pending node, which completes
inline and acks only when fully moved in, so the granter's HTTP response saying
`delivered: true` means the persona is already home on the other machine: synced, self-named,
ready to open. The design choice worth its ink: the inverted alternative (a granter-minted
invite code) was rejected because it is a bearer capability - anyone holding the string joins
the tree - while keeping the request direction keeps both codes non-bearer: the delivery
channel is pinned to the exact endpoint the request named, and the accept side only honors
grants matching a pending adoption it minted itself (a 32-byte unguessable leaf). Delivery is
best-effort with the carried code as graceful fallback (the response always includes it), and
completion became idempotent - the wire beating the human's paste is now the common case, so
a pasted code after delivery confirms instead of 404ing; every pre-existing adoption test
passes unchanged through the new path because of exactly that. Wire format: the codes' own
node-level JSON, length-prefix framed - deliberately one level above the entry conformance
boundary, so proto and its vectors are untouched. UI: the join screen waits with a pulse
("your persona walks in here on its own"), polling until the persona arrives, paste box demoted
to fallback; the invite screen answers "it moved right in - nothing to carry back" when the
wire wins. The conventions cop earned its keep mid-build (adoption.rs reached into the
identities table; the queries moved home to identity.rs as owned helpers), and the fresh
test-unit tee caught the failure block on first firing. Proven by the one-trip integration
test: delivered:true, persona present on B with zero complete calls, new key self-named, and
the fallback code confirming idempotently afterward.

---

## Codes wear a costume (2026-07-24)

The adoption codes stopped showing their gubbins: the raw JSON strip of pubkeys and socket
addresses ("code? so complicated!") is now `rt1.` + base64url(deflate(JSON)) - an opaque
~40%-shorter ticket (about 390 chars vs 600). Decorative armor with real dividends: the prefix
versions the envelope independently of the inner JSON's `v`, deflate genuinely earns its keep
on 4-bit-per-char hex pubkeys, and compact base64url is what the QR ceremony will want anyway.
`pack`/`unpack` live in adoption.rs beside the codes they dress; unpack tolerates whitespace
and the bare-JSON form (cheap mid-upgrade tolerance, not a compatibility promise), bounds
decompression at 64 KiB, and refuses garbage in every costume cleanly. The wire delivery frames
and everything under them are untouched - this is strictly the human-visible layer. Tests peek
inside codes via a shared `decodeCode` helper (node:zlib mirrors the server's unpack).

---

## Junior grants: the trim un-trimmed (2026-07-24)

The last "v1:" in adoption is gone: any Active key can now sign a newcomer into the tree, so
invitation chains daisy - A founds, B joins from A, C joins from B - and the rank paths record
exactly who vouched for whom (C's path extends B's by one step). The missing piece was never
doctrine (rank-path growth was always the model; spare-key succession depends on it) but one
computation: the usurper stamp for a non-root parent. That now lives where it belongs, in the
conformance crate - `Crown::usurper_stamp_for_new_child` walks the parent's rank path
accumulating every senior and their earlier siblings, proven by a round-trip test at depths
one and two (a stamp the validator's exact-match check accepts IS a correct stamp) plus the
assertion that the day-one spare key outranks the deepest link. Node-side, `authorize_node`
signs with its own leaf, appends the authorization to its own chain, and reseals epochs keyed
by its own leaf's enc keypair (root-hex was a founding-node coincidence); a revoked leaf is
refused in words up front (its grants would be quarantined anyway). The root-only refusal
message we made cozy this very morning died young, as it deserved. Harness grew a third node
("charlie", :5283) booted by every integration run, `just start_three` for the human
playground, and `daisychain.cjs` proves the lot in one test: B's grant of C delivered by wire,
the rank-path lineage, every key named from the deepest chair, a write on C converging to A
through the epidemic relay with no manual syncs, and the founding spare key rescuing C's
account password two hops from home. The old junior-refusal test retired with a headstone
comment pointing here.

---

## The live cache, Stage 1 (2026-07-24 → 07-25)

The browser stopped fetching and started mirroring: `/api/identity/{root}/stream` is the
read-only WebSocket the plan settled (The Browser Is a View), and `cache.js` is the Dexie
mirror it feeds. The v1 shape, honest and named in the plan text: whole-kind refreshes (every
row of profile / doc summaries / taxonomy roster - the degenerate delta, idempotent to
apply), a cursor that is resync's frontier fingerprint hashed (matching reconnect → "live";
any doubt → full snapshot, because drop-and-re-stream is the design's own answer), change
detection as a 1s fingerprint poll per open socket, one socket per tab (Dexie's liveQuery is
already reactive cross-tab), mirror dropped unconditionally on logout, and the shadow overlay
deferred to the notes editor - its first real writer. The stream reuses the HTTP routes' own
response structs, so the mirror rows and the fetch rows can never drift. Ownership is gated
BEFORE the upgrade (strangers never get a socket: anonymous → 401, someone else's cookie →
the uniform 404), and client chatter down the socket is read-and-ignored - mutations are
POSTs, doctrine held mechanically. First consumer: the persona badge reads the mirror live,
so a rename on any computer lands in every browser's bar within seconds. Proven by
`livecache.cjs`: snapshot-then-echo (including a document arriving in the doc rows), cursor
resume to "live", doubtful-cursor snapshot, read-only chatter ignored while real POSTs land,
stranger refusals, and the crown jewel - a write on node B arriving down node A's stream in
~3s with nobody polling anything.

The debugging war story, recorded because both morals generalize: the first full run appeared
to wedge mid-suite with both nodes healthy - a false alarm manufactured by block-buffered
grep in the harness pipeline (output frozen at a 4KB boundary while the suite actually ran to
93-passing), hiding the REAL bug: mocha hung at exit on websocket handles leaked by the
stranger tests (`ws` keeps the socket - and the process - alive after `unexpected-response`
unless you `terminate()`). Killing the run flushed the buffer and confessed everything.
Morals: line-buffer or don't pipe, and a refused upgrade still leaves a handle to destroy.

---

## The notes app, v0: two columns and honesty (2026-07-25)

The flagship boots - deliberately skeletal, exactly as scoped: a top bar, a left column
listing EVERY document newest-first straight off the live mirror (another computer's save
re-sorts the list within seconds; the component never fetches a list in its life), a "+ new
item" button that mints a Hello World document, and a right column reading the selected
document read-only. The reader consumes the node's synthesized `body` - single head, clean
merge, or the conflict presented inline with device labels - which means divergence display
cost the reader NOTHING: it shows what it's given, plus an honest "diverged" chip
(the editor-is-the-merge-tool doctrine, reader half). Format dispatch works today: plaintext
in a pre, marquee through the real Marquee renderer (the hello-world demo page retired; its
renderer moved into the reader and earns real work), stills/video/audio via the body
endpoint. Settled in passing: a document's format is per-VERSION, so "change a file's type"
is an ordinary save with a new format - text↔markup is trivial reinterpretation, and nothing
needed building. Deferred by name: the editor (and with it the shadow overlay), taxonomies
and tag filters in the left column, the adjustable-width column, and the cozy-OS window
dressing - for now the app IS the desktop.

---

## The editor (2026-07-25)

Never-lose-words meets a keyboard. One component (`editor.js`) carries all four client
obligations from NOTES_APP's sync model, each with its mechanism: **debounced autosave**
(~10s idle, blur, tab-hide via keepalive fetch, doc switch - and a clean buffer never saves);
**check-the-head-before-saving** with the live mirror as the lookout (head moved + clean
buffer → quiet fast-forward reload; head moved + dirty → keep typing, the next save forks
knowingly and the conflict presents next open - never blind-save, never lose); **conflicts
present in the document** (a diverged doc loads its synthesized tangle - markers, device
labels - and editing-then-saving with every head as parents IS the resolution: the editor is
the merge tool, exactly as designed); and **the tangle starts clean, not dirty** (dirty arms
only on real input, so autosave can never commit an untouched conflict). The buffer is the
long-promised **shadow overlay** in its natural form: local state the stream never repaints,
watched against the mirror but never rendered from it, fast-forwarded by save responses
without a refetch - and the status chip (saved / unsaved / saving… / not saved!) is the
unsynced indicator's first rung made visible. Marquee editing is write/preview tabs over the
real renderer, with the strict parser run first so a broken document previews as its error.
Format is a chip-button: plaintext ↔ marquee conversion as an ordinary save - which flushed
out a real bug in review: the no-op bounce compared body and title but NOT format, so a
format-only conversion would have bounced into nothing, silently swallowing the exact
explicit act the per-version-format doctrine promises. Fixed with format in the bounce
condition and a regression test (conversion is a real save; re-saving in the same format
bounces as ever). New items are born untitled and empty now - there's an editor waiting.
Stale-closure traps (timers and unmount flushes capturing old buffers) were routed through
refs before they could eat anyone's words.

---

## The body lane joins both sides (2026-07-25)

Field testing found the first real dragon of the dogfood era: two editors on a diverged doc
kept "clearing" each other. The autopsy, in layers: document HEADERS ride entry sync but
BODIES ride iroh-blobs, and `fetch_missing_bodies` ran on the sync *initiator's* side only -
its own comment admitting "the responder catches up on its own next initiated sync". Eager
push makes the WRITER the initiator, so the receiving node's brand-new headers pointed at
blobs it wouldn't hold until its next anti-entropy pass (up to five minutes). Inside that
window the resolver honestly answered `body: null` ("bodies this resolution needs aren't
here yet") - and the editor poured null into the textarea as empty string. The user typed
into the void; the save asserted every head as parents; the fork resolved to almost nothing.
Never-lose-words held at the chain level throughout (every version is still in the history),
but the UX was an eraser. Two fixes, either of which would have prevented the loss, both of
which are correct: **the responder now backfills too** - after serving an exchange that
ingested entries, it dials back the peer that just delivered the headers (who is online right
now, by construction) and fetches the referenced blobs, spawned and best-effort; and **the
editor treats a null body as a waiting room, never an empty buffer** - editing disabled, "on
its way…" status, a 2s retry until the words arrive, and a structural guard that a
parentless buffer can never save. The reader learned the same retry. Proven by `bodies.cjs`:
a body written on A becomes readable on B with B never initiating anything, and the reported
scenario verbatim - divergent saves on both computers - converges on BOTH nodes to a
synthesized conflict containing BOTH texts, diverged flagged, never a null, never an empty.

---

## The oblivious editor, and conflict sides get their names (2026-07-25)

Field test round two found the asymmetry: after a fork, one editor showed the merge and the
other sat oblivious, showing only its own words. The mechanism: the editor's lookout watched
"did the display head move" - but the display head of a diverged doc is one deterministic
pick among the logical heads, identical on every node, so the device whose save happened to
BE that pick saw its own hash and never reloaded. The lookout now watches the whole shape -
display head, head count, diverged flag - and any change against a clean buffer reloads
(which also means a fork you created unknowingly presents its conflict moments after your
save lands, rather than on the next open). And the merge got legible: conflict side labels
were "device 8657ff04 at 1753400000000" (raw hex, raw millis, half a line wide); they now
speak DEVICE NAMES - "from alpha, 2026-07-25 03:12" - the exact promise NOTES_APP made
("from your phone, yesterday 9pm"; chains are per-device, so attribution is free) and the
exact purpose device names were minted for two days ago. Threaded as a names map from the
store layer (which owns the devices register) into the resolver, with a zero-dep UTC
formatter (Hinnant's civil-from-days) because the label is baked into synthesized text and
must be deterministic; unnamed keys fall back to "computer <shortcode>". The app shell also
widened to 1100px for the notes app alone (every other screen carries its own max-width) -
a merge deserves room to breathe. Proven in bodies.cjs: the stale-tab scenario now also
asserts "from alpha" and "from bravo" appear in the synthesized conflict on both nodes.

---

## The recursive base: criss-cross scars merge again (2026-07-25)

Field test round three, subtle and excellent: a clean two-sided edit (append E-F on one
computer; insert X and Y mid-document plus a different tail on the other) came back as a
whole-document conflict instead of the expected smooth X/Y merge with one tail hunk. The
reported SHAPE was innocent - a fresh reproduction test of exactly that autosave-chain fork
passes as-is, per-hunk, one conflict. The real culprit was the document's PAST: earlier field
rounds had raced resolutions (both editors saving the same fork's heads as parents), leaving
a criss-cross - two maximal fork points - and `resolve`'s base-finder demanded exactly one,
degrading every future fork on that document to a whole-document conflict, forever. One race
anywhere in history salted the ground permanently. The fix is git's recursive strategy,
bounded: with two fork points, synthesize a VIRTUAL base by merging them over their own base
(computed the same way, recursively, depth-limited) - and, exactly as git does, a CONFLICTED
virtual merge still serves as the base, markers and all: both outer sides descend from the
race's resolutions, so they agree about the once-disputed region and the markers cancel
against both sides. Proven twice: `autosave_chains_merge_per_hunk_not_whole_document` (the
report's shape, verbatim - X and Y outside any fence, exactly one hunk, both tails present)
and `criss_cross_scars_still_merge_per_hunk` (the scarred history, confirmed as two fork
points, still merging per-hunk). The genuinely-ambiguous case - histories with no common
ancestor at all - keeps its conservative whole-document degradation, unchanged and tested.

The recursive base's shakedown, same day, was a double catch. First: the rescue test flaked -
`fork_points` iterated a HashSet, and the virtual base is order-sensitive, which was not a
test problem but a CONVERGENCE bug (two devices could synthesize different tangles from
identical DAGs); fork points now sort by the house total order (claimed stamp, hash). Second:
even sorted, one hash-ordering leaked the virtual base's markers into user-facing output
through diff3's `||||||| original` base section - so every merge in the resolver now uses
git's plain ours/theirs conflict style (`merge_lines`, one function, one style), which closes
the leak structurally (the SIDES are always real user text) and drops the noisy base section
from user conflicts besides. And in the same gate run, the test-unit tee finally caught the
three-day phantom flake with its name on it: `db_without_key_file_refuses_to_open`,
"Decryption failed for page=1" - `temp_dir()` derived uniqueness from pid+nanos, SystemTime's
granularity is coarser than a nanosecond, and two parallel db tests on the same clock tick
shared a directory: one encrypted the database under its keystore, the other opened it with
a different one. Never the net layer at all. Fixed with an atomic counter; three consecutive
full-suite runs clean; the REFACTOR most-wanted entry retired. A TEMPORARY debug button also
shipped ("debug" chip in the editor → the full version DAG as JSON: every version with
parents, author + device name, stamps, fingerprints, bodies; head bookkeeping; fork points;
this node's synthesized resolution) - field-testing's request, slated for removal when the
thorny-merge era ends.

---

## The chip learns two words (2026-07-25)

Field-test dump review, with a victory lap inside it: a user's "incredibly smooth" merge
session turned out to contain a live criss-cross (raced 07:01 resolutions, two fork points)
that the day-old recursive base handled invisibly - resolution "merged", both sides' edits
woven. The question it raised: why does a CLEAN merge still light the "diverged" chip? Answer,
recorded: the flag is honest - the DAG genuinely holds two heads until the next ordinary save
heals it, because clean merges are synthesized at read time and never auto-committed (minting
merge entries at detection is exactly how racing devices would generate infinite criss-cross).
But the chip conflated two states under one alarm word. Now: diverged + clean synthesis shows
a calm green "merged" ("woven together cleanly - your next save seals the weave"); diverged +
genuine overlap keeps the red "diverged"; the list row goes neutral ("two versions"), since
the memoized row can't know the resolution without running the merge.

---

## Marquee conflicts go per-hunk (2026-07-26)

The whole-`:::version` conflict presentation for Marquee - settled in NOTES_APP to protect
block elements from being split by hunk boundaries - was re-judged in the field as a cure
worse than the disease: it discarded every cleanly-merged region to prevent occasional
breakage, and with Marquee's block elements largely line-tied, line-boundary hunks usually
land clean anyway. Now diffy's marker lines become `:::conflict` / `:::version` vocabulary at
the same boundaries (a line state machine, not blind replace - a user's own "=======" line
outside a conflict is untouched), so non-overlapping edits stay merged and only disputed
hunks wear scaffolding, with device-named labeled version blocks. The accepted risk, stated
in the spec: a hunk can split a multi-line element and fail the strict parse - the reader
now degrades to showing source with an honest note, and the editor's preview already reported
parse errors. Whole-version blocks remain the degraded form (three-plus heads, no usable
fork point), parallel to plaintext's whole-document fallback. Proven by the Marquee mirror of
the per-hunk plaintext test: insertion outside the scaffolding, exactly one conflict block,
labeled sides, no git markers, both tails inside.
