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

## The farewell: a revoked node learns to let go (2026-07-31)

Field report: a revoked computer's UI carried on as if nothing had happened - a read-only
ghost town where every save silently bounced at other nodes' gates (and, since the suffix
sweep, evaporated locally on the next sync). The node HELD the fact of its own revocation the
whole time - its gate had ingested the revocation and resolved the tree - it just never looked.

Now it looks, at three layers. **Standing**: the persona list annotates each identity with
this node's own leaf status, computed from the local crown. **Refusal**: `imaol::append` - the
one place every locally-authored entry passes - refuses when the local tree says the signer is
revoked (403, stable `code: "revoked-signer"`; the `Db` handle now knows its root, which is
what lets the deepest layer ask an identity-scoped question). Unknown stays allowed on
purpose: genesis and a just-adopted leaf both write before the tree can know them. **The
farewell**: discovery at persona load or the moment a live tab's write bounces (net.js
announces the code; persona.js listens), then a plain goodbye in the Computers screen's own
vocabulary - "this computer has been locked out" / "has left the persona" - and one button
that detaches (node-local unlink; the persona lives on everywhere else) and returns the node
to "nobody lives here". Multi-persona ready: the list opens the first ACTIVE persona, so a
future node agenting several simply drops the defunct one. Residuals ledgered: detach leaves
the files on disk, and a passively-reading tab learns only at boot or on a failed write.

## Sidebar thumbnails, and the harness grows a real stream (2026-07-31)

**The feature:** media rows in the notes-family sidebar wear a 32px thumbnail where text rows
wear their format glyph - `media.has_thumb` was already on every summary and `/thumb` already
served the display head's AVIF, so the whole feature is a row-level `<img>` with the honest
edges handled: the URL is version-keyed (`/thumb?v=<head>`), which let the endpoint turn on
`immutable` caching (fifty media rows cost fifty requests once, then none), a 404 for a
not-yet-fetched blob hides the image rather than showing the broken-glyph (the next mirror
refresh retries), and `loading="lazy"` keeps long lists cheap.

**The instrument:** proving it surfaced a harness gap - the notes list is a pure-mirror
surface, and the harness's WebSocket stub starved the mirror, so the first probe rendered an
empty list. The stubs had also quietly become four drifting copies. Both findings resolve
into `harness/boot.mjs`: the shared session jar, the jsdom boot, and a REAL WebSocket bridge
(npm `ws`, session cookie riding along) - the live-cache stream and Dexie mirror now run for
real under the harness, and every scenario script (drive, ui, join, state, and the new
`thumbs.mjs` media probe) is a thin import of it. All five verified against live nodes after
the refactor.

## The kind dial: search grows its options dropdown (2026-07-31)

A funnel button beside the search box opens the search-options dropdown - the socket future
options plug into - holding, for now, exactly one dial: a button rotating **all files / only
documents / only media**, an extra filter over the documents-app lists (TurboNotes and
Recipes both, via the shared DocsApp). The predicate and rotation live in pure/doclist.js
(`kind` is a fourth `orderDocs` filter beside bucket/hits/tags, with vectors; an unknown kind
means "all" rather than an empty list), the dial narrows the tag cloud the same way a query
does, the funnel tints while the dial is off "all" so a filtered list never looks
mysteriously short, and the state rides the search lifecycle - cleared on app switch, so a
filter set in Recipes can't silently empty TurboNotes. The dial reaches the TREE too (the
wiki, and TurboNotes' tree column), riding the exact rail search already built: pages filter,
sections stay as scaffolding - a directory empties, never vanishes - and a page whose facts
aren't held locally passes rather than hiding. The journal shows no funnel at all: day
entries are always prose, and a knob that does nothing is worse than no knob. Verified in the
real UI by the harness's media probe: a real image beside a text note, filed into a tree
section - rotate the dial, the list and tree pages narrow at each stop, the section count
never moves.

## All Documents: the everything-view (2026-07-31)

The resolution to "where did my files go": a new app, last on the dock, showing every document
from every notebook PLUS the unbucketed - the one surface where nothing can be orphaned out of
sight (a repudiation striking a bucket's definition relocates documents; here they remain
findable). Registry-wise it is an app with `everything: true` and no `style`: it owns no
bucket type, mints no implicit bucket, shows no bucket switcher, and `bucketHolds`
short-circuits to yes - one flag, and the whole documents skeleton (search, the kind dial,
descriptions, dates) just works on it. A browsing surface, not a making one: no new-thing
button (creation belongs to real apps; stray editor-drop writes land in the default app's
home), no tree, no tag column.

