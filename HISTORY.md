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

## Marquee conflicts go per-hunk (2026-07-25)

The whole-document conflict presentation for Marquee - settled in NOTES_APP to protect
block elements from being split by hunk boundaries - was re-judged in the field as a cure
worse than the disease: it discarded every cleanly-merged region to prevent occasional
breakage, and with Marquee's block elements largely line-tied, line-boundary hunks usually
land clean anyway. Now diffy's marker lines become `:::conflict` / `:::variant` vocabulary at
the same boundaries (a line state machine, not blind replace - a user's own "=======" line
outside a conflict is untouched), so non-overlapping edits stay merged and only disputed
hunks wear scaffolding, with device-named labeled variant blocks. The accepted risk, stated
in the spec: a hunk can split a multi-line element and fail the strict parse - the reader
now degrades to showing source with an honest note, and the editor's preview already reported
parse errors. Whole-variant blocks remain the degraded form (three-plus heads, no usable
fork point), parallel to plaintext's whole-document fallback. Proven by the Marquee mirror of
the per-hunk plaintext test: insertion outside the scaffolding, exactly one conflict block,
labeled sides, no git markers, both tails inside.

---

## The lookout learns about raced resolutions; the conflict vocabulary gets its real name (2026-07-25)

Field report with paired debug dumps, and the dumps were the diagnosis: both nodes in perfect
agreement (same heads, same synthesized conflict), but only one browser showing it. The blind
spot: two devices each resolved the same fork, producing a fresh two-head fork whose display
pick was one racer's own save - that editor saw head ∈ parents, heads still 2, diverged still
true, every watched scalar identical to the tangle it had just resolved, and sat oblivious
while the head *set* rotated underneath. Second scar on the same predicate (the first: the
display-pick device never sees the head move), so the judgment moved out of the component into
`js/lookout.js` as a pure function carrying its scar record, tested by mocha without a browser
(`integration/test/lookout.cjs` - the raced case reproduces the dumps' exact shape, and failed
against the old logic before the fix). The cure is one clause: an editor that believes it is
linear (exactly one parent - its own fast-forwarded save) while the row says diverged has
definitionally not yet presented that divergence - reload. After the reload save_parents is
every logical head, so it cannot loop.

Same report, second bug: the synthesized Marquee conflict wore `:::version` blocks, but the
vocabulary Marquee actually shipped is `:::conflict` / `:::variant` ("version" was judged
overloaded on their side; both renderers carry the mq-conflict/mq-variant class contract).
So our conflicts were falling through to the unknown-vocabulary shrug - lossless, as designed,
but unstyled. Renamed, and the attrs corrected to the contract: `label` and `when` are
advisory display text rendered *verbatim* (their renderer comment warns that reformatting
timestamps makes two renderers disagree), so `when` now carries quoted civil time instead of
raw epoch ms, and the device name and timestamp split across the two attrs rather than
doubling up. The NOTES_APP open question - host vocabulary or upstream? - closed itself:
upstreamed, and Ringtome emits their names.

---

## Three-plus heads merge per-hunk: the N-way alignment (2026-07-25)

Field report, three debug dumps in agreement: three computers changed the same paragraph
simultaneously and got the whole-document wall - because three-plus logical heads skipped
merging entirely and went straight to the degraded form (`fork_points_of_logical_heads: []`
in the dumps was the tell: we didn't even compute fork points past two heads). The dumps
also showed the fix was well-posed: all three heads forked from ONE version, so the merge is
fully determined by N diffs against that base.

Now: `fork_points_of_heads` generalizes fork points to head *sets* (maximal common ancestors
of all heads at once; the pairwise form is a thin wrapper), and when the set shares a single
fork point, `align_heads` runs the N-way line alignment - each head diffed against the base
(diffy patches, walked into edit runs), runs whose base ranges overlap or touch grouped into
disputed regions, everything else woven clean. A disputed region carries one variant per
*distinct* proposal, labeled by the earliest head carrying it (twin-folding spirit: two
devices that wrote the same words agree). Presentation dispatches per format exactly like
the two-head paths - plaintext's marker chain, Marquee's `:::conflict`/`:::variant`. Bonus
correctness: three heads with DISJOINT edits now merge fully clean (green "merged"), a case
the old always-degrade rule falsely conflicted. Whole-document remains for what alignment
can't stand on - no single fork point for the set (criss-cross among three-plus heads,
pinned by test), or a missing base body. The debug endpoint now reports fork points for any
head count. Four new tests, the field scenario reproduced verbatim among them.

---

## The write nudge: sync latency drops from ~5-7s to ~1s (2026-07-25)

Field observation after the merge saga quieted: watching a sync was a little too *visible* -
the write-to-other-screen path summed a 0-2s eager-tick notice, a 3s quiet debounce, and a
tick alignment into ~5-7 seconds, while same-node tabs (1s stream tick only) felt instant.
Three levers, none touching correctness (all of this is latency-only; anti-entropy remains
the reliability layer and the exchange is idempotent):

- **The write nudge**: every locally-signed write rings a doorbell (`Db::nudge_sync` -
  `imaol::append` is the one funnel, since only local writes sign) that wakes the eager loop
  immediately via `loops::periodic_nudged`, so the debounce clock starts at the write instead
  of up to a tick later. The bell is one `tokio::sync::Notify` owned by the user-DB manager
  and attached to per-user handles exactly like the journal; `notify_one`'s stored permit
  makes a write racing an in-flight pass safe. The deliberate asymmetry is the damping:
  sync-*received* entries do NOT ring the bell - relays ride the lazy tick, which is what
  keeps a peer triangle from ping-ponging exchanges. Convergence was never at stake (an
  up-to-date exchange transfers nothing).
- **Dial turns**: `sync_debounce_ms` default 3000 → 750 (the UI's own ~10s autosave debounce
  is what batches a typing burst into one save; the server-side debounce only needs to catch
  multi-write ceremonies), `EAGER_TICK` 2s → 1s (the tick now paces relays, retries, and the
  follow-up pass that finds the debounce open).

New floor: ~debounce rounded up to a tick - a save is on its peers in about a second, on the
other screen in about two. The lever deliberately NOT pulled: the UI's 10s autosave, which is
doing version-count thrift, not sync pacing - shortening it quintuples versions per writing
session, and the principled fix there is retention (keep-last-N), not a shorter debounce.
Evidence the levers work: the integration suite - full of tests that poll for cross-node
propagation - halved its wall clock, 44s → 22s, with no test changed.

---

## The editor grows modes; Marquee becomes the front door (2026-07-25)

