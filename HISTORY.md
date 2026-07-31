# Ringtome — Delivery History

The delivery log: what shipped, when, with the honest status notes **as recorded at the time**.
The other documents stay lean because this one exists - NEXT_STEPS.md is forward-looking only,
and PROJECT_PLAN.md carries the design with `(IMPLEMENTED)` markers.

Live residuals are tracked in NEXT_STEPS ("Standing residuals"); the residual notes below are
snapshots of what was owed on each ship date.

> **Compressed 2026-07-29.** This began as one entry per shipped unit and reached ~2100 lines,
> which stopped being readable as a story. It is now an era narrative: every milestone, every
> doctrine ruling, every war story with a generalizable moral, and every residual that outlived
> its day - at roughly a quarter the length. The full per-unit entries are recoverable from this
> file's pre-compression revisions in git. New work still appends at the bottom in full detail;
> fold it into the story when the tail grows unwieldy again.

---

## The ladder: M0 → M3.5 (through 2026-07-07)

**M0 — the skeleton.** Axum node with `/health`, `/api/config`, tracing + correlation IDs, and
config-from-env carrying the node/desktop seams. `node.db` plus per-identity databases on real
migrations, moka-capped `UserDbManager`. Accounts and sessions: register/login/logout/whoami,
Argon2 (minimal params in local-test mode), opaque server-side tokens, a tag system with
`node_admin`/`admin`. A keystore doing XChaCha20-Poly1305 envelope encryption with pubkey-as-AAD
and an unattended-boot envelope key. Identity creation minted a root ed25519 keypair. Test rig:
Rust units plus a mocha suite over real HTTP in ~0.3s. What M0 identities could do: **nothing.**
They existed; they didn't sign.

**M1 — entries that sign (COMPLETE 07-06).** The IM-AOL core: canonical CBOR (RFC 8949 §4.2
deterministic), NFC normalization, unknown-field carry-through, entry type registry v0,
BLAKE3-256 hashing, domain-separated ed25519, per-`(key, service)` chains with dense seqs and
`prev_hash` links, and the store-the-author's-original-bytes discipline. First consumer
`profile-set` with LWW materialization, chosen because it exercises sign → append → validate →
materialize with the simplest possible semantics. Test vectors published to `spec/test-vectors/`
(the conformance boundary, started as a habit on day one) and `ringtome inspect` shipped as the
promised readability escape hatch. Exit demo, still living as `profile.cjs`'s "rebuilds an
identical profile": wipe the view tables, replay the log re-validating every signature and hash
link, get the same state back.

Three design decisions from M1 are load-bearing everywhere since:

- **The protocol lives in its own crate (`proto/`, `ringtome-proto`).** A compiler-enforced
  dependency firewall - its manifest lists blake3, ed25519-dalek, thiserror,
  unicode-normalization and nothing else - so the layer a third implementation must reproduce
  bit-for-bit physically cannot grow a dependency on node state. In a module that purity is a
  convention that erodes one convenient import at a time. It also names the conformance boundary
  and puts the fast test loop where the hard tests live.
- **COSE-style envelope, not sig-as-a-map-field.** The wire object is `[body: bstr, sig: bstr]`
  and the signature covers `domain-tag || body-bytes`, so verification slices received bytes and
  *never re-serializes*. Re-encoding during verification is exactly where canonical-encoding bugs
  become forgery bugs; this makes the store-original-bytes rule structural, not disciplinary.
- **Hand-rolled strict canonical CBOR subset, ~250 lines, not a serde library.** The encoder is
  the spec (vectors promise exact bytes), and - the part libraries don't offer - the *reader
  rejects non-canonical input*: non-minimal integer heads, indefinite lengths, unsorted keys,
  non-NFC text, tags, floats. Entries are hostile network input; one logical value = exactly one
  accepted encoding.

**M2 — the key tree (COMPLETE 07-06).** `proto::keytree`: chain linearization with deterministic
fork resolution and evidence, usurper-stamp cross-check, rank-path total order, seniority-sorted
retirement/repudiation with anchored ceilings. Eleven scenario tests plus a 25-seed property test
covering totality/antisymmetry/transitivity, recovery-position-outranks-all, and shuffled-arrival
convergence. Node side: identity creation mints the recovery key and writes the genesis authorize;
the recovery secret is returned exactly once and never persisted. Two dragons were named here for
later: fork-aftermath re-signing, and the weight of the recovery key as a permanent skeleton key
(the Cozyweb ceremony must carry it).

**M3 — two nodes, one identity (COMPLETE 07-07, with deliberate trims).** iroh 1.0 endpoint per
node (persistent node key sealed in the keystore, `presets::Minimal` - zero external
infrastructure), `proto::sync` wire messages with `[floor..head]` frontiers **from day one**
(retrofitting shallowness into a dense-from-zero wire format is a protocol break), and the
symmetric-exchange engine with the validation gate ahead of storage: strict decode → signature →
chain contiguity → key-tree membership → revocation ceilings. The add-a-node ceremony landed as
request code / grant code, two copy-pastes. The exit demo became a two-node integration test:
adopt, write-on-B-read-on-A, kill-A-and-survive, and repudiation with A's gate refusing the
evicted key's writes ("EVIL TWIN" stays on B). *Trims:* iroh-blobs deferred (no blob producer
existed yet), pkarr deferred. *Residuals:* manual sync triggering, root-only grants, and - the
long-lived one - **fork evidence cannot be stored**: the entries PK means a conflicting entry is
rejected at the gate (safe, convergent) but its bytes are dropped rather than kept as proof.

**M3.5 — discovery (COMPLETE 07-07, pulled forward for `ringtome://` resolution).** Dial-by-key
everywhere; addresses stop being our data. Signed **serving records** published under an identity
*leaf* key (`ringtome-v0/serving-record`, test-vectored, well inside pkarr's 1000-byte budget -
trust never comes from the record, so they are pointers and liveness only). One `Directory` trait,
two implementations: `MainlineDirectory` over the real DHT and `LocalDirectory`, a shared-folder
fake storing the *same signed bytes* with the same one-record-per-key and TTL semantics - also the
future attack harness. Discovery mode selects the iroh preset too. **Publication is an act**: only
identities explicitly marked served publish (`served_at_ms` + `POST .../serve`), never as a side
effect of creation. The `addrs` column died. *Residual, later closed on 07-22:* Mainline mode had
never touched the real DHT.

---

## Private chains and the store layer (2026-07-08)

**Private chains** were pulled forward from Tier 5 the moment vouches and contact names needed
them: encrypted chains synced only among an identity's own nodes. The scheme is written up in
PROJECT_PLAN ("Private Chains: Epoch Keys and the Membership Boundary"). Proto gained `key-epoch`
/ `private-record` payloads, `PrivatePlain` (register / set-add / set-remove), `enc_pubkey` on
authorize, and a channel-bound `MemberProof` in the sync Hello. Node gained `seal.rs` (dryoc
sealed boxes, photo-seed recovery derivation) and `private.rs` (epoch unseal/mint/rotate,
XChaCha record crypto, LWW register and set views). Identity creation mints the root enc key and
epoch 0; adoption re-seals the epoch history; **every revocation rotates the epoch**; and the sync
gate withholds private entries *and frontiers* from unproven peers in both directions. Proven by
`private.cjs`: a revoked node keeps reading its era while the post-rotation record never even
reaches it. *Residuals from the day:* concurrent rotations can twin an epoch number (readers try
all keys, the AEAD tag disambiguates - convergent but unlovely); the epoch boundary is eventual
under partition, by design; requesters re-offer private chains every exchange.

**The store layer** landed the same day: `node/src/store.rs`, one table declaring every variable's
chain, merge rule, visibility, materialization, and sync policy, plus typed handles exposing
exactly each CRDT's legal operations. Routes went on a diet and application code stopped touching
`imaol`/`private` directly. Timestamps unified to `i64` end to end, `received_at_ms` per replica,
and the authoring clamp closed the fast-clock LWW wedge.

---

## Doctrine interlude, and a license (2026-07-09 → 07-14)

A documentation stretch between build pushes. NOTES_APP.md born (07-09) as the first application
spec - multi-device encrypted notes as the proving tenant for the private store. Slug and
address-bar resolution designed into the plan (07-11); groups sketched (07-14); PROJECT_PLAN
rewritten in place up through Recovery Planning (07-14). License settled: **AGPL-3.0 for now**
(07-12).

---

## Files, documents, and media (2026-07-15 → 07-20)