Its rows carry the finding aids: the notebook name(s) that hold each file ("unfiled" when
none), 64px thumbnails (double the sidebar's - browsing media is half the job), and
**follow me home** - a path-icon button routing to the document's official app
(`homeAppFor`: first bucket's type via the roster; unbucketed to the default app), where the
existing deep-link correction picks the right notebook and the cozy re-dress settles the true
address. URLs live in their own `/home/all/<id>` namespace and never re-dress - one document
shows in many places, but an /all link always means the everything-view. Field-verified by
the harness probe: bucket labels, big thumbs, the stable /all URL, and a follow-me-home that
landed on `/home/shots/bowie` - the official cozy address, minted by machinery that predates
the feature.

## Copyable, pasteable, portable: the byte-URL round trip (2026-07-31)

Field report: copy an image's address out of the reader, paste it into a document as
`![](url)`, nothing renders. Two defects hiding in one papercut. First, the reader was the
one surface handing out the BARE `/body` URL - and the marquee embed parser is pure and
synchronous, so it classifies embeds by sniffing the URL's extension; the bare form serves
the bytes fine and can never render. The reader now renders (and therefore copy-address now
yields) the decorated form via `decoratedBodyUrl` - extension derived from the document's own
format, title as decoration - so the round trip works. Second, the copied URL was ABSOLUTE
(`http://localhost:5281/...`): correct today, wrong the moment the persona is read anywhere
else. Now every editing surface relativizes pasted self-URLs at paste time (never at save
time, where a rewrite would move text under the cursor): CodeMirror's clipboardInputFilter on
the interactive surface (which the journal shares), a text-only onPaste on the editor's
textarea modes that lets file pastes fall through to the upload capture. The self-test is
`location.origin` - complete because the SPA only ever talks to the node that served it; a
URL copied under one of the node's OTHER names passes through untouched, the honest boundary.
`pure/portable.js` holds the transform and its vectors. The full ingest-on-embed machinery
(external URLs baked into local blobs) remains 4M's, as planned - a same-node reference needs
no ingest, just a relative path.

## The scheme dissolves: the path is the address, the origin is the lens (2026-07-31)

The `ringtome://` URL scheme - a designed-ahead section of the plan since the early days -
examined and dissolved, exit-disposition style. Three reasons had each quietly become
decisive: the packaging doctrine (one client carried by the web, local server + system
browser, never a native shell) forecloses the only program that could ever register the
scheme handler, so `ringtome://` was the link that doesn't open; months of building had voted
with their feet, every reference every feature actually mints being an identity-rooted HTTP
path (the scheme appeared in exactly one code comment); and the just-minted-QR niche its hint
slots served best already belongs to the `rt1.` codes, whose consumers are nodes - which is
who hints are for.

Everything load-bearing survives, re-homed as ordinary URL parts: **authority rides the path**
(the root, self-certifying, chain-to-root-or-discard), **provenance and first contact ride
the origin** (which, unlike the old `nodeID` slot, is clickable - a naive browser reads
through that node's public face, a ringtome-aware consumer re-homes the path at its own
lens), **reachability rides `?via=` keys** (never addresses, never trusted). The resolution
ladder is unchanged - it just becomes what a node does when asked for a root it doesn't hold,
4S consuming M3.5's directory - and graceful degradation becomes "a URL degrades to its
path": strip a dead origin and the always-correct part remains, bootstrap included. The
doctrine sentence the built system had been implying all along, now stated: the path is the
address; the origin is the lens.

## The cap is a promise, not a target (2026-07-31)

Field bug: long audio uploads landed a few percent OVER the byte cap instead of under it.
The fit-to-cap estimator spent the entire budget on the raw bitstream - `cap * 8000 /
duration` - budgeting nothing for the Ogg container (one page per second: 27-byte header +
a lacing byte per packet ≈ 616 bps, a full 5% of the stream at the 12 kbps floor, which is
why the longest files overshot worst) and nothing for VBR variance (the requested rate is an
average target libopus lands AROUND, not under). And no size check after the mux: the
overshoot sailed out of the crush and died downstream at the document cap.

Fixed at both layers. The estimator now subtracts the container's per-second cost and spends
97% of what remains (`OGG_OVERHEAD_BPS`, `VBR_HEADROOM_PCT`), with the duration ceiling
tightened to match (~116 → ~107 minutes at the default cap - the honest number once the box
is priced in). And the encode lane became a loop: on the rare remaining overshoot, re-encode
a step lower scaled by the observed excess; only a floor-rate encode that still overflows is
TooLong. ≤ cap is now true by construction, and the test suite says so: the old test's
"fits ~cap" 10% grace clause - the bug's confession, in an assertion - tightened to a hard
≤, plus a near-floor worst-case vector planted-red against the old formula.

## The meter and the line: ingest grows honest progress (2026-07-31)

Field report: audio and video processing takes long enough that a spinner reads as "broken".
Now every stage of an upload's life reports. **The line**: the jobs endpoint annotates pending
jobs with their position in the node's WHOLE queue (other accounts included - "3 ahead of it"
is only honest on a shared node), rendered as "next up…" / "N ahead of it…". **The server
meter**: the crush lanes gained a progress callback (`media::Progress`) - audio reports
through its decode loop (frames done over frames expected), video per encoded frame from the
AV1 chunk threads (Sync by necessity) and the APNG stitcher alike - feeding an in-memory
job_id->percent map on `Ingest` that the jobs endpoint joins in (ephemeral on purpose: a
reboot honestly resets the bar). All meters cap at 99: "done" is the row's word, never the
estimator's. **The browser meter**: the video-ingest spike's lanes take `onProgress` - the
AV1 lane's real-time playback tap IS the meter (currentTime/duration), the frames lane
reports per extracted frame - and the upload modal shows the bar under the existing elapsed
readout. Verified live: three racing uploads showed positions 0/1/2 shrinking as the queue
drained and each processing meter climbing 0→92 in order. The browser-encode path is
jsdom-unprobeable (no MediaRecorder there) - an event listener and a loop callback, verified
by read and lint.

## The repudiation compact: what documents do after the strike (2026-07-31)

Field report: "a complex history, then repudiated a device to the nub - it FELT like some
stuff may have been lost, but I didn't keep good track going in." The new
`integration/test/repudiation.cjs` IS the good track, kept permanently: it builds one
composite world - five documents with interleaved authorship (A-only, B-only, A→B→A linear,
B-created-A-improved, a live divergence), buckets and filings and tags from both devices, a
taxonomy tree with a section and a placement from each - strikes B with the genesis cut, and
asserts the entire surviving shape on BOTH nodes, plus rebuild-from-journal invariance and a
no-document-resolves-empty sweep. Every behavior held on the first run: A's ends of a linear
chain survive as a two-head conflict around B's dangling middle; a B-created doc survives AS
A's improvement; a live divergence RESOLVES when the other branch was the impostor's; A's
placement of B's dead doc degrades to a dangling reference; and a document only B ever
touched vanishes entirely - pinned explicitly as the CORRECT loss, so the next person who
feels like something went missing can read exactly what was supposed to. The now-cut
companion pins the contrast: everything synced before the strike survives whole; the cut
closes the future, not the past.

## Strays move out: the everything-view becomes the one home for the unfiled (2026-08-01)

"Wait, unbucketed files end up in TurboNotes?" They did - a deliberate pre-All catch-all in
`bucketHolds` ("something has to hold them"), which quietly mingled strike-orphans and script
strays into someone's actual home notebook, indistinguishable from things they filed there.
With All shipped as the formal home for the unfiled, the clause retired: membership IS the
rule now, a notebook shows what's in it, and the unbucketed appear only in the
everything-view, labeled "unfiled". Follow-me-home agrees: an unbucketed document's official
home is All itself. The sweep also caught the rule's SECOND copy - the link and media pickers
each carried their own membership filter and one had drifted (the media picker still had the
catch-all clause; the classic second-copy finding) - both now share one `inBucket`. Vectors
updated to pin the new law; field-verified: a never-filed stray appears nowhere in TurboNotes'
home and exactly once in All.

## Journal attachments come home (2026-08-01)

The other half of the teleporting-image mystery: journal attachments were DELIBERATELY filed
into TurboNotes' home ("findable as documents"), a decision documented only where users can't
read it - a code comment - and experienced as documents materializing in the wrong app. Now
they file into the journal's OWN bucket: attachments live with their journal, the stream stays
clean because daybook's `isEntry` format test already kept media records out (its comment now
records that the test is load-bearing rather than defensive), and the records are findable in
the everything-view labeled with their journal's name. The `!` media picker follows: it offers
the journal's own attachments, not TurboNotes'. Verified live across all three surfaces: the
journal shows the entry and not the record, All shows both labeled `journal`, TurboNotes shows
neither.