The write/preview tabs retire in favor of four view modes - *interactive*, *side by side*,
*plaintext*, *read only* - with the rule that keeps the mapping honest: modes are a VIEW
choice, format is a DOCUMENT property. A Marquee doc offers all four and opens interactive;
a plaintext doc offers plaintext/read-only and opens plaintext; converting a format re-clamps
the mode. New items are now created as Marquee - the interactive editor is the front door.

The interactive surface is `@cube-drone/marquee-codemirror` (published from the marqueemarkup
workspace): Obsidian-style live preview on CodeMirror 6, where the document never stops being
plain Marquee source - styling is projected on as decorations, blocks the cursor isn't in
render fully via the real HTML renderer, and the block under the cursor opens to its source.
No rich-text model means the editor's save machinery is untouched: the surface hands the
shadow buffer a string exactly as the textarea did, autosave/lookout/conflict obligations all
apply unchanged. The Preact wrapper (`js/livemarquee.js`) does the controlled-CodeMirror
dance - the view owns its state while typing; the `body` prop replaces the doc only when it
disagrees, i.e. exactly on loads, lookout reloads, and conflicts presenting - with a syncing
guard so programmatic replaces never arm the dirty flag (that would have marked every
background reload "unsaved").

Conflict tangles ride along nicely: the interactive mode renders `:::conflict`/`:::variant`
blocks live, so a divergence looks like labeled stacked blocks you click into and tidy.
The last-picked mode is remembered per document in a new local-only `prefs` table on the
Dexie mirror - the single table the stream never feeds and refreshes never clear, still
disposable with the mirror on logout. Added to the one version(1) schema, no bump: the
User-1 rule applies to the mirror doubly (no migration ceremony pre-launch, and this
database is disposable besides), and Dexie 4 auto-diffs additive schema anyway. Hydration
uses a functional set so a human's click always beats the read; a remembered mode the
current format can't offer sits clamped and resurfaces if the doc converts back.
Housekeeping: a project `.npmrc` pins the @cube-drone scope to public npm (the home config
routes the scope to GitHub Packages for publishing, which 404'd new installs here); the JS
bundle grows 182 → 463 KB with CodeMirror aboard - fine for a self-hosted node UI.

---

## Turbolinks unfurl: OpenGraph cards via the node (2026-07-25)

Field observation: no turbolink expanded anywhere - not for want of machinery but for want
of wiring. Every Marquee surface ran the bare-web default profile, whose turbolink socket is
empty; even marquee-turbolink's fetchless plugins (YouTube, Spotify, image/audio/video -
derivable from the URL, zero network) were sitting uncomposed. And the package's own
OpenGraph plugin can't run in a browser at all: CORS forbids reading foreign HTML.

Now: `js/turbolinks.js` composes the fetchless defaults plus a Ringtome OpenGraph plugin
whose resolve() asks the node - `GET /api/unfurl?url=...` - and whose render() hands the
summary to the package's own renderCard. One shared resolve cache and one injected
stylesheet serve every surface (reader, side-by-side, interactive - the CodeMirror extension
takes the profile through a Compartment, so cards arriving reconfigure decorations live).

The node side (`net::unfurl`) is the interesting part, because an endpoint that fetches
user-chosen URLs owes two guarantees, both tested:

- **No reaching inward (SSRF)**: http/https only, every hop of a redirect chain (≤ 4)
  re-vetted - every DNS answer must be a public address (private/loopback/link-local/CGNAT/
  ULA/v4-mapped all refused) - and the connection is PINNED to the vetted address via a
  per-hop resolve override, closing the DNS-rebinding TOCTOU. A node is never a periscope
  into its own LAN; integration proves the refusals against real local addresses.
- **No reaching outward too hard**: one global token bucket, generous for a human pasting
  links, useless as a load test against a foreign server (Curtis's framing, and the
  condition on shipping this at all). One knob, `RINGTOME_UNFURL_RATE_PER_MIN` (default 30):
  the per-minute rate is also the burst capacity, sized per NODE - a single-user node is
  generous at the default, a many-user node raises it. Nonsense values fall back rather
  than disabling the brake. Refusals spend tokens too, which is what makes the 429 provable
  offline. Per-URL day-long cache; cache hits don't spend; transient fetch failures aren't
  cached, so a hiccup doesn't wear a day-long scar.

The parse is a hand-rolled port of marquee-turbolink's parseOpenGraph (same fields, same
title-required rule, same bounded 64KiB read, same five entities) - no regex dependency,
pinned by fixture tests including the multibyte-char-at-the-cap edge. The privacy call is
recorded as deliberate: unfurling links in private notes reveals interest to target sites;
accepted (niche threat, node-not-browser does the fetching, cache damps repetition).
reqwest was already in the tree via pkarr - the direct dependency cost nothing new.

---

## Side-by-side learns to follow the cursor (2026-07-25)

Field note: the marquee-react-renderer demo goes to real effort keeping its two panes in
step, and our side-by-side mode did none of it - the scroll-sync half of the renderer's API
(the MarqueeHandle: `elementNear`, `scrollToSource`, `onNodeClick`) was sitting unused.
Ported the demo's pattern whole ("the honest prototype of the editor we're heading toward",
its own words): forward sync on select/click/keyup - the source cursor centers the nearest
rendered node in the preview and outlines it (`editor-cursor-node`, the house amber) -
and reverse sync on preview click, which puts the cursor on that node's exact source span.
The load-bearing subtlety, kept with its comment: an echo guard, because setSelectionRange
fires `select`, which would run the forward sync and yank the clicked node out from under
the cursor; cleared on a timeout so a `select` that never arrives can't wedge it. Both
handlers no-op gracefully in the modes missing one of the panes (plain has no preview,
read-only no textarea).

---

## The caret remembers (2026-07-25)

Field report: switching interactive ↔ side-by-side dumped the document back to position 0.
Now every editing surface shares one caret memory per document - switch modes and the caret
(and scroll) land where they sat; leave a doc and return and you're where you left off. The
judgement call, made deliberately: this lives in a module-level Map - per tab, per session -
NOT the mirror's prefs table. The prefs table is for choices (view mode); a caret is
incidental working state, and Dexie is cross-tab shared, so persisting it would make two
tabs on one doc clobber each other and would resurrect week-stale positions as noise. Per
tab like scroll positions everywhere else on the web. Mechanics: the textareas note the
caret on select/click/keyup and restore (clamped to the current body, selection-then-focus
so browsers also scroll there) when a textarea surface (re)appears; CodeMirror seeds
EditorState.create's selection, scrolls it centered, and reports movement through an
onCursor hook - the syncing guard keeps programmatic doc replaces from being mistaken for
human caret moves.

---

## Private-document search: a materialized, mirror-synced token index (2026-07-25)