**The file layer + CI (07-15).** `files.rs`: encrypted, content-addressed file bodies stored and
transferred by iroh-blobs over a second ALPN on the same endpoint. A "file" is XChaCha ciphertext
under the epoch key with a random nonce, content-addressed by the BLAKE3 of the *ciphertext* -
unlinkable, which is why serving needs no gate: holding the hash is the capability. One
content-agnostic layer for note bodies, posts, and media alike. Same day, CI: a GitHub Actions
workflow that runs `just ci` verbatim, so the push gate and the local gate cannot drift.

**Versioned documents (07-15 → 07-17).** A document is a stable `doc_id` whose versions form a
DAG. Each save appends one encrypted `doc-header` to the notes chain (the version's identity is
the entry's own hash; `parents` are what it was edited from) with the body as an encrypted file.
The materializer folds headers into per-document DAGs and **detects** divergence rather than
resolving it - keep-both is the universal never-lose answer, merge is a per-format capability
dispatched on the document's type. Shipped as merging machinery → merge behaviors → the DAG
proper → two text formats (marquee and plaintext) with the conflict format dispatching on type.

**Media ingest (07-18 → 07-20).** One weekend of escalation: WebP as the first media format →
stills AVIF-ified (animated exempt) → size caps split into their two honest meanings (the
pre-crunch upload ceiling vs. the ~10MB nothing-bigger-moves-on-the-network distribution cap) →
one deliberately-low quality tier → video ("IT IS TIME TO CRUSHA DA VIDEO"): WebM canonical output
with poster frame and silent micro-preview, then audio through the same crush. Ingest became one
async pipeline: raw upload lands in a disposable quarantine directory, a `pending` row goes into
`ingest_job`, the caller gets a version-less `doc_id` back immediately (**version-less IS the
pending state**), and a background worker drains the queue FIFO on `spawn_blocking`. Terminal
failures surface as tombstones in the queue, never ghost documents.

**Crown hardening: revocation anchors by hash (07-20).** A revoked-but-still-held key could forge
an alternative under-ceiling prefix that fresh or late-syncing nodes would accept - enforcement
was seq-only, because the crown discarded the anchor's `head_hash` and every test used zeroed
hashes. Now: sealed-prefix-as-unit crediting in the crown, seal-or-nothing admission at the gate
(the prefix walked by hash-link from the anchor down to `ZERO_HASH`), and proven-forgery eviction
for the race where the forgery arrived first. The adversarial tests were verified to fail against
the old behavior before the fix landed.

---

## The substrate, the UI shell, and real infrastructure (2026-07-20 → 07-22)

**Turso, the journal, materialized views (07-20 → 07-21)**, in the order the plan sequenced them
so nothing interim was built to be thrown away:

- **Turso** with page-level at-rest encryption (AEGIS-256). Every database gets its own random key
  sealed in the node keystore, and there is **no unencrypted mode** - a database file with no key
  file refuses to open rather than minting a key over the tell. Schema policy pre-launch: squash
  into `0001`, generation-stamped, rebuild never migrate-in-place.
- **The journal**: the insurance that lets a beta database engine sit under the views. One
  append-only flat file per identity - length-framed signed envelopes, no checksums, no
  timestamps, because replay re-runs the full validation gate and integrity rides the signatures.
  Write-ahead at both insert sites; journal ⊇ database is the invariant.
- **Materialized views**: private register/set views moved from memory to persistent tables with
  per-chain watermarks, catch-up-on-read, and the stall rule (a watermark never passes an entry
  this key-set can't decrypt). Everything in a per-user DB outside `entries` is now a disposable
  projection, and the conventions cop's table-ownership map grew to enforce the new tables' owners.

**The embedded UI (07-21).** The Preact SPA served by the node itself: esbuild bundles and the
HTML shell baked into the binary at compile time, fonts and all, with versioned static asset
paths - the deployed binary is fully self-contained. `just start` boots server plus JS/CSS
watchers in one terminal with one Ctrl-C teardown.

**Mainline field test (07-22).** The M3.5 residual closed: two nodes on one box against the real
public DHT. A serving record published under the leaf key and resolved back out through the
*other* node's pkarr client, the adoption ceremony, then both nodes restarted - address caches
gone, fresh UDP ports - and a re-sync driven by nothing but a bare endpoint id through iroh's N0
discovery. Healthy runs finish in ~7 seconds; the test budgets minutes as retry ceilings for when
infrastructure isn't healthy. Shipped as `just mainline-smoke` plus a dispatch-only GitHub action
that uploads per-node logs win or lose. *Residuals:* only the relay-assisted path has been
observed - raw-DHT fallback is unexercised, and same-box means the NAT rung still awaits two real
houses. Each run publishes throwaway records (and the runner's IP) to the public DHT, by design.

**Background sync + eager push (07-22).** The M3 residual delivered: sync stops being manual.
`net/resync.rs` registers two passes over the existing exchange - **eager push** (per-root
frontier fingerprints compared across ticks, a debounce that waits for the write burst to quiet
plus a max-latency cap, then a full exchange with every known peer) and **anti-entropy** (up to 3
randomly chosen peers per identity, dirty or not, first pass at boot). Entries *received* re-dirty
the frontier and relay onward - epidemic spread, converging because an up-to-date exchange moves
nothing. Privacy needed zero new logic: member proofs inside the exchange decide disclosure
regardless of who dials. Doctrine clarified along the way: **"Rehosting: Pull, Not Push" governs
*hosting*, not sync initiation** - hosts holding tradeable information SHOULD sync unprompted.

The feature flushed out two latent concurrency defects, both fixed and both instructive: Turso
connections refuse overlapping statements, a race that stayed theoretical while traffic was
request-driven and became constant under a 2s poll (fix: a per-statement async lock inside `Db`);
and concurrent gate ingests raced between head-read and insert, so the losing batch died on a
UNIQUE constraint instead of duplicate-skipping and armed the retry backoff (fix: a per-identity
ingest gate held across each validate-and-store batch). Design note kept: the tracker seeds
newly-observed roots **dirty**, because seeding clean was empirically shown to swallow writes
landing between adoption's peer-add and the loop's first look.

---

## Annotations, taxonomies, trees (2026-07-22 → 07-23)

**Annotations** were the data-layer rewrite's last step and the substrate's first real tenant:
`doc-meta-private` (service 7), the pre-graduated chain for private facts about documents.
`annot:<root>/<doc_id>` collections on the existing `PrivatePlain` codec - LWW registers for
fields, set elements for tags, a 2 KiB value cap enforced at the handle with the refusal naming
the alternative (a description that big is becoming another document - write one and reference
it). All the mandatory mechanics were present: a fresh AAD, the `is_private_service()` line at the
sync gate, the withheld-from-strangers test cloned. The persisted view tables absorbed the new
service with **zero schema change** - `service` rode their primary keys from day one, exactly as
the migration comment promised. The docs-list read gained `doc_heads`, a memoized per-document
display row: not judgment-in-SQL, but a memory of the Rust resolver's latest answer, recomputed
for exactly the documents whose inputs changed.

**Taxonomies, v1 lists (07-22).** Ordered document lists as per-element ranked facts on the
doc-meta chain - zero new wire format, zero new tables. `record/rank.rs` holds fractional base-36
ranks (`between` for inserts, compact-append `after`); review caught two real hangs before they
shipped (gapless intervals, and same-digit-collapsing hostile bytes), both now terminating as
deliberate rank duplicates with the contract stated in the module doc. The `Taxonomies` handle
made existence a roster fact, made **place mean add AND move** (a set re-add updates the value
under the same LWW stamp - one write, drag-and-drop semantics, a mover never transiently absent),
and made titles ordinary annotations on the taxonomy's own id, so rename needed no machinery and
no routes. A foreign identity's document was representable as a member from day one.

**Trees as composition (07-23).** The trees residual closed by a design comparison instead of a
build: the planned `parent` slot with a fold-time cycle rule, versus composition (a taxonomy
placed as a member of another - a capability the lists ship had already created by accident).
Composition won on one decisive ground: parent pointers put a merge-created cycle IN the storage
structure, broken until an algorithm silently rewrites someone's move - exactly what the notes
design refused - while composition cycles are independent membership facts that corrupt nothing
and reduce to a render concern. The `parent` slot retired unused; the cycle-rule dragon retired
unslain. What shipped: local cycle refusal in `place` (BFS over the local view - a courtesy, not a
guarantee) and `Taxonomies::tree`, which expands nested own-taxonomies depth-first under a visited
set, rendering any second encounter as a titled stub (`members: null`) - which also bounds the
walk linearly.

---

## The client arrives (2026-07-23 → 07-24)

**The front door (07-23).** Node login and registration, deliberately bargain-basement: username
and password against the M0 auth API, no identity ceremony, no email. `auth.js` carries a
`useSession` hook over the HttpOnly cookie (whoami on first paint, so the sign-in screen never
flashes at someone already in), register-then-login in one motion, live debounced username
availability, and one two-mood Welcome component. ~330 lines, sized to be reviewed without losing
the plot.

**Device names (07-23).** A key tree rendered as fingerprints is a statement for the utterly
deranged, so keys carry private human labels (PROJECT_PLAN, Device Names) - one register
collection on general-private, so labels sync to all your own nodes and are structurally invisible
to strangers. Nodes carry a configured name defaulting to the hostname; identity creation labels
the founding key, an adopting node labels its own new key - both **best-effort by design, because
a label must never doom a ceremony**. The recovery key stays unlabeled (a role, rendered by rank),
disambiguation is derived at render, never stored, and rename is the ordinary private KV route.

**Personas in the UI (07-23 → 07-24).** Signing in now lands somewhere. An account with personas
auto-opens the first; an account with none gets "Nobody lives here yet" and the create flow. Two
language rulings joined the Cozyweb mapping: **the persona is the single taught concept**, and
**the account never gets a noun** ("sign in" / "new here?" are verbs). Creation runs the minimal
honest spare-key moment - the recovery secret rendered once, downloadable, continue-gated behind
"I put my spare key somewhere safe". Two-step onboarding was interrogated and kept: the friction
is dissolved by sequencing, not by merging the model. Field-testing immediately caught the missing
last step of being born - a fresh persona rendering as "persona 7db0" - so the ceremony flows into
a name picker, pre-filled with the account username (the one name this human already chose today).

**Spare-key password reset, Flow A (07-24).** "Give me your spare key and I'll let you reset your
password", scratch version, lattice fully enforced. The pasted seed derives the recovery keypair
and its pubkey must match the identity's **designated recovery key** - the unique Active key on
the all-zeros rank path, failing closed if the leftmost-spine convention is ever violated; an
ordinary leaf, even a valid one, proves nothing. The scoping split is worth its paragraph:
recovery is a **credential-authority operation, not identity verification**, so a single-persona
account resets in place while a multi-persona account **re-homes** - a 409 asks for a new sign-in
name (post-proof only; count-not-names is the accepted disclosure), then the proven persona moves
to a freshly minted account and the old account is left entirely alone. If the key was stolen, the
victim keeps everything except the persona the stolen key already owned outright. Every unprovable
failure is the same uniform "recovery failed"; in-place reset purges every session; 5/hour/IP.
*Deferred and named in the plan:* browser-side challenge signing, post-use rotation, cooling-off.

**The password floor follows the bind address (07-24).** A node bound to loopback relaxes the
8-character minimum to 1 ("password can't be empty" is the only refusal left), because reaching
that prompt already required physical access. The load-bearing signal is **reachability, not
tenancy**: a single-tenant node on `0.0.0.0` keeps the strict floor, and an unparseable bind fails
closed to strict. The integration suite's "rejects short passwords" test inverted into "allows
short PINs" - the test suite updating to describe the new world is the change working as intended.

---

## Adoption grows up (2026-07-24)

**Adoption in the UI.** On a new computer, "bring your persona from another computer" mints a leaf
and shows the request code (**keys are born where they live** - only signed codes travel); on a
computer that is already you, a "your computers" screen renders the key tree in domestic clothing -
device names where we labeled them, "the crown" and "the spare key" by role, shortcodes beside
everything because names are never authority. Settled on the way: two nodes on one machine are
simply two peers; adoption is a synchronous ceremony (the grant code's addresses are deliberately
ephemeral); there is **NO per-leaf recovery key** - the spare key is tree-level, proven by a new
two-node test where a persona born on A and adopted to B is rescued on B by A's day-one seed; and
spare-key succession after catastrophe became settled doctrine (the survivor mints its successor
spare FIRST and owns the reachable future; the lost past stays dormant-senior forever).

Field-tested immediately and caught red-handed: running both halves on one node sailed through
grant and died at completion with iroh's raw "Connecting to ourself is not supported" - after
authorizing a stray leaf per attempt. The guard now lives at the GRANT step (zero tree pollution),
with a belt-and-braces twin at complete. And the phantom unit-test flake's fourth escape finally
bought the promised capture wrapper: `just test-unit` tees full `--no-fail-fast` output to a log,
so sighting five cannot vanish.

**One-trip adoption.** The second courier trip deleted: a dedicated adoption ALPN carries the
grant over the wire, so the granter dials the requester and hands the grant straight to the
pending node, which completes inline and acks only when fully moved in - `delivered: true` means
the persona is already home. The design choice worth its ink: the inverted alternative (a
granter-minted invite code) was rejected because it is a **bearer capability** - anyone holding
the string joins the tree - while keeping the request direction keeps both codes non-bearer.
Delivery is best-effort with the carried code as graceful fallback, and completion became
idempotent, so the wire beating the human's paste is now the common case; every pre-existing
adoption test passed unchanged through the new path because of exactly that.

**Codes wear a costume.** The raw JSON strip of pubkeys and socket addresses ("code? so
complicated!") became `rt1.` + base64url(deflate(JSON)) - ~390 chars instead of 600. Decorative
armor with real dividends: the prefix versions the envelope independently of the inner JSON's `v`,
deflate genuinely earns its keep on hex pubkeys, and compact base64url is what the QR ceremony
will want. Bounded at 64 KiB of decompression; garbage refused cleanly in every costume.

**Junior grants: the trim un-trimmed.** Any Active key can now sign a newcomer into the tree, so
invitation chains daisy - A founds, B joins from A, C joins from B - and rank paths record who
vouched for whom. The missing piece was never doctrine but one computation, and it landed where it
belongs: `Crown::usurper_stamp_for_new_child` in the conformance crate, proven by a round-trip
test at depths one and two (a stamp the validator's exact-match check accepts IS a correct stamp).
The harness grew a third node, and `daisychain.cjs` proves the lot: B's grant of C delivered by
wire, the lineage, every key named from the deepest chair, a write on C converging to A through
the epidemic relay with no manual syncs, and the founding spare key rescuing C's account password
two hops from home.

---

## The browser becomes a view (2026-07-24 → 07-25)

**The live cache, Stage 1.** `/api/identity/{root}/stream` is the read-only WebSocket the plan
settled (The Browser Is a View); `cache.js` is the Dexie mirror it feeds. The honest v1 shape:
whole-kind refreshes (the degenerate delta, idempotent to apply), a cursor that is resync's
frontier fingerprint hashed (matching reconnect → live; any doubt → full snapshot, because
drop-and-re-stream is the design's own answer), change detection as a 1s fingerprint poll, one
socket per tab, mirror dropped unconditionally on logout. The stream reuses the HTTP routes' own
response structs, so mirror rows and fetch rows can never drift. Ownership is gated BEFORE the
upgrade, and client chatter down the socket is read-and-ignored - mutations are POSTs, doctrine
held mechanically. First consumer: the persona badge reads the mirror live, so a rename on any
computer lands in every browser's bar within seconds.

The debugging war story, recorded because both morals generalize: the first full run appeared to
wedge mid-suite with both nodes healthy - a false alarm manufactured by block-buffered grep in the
harness pipeline (output frozen at a 4KB boundary while the suite ran on), which hid the REAL bug:
mocha hung at exit on websocket handles leaked by the stranger tests. **Line-buffer or don't pipe;
a refused upgrade still leaves a handle to destroy.**

**The notes app, v0 (07-25).** The flagship boots, deliberately skeletal: a left column listing
every document newest-first straight off the live mirror (the component never fetches a list in
its life), and a right column reading the selected document read-only. The reader consumes the
node's synthesized `body` - single head, clean merge, or the conflict presented inline with device
labels - so divergence display cost the reader NOTHING. Settled in passing: **a document's format
is per-VERSION**, so "change a file's type" is an ordinary save with a new format.

**The editor (07-25).** One component carrying all four client obligations from NOTES_APP's sync
model: debounced autosave (~10s idle, blur, tab-hide, doc switch - and a clean buffer never
saves); check-the-head-before-saving with the live mirror as the lookout (head moved + clean →
quiet fast-forward; head moved + dirty → keep typing, the next save forks knowingly - never
blind-save, never lose); conflicts present in the document, and editing-then-saving with every
head as parents IS the resolution (**the editor is the merge tool**); and the tangle starts clean,
not dirty, so autosave can never commit an untouched conflict. The buffer is the long-promised
**shadow overlay** in its natural form: local state the stream never repaints, watched against the
mirror but never rendered from it. Review caught a real bug: the no-op bounce compared body and
title but not format, so a format-only conversion would have silently swallowed the exact explicit
act the per-version-format doctrine promises.

---

## The merge saga: seven field-test rounds (2026-07-25)

Dogfooding the editor produced the most productive week of bug reports in the project. Each round
is kept because each moral outlived its bug.

- **The body lane joins both sides.** Two editors on a diverged doc kept "clearing" each other.
  Headers ride entry sync but BODIES ride iroh-blobs, and `fetch_missing_bodies` ran on the
  *initiator's* side only - and eager push makes the WRITER the initiator, so a receiving node's
  fresh headers pointed at blobs it wouldn't hold for up to five minutes. The resolver honestly
  answered `body: null`; the editor poured null into the textarea as empty string; the user typed
  into the void and the save asserted every head as parents. Never-lose-words held at the chain
  level throughout, but the UX was an eraser. Two fixes, either sufficient, both correct: the
  **responder now backfills too** (dialing back the peer that just delivered the headers, who is
  online by construction), and the **editor treats a null body as a waiting room** - editing
  disabled, "on its way…", a 2s retry, and a structural guard that a parentless buffer can never
  save.
- **The oblivious editor, and conflict sides get their names.** After a fork, one editor showed the
  merge and the other sat oblivious: the lookout watched "did the display head move", but the
  display head of a diverged doc is one deterministic pick, so the device that WAS the pick saw its
  own hash. The lookout now watches the whole shape - display head, head count, diverged flag.
  Same round: conflict labels stopped being raw hex and millis and started speaking **device
  names** ("from alpha, 2026-07-25 03:12"), the exact promise NOTES_APP made and the exact purpose
  device names were minted for two days earlier - with a zero-dep UTC formatter, because the label
  is baked into synthesized text and must be deterministic.
- **The recursive base: criss-cross scars merge again.** A clean two-sided edit came back as a
  whole-document conflict. The reported shape was innocent; the culprit was the document's PAST -
  earlier rounds had raced resolutions, leaving two maximal fork points, and `resolve`'s
  base-finder demanded exactly one, degrading every future fork on that document forever. **One
  race anywhere in history salted the ground permanently.** The fix is git's recursive strategy,
  bounded: synthesize a virtual base by merging the fork points over their own base, recursively,
  depth-limited - and, as git does, a CONFLICTED virtual merge still serves as a base, because both
  outer sides descend from the race's resolutions and the markers cancel. Shakedown was a double
  catch: `fork_points` iterated a HashSet, which was not a test problem but a **convergence** bug
  (two devices could synthesize different tangles from identical DAGs; fork points now sort by the
  house total order), and one hash ordering leaked the virtual base's markers into user-facing
  output through diff3's base section, so every merge now uses plain ours/theirs style - closing
  the leak structurally. In the same gate run the test-unit tee finally caught the three-day
  phantom flake with its name on it: `temp_dir()` derived uniqueness from pid+nanos, SystemTime is
  coarser than a nanosecond, and two parallel db tests on one tick shared a directory. Never the
  net layer at all. A temporary "debug" chip shipped alongside (the full version DAG as JSON) -
  field-testing's request, and the diagnostic instrument for everything below.
- **The chip learns two words.** Why does a CLEAN merge still light the "diverged" chip? Because
  the flag is honest - the DAG genuinely holds two heads until the next ordinary save heals it,
  since clean merges are synthesized at read time and never auto-committed (minting merge entries
  at detection is exactly how racing devices generate infinite criss-cross). But one alarm word
  covered two states, so: clean synthesis shows a calm green "merged", genuine overlap keeps the
  red "diverged".
- **Marquee conflicts go per-hunk.** The whole-document presentation for Marquee - settled to
  protect block elements from hunk boundaries - was re-judged in the field as a cure worse than the
  disease. Markers became `:::conflict` / `:::variant` vocabulary at the same boundaries (a line
  state machine, not blind replace), so non-overlapping edits stay merged. The accepted risk is
  stated in the spec: a hunk can split a multi-line element and fail the strict parse, so the
  reader degrades to source with an honest note.
- **The lookout learns about raced resolutions.** Paired debug dumps were the diagnosis: both nodes
  in perfect agreement, only one browser showing it. Two devices each resolved the same fork,
  producing a fresh two-head fork whose display pick was one racer's own save - every watched
  scalar identical while the head *set* rotated underneath. Second scar on the same predicate, so
  the judgment moved out of the component into `js/lookout.js` as a pure function carrying its scar
  record, tested by mocha without a browser. The cure is one clause: an editor that believes it is
  linear while the row says diverged has definitionally not yet presented that divergence - reload.
  Same report closed the NOTES_APP open question of whose conflict vocabulary wins: **upstreamed**,
  and Ringtome emits Marquee's names, with `label`/`when` rendered verbatim as their contract
  requires.
- **Three-plus heads merge per-hunk.** Three computers changed one paragraph and got the
  whole-document wall, because three-plus heads skipped merging entirely. The dumps showed the fix
  was well-posed: all three forked from ONE version. `fork_points_of_heads` generalizes to head
  *sets*, and when the set shares a single fork point, `align_heads` runs an N-way line alignment -
  each head diffed against the base, overlapping runs grouped into disputed regions, everything
  else woven clean, one variant per *distinct* proposal labeled by its earliest head. Bonus
  correctness: three heads with disjoint edits now merge fully clean, a case the old rule falsely
  conflicted.

---

## Latency, modes, and the writing surface (2026-07-25)

**The write nudge** cut write-to-other-screen latency from ~5-7s to ~1s. Every locally-signed
write rings a doorbell (`imaol::append` is the one funnel, since only local writes sign) that wakes
the eager loop immediately, so the debounce clock starts at the write. The deliberate asymmetry is
the damping: **sync-received entries do NOT ring the bell** - relays ride the lazy tick, which
keeps a peer triangle from ping-ponging. Dial turns: debounce 3000 → 750ms, eager tick 2s → 1s.
Evidence the levers work: the integration suite halved its wall clock, 44s → 22s, no test changed.
The lever deliberately NOT pulled is the UI's 10s autosave, which is doing version-count thrift,
not sync pacing; the principled fix there is retention. Later the same bell served the browser: a
title change had been taking a full loop to reach the list, so the single `Notify` became a `()`
broadcast and every open socket wakes on a write to re-check its own cursor - with the 1s tick left
as the backstop for what a local nudge can't see, so **nudging is pure latency, never correctness**.

**The editor grows modes; Marquee becomes the front door.** Write/preview tabs retired in favor of
four view modes - interactive, side by side, plaintext, read only - under the rule that keeps the
mapping honest: **modes are a VIEW choice, format is a DOCUMENT property.** The interactive surface
is `@cube-drone/marquee-codemirror`: Obsidian-style live preview where the document never stops
being plain Marquee source, so the save machinery is untouched - the surface hands the shadow
buffer a string exactly as the textarea did. The Preact wrapper does the controlled-CodeMirror
dance (the `body` prop replaces the doc only when it disagrees) with a syncing guard so
programmatic replaces never arm the dirty flag. Conflict tangles ride along: `:::conflict` blocks
render live, so a divergence looks like labeled stacked blocks you click into and tidy. Last-picked
mode remembered per document in a new local-only `prefs` table on the mirror - the one table the
stream never feeds.

**Turbolinks unfurl: OpenGraph cards via the node.** No turbolink expanded anywhere, not for want
of machinery but for want of wiring - and the package's own OpenGraph plugin can't run in a browser
at all, since CORS forbids reading foreign HTML. So `js/turbolinks.js` composes the fetchless
defaults plus a Ringtome plugin whose resolve() asks the node. The node side owes two guarantees,
both tested: **no reaching inward** (http/https only, every redirect hop re-vetted, every DNS
answer required to be a public address, and the connection PINNED to the vetted address via a
per-hop resolve override, closing the DNS-rebinding TOCTOU - a node is never a periscope into its
own LAN) and **no reaching outward too hard** (one global token bucket, generous for a human
pasting links, useless as a load test against a foreign server - Curtis's framing and the
condition on shipping this at all; refusals spend tokens too, which is what makes the 429 provable
offline). Recorded as deliberate: unfurling links in private notes reveals interest to target
sites; accepted.

**Side-by-side follows the cursor, and the caret remembers.** Ported the renderer demo's scroll-sync
pattern whole, keeping its load-bearing echo guard commented (setSelectionRange fires `select`,
which would yank the clicked node out from under the cursor). Then a shared per-document caret
memory across every editing surface, deliberately in a module-level Map rather than the mirror's
prefs table: **prefs are for choices, a caret is incidental working state** - and Dexie is cross-tab
shared, so persisting it would make two tabs clobber each other and resurrect stale positions as
noise.

**Private-document search.** Settled along the seam the architecture already offered - Curtis's
synthesis, which collapsed the "where does the index live" fork and dodged the Turso-FTS5 gamble:
the index is a **materialized view like `doc_heads`**, not a SQL FTS feature. `doc_search` holds
one token-bag row per document (title, resolved body, and annotation text - fields AND tags, so a
long description is exactly as findable as body prose). It lives in the per-identity Turso DB, so
it inherits at-rest encryption **by construction** - an index is a plaintext derivative of
encrypted bodies and must never be less protected than they are; putting it anywhere else would
have been the whole security question. It streams to the mirror as one more kind and the browser
queries it locally: offline, instant, zero round-trips per keystroke. Two mechanics worth keeping:
staleness is a fingerprint over exactly the token inputs (the head *SET* as a BLAKE3, not the
count, because raced resolutions rotate the set invisibly - the lookout lesson, reused), and **a
backfilled body re-indexes with no chain movement**, via a per-root `view_epochs` counter mixed
into the stream cursor.

**The 64 KiB save cliff.** Pasting a ~600KB document (Sherlock Holmes) showed "Not Saved!" and a
bare NetworkError, with nothing in the network tab or the server log. That absence WAS the clue:
the request never left the browser. The editor set `keepalive: true` on every save, and fetch's
keepalive flag caps request bodies at 64 KiB by spec. Any document over ~64KB simply could not
save. Fix: keepalive only on the unload flush, and even then only when the body fits - a big
document flushed on unload falls back to a plain fetch, which is all an unload flush ever was. The
decision is a pure tested helper because the bug was so silent it earns a regression guard.

**Annotations get a UI, and a claimed date.** The annotation model had routes but nothing to set
them with; now an annotations panel sits in the editor and the list filters by tag, stacking with
search. The design question - bake annotations into `doc_heads`? - resolved to **join at the stream
boundary, not merge the folds**: `doc_heads` memoizes the *notes* chain while annotations fold from
a *different* chain, so merging them physically would couple two folds. `DocSummary` gained `tags`
+ `fields` joined in `gather`, and staleness is free because an annotation write IS a chain write.
Then `display_date`: the user's own asserted date, authoritative for sorting precisely because a
human's deliberate assertion outranks any clock (PROJECT_PLAN, Displayed Time vs. Claimed Time -
openly the most authoritative and least trustworthy date at once). The satisfying part is **zero
backend** - it's a conventional annotation field riding the existing route onto the mirror row, so
the whole feature is client-side pure rules (date-only parsed as LOCAL midnight so "2015-07-31"
never displays as the 30th), amended the same day to carry an optional time.

**The console and client-side routing.** Opening a persona lands on a **console** - an application
launcher (PROJECT_PLAN, The Client Is a Console of Applications) - with one tile today and apps
known only as `{id, name, icon, tagline}` in a plain registry. The whole client got URL routing
under `/home`, so back/forward, refresh, and deep links work, and the selected document moved from
state into the route. Two doctrine rules fell out:

- **Internal URLs are session-relative and identity-free.** The moment an identity appears in a
  URL it looks shareable, and internal URLs are not. The rule that follows: *identity-in-the-URL is
  the signal that a thing is shareable* - so the two can never be confused, structurally rather
  than by carefulness.
- **A persona slug is a publishing prerequisite, not a routing one.** Slugs become real when a
  persona or document becomes publicly addressable - a claim-your-handle moment - so nothing about
  this layer waits on them.

---

## Buckets and the app shelf (2026-07-26)

**Document bucketing.** Which project(s)/notebook(s) a document belongs to. Curtis's correction
shaped it: buckets are NOT a Taxonomy (no ordering, no ranks, no composition), they're
**annotation-shaped** - the exact tag mechanism, in a SEPARATE collection namespace. The
separation is the whole point: a bucket is the axis search and tags are *scoped to* ("braise" in
the recipe book finds braised pork, never the journal), so it must not appear in the tag cloud it
filters. No new SQL table; `DocSummary` gained `buckets` at the stream boundary like tags. The
load-bearing test: a word used as both a bucket and a tag stays cleanly separate in both axes.

**The bucket registry.** Curtis corrected an over-reach (I had started modeling a named bucket
object as a Taxonomy). Membership is already tag-like and name-keyed and stays exactly that; the
only new thing a bucket needs is a place to tie its **name to an app-type** so a wiki never opens
in the recipe app - and, as a side effect, somewhere for an empty bucket to exist between
"created" and "earned its first document". So: one LWW register collection, key = bucket name,
value = app-type. `roster` merges the registry with the in-use names, so a bucket appears if it is
registered OR holds documents.

**App styles, then implicit scoping.** `js/apps.js` is the curated app registry, each app carrying
a `style` and `default` (Notes) as the fallback for an unknown style - the graceful degradation a
free-form app-type field requires. The `Notes` component became `DocsApp`, the shared documents
surface parameterized by its app, so a new app is a registry line rather than a fork of the
machinery. Then Curtis simplified the app↔bucket tie: **a bucket whose NAME is an app-type simply
IS that type**, so every app has an eponymous bucket we just assume exists - no implicit creation,
no `define` for the common case, registry only for user-named buckets. `DocsApp` scopes its list by
resolved app-type with unbucketed docs belonging to the default app (the catch-all, so legacy notes
never vanish), and search and tags filter *within* the app - the scoping the whole console rests on.

**Recipes gets its own face.** App surfaces became data: a `features` block per app over
full-Notes defaults. Recipes overrides to a recipe book - interactive mode only, no format chip, no
date/description, plus a `tagColumn` (a thin tag-frequency sidebar, counted over the app's docs
unfiltered so it stays a stable index). The pieces read the flags rather than hardcoding, and the
editor falls back to the format's full mode set if the intersection is empty, so a doc is never
trapped. Adding an app's personality is now a `features` block, not a fork of the editor.

**Four correctness-and-polish units the same day:**

- **Tags read in insertion order.** Tags surfaced alphabetically, scrambling the order the author
  built them in - and the order was recoverable all along. An LWW-element-set element carries the
  stamp it was last written under, and that stamp is the CRDT's full total order
  `(timestamp_ms, seq, hash)`; `SetElement` only ever exposed `updated_at_ms`, so a
  same-millisecond burst fell back to a string tiebreak. `set_elements_ordered` sorts by the full
  stamp. No schema change - the order was in the stamp the whole time; we were throwing it away at
  the view boundary.
- **Title edits settle on blur.** A tag is an annotation (immediate write, sub-second echo) while
  the title is part of the document *version*, so it rode the 10s autosave and the list row lagged.
  The title input now flushes on blur; body edits keep the debounce on purpose.
- **Delete: a reversible tombstone.** The id joins a `deleted` LWW-element-set on the doc-meta
  chain and the document drops out of every list and search at once. The version chain is
  untouched, so `restore` brings it back whole - **a hide that syncs, not an erasure**. The filter
  is centralized in the three `Documents` read methods, so all six route surfaces are covered with
  zero route changes. The editor disarms its dirty buffer BEFORE navigating away, or the
  doc-switch unmount flush would save a fresh version onto the doc being tombstoned. *Residuals:*
  dropping the content blobs, and a visible undo surface.
- **Pin.** The tombstone's twin: a `pinned` LWW-element-set in its own collection (never a hidden
  tag - a tag would leak into the tag cloud, the row chips, and the search index). It filters
  nothing; it rides the row and the client sorts pinned first, so the ordering lives entirely on
  the client and the server only reports the fact.

---

## The chrome era (2026-07-26)

The client acquired a house style, in a run of small units:

- **The app becomes a fixed frame.** The bottom dock stopped being a `position: fixed` overlay:
  `.app-main` is now a full-viewport flex column holding the app region above and the footer band
  below, so neither can cover the other. The app region is a framed box with a chunky 10px `--ink`
  border whose inner layer scrolls *inside* the border, and the notes columns scroll internally.
  The border isn't `border-radius` (too smooth for a retro panel) - it's two `clip-path` layers
  sharing one polygon whose corners STEP like pixels, dark outside and surface inside. No image, no
  9-slice; the jaggedness is the corner geometry itself, and only the bottom corners step, so the
  panel reads as sitting on its feet.
- **An icon language.** Every emoji replaced with a Phosphor duotone icon (MIT, so it fits the
  project's constraint), through one `icons.js` role → glyph map, so the UI names icons by meaning
  and a restyle is one edit. One `IconContext.Provider` sets the house style. Cost ~44KB. The one
  glyph left as text is the `×` on tag-remove buttons - a typographic character, not an emoji.
- **The app selector lives outside the shell.** The bordered frame means "an app is open", so the
  honeycomb launcher rides a bare warm desktop `stage` instead: the hexagons SUMMON apps, they
  aren't an app themselves. The pre-persona flows ride the stage too.
- **A unified app header.** Every app gets the same header from the shell - no app draws its own
  top bar - derived from the path, so a new app is a registry line and nothing more. `close` leaves
  for the launcher, `back` appears only when a document is open. Net rule held throughout: **one
  obvious way out from every screen, never two.**
- **Persona becomes an app**, the first tile, wearing the unified header - which required
  distinguishing `liveApps` (launchable) from `docApps` (live apps with a document `style`), since
  Persona is a system app with its own pages. Then it **wears your name**: the tile and header read
  the live persona name off the mirror, so a rename on any computer lands within seconds.
- **The Quickbar, with an app dock.** The footer got a name and its left end became one small
  hexagon per live app - a one-click switch that skips the console, the current app lit and the
  rest dimmed. It grew up the same day: the persona badge and gear went away because Persona is the
  first hex and IS both the identity and the way into persona management. The tiles are two-layer
  hexagons whose rim is the SAME teal as the bar, so within the bar it dissolves and only the part
  poking ABOVE the bar carries a visible edge - the frustrating-to-lay-out effect Curtis asked for.
- **A Swatch Internet Time clock**, because the retro web demands it: 1000 beats on Biel Mean Time,
  two decimals so it visibly moves, real wall-clock time a hover away, verified against the known
  anchors. Purely, gloriously ornamental.
- **Console tiles: the diagonal badge.** A `::before` floods the lower-right half of the hex face
  with the border colour along the corner-to-corner diagonal - a `linear-gradient(to bottom right,
  transparent 50%, border 50%)`, NOT a clipped triangle, because nesting a triangle clip-path
  inside the hex clip-path flooded the whole tile in practice. Icon behind the fill, rotated name
  above it.

---

## Search, resume, and the third app (2026-07-27)

**Search moved into the app header** - a top-level tool in a consistent place across every document
app, with the query lifted to the shell and cleared on app switch. **Apps resume the last document
you had open** (a module-level session memory keyed by `root:app`, redirecting once on entering an
app, validated against the live mirror and the app's scope). **Editor chrome slimmed**: the
annotations panel became a dropdown that takes zero space when closed (closing unmounts it, which
flushes any pending edit, so nothing is lost), the mode tabs went icon-only and pressed right up
against the text like fold-tabs, and every header chip followed - words moved into richer tooltips.
**Search results gained highlighted snippets**, fetched per result and cached by doc_id, so
matching stays local and instant while the snippets fill in a beat later.

**Journal, and the extraction that made it cheap.** Journal is a genuinely different document app,
so it's its own app COMPOSING shared pieces rather than Notes reconfiguring itself with a growing
pile of `false` flags (Curtis's call, and the right one). The shared piece: **`useDocSession`** -
the save engine every editing surface needs (load, buffer, debounced autosave, blur/unmount/tab-hide
flush, and the mirror lookout that fast-forwards a clean buffer or forks a dirty one), moved
verbatim out of the old Editor. "Never lose words" lives in one place now. Journal itself is a
centered stream of one entry per day, newest-first by CREATION time, infinite-scroll windowed, with
today's entry at the top as an inviting blank page - **a phantom that only becomes a real document
when you start writing**. Only today's entry is editable; a minute tick re-checks the day boundary,
so an entry locks shut when its day ends, even mid-edit. Older entries carry a lock button with a
15-second fill.

---

## Notebooks, the wiki, and uploads (2026-07-28)

**Journal polish + the bucket switcher.** Seal/unlock state moved from a session Map into Dexie's
local `prefs` (durable across reloads, live across tabs, **never synced** - "this page is closed"
is a per-device gesture, not a document fact). A page-wide font picker (Special Elite / Caveat /
Atkinson Hyperlegible, typewriter by default) joined it, plus a global `mq-font-*` normalization
pass so the whole marquee grab bag reads at roughly one size. Journal got the same header search,
painting hits in place via the CSS Custom Highlight API - ranges, not `<mark>` surgery, so it lays
over the live editor safely. Then the **bucket switcher**: each doc app is a shelf of notebooks,
ONE bucket at a time rather than an app-type union. Plus mints a new bucket of the app's type,
arrows page the rail, the name drops the full list; deleting the current bucket tombstones every
member doc then undefines it, behind a big confirm. Bucket choice is lifted shell state like the
search query, with per-app last-open-bucket memory. Recorded in auto-memory the same day, because
it cost real time: **`npm run build` is JS only** - CSS needs `npm run css`, and forgetting it
looks exactly like "my CSS changes don't work."

**The wiki.** The taxonomy machinery's first real consumer, and the question "can non-root nodes be
named?" answers itself: interior nodes ARE taxonomies, titled by design. A wiki is one bucket plus
one root taxonomy, associated by title convention (`wiki:<bucket>` - prefixed so user-titled
sections can never collide with a root lookup; lowest id wins a concurrent-mint tie, minted lazily
on first write). Sections are child taxonomies, pages are document leaves edited by the shared
Editor. Fold state in prefs, search filters page leaves while sections stay as scaffolding, and an
"unfiled" bin catches anything in the bucket but out of the tree - **nothing is ever lost to tree
surgery**. Multiple wikis ride the bucket switcher for free. Follow-ups the same day: deep-link
bucket correction, and drag-to-reorganize with native HTML5 DnD and no library - a row's top/bottom
half is insert-before/after, sections split 25/50/25 with a drop-INTO middle, and cross-section
moves **place FIRST then remove**, so a failure between the writes leaves a visible duplicate,
never a lost page. The server API was already drag-shaped, since member PUT was add-and-move from
the start.

**The everything-app (frankenstein, embraced).** The wiki tree extracted whole into `tree.js` and
became a feature flag like `tagColumn`; Notes claimed both, so it now runs tags, list, tree, and
editor side by side. Every column left of the editor is TUCKABLE - minimized to a slim vertical
rail - so the everything-app is only as monstrous as you choose (tuck state per app in prefs, same
home as seals and folds). Two coherence fixes behind the composition: "+ new item" also appends to
the tree root when a tree column exists (via a shared `ensureTreeRoot` dedupe, so list and tree
racing on a fresh bucket still mint ONE root), and with the unfiled bin hidden, deleting a section
re-places its pages at top level BEFORE the sections come down.

**File upload, in three phases.** *Phase 1* built the house modal - the app-window language as a
floating panel, pixel-cornered frame and Press-Start title band, but wearing the bold Quickbar
teal so a modal reads as the system stepping forward - plus three doors into it from the shared
Editor: a chip, a desktop drop (guarded on real Files, so internal row drags pass through), and a
pasted image buffer. *Phase 2* gave it an engine: each File POSTs via XHR (fetch can't report
upload progress) with a live progress bar, the 202's doc_id files into the current bucket
immediately (membership is doc-meta, version-independent), and the modal follows the job through
the ingest queue to done or failed. Mid-flight the name and tags are editable, and closing the
modal abandons nothing - the transcode lands server-side on its own. Names needed a server
addition, since the title is baked into the version when the worker CLAIMS the job: a retitle route
for still-`pending` jobs that returns `applied: false` when it arrives too late - honest, never
pretending. *Phase 3* planted the placeholder: all three doors route through `captureFiles`, which
puts `[uploading "name" …nonce]` at the CURSOR and swaps it for a real marquee embed when the
upload lands. The extension trick: the renderer's media-kind sniff is extension-based and the body
URL had none, so a decorative-filename route (`/docs/{doc_id}/body/{filename}` - name ignored, real
Content-Type authoritative and nosniff-pinned) lets references carry `.avif`/`.webm`/`.ogg`. A
failed upload removes its placeholder; a placeholder the user deleted by hand is respected.

**Upload field-test rounds.** (1) Past the job-title window the doc EXISTS, so rename should
retitle the record: a new `documents::retitle` primitive mints a version copying the display head's
content pointers verbatim - no bytes read or stored, blob reuse by construction - because the JSON
save route would clobber a media doc into text and this can't. (2) A PDF sailed all the way to the
server before dying with a codec-guts error; the modal now bounces non-media types kindly BEFORE a
byte moves, and the server's message leads with the human sentence. (3) "Daria S01E12.mp4" came out
the other end as an audio file, because the node speaks few video codecs and took the AAC track -
which motivated the next unit.

**Video uploads: the spike goes into service.** The video-ingest spike is wired in, and its whole
thesis is now live: a video re-encodes IN THE BROWSER, so the hostile decode happens in the
browser's hardened licensed decoder and the server only ever receives a normalized intermediary it
can decode in memory-safe Rust. Happy lane is AV1-in-WebM through the existing binary route;
fallback lane (browsers that can't encode AV1) is 320p APNG plus an Ogg Opus sidecar over
multipart, with the sidecar riding quarantine as a derived-path sibling (existence is the flag, no
schema change). The modal narrates honestly - an encoding phase with elapsed seconds and the
realtime caveat, the intermediary's size, a note when the fallback lane is working, a note when
undecodable audio forces video-only. Then a field-test refinement: a 21.6-minute clip hit the hard
150s duration refusal, which was guarding real memory (every kept frame is a 320p RGBA buffer held
until re-encode; the laundering doctrine forbids passthrough). So the frame budget **spreads** -
spacing stretches so the whole declared duration fits the frame cap - and a long talk arrives
sparser (~1.8 fps), never refused, never truncated.

**Uploaded files become full citizens.** The Reader now edits the RECORD around its read-only body
(editable title via the media-safe retitle route, plus tags) - **"read-only" is about the bytes,
not the filing**. Uploads in tree-having apps file into the tree root at upload time, and the wiki
mounts the shared RightColumn so a media page opens the Reader rather than a text editor that can't
hold it.

**Cozy addresses.** `/home/<bucket>/<section>/<section>/<slugified-title>` resolves to a document
by **DERIVED** addressing - computed from bucket names, section titles, and doc titles, with no
register to maintain. Deliberately NOT the plan's author-owned slug register (that's a publication
surface for the `ringtome://` face; this is the private working-form convenience, same spirit -
pointers, never authority - computed not curated). The rules, stated once: first segment is the app
id or slugified bucket, middles are section titles walked STRICTLY down the tree, last is the doc
title, a 32-hex tail is canonical, ties go to the lowest id, and when the strict walk misses a
bucket-wide title pass catches it - so a doc dragged to a new section keeps its old links working.
A copy-link chip falls back to the honest id tail when a slug would lose its own tie, so it never
hands out a link that resolves to someone else. Then, in a follow-up, cozy addresses became the
**RESTING form**: the flow reversed, so hex canonicalizes to cozy rather than the other way, the
shell reads cozy paths (a first segment that isn't an app id resolves as a bucket slug off the live
roster, and the header, switcher, and bucket all follow the URL), and a rename re-dresses the
address live.

**Drag a document into a document.** Rows from the list and tree drag into the editor and land as
links at the POINTER. The trick that made it small: the editing surfaces natively insert a drag's
`text/plain` at the drop point, so the drag itself carries the link markup and precision costs
nothing. Media docs carry their byte-URL embed; ordinary docs carry an id-form link valid the
moment it lands, with the cozy form computing in flight and the editor claiming the swap.

**The emoji table.** `:smile:` stayed literal - not a Marquee bug: its emoji socket is
embedder-supplied BY DESIGN, and Ringtome never supplied one. Now the gemoji dataset (1913 entries)
rides the shared profile, and since both renderers spread-merge the profile, every surface gets it
at once. Unknown slugs stay literal. ~51KB, accepted.

**App-shelf cleanup.** Blog and Book (the `soon` placeholders) came off the console; Wiki became
Wikibook and Notes became TurboNotes (ids, styles, routes, and bucket names unchanged - only labels
moved); shelf order is Persona, Journal, Recipes, Wikibook, TurboNotes, in console tiles and
quickbar hexes alike, since both read registry order.

**The journal takes images (but never shows the records).** The capture side extracted into a
shared `useUploadCapture` hook, which the journal's entry editor mounts. Two deliberate choices:
journal-borne media RECORDS file into TurboNotes' home bucket, not the journal's - findable as
documents there, embedded in the entry either way, since references are by id - and the stream
filter now requires TEXT format besides bucket membership, so the journal shows finished entries,
never loose image records.

---

## Reading from cache, and the pickers (2026-07-29)

**The read-your-cache layer.** Doc bodies and taxonomy trees now live in Dexie beside the streamed
rows that VOUCH for them: opening a document you've seen paints straight from disk, and the network
runs only when the stream says a new copy exists - the contract headers and annotations always had,
extended to the fetch-on-click surfaces. The freshness handshake: doc details are stamped with the
live row's `head:heads:diverged` trio (the exact fingerprint the divergence lookout watches, so
cached save-parents are as trustworthy as a fetch under the same row), while trees are stamped with
the whole taxonomy-roster fingerprint (coarse on purpose - trees span taxonomies and the roster is
the only streamed signal). **Null bodies are never remembered** - the waiting room keeps asking the
node. Race stamps self-heal: a mid-race stamp mismatches on the next tick and forces one honest
refetch.

**The anti-jitter: one route for every document path.** Clicking a page with a taxonomy path
jittered the whole structure, because a 3+ segment cozy address fell out of the per-app route
pattern - the Router unmounted the app and remounted it from scratch. Fix: the per-app routes are
GONE, and SlugRoute is now the ONE renderer for every document-app path - bare app, hex, slug, deep
cozy alike. preact-iso marks a route change only when the component TYPE changes, so all doc
navigation reconciles a single mounted component and the list, tags, tree, and widths hold still.
Doc apps are keyed by app id, so the same app reconciles while switching apps remounts
deliberately. The editor still remounts per document, keyed **by design** - a fresh save session
per doc is the never-lose-words guarantee - and it's now fed from the doc cache, so it's a rebuild,
not a fetch.

**The flash-back race.** Clicking a tree page sometimes flashed BACK to the previous document: a
hex URL painted doc B synchronously, the cozy re-dress moved the URL to B's deep form, the sync hit
went null, and the fallback reached for the freshest ASYNC resolution - which was still doc A's.
Fix: async resolutions are tagged with the path they answered (and ignored at RENDER, not just at
set), and the fallback is the last actually-PAINTED view. Mid-flight you keep seeing exactly what
you last saw.

**Arrow-key navigation.** Left/right walk the prev/next order in TurboNotes, Recipes, and the
Wikibook - but only while the keyboard is FREE: any focused input, textarea, or editor keeps the
arrows for the caret, and modifier combos pass through. With nothing selected, right opens the
first document and left the last: the book falls open at either cover.

**Caret pickers, the trio.** The contextual-helper system, riding CodeMirror's own autocompletion
through a new `completions` prop:

- **`:` emoji** - a searchable picker at the caret over all 1913 gemoji names (the same table the
  renderer resolves), arrows plus Enter filling the whole `:slug:` tag and rendering immediately.
  Escape or just typing past waves it off; the picker never blocks a key.
- **`[` links** - the CURRENT BUCKET's documents, read live off the mirror per pop. Picking fills
  the whole `[title](link)` tag: id-form immediately (always valid), dressed in its cozy address
  the moment it computes - the drag-a-document swap, reused. The match region starts after the
  bracket so titles filter cleanly, and typing your own closing `]` folds the picker away, so a
  hand-written link is never interfered with.
- **`!` media** - the bucket's media, filling the whole `![title](…/body/name.ext)` embed, the same
  byte-URL form uploads and drags write, so media renders inline immediately. The link picker
  learned to step aside when `[` follows `!`, since the embed opener belongs to media. The
  journal's `!` searches TurboNotes' home, where journal-borne media records actually live.

## The doctrine day: lanes, pairs, and the retirement that vanished (2026-07-30)

A design-review conversation ("what makes a friend?") pulled one thread and re-wove three
sections of the plan, then walked into shipped code and found a real hole. No feature work; one
protocol-adjacent bug fix and a doctrine restructure, all in PROJECT_PLAN unless noted.

**Groups moved off the epoch machinery.** The sketch's tortured half was minted secrecy - every
membership change had to mint a key while every membership *fact* was merely computed. Settled:
**a group is an identity for its public face and a roster for everything else** - group content
is plaintext on a **member lane**, served only against member proofs (confidentiality by
refusal, not mathematics), the roster is the ACL (plaintext, member-only, never published), and
governance is the **invite tree** over members' own keys (rank-path pointed at a different
tree), the group's own key tree demoted to its public voice. Supergroups nest now - gated access
is a predicate, and predicates compose. The honest costs are stated in place: fail-open serving
surfaces, member-lane blobs needing a gate the blob transport doesn't have (the File Layer's
"ungated because the hash is the boundary" names its premise now), and operator moderation
surface. "Public Means Public" grew the three-lane statement: sealed / member-gated / public,
always a property of the service slot, never a bit (Copy, Don't Flip).

**DMs are the sealed pair.** Two is not an arbitrary cut: it is the only size at which
membership is not a mutable object - a pair has no roster, no admission, no ejection, and its
membership changes only through identity events the shipped machinery already handles. A DM is
two chains interleaved at read; the key is an epoch scoped to two; you cannot add a third person
- doing it *mints a room*, a copy-don't-flip ceremony. The Inbound Gate (Trust section) now
states the one predicate DMs, follow receipts, and group invites all pass: above your floor and
not muted - anti-spam, explicitly not anti-safety.

**The Adult In The Room audit hit shipped code.** Re-reading the sketch's defect list against
the implementation found the minter rule violated live (a self-retiring key minted the epoch
excluding itself) and, worse, **self-retirement did not survive sync at all**: a revoke can
never anchor itself, so it sits beyond its own seal - one seq past it when the chain had
history, or as an anchorless chain's *only* entry (the adopted-leaf shape the API actually
produces) - and the gate's seal-or-nothing refusal dropped it both ways. A peer resolved
Retired in passing, stored nothing, and un-retired the key on the next resolve: the exact
dumpster-diver attack retirement exists to stop. Fix: `Crown::revocation_of` (proto) names the
credited revoke - one source of truth, competing forked revokes already settled by resolution -
and the gate keeps exactly that entry in both shapes (`admit_ceilinged_chain` carve-out +
founding-entry arm). The minter rule is enforced (self-retirement defers rotation; `rotate_epoch`
refuses a signer that is its own exclude). Tests at all three levels: proto (phantom-beyond-seal,
forked competing retirements converge on one credited revoke, anchorless first-entry), gate
(both shapes stored, dumpster continuation refused from the stored set alone; planted red before
fix), integration (real two-node self-retirement persists across syncs).

**Doctrine caught up with its own findings.** Repudiation's blast radius generalized to every
authority-conferring statement (the sketch's item 4, fixed at the source); retirement is
senior-issuable and the UI will prefer that path; **Exit examined and declined** - its group
consumer dissolved with the member lane, and the remainder composes from existing verbs (a
repudiation anchored at the current heads distrusts nothing and kills the subtree; a
self-issued exit is retire-plus-repudiate-each-child, complete because a key's children all
live on its own chain); the standing principle stated: friendly departures are self-service,
hostile ones need a senior. Private
Chains gained the **Rotation rules**: recipients verified never asserted (smuggle = refusal,
omission = loud flag + re-seal), any Active member may mint a missing rotation ("rank orders the
delay, never the right" - seniormost-surviving is unknowable and doesn't need to be known),
concurrent mints converge by (minter rank, entry hash) with readers trying keys in the same
order. Residuals ledgered in REFACTOR.md: the liveness watcher (owed - self-retirement currently
never rotates) and `key-epoch` recipient verification, paired.

## The trash icon: removal comes to the Computers screen (2026-07-30)

The key tree's exits, in cozy clothing. Every row of "your computers" whose removal this node
has authority over grows a quiet trash affordance; the flow behind it is the removal ceremony,
two doors with deliberately different *agency* (not just severity): "**have this computer
leave**" - gentle, voluntary, everything it wrote stays good and its invitees stay - versus
"**lock this computer out**" - forceful, its invitees shut out with it. On your own row the
voluntary door reads "**leave this persona**." Locking out asks the one question that decides
the record - *was this computer you?* - "it was me, until now" (anchored cut, history stands)
or "it was never me" (genesis cut, everything it ever signed is struck). Status chips: "left"
and "locked out."

The plumbing under it: the keys response carries a per-key `removal` capability ("self" |
"senior") decided by the crown server-side - the client never re-derives authority, it only
shows consequences (the lock-out confirm lists the blast radius via `pure/removal.js`, and
every terminal screen echoes the fingerprint, names being pointers). The revoke route gained
the `cut` parameter ("now" default | "genesis", repudiation-only, retirement+genesis is a
400 because a retirement IS the honoring of history). The genesis cut is made real by a new
gate sweep: a quarantined key's stored chains that no revocation anchored are uncredited -
the gate already refused them as arrivals - so they are evicted and the views rebuilt, on the
revoking node immediately (the revoke route pushes an empty batch through the ordinary gate:
one sweeper, no second code path) and on every other node as the revocation syncs in.
Integration proves the round trip: the impostor's profile write is struck from the revoker's
record at once and from the impostor's own node after its next sync.

## The panel that wouldn't die, and the gate it bought (2026-07-30)

A drive-by report - "each new directory spawns a whole new panel that never cleans up" - turned
out to be a one-word bug with a lesson attached. The refactor that gave apps per-item nouns
made `itemNoun` a WikiTree prop but left one use inside SectionNode, a sibling component where
the name resolves to nothing. Sections only render once one exists, so the tree worked
perfectly until the user created their first directory - then every render threw
`ReferenceError`, and with no error boundary each render aborted mid-diff, orphaning
partially-committed DOM: app panels piling up, unkillable, because the unmount diff died on
the same throw. Server data was provably clean; the bug lived entirely in the render pass.

Two pieces of tooling came out of the hunt:

- **eslint joins `ui-check`** (`node/js/eslint.config.js`): esbuild cannot tell a typo from a
  browser global, so an undefined identifier ships silently - `no-undef` at error level is the
  gate (planted a violation, watched it go red). The react-hooks rules opened at *warn* with
  13 findings and were paid down to zero the same day - the headline was doc/editor.js, six
  hooks below two `!loaded` early returns (a hook list that grew once the doc loaded, correct
  only by accident of monotonic growth): every hook now sits above the returns, their guards
  carrying the not-yet-loaded case, `modesFor`/`defaultMode` being total making the hoist
  safe. The rest were split between real fixes (a `useCallback`, extracted dep expressions)
  and deliberate partial deps annotated with their reasons (the save-flush cleanup reads its
  ref at teardown time ON PURPOSE; turbolinks' `gen` counter IS the change signal for a map
  mutated in place). Both rules now run at *error* - the cop gates.
- **The headless harness** (`node/harness/drive.mjs`): the real bundle in jsdom against a
  throwaway node - browser-global stubs, a cookie-jar fetch bridge, API pre-provisioning that
  skips the onboarding ceremony - which reproduced the exact symptom, confirmed the fix, and
  proved clean app-switch teardown. A debugging instrument, not a test suite: STYLE's
  no-automated-UI-testing rule stands, and the scenario half is disposable by design. Kept
  because the bug class it catches - rendering failures only a running SPA exhibits - is
  exactly the class every other gate leaves dark.

## The quickbar with nobody behind it (2026-07-30)

Second field catch of the evening, and the harness's first same-day repro: after a one-trip
adoption, the NEW computer's tab showed only the quickbar. The arrival watcher (persona.js)
cleared the join state and THEN awaited the async `open` - and any render in that window was
still in state 'join' with a null join, so JoinFlow threw on `join.requestCode` and took the
whole tree down with it (no error boundary; the same corrupted-DOM class as the tree-pane
panels). Fix: open first, clear after - in the watcher and in `completeJoin` alike - plus a
render guard in JoinFlow, because a transitional frame rendering nothing beats a crash.
`harness/join.mjs` (promoted) drives the real NullState -> join -> grant -> arrival path and
proves the tab lands on the open console within one poll tick.