## Two nodes, one browser, one cookie jar (2026-08-01)

Field report confirmed as diagnosed: logging into localhost:5281 logged the user out of
localhost:5282, because browsers scope cookies by HOST alone - never by port - so the two
nodes fought over a single `ringtome_session` cookie on the shared `localhost` jar. The fix
puts the port where the browser refuses to: in the cookie's NAME
(`ringtome_session_<port>`), so each node reads and writes only its own and the jars coexist.
Proven with a browser-faithful shared jar: log into A, log into B, and A's session survives -
`ringtome_session_5297` and `ringtome_session_5296` side by side where one clobbered the
other before. Sessions in dev browsers invalidate once (the cookie was renamed); log in again.

## The date field stays native (2026-08-01)

Examined and declined: replacing the claimed-date control's native `<input type="date">` with
a yyyy/mm/dd text field. The mm/dd/yyyy it shows is not our formatting - the native widget
renders in the BROWSER'S locale and ignores everything the page says about format - and a
first pass traded the widget for a text field that owned the dialect. Walked back the same
day: locale-awareness is the superior design (right rendering for every locale, calendar
pop-up, mobile keyboards, accessibility, zero code we own), and the display order is properly
the reader's machine's business, not the app's. Anyone who wants ISO order sets their OS
region format to one that renders it. The stored form was ISO throughout and never moved.

## "Hello!" is not a donut (2026-08-01)

The media picker popped on a bare `!` anywhere in the text, and Enter with a picker open
ACCEPTS - so typing "Hello!" and pressing Enter for a new line embedded the top media match
instead. A bare `!` is ordinary punctuation nearly everywhere; it now only means "media" at
the start of a line (leading whitespace allowed). The explicit `![` opener still pops
anywhere, because typing markdown's own embed syntax is never an accident. One guard in
`mediaCompletions` (doc/completions.js); the `:` emoji and `[` link pickers are untouched -
their trigger characters don't end sentences.

## One bracket, two grammars (2026-08-01)

A `[` legitimately opens either a link or one of Marquee's inline span tags, and only what
you type next says which - but the editor's `[` picker only knew the link half. It now
offers both: the bucket's documents as before, plus the spec's closed span vocabulary
(rainbow, wave, spoiler, typewriter, the size rungs, the note synonyms - 24 names), marked
apart in the detail column. Picking a tag fills the whole `[tag][/tag]` pair with the cursor
between; the three value tags fill `[tag=][/tag]` with the cursor after the `=`. The
vocabulary is a HARDCODED transcription (SPAN_TAGS in doc/completions.js) of the span switch
in marquee-html-renderer - deliberate for now; upstreaming an exported list from the Marquee
packages is the durable home, and drift meanwhile costs a completion, nothing else.

## The bracket that poisoned the line (2026-08-01)