Search settled along the seam the architecture already offered - Curtis's synthesis, which
collapsed the "where does the index live" fork and dodged the Turso-FTS5 gamble entirely: the
index is a **materialized view like `doc_heads`**, not a SQL FTS feature. `doc_search` holds
one token-bag row per document - the unique lowercased words of its title, resolved body, and
annotation text (field values AND tags, so a long description is exactly as findable as body
prose, which answered the "do annotations need indexing too?" question: yes, folded into the
doc's row rather than a separate kind). It lives in the per-identity Turso DB, so it inherits
at-rest encryption **by construction** - an index is a plaintext derivative of encrypted
bodies and must never be less protected than they are; putting it anywhere else would have
been the whole security question, and this puts it nowhere else.

It streams to the Dexie mirror as one more kind alongside docs/taxonomies, and the browser
queries it locally (`js/search.js`: prefix-match for type-ahead, AND across query words to
narrow) - offline, instant, zero round-trips per keystroke. The notes list gained a search
box that filters live.

The interesting mechanics:

- **Staleness is a fingerprint over exactly the token inputs**, so only changed docs
  re-tokenize: the logical-head SET (`heads_fp` - the set as a BLAKE3, not the count, because
  raced resolutions rotate the set invisibly - the lookout lesson, reused), which of those
  heads' bodies are locally present, the title, and the annotation text. A clean pass is one
  query and some hashing.
- **A backfilled body re-indexes with no chain movement.** Headers travel ahead of bodies;
  a body arriving changes what the index can say without moving any frontier. New per-root
  `view_epochs` counter, bumped when `fetch_missing_bodies` lands blobs, mixed into the live-
  cache stream cursor - so open browsers re-stream and the index re-checks body presence.
  In-memory, so a boot resets it to a full snapshot, which is the design's own answer anyway.
- **doc_heads grew `heads_fp` + `head_bodies`**, computed in the existing fold where the head
  set is already in hand - the search refresh reads them instead of re-resolving every doc.

Tests: four Rust (tokenization band, annotation inclusion, fingerprint-gated refresh on body
edit / annotation change, and the headers-ahead-of-bodies re-index), six JS matcher units, and
an end-to-end stream assertion that a created doc's body words arrive as a token row. Schema
generation 4 (User-1 rule: additive columns, no migration - rebuild). `doc_search` registered
with the SQL-ownership conventions cop.

---

## The 64 KiB save cliff: keepalive vs. a big paste (2026-07-25)

Field report: pasting a ~600KB document (Sherlock Holmes) into a note showed "Not Saved!" /
"NetworkError when attempting to fetch resource" and never saved - with nothing in the network
tab or the server log to explain it. That absence WAS the clue: the request never left the
browser. The editor set `keepalive: true` on every save (so a save survives a closing tab),
and fetch's keepalive flag caps the request body at 64 KiB by spec - a larger body is rejected
client-side as an opaque NetworkError before any round-trip. Any document over ~64KB simply
could not save.

Fix: keepalive is now set ONLY on the unload flush (visibilitychange -> hidden), and even then
only when the body fits - a big document flushed on unload falls back to a plain fetch, which
is all an unload flush ever was (best-effort; the 10s autosave has almost certainly already
saved it). Normal debounced/blur saves are ordinary fetches with no size limit; a React
unmount (doc switch) doesn't abort fetches, so it never needed keepalive either. The decision
is a pure tested helper (`js/keepalive.js`, `keepaliveOk(unloading, bytes)`) because the bug
was so silent it earns a regression guard. Two tests: the JS guard (a 600KB unload body does
NOT get keepalive) and an integration save of a 126KB document (2x the cap) proving the server
was never the limit - it round-trips verbatim. The server-side ceiling (`max_document_bytes`,
~10MB default) returns an honest 413 with a message, never a silent NetworkError.

---

## Setting tags and descriptions; tag-filter that stacks (2026-07-25)

The annotation model had HTTP routes but no UI - a document could hold a description and tags,
but nothing let you set them. Now an annotations panel sits in the editor (tag chips with
add/remove, a description field) and the notes list can filter by tag, stacking with search.

The design question Curtis raised mid-build - "bake annotations into the doc_heads
materialized view?" - resolved to **join at the stream boundary, not merge the folds**.
`doc_heads` is the resolution memo of the *notes* chain; annotations fold from a *different*
chain (DOC_META_PRIVATE). Physically merging them would couple two folds (an annotation write
moves the doc-meta chain, not doc_versions, so it would have to reach over and dirty
doc_heads). Instead the `DocSummary` the stream ships gains `tags` + `fields`, joined on from
the doc-meta view in `gather` (and the HTTP list, tagged, and tree handlers, via one
`annotation_map` helper). Same mirror shape Curtis wanted - one `docs` kind, annotations on
the row, filter-ready - with no cross-chain fold entanglement, and staleness is free: an
annotation write IS a chain write, so it moves the frontier and ticks the stream cursor.

Client: `js/annotations.js` reads tags/description live off the mirror docs row and writes
through the annotation routes. Tags use an optimistic overlay (a click shows before its echo
lands, clears when the mirror reflects it); the description is a shadow buffer like the editor
body (local while dirty, adopts the mirror when clean, debounced save + blur flush). The notes
list stacks filters - search hits AND every active tag - honoring the search-as-filter
preference (search narrows the current view, never a separate ranked screen). Row tags are
clickable to toggle a filter; active filters show as removable chips.

The backend already had the inverted reads (`own_docs_tagged`, the tagged-docs and taxonomy
tree endpoints); this unit gave them a front end and put the same data on the live list. Test:
the docs list row carries joined tags + fields (and empty structures, never undefined, for a
bare doc).

---

## The claimed display date (2026-07-25)

A document can now carry `display_date` - the user's own asserted date for it, distinct from
its authoring claim, its received-at, and its last-edit stamp. Write up a 2015 interaction in
2026 and file it under 2015: the claim is authoritative for list sorting and display precisely
because a human's deliberate assertion outranks any clock (PROJECT_PLAN, Displayed Time vs.
Claimed Time - it's openly the most authoritative and least trustworthy date at once).

The satisfying part: zero backend. It's a conventional annotation field, so it rides the
existing `set_field` route and arrives on the docs mirror row inside the `fields` map already
joined there - the whole feature is client-side. `js/docdate.js` owns the pure rules (sort key
= claimed date if set and parseable, else the real updated stamp; date-only parsed as LOCAL
midnight so "2015-07-31" never displays as the 30th in a western timezone; garbage falls back
rather than sorting to NaN), tested without a browser. The annotations panel got a date input
(sharing a `useField` shadow-buffer hook with the description), and the list sorts by the
claim and shows it in amber, marked as a claim ("its real last edit was ..."). One integration
line proves the field rides through onto the row like any other. The reserved field name is
documented in NOTES_APP and the Displayed Time doctrine.

**Amended same day: time added.** The claim now carries an optional time - two controls (date +
time) over the one `display_date` field, stored self-describing (`YYYY-MM-DD` or
`YYYY-MM-DDTHH:MM`; a time without a date clears, since a claim is anchored on its day). Still
zero backend - `js/docdate.js` grew `splitClaimed`/`joinClaimed` (pure, tested), `parseIsoDay`
became `parseClaimed`, and the formatter shows a time only when the claim has one. The panel's
date input gained a time sibling (disabled until a date is set); the annotations `useField`
shadow-buffer discipline generalized to the composite `useClaimedDate`.

---

## The live-cache stream gets nudged (2026-07-25)

Field report: changing a title or annotation took a full sync loop to reflect in the list -
human-noticeable. The cause was the stream's own 1s cursor poll: a local write echoed back only
when the next tick happened to notice the cursor had moved. This is exactly the "internal
broadcast bus is the refinement if that ever shows in a profile" case the Stage-1 notes named -
and it showed.

Fix: local writes now ping the same write-nudge that already wakes the eager-sync loop, and the
live-cache stream subscribes to it. The one change needed was topology: the nudge was a single
`Notify` (one waiter - the eager loop), which can't serve many streams, so it became a `()`
broadcast (`db::WriteNudge`). Every waiter - the eager loop and each open socket - wakes on a
write, re-checks its own cursor, and sends only if it actually moved (`db::await_write_nudge`
folds a lagged/closed receiver into one clean "re-check", never a busy loop). The 1s tick stays
as the backstop for the two things a local-write nudge can't see - a write that races an
in-flight send, and a body blob arriving by backfill (which bumps `view_epochs`, not a chain) -
so nudging is pure latency, never correctness. Net: a save reflects in every open browser in a
round-trip (~tens of ms) instead of up to a second. Tests updated for the broadcast (the loop
doorbell test, the manager-nudge test now asserting TWO subscribers both hear one write).

---

## The console and client-side routing (2026-07-25)

The client grew a real front layer. Opening a persona now lands on a **console** - an
application launcher (PROJECT_PLAN, The Client Is a Console of Applications) - rather than
straight into notes. Today it holds one tile, Notes; the console knows an application only as
`{id, name, icon, tagline}` in a plain registry (`js/console.js`), the generic-boundary
discipline kept even at one-tile scale.

And the whole client got **URL routing** (preact-iso, already in the tree). The internal UI
lives entirely under **/home** - `/home` is the console, `/home/notes[/<doc_id>]` the notes app,
`/home/computers` the system view - so back/forward, refresh, and deep links all work, and the
selected document moved from local state into the route (`/home/notes/<doc_id>`). Root `/`
bounces to `/home` with a temporary redirect, keeping the root namespace free for the API and a
future public face; the LocationProvider is scoped to `/home` so the SPA never hijacks a link
outside it.

Two design decisions are recorded in the doctrine, not just the code:

- **Internal URLs are session-relative and identity-free.** No node-username, no persona in the
  path - because the moment an identity appears in a URL it looks shareable, and internal URLs
  are not. The rule that falls out: *identity-in-the-URL is the signal that a thing is
  shareable* - private/internal has none, public/addressable has one - so the two can never be
  confused, structurally rather than by carefulness.
- **A persona slug is a publishing prerequisite, not a routing one.** Routing needs neither a
  persona slug (persona is the implicit active one; doc_ids are already persona-scoped) nor a
  document slug (raw hex is fine for URLs only you can open). Slugs become real when a persona
  or document becomes *publicly addressable* - a claim-your-handle moment - so nothing about
  this layer waits on them. Buckets/views get their route shape when they're built.

Server change was one line (root redirect); `/home/*` already served the SPA shell, and the
page's asset URLs were already absolute, so deep-link refreshes load correctly. 124 integration
green.

---

## Document bucketing (2026-07-26)

Buckets - which project(s)/notebook(s) a document belongs to - landed on the server. Curtis's
correction shaped the design: they are NOT a `Taxonomy` (no ordering, no ranks, no tree
composition), they're **annotation-shaped** - the exact tag mechanism (a per-document
LWW-element-set, unordered, multiple, unions on concurrent add), but in a SEPARATE collection
namespace (`bucket:<root>/<doc_id>` beside `annot:<root>/<doc_id>`). The separation is the whole
point: a bucket is the axis search and tags are *scoped to* ("braise" in the recipe book finds
braised pork, never the journal), so it must not appear in the tag cloud it filters.