Field report: "[sid unfolds, [rai doesn't." Not the letters - the LINE. The `[` picker's
match region (`\[[^\]\n]*$`) let `[` inside its interior class, so it anchored at the FIRST
unclosed bracket before the caret: one stray `[` earlier in the line and every later `[`
filtered on garbage (" b [rai") that matched nothing, so the picker silently refused the
rest of the line. Excluding `[` from the interior (match region and validFor both, and the
media picker's `![` branch to match) anchors at the LAST bracket - a fresh `[` restarts the
picker instead of feeding the old one. Found with a new harness probe, `harness/pickers.mjs`
(boot the SPA, type into the real CodeMirror char by char, dump the tooltip per keystroke) -
the machinery passed every isolated test; only the whole app running showed it, which is
exactly the bug class the harness doctrine exists for. The probe stays in the family.

## The empty pair that ate its own insertion (2026-08-01)

The tag picker's second field failure, and the real one: Enter and click both dead for every
EFFECT tag while the tooltip sat there open. The accept ran fine - and the transaction it
dispatched was killed by the live preview: marquee-codemirror's plan() lays an animated
effect's mq-* MARK over the span's content, an empty `[rainbow][/rainbow]` has no content to
cover, and "Mark decorations may not be empty" aborted the very insertion that created it.
Hence the pattern: sidenote completed (a note-ref WIDGET, no mark) while rainbow/fadein
refused (marks). The fill now inserts `[wave]text[/wave]` with the placeholder selected (next
keystroke replaces it; value tags park the cursor after the `=` instead) - never-empty by
construction, and a visible affordance besides. Upstream half ledgered in NEXT_STEPS:
hand-typing an empty pair still bricks the closing `]` until plan() skips empty inline spans.
Diagnosed end-to-end with harness/pickers.mjs probes - the tooltip DOM said "open, selected",
the keydown said "unhandled", and the uncaught RangeError between them told the story.

## The conflict that spoke two dialects (2026-08-01)

Field report: a Marquee merge conflict came out half-dressed - `:::conflict` scaffolding on
the first half, raw `=======`/`>>>>>>>` on the second. Root cause: the two-head Marquee
presentation re-parsed diffy's marked TEXT with a line state machine, and a content line
that merely LOOKS like a marker inside a disputed hunk (your own `=======` underline, or
markers a criss-cross virtual base let surface) is undecidable from the text - the machine
switched sides at the lookalike, and the real separator fell through as literal git syntax.
The fix deletes the state machine: two-head Marquee conflicts now render from merge
STRUCTURE via `align_heads` + `render_segments`, the same engine the N-way path has trusted
since 2026-07-25 - lookalike lines are just content there, and the misparse is impossible by
construction, not by cleverness. Plaintext keeps diffy's marked output verbatim (markers ARE
its vocabulary; the ambiguity is git's own native hazard). Violation planted:
`marker_lookalike_content_inside_a_hunk_stays_content` failed against the old code with the
field symptom reproduced verbatim, passes now; every previously-pinned conflict shape
(two-head, N-way, criss-cross, per-hunk boundaries) survived the engine swap untouched.
Also swept while lint was red: the orphaned no-progress `crush` wrapper is `#[cfg(test)]`
now (production always wants the meter), and audio's `encode_pass` returns a named
`EncodedPass` instead of a four-way tuple.

## Lanes: the member lane grows up (2026-08-01)

Doctrine amendment, no code: the chain classes are now a settled triad - PUBLIC (plaintext,
served to anyone), GATED (plaintext, served behind a predicate), PRIVATE (epoch ciphertext,
the identity's own leaves) - written up in PROJECT_PLAN (IM-AOL, "Lanes: Public, Gated,
Private"). The gated lane is the groups member lane PROMOTED to an identity-generic class:
gated access is a predicate and predicates compose, so roster membership, disclosed-mutual-
follow friendship, and one-hop supergroup proofs are instances of one gate, not three
features. "Public is public" generalizes to "shared is shared" (gating is disclosure control
plus enumeration resistance, never secrecy; revocation closes the future only), and
"unlisted" in the capability-URL sense was considered and explicitly does not exist. Three
promissory notes ledgered in NEXT_STEPS before any consumer is built: per-service lane
declaration, the friendship predicate's staleness bound, and the blob gate built once,
predicate-parameterized. Set up by the session's next-steps discussion: relationships before
publication, per the recommended route - the bottom rungs (tokens, quiet follows, receipts)
unlock friends-gated serving without waiting for groups.

## NEXT_STEPS remembers what it's for (2026-08-01)

A cleanup pass on NEXT_STEPS.md, which had drifted into a changelog: the "Where we are" section
held ~sixty multi-line delivery reports (the file's own preamble says "finished work leaves
this file - one line below, full report in HISTORY"), one residual was a full shipped report,
and the tier descriptions still described the delivered client track as future work - which is
why the supply of next steps FELT dwindling: the real ones were buried. The rewrite: the ledger
compressed to one line per era; a new "The route from here" section up top carrying the
2026-08-01 decision (relationships before publication - admission/tokens → quiet follows →
receipts → public serving + the publication act → friends-gated serving) plus the rough-edge
triage; tier statuses updated (4C delivered in substance with its named tail, 4M substantially
delivered as Marquee with the Ringtome-side remainder, 4S the main course); accessibility added
to the standing disciplines; localization to "deliberately not yet."

Closed with the pass: the **PrivatePlain size-cap** residual - its own close condition
("confirm when the blob lane lands") has been met since the file layer shipped: bodies ride
blobs, inline records stay small, the caps are correct as-is.

Preserved here because it lived only in the trimmed entry - **the federated search bloom
sketch (2026-07-25)**, from Curtis's log-search engine (subtoken bloom filters over
hierarchical blocks): blooms are mediocre as an index of record at document granularity
(word-exact kills type-ahead; short prefixes match everything; false positives read as bugs)
but excellent as a PRE-FILTER - if 4S search ever reaches across identities, a small
per-identity/per-collection summary bloom (one-way by construction, cheap to sync) narrows
"which of the fifty identities I follow might mention this" to a handful worth querying
properly. Blocks reassigned from hours to identities; the local index stays a token bag, where
localhost bandwidth is free.

## The /id endpoint designs itself (2026-08-01)

A three-message design conversation that turned out to be settling 4S's front door, now
canon. The pieces, in the order they fell: **the prefix got its name** - the Addressing
template's elided `…` is the literal `/id/`, identical on every node so re-homing stays
mechanical, with the SPA served there and the SESSION as the lens (the person page is the one
place the address bar is legitimately shareable as-is; `/home` stays identity-free and the
console's people surface is a rolodex that navigates OUT to `/id/<root>`). **The gateway went
default-on** - the dual-opt-in Web Gateway role was judged overwrought by Public Means
Public's own argument, replaced by three rungs with a sharp line: serve the SHELF (hosted +
member-followed, the accountable demand edges, disclaimer on not-hosted-here), SIGNPOST the
reachable (metadata only, never bytes - via hints + serving records, which now carry a
web-faced node's public HTTPS URL; a road sign, not a rehost), and TOMBSTONE warmly (the
irreducible residue: content nobody chose to put on the web - honest, and dissolved
per-identity by one web-faced help-host). Authenticated members get temporary fetch-and-serve
for off-shelf roots; the anonymous shelf grows only through durable demand, never one
member's curiosity. Author opt-in flipped to opt-out courtesy; foreign-media scanning stays
fail-closed and hardened headers move into the default build; the curated gateway survives as
the "magazine" tier. Ruling recorded with its own caveat: not safety-forward, chosen for
early usefulness, dials adjustable later. NEXT_STEPS declares the /id endpoint the next unit.

## The persona learns its address (2026-08-01)

First brick of the /id unit: /home/persona now shows "your address" - the persona's shareable
identity URL, minted per the fresh Addressing doctrine. The origin comes from
`RINGTOME_PUBLIC_URL` (new operator env var, trimmed once at config load, surfaced to the
client through `/api/config`'s PublicConfig) and NOWHERE else - never window.location, whose
origin (localhost, a LAN name, a tailnet alias) proves nothing about what the world can dial.
Declared URL → `https://my-node.ca/id/<root>?via=<node-key>`; none → the origin-free path
form with an honest hint ("this computer has no public web address - other ringtome folk can
still open it from their own node"). The `?via=` hint is this node's endpoint key, read from
the existing `/api/node`. Minting lives beside its mirror image: `identityAddress` joins
`stripSelfOrigin` in pure/portable.js (the origin-handling module - one strips origins on the
way in, the other grants them on the way out), with vectors. Copy is the whole interaction
for now - the /id surface itself is the next brick, so the link is a thing you give away, not
yet a place you go. Field-verified through the harness on both node shapes.

## The speakable identicon (2026-08-01)

Roots learned to say their name: `sway-broke-AwTyvw9SPjfiJ4xvMfwDKZeHQH6N1mw3LQtoYtJNPfqU` -
two checksum words (blake3's first two 4-byte windows, mod 1,296 into the pinned EFF short
wordlist) and the key in base58btc (0OIl dropped; this string exists to survive handwriting).
Canon in PROJECT_PLAN (Naming, "The Speakable Identicon"): the grammar accepts worded, bare
base58, and the hex escape hatch; a checksum mismatch REFUSES loudly with the true words in
hand; 21 bits is recognition, never authority (a colliding pair costs an attacker minutes -
words join the pointers-never-authority family). The wordlist is a wire format - words are
addressed by index, so the list froze at pin time (one amendment: the hyphen-bearing "yo-yo"
slot became "yonder"; "yoyo" was already taken two lines down, which the vectors now pin).
Twinned implementation - js/speakable.js + src/speakable.rs - held bit-compatible by shared
goldens, the entry-format vector discipline at miniature scale; `ringtome inspect` prints the
speakable form beside every author key (its first Rust consumer), and the persona address row
now mints `https://my-node.ca/id/frisk-carol-4a8W…?via=…` (field-verified). One sanctum
lesson: speakable.js lives OUTSIDE pure/ - blake3 is an import, and the pure zone admits
none; the conventions test caught the breach and the module moved rather than the rule.

## The address learns who else carries it (2026-08-01)

`?via=` grew from one hint to the doctrine's real shape: this node's endpoint key first (the
one provably alive - it served the page), then the persona's liveliest known peers, capped
at three. New pieces: `liveliest_peers` in net/sync.rs (identity_peers ordered by
last_synced_ms, never-synced last - the "biased toward nodes online at production time"
signal the Addressing section asked for), a session-gated `GET /api/identity/{root}/peers`,
and `viaHints` in pure/portable.js carrying the cap and the self-first/dedupe rule with
vectors (the cap is the plan's Costs ruling: a URL that is mostly hints stops being a thing
you'd paste in a bio). Peers are gravy in the address hook - a one-computer persona or a
failed fetch never costs the row its self-hint. Field-verified over a real adoption: alpha
mints `https://alpha.example/id/water-mull-…?via=<alpha>,<bravo>`, bravo mints the path form
with the same hints reversed - one persona, two lenses, each address warm-starting at either
computer.

## The /id endpoint opens its doors (2026-08-01)

The front door of 4S, v1. The two-audience question ("is our browser set up for anonymous
access?") answered by NOT making the SPA bimodal: **a session gets the SPA, anonymity gets a
server-rendered face** (src/idface.rs) - static HTML, no scripts, hardened headers from the
first byte (nosniff, default-src 'none' CSP, no-referrer), because the stranger-facing
surface should have as little machinery behind it as possible. The session branch rides a new
`Option<Session>` extractor (OptionalFromRequestParts: missing credentials are an audience,
node breakage is still an error). The anonymous shapes shipped: the SHELF (a hosted persona's
public profile - name and bio read straight off the identity db's public lane, escaped, with
the speakable address and hue chip), the WARM TOMBSTONE ("lives on the quiet side of
ringtome", re-homeable address in hand, 404), and the CHECKSUM REFUSAL (lying words → 400
with "did you mean <true-words>", served to every audience - the refusal is
audience-independent). The SPA grew its lens page (js/idpage.js at /id/:seg): the same
shapes dressed for the console, plus the one thing only a member can be told - "this is
you". An anonymous JSON face (/api/id/{root}/profile) follows the same shelf rule and feeds
the lens. Rust's speakable parser un-gated for its real consumer, with the mismatch-refusal
grammar tested in both languages. Seven integration tests pin the contract (390 passing);
the lens shapes field-verified through the harness - which needed its own fix, worth
recording: boot.mjs now sends the session jar on the initial page GET, exactly as a browser
would, because /id is the first surface that branches on it. Still owed from the unit's
scope, ledgered in NEXT_STEPS: the signpost rung, member fetch-and-serve, and the rolodex.

## The id page gets a door and a name (2026-08-01)

Two finishing touches on the /id lens: the persona page's address row is now a LINK (the
local /id path form, so the visit stays at this lens whatever origin the shareable text
carries - copy still hands out the full address), and the lens page wears the shell's header
band with the viewed persona's name as its title - the words immediately (always derivable
from the address), the display name the moment the shelf answers, cleared on unmount so the
band's next tenant never inherits a stale name. Structural note, recorded as open: /id is
deliberately NOT an app off the registry yet - a "persona browser" tile is the natural shape
if it grows one, and the header wiring (an idHeader beside the appHeader, title reported
upward by the page) is the smallest thing that makes the frame look right meanwhile.

## The id page stops repeating itself (2026-08-01)

The lens page's own-persona view reshaped on field feedback: the standalone fingerprint line
was redundant (the words are the address's own prefix, one row down), so it's gone - the
page now shows the SAME shareable/copyable address row the persona home mints (origin, via
hints, copy button; AddressRow exported from persona.js, its label bending to "your address"
/ "their address"), and "this is you" became the link home instead of a separate pointer
paragraph. A hosted persona's page is exactly where you'd reach for its link, so the link
lives there in its full form.

## The address row goes quiet (2026-08-01)

Field review trimmed the address row to its essentials: the whole identity string, a small
"address" tag, a copy button - the explanatory subtitles ("this computer has no public web
address…" / "where this persona lives on the web") are gone. The address is its own
document; a label that explains it is a label that doubts it. One row, both pages
(/home/persona and the id lens), no per-audience label bending.

## The profile learns to count, and to wait (2026-08-02)

Two field findings on the profile editor, one fix. The invisible 400: a too-large bio hit
the wire cap (proto's ProfileSet::MAX_VALUE_LEN, 4096 bytes) and the autosave's failure went
nowhere the user could see - a save that silently didn't happen. And the deeper mismatch:
every profile save mints a permanent chain record, which autosave-on-debounce spends on
every typing pause. The editor now drafts and COMMITS: byte counters on both fields
("15/4096" - bytes, not characters, because that's what the wire counts; an emoji spends
four), red plus a refused Save once over the cap, and an explicit Save button in place of
the debounce - the write happens when you've committed to the words, not when you pause
typing. The draft keeps the shadow contract's good half (a rename echoing from another
computer is adopted only while your draft is clean) minus the autosave, with a written-value
stand-in so the moment after a save never flashes "unsaved". Limits mirrored in
pure/profile.js with boundary vectors (4096 saves, 4097 refuses, the emoji tips it).

## Cozy caps (2026-08-02)

The profile counters moved from the wire's bound to product bounds: 64 characters for a
name, 512 for a bio (pure/profile.js PROFILE_LIMITS), counted in CODE POINTS now - one emoji
is one character to the person counting - because the cozy caps sit so far under the wire's
4096-byte cap that byte-honesty stopped mattering. A vector pins the safety inequality
(cap x 4 worst-case bytes <= wire cap) so no future cap bump can silently reopen the
invisible-400 hole; uncapped fields defer to the wire.

## The static face catches up to the lens (2026-08-02)

The anonymous /id face now shows the FULL shareable address - origin when declared, ?via=
hints minted by the same rule as the SPA row (this node first, then the persona's liveliest
peers, capped at three) - above the bio, linked to itself, with the separate words line gone
(the words are the address's own prefix). The two faces of one persona now agree about what
an address looks like and where it sits. Integration pins the hints and the ordering.

## Reaching across the network (2026-08-02)

Fetch-and-serve shipped: a member asking /api/id about an off-shelf root now triggers a
request-time fetch of the persona's PUBLIC lane, and the machinery turned out to be almost
entirely already built - `sync_with_peer` is root-general (user dbs open for any root, the
member proof degrades to None, an unproven requester with empty frontiers receives exactly
the public lane through the same from-empty path adoption exercises, and the gate validates
everything against root). The new code is a short ladder: dial each of the address's own
`?via=` hints (three max, 8s timeout each), first success marks an IN-MEMORY freshness map
(10-minute TTL; a reboot forgets every fetch - ephemerality is the design), failures fall
back to whatever an earlier fetch left in the db, and a root never reached is an honest 404.
The lens page passes its URL's hints through and labels the result ("reached across the
network - not carried on this node"); the identities table never learns, so the anonymous
face still tombstones - the shelf grows only through durable demand. Two-node integration
proves the arc: B's member reads a persona hosted only on A through one via hint, while
anonymous B keeps tombstoning it. Design finding ledgered: serving records publish under
LEAF keys (pkarr requires the publisher's signing key; the root's is offline by design), so
the "resolve a bare root via the directory" backstop is a store-at-derived-key design
problem, not a missing call - until it lands, the ladder is honestly origin + via, which
every minted address carries.

## Durable knowledge, member-scoped serving (2026-08-02)

Field review caught a conflation in the day-old fetch-and-serve design: "ephemeral" had
bundled two different dials - the SERVING scope (anonymous shelf grows only through durable
demand; the liability doctrine) and the KNOWLEDGE of what was fetched, when, and through
whom. The second is precious, not disposable: once an identity's own nodes go permanently
dark, it survives exactly in the nodes that fetched it and their memory of having done so -
and the in-memory registry meant a reboot would 404 chains the node still held on disk
(the orphaning bug at one node; friendly-fleet-reboots-kill-the-identity at network scale).
The registry moved to node.db (`foreign_fetches`: root, fetched_at, last_via - schema
generation 2; dev nodes rebuild, per the pre-launch rule), with `last_via` joining the
ladder as the durable refresh candidate - a bare hintless ask now serves from memory, which
integration proves. Deliberately still OUT of the identities table and identity_peers: a
fetch is remembered, never promoted to fronting. Doctrine amended in place (Moderation, the
fetch-and-serve paragraph): durable knowledge, member-scoped serving - the two were never
the same dial.

## Ten hints, dressed in base58 (2026-08-02)

The via-list re-ruled: the original "2-3 liveliest keys" default optimized URL length, but
until the root-directory backstop exists the hints ARE the ladder - a fast-moving identity
survives exactly as long as some listed node answers. Minted addresses now carry up to TEN
liveliest node keys, base58-dressed (44 chars against hex's 64; node keys get the denser
coat but no words - their audience is nodes). Both minters follow the rule (the SPA row and
the static face; the peers endpoint serves sixteen so the cap stays in minting code), both
spellings parse everywhere via is consumed (hex is the eternal escape hatch), and the fetch
ladder went PARALLEL to match - ten sequential 8s timeouts would be an 80s worst case, so
candidates race and the first success aborts the rest (safe: single-writer chains,
duplicate-skip ingest). PROJECT_PLAN's Costs ruling amended in place, reversal noted.

## The contact ledger (2026-08-02)

The trust layer's first UI: another persona's id page now carries "your ledger" - block,
trust (Curtis's six stops, 0/5/20/50/80/95, worded per doctrine: "not how much you like
them - whether you believe they're real"; the 95 stop is vouch-shaped and Tier 5's vouch
payload will ride it as its own statement, fork-in-the-UI), a trust-public consent toggle
with the honest small print, and two interest dials (theirs, and their rebroadcasts -
0/25/50/75/100). Every fact is a private-chain LWW register on YOUR identity
(`contact:<their-root>` in the existing private KV - zero new protocol), stored as NUMBERS
so the scale can grow stops without migration (pure/contact.js, stops pinned by vector;
`nearestStop` keeps the selects honest over finer values). Two flags are records awaiting
consumers: trust_public awaits the graph's publication machinery, blocked awaits the
Inbound Gate. One field find while proving it: rapid dial picks raced the single-writer
private chain and silently lost writes - the ledger now serializes its writes through a
queue and reloads the stored truth on failure; the harness rapid-fires all five dials and
all five land.

## The ledger learns to speak cozy (2026-08-02)

Two field notes on the day-old contact panel: "your ledger" broke the Cozyweb language
budget (engine-room word, banned from the UI) and became "your relationship"; and the
trust-visibility checkbox was a floating signifier (label text that changed when clicked -
an unchecked box saying "private" reads as its opposite), replaced by a select whose two
options say the whole truth standing still: "private - just my computers" / "public -
shared with the network".

## The vouch, dissolved (2026-08-02)

Doctrine amendment, prompted by a one-line question ("your vouches are just the set of all
your positive trust edges, aren't they?") that the day-old contact ledger made answerable:
yes. The vouch was three things wearing one word, and only one was ever a real object. As a
JUDGMENT it dissolves - the trust dial's met-in-person stop IS "I met this human", and a
separate record would be a driftable second copy of one opinion. As a WIRE OBJECT it
survives, redefined: a vouch is a positive trust edge its author chose to publish, and Tier
5's payload becomes the MINT - a signed public trust statement built from a consented edge
(copy-don't-flip: the trust_public dial is consent, the statement is a new artifact;
retractable; discloses a rounded tier, never the raw integer). As a WORD it survives as the
ceremony's name - "vouch for them" sets the stop and offers the public flip in one gesture,
and the friend token's flag becomes the same write at redemption, with the seed crystal
defaulting to shared-with-consent or the graph never grows. Sybil math untouched (budget
was always the flow computation's job); the Interest/Trust firewall untouched. New section
in PROJECT_PLAN (Trust, "The Vouch, Dissolved into the Ledger"); the Follow Ceremony
section, Tier 5's bullet, and pure/contact.js's comment all retuned to match. The same move
as roster-is-the-ACL, one layer up.

## People, and the stream keeps its promise (2026-08-02)

Two units that are really one lesson. First, an architecture audit prompted by a one-word
smell ("query"): The Browser Is a View held completely inside the persona's document world
(six stream-fed mirror tables, every read reactive, fetch caches fingerprint-vouched) but
was drifting at the edges - the day-old contact ledger read its own chain data by ad-hoc
GET, the keys screen has fetched-on-mount since July, and the People app was about to
compound the pattern. Second, the correction: contact facts became the mirror's seventh
stream kind (`contacts` - the store folds `contact:*` collections to rows; the stream
cursor already covered private frontiers, so dials tick it with zero new plumbing), the
ledger converted to mirror-plus-pending-overlay (the tags pattern; the hand-rolled
reload-on-failure died, the write queue stays - append races are real), and THEN the People
app was built the doctrinal way: a lookup box that dissects any pasted dress of an address
(full URL, /id/ path, bare - parseIdReference) and routes to the lens, over a relationship
shelf that is nothing but a reactive sort of mirror rows (pure/people.js: by trust or
interest, descending, blocked personas sinking visible-last - findable to unblock, never
outranking the living). A dial turned on any computer re-sorts every browser's shelf live.
The 2026-08-01 structural question (is /id an app?) settled by construction: People is the
app; id pages are the shareable places it navigates out to. Still fetch-on-mount, ledgered
as tolerable: the keys screen (chain data, drift), and config/node/peers/foreign-id (not
chain data, or not YOUR chains - correct as fetches).

## Three names, one person (2026-08-02)

Jerry is (nickname) Jerry, (self-configured) PhazerBean, (speakable) stood-dizzy - and the
UI now says so in that order, everywhere. The NICKNAME is Tier 5's contact-names bullet
delivered as one more fact in the contact ledger (`nickname` in `contact:<root>` - fully
private, your word for them, set on their Person page with a draft-then-blur commit so a
chosen name costs one chain record, never one per keystroke). The SELF-NAME joins the
contacts stream kind server-side: each contact row carries their profile's `name` when this
node holds their chains (hosted or foreign-fetched; `UserDbManager::exists` first, so a
contact list full of strangers never mints empty databases - absent otherwise, honestly).
The display rule is pure and vectored (`displayNames`: nickname first - the word you chose -
self-name second - their claim - speakable words always last, the anchor that cannot lie),
applied to the People rows, the Person card, and the header band alike. Field-proven end to
end; one instrument note - the probe's raw Event('blur') never reached the commit, real
focus()/blur() semantics did, so the harness speaks focus properly now.

## People learns to draw (2026-08-02)

The People list's text facts became an icon table: three columns headed by
IdentificationBadge (trust), Broadcast (interest), and CellTower (rebroadcasts), each row's
dials rendered as CellSignal bars (none/low/medium/high/full) climbing a color ramp
(faint -> teal -> sea), the trust cell escorted by a privacy glyph (LockSimple private /
Globe public), and blocked personas wearing SpeakerSimpleX in coral beside their name. The
100-point-to-five-bars squeeze is pure and vectored (`signalLevel`: quarters, rounded -
interest's stops land exactly, trust's 0 and 5 share "none" honestly); every icon keeps its
words in the tooltip, so the compression never loses the vocabulary. Two conventions-check
catches during the build: the orphaned .person-facts rule, and sig classes hidden inside a
template interpolation - enumerated as literals so the dead-CSS check can see them.

## The identities table gets its door back (2026-08-02)

CI red since the /id endpoint shipped: the Rust conventions test (SQL stays in its owning
module) caught idface.rs querying `FROM identities` directly - identity.rs's table, asked
around its back. The query moved behind the door as `identity::is_hosted` (the
audience-independent sibling of `require_owned`), idface delegates, and the new
`foreign_fetches` table registered its owner (idface.rs) in the conventions map rather than
squatting unlisted. Process note, on the record: the /id sessions ran ui-check, clippy, and
integration but skipped `just test-unit`, which is where the conventions suite lives - the
full `just ci` chain exists precisely because partial gates feel complete.

## The public lane opens, wearing a face (2026-08-02)

Public documents began - and the design conversation that preceded them settled the shape:
parallel DATA universes (copy-don't-flip demands a published thing be a new artifact on a
different chain), never parallel CODE. The document fold is now lane-parameterized: service
POSTS (reserved for exactly this since M1, per its own comment) carries plaintext
DocHeaderPlain headers, folded by the same code that folds the private lane, into the same
doc_versions/doc_heads tables under a new `lane` column (user schema gen 5). The public
sweep is deliberately KEYLESS (catch_up_public_lane - anonymous serving runs it with no
epochs in hand); public bodies are plaintext content-addressed blobs (put_public/get_public;
the no-dedup rule was ciphertext armor and inverts cleanly), served at the identity-rooted
path - /id/<root>/docs/<id>/body and /thumb, immutable caching, nosniff, and the lane check
as the whole gate: a private doc_id asked through the public door is a 404, never a leak.
The private workspace never sees public docs (list_heads filters); the apps' shelves are
unchanged. Tenant zero: THE AVATAR - "everything file-shaped is a document" held (a
profile-field-holding-a-blob-hash shortcut was argued down: it would have minted a GC-orphan
class and a document-less file precedent) - one crushed born-public media doc, the profile's
`avatar` register holding the pointer (field allowlist grew its third member), the upload
crushed inline through the same laundering every byte gets. Rendered everywhere a person
shows: the static face (CSP grew img-src 'self'), the lens card, People rows (displacing the
hue chip), and the profile page's uploader. Six integration tests pin the arc; the
conventions suite caught the raw fetch in the uploader (net.js learned FormData instead).
Deferred with the posts era, ledgered: the publication mint, public divergence, public
taxonomies, foreign body backfill.

## The proofs get homes (2026-08-03)

Asked where yesterday's four wipe-recovery proofs live, the honest answer was "one and a
half of four" - the isDeparted predicate was vectored, but the scenarios themselves were
deleted probes. Now: shape 1 (journal replay) is a Rust regression test
(db.rs, `empty_db_under_a_nonempty_journal_replays_on_open` - write through the real append
path, delete the database file, reopen, and the profile must come back by validated replay);
shapes 2 and 3 (peer-heal and peer-down) need node lifecycle control no test suite should
own, so they live as a KEPT instrument per the harness doctrine - harness/standing.mjs, the
diagnostic half (login, report standings, console-or-farewell), with the three wipe recipes
documented in its header as operator work. The split is the doctrine working: unit facts get
unit tests, composed lifecycle scenarios get instruments with instructions.

## Names and faces (2026-08-03)

Field report: a persona's name crossed nodes but their avatar didn't, both directions. The
ledgered limitation from the avatar's ship, now closed: `fetch_missing_bodies` opened with a
key-gated bail ("not an identity we agent: nothing to decrypt, nothing to fetch") that sat
ABOVE the public lane's walk - but public bodies need no keys at all: the headers are
plaintext, the blobs are public, the hash is the capability. The function now walks in two
halves: the public lane first, keyless (catch up the POSTS fold, enumerate
file/thumb/preview refs from public-lane versions, fetch whatever's absent), then the
private lane's enumeration behind the same agent gate as before. A foreign persona's avatar
now crosses in the SAME exchange as their profile - one via-hinted fetch and the viewing
node serves the thumbnail itself. Integration pins it two-node: B serves A's avatar bytes
with no second trip to A.

## The Person widget family (2026-08-03)

A persona now renders through one family instead of four hand-rolled copies (js/person.js).
The architecture question was asked directly - one flexible component with a `mode` prop, or
several? - and settled SEVERAL, over ONE hook: everything upstream of rendering is identical
at every size (the three names, the avatar, the hue, your relationship facts, is-this-you,
where clicking goes), so it lives once in `usePerson`; the DOM shapes are genuinely unlike
each other, and a mode-switching component would be four disjoint branches over a props
union where half the props are inert per mode. The one place a prop IS right: mini and small
are the same shape at different sizes, so the chip takes `size` (shape differs -> component;
size differs -> prop). The shapes: PersonChip (a hexagon of their picture, ringed in their
colour, name on hover, links to their page), PersonBanner (the inline header), PersonCard
(everything - face, names, address, bio, relationship). The hook's one option is data DEPTH,
not display mode: it never fetches for someone your ledger knows (name and avatar ride the
contacts stream), never for yourself (your mirror holds it), never when the caller passes the
profile down - so a fifty-row People shelf costs zero fetches. Adopted by /home/persona
(banner), /id/<root> (card, profile passed down so the page doesn't fetch twice), and the
People rows (hex + names, now real links). Moved with it: personaHue and displayNames into
pure/person.js (vectored), AddressRow and the relationship ledger into person.js - which
untangled a persona.js <-> idpage.js knot into one-way imports. The gallery lives at
/id/<persona>/ui-demo: every shape, one after another, against a real persona - a workbench
for tuning them side by side.

Two bugs the gallery flushed out on its first load, both latent since their code shipped:
the server's `/id/{seg}/{*rest}` route destructured its TWO path params as one
(`Path<String>`), so every deep /id path 500'd - axum extracts positionally, and only
single-segment addresses had ever been tried; and a comment-expression I put inside
`<Router>` rendered as a string child, which the router dereferences for `props.path` -
every child of a Router must BE a route. Integration now pins the deep path for both
audiences.

## An address that points where it says (2026-08-03)

"The address in the card should include the ?via hints, right?" - it did, but the question
uncovered worse: the hints were always THIS node's, whoever the persona was. Three cases,
one of them a lie. For your own persona and for one this node hosts, hinting itself is
honest. For a FOREIGN persona - reached across the network for a member - it is not: the
anonymous face still tombstones them here (fetch-and-serve is member-scoped, by the durable-
demand doctrine), so an address minted with this node's origin and this node's key hands a
stranger a dead end at both ends. Now the node answers the question itself: `/api/id/<root>/
profile` returns `hosted` and `via` - hosting hints itself plus the persona's liveliest
peers; not-hosting hints whatever actually reached them (the caller's own URL hints, merged
with the endpoint that last answered) and never itself. The client mints the origin only
when `hosted`, so a foreign persona's address is the origin-free path form, which re-homes
wherever it lands. Also relaxed while here: the peers endpoint answered only for your OWN
personas, so a housemate's address could never carry their other computers; it now answers
for any persona the node hosts (transport keys that serving records publish anyway).
Verified across two nodes - alpha mints origin+self for its own and its neighbour's persona,
bravo mints the path form with ALPHA's key for the same persona seen from afar - and pinned
by integration on both sides of the contract.

## Identicons, twinned rather than imported (2026-08-03)

A persona with no picture now wears one derived from their root - the affordance canon
already assigned a job ("the name may collide; the image will not", Naming). Deliberately
NOT a Rust identicon crate: the picture has to be identical in the console and on the
anonymous face, and no image crate's PNG can be reproduced bit-for-bit by a browser - two
faces that disagree defeat the confusable-name defence the identicon exists for. So it is a
twinned pure function on the speakable.js/speakable.rs pattern (pure/identicon.js +
src/identicon.rs, one set of goldens), and it takes no hash at all: a root pubkey is already
32 uniformly-random bytes, so the picture reads the key's own bytes and the pure zone's
no-imports rule is honoured for free. The shape: a 5x5 grid mirrored left-to-right (symmetry
is what makes a 22px glyph memorable, and the hexagon's clipped corners then take the same
thing from both sides), three tones from the persona's own hue so the identicon and the
hexagon's ring read as one object. One design catch during the build: the first cut read the
same low bit of every byte, which drew a BLANK identicon for a patterned key (0xaa
repeating) - a different bit per cell fixed it, with a vector standing over the case. The
face inlines the SVG rather than linking a data: URI, so `img-src 'self'` stays untouched;
integration asserts the face's bytes equal the console's, and the goldens hold both
languages to one picture.

## The relationship folds away (2026-08-03)

"your relationship" became a disclosure: closed, it SAYS the relationship in the People
shelf's own icons (trust, interest, rebroadcasts, the privacy glyph, a block mark if there
is one - or "nothing recorded yet"); open, it is the dials as before. A native `<details>`
rather than hand-rolled state, because the platform's own disclosure widget arrives with the
keyboard and the semantics already fitted; the caret is CSS on `::after`, the marker hidden.
One consequence worth naming: the block button MOVED into the open body - a button in a
`<summary>` toggles the disclosure instead of doing its job, and blocking is an edit like
every other one down there. The summary and the shelf now share one vocabulary rather than
two copies: SignalCell, the stop labels, and the new RelationshipGlance live in person.js
with the rest of the widget family, and signalLevel moved to pure/person.js (with its
vectors) since it is dial-display, not list logic - the People row imports what it used to
own. A relationship reads the same in the list and on the card because it is the same code.

## The glance says what, and how much (2026-08-03)

The relationship pill grew pairs: each dial now shows its OWN icon (identification badge /
broadcast / cell tower - the People table's column heads) beside its level in signal bars,
divided by hairlines, so the summary reads "what, and how much" with no legend to learn. The
kind stays quiet and the bars carry the colour, which is what makes the pair scan. And
BLOCKED collapses the whole thing: the pill becomes one red lock and nothing else, because
the only fact about a blocked relationship worth summarizing is that it's shut - with the
blocked persona's chosen PICTURE hidden everywhere at once (usePerson drops avatarUrl, so
chip, banner, card and shelf all comply from one rule), their identicon standing in. That
last part is deliberate rather than incidental: an identicon derives from the key and was
chosen by nobody, so a blocked row stays recognizable enough to unblock without showing you
what they wanted you to see. Verified live on a single open card - dials set, then blocked,
and the same page redrew from three pairs and a photo to one lock and an identicon.