A new `Buckets` store handle in the annotation family: `place`/`remove` (membership), `of`
(a doc's buckets), `own_docs_in` (a bucket's docs, the inverse read via
`collections_with_element` filtered to the bucket namespace), `roster` (distinct names + counts),
and `all` (the doc→buckets join). No new SQL table - buckets reuse the doc-meta chain's private
set machinery entirely, so the conventions cop needed nothing. HTTP: PUT/DELETE membership, GET
roster, GET docs-in-bucket. And `DocSummary` gained a `buckets` field joined at the stream
boundary exactly like tags, so the mirror row carries membership and the client can scope and
filter with no extra fetch. Four integration tests, including the load-bearing one: a word used
as both a bucket and a tag stays cleanly separate in both axes.

Deliberately deferred (name-keyed is the minimal foundation; the User-1 rule lets us upgrade
freely): named bucket *objects* - a minted id so an empty bucket persists and rename is free,
plus an app-type field - which the launcher's notebook picker will want. For "document
bucketing," name-keyed membership is the right, minimal axis.

---

## The bucket registry: name -> app-type (2026-07-26)

Curtis corrected an over-reach: I'd started modeling the "named bucket object" as a Taxonomy
(minted id, id-keyed membership, a roster). Wrong shape. Membership is already tag-like and
name-keyed and stays exactly that. The only new thing a bucket needs is a place to tie its
**name to an app-type** ("grandmas-recipes" -> "recipes", "very-personal-private" -> "journal")
so a wiki never opens in the recipe app - and, as a side effect, somewhere for an empty bucket
to exist in the window between "created" and "earned its first document".

So the registry is the lightest possible thing: **one LWW register collection, `key = bucket
name, value = app-type`** on the doc-meta chain. Not a Taxonomy, not a document. `define(name,
app)` writes the register (and is how an empty bucket is born); `undefine` clears it; `roster`
now merges the registry (app-types + registered-but-empty buckets) with the in-use names
(membership counts), so a bucket appears if it is registered OR holds documents. Membership -
`place`/`remove`/`of`/`own_docs_in` - is untouched, still name-keyed sets in the `bucket:`
namespace. HTTP gained `POST /buckets` (define) and `DELETE /buckets/{name}` (undefine); the
roster response and a new streamed `buckets` mirror kind carry `{name, app, members}`, so the
launcher can resolve which app opens a notebook, live. Two integration tests: an empty bucket
that earns a document (app-type persisting across membership changes, and surviving as a
member-only roster entry after undefine), and two notebooks routing to two different apps.

---

## App styles: the recipe app joins the console (2026-07-26)

The client learned that it has more than one application. A new `js/apps.js` is the curated app
registry - each app carries a `style` (the app-type a bucket stores to say which app opens it),
and `default` (Notes) is the fallback for an unknown/absent style, the graceful degradation the
free-form app-type field requires. Recipes went from a `soon` placeholder to a `live` app with
style `recipe`; the console launches it, and `index.js` generates a route per live app
(`/home/<id>/:docId?`) instead of hardcoding notes. The `Notes` component became `DocsApp` - the
shared documents surface, parameterized by its app (id in its routes, name/icon in its header) -
so the recipe app is a real, launchable, labeled destination today, and a genuinely distinct
recipe layout is a later accretion rather than a fork of the machinery. `appForStyle(style)`
resolves a bucket's app-type to its app (default when unknown), the hook the launcher will use
to open a notebook in the right place.

Deliberately not yet: scoping an app's view to its buckets. Both apps currently render the same
shared documents view (all docs), because scoping the recipe app to recipe buckets before there
is any UI to create those buckets would just yield an empty app with no way to fill it. The
next accretion is bucket-creation + per-app scoping together.

---

## Apps scope to their buckets, implicitly (2026-07-26)

Curtis simplified the app<->bucket tie: a bucket whose NAME is an app-type simply IS that type
(the `recipes` bucket is a recipes bucket, no registry row), so every app has an eponymous
bucket we just assume exists - no implicit creation, no `define` call for the common case. The
server-side registry stays, but only for user-named buckets (`grandmas-recipes` -> `recipes`).

`apps.js` grew `appTypeOf(bucketName, roster)`: the name IS a known style -> that style; else the
streamed registry mapping; else `default`. The documents app (`DocsApp`) now scopes its list -
a doc shows only when one of its buckets resolves to this app's style, with unbucketed docs
belonging to the default app (the catch-all, so legacy notes never vanish). "+ new item" files
the doc into the app's eponymous bucket (a name-keyed membership PUT, no define), so it belongs
here rather than only to the catch-all. Search and tags now filter *within* the app - so
searching "braise" in Recipes can never surface a journal entry, the scoping the whole console
rests on. Managing/switching multiple notebooks within an app is still deferred.

---

## Recipes gets its own face: per-app features (2026-07-26)

The first genuinely-differentiated app. App surfaces are now data: `apps.js` grew a `features`
block per app (over full-Notes defaults), and `featuresOf(app)` resolves it. Recipes overrides
to a recipe book - `modes: ['interactive']` only, no format chip, no date/description
annotations, no debug chip, and a `tagColumn`.

The pieces read the flags rather than hardcoding: the editor filters its offered view modes to
the app's list (falling back to the format's full set if the intersection is empty, so a doc is
never trapped), and hides the format/debug chips and the mode tabs when there's nothing to
switch; the annotations panel drops the date and description rows but always keeps tags and
title; and `DocsApp` renders a thin tag-frequency sidebar to the left of the document list -
every tag across the app's documents, most-used at the top, counted over the app's docs
unfiltered so it's a stable index, each row toggling the same tag filter the list already uses.
The default Notes app resolves to the defaults, so it is untouched. Adding an app's personality
is now a `features` block plus, where it wants one, a new column - not a fork of the editor.

---

## Tags read in insertion order, not alphabetical (2026-07-26)

Tags surfaced alphabetically both in the annotations panel and the recipe/notes rows, which
scrambled the order the author built them in. The order was recoverable all along: an
LWW-element-set element carries the stamp it was last written under, and that stamp is the CRDT's
full total order - `(timestamp_ms, seq, hash)` - not just a millisecond. `SetElement` only ever
exposed `updated_at_ms`, so a same-millisecond burst of tags (the common case: three tags typed
in a row) had no sub-ms order to sort by and fell back to a string tiebreak, i.e. alphabetical.

`PrivateView` grew `set_elements_ordered`, which sorts by the full stamp it already holds - seq
breaks a same-millisecond tie by chain position, hash breaks it across devices. `Annotations::tags`
and `Annotations::all` now read through it, so both the per-doc panel and the mirror-joined row
carry build order. The client dropped its trailing `.sort()` on the tag chips; the mirror now
delivers them oldest-first and optimistic adds append at the end, so a new tag lands where you'd
expect. The tag-frequency sidebar stays frequency-sorted (a different question). No schema change
- the order was in the stamp the whole time; we were throwing it away at the view boundary.

---

## Title edits settle on blur, not on the 10s autosave (2026-07-26)

A field report: tags update instantly but a title change "takes a cycle". The cause is
structural - a tag is an annotation (immediate small write, sub-second stream echo, so the list
row catches up at once), while the title is part of the document *version* and rode the editor's
10-second autosave debounce. Nothing left the building until that timer fired, so the doc-list
row kept showing the old title / "untitled" for up to ten seconds. The title input now flushes
the save on blur (the discipline annotation fields already use), so leaving the field settles the
row within a round-trip. Body edits keep the 10s debounce on purpose - minting a version per
keystroke is exactly what that timer prevents; the title is small and the thing you glance at the
list to confirm, so it earns the early flush.

---

## Delete a document: a reversible tombstone (2026-07-26)

A delete button, in every documents app (Notes, Recipes, and the media Reader). Deletion is the
tombstone half of the deletability doctrine (NOTES_APP: "a tombstone plus dropping its files"):
the id joins a `deleted` LWW-element-set on the doc-meta chain - the taxonomy-roster shape exactly
- and the document drops out of every list and search at once. The version chain is untouched, so
`restore` (an LWW set-remove) brings the document back whole; a delete/restore race resolves by
timestamp like any other LWW fact. It is a hide that syncs, not an erasure.

The filter is centralized where the codebase already centralizes: every doc read is a method on
the `Documents` store handle (`summaries`, `summaries_for`, `search_rows`), and all three now drop
tombstoned ids - so all six route surfaces (list, stream, by-tag, by-bucket, taxonomy members,
search) are covered with zero route changes. The stream's whole-kind refresh does the rest: a
delete moves the doc-meta frontier, the cursor ticks, and the mirror clears-and-replaces the docs
kind, so the doc vanishes from every open browser in a round-trip.

Client: a coral `delete` chip in the editor/reader header (warms up only on hover, never shouts),
behind a confirm. The editor disarms its dirty buffer BEFORE navigating away - otherwise the
doc-switch unmount flush would save a fresh version onto the very doc being tombstoned. On success
it routes back to the app's list; the now-deleted row is already gone from the live mirror.

Two residuals, both named in NEXT_STEPS: dropping the content blobs (the other half of the
doctrine - this hides bytes, doesn't yet reclaim them), and a visible undo/restore surface (the
`restore` verb exists on the store handle and is reversible by construction; nothing in the UI
calls it yet - a deleted doc is currently recoverable only by a direct set-remove).

---

## Pin a document to the top of the list (2026-07-26)

The delete tombstone's twin, opposite in effect. A `pinned` LWW-element-set on the doc-meta chain
(its own collection, never a hidden tag - a tag would leak into the tag cloud, the row chips, and
the search index, the same reason buckets stayed out of the tag namespace). Unlike delete, a pin
filters nothing: it rides the list row as `DocSummary.pinned`, joined at `summarize` beside tags
and buckets, and the client sorts pinned documents first, then by claimed date. So the ordering
lives entirely on the client; the server only reports the fact.

Backend: `Documents::pin`/`unpin`/`pinned`, a `PUT`/`DELETE .../docs/{id}/pin` route, and the
`pinned` set threaded through the five `summarize` call sites. Client: a teal "pin"/"📌 pinned"
chip in the editor and reader headers (reading pin state from the same live mirror row it already
watches), and a small 📌 ahead of a pinned row's title. Propagation is free - the pin moves the
doc-meta frontier, the stream re-gathers, and the mirror's whole-docs refresh carries the new flag
to every open browser.

---

## The app becomes a fixed frame, the footer its own band (2026-07-26)

The bottom dock was a `position: fixed` overlay that hung over the content with a shadow, and
`.app-main` reserved matching bottom padding so nothing hid beneath it. Replaced with a
non-overlapping layout: `.app-main` is a full-viewport flex column that never scrolls, holding two
stacked bands - the app region (`.app-frame`) taking all the room above, the footer
(`.session-bar`) its own fixed band below. Neither can ever cover the other, so the footer no
longer hangs over note content.

The app region is now a framed box with a chunky 10px dark (`--ink`) border, and its inner layer
scrolls *inside* that border rather than moving the page. The route content is wrapped in
`.app-frame` > `.app-frame-inner` in the shell (`index.js`), with the footer rendered after it so
flex order stacks them. The notes app fills the frame (`height: 100%`, clip) and its columns - tag
list, document list, editor - scroll internally, so each reaches the bottom of the app. The old
`max-height: 70vh/78vh` column hacks and the dock's shadow are gone; the frame's height bounds
everything now.

The border isn't `border-radius` (too smooth for a retro panel): it's the hexagon-tile trick
turned rectangular - two `clip-path` layers sharing one polygon whose corners STEP like pixels (a
two-step 6px staircase), dark outside and surface inside, so the dark shows through as a
pixel-cornered frame. No image, no 9-slice asset; the jaggedness is the corner geometry itself.
Only the two BOTTOM corners are stepped - the top stays square - so the panel reads as sitting on
its rounded feet.

---

## An icon language: Phosphor duotone, no more emoji (2026-07-26)

Emoji read inconsistently across platforms and don't belong in the UI. Replaced every one with a
Phosphor icon (MIT-licensed, so it fits the project's open-source constraint), rendered in
duotone. The React package resolves fine under the existing `react` -> `preact/compat` browser-field
alias (the same path the Marquee renderer already uses).

The vocabulary lives in one new module, `icons.js`: a `role -> glyph` map (`Icons.notes`,
`Icons.pin`, `Icons.gear`, `Icons.back`, `Icons.profile`, ...), so the rest of the UI names icons
by meaning and a restyle is one edit. `apps.js` now carries component refs instead of emoji
strings; the console tiles, app headers, pin chips/row markers, the dock gear and back-nav, and
the persona menu all render `<${Icons.x} />`. A single `IconContext.Provider` at the app root sets
the house style - `weight: 'duotone'`, `size: '1em'` (so the containers' existing font-size rules
size the glyphs), `currentColor`, and a `ph` class the stylesheet uses to seat glyphs on the text
baseline. Verified end-to-end by bundling a render through esbuild: the SVG comes out with the two
duotone paths (secondary at `opacity 0.2`), `1em`, `currentColor`, and the class.

Cost: ~44 KB (Phosphor bundles all six weights per icon even though only duotone is used; tree-
shaking kept just the twelve icons we reference). The one glyph left as text is the `×` on
tag-remove buttons - a typographic character, not an emoji.

---

## The app selector lives outside the shell (2026-07-26)

The bordered pixel-cornered frame means "an app is open" - so the console (the honeycomb launcher)
shouldn't be inside it: the hexagons SUMMON apps, they aren't an app themselves. `Inside` now has
two wrappers over the same footer - `shell` (the clip-path frame, for an open app) and `stage`
(the bare warm desktop) - and picks between them on the `inApp` line the routing already draws:
`/home` (the console) rides the stage, any deeper route gets the shell. The pre-persona flows
(loading, spare-key ceremony, name picker, join, null state) ride the stage too - they aren't apps
either. The console now centers its honeycomb on the bare desktop instead of sitting in a boxed
surface. Persona management stays framed: it's a place you navigate into and back out of, more app
than launcher.

---

## A unified app header (2026-07-26)

Every app now gets the same header from the shell - no app draws its own top bar. It's a solid
band in `--ink` (the frame colour, so the top border and the header read as one), the app's
icon+title on the left, back/close on the right. The shell derives the current app from the path
(`/home/<app>/<doc?>` -> the registry), so the header is truly uniform: a new app is a registry
line, nothing more. `close` leaves the app for the launcher (`/home`); `back` appears only when a
document is open and returns to that app's list. The Notes app's old `.notes-bar` (its "Notes" +
"6 things" count) is gone - the count loses its home, as intended.

Persona management isn't an app, so it gets no app header (it keeps its own page head). That would
have stranded it once the header owned "close", so the footer's leave button survives but now
appears ONLY on header-less shell routes (persona, not-found) - an open app never shows it
(redundant with the header's close), the console never shows it (you're already home). Net: one
obvious way out from every screen, never two.

---

## Persona becomes an app (2026-07-26)

Persona was chrome reached only by the footer gear; now it's a first-class app - the first tile in
the console, named "Persona", and it wears the unified app header like any other. It's a SYSTEM app
though (its own pages - profile, computers, log out - not a document surface), so the registry
grew a distinction: `liveApps` (every launchable tile) vs `docApps` (live apps with a document
`style`). The generated `/home/<app>/<doc?>` routes come from `docApps`, so Persona keeps its own
explicit routes; `appById` still includes it, which is what makes the shell hand it the header.

Consequences that fell out cleanly: the header's `back` already means "up to the app's list", so
inside `/home/persona/profile` it returns to the persona menu - the profile page's own back-link
was now redundant and is gone. And because Persona is an app, the footer's leave button (shown
only on header-less shell routes) no longer appears on persona pages - the header's `close` takes
you home, exactly as it does from Notes. The gear stays as the quick-bar shortcut. One blank
honeycomb cell was dropped so the eight tiles still fill two clean rows.

---

## The Persona app wears your name (2026-07-26)

"Persona" was a generic label; now the Persona app shows the CURRENT persona's name wherever its
label appears - the console tile and the app header both read "Corff Burblepunk" (or whatever
you've named yourself). The name is live: `usePersonaName` (extracted from `PersonaBadge`, which
now shares it) reads the profile name from the mirror, so a rename on any computer lands within
seconds; it falls back to the fetched-at-open name, then to '' while the mirror fills. `appLabel`
resolves the display label - the persona app to that live name, everything else to its registry
name - and the Persona tile falls back to "Persona" when the persona is unnamed. The tile gained
ellipsis so a long name stays on one tidy line inside the hexagon.

---

## The Quickbar, with an app dock (2026-07-26)

The bottom bar has a name now - the Quickbar (`.session-bar` -> `.quickbar`). Its left end became
an app dock: one small pointy-top hexagon per live app (Persona, Notes, Recipes), icon only -
sharing the console tiles' glyphs without the names - a one-click switch between apps that skips
the console. The current app's hex is lit; the rest dim back, so the dock also shows where you
are. The tooltip carries the name (Persona's is the live persona name, like everywhere else). The
right end is unchanged: the persona badge and the gear.

The old footer "leave" button (shown only on header-less routes) is gone - the dock reaches every
app directly and the app header's close reaches the console, so nothing is stranded without it.
Dead `.session-nav`/`.session-out` styles removed.

---

## The Quickbar dock grows up (2026-07-26)

Reworked the Quickbar into a proper app dock. The right-hand side (persona badge + gear) is gone -
Persona is the first hex now, and it IS both the identity and the way into persona management, so
the duplicate had to go. The account username display went with it (the account was never a noun
anyway).

The tiles are bigger and now overflow the bar: the Quickbar is a fixed-height band with
`overflow: visible`, the tiles bottom-align and run taller than it, so their tops poke up above the
bar (a stacking context on the bar keeps them painting over the app region, not behind it). Each
tile is a two-layer hexagon - an outer teal-deep rim (a clip-path can't take a clean CSS border)
around a surface face with the icon. The rim is the SAME teal as the bar, so within the bar it
dissolves into the backdrop and only the part poking ABOVE the bar carries a visible teal edge -
the frustrating-to-lay-out effect Curtis asked for. The user's own tile (Persona, first) runs a
little bigger than the rest; the current app's tile sits full while the others dim back.

---

## A Swatch Internet Time clock in the corner (2026-07-26)

Because the retro web demands it: the Quickbar's bottom-right corner now carries a live `.beat`
clock. Swatch Internet Time cuts the day into 1000 beats on Biel Mean Time (UTC+1, no DST) - a
`Clock` component ticks it every second, shown to two decimals (`@541.67`) so it visibly moves,
with the real localized wall-clock time a hover away (the `title`). Verified against the known
anchors (Biel midnight is `@000`, Biel noon `@500`). Purely, gloriously ornamental.

---

## Console tiles: the diagonal badge (2026-07-26)

Restyled the application-selector hexagons into a diagonal name badge. A `::before` on the hex face
floods the lower-right half with the border colour along a bottom-left -> top-right line, so the
border reads as pouring diagonally into the tile. The fill is a `linear-gradient(to bottom right,
transparent 50%, border 50%)` - NOT a clipped triangle: nesting a triangle clip-path inside the
hex clip-path flooded the whole tile in practice, whereas `to bottom right` lands the hard edge on
the exact corner-to-corner diagonal at any aspect ratio and needs no second clip-path. The icon is
large and sits BEHIND the fill (z-index 0), centred, so its top-left shows over the surface while
its bottom-right is swallowed - present but half-obscured. The name sits ABOVE the fill (z-index 2),
uppercase and rotated ~-49deg to run parallel to the diagonal. The face gets `isolation: isolate`
so those layer z-indexes order cleanly. Positions/size/angle are eyeballed and meant to be tuned.

---

## Search moves into the app header (2026-07-27)

Search is a top-level tool, so it now lives in a consistent place: the unified app header, right
next to the title, the same spot in every app that offers it (Notes, Recipes - any document app).
It used to be buried in the notes app's left column. The query string is lifted to the shell
(`Inside`) - the header owns the input, and `DocsApp` reads the query as a prop and does the
filtering (`useSearch`) as before - and it clears when you switch apps. The header only shows the
box for apps with a document `style`; Persona and the console have no search. Old `.notes-search`
input and styles removed.

---

## Apps resume the last document you had open (2026-07-27)

Like the per-document cursor memory, an app now returns you to where you were: opening it jumps
back to the document you most recently had open there. A module-level `lastDocMemory` (keyed by
`root:app`, in-memory - a session convenience, forgotten on reload) records the open document;
on ENTERING an app with nothing selected, a one-time effect redirects to the remembered document
(REPLACE, so Back still exits to the launcher). A `restored` ref makes it strictly on-open:
deliberately going back to the list later (header back) never bounces you into the document again.
The jump is validated against the live mirror and the app's scope, so a since-deleted or
moved-away document just leaves you on the list.

---

## Editor chrome slims down: metadata dropdown, icon mode-tabs (2026-07-27)

The tags/date/description panel was permanently parked under the header, eating writing space. It's
now a dropdown: a tag-icon toggle in the header chips drops the annotations panel over the editor
on demand (absolute, shadowed), and takes zero space when closed. Closing it unmounts the panel,
which flushes any pending edit - so nothing is lost.

The view-mode tabs stay out but tightened: icon-only now (ArticleMedium = interactive, SquareHalf
= side-by-side, TextT = plaintext, TextTSlash = read-only), their names moved to the tooltip, and
pressed right up against the text with a negative margin so they read as fold-tabs on the note.

---

## The editor header chips go fully icon (2026-07-27)

Every header chip is now an icon, its words moved into a richer tooltip (a title plus what it is
or what clicking it does): pin (text "pinned" dropped - the pin says it), delete -> trash, debug ->
skull, the save status -> floppy-disk-back (state in the tooltip), the divergence chips -> a
git-pull-request (conflict) and a git-merge (merged), and the format toggle -> the article-medium /
text-t split (matching the interactive/plaintext mode icons). Chips restyled for glyphs: inline-flex,
1rem, squarer padding.

---

## Search results show a highlighted snippet (2026-07-27)

A search result row now carries a `<small>` snippet: the first 2-3 body lines that contain the
query, with every hit highlighted. The mirror's search index is only a token bag (no line
structure) and the list row carries no body, so the snippet body is fetched per result and cached
by doc_id - once per document, not per keystroke, so matching stays local and instant; the snippets
just fill in a beat later. `snippetLines` picks the first non-blank lines mentioning any query word;
`highlight` wraps the hits in `<mark>`. Rows whose match was only in the title/tags (no body line)
simply show no snippet. Only rendered while a search is active.

---

## Journal - and extracting the shared editing session (2026-07-27)

Journal is a genuinely different document app, so it's built as its own app that COMPOSES shared
pieces rather than the Notes app reconfiguring itself with a growing pile of `false` feature flags
(Curtis's call, and the right one).

The shared piece extracted: `useDocSession` (docsession.js) - the save engine every editing
surface needs (load, buffer, debounced autosave, blur/unmount/tab-hide flush, and the mirror
lookout that fast-forwards a clean buffer / forks a dirty one). It's moved verbatim out of the old
Editor; the Notes Editor now composes it with its full chrome, and Journal composes it with almost
none. "Never lose words" lives in one place now.

Journal itself (journal.js): a centered stream (<=600px) of one entry per day, newest-first by
CREATION time (a new `created_ms` on the doc summary, from `genesis_ms`), infinite-scroll windowed.
Today's entry sits at the top as an inviting blank page - a phantom that only becomes a real
document when you start (create + file into the `journal` bucket). Only today's entry is editable;
a minute tick re-checks the day boundary, so an entry locks shut when its day ends, even mid-edit
(the editor swaps to a read-only render, flushing first). Each older entry carries a lock button;
clicking it runs a 15-second fill, after which the entry unlocks - editable and deletable. Routed
at `/home/journal` to `JournalApp` (special-cased in the shell since it's a doc app but not a list
one); no search box (it has no selector).

Pragmatic v1 edges to revisit: the phantom is click-to-start (not first-keystroke), infinite-scroll
uses a viewport IntersectionObserver, and locked entries fetch their body per-render (like search
snippets). Needs a real browser pass - the save-engine extraction especially.

## 2026-07-28: journal polish + the bucket switcher

Journal grew its living-room comforts: seal/unlock state moved from a session Map into Dexie's
local `prefs` table (`seal:<doc_id>`) - durable across reloads, live across tabs, never synced to
the node ("this page is closed" is a per-device gesture, not a document fact). A page-wide font
picker (keyboard/pen-nib/text-aa -> Special Elite / Caveat / Atkinson Hyperlegible) sits at the
top of the stream, also in prefs, defaulting to typewriter. Journal text runs 1.1x with per-face
optical scaling, and index.css gained a global `mq-font-*` size-normalization pass so the whole
marquee grab bag reads at roughly one size (Caveat/VT323/Cormorant needed the most help). Search
came to Journal too: the same header box, filtering the stream and painting hits in place via the
CSS Custom Highlight API (ranges, not <mark> surgery - it lays over the live editor safely). All
three header search boxes are now dead-centered (3-track grid).

Then the bucket switcher (index.js `BucketSwitcher`, in the app header next to the title): each
doc app is now a shelf of notebooks - ONE bucket at a time, not an app-type union. Plus creates a
new bucket of the app's type ("New Journal"/"New Recipe Book"/"New Notes", via prompt ->
POST /buckets), arrows page the rail (home bucket first, then registered same-type buckets,
wrapping), and clicking the name drops the full list (member counts, current bolded). Deleting the
current bucket (not offered for home) tombstones EVERY member doc then undefines the bucket,
behind a BIG confirm. Apps filter by bucket membership now (`inThisBucket`); Notes' home bucket
still gathers unbucketed docs; new docs file into the bucket you're looking at. Bucket choice is
lifted shell state like the search query, and re-entering an app returns you to the bucket you
last had open there (`lastBucketMemory` - the same session-Map idea as the last-open document);
home when there's no memory.

Hard-won build note, recorded in auto-memory too: `npm run build` is JS only - CSS needs its own
`npm run css`, and forgetting it looks exactly like "my CSS changes don't work."

## 2026-07-28: the wiki

The taxonomy machinery's first real consumer (PROJECT_PLAN, Taxonomies - lists + trees were
already implemented server-side; the question "can non-root nodes be named?" answers itself:
interior nodes ARE taxonomies, titled by design). A wiki is one bucket + one root taxonomy,
associated by title convention (`wiki:<bucket>` - prefixed so user-titled sections can never
collide with a root lookup; lowest-id wins a concurrent-mint tie, minted lazily on first write).
Sections are child taxonomies (create: POST /taxonomies + place in parent; rename: the title
annotation on the taxonomy's own id; delete: unhook from parent + delete descendants, pages
spared). Pages are document leaves - created into the bucket AND placed in their node, edited by
the shared Editor (same one Notes uses, full feature set). The tree pane renders the whole
expanded tree from GET /taxonomies/{root} - refetched when the streamed roster ticks or after
our own writes; page titles read live off the mirror row so editor renames re-title the tree
instantly. Cycle/diamond stubs render as ↩ markers (the server's members:null contract). Fold
state in Dexie prefs (`wikifold:<tax_id>`), search filters page leaves (sections stay as
scaffolding), and an "unfiled" bin catches anything in the bucket but out of the tree - nothing
is ever lost to tree surgery. Multiple wikis ride the bucket switcher for free.

Follow-ups landed same day: per-app last-open-bucket session memory (`lastBucketMemory` in the
shell), the wiki's last-open-page memory (Notes pattern verbatim), deep-link bucket correction
(a refreshed document URL switches the shell to the doc's own bucket, at most once per doc), and
drag-to-reorganize: native HTML5 DnD, no library. Pages and sections drag; a row's top/bottom
half is insert-before/after (sections split 25/50/25 with a drop-INTO middle zone), the pane
background files at top level, and the unfiled bin is a drop target that unhooks a page from its
section. The server API was already drag-shaped (member PUT index = add-and-move, position
counted without the member); cross-section moves place FIRST then remove, so a failure between
the writes leaves a visible duplicate, never a lost page. Cycle guard client-side via the
dragged section's subtree ids (the server refuses too); indicator CSS: insertion lines, teal
drop-into wash, lifted opacity on the source.

v1 edges to revisit: deleting a wiki BUCKET leaves its root taxonomy orphaned on the roster
(invisible, harmless), and other-identity tree members are skipped in render.
