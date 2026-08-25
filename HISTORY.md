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

## The table becomes a list of people (2026-08-03)

People's five-column table retired in favour of a fourth widget shape: PersonRow - the
banner's roster form, hexagon and names as ever, your relationship glance riding the right,
and the WHOLE row as the link (a list is a place you click, not a place you aim). The
column heads went with it: the glance's pairs now carry their own kind-icons, so the header
row had nothing left to explain. What the change is really made of is deduplication - the
People app no longer owns a row component, a signal-cell component, a stop-label helper or
a header; it maps roots to `<PersonRow>` and sorts them. The names block came out as
PersonNames, shared by banner and row, so a persona reads identically in a page header and
in a list because it is one component. Gallery gained the shape (a stack of two rows) so
every size still sits side by side at /id/<persona>/ui-demo. Field-proven with three shapes
of person on one shelf: a photographed contact with three full pairs, a nicknamed one
showing "Pammy (Plain Pam - pouch-staff)" over her identicon, and a blocked one dimmed to a
lock and an identicon.

## People's lookup moves into the band (2026-08-03)

The lookup box left the page body for the app header's search slot, where every other app
keeps its search - one place for "the thing you type into", whatever the app does with it.
The registry says who brings their own: People carries `lookup: true` and the shell renders
its component (apps/people.js exports PeopleLookup) in place of the search box, so the
placement stays the shell's business and the grammar stays the app's. It keeps its BUTTON,
and the comment says why: every other app's search filters what is already on screen, while
this one navigates somewhere else - an act that completes elsewhere deserves a moment of
commitment rather than firing per keystroke. The error line went with the move: a band has
no room for a paragraph, so a bad paste outlines the input in coral and explains itself in
the tooltip. The button borrows the shell's own --search-h token, so it stands exactly as
tall as the search bar it sits beside - the same trick the search-options funnel uses.

## Adopting over a fetched copy (2026-08-03)

A question with a testable answer: if a node already holds a persona's PUBLIC-only copy
(someone here follows them) and that persona later moves in, does anything need deleting?
No - and the path had never been run, so it was run rather than reasoned about. Adoption
onto an existing greg.db works whole: the public copy is a prefix, not an obstacle
(content-addressed entries, duplicate-skip on ingest, an incremental fold with per-chain
watermarks), the member proof starts flowing on the next exchange, and the private half
folds on top - proven by a private note written on the home node arriving and DECRYPTING on
the newly-adopted one. One untidy edge found and fixed: the `foreign_fetches` row survived,
so the node's own records kept telling a stranger's story about a tenant. Hosting now
supersedes fetching - record_identity forgets the fetch, covering adoption and creation
alike, since that is the transition that makes the record wrong rather than merely old.
Pinned by integration (with its own persona, after the first version of the test rewrote the
world the foreign-state tests around it were asserting - test pollution caught by the suite
itself); `sql()` learned to ask the second node, which two-node tests had never needed.

## Arrival and attention, written down (2026-08-03)

Two design conversations - "every user needs an inbox" and "a feed over 300 identities is a
fan-in problem" - settled into canon as two Data Layer sections, because they turned out to
be one question wearing two hats: how a reader materializes many writers.

**Other People Live in Their Own Database** records what the code already decided and never
stated: Greg's chains land in Greg's database, node-shared and deduplicated, because a fold
of his chains is a property of *him*; the line that keeps it coherent is **content is
theirs, opinions are yours** (his posts in his file, your nickname and dials on your private
chain); what lands there is exactly what you can prove entitlement to, enforced three times
(his node won't send, yours won't accept, you couldn't read) and generalizing without
amendment to a group's member lane; a foreign database is entirely disposable, which is what
makes retention tractable; store, serve and advertise are three different acts with three
different visibilities; your own nodes may RELAY foreign content to each other because
entries are self-validating, under the `?via=` rule that a reported frontier is a hint, never
a fact. Ledgered inside it: nothing records WHO demanded a foreign identity, though the Three
Funnels asserts exactly that - doctrine ahead of code, and the subscription table is where
the debt gets paid.

**Arrival and Attention** settles the inbox as a DOORBELL, not a mailbox - it holds only what
arrives from people whose chains you don't sync, and accepting someone converts the
relationship to pull. Strangers cannot write your chains (single-writer is foundational), so
your node transcribes behind the Inbound Gate, at transcription rather than delivery, keeping
the sender's signed envelope verbatim so your other nodes verify it themselves; the envelope
hash is the notice id, which makes multi-node delivery idempotent. Notices are
SELF-DESCRIBING, which is what keeps a thousand-notice inbox from touching a thousand
identities - and the sender's name and face are not fetched at all, because an unadmitted
stranger renders as derived identity only. That last convergence is the nicest thing in the
section: the anti-harassment rule and the fan-out rule are the same rule. Anti-flood in four
layers (gate, collapse by sender+kind, a two-tier quota where a flood can only evict other
strangers, and refuse-before-signing), with the honest costs named. The feed half: the naive
read is not 300 queries but 300 FILES (the handle cache thrashes), so fan-out on write into a
cross-identity index that is public-lane-only by construction; **the node routes, the user
ranks** (a subscription table, deliberately not the aggregated social graph - already-possible
and already-assembled are different security postures); journal then index, which makes
unfollow/block/interest a re-index rather than a retraction; two cursors, since "delivered" is
disposable bookkeeping and "seen" is a user fact that must sync; the interest dial doubling as
a sync-cadence dial; and nodes sharing frontiers, never views - evidence crosses wires,
opinions stay home. "The Browser Is a View", promoted one level.

Cross-referenced from the Inbound Gate and Edge-Endpoint Visibility, and promoted in
NEXT_STEPS to route step 4 - the substrate posts and feeds sit on, and the first thing that
would make following someone actually *do* anything.

## Publication: a note becomes a post (2026-08-03)

The membrane crossing, built. `POST /docs/{id}/publish` reads a note's synthesized text and
MINTS a new artifact on the public lane - copy-don't-flip in code, so the post has its own
doc_id, the note keeps its private history, and there is no bit anywhere that could have been
toggled instead. Re-publishing is another explicit act and lands as a further VERSION of the
same post, because the note remembers its post through a `published_as` annotation. A
DIVERGED note is refused rather than shipped: its synthesized text would carry conflict
scaffolding, and nobody means to publish that.

The scope turned out smaller than "expand documents, taxonomies and annotations to the public
space" suggests. Documents had already crossed with the avatar (lane-parameterized fold,
plaintext public blobs, serving routes) - only a TEXT path was missing (`save_public_text`).
Annotations need nothing at all: they are keyed `annot:<root>/<doc_id>`, lane-blind, and the
collection form already carries a root, so annotating your own post - or someone else's -
was anticipated in the naming. Taxonomies wait for books and tag-pages, where published
curation is the point. Labels stay deferred: the header's decoder already skips unknown keys,
so adding them later is additive rather than a break.

Canon amended where the code disagreed with it: NOTES_APP said the note's HEADER records
`published_as`, which predates the annotation layer. A header field would mint a new version
of the note to record bookkeeping - reading as an edit, and forking the note if two computers
published at once. It is an annotation now, with the reasoning recorded.

Six integration tests pin the shape (post is not note; listed publicly; body served to a
stranger; the note stays behind the membrane; re-publish extends rather than mints; diverged
refused). Two bugs found by them, one mine in the test and one real: the `published_as` reader
folded GENERAL_PRIVATE while annotations live on DOC_META_PRIVATE - the watermark table is
keyed by service, so the wrong view is simply empty, and the first version silently
re-published every post as a stranger. Clippy's turn improved the API on the way past: an
eight-argument function became a `PublicText` value, and a `head` field nobody read left the
public listing.

## Feed: the app that writes in public (2026-08-03)

Publication got its home, and deliberately not inside the private notebooks - those were
built private-first, and growing a "make this public" button on them is exactly the
membrane-by-accident that copy-don't-flip exists to prevent. Feed is the other way round: a
draft here exists to be posted, and posting is the app's one verb.

Its shape is Journal's, because it is the same shape - a single stream, newest first, each
item either open for writing or SEALED behind the deliberate fifteen-second unlock. Journal
seals by the calendar (yesterday is done); Feed seals by publication (this has been said in
public), and here the ceremony is load-bearing rather than decorative. A sealed item is also
not a LINK: the editor behind it would open without the unlock, and a ceremony you can walk
around isn't one. State is pure and vectored (pure/feed.js `publishedState`), split along the
line that matters: whether a document HAS a public form is a durable synced fact (the
`published_as` annotation), while whether it is open for editing is a local per-device
gesture (Journal's seal pref, never synced) - so "I'm working on this again" stays personal.

The behaviour Curtis asked for - stacking private edits and baking them down to a single
public change - needed no code: `publish` reads the RESOLVED text and appends one public
version, so the public history is a history of publications rather than keystrokes, which is
canon's "born with a public history of one" holding at every re-post. Proven end to end: two
private edits then one post, and the world sees the newest words with still one post
standing. Added while building it: the no-op bounce (re-posting identical words writes
nothing at all - the same guard `retitle` uses one lane over), pinned by a test that counts
chain entries before and after.

No buckets for public posting, as decided: the drafts live in one eponymous bucket, and the
posts have none - a bucket is a private annotation and a public post has nowhere to keep one
until public annotations exist. Which is the next bite, and the one that makes tags mean
something.

## One draft at a time (2026-08-03)

Feed shipped with a "+ write something" button, and the first user through it found the
oldest UI failure there is: the click was a round trip, nothing on screen moved for the
second it took the stream to come back, so it got clicked again, and again - and then six or
seven untitled drafts arrived at once. The button returned 200 every time. It was working
perfectly and it looked broken, which is worse than broken.

The fix wasn't feedback on the button; it was deleting the button. Feed now holds ONE open
draft, Journal's shape rather than a list's: the app opens straight into the current draft,
or - if there isn't one - mints exactly one, silently, and you are simply looking at a page.
Editing happens in place with the real interactive editor (doc/session.js, the same autosave,
blur flush, and other-computer lookout every editing surface uses), and Post moves the slot
along: mint the next page BEFORE sealing the last, so the composer hands over draft to draft
with no moment where there is no draft to show. Which draft is THE draft is pure and vectored
(`openDraftOf`: the newest unposted one); older drafts aren't hidden by the rule, they fall
into the stack below, visible and editable.

The thing worth keeping: a pile of drafts is now unrepresentable rather than guarded against.
A second visit finds the first visit's draft and mints nothing, so the failure mode has no
shape to take - the guard against double-minting is one ref inside one window, and the
correctness doesn't depend on it. Curtis also asked whether the public chain syncs
differently, and it doesn't: posts are filtered out of the mirror's docs kind entirely
(`list_heads` takes the private lane), so Feed was only ever watching drafts on the ordinary
stream. The pile was a button, not a lane.

Ledgered from the probe rather than fixed: jsdom windows that are closed keep their live
queries running and then draw into a document that is gone. That throw belongs to the
instrument - harness doctrine again - and the probe now leaves its windows open instead of
being read as an app fault. It very nearly bought a defensive try/catch around the editor's
teardown, in the real code, for a hazard the real code doesn't have.

## The composer opens before the stream agrees (2026-08-03)

Curtis, on the reshaped Feed: "opening a fresh page…" sat there for a handful of seconds. The
one-draft rule made the button's damage unrepresentable but left its LATENCY exactly where it
was - the app still couldn't show a composer until the mirror handed back a row with the feed
bucket on it, which is two chain appends (the document, then the annotation that files it)
plus the stream echo plus a whole-kind refresh. Deleting the button moved the waiting from
before the click to after it.

So the draft goes on screen the moment the server names it: a local overlay holds the minted
doc_id and leads the mirror, cleared the instant the mirror agrees. This is the overlay the
contact ledger and the tags already use, and it is *The Browser Is a View* holding rather than
bending - the view may run ahead of the stream so long as it never disagrees with it, which is
guaranteed here because the thing it is ahead about is a document the server has already
acknowledged. The editing session never needed the row anyway; it fetches by id.

Honest about the measurement: the probe could NOT reproduce the multi-second wait - 216ms cold,
231ms against a persona with 150 notes already mirrored - so what the overlay removes is stated
as mechanism, not as a demonstrated number. The local node is empty, its chain is short, and
its debounce is hand-tuned; a real one carries all three costs. Timing is now recorded on every
visit in the probe, so a regression here reads as a number rather than a feeling.

Nearly-shipped mistake worth keeping: the earlier commit's harness failure looked like the
editor's teardown throwing, and very nearly bought a defensive try/catch around CodeMirror's
destroy in real app code. The actual cause was the probe closing its own jsdom windows, whose
live queries kept running and then drew into a document that no longer existed. Harness
doctrine, the hard way: an instrument's failure was one commit away from becoming a permanent
apology in the app.

## A post shows its words (2026-08-03)

Two display faults, both of them the app talking about a document instead of showing one.

"untitled" was the app's word, not the author's, set in heading type where a title goes - a
post that was never given a name now simply has no heading, and the words start where the
heading would have been. The stack rendered no body at all, only a link out; it now renders
the document the way Journal renders a sealed entry (doc/detail.js, cache-first and patient
about a body still in flight; the BARE fallback for an unparsable document rather than the
apology, because a paragraph of explanation per card is noise in a stream). What it renders is
YOUR copy, not the public artifact minted from it: they hold the same words until you edit
again, and after that the honest thing to show in your own app is the draft you are working
on. The link below it, relabelled "the public copy", says where the other one lives.

Which leaves the question Curtis actually asked - why that link lands on raw marquee source -
standing, and it is not a bug in the link. There is no public RENDERED page for a post
anywhere: `/id/<root>/docs/<id>/body` serves the artifact's bytes under its format's mime
type, and it is the only public way in, because the anonymous face is Rust-rendered HTML while
the marquee renderer is JavaScript. The static face does not even list posts yet - they exist
only in the JSON profile. So the world can currently fetch our posts but not read them as
written. The cheapest fix is not the SPA and not a Rust renderer: a small public reader page
that fetches `/body` and renders it with the marquee bundle, no session and no app. Ledgered,
not built - the ask here was the feed's own display.

## Feed gets columns (2026-08-04)

The composer moved into a column of its own - the documents apps' layout, unchanged: panes.js
draws the head and the rail, drags the width at a resizer strip, and settles both into this
browser's prefs, so Feed inherits every gesture Notes and the wiki already taught. Writing sits
on the left, the stream fills the main area, and both are on screen at once.

The one-column stack was fine while a post was a title and a link; it stopped being fine the
moment posts rendered their words, because then the composer scrolled away exactly when you had
something to react to. The name of the app had implied this arrangement all along.

Nothing new was written to get it - the whole change is composition, which is the payoff for
panes.js having been pulled out of two drifting copies rather than left in Notes. The column
key is the app's own (`feed`), so its width and its tuck are its own business. Checked in the
probe rather than assumed: the resizer exists, the live editor really is inside the pane, and
the composer tucks to a rail and comes back.

## Chrome an app didn't ask for (2026-08-04)

Feed wore a bucket switcher over its single eponymous notebook - a choice that isn't one - and
the registry had said "No bucket switcher" in a comment since the day it was written. The shell
never asked; it inferred the documents chrome from `style`, which Feed declares only so its
drafts have somewhere to live. Looking for the switcher turned up its twin: a search box in the
header of an app whose component is handed no query at all, so typing in it did nothing.

Both are now said outright in the registry (`soleBucket`, `searchable: false`) rather than
inferred from a field that means something else. The general shape worth remembering: a
capability flag reused as a chrome flag will eventually hang a control off something that can't
answer it, and the control will look broken rather than absent - which is the same failure the
"+ write something" button made, one layer up.

Search over your own posts is a real feature and this doesn't rule it out; it removes a box that
promised it early. Ledgered in NEXT_STEPS.

## Posting stops queueing (2026-08-04)

Three seconds between the click and the words joining the stream, and every one of them was a
round trip we had put in a line: save the buffer, then publish it, then create the next page,
then file that page in the bucket - four chain appends end to end, with the post sitting in the
composer for the whole procession. Only the first two of those have any order between them.

The next page is now minted ALONGSIDE the publish, and the composer hands over the moment that
document exists rather than when the whole queue drains. The publication itself is stated
locally the instant the server answers, instead of being waited for a second time through the
stream (`overlayPosted`, pure and vectored - and it YIELDS to the mirror once the mirror carries
the annotation, which is what makes it safe to leave in place rather than something to remember
to clear; the vector for that is the one that fails when the yield is removed). Measured in the
probe rather than asserted: 29ms from click to the post in the stream, reading "posted", against
a stream that was empty when the click landed.

What this trades: the handover no longer waits to hear that the publish succeeded, so a REFUSED
publish (a diverged draft, the one case) leaves the words in the stream as what they still
honestly are - a draft, unsealed, with the reason printed above them - rather than holding the
composer hostage to the rare failure. Worth saying plainly because it is the third time in this
app that the fix was the same shape: the wait was never the work, it was the queue.

## Reading someone else (2026-08-04)

A persona's page now carries what they have said in public, newest first, rendered - the first
surface in the console that shows another person's words rather than a name and a relationship.

Nothing had to be added to the wire: `/api/id/<root>/profile` already answered with posts, and
the page already fetched that profile to tell reachable from unreachable, so the posts ride the
fetch that was happening anyway. Each body comes from the ANONYMOUS path, `/id/<root>/docs/
<id>/body` - the same bytes by the same route a stranger would use, which is the property worth
keeping: a member reading a foreign post and a stranger reading it differ only in the chrome
around the words. It works for a persona this node has never carried, because the fetch-and-serve
that named the posts brought their bodies with them.

Deliberately no mirror table. Another person's public documents are not ours to keep in a local
kind (*Other People Live in Their Own Database*), so this is one body fetch per post and a cap of
twenty in pure/feed.js - a person's page is an introduction, not an archive.

Order is established here rather than trusted: the server answers newest-first, but this list can
arrive from a fetch across the network, and a page that leans on a remote node's ORDER is leaning
on something it doesn't control. The vector that catches it is the undated post - a bare
subtraction sorts NaN wherever the comparison happens to land, so it gets pinned last on purpose.

`apiText` joined `api()` in net.js rather than a bare fetch appearing in a component: a public
body is bytes under its own mime type, so the parse differs and nothing else does. Twelve private
copies of the JSON client is how that module came to exist; a thirteenth for text would have been
the same story with a different verb.

## Down the shelf, not just the top of it (2026-08-04)

Twenty posts was the whole of what a visit could ever see - a cap invented on the client over a
profile that was handing back the entire shelf anyway, which is the worst of both: a payload
that grows without bound and a reader who can't reach past the first screen. Now the shelf pages,
and the page size lives on the server where it belongs (`POSTS_PAGE`); the profile carries the
first page and says whether there is more, and "load more" walks back to the beginning of time.

KEYSET, not offset. The cursor is the last row shown, `(head_ms, doc_id)`, and the query starts
strictly after it in the order it already sorts by. Posting to a shelf someone is reading down is
the ordinary case here rather than the exotic one - it is the whole point of the lane - and an
offset would silently skip a row for every arrival. Re-publishing still moves a document to the
head, so a page turn can hand back one already shown; the reader dedupes by doc_id, which is the
honest place for it, because the shelf really did change underfoot and no cursor can undo that.
First sighting wins, so what's on screen stays where the eye left it.

The bug worth recording: the cursor parse was written against a 32-byte document id, and document
ids are 16. Every real cursor failed - and failed as `404 no such persona here`, because the parse
error borrowed the not-found path, which sent me hunting the access gate instead of the four
characters that were actually wrong. A malformed cursor is now a 400 that says "cursor", with a
test that pins it. Cheap error-shape laziness bought an expensive detour.

## Two writes at once (2026-08-04)

Posting threw a 500 reading "storing entry", left the post sitting as a draft, and then stopped
happening on its own - the signature of a race, and this one was bought three commits back, this
morning, buying speed in this same app (*Posting stops queueing*, above). Making Post fast meant
minting the next draft ALONGSIDE the publish, and both of those author entries on the same
chain. Every entry derives its seq from the chain head, so two appends overlapping between that
read and the insert leaves the loser dead on the
`(author, service, seq)` primary key. It self-healed because it is a timing window, not a state.

The key was doing its job: it exists so a lost race fails loudly instead of forking a chain. What
was missing is that local writes were never serialized against EACH OTHER. `lock_ingest` had
closed exactly this window on the sync side, and its own comment said "local authorship is
unaffected - it writes only this node's own chains, which no ingest batch contests", which was
true and not the whole truth. `lock_append` is the same lock on the other side of the membrane,
held across the head read, the signing and the insert - so the primary key goes back to being a
backstop rather than something users meet.

Not a retry loop, deliberately: retrying re-signs under a new seq and leaves the dead frame in
the journal, which is a mess to clean up in exchange for a window that a mutex simply closes.

The test plants the violation and the violation shows: eight documents created at once fail
without the lock and pass with it. Worth recording that the two-request version - publish and
mint together, the exact shape the app performs - passed even WITHOUT the lock on that run,
because the two requests do different amounts of work before reaching their appends. A test that
reproduces the user's action was the less sensitive instrument; the one that reproduces the
CONDITION found it every time.

And what the reader was shown: "storing entry" is a note the code left for whoever debugs it,
not a sentence anyone else can act on. Internal errors now say so plainly and keep the full
anyhow chain in the log, where the person who can act on it is looking. Feed's error moved into
the composer column too - it had been reporting a failed post from above the columns, a long way
from the button that caused it.

## The unlock had nothing behind it (2026-08-04)

Fifteen seconds of ceremony, and then nothing. The unlock's only consequence was to turn the
item's title into a link - so an UNTITLED post, which this app has deliberately made ordinary,
had no consequence at all. Worse where there was a title: the link pointed at `/home/feed/<id>`,
an address Feed doesn't answer, so it fell through to the documents-app rendering of a feed post
- the "clicking on one carried me into essentially the notes app" from the day the app was built,
still standing behind a door nobody had opened for fifteen seconds.

Editing now happens where the words are. The unlock mounts the same interactive editor the
composer runs, on the item itself, with the same save machinery and a "post the changes" button -
which is what *edits are made using the interactive editor, in place* asked for in the first
place, applied to the half of the app that hadn't got it yet. An item already unsealed offers a
plain `edit` instead of the lock, and the editor mounts on demand rather than whenever an item is
unlocked, so a stack of leftover drafts doesn't raise a live CodeMirror each on first paint. The
title is no longer a link at all: there is nowhere else to go.

Re-posting from the stack says the same document again and does NOT mint a next page - only the
open draft moves the slot along. A blank composer as the reward for pressing a button on an old
post is nonsense, and the code now says which case it is in rather than assuming.

Probe note: jsdom runs no CSS animations, so the fifteen-second fill never ends there and the
handler hangs off `animationend`. Firing that event by hand drives the real path - seal pref and
all - rather than standing in for it. The first attempt DID stand in for it, by writing the seal
pref through an HTTP endpoint that does not exist (prefs are local, never synced), and reported a
failure that belonged entirely to the instrument.

## Dated by when it was said (2026-08-04)

Both post displays sorted by last-update, so fixing a typo republished your week: the edited post
climbed to the top of your own stack and of your page as a stranger reads it. They sort by
GENESIS now - the earliest version's claimed stamp - and that is the post's displayed date too.
Editing something is not saying it again, and a stream that reshuffles when you correct a word
has stopped being a record of when things happened.

Nothing had to be stored: `doc_heads.genesis_ms` has carried "the claimed stamp of the
parentless/earliest version" since the table was written, and the docs mirror row has been
handing the browser `created_ms` all along - the Journal already stacks by it. What was missing
was a `createdMs` beside `claimedMs` in pure/docdate.js, asking the other question a stream can
ask about a document: not when it last changed, but when it began. A claimed `display_date` still
outranks both clocks, because Displayed Time vs. Claimed Time applies to whichever question is
being asked.

The public shelf pays twice for this. Its sort key is now IMMUTABLE, so the keyset cursor can no
longer be shuffled across a page boundary by a re-publication mid-read - the case the reader's
dedupe existed to catch. The dedupe stays, cheaply, for the honest remainder: a post published
while the reader is between pages. `published_ms` now means what its name says (first said), with
`updated_ms` reported alongside for anything that wants it.

A vector of mine failed for its own reasons and briefly looked like the code's: I wrote 1e12 ms
as "recent" to prove a 2015 claim would backdate it, and 1e12 is 2001. Asserting the parsed
claim directly says what was meant and can't be wrong about the calendar.

## The node learns who moved (2026-08-04)

The first piece of the fan-out substrate: a node-level map of what this node holds of each
persona's PUBLIC lane, one blake3 fingerprint per (persona, service). Per-user databases are
separate files, so "which personas changed?" used to mean opening every one of them; it is one
scan now, and it is the hook a subscription will hang from.

The construction, settled in conversation and worth restating because two nodes must agree on it
exactly: for each `(author, service)` chain, hash `author ‖ service ‖ head_entry_hash`, sorted by
author. The head HASH, not the head seq - `local_frontiers` reports ranges, and two chains that
forked carry the same max seq with different entries, so a seq-derived fingerprint compares equal
across a divergence and reports nothing to do. Canon already named the right tuple: `(chain, seq,
head_hash)` anchors.

Keyed per SERVICE, not per persona, which was Curtis's question about 49 chains doing its work: a
persona's public chains are devices x services (sparsely - a computer that never posts has no
POSTS chain), and one fingerprint over all of them is maximally sensitive. Adding a computer
writes an authorize entry on IDENTITY_PUBLIC, and under a single fingerprint that would wake
every follower to discover the person said nothing. Keyed this way, "did they post" and "did they
add a computer" are different questions. The persona-level digest is derived from the rows rather
than stored, so it cannot disagree with them.

Public only, structurally, using `is_private_service` - the sync gate's own predicate rather than
a second list of what counts as private. The count and cadence of private activity is itself
private metadata, and this value exists to be compared with other nodes.

Two things the module says about itself in its own doc comment, because both are easy to forget
later: it is NOT ORDERABLE (a hash detects difference, never progress - it can say "go look" and
can never say "we are behind"; deciding who holds more is the exchange's job, where entries are
validated rather than believed), and the refresh is EDGE-triggered, returning whether the
fingerprint moved. Level-triggering would be true forever once true, and a fan-out reading it
would tell every subscriber on every pass. Today the edge's only consumer is a log line; that is
where the notify goes.

Off the hot path: the sweep is a nudged loop (`periodic_nudged` already existed, doorbell and
all), because recomputing inside `imaol::append` would charge every entry for a fact only sweeps
read - and Feed writes several entries per post.

Node schema generation 2 -> 3, which by the pre-launch policy means delete node.db and rebuild.
The peer-claim columns on `identity_peers` (`seen_fp`, `chased_fp`, `verdict`) land in the same
bump though nothing writes them yet, deliberately: their design is settled, and adding them later
would cost a second wipe of everyone's accounts to save nothing.

The peer half landed in the same sitting, after a detour worth recording. I had told Curtis this
feature added no wire surface, describing the protocol from the sync function's shape rather than
reading the struct: `Frontier` carried `{author, service, floor, head}` - seq numbers, no head
hash - so a peer's Hello could not be folded into a fingerprint comparable with ours. Then I
stopped and asked which way to go, having in the same breath recommended one option and dismissed
the other. Curtis's reply was the correct one: what decision, exactly? Presenting a settled call
as a question is not caution, it is handing back work.

So `Frontier` grew `head_hash` (pre-launch, no compatibility burden), `local_frontiers` fills it,
and an exchange now records what the peer CLAIMED - `claimed_fingerprint` over the same
construction, so the two are comparable by identity rather than by conversion - and then what
came of chasing it. The verdict is stored beside the claim rather than the claim alone, which is
the whole point: without it, a node advertising a fingerprint it cannot back up is chased on
every sweep forever, free for it and expensive for us. Three verdicts, only one a fault - `ahead`
(they had entries, and the entries validated), `behind` (their frontier is ours; the signal to
push), `unresolvable` (nothing arrived and we still disagree). The order matters and is commented
where it matters: our own frontier is recomputed AFTER the ingest, so "do we still disagree" is
asked of what we now hold rather than what we held when they spoke.

Left undone deliberately: `send_missing` still diffs on seq, so two nodes forked at the same seq
exchange nothing. The anchor to detect it now crosses the wire, but what an exchange should DO
about a public fork is public divergence semantics, which is deferred with the posts era and
deserves its own design rather than an improvisation inside a bookkeeping change.

## The nudge learns to say who (2026-08-04)

Curtis, reading the frontier write-up: is there one sync loop for the whole node, and if so does
a single person posting fire it for everyone? Yes, and yes - and the answer got worse the closer
it was looked at.

`eager_pass` walked every root with peers on every firing, running a `GROUP BY` over each
persona's entries to discover whether it had moved. The in-memory debounce stopped the DIALING,
never the SCANNING, so a node holding a thousand personas ran a thousand frontier scans every
time anybody wrote, to learn that nine hundred and ninety-nine of them were exactly as before.
The cost scales with personas on the node, not with entries in a chain.

The frontier sweep, written an hour earlier in the same shape and without examining it, was
worse twice over: its worklist included fetched foreign personas as well as hosted ones, and it
had no equivalent of the debounce at all - it upserted every service row on every pass whether
anything had moved or not. A thousand personas meant four thousand node.db writes every thirty
seconds to record that nothing happened, and it made `held_at_ms` mean "when we last looked",
which is a fact nobody wants. It now writes only what changed, so the column means "when this
changed" - which is what fan-out will read.

The shared fix is one word on the wire between a write and the loops that care: the nudge now
NAMES the identity that wrote. It was a dataless ping, deliberately, and dataless means every
consumer must re-examine everything to find the one thing. `imaol::append` knows the root at the
moment it rings the bell. A named pass does one persona's work; `None` - a tick, or a lagged
receiver that can no longer say what it missed - sweeps everyone. Getting that backwards, reading
a lag as "nothing happened", would silently drop exactly the writes that arrived in a burst,
which is why the lag case is spelled out where it is decided rather than left to the reader.

The tick keeps its job, and it is a real one: entries arriving BY SYNC never ring the bell (the
relay damping that keeps a peer triangle from ping-ponging), so a followed identity's movement is
found by the sweep rather than announced by it.

A third consumer fell out for free. The live-cache WebSocket woke every open stream on every
write by anyone on the node; it now ignores nudges naming a different identity - and still wakes
on a lagged one, because a receiver that missed pings cannot rule itself out.

Pinned by planting both violations: removing the write-skip fails the "does not move when nothing
public happened" test, which for that reason selects `held_at_ms` rather than just the
fingerprint - a rewrite is invisible if you only compare the value that didn't change.

## Looking is what triggers looking (2026-08-04)

A foreign persona's page showed a name changed hours ago and posts from far in the past. It was
re-syncing - just behind a ten-minute TTL, so any visit within ten minutes of the last one served
the cached copy without dialing anybody. The whole public lane crosses in one exchange, so a
stale name and stale posts are the same skipped fetch wearing two faces.

That TTL was long for a reason that no longer holds: the fetch sat in the request path, and a
long window was the only thing keeping a dead peer from becoming a slow page. So the fetch left
the request path. A visit now serves what this node already holds and revalidates BEHIND the
answer, the response saying `refreshing: true` so the reader knows to look again - which the /id
page does, up to four times at a second and a half, bounded because a peer that never answers
must not leave a page polling forever.

With the wait gone, the TTL stops being a freshness window and becomes what it should have been:
a thirty-second anti-hammer floor, so a reload loop cannot become a dial loop. The exchange it
guards is cheap in the ordinary case - an up-to-date frontier swap transfers nothing, and only a
persona that actually moved costs more than a kilobyte. The expensive case is exactly the case
worth paying for.

One case still blocks, deliberately: the FIRST sight of a stranger, where there is nothing to
serve stale. That visit pays the network's latency because the alternative is showing a tombstone
for someone we could have reached.

The in-flight set is the other half of the anti-hammer: ten page loads in a second dial the
stranger's node once, and a root already being fetched reports `refreshing: true` to everyone
waiting on it rather than starting a second exchange. It is released in the task's own exit path,
success or failure - a root that leaked into that set would never be refreshed again for the life
of the process.

The doctrine this lands on: a visit is the demand signal the pull model runs on. Someone opening
your page is the system's only honest cue that your words are wanted somewhere, and it should
always mean "go and look" - just never at the reader's expense.

## Where these words came from (2026-08-04)

The /id page now says when this node last reached a foreign persona, and spins while it is
reaching again. It is the honest caption on everything above it: what a reader sees is what this
node holds, which is what it last managed to fetch.

Only for a persona this node does NOT host. One it hosts has no "last synced" - its words are
written here, and a timestamp would answer a question nobody asked.

A first sight reports the sync as happening NOW rather than reporting nothing. The row it writes
is younger than the response, so the obvious implementation renders an empty caption on the one
visit that definitely just synced; setting it explicitly is both truer and more useful.

`pure/ago.js` splits the judgement from the rendering: choosing the unit is ours (ninety minutes
reads as "an hour ago", not "90 minutes ago") and testable, while turning a count into words
belongs to `Intl.RelativeTimeFormat`, which knows the reader's language and their idea of
"yesterday" - the same rule the date field settled on when the locale-aware native control beat
the hand-rolled one. A stamp from the FUTURE - their clock ahead of ours, ordinary between
machines - falls through the just-now door and declines to count, because "in 3 minutes" for
something that already happened is worse than saying nothing.

The plant-the-violation habit paid a different way than usual here: the clock-skew vector did
NOT fail when its guard was removed, because a `Math.max(0, ...)` clamp was unreachable - the
just-now threshold already swallowed every negative delta. The clamp came out and the comment now
says which rule actually carries the case. A test that cannot fail is not the only thing worth
finding this way; code that cannot run is the other.

## The relationship comes first (2026-08-04)

On a person's card, your relationship with them now sits above their bio, and the bio wears a
frame of its own. How you stand with someone is the first thing you want when you arrive on their
page; the bio is what you read once you have it. The frame does the other half - it makes the
bio read as something they WROTE rather than as more of the page's chrome, which matters more the
more of the card is ours rather than theirs.

## The node's memo of who follows whom (2026-08-04)

`subscriptions` at node level: one row per (persona, contact) carrying `eagerness`,
`rebroadcast`, and - conditionally - `trust`, derived from each persona's own contact ledger and
rebuilt off the named nudge, since turning a dial is a private-chain write like any other. Same
memo idiom as `doc_heads` and `persona_frontiers`: the truth stays where it was authored, and
this is the copy that makes a cross-persona question answerable without opening every encrypted
file on the node.

No new knob for the routing half. The interest dial has been a sync-cadence dial by design since
the Data Layer was written - "don't show / low / medium / high / top priority" is already how
eagerly to sync someone - so `interest` becomes `eagerness` and needed no UI at all.

The trust half took a conversation to get right, and the record is worth keeping because I was
wrong first. Canon says the node routes and the user ranks, and that it deliberately does NOT
assemble trust weights, because *already-possible* and *already-assembled* are different security
postures. I read Curtis's proposal as an amendment to that and pushed back; the resolution was
better than either starting position. Only `trust_public`-consented edges are copied, which
resolves the objection rather than overriding it: assembling statements their authors agreed may
be known discloses nothing the published version wouldn't, and the rule keeps its force exactly
where it was aimed - the quiet graph. It also gives that consent flag its first consumer since
the ledger shipped.

The second reason for the consent gate is one the doctrine didn't cover because the use is new:
acting on a quiet edge makes it MEASURABLE. Give a peer a better rate limit because someone here
trusts them, and the peer can detect that trust by measuring - third-party enumeration arriving
by side channel rather than by query. The check therefore lives in exactly one function, so an
unconsented value is never copied out at all rather than copied and filtered downstream.

Curtis overruled me twice, both times correctly. Storing the raw 0-100 rather than a rounded
tier: a number can be bucketed later, a bucket can never be un-bucketed, and nothing consumes it
yet to have an opinion. And deferring the Sybil question - a count of trust edges is exactly the
per-person sum the trust thesis forbids, but there is no consumer to game, and inventing a
defense before the thing it defends is how you get a defense shaped like a guess. Both are
recorded in the module doc for whoever writes the consumer.

Nothing reads the table, and there is deliberately no reader function either - a query written
before its consumer guesses at the shape the consumer wants. That was learned an hour earlier:
the frontier module shipped `held`/`persona_fingerprint` with no caller, and clippy's dead-code
error was the honest signal.

## Asking is telling (2026-08-05)

`identity_demand`: who has asked this node about which persona, one row per (persona, node),
updated in place. It is the fan-out address list - "a public post for P just landed, which nodes
should I tell?" - and it needed no new protocol, because the answer was already crossing the wire
and being thrown away. A node that dials us and names P in its Hello has told us it wants P.

Curtis proposed trust as the routing proxy and it doesn't hold, for a reason the doctrine states
in its own words: trust is "do I believe they're real", never "do I like them" - Interest is the
liking dial. So it is over-inclusive (I vouched my dentist is a real person; I don't want their
posts) and, fatally, under-inclusive: following someone without making any claim about whether
they're impersonated is the ordinary case, so a trust-keyed fan-out misses nearly everyone who
actually asked to read you.

It also pays a debt canon had booked and nothing wrote: the Three Funnels has been asserting a
demand record for months. This is the honest kind - a record of what someone DID rather than an
inference about what they might want - and it decays by nature: a node that stops asking stops
being told, so losing interest needs no unsubscribe.

Kept separate from `identity_peers` deliberately, though the key looks identical. That table
means "nodes that ARE this identity" - member-proven, entitled to private chains, and
`roots_with_peers` drives the eager push loop assuming exactly that. A reader is none of those,
and the conflation is the kind that leaks the day someone writes a loop over `peers_for` without
re-reading its comment. The test pins it from the other side too: a stranger asking about a
public persona must not appear in `identity_peers`.

Recorded AFTER the agented check, which matters more than it looks: a node we don't serve gets a
uniform empty answer by design ("we don't confirm what we do or don't hold"), and writing a row
for it would make that silence measurable from our own database.

Two things left undone on purpose. No `fanout_targets` query - it has no consumer yet, and a
query written before its reader guesses at the shape the reader wants; this is the third time
that lesson has come up today and the first time it was applied before clippy said so. And no
retention pass: Curtis's call, correct at this stage, but the table does assemble a readership
graph for personas we host, which is the same already-possible/already-assembled line trust had
to respect - so pruning to a window is owed before any node hosts strangers, and is ledgered.

## The wire between a post and its readers (2026-08-05)

Fan-out is real: a post published on one node lands in a follower's journal on another, with
nobody on the follower's side asking - 445ms across two nodes in the test, and every table built
this week is load-bearing in the path. The frontier map notices the public lane moved; the demand
record says which nodes to tell; the exchange carries the entries; the subscription memo says
which local readers follow the author; `feed_journal` writes the arrival.

The design fact worth stating first: there is NO notification message. "Hey, you have a fresh
post" never crosses the wire - the push is the ordinary sync exchange, the receiver's own gate
validates what arrives, and the receiver's own journal write IS the notification. Evidence
crosses wires; opinions stay home. Zero new protocol, again.

The trap dodged, worth the paragraph because it nearly wasn't: the push hangs off the FRONTIER
MAP's edge, not the eager loop's debounce. The eager tracker fingerprints every chain including
private ones - that is its job, it keeps a persona's own devices current - so a dial hung there
would ring strangers' doorbells on every private save, and the TIMING of those dials leaks
exactly what canon holds private: the count and cadence of private activity. The frontier map is
public-only by construction, so its edge is the one that may be heard off-membrane.

The other half was acceptance. The responder served only identities it agents; a push for a
persona we merely follow bounced off the guard as a polite empty exchange. Acceptance widens to
"agented, or followed by someone here, or previously fetched" - and the disclosure cost is
nothing new, because accepting for a wanted persona reveals only the node-level interest our own
fetch already disclosed the day it created the want. The planted violation confirms the widening
is load-bearing: narrowing it back kills exactly the cross-node push test while the device-mesh
tests stay green.

`feed_journal` is DELIVERED, not SEEN - node-local pipeline bookkeeping, disposable, rebuildable
from subscriptions x held lanes. What the human actually looked at is a user fact that travels on
their private chain, and deliberately does not exist yet (Two cursors, not one). No ordering, no
ranking: the journal is honest about what came, and how a feed READS is decided when its reader
opens it, in their own database where the interest dials live. "Don't show" (interest zero)
journals nothing, and the test proves the silence is a decision rather than lag by settling on a
real follower's journal growing first. Backfill is bounded by construction: the journal window is
the shelf's newest page, so following someone with years of history journals twenty posts, not a
life story.

One Rust scar: the fan-out future contains an exchange whose ingest can call back into fan-out,
so the type contained itself and could not be named. The knot is cut at the function boundary -
`after_public_move` returns a boxed future, with a comment saying the erasure is load-bearing.
The runtime cycle was never dangerous: an up-to-date peer exchanges nothing, received stays 0,
and the chain goes quiet.

Still owed, now with the substrate under it: the feed READ surface (the UI, ordering by the
reader's own dials at open), seen-state on the private chain, demand retention, and
rebroadcast - the push deliberately fires only for personas this node AUTHORS, because relaying
someone else's lane onward is a consent question, not a routing one.

## One table for every face (2026-08-05)

Curtis asked whether rendering "who wrote this" in a feed would open the author's database per
byline - and it would have, because the contacts join was ALREADY doing exactly that, live, per
stream snapshot: `contact_self_claims` opened every contact's encrypted file on every gather to
re-learn names that almost never change. The fan-in warning in the Data Layer, running in
production as the People roster.

`persona_profiles` is his proposed fix, built as the memo idiom's fourth instance this week: the
most recent public name and avatar of every persona the node holds, refreshed on the frontier
map's edge - a rename IS the PROFILE_PUBLIC service moving, which is exactly what fires it, so
the per-service split of the frontier table pays for the second time. Public facts only, by
construction: name and avatar are the registers the anonymous /id face already serves to
strangers, so the cache discloses nothing. Write-on-change (the frontiers lesson), so
`updated_at_ms` means the CLAIM moved, not that somebody looked.

The contacts join now reads the cache - one query for the whole roster instead of one database
per face - which means the cache shipped with a real consumer on day one rather than as
speculative substrate, and the future feed's bylines are already paid for: `bylines(roots)` is
the query a feed list will make.

The near-miss worth recording: the full suite passed after the repointing, and that meant
nothing, because no test had ever pinned the name join. The green was vacuous. Three tests now
pin it - the cache learns a rename unasked, the stamp moves with the claim, and the roster read
through the live-cache stream (the way the browser actually reads it; there is no HTTP contacts
endpoint) wears the cached name. The planted violation kills all three.

## Thrash becomes a deliberate act (2026-08-05)

Curtis, after the byline cache: it would be very easy to walk into database thrash again by
accident. It would - it already happened once, silently. The contacts join shipped opening a
database per face, ran in production, and was caught only because a design conversation about
feed bylines walked past it. The suite was green the whole time, because thrash is slow, not
wrong, and no test measures slow.

A grep cannot see "inside a loop", so the defense pins the next best thing, in the house's own
idiom: a conventions test that holds the exact set of `user_dbs.get` call sites, per file, per
count. Adding one fails the build until the number is bumped in the test - and the bump is the
designed moment of reflection, with the question printed in the assertion message: does the new
call run once per request, or once per persona? The first is fine; the second wants a memo table,
and the four precedents are named where the decision happens. The rule also now lives at the
point of temptation (a doc comment on `UserDbManager::get` itself) and in STYLE.md as "one
question, one database".

The test's own first draft had the bug its comment now warns about: a line-based grep
undercounted the call sites, missing exactly the newest ones - they're line-wrapped by rustfmt
(`state\n.user_dbs\n.get`). The count is taken over whitespace-stripped source for that reason,
and the near-miss is recorded in the comment so the next survey doesn't repeat it.

What this deliberately is not: a runtime tripwire. An eviction-rate warning on the handle cache
would catch the dynamic case (a pinned call site that grows a loop around it), and it may be
worth having when a node first hosts real load - but a static pin that fires at build time
beats a log line nobody reads, and the one incident we have would have been caught by this one.

## Known around here (2026-08-05)

Curtis, looking at the byline cache: because it maps what the node KNOWS ABOUT rather than what
it contains, can it be a proto-discovery surface - "here are some known identities"? It can, and
it is now: GET /api/directory for members, and a "known around here" shelf on the People app
below your own roster - the node introducing you to who it knows, which is the first concrete
answer to the closed-room worry Curtis has been carrying since the inbox conversations.

It is also the first surface ANYWHERE that enumerates identities - everything before it answered
only about roots you already knew, and volunteering roots is a new act - so its rules are
consent lines, each pinned by a test:

- **Born-dark stays dark.** A hosted persona lists only once SERVED: `served_at_ms` is the
  publication act, and it gates local listing for the same reason it gates the DHT record - a
  housemate's dark pseudonym must not be volunteered to housemates. The planted violation
  (listing hosted instead of served) fails exactly this test.
- **Quiet follows never list.** The subscriptions table is not consulted; a discovery list must
  not be a way to notice a quiet follow.
- **The fetch trail is node-level and anonymous within the node BY CONSTRUCTION.** Fetched
  personas appear - acquaintance is the surface's whole value - but `foreign_fetches` has no
  account column, so a row says "someone here has met them", never who.
- **Members only.** A stranger enumerating who a node knows would be reading its members'
  interests; the anonymous face keeps tombstoning everything it already tombstoned.

Bylines come off the cache, and the thrash rule held by counting: the endpoint makes zero
`user_dbs.get` calls, and the UI hands each directory row down as PersonRow's `profile` prop -
the designed no-refetch path - so a fifty-face shelf is one query and one HTTP fetch, total.

Deliberately modest: this is browse-discovery among the already-adjacent, not search. Finding a
SPECIFIC identity from a bare root is the resolution ladder (signpost rung, root-directory
backstop, still owed), and graph-shaped discovery - friends-of-friends via published follows and
vouches - is Tier 5's to build on edges people chose to publish. The directory is the humble
floor under both: the node is allowed to say who it knows to the people it hosts.

## The feed, first draft (2026-08-05)

The read half of fan-out: /home/feed's main area is now THE feed - everyone you follow, and
you, in strict reverse chronology, scrolling down into the past. Drafted under a design premise
Curtis stated outright and the code repeats: "how do we generate a good feed" is a
million-dollar question and an open research problem, so this draft does not rank. Chronology
is the whole ordering, and the reader's interest dials shape RENDERING only - a low-interest
source is smaller, a little transparent, and cut to its lead paragraph ("the whole thing" opens
it); a high-interest source gets a touch more visual importance and is never cut. Order never
moves. All pure and vectored (emphasisOf, leadOf, mergeFeed, feedCursor), with the never-cut-
the-important rule pinned by a planted violation.

The server half is one endpoint over the arrival journal: strict keyset pages, byline joined
from the cache (zero databases opened per face - the conventions counter never moved), seen
joined from the reader's own private chain, `mine` flagged. Your own posts appear in your own
feed as if you had written them - which you did - by the journal simply including a hosted
author among their own readers; they arrive pre-seen, because you were there.

Seen-state went where the schema comment promised it would: the reader's `feed_seen` registers
on their PRIVATE chain, written through the ordinary KV surface (nothing feed-specific writes),
so a mark travels to their other computers - Delivered stayed node-local in the journal, Seen
travels with the human (Two cursors, not one). Marks happen when an item actually enters the
viewport, once ever per item; jsdom has no IntersectionObserver, so the instrument's honest
degradation is that nothing auto-marks there and the probe marks by hand. The "only what's new
to you" toggle filters client-side over loaded pages.

Item links go to the author's page for now - which fresh-syncs them on arrival, most of what
the eventual per-item page owes - titled items link from the title, untitled ones from a quiet
foot line. The per-item page, with its own fresh-sync, is ledgered.

The probe lied twice before the app was proven right: it read emphasis classes before the
mirror's contacts had arrived, and held element references across re-renders that replaced the
nodes. Re-query after every wait; a stale reference reads the page as it was.

## A vibrant fake network, on tap (2026-08-05)

Every schema wipe cost Curtis his hand-built test users, and rebuilding a believable network by
hand is exactly the labor a generator should do. `just test_data [personas] [actions] [seed]`:
finds every booted dev node by health check, births N named personas per node (one account
each), then runs interleaved rounds where every persona draws an action from a weighted hat -
public posts (some untitled, on purpose), cross-node follows done the way a human does them
(from the person's page, which is also the fetch that makes the follow feed-capable), trust
with occasional published consent, untrust and unfollow, private notebooks and private writing,
going public, and spreading onto another node via the real adoption ceremony.

Extensibility is the design center, stated at the top of the file: an action is one entry in
ACTIONS - name, weight, async run(ctx, persona, rng) - because "populating a vibrant fake
network" is a permanent testing need, not this script's one-off shape. Deterministic by seed
(same seed, same network), so a bug found in generated data can be regrown. Credentials land in
harness/testdata-state.json (gitignored), one password for everyone, so any generated persona
can be logged into by hand - which is the point: this exists so a human can walk around in a
populated world. Marquee images are the ledgered TODO; lorem prose ships first.

Proven by census rather than by exit code: a 5x12 run across two nodes produced 11 identities a
side (births plus adoptions), twenty-odd subscriptions each, published trust edges, and 71-97
feed-journal rows spanning 12-14 distinct authors - foreign posts crossing nodes into local
feeds with nobody asking, the whole week's plumbing exercised by accident, which is what a
generator is for.

It also flushed out a dependency it never should have had: the generator imported boot.mjs for
its cookie fetch, and boot.mjs imports jsdom - a fake browser, for a script that never opens a
page - which broke on an older system Node before a single line of the generator's own code
ran. The HTTP half now lives in harness/http.mjs, browser-free (boot.mjs layers jsdom on top,
one cookie-jar implementation as before), and the recipe preflights the interpreter with a
sentence - "needs Node 18+, found vX at <path>" - instead of a stack trace from cssstyle.

And it found a product gap within minutes of existing: the first-born persona's feed held only
their own posts, because journaling hangs off the frontier EDGE and a follow moves no frontier -
a fresh follow's feed stays empty until the followee next posts. Ledgered with its one-call fix.
A data generator that surfaces design gaps on its first run has already paid for itself.

## The operator is not an attacker (2026-08-05)

`just test_data` against the real dev network died on its third registration: the rate limiter
allows two registers per hour, and it was doing its job - against the wrong audience. The
limiter exists to stop one IP hammering account creation from the NETWORK; a loopback caller is
the operator or their tools, and the generator registering a hundred personas is the intended
customer, not an attacker being merely tolerated.

The fix is the password floor's posture applied per-request: `check_ctx` exempts a request that
is loopback AND unproxied. The second condition is load-bearing, not decoration - behind a
reverse proxy every request arrives from loopback, and exempting bare loopback would turn "no
limits for the operator" into "no limits for the world". A proxied request announces itself via
X-Forwarded-For, so its absence plus a loopback socket means the operator's own machine; a proxy
that STRIPS the header would still fool this, which is one more thing the security pass gates
public exposure on. Three unit tests pin the triangle: direct loopback exempt (v4 and v6),
loopback-behind-proxy limited, the network limited.

An editing scar worth its sentence: the first fix verified as broken, because the edit script
asserted on a call site that didn't exist AFTER performing the register replacement in memory -
the throw skipped the file write, so the change tested was half-landed. The live re-test caught
it, which is why the live re-test exists.

## The log learns to end (2026-08-05)

The fifth slowdown term from the fake-network autopsy, taken first because it multiplies the
other four: nothing ever checkpointed the databases, and one generator run left node.db with a
568MB WAL over a 12MB main file - every read afterwards paying the difference, the whole node
feeling quadratically slower as the log grew.

The subtlety is that turso is NOT failing to checkpoint. Its auto-checkpoint (1000-frame
threshold, on by default) runs in passive mode, which bounds WORK - pages get backfilled into
the main file - but never the FILE: only a TRUNCATE checkpoint cuts the log. So the node was
dutifully maintaining a WAL that grew forever anyway. `Db::checkpoint()` issues
`PRAGMA wal_checkpoint(TRUNCATE)` (drained with fetch_all - the pragma answers a row, and an
undrained statement wedges the shared connection), and a sixty-second loop walks node.db plus
every OPEN user handle. The warm set only, deliberately: a cold file's WAL only grows while
written, writes only happen through an open handle, and the next open puts it back on the walk -
reopening cold files to maintain them would be the thrash the handle cache exists to prevent.

Proven twice. A unit test writes 300 fat rows, checkpoints, and asserts the FILE shrank tenfold
while the data still answers - pinning the mode distinction, since a passive checkpoint passes
the work test and fails the file test. And live: a seeded scratch node's WAL went 4.6MB after
load to 109KB after one pass, with all ten user WALs cut to zero.

## Events for latency, sweeps for recovery (2026-08-05)

Curtis, watching a polluted node run SLOWER than a clean one with the extra personas doing
nothing: reopening every database on the node every tick is itself a design smell - why are we
doing that at all? The audit his question forced found the answer was "mostly for nothing, and
once for a bug".

The ticks exist as the correctness backstop behind "nudging is pure latency, never correctness".
That doctrine is right; what was wrong is that the backstops were frequent AND expensive - the
frontier sweep opened every known persona's encrypted database twice a minute, and the
subscriptions sweep paid a keystore unseal per persona per minute, all to learn that idle
personas were idle. A recovery mechanism should be rare and nearly free; ours was neither, which
is why two hundred RESIDENT personas taxed a run they took no part in.

Worse, one tick was load-bearing in disguise: a contact dial turned on one device reaches the
persona's other devices by sync, and ingest never rings the nudge bus (relay damping) - so the
subscriptions memo only learned about cross-device dials from the 60-second everyone-sweep. The
backstop was masking a missing event hook. The hook exists now (post-ingest, both ends of the
exchange), pinned by a two-node test that only passes through it: the tick is ten minutes,
so the settle window expires long before a backstop could fake the event.

Three changes, one shape - make events complete, make backstops cheap:
- The missing ingest hook, above.
- Backstop sweeps STAT before they OPEN (`loops::FreshnessMarks` + `db_mtime_ms`): a file's
  mtime is readable without decrypting anything, so an idle persona costs a stat, never an open,
  never an unseal. Marks record what the files looked like when the fold STARTED, so a write
  landing mid-fold is redone once rather than skipped forever. In-memory, boot resets it, and
  the first sweep after boot folding everyone is the catch-up every loop wanted anyway.
- Nudge COALESCING in periodic_nudged: one action is several appends, each ringing the bell,
  and each ping ran a full pass - up to nine redundant refreshes per action across the three
  nudged loops. The drain dedupes a burst by root; four pings across two roots is two passes.
  Bus capacity went 16 -> 1024, because a lagged receiver falls back to sweeping everyone.

Measured on a scratch node: 60 resident personas, then a 200-action run over them - 20ms an
action, flat across rounds, where the polluted dev trio had been at 125ms and climbing. The
remaining floor is durability, not waste: each action is 1-3 chain appends, each an fsynced
journal frame, which is the never-lose-words contract being paid for at macOS fsync prices.

## The fact was in hand (2026-08-05)

Curtis, pressing past the stat-guard: the ticks are rarer, but why does anything open every
user database at all - what does a sweep actually NEED from in there? Enumerating the answer
exposed the real smell: one head-hash per chain, a handful of dial values, a page of titles -
and every one of those facts was in somebody's hand, in plaintext, at the moment it was
written. We were throwing them away and re-deriving them later from the encrypted file.

`chain_heads` is the first correction: the tip of every chain, for every persona, fed at WRITE
time by the three places entries change - the local append (imaol), the sync gate's store, and
the gate's eviction - each of which holds the tuple as it acts. The frontier map now derives
entirely from node.db: the event path opens no per-user file, the per-write GROUP BY over the
whole entries table is gone (both of them - the fingerprint read and its ingredient), and the
backstop sweep's only remaining open is RECONCILIATION, for stale roots only, through the
owning module's door (`sync::chain_ranges` - the conventions test caught the reconciler
reading `entries` directly and was right).

Private chains included, and the doctrine got sharper rather than quietly dropped: Curtis
called the "already-assembled" hedge overweight, and he was right for a reason worth pinning -
node.db and every user database are sealed by the SAME keystore, so an attacker who can read
the memo already holds the key to everything it summarizes; on-disk dispersal bought
milliseconds. The rule with actual force is the WIRE: private heads go only to member-proven
peers, one predicate, enforced at egress. Foreign personas appear public-only in the memo
automatically, because the exchange never gives us their private chains to store.

The honest cost is the system's first deliberate dual-write: a user-db commit and its memo
note cannot be atomic across two files, so a crash between them leaves the memo one write
behind - which is now precisely what the backstop is FOR, the first real job it has had since
the ingest-hook fix. Planted violation confirms the feeding is load-bearing: severing the
append-side note fails fourteen integration tests, because every frontier, fanout, and feed
test settles in seconds against a ten-minute tick and only the write-time path can carry them.

Schema generation 6 - one more wipe, regrown in seconds by the generator that started this
whole excavation.

## The feed learns when to move and when to hold still (2026-08-06)

Curtis's post never appeared in his own feed - the stream fetched once on mount and never asked
again - and his design for fixing it drew the line exactly where attention lives: a list you are
READING must never move under you, and a thing you just POSTED must appear instantly, because
"seeing the thing I just posted" is the feedback that says it really happened.

Both halves landed. Arrivals are detected by a slow poll (and on window focus - coming back to
the tab is when "anything new?" is the live question) but never shown: they wait in a reserved
bar reading "3 updates · refresh". The bar's space is HELD at fixed height whether or not it has
anything to say, so even its appearance can't move a read position. Your own post is the one
exception, prepended the moment the server confirms - your attention is already at the top, so
the popping-in objection doesn't apply to the thing you just did - and the synthesized item
carries the same key the real journal row will, so the poll's later copy dedupes instead of
doubling.

The design got simpler mid-flight because Curtis caught me building on a false premise. I had
invented a "pinned outside chronology" slot on the theory that a public post inherits its
draft's creation date - a draft begun yesterday would sort below today. It doesn't: publication
MINTS a parentless public document stamped at publish (copy-don't-flip means the private editing
history never enters the public date), so a first publication tops the feed by plain chronology
and the pin was solving a conflict that doesn't exist. Re-publications keep their original date
and deliberately do not jump - "dated by when it was said" holding exactly as ruled.

One casualty of the interrupted build: the rejected edit's CSS had already landed, leaving
orphaned pin styles and a duplicated bar block - which the dead-CSS convention caught by name,
as designed.

## Further back reaches the past (2026-08-06)

The feed's "further back" button did nothing, and the nothing was two bugs stacked so neatly
that each hid the other. The server's keyset query used numbered placeholders with ?2 appearing
twice - which binds ONE value - while the code passed five values into four slots, and turso
refused with "bind index 5 out of bounds". Only the CURSOR branch has that shape; the first page
never takes it, and no test had ever paged the feed, so the 500 lived exclusively behind the
button. And the client's catch was silent by design ("a failed page leaves what's shown"), which
turned a server error into a button that simply did nothing - hiding the bug from the user AND
from the developer, which is the same lesson the "storing entry" error taught on the other side
of the wire: an error a human can't see is a bug that gets to stay.

Three fixes: the bind (four values for four slots), the silence (the button itself now says
"couldn't reach further back - try again"), and the test gap (an integration test that fills
past a page and walks the cursor branch, asserting page two arrives and never repeats page one).
The shelf pagination one module over never had this bug - it uses bare positional placeholders,
where marker count IS value count and the mistake cannot be written.

## One card for a post, and the editor found its way home (2026-08-06)

Curtis: the edit UI for our own posted feed items vanished in the feed rework. It had - worse,
the comment that retired it pointed editing at "the persona page's business", and the persona
page had no editor. A regression narrated instead of caught, possible because the feed and the
persona page rendered two DIFFERENT cards for the same thing, so an affordance could die on one
while the other never had it.

The fix is the ruling Curtis made when he caught it: one card, everywhere a post is shown.
`PostEntry` (js/postentry.js) is now the entry both surfaces render - banner on every post,
redundant on your own page and accepted - and the editing machinery is a shared hook
(`useOwnPostEditing`) either surface wears. The hook is where the membrane crossing lives: a
card names the PUBLIC document, editing means opening the PRIVATE note it was minted from, and
the `published_as` annotation is the thread the hook follows through your own mirror. The
Journal's fifteen-second unlock guards the door in both homes, "post the changes" re-publishes
in place, the card refetches its own words when the editor closes, and the seal re-locks so the
next edit costs the ceremony again.

The feed decorates the hook's lookup with its local publication overlay, so a post made seconds
ago is editable before the stream echoes it back. The probe drives the whole ceremony in BOTH
homes - unlock, editor-in-place holding the words, post-the-changes, close, re-seal - and
confirms the world still sees exactly one post after two rounds of editing.

Moving out retired the persona page's bespoke post card; the dead-CSS convention named all six
of its orphaned classes on the first run after, as designed.

## Your own words don't need fetching (2026-08-06)

An edited post showed its old words until a page refresh, and my first fix ran the wrong way:
refetch the body after the editor closes - a server round trip to show a user what they had
just typed. Curtis cut it down to its shape: the client HOLDS the new words, the publish's 200
IS the confirmation, and any later refresh reconciles against the canonical fold for free. So
the composer now hands its buffer along with the post ("the words ride along"), and the card
displays exactly what was confirmed - no refetch, no race with folds or caches, editor staying
open with the buffer intact if the publish refuses.

Two real bugs surfaced on the way and both got fixed. The public body route was serving
`immutable, max-age=1y` on a URL addressed by DOC ID - whose content changes on every edit; only
the blob underneath is content-addressed. That promise meant OTHER readers' browsers could hold
an edited post stale for a year. It now serves no-cache with the blob hash as the ETag: an
unchanged body costs a 304, an edited one arrives the moment anyone asks. And a
temporal-dead-zone crash (`tlProfile` reading `shownBody` before its declaration) sailed through
eslint and 343 green jsdom tests - nothing mounts the card in the unit layer - and died on first
real render; the probe caught it because the probe renders.

The editing scars compounded once more: an edit script aborted mid-assertions AFTER its early
replacements, writing nothing - so the handler expected words the composer never sent, and the
card showed one edit behind. The probe's stale-title symptom diagnosed it. Two turns of this
session have now been spent on half-landed multi-replace scripts; the discipline going forward
is one replace per write, or verify the write happened before building on it.

## The membrane learns about media (2026-08-06)

Publication's copy-don't-flip crossing now extends past the words to what a post EMBEDS. A
public post may not lean on a private blob (a stranger following the link gets ciphertext they
can never open) or on a foreign server (gone tomorrow, changed silently, watching its
referrers) - so at publish time the body is walked with the Marquee reference parser (our own
crate, off crates.io, pinned like turso; the AST, never a regex - the markup repo keeps
adversarial examples precisely to punish pattern-matching) and every media embed is BAKED:

- A PRIVATE media document gets a public twin, inline and in milliseconds: its already-crushed
  bytes decrypt and re-mint via save_public_media, remembered on the private doc's
  published_as annotation - media publication IS publication, the same one door, the same
  reuse (a second post embedding the same image shares the twin).
- An EXTERNAL image or audio URL is downloaded under the unfurl module's SSRF posture (vetted
  public address, pinned resolution, re-vetted redirects, hard size cap; loopback permitted
  under LOCAL_TEST and nothing else), crushed through the SAME pipeline uploads take, and
  minted public by the node's own leaf - the ingest worker's session-free path. The bake
  registry (media_bakes, node schema gen 7) is pipeline state AND provenance: where the bytes
  came from, when they arrived, deduped so the same URL across posts bakes once. Provenance ON
  the public header is ledgered for the next deliberate wire break - DocHeaderPlain is
  fixed-arity CBOR, and a new field today would invalidate every existing header, journals
  included.
- VIDEO is refused, both kinds, with an honest tombstone - the agreed scope line.

The published body is REWRITTEN to the twins' anonymous /id targets (which grew the
decorative-filename route the renderer's kind-sniff needs); the private draft keeps its private
links untouched, because the crossing mints, never moves - the probe pins both directions.

External bakes are slow, so publish became honestly two-phase: 202 with the item list until
everything lands, re-POST as the idempotent "how's it going", 200 with the post only when the
post can actually stand. The composer's "preparing media for the network" modal rides that
loop - every item, its kind, its live crush percentage from the same meter uploads use, its
tombstone on failure (Post again re-arms the retry). Driven end to end twice: the API contract
in the integration suite, and the human path in a probe - click Post, watch the modal appear,
watch it clear, watch the post top the feed.

The thrash sentinel earned its keep once more: it flagged the bake worker's user_dbs.get the
moment it was written, and the ledger bump records the verdict - one open per bake job, the
ingest worker's own pattern.

## The composer grows up (2026-08-06)

Media baking shipped with no way to put media INTO a post - the composer was a title box and an
editor pane, built bespoke while the notes editor next door had everything. Curtis's ruling cut
the duplication at the root: both surfaces point at a private document, so the features come
over WHOLE. The Composer is now the real Editor (doc/editor.js) wearing Feed's clothes, and the
tailoring was already sewn: the app registry's feature block - written when Feed was born -
declares `date: false` (a post happens NOW; nobody claims a date for one) and `pin: false`, and
the Editor has honored feature blocks all along. One new seam was needed: a `foot` render-prop,
so the Post button lives inside the editor's chrome, flushes the session's save, and carries
the confirmed words out.

What arrived free, probed live: the format-convert chip (marquee <-> plaintext), the upload
chip with drop-and-paste-inline, tags and description in the meta dropdown WITH the date field
absent, view modes, the crosslink chip - and delete, which on the open draft simply clears it:
the one-draft rule mints a fresh page the moment the old one dies (the fresh-post overlay
learns to stand down so it can't resurrect the dead draft). The in-place edit composer on
published posts inherits everything except delete, deliberately - removing the private twin of
a published post is not a card-level gesture.

The full circle, live: upload a real PNG through the pipeline, embed it in the open draft,
click Post - and the baked twin serves to a stranger as image/avif from the /id path. The
feature that motivated this (yesterday's media baking) is now reachable by hand.

Probe scars, small but recorded: jsdom has no window.confirm (the delete dialog needs a stub -
a human clicking through it is the same yes), and placeholders aren't textContent (the meta
panel looked empty to a probe reading the wrong property).

## The editor learns to be narrow (2026-08-06)

Three refinements from Curtis watching the composer squeezed into its column, all landing on
every editor surface at once because the composer IS the notes editor now:

- Under 400px of width the title gets the whole first row (crowded beside the chips it had
  become uneditable) and the view-mode tabs step aside. Measured with a CONTAINER query, not a
  media query - the composer lives in a draggable column, so the squeeze is a property of the
  column, and a viewport rule would answer the wrong question.
- Wherever side-by-side is offered, the plaintext tab is hidden: side-by-side contains the raw
  source already, so plain was a duplicate crowding the row. A plaintext-format document never
  offers side-by-side, so plain survives exactly where it is the only way to edit.
- The feed's editor drops read-only: a post's read view is the feed itself.

The mode-availability rules moved from the editor's closure into pure/apps.js (`editorModes`),
vectored, with the plant confirming the side-hides-plain vector bites. The plant also taught a
build-chain lesson the hard way: `just ui-check` REBUILDS the bundle, so a planted violation
followed by a source-only restore leaves the violation LIVE in the embedded JS - the re-probe
was green-source, planted-bundle, and read exactly backwards until the recipe chain was reread.
Restore means rebuild.

## Narrow mode, actually (2026-08-06)

The first narrow-mode shipment was broken in the exact way the index.css header warns about:
the @container block lived in notes.css, editor.css imports after it, and a container query
adds no specificity - so the tabs' own display rule won the cascade and narrow mode never
fired. Worse, the unconditional flex-wrap added alongside it made mid-width headers LOOK like
narrow mode, which is why it appeared half-working. The block now lives in editor.css after the
rule it overrides, and the wrap is scoped inside the query.

Also per Curtis: the feed composer's column floor is 260px - below that the editor's chrome
crushes even in narrow mode. panes.js grew per-column minimums, applied to drags AND to
previously-stored widths, so a pref written under the old 140 floor honors the new one on read.

## 2026-08-06: the follow lifecycle earns its feed consequences

Three fixes in one sitting, all at the seam between the public lane and the feed.

**Media documents are not posts.** Publishing a post with baked media mints the media onto
the same public lane as the post - and every listing surface (the /id shelf, its pager, and
fanout's journaling) listed it as if it were one, rendering AVIF bytes as text. The filter
went into `public_docs` itself (the one shelf query all three consumers share): text formats
only, in SQL, so keyset pages stay full and media is never journaled into feeds at all.
`feed_page` grew the matching guard so journals written before the filter are harmless -
no data wipe needed. Plant-validated live: with the shelf clause neutralized, the probe
reproduced the field bug on the shelf while the feed guard independently held the line.

**A new follow backfills at follow time.** Journaling hung off the frontier edge, and a
follow moves no frontier - worse, the common gesture (follow from their /id page, which
resynced them on visit) guaranteed the follow-moment sync received nothing. Now the
subscription memo's rewrite diffs the eager set (eagerness > 0, the feed criterion - narrower
than `keep`) and a silent-to-eager crossing journals the author's newest page to that one
reader via `fanout::backfill_follow`. Same burst-to-bound as ever: their latest page, not
their life story, interleaved at original published_ms. Infallible by design - a followee
whose shelf isn't here yet just waits for the first real sync to fire the normal edge.

**Unfollowing excises.** The same rewrite's delta drives `fanout::excise_unfollowed`: rows
from authors outside the current eager set are deleted in the same breath that drops the
subscription - "don't show" means it retroactively. Own rows are exempt (your posts are in
your feed because you're hosted, not because you follow yourself), and nothing anyone owns
is lost: a re-follow backfills the page right back. Live-probed on a scratch node: follow
backfills Alpha+Beta, unfollow leaves only "Mine stays", re-follow restores all three.

## 2026-08-06: a repudiation reaches the feeds

ChatGPT pitched an integration test with a sharp prediction: eviction rebuilds the VIEWS
(doc_heads refolds, the shelf heals), but feed_journal is a delivery memo, not a view over
the log - so a repudiated device's post that had already crossed into a follower's journal
would keep rendering as live content, laundered by the delivery record. Code reading
confirmed it; a planted probe (retraction disabled) reproduced it live: after the strike,
doomed-post sat in Alice's own feed forever.

The fix is `fanout::retract_vanished`, on the same edge as journaling: after every public
move, the author's journaled doc_ids are checked against `documents::public_doc_ids` (the
fold's current truth) and rows whose documents are gone are DELETED - no tombstone, same
doctrine as the unfollow excision: the rows are bookkeeping, and a "previously delivered"
marker would keep disproven words in the room under a politer name. The reconcile covers
any future public-lane shrink (retraction, unpublish) for free.

Pinned by a three-node integration test in repudiation.cjs (senior + doomed device + a
follower on a third node who hears everything by push) and probed live on scratch nodes:
pairing, posts from both devices, strike from the senior - the disowned post leaves the
feed, the honest one stands. What was NOT built from the pitch: replay-resistance and
rebuild-from-journal assertions (already pinned by the existing repudiation suite) and the
restart-invariance one (the journal is durable SQL; deletion is trivially restart-safe).

## 2026-08-06: the two-hop body race

ChatGPT's second pitch, and again the mechanism analysis held up under code reading: headers
ride entry sync, bodies ride iroh-blobs in a separate after-exchange pass - and on the
responder path, fan-out (push headers onward) fires BEFORE the spawned body backfill. So a
post authored on a second device could reach a follower two hops away as a journal row whose
body dial-back found nothing - and since the follower only ever RESPONDS (it never initiates
sync for a mirrored persona) and its dial-back was gated on entries-received, it stayed
bodiless until the author's next post. Even the pitch's sharpest claim was literal: the body
backfill's comment says "Bodies arrived without any frontier moving" and bumps only the
local view epoch.

Two small changes close it, pinning the property (the pitch's option b) rather than
reordering the pipeline: (1) a fruitful body fetch re-rides `after_public_move` on both
sides of an exchange - bodies arriving here may be the bytes a node downstream is waiting
on; (2) the responder dial-back is ungated - every inbound exchange is a chance to finish,
and the walk exits at one query when nothing is missing. Fan-out still pushes headers
immediately (notification speed is a feature); the body follows one poke behind.

Made deterministic with a LOCAL_TEST-only knob (RINGTOME_TEST_BODY_LAG_MS holds the middle
node's body lane open) and probed on three scratch nodes: journal row lands with the body
404 in the race window, then the body arrives with no manual sync and no second post.
Planted (old gate restored): the body never arrives - the exact permanent bodiless state
predicted. Pinned knob-free in the integration suite as a two-hop liveness test (adopt
ceremony + third-node follower + body resolved through the follower's own serving route).
Residual ledgered: the recovery-sweep half (retryable source set) for the transient-failure
case.

## 2026-08-06: the gravedigger's ledger

The body-lane recovery backstop, closing the residual the two-hop fix opened. The design
came out of conversation: the body walk already computes each persona's missing set on every
exchange and threw it away - now it records the shortfall in `missing_bodies` (node.db, gen
8), replace-set per persona, so satisfied rows clear on arrival by any path and rows for
vanished documents clear on the next look. The memo IS the guard: the sweep's worklist is
one query, an empty ledger costs nothing, and no stat-marks are needed.

The sweep (net::bodies, "the gravedigger's rounds", 300s beat) takes each due persona,
guesses who might hold the bytes - the via that answered our fetch, the nodes that asked us,
the device peers; all three already knew of our interest, so asking discloses nothing new -
and runs the ordinary body walk at each candidate until whole. Backoff (30s doubling to an
hour) lives in tries/last_tried_ms, which belong to the sweep alone; walks reconcile
membership only, so exchange churn never resets the ladder. A fruitful round re-rides the
fan-out edge, same as any body arrival.

Probed end to end on three scratch nodes with the failure the backstop exists for: B loses
the race (A1's body lane lagged), then misses the poke (SIGSTOPped through the window),
resumes bodiless with nothing ever dialing it again - and heals by its own rounds, confirmed
by the sweep's own log line rather than inference. Five unit tests pin the ledger semantics.
NOTE: node schema generation bumped 7 -> 8; dev node.db rebuilds on next start.

## 2026-08-06: equivocation - detected, contained, adjudicated

ChatGPT's third pitch, the protocol-level one, and the strongest: equal-height public forks.
Every mechanical claim verified. The wire's Frontier carries head_hash precisely because two
forked chains at one height agree by range arithmetic - detection was built, response wasn't:
send_missing reduced peer frontiers to (author, service) -> head and sent from head+1, so
two nodes holding different branches at the same seq each concluded the other lacked nothing,
forever. And the resync tracker's change fingerprint omitted head_hash entirely, so even a
resolved fork (same-height replacement by eviction) read as "nothing moved".

The doctrine was already settled in PROJECT_PLAN ("forks are self-proving... a fork on any
single chain condemns the key"); what was missing was mechanism, in four pieces:

* **The proof crosses the wire.** missing_for_peer (send_missing's testable core): a peer
  whose claimed head we hold at a different hash is sent our entry at that position - one
  entry, and the receiver holds two valid signatures at one (chain, seq). Works for unequal
  lengths too; only the exact fork POINT goes unfound, and condemnation doesn't need it.
* **The gate records rather than stores.** The Active path's at-or-below-head skip now
  compares hashes; a contradiction writes both signed envelopes to `equivocations` (user db,
  gen 6) - EVIDENCE, never touched by rebuild_views. Neither branch displaces the other.
* **Containment is presentation-level.** While evidence stands on a public content chain,
  public_docs/public_doc_ids return nothing - the shelf goes dark, and everything downstream
  follows free: /id empty, fan-out journals nothing, feed retraction sweeps delivered rows.
  Quarantine on PROOF only, never on a bare fingerprint mismatch - a hostile peer
  advertising garbage must not be able to suppress an honest persona (Unresolvable-with-
  backoff already handles the unproven case).
* **The crown adjudicates.** ingest_batch clears evidence for any no-longer-Active author:
  the revocation's anchors decide honored history (machinery that existed), the quarantine
  lifts, the vindicated shelf returns, and losing-branch replays are the ceiling's problem.
  Plus the resync tracker fingerprint gained head_hash - same-height replacement is movement.

Pinned by the pitched Rust test (net::sync::tests), driving the whole arc: fork -> proof
crosses both ways -> recorded not stored -> shelves dark -> idempotent under re-delivery ->
senior anchors left -> C evicts right and converges -> quarantines lift -> replay refused
without re-arming. Plant-validated (wire branch removed -> proof never crosses -> red).
User schema gen 5 -> 6: user DBs rebuild from journal on next start. Residuals ledgered:
a reader-facing "disputed" notice, and evidence surviving journal rebuilds.

## 2026-08-07: the chain frontier becomes the peer list (discovery, phase 1)

The build that fell out of a week of design conversation (equivocation -> "how do nodes
even know their siblings" -> the discoverability doctrine). The plan always said "the chain
frontier IS the peer list"; the implementation's identity_peers was only ever the adoption
ceremonies' pairwise edges, so a dead introducer partitioned honest replicas forever and a
repudiated device's row was never removed - the eager loop kept dialing the attacker's
machine with fresh frontiers.

What shipped, on machinery that mostly existed:

* **Serving records go universal** (identity/serving.rs): every hosted identity publishes
  its leaf-signed record - at creation, at adoption, and on the republish beat. "Publication
  is an act" is retired for serving records; served_at_ms remains as the HTTP-face flag.
* **The derived peer set** (net::sync::derive_peers_for): Active crown leaves x resolved
  serving records, upserted leaf-bound into identity_peers (node gen 9 adds leaf_pubkey +
  last_resolved_ms); rows whose leaf the crown no longer credits are DELETED - revocation
  finally reaches routing. Runs at adoption and on a 600s beat (LOCAL_TEST override:
  RINGTOME_TEST_PEER_DERIVE_MS). Probed: A adopts B adopts C, kill B, write on C - the words
  reach A with the introducer dead; planted (derive no-op'd), the partition stands.
* **Member-proven dialers are remembered**, leaf-bound from their proof, on both sides of
  an exchange - healing on any contact.
* **Hints become leaves**: the /id face mints ?via= as identity leaves (own leaf first,
  then liveliest siblings by serving-record freshness; endpoint ids remain as filler and
  fallback), and fetch_foreign tries every hint as a leaf (serving record must name the
  target root - a leaf via for the wrong identity is discarded) before falling back to
  dialing it as an endpoint.
* **Bare roots resolve** - the accident that fell out: a founding node signs with the root
  AS its leaf, so its serving record lives at the root's own slot. fetch_foreign gained the
  zeroth rung (the target root as implicit hint), and a stranger node resolved a persona
  from nothing but its root, live-probed. The announce rendezvous shrinks again: needed only
  when the founder is gone.

Pinned by integration/test/peerderive.cjs (3-host ceremony chain -> leaf-bound mesh on both
ends -> repudiation prunes the dial list; the justfile's integration nodes now run a 3s
derive beat) and three probes (peer-derive, leaf-via mint/resolve, bare-root). Node schema
gen 8 -> 9: dev node.db rebuilds on next start.

## 2026-08-07: discovery phase 2 - the edge, the ladder, and the forgetting

Three small bricks that finish making peer knowledge self-healing.

**Derive on the failure edge** (net/resync.rs): an eager push that reaches zero peers is the
loudest possible "your peer view is stale" - it now re-derives the root's peers from tree x
directory on that transition and immediately retries at just the newcomers (freshly-resolved
rows are exactly the endpoints most likely alive). Probed with the sweep pinned an hour
away: A knows only dead B, writes anyway, and the words reach C seconds later - only the
edge could have done it.

**Mirrors re-fetch through stored-tree leaves** (idface.rs): a background revalidation now
widens its hints with the Active leaves of the tree it already holds - the same trick the
member mesh uses, pointed at a mirror. This un-pins a followed persona from the one node
that answered its first fetch. Probed: bob mirrors alice through her founder, the founder
dies, alice posts from her second device, bob's mirror heals with last_via dead and the
zeroth root rung resolving to the dead founder; planted (rung emptied), the mirror stays
pinned forever.

**The forgetting** (net::sync::prune_forgotten_peers, on the derive sweep): a week of
silence on BOTH clocks and a row is forgotten - `last_synced_ms` stale alone would evict
NAT-bound devices that are alive and publishing, so the fresh serving record is the tell
that keeps them; `added_at_ms` grace spares newborns. Safe only because rows became cache
entries over a derivable truth: the leaf set lives in the tree, the endpoint in the serving
record, revocation memory in the chains - a forgotten node that returns re-enters within a
beat. Dead hardware finally leaves dial lists. Unit-tested across all quadrants.

## 2026-08-07: grant codes carry sibling leaves

The onboarding cut-vertex, removed. A grant code now carries up to ten of the identity's
liveliest OTHER leaves (granter's own first, ranked by serving-record freshness; serde
default keeps old codes decoding as "granter or bust"). Completion's bootstrap became a
ladder: the granter's ephemeral addresses first, then each sibling leaf resolved through its
serving record (root-checked, 8s per rung) - and the SECOND pass (the member-proven private
pull) now rides whichever peer actually answered, which the build caught red: it used to
re-dial "the granter" unconditionally, so a sibling-completed adoption 500'd after
registering the identity.

The scenario this buys: the granter dies (or NATs out) between grant and paste. Before, the
newborn was stranded permanently at "initial sync failed" - the authorize was already on the
siblings' chains, but completion knew only one door. Probed properly the hard way: the first
probe version passed its own plant, because in-band grant delivery (net/adopt.rs,
best-effort at grant time) had completed the adoption before the granter died - the valid
probe freezes the newborn's node through the grant, lets the authorize escape to a sibling,
kills the granter, thaws, pastes. Fixed build: 200 through the ladder, log-attributed,
history inherited. Planted (ladder capped to zero rungs): 500, stranded. A probe-timing
lesson worth keeping: a grant whose authorize dies WITH its granter is unrecoverable by
design - nothing anywhere can prove the newborn - so the probe must let the entry escape
first, and that is the protocol being honest, not the test being fragile.

Discovery arc remaining: the root announce rendezvous (founder-dead personas), alone.

## 2026-08-07: the wake pass - follow the person, not the node

Follower-side anti-entropy (idface::refresh_followed_pass, 60s beat): for each followed
persona whose mirror has gone stale, re-fetch through the ordinary ladder - which does both
halves of the reunion in one exchange: pulls what was missed while the laptop was closed,
and re-arms this node on the answerer's push list, because the dial IS the demand signal
("asking is telling" - no new message needed). Steady state is near silent: a delivered push
now stamps the mirror's freshness (sync responder -> touch_foreign_fetch), so an online node
finds nothing stale. Priority per Curtis: personas followed by humans PRESENT AT THE NODE
first (ActivityMarks, stamped by the session extractor, in-memory), then the interest dial
(a cadence dial by design), stalest first - capped at 8 per beat so a hundred users' worth
of follows catches up ordered instead of stampeding.

Two catches worth their ink, both found because plants refused to fail:

* **Phase-1 scope creep**: the member-proven dialer upsert was enrolling MIRRORED personas
  into identity_peers when their devices pushed to us - and identity_peers is the device-
  mesh worklist, so every follower node was quietly running unpaced, unfollow-blind
  anti-entropy for everyone it followed. Exactly the conflation the schema comment warns
  about. Now gated to hosted personas; the wake pass is the follower-side channel, with
  presence, pacing, and the dial.
* **QUIC patience**: a SIGSTOPPED process's UDP socket buffers the push's dial and completes
  it on thaw - a 12s nap wasn't a missed push at all, just a slow one. The probe's freeze
  now outlasts the handshake patience (45s), after which the plant finally failed honestly:
  no wake pass, post missed forever.

Also: the wake pass makes DEMAND RETENTION safe to build - their node can prune quiet
askers aggressively because askers who still care re-ask on every wake. The two halves make
each other's settings correct. Curtis's partition question sharpened both points: the pass
is STALENESS-triggered, not wake-triggered, so a partition just keeps the reunion attempt
standing until connectivity returns - and pruning can never cost data, because the re-ask
is a full exchange that PULLS the pushless window (pushes are latency; the pull on
re-contact is correctness). The question also surfaced a real bug: failures advance no
ordering key, so a partition re-dialed the same top-of-cap mirrors every beat forever while
the tail starved. Fixed with an attempt cooldown (5min, in-memory, boot-reset): the cap
rotates the whole list, partition-time dialing is rate-limited, and heal latency is bounded
by one cooldown.

## 2026-08-07 to 08-08: Popularity Problems - the 50k-follow investigation

Ten entries, kept whole in
**[`history/2026-08-popularity-problems.md`](history/2026-08-popularity-problems.md)**
rather than folded into a paragraph here: the arc is worth reading in sequence, because
almost every fix in it got smaller and better after a question about the first version.

The question was "50,000 incoming follows, 50,000 outgoing - where does this get very slow?"
The audit found the follow ledger assumed small in nine places, one path genuinely O(F
squared), and every existing cap sitting on the read-a-page or dial-a-peer axis with none on
the follow-list axis. What shipped, in one breath: range-walked contact reads and
per-collection private-view readers; delta journaling and chunked upserts; the subscription
memo's megabyte SQL literals replaced by a timestamp and a delta; a 16-dial push cap with a
self-rotating recency order; demand retention; a paging sync sender and a bounded-batch
receiver; per-kind stamps and per-row deltas on the live-cache stream; a search-first
rolodex. Plus two findings that were not about popularity at all - empty databases being
MINTED for never-synced personas, and the `get`-that-creates API shape that made that easy,
now `Option`-returning with minting as its own verb.

Residuals live in NEXT_STEPS (Popularity Problems): wake-pass rotation tiering is the last
popularity-shaped gap; the rest is parked on measurements with its triggers named.

## 2026-08-08: the lint gate learns about test code

`just lint` was `cargo clippy -- -D warnings`, which lints the binary and the library and
never the tests - so sixteen real lint failures had been sitting in test modules on main
without CI noticing, because the workflow runs `just ci` verbatim and `just ci` runs `lint`.
Warnings-as-errors on production code beside zero linting on the code that PROVES it is an
odd seam, and sixteen is an afternoon, so the flag went on and the backlog went away:

* **Eleven `&[x.clone()]` -> `std::slice::from_ref(&x)`** in the sync gate's tests - each was
  cloning a signed entry purely to build a one-element slice.
* **`items after a test module`** in `request_context.rs`, where an `impl FromRequestParts`
  block had drifted below `mod tests`. Clippy and the house rule (STYLE, File ordering:
  "tests at the bottom") wanted the same thing, so it moved rather than being suppressed.
* **A stray `vec!`** where an array does, in the fan-out batching test.
* **Two arity allows, with the reason inline** (`documents.rs`'s `save`/`save_fmt`): taking
  the `Save` struct's fields positionally IS what those helpers are for, at ~40 call sites,
  and handing them a struct parameter would restore exactly the verbosity they exist to
  remove. Curtis's rule for this pass - genuinely exceptional cases may carry "the lint does
  not apply here" inline - and these two are it. An `#[allow]` with a stated reason is a
  decision on the record; an ungated lint is a silence.

Nothing was suppressed to make the gate pass that could reasonably have been fixed instead.

## 2026-08-08: the fold path gets its index

Curtis's 3-node 50x50 test-data run (7500 actions, 647s) showed per-action latency climbing
34ms -> 158ms as the network densified - linear data growth producing a 4.6x slowdown, which
is the signature of per-action work that scans something accumulating. EXPLAIN over the three
hottest queries found the entries table carrying exactly one index beyond its primary key,
and the worst offender not on the sync path at all:

`imaol::entries_past_watermarks` and `entries_of_type` both ask "entries of this (service,
entry_type), in (author, seq) order" - the first on every private and document read (via
`catch_up`), the second on every store open (unsealing epoch keys). The primary key leads
with `author_pubkey`, so neither could use it, and the plan was a raw `SCAN entries` - reading
every row's BLOB bytes off disk - followed by a sorter, over a table that grows with
everything the identity ever writes.

`entries_by_service_type (service, entry_type, author_pubkey, seq)` fixes both: equality on
the first two columns, and the tail columns supply the ORDER BY so the sorter disappears with
the scan. Deliberately not covering - adding `bytes` would duplicate the entire log. User
schema generation 6 -> 7.

Pinned by a plan assertion rather than a timing one (`the_fold_path_reads_seek_and_never_scan`):
it fails on the query's SHAPE, not on how slow the machine felt, which is the property that
makes it safe to run on a shared CI box. Planted by deleting the index - back to
`SCAN entries | USE SORTER FOR ORDER BY`, red, as it should be.

Two known offenders left standing, deliberately: `local_frontiers` (twice per exchange) and
`missing_plan`'s chain list (once) both scan the whole entries table to recompute what the
`chain_heads` memo already holds. Reading the memo instead would be O(chains) rather than
O(entries) - but those two answers back the frontier we CLAIM to peers and the entries we
SEND them, so a memo that ever understates means a peer silently never receives something we
hold, with nothing to heal it. Today they are derived from the log itself and cannot be
wrong. That swap is its own change with its own adversarial tests, not a perf patch.

## 2026-08-08: opening a database stops costing a whole history

Chasing the test-data generator's latency curve past the fold-path index (which bought 2%,
because the benchmark's identities are ~60 entries deep and the scan it fixed had nothing to
scan). The real find was the handle cache: each node ends the 50x50 run holding **150** user
databases against a cache of **128**, so the back half of every run is thrash - and a miss
was O(the identity's entire history), twice over:

* `UserDbManager::open` called `all_entry_bytes` unconditionally - every entry's BLOB, off
  disk - and in the common case (journal populated, database populated) used the result for
  nothing but `is_empty()`. The bytes are needed only on the journal-backfill branch, so
  that is the only branch that fetches them now; the other asks `imaol::entries_are_empty`,
  one indexed probe.
* `Journal::open` read the WHOLE journal file and walked every frame to apply the torn-tail
  rule - a rule its own doc comment calls a one-time act ("once, here - after which appends
  proceed blindly"), which the cache quietly turned into once-per-miss. Torn tails are crash
  recovery; within a process run every byte past the first check was written here as a whole
  frame. `Journal::reopen` attaches for append with no read and no walk, and `UserDbManager`
  remembers which journals it has validated this run. In-memory, so a fresh process - which
  wrote none of those bytes - validates again.

And the cap itself became `RINGTOME_MAX_OPEN_DATABASES` (default unchanged at 128), because
it was never really a magic number: it is a file-descriptor budget, ~4 per open database
(main, WAL, shm, journal), and stock limits run from 256 on old macOS through 1024 on Linux
to 1,048,576 on Curtis's machine - which is where the 399 descriptors a running node was
holding got measured. A userspace p2p node gets whatever the host hands it, so it wants a
knob, and the knob makes the thrash hypothesis testable in one command instead of a
recompile. Deriving it from `getrlimit` automatically is the obvious follow-up and is
deliberately not here.

The plants earned their keep twice over. A lying `entries_are_empty` (always "populated")
correctly killed the journal-replay test. But the first eviction test PASSED with a
deliberately broken `reopen` - capacity eviction in moka is lazy, so the handle was never
actually evicted and the test had been asserting nothing. Rewritten to invalidate the entry
explicitly and assert the cache is empty first; then the broken reopen failed it, as it
should have all along. A test that only USUALLY exercises its path is a test that only
usually tests anything.

Also deleted on the way past: a new test that turned out to duplicate
`empty_db_under_a_nonempty_journal_replays_on_open` outright. That coverage already existed;
what changed is what it guards, so the note went into its doc comment instead of into a
second copy.

## 2026-08-08 — every word the app says, behind one key

The app's copy became addressable. 277 interface phrases and 94 server errors now pass through
`t(key, seed)` and `msg!(code, seed)` respectively, and `js/locales/en.js` is the authoritative
English catalog: grouped by the screen each phrase appears on, the file to read when you want to
hear the house voice all at once, the file to EDIT to change what the app says, and the file a
translator copies to start a language. `just strings-check` (in `ci`) fails when it is out of step
with the source, when a seed disagrees with it, when two phrases share a key, or when copy reaches
a person without going through `t` — so new words cannot land silently, which was the whole point.

The last of those took a second pass to get right. The first cut made the call-site string the
English and left `en.js` generated and unread, which Curtis named as a category error: "default"
means *what you reach when a lookup fails*, not *the English locale*, and conflating them leaves
`en-GB` — and any copy edit that shouldn't touch code — with nowhere to live. The runtime turned
out to already be correct (a registered `en` table beats the call-site string exactly the way `fr`
does); what was wrong was that the generated catalog wasn't wired in, and the comments said so
proudly. So `en.js` is now loaded and outranks the seeds, and `just strings` syncs BOTH ways: a key
the catalog has never seen is added from its seed, a retired key is dropped and named in the
output, and every seed is rewritten to agree with the catalog. New copy flows code → catalog once;
every edit after that flows catalog → code. Without that write-back the seeds would quietly rot
into stale documentation, which is the only thing they are for.

The starting question was a voice map, not localization. The first attempt answered it literally:
a generated `VOICE.md` listing every extractable string, call sites untouched. It was the wrong
artifact, and the giveaway was its own keys — `file:line`, which move on every edit above them, so
the claim that it "bootstraps a catalog later" was false. The reading surface and the translation
catalog are the same artifact; building the report was building half the tool and throwing away
the half that makes it load-bearing. `t(key, default)` — Curtis's call — keeps the English at the
call site (so a screen still reads as prose) while the key survives rewording, which is the thing
English-as-key cannot do.

**Two-thirds of the work was finding the words, not moving them.** 112 of the 402 phrases are
written in Rust: `AppError` prose that `net.js` lifts onto an `Error` and fifteen `setError(e.message)`
sites render verbatim. Any tool that read only the UI would have shown a third of the app and
looked complete. `AppError` variants now carry a `UserMessage` (code, formatted English, and the
params kept SEPARATE so another language can reorder them); `net.js` translates once, at the point
the `Error` is built, so every existing display site shows the reader's language without knowing
anything changed. `error.rs`'s `code` stayed exactly what it was — the structural discriminator the
revoked-signer farewell branches on — and the catalog key rides beside it, because "which failure
is this" and "which sentence is this" are different questions.

The migration is a codemod, which is why three wrong turns cost re-runs instead of rework. What it
taught, in the order it hurt:

* **Position is what separates voice from machinery.** `${busy ? 'bringing your things across…' :
  'become me here'}` is prose; `class=${kind === 'all' ? 'search-opts-btn' : '…'}` is not. Same
  syntax — the only difference is whether the hole landed in a text node or an attribute. The first
  pass collapsed interpolations and silently dropped 46 real phrases, including both branches of
  idpage.js's "none of the computers its address points at answered."
* **Idempotency is correctness, not tidiness.** Run two found the English sitting inside the `t()`
  wrapped by run one and wrapped it again, making the outer call's key the inner call's text.
  Existing `t(...)` spans are now blanked before the choice scanner reads an expression, and
  "migrate twice, second run reports zero" is how the codemod is tested.
* **rustfmt's trailing comma hid the longest messages.** A pattern anchored without `,?$` skipped
  exactly the constructions long enough to be broken across lines — which are the wordiest, most
  user-visible ones. Two dozen of them.
* `let USERNAME_MIN = &value` does not bind: an ALL-CAPS name in a `let` pattern is read as a
  constant pattern, so `msg!` stopped compiling at precisely the call sites naming a constant. The
  macro now evaluates its arguments twice and says so.

Ten server errors carried positional `{}` holes that no codemod can map to their arguments; those
were converted by hand, so all 94 have named parameters and none is stuck half-translatable.

One more round closed the fragments. Sentences interrupted by markup had each been catalogued in
pieces — `", choose"` and `". One hook feeds them all ("` were real entries, connective tissue no
translator could do anything with — and the ledger said the fix was rich text: element placeholders
inside the catalog. Curtis pushed back: doesn't the `{name}` template already cover this? It does.
The holes were always the seam; the only obstacle was that `fill` coerced its params with
`String()`. Splitting the template into parts instead of replacing into a string lets a param BE an
element, and Preact renders the array — so the catalog stays free of markup, which matters, because
tags in a translation file are how a translator breaks a build. `tNodes` is that variant, separate
from `t` because 57 attributes and `new Error` still need a string. Nine sentences merged, 9 keys
retired.

The merge taught the sharp edge of an authoritative catalog. Merging onto the OLD keys meant the
catalog still held the old fragment, and since the catalog outranks the seed, `just strings`
cheerfully rewrote `'Did you mean {suggestion}?'` back to `'Did you mean'` — dropping the hole, and
the link with it, in silence. The tool now refuses: a seed carrying holes its catalog entry lacks
is a SHAPE change, not drift, and gets named rather than overwritten. The catalog wins on wording,
never on structure.
`locales/` is exempt from the purity cop — generated word tables are data, and pure/ owes test
vectors. Left on the ledger: sentences split by an inline element are catalogued as fragments,
which reads fine in English and fights a translator (REFACTOR.md).

The one thing that reached `integration` and not the unit gates: a mechanical migration quietly
changed what a user reads. The failed-upload endpoint returns the ingest queue's tombstone, and
the tombstone is already a whole sentence ("this isn't a kind of media Ringtome can store yet —
…"). Wrapping it in `"upload could not be processed: {reason}"` looked like tidy framing and was a
stutter in front of a sentence that explains itself — and it broke the endpoint's actual contract,
that its message IS the queue's `error`, pinned by `docs.cjs`. It passes through verbatim again, as
a message that is nothing but its hole. Worth remembering that a migration touching 400 sentences
is a copy change wearing a refactor's clothes, and only a test that read the words caught it.

That tombstone also marks the extractor's blind spot: it is prose written in `ingest.rs` and
PERSISTED to the job row, so it never passes through an `AppError` and the cop cannot see it.
Making stored prose translatable means storing a code and params instead of a sentence — a data
format question, not a wrapping one, and not taken here.

Gates: full `just ci` green — 560 passing, 1 pending. That is the whole bar: `.github/workflows/
ci.yml` runs the recipe verbatim.

## 2026-08-08 — going public with nowhere to publish

`POST /serve` returned a 500 on any node with no directory configured — which is `RINGTOME_DISCOVERY`
unset, the DEFAULT, and therefore every offline and LAN-only node. Found by pointing `just test-data`
at a lone `just start`: every `go-public` action failed, and the arithmetic said so plainly — the
action carries weight 4 of 145, so its 2.76% share matched the observed failure count almost exactly.
Not intermittent at all; a rarely-drawn action failing every time.

The shape of it: `mark_served` writes consent with `record_served`, then publishes. `Directory::Off`
returns `Err("discovery is off")` from `publish_serving`, and `mark_served` was the ONE caller out of
four that mapped that to `AppError::Internal` instead of tolerating it — creation and adoption both
use `publish_best_effort` ("a dark directory must not fail a ceremony"), and the republish pass logs
a warn. So the consent had already committed when the 500 went out: the node believed the identity
was served and the reader was told the act had failed, and nothing ever reconciled them. That split
brain, not the status code, is what made it worth fixing rather than reclassifying — a truthful 4xx
would have left the same disagreement in place. `mark_served` now publishes best-effort; the
republish loop carries the record out the moment a directory exists.

Nothing user-facing was actually broken today: the write path never touches the directory (`state.
directory` appears outside serving.rs only in `net::sync`, and only to resolve), persona creation
already tolerated the dark, and the UI has no caller for `/serve` at all — every one is a test or the
generator. It was a latent bug waiting for the "go public" control to be wired up.

Why nothing caught it: all three rig nodes boot on `local:` discovery and `mainline-smoke` uses the
real DHT, so `/serve` had only ever been exercised somewhere it could succeed. The rig now boots a
FOURTH node — delta, on 5284, deliberately without `RINGTOME_DISCOVERY` — and `darkdirectory.cjs`
pins the whole posture there: a persona is created, serving succeeds and is idempotent, `served_at_ms`
is actually written (read from the table, not inferred from the 200 — the same success-that-kept-
nothing would otherwise pass), and posts still write and publish. A default configuration that no
test ever booted is a gap the suite could not see, and now it has a permanent home.

Gates: full `just ci` green — 565 passing, 1 pending.

## 2026-08-08 — one notebook app, and a lost & found

Recipes and Wikibook are gone. The cut is the whole argument: each was TurboNotes with a column
taken away — Recipes was the tag column plus the list, Wikibook was the list plus the tree — so
shipping them separately bought two app tiles and two vocabularies for no capability anyone
could name. What made the single "complicated notes app" safe to embrace was tucking: TurboNotes
now carries `startsTucked: ['tags', 'tree']` and opens on a plain list, with the other two waiting
as rails. It is only as monstrous as you choose to make it.

`startsTucked` is a DEFAULT, not a rule, and the distinction is load-bearing: `setFlag` writes
'0' when a column is opened, so "no stored preference at all" is a different state from "opened
once", and only the first yields to the default. That is why `useColTucks` reads the raw pref map
instead of `flagsOf`, which collapses both into the same nothing. `usePrefMap` returns `undefined`
while loading, so the columns start tucked during load rather than flashing open.

Retiring an app is a data question, not a code one: every dev node has `recipes` and `wiki`
buckets in it. The fallback already handled that — an unresolvable style opens in TurboNotes — so
the vector that pins it is the actual migration story, and it is the one to keep if the rest of
`apps.cjs` ever gets rewritten: `appTypeOf('recipes') === DEFAULT_STYLE`, `homeAppFor({buckets:
['wiki']}).id === 'notes'`. Nothing orphaned, no migration written.

Then "All" became **Lost & Found**, which took three passes to name because the surface is doing
two jobs and was being asked to imply a third. The first pitch was "Trash" — wrong, and the
investigation is why: `restore()` exists in `record/store.rs` with a passing test, its only caller
IS that test, there is no route and no UI, and nothing anywhere lists deleted documents. So a
deleted document is unreachable in practice while its doc comment promises "reversible-by-design".
There is no trash can to name. Then: it is not "all" either — it is every PRIVATE document, since
public posts live on the feed. The name that survived describes what you come here to DO rather
than what it holds, which is honest about the strays being a minority of the rows: the view
already labels them "unfiled", so the app name never had to carry that meaning alone. The glyph
is a lidded crate — the lost-property box, not a filing cabinet.

And the name immediately broke the tile that had to draw it: "LOST & FOUN…", because the launcher
cut every label at 11 characters. Type SHRINKS before it truncates now (`pure/tilelabel.js`) —
eleven characters is the measured capacity at full size, past that the size falls in proportion so
the word keeps occupying the same strip, and the cut only happens once the type hits a floor at
about twenty characters. A persona named for a Russian novelist gets small; one named by a cat
walking on the keyboard still gets cut off. The 11 is a CALIBRATION, not arithmetic — measured
against the real hex in Radio Canada 800 uppercase — and the two vectors worth keeping are the
invariants a threshold tweak could quietly break: monotonic (a longer name is never drawn larger)
and never below the floor.

Residual, and it bit twice in one day: app names and nouns live in `pure/apps.js`, which
`strings-check` skips as "arithmetic and wire formats". Renaming a tile from "All" to "Lost &
Found" is user-facing copy, and the voice cop reported `+0 new, -0 retired`. Third instance of the
same family, after the `note=` component prop and the persisted ingest tombstone.

## 2026-08-08 — a port band per checkout

`just ci` no longer disturbs `just start`. It used to bind the same three ports, which is why
integration began by shooting every ringtome on the machine — the tests and the playground were
fighting over the same sockets, and the "fix" took the dev network down with them (and any other
checkout's, and any other agent's).

Nothing here talks to a backing service, so coexistence is entirely a question of who binds what.
Each checkout now owns a 32-port band derived from its own path, split into lanes that cannot
overlap: dev at `base+1..16`, scratch at `base+17..19`, a deliberately unbound firebreak, then
integration at `base+21..24`. `just ports` prints the map, and every `start*` prints its URL,
because the port is no longer memorable. This replaces the `*ringtome-alt* -> +500` special case,
which handled exactly two copies and only if the second was named right.

Verified the only way worth verifying: a node booted on the dev port, a full `just ci` run around
it (578 passing, exit 0), and the same pid still listening afterwards.

The trap that nearly shipped as a silent success: **`{{ }}` is not interpolated inside just's
backticks.** The first cut hashed the literal text `{{justfile_directory()}}` — perfectly stable
across invocation directories, and identical for every checkout, which is exactly the failure that
looks like it works. `shell()` takes real arguments; that is the only reason this works, and it is
written at the top of the justfile so nobody re-derives it. (`$PWD` is no good either: it is the
INVOCATION directory, and on macOS `/tmp` and `/private/tmp` hash differently.)

Consequences worth knowing. `just scratch` takes an INDEX now, not a port — it used to carry a
hand-maintained list of dev ports it refused, and lane arithmetic makes the overlap
unrepresentable instead, which is the better version of the same guard. `scratch-kill` is scoped
to this band; it globbed every `ringtome-scratch-*.pid` on the machine, fine with one checkout and
hostile with two. Integration writes pidfiles and sweeps its own band on the way in, so a run
SIGKILLed before its trap is cleaned deterministically rather than by pattern. `mainline-smoke`
moved to the spare lane, having sat inside the dev one. And the Windows cleanup lost its
`taskkill -F -IM ringtome.exe`, which was machine-wide — precisely the coupling being removed.

Still machine-wide, deliberately: `just kill` (a panic button that nothing depends on any more)
and `just clean`, which needs it because it deletes files out from under whatever holds them open
and a foreground `just start` has no pidfile to shoot it by. Left undone: about twenty harness
probes still hardcode `localhost:5299`. They were already wrong on the alt twin for the same
reason; `just scratch` now prints the export line they need.

## 2026-08-09 — the interest dial, made visible

The reader's interest dial now shapes two things about a post: how much room the card takes
(`postScale`, 1.0 down to 0.75 across the five stops) and how big a picture may draw inside it
(`postImageCap`, 800px down to 50px). Order still never moves — chronology is the whole ordering,
and the dials shape rendering only, which `fanout.rs` says from the server side too.

Some of this already existed and that turned out to be the interesting part. `.feed-entry-low`
carried `font-size: 0.85em` — a 15% cut — and Curtis had never noticed it. Two reasons, both
worth keeping in mind next time a subtle visual signal doesn't land. It was a STEP, not a ramp:
one cliff between "Low priority" and "Medium", with the top three stops rendering identically, so
a feed of people you mostly like looked completely uniform. And it only shrank TEXT: padding,
title, date and avatar were all in `rem` and stayed exactly where they were, so the card never
actually got smaller — the words just got tighter inside an unchanged box.

So the card's every metric moved to `em` and hangs off one custom property, `--post-scale`. That
is what makes the number mean anything: 25% now shrinks the whole card, where 15% used to shrink
part of it. The first cut of the ramp was 10%, raised to 25% for the plainest possible reason —
the thing it replaced was 15% and was invisible, so a difference nobody can see is not a subtle
difference, it is an absent one.

The banner needed its own clause. `PersonBanner` is shared with the persona page and its metrics
are rem, so a low-interest post would have rendered a full-size author over a shrunken body — a
layout bug, not quietness. Its sizes are restated in `em` scoped inside `.feed-entry` rather than
converting the shared widget, which has no business breathing on any other page.

Images got a much steeper ramp than type — 16:1 against 1.33:1 — because they are what actually
costs a feed its shape; a quarter-size card holding a full-size photograph is still a full-size
interruption. The 800px ceiling is not a free choice: it is `MAIN_BOUND` in `media/image.rs`,
where the transcode already lands, so top interest is deliberately a no-op and a larger number
would be asking the browser to upscale something nobody stored. A vector pins the two together,
since that coupling is invisible from either end. The cap is px while the card scale is em, so the
two ramps stay independent instead of multiplying. Height is capped alongside width — `max-width`
alone is a width cap, and a tall image would keep its full height in a 50px column — and
`.mq-emoji` is exempt, being a character wearing an image's clothes.

Both ramps give a dial you never set FULL size, rather than the middle: an unset dial is not
"medium interest", it is silence, and a feed of strangers must not render uniformly shrunken.

One real bug fell out. A vector written for `postScale` failed on `null`, because `Number(null)`
and `Number('')` are both 0 — the BOTTOM of a 0-100 dial. `emphasisOf` had carried that hole since
it was written and would have rendered a null dial as low emphasis: dimmed, truncated, and now
shrunk. Both read through a `dialValue` helper that checks nullish before coercing.

Gates: `just ci` green. Not verified in a browser — the vectors pin the arithmetic and the
compiled CSS carries both knobs, but whether 0.8125 and 238px read as "quieter" or as "broken" is
a judgement only eyes can make. `POST_SCALE_MIN` and `POST_IMAGE_MIN` are the two levers.

## 2026-08-09 — arrival and attention, extended: how strangers knock

A design day, no code. The Arrival and Attention section (settled 2026-08-03) grew from a sketch of
the inbox into the full mechanism for delivered events, working through the attack surface one
adversary at a time. The routing rule that anchors it: where a follow-edge exists, evidence travels
by pull and opinions are derived locally (zero inbox rows, at most a content-free sync offer);
where none exists, evidence travels by envelope and is transcribed under quota.

What got settled: **envelopes carry evidence, not claims** — the sender's signed entry plus its
root-to-leaf authorization path embed in the envelope, so a stranger's rebroadcast/comment/tag/
follow notice verifies offline with zero fetches, killing the forced-sync attack outright (the
header/blob split and self-authenticating key-tree entries are what make it fit in kilobytes).
**Per-kind floors** inherit Trust's Sybil hardening — content-bearing kinds require nonzero graph
flow, first-contact is the one kind open to the pathless — with a named pre-Trust fallback
classifier (explicit/mutual edge ⇒ trusted, else stranger, muted ⇒ refused) so the inbox doesn't
wait on Advogato. **Tiered inbox chains**, (device key × tier), count-bounded at ~1–2K entries —
a named exception to own-nodes-hold-chains-whole — with the one-sentence rule "anything shown to
the user is a chain row; anything node-local is in-flight" (the decisive argument: the device you
read on is the least reachable device you own). **One-door delivery**: sender retry plus friends'
always-on nodes as sealed-envelope answering service. **The transport tier**: nodes price
connection admission by shared standing over a materialized public-edge graph — public edges only
(rate limits are observable; a timing side channel must never out a quiet follow), relief never
penalty, outbound-edges-only with diminishing returns, all inputs signed. **The proof-of-work
dial at resting position zero**: the stamp slot, reject-with-price, and retry path ship wired and
tested with the number at zero everywhere; the dial rises only under measured pool-local stress
and decays back on its own.

Rejected along the way, with reasons recorded in the section: per-calendar-day inbox chains (a
clock-fact discriminator; the extracted rule is that chain discriminators are identity-shaped,
never time-shaped), accept-then-randomly-audit with node blacklisting (auditing is itself a forced
sync, and blame lands on the wrong noun), node-local stranger buffers (strands notices on the
public face, never the pocket), and an always-on PoW price (regressive, flood-ineffective, and it
destroys the dial's signal value).

NEXT_STEPS' Inbox section recast as build work in dependency order. Nothing scheduled — the
design runs ahead of the ladder deliberately, so the envelope format and gate are already final
when the graph features arrive.

## 2026-08-09 — bands, not numbers: the relationship ledger stops counting

The first build step toward edge publication turned into a spring-cleaning of the thing being
published. Curtis's call, two decisions: the 0-100 dial scale is gone — every edge value in
every system is one of five bands, none/low/medium/high/max — and the per-edge publication
consents collapse to one `edges_public` dial per contact ("may the network see how I hold this
person"), covering trust and interest together. The "help host" disclosure tier is demoted to
speculative, to be designed with fronting's ceremony. Doctrine updated in place: Edge-Endpoint
Visibility gains the Publish tier, a new "Bands, Not Numbers" section records the repeal, and
The Vouch Dissolved loses its "mint rounds to a tier" hedge — the ledger holds a band, the
statement will carry that band, and there is no finer value left to protect.

The numeric scale's only defense was "finer values a future flow engine might read" — a
consumer that never existed, arguing for granularity nothing consumed. The stops were always
the interface: `TRUST_STOPS`/`INTEREST_STOPS` now carry band values, `bandOf`/`bandOrdinal`
(pure/contact.js) replace `nearestStop`, `signalLevel` reads the ordinal straight, and the
feed's rendering ramps (`emphasisOf`, `postScale`, `postImageCap`) take a rung out of four
instead of a percent — same outputs at every stop, pinned by the updated vectors. The
2026-08-08 null-guard lesson is preserved structurally: silence and garbage read as null (no
opinion), never as 'none' (an opinion), and the retired numeric values land on the silence
side — pre-User-1, a dropped dev-data dial beats a shim carried forever.

The subscriptions memo stores band ordinals 0-4 in its integer columns, so `eagerness > 0`
keeps meaning "any rung above Don't show". One real bug fell out of the consent rename: the
old gate matched `trust_public` = "true"/"1", but the ledger UI has only ever written "yes" —
so UI-granted consent never actually reached the memo's trust column. Nothing read the column
yet, so it cost nothing, but it was the second-copy disease verbatim: two vocabularies for one
fact, drifted apart, one clause missing. The new gate matches the UI's word and the test that
pins it says why.

Gates: full `just ci` green (the memo is sync-adjacent). Not eyeballed in a browser: the
ledger's selects, glance bars and feed scaling all render from the same pure functions the
vectors pin, but whether the five worded stops read well in the dropdown is a judgement for
eyes. Residual: existing dev databases hold numeric dial values, which now read as unset —
re-dial or regenerate test data (`harness/testdata.mjs` now writes bands).

## 2026-08-09 — the follows-public chain speaks, and the bell rings

Same day, second act: the publication rung built end to end on the banded ledger. The
follows-public chain — a reserved service id with zero writers since the registry was born —
got its first citizen: **`public-edge` (entry type 8)**, `{subject, trust?, interest?}` with
band words validated strictly at the codec (a fold that can't decode skips; admission is
signatures and hashes only, so strictness can't poison a chain). Two new conformance vectors
(statement + retraction), additively re-blessed. `inspect` prints it.

**The mint is a reconcile, not an event handler** (`publish.rs`): desired (every contact whose
ledger says `edges_public: yes`, carrying the bands as set) versus published
(`imaol::published_edges`, an LWW-per-subject fold over the persona's follows-public chains),
appending statements only for the difference. Consent granted publishes, a dial turned while
consented re-publishes, consent withdrawn mints the empty statement — LWW needs a write to
override, so silence cannot un-publish. It rides `subscriptions::refresh` (the one place the
whole ledger is already read with the store open) and is idempotent across devices: each
compares against the merged fold, so racing devices write agreeing statements, not duplicates.

**Notifications are the derived path made real** (PROJECT_PLAN, Arrival and Attention: the
follow-edge rule). A `notifications` memo in node.db (schema generation 11 — `just clean`),
one row per (reader, author, kind), folded on the frontier edge beside `fanout::
after_public_move` and rung by hand after a local mint (locally-authored entries never take
the sync gate — learned by reading, not by debugging, for once). The fold routes only to
hosted personas who FOLLOW the author — the boundary the integration test pins with a
bystander: a consented edge toward a non-follower mints fine and notifies nobody, because
reaching someone who doesn't follow you is the inbox path's job. A retraction DELETES the
row; stale flattery is not a notification. Stamps are the winning entry's `received_at_ms`,
so re-folding is a no-op instead of a resurrection.

**The bell**: a Notifications app (Phosphor `Bell`) on the console, reading
`GET /api/identity/{root}/notifications` — rows dressed with bylines from the cache and
seen-state from a single `notifications_seen/watermark` register on the reader's own private
chain ("mark all read" is one write that reaches every device by sync). Copy composes
client-side from kind + bands through `t()` — the row carries machine facts, the client makes
words, and the vouch reading is reserved for the max band because that stop IS the vouch.

The conventions cop earned its keep twice: it demanded the `notifications` table name an
owner, and it caught the new per-edge `user_dbs.get` call site and made the "once per edge,
never per persona" argument be written down in the expected-counts table.

Gates: full `just ci` green, including a new `notifications.cjs` integration suite driving
the whole pipeline over real HTTP (consent → statement → fold → endpoint → watermark).
Browser judgement still owed: the bell app renders from the same components the suite's
pure functions pin, but nobody has looked at it. Residuals, named: the notification fold
opens the author's user DB once per frontier move (fine at dev scale; the memo idiom's
answer exists if it thrashes); the endpoint has no paging (the memo collapses per author, so
the page is the social circle); and the seen watermark is all-or-nothing until a kind needs
per-row granularity.

## 2026-08-09 — the mint learns not to shout in an echo chamber

Curtis noticed `just test-data` had slowed and brought a before/after: 62s on two nodes, 160s
on three. The comparison had a confound (2 vs 3 nodes, 6 vs 9 personas, every persona on
every node - a bigger mesh does more sync per action regardless), so the answer was a
controlled A/B: a git worktree at the pre-rung commit with its own path-derived port band,
three fresh scratch nodes per leg, same seed, same machine. Verdict: pre-rung 144s, rung
**201s** - the rung really did cost ~40% on this workload - and the mechanism was sitting in
`chain_heads`: **9 personas had published 315 statements across 19 device keys**. The
sibling-mint race, live: a dial syncs to a persona's other nodes ahead of the authoring
node's statement, each sibling's post-ingest reconcile sees desired ≠ published and honestly
mints a duplicate - one consent flip became up to three statements, each an fsync and an
eager push that triggered ingest and folds on two more nodes. The rung's own HISTORY entry
had called racing duplicates "harmless"; harmless to CORRECTNESS was true, and the wrong
question.

Two fixes, neither touching convergence:

- **The post-ingest path stopped minting** (`subscriptions::Minting`, `Allowed` vs
  `MemoOnly`): publication needs no sibling-speed reaction - the authoring node mints on its
  own write, the statement rides the same sync as the dial, and the backstop sweep still
  converges the one real gap (an authoring device that dies between the dial and the mint).
  The routing-memo work on ingest is unchanged; only the pen is withheld.
- **The notification fold gained a cheap gate** (`frontier::has_service_chain`): one node.db
  probe on the chain_heads PK answers "this author has published no edges" before paying for
  an encrypted user-database open - the hook fires on every public frontier move, and most
  authors will never publish an edge toward anyone you host.

Re-run, same seed: **151s**, and the chains say why - 9 publishing keys for 9 personas
(exactly one each, was 19), 302 statements (all legitimate re-publications, zero duplicates),
notification rows unchanged (48/43/48 vs 48/44/48). The remaining ~7s over the pre-rung
baseline is the feature's honest price: ~300 real statements minted, synced, and folded.

Gates: full `just ci` green. The lesson worth the ink: "idempotent under races" and "cheap
under races" are different claims, and a mesh where every persona lives on every node is a
race generator - measure the write amplification of any reconcile that can run on more than
one node per fact.

## 2026-08-09 — the worded scale learns other languages exist

Curtis noticed the relationship panel's words weren't in the English catalog. Three escape
routes, each its own hole: the whole worded scale ("Never heard of them" through "I've met
them in person") lived in `pure/contact.js`, which the strings scanner SKIPS and which can't
call `t()` - so the most human copy in the panel was structurally unlocalizable; the dial
hints were `hint=` props, an attribute the scanner didn't treat as human copy; and the
tooltip nouns rode a `what=` prop it had no reason to look at.

The fix follows the pure boundary rather than fighting it: `pure/contact.js` keeps only the
BANDS values (the ladder the tests pin - "max", "high", plain English words as VALUES, which
is fine, they're wire vocabulary, not prose), while the human words moved to `person.js` as
`trustStops()`/`interestStops()` - functions, so a locale switch re-reads them - with every
label through the catalog. The hints went through `t()`, and the scanner's holes closed
structurally: `hint` joined HUMAN_ATTRS, and SignalCell/GlancePair's `what` prop was renamed
`label` - a word already in HUMAN_ATTRS - so a future bare-English caller of either gets
flagged by `just strings-check` instead of quietly shipping untranslated. en.js gained 18
phrases and is now the authoritative home of the worded scale, ready for the French/Spanish
pass NEXT_STEPS just took on.

Gates: `just strings-check` + `just ui-check` green (the pure suite dropped one test - the
label pins left the pure boundary with the labels; the catalog gate pins the words now).

## 2026-08-09 — publication moves to the resting state

Curtis's call, and a genuine reversal of a written principle rather than a default tweak, so
it is recorded as one. Edge-Endpoint Visibility said "an edge is visible to its endpoints by
default, invisible to everyone else, and any wider publication is a separate, explicit act."
It now says the wider publication is a per-contact switch that **rests open**: only an
explicit `edges_public: no` keeps a relationship quiet. The visibility question also moved to
the TOP of the relationship panel, above the dials that feed it - the mitigation for a
default-open switch is placement, not machinery, and a question answered before the dials are
touched is a different thing from a footnote under them.

The argument, written into the plan where the surprise will be: the graph is the substrate
every Tier-5 feature reads (flow computation, inbound floor, transport tier), and a graph
assembled from opt-in edges is not a smaller version of the real one - it is biased toward
the users who go looking for a privacy control and flip it the friendly way, and a Sybil
computation over that is worse than none. What keeps it honest is that **silence stays
silent**: a contact with no bands set publishes nothing, so browsing, naming, and merely
looking at someone remain private; only the edge you deliberately dialed travels. What is
surrendered, plainly: the quiet follow is no longer inherited, and users who take no actions
are exactly the ones defaults are for.

Mechanically it is one inverted comparison in two gates (`subscriptions::edge_of`,
`publish::desired_of`) - `!= Some("no")` where it read `== Some("yes")`. Copy-Don't-Flip is
untouched: the flag is visibility, the mint still writes a statement, and withholding still
retracts by writing. The tests inverted with it, and read better for it - the integration
suite's publication case no longer writes a consent register at all, because dialing IS the
act now.

The cost, measured rather than assumed (same seed and shape as the amplifier fix's 151s
baseline): **176s, +17%**, with public-edge statements up from 302 to **448** on 9 chains -
no duplicates, just more real publication, because ~20% of generated actions now publish
where ~4% used to. That is the feature doing what was asked rather than a regression, but it
is the second time this rung has moved the test-data number, and the standing note applies:
publication volume is now a function of how many relationships exist, so the next scale
question is the mint's fsync cadence, not its correctness.

Gates: full `just ci` green. Also, while in the panel: the block button got room to breathe
(a larger tap target than the glance pills it borrowed its metrics from, plus daylight above
it - a destructive control should not sit flush against the dial you were adjusting), and
`just ui-build` reran so the compiled bundle actually carries it.

## 2026-08-09 — the feed stops keeping score

Curtis, on feed read-state: "I don't want that feature to exist at all." Cut in full - no
unread dot, no "only what's new" toggle, no `feed_seen` registers, no `seen` field on a feed
row. 136 lines deleted against 71 added, most of the additions being the argument.

One correction to the premise on the way in, which did not save the feature: the marks were
on the PRIVATE chain, not the public one, so nobody else ever saw them. The growth complaint
survived that untouched (permanent, append-only, one register per document ever read), and
the real indictment turned out to be the TRIGGER rather than the total: marks fired from an
IntersectionObserver at a 0.6 threshold, so *scrolling* wrote one signed, encrypted,
epoch-sealed, fsynced private-chain entry per post that crossed the viewport, then pushed it
to every device the reader owns. Reading was the highest write-rate act in the application -
in a codebase whose contact ledger already says "one private record per deliberate click,
unlike keystrokes." Seen marks were keystrokes in a click's clothing.

The product argument is what makes the deletion permanent rather than an optimization: an
unread badge is a debt the application invents for you and then asks you to pay down, which
is the engagement machinery the Vision indicts, arriving through the side door as a
convenience. A cozy feed is a river you dip into, not an inbox to empty.

The cheap middle ground was examined and declined on a technical merit, not just taste: one
watermark register (what the bell uses) would have cost nothing to store, but the bell orders
by ARRIVAL (`received_at_ms` - local, monotonic, honest) while the feed orders by CLAIMED
`published_ms`. A watermark over claimed time breaks under ordinary clock skew - a backdated
post lands below the line and never reads as new - so "above the watermark" and "top of the
feed" would silently disagree. Where a since-I-last-looked hint is ever wanted, `arrived_ms`
is already on every row and a device-local mark costs no chain and no sync.

What survives, and the rule that came with it: the bell keeps ONE watermark register per
persona, and **automatic observation is ruled out for good** - it moves when a human presses
"mark all read", never because eyes passed over something. Curtis's line: notifications
benefit from seen much more than a feed does, and a button keeps the structure bounded. The
future inbox inherits the same rule (recorded in Arrival and Attention), since a notice list
is the other place read state genuinely earns its keep.

PROJECT_PLAN's *Two cursors, not one* is now *One cursor* - delivered, node-local,
disposable - with both reasons and the declined middle ground written into it, so the next
person to think "the feed should show what's new" finds the argument instead of the absence.
NEXT_STEPS' "Seen" item ("needs to work more reliably, use less private chain space") is
struck: answered by deletion.

Gates: full `just ci` green. The feedstream probe's last act was rewritten from driving the
unseen toggle to asserting the read-state chrome is gone.

## 2026-08-09 — the door: a stranger's follow arrives in an envelope

The delivered half of Arrival and Attention, built. Until today every notification came from
the DERIVED path - fold a chain you already sync - which by construction cannot carry the one
event people most want: *someone you don't follow followed you*. There is no edge, so there is
no sync, so there is nothing to fold. That fact has to be carried to your door.

**The wire** (`proto/src/deliver.rs`, its own `ringtome/deliver/0` ALPN because sync's own rule
is that a different table of messages is a different protocol). A `SignedEnvelope` mirrors
`SignedEntry` exactly - `[body, sig]`, signature over `DOMAIN_ENVELOPE ‖ body`, slice-never-
re-serialize - and carries **evidence, not claims**: the authorization path from the sender's
root to the leaf that signed, plus the sender's own signed `public-edge` entry naming the
recipient as subject. Three messages: Offer, Accepted, Refused(reason). Refusal is spoken
aloud, per doctrine ("a silent drop is the worst failure mode in messaging") and per the adopt
protocol's precedent that words beat resets; below-floor and muted deliberately share one code
so a refusal is not an oracle.

**The design collided with reality once, usefully.** Doctrine said the envelope carries "the
chain of authorization entries from root to leaf". `Crown::build` cannot consume that: it
linearizes each key's whole identity-public chain from genesis, which is what lets it enforce
usurper stamps and revocation ceilings - and shipping that means every intermediate key's
key-epoch entries, kilobytes for a mature persona, against an envelope budget of 4 KiB (the
number is not free: a notice is stored verbatim inside one private record, whose ciphertext
caps at 6 KiB). So `verify_claim` asks the smaller question it actually needs - *may this leaf
speak for this root?* - and answers it with a signature chain, each rung signed by the key the
previous rung authorized. Forging it needs the root key, at which point you ARE the identity.
What that gives up is written into the function: revocation (already accepted doctrine,
"verifiable-modulo-revocation") and seniority (a notice grants nothing, so rank decides
nothing). Twelve adversarial tests hold the line - wrong root, truncated path, broken middle
link, evidence signed by another key, an edge about somebody else, a retraction, a profile-set
smuggled in as evidence, a public-edge smuggled into the path.

**The door** (`inbox.rs`). Two chains, `inbox-trusted` and `inbox-stranger`, so retention is
per-chain policy rather than per-row bookkeeping - both registered as private services, which
is the one line that stops an inbox syncing to strangers. The gate's order departs from the
written one and says why: doctrine puts mute first assuming it is a local lookup, but `blocked`
lives in the epoch-encrypted ledger and is deliberately never projected into node.db ("a block
stays home"), so it costs a keystore open and an epoch unseal. The order keeps the principle -
never pay for a check until the cheaper ones pass - by asking node.db questions first (do we
serve this persona; **does the recipient already pull this sender**, which is the follow-edge
rule enforced where only the recipient can know it), then pure-CPU verification, and only then
the credentials that transcription needs anyway. The envelope is stored verbatim so the
recipient's OTHER nodes re-run the same verification rather than trusting whichever node
answered.

**The knock** (`outbox.rs`, `net/deliver.rs`). Always queue, let the recipient decide: whether
someone syncs you is a fact only their node holds, and a sender that guesses either misses
people silently or interrogates strangers about their follow lists. Durable ledger, 30s-doubling
backoff to an hour, expiry at three days, retire on ANY answer - a refusal is an answer, and
retrying one is what a spammer does. Eager first attempt with the sweep as backstop, the same
shape as every other push here. Housemates short-circuit to an in-process judgment rather than
dialing ourselves.

**The bell shows both.** One list, ordered by time, derived and delivered together - the reader
should not care which path a fact took. Delivered rows get **no byline**: an unadmitted
stranger renders from their root alone, identicon and speakable words, because claimed identity
costs a sync and you pay it only for people you have answered. The client half of that is
load-bearing and easy to lose - passing an empty `profile` prop is what stops `usePerson`
fetching their page - so it is commented at the call site.

### Two failures, and a process failure worth more than either

`just ci` came back red, which is how a **process** bug surfaced: every run this session was
shaped `just ci 2>&1 | tail -N`, and bash reports the *pipeline's* status, so I had been
reading `tail`'s exit code and calling it green. A stash-and-rerun proved HEAD was already
failing `just lint` on two `clippy::type_complexity` errors from earlier today's work, both
committed on a green I never actually checked. Runs now capture `$?` into an echo before any
pipe. The LWW stamp tuple had also quietly become two definitions (`private.rs` had one,
`imaol` spelled it inline); it now lives once in `imaol`, which owns The Ordering Contract.

The livecache failure was a real regression from **public-by-default**, already committed:
`FOLLOWS_PUBLIC` shared the stream's contacts group, harmless while nothing wrote that chain,
but now every dial mints an edge that bumps the contacts stamp and fires a second update
carrying an empty delta. Published edges now move no group - they are an echo of a ledger write
that already fired its own update - and the inbox services get an explicit no-group arm so they
do not fall to the catch-all and spuriously invalidate documents and the profile on every
delivery.

The inbox failure was my test racing itself: delivery is eager, so a queued row lives for
milliseconds and asserting on it is a flaky test of nothing. Replaced with the stable case - a
knock at a door nobody serves stays queued with its try count advanced - which actually
exercises the backoff.

Gates: full `just ci` green, 596 passing, exit code verified. Residuals, named: the stranger
pool **refuses when full instead of ring-buffering**, because moving a chain floor as policy is
machinery nobody has built (NEXT_STEPS carries it); the stamp slot is a field with no protocol
behind it; relays and the transport tier are designed and unbuilt; and nobody has looked at the
bell in a browser. One efficiency finding logged separately: `published_edges` is an
un-memoized full fold that decodes every public-edge entry, now on hot paths, which is the
fan-in-at-read-time mistake `feed_journal` exists to avoid.

## 2026-08-09 — the ring turns: chain floors as policy

The retention residual, closed the same evening, because it was the load-bearing one: a
stranger pool that refuses when full is a door a flood can shut *and leave shut* - the
opposite of the design, where a flood can only ever rotate other strangers out.

The insight that shaped the build: **retention is an admission feature wearing a deletion
feature's clothes.** Deleting rows below a floor is twenty lines; the hard part is that a peer
who pruned now honestly OFFERS a chain that starts above zero, and every replica's gate would
reject it entry by entry - `validate_next(None, e)` demands genesis. A fresh device adopted
after pruning would hold an inbox that could never arrive. So the work split three ways:

- **The prune primitive** (`imaol::prune_chain_below`), with one structural invariant: **the
  head always survives**, clamp regardless of what the caller asked, because an emptied chain
  would re-genesis at seq 0 and equivocate with its own history on every peer still holding
  the old one. The unit test asks to prune 9,999 entries of a 3-entry chain and checks the
  next append continues at seq 3.
- **Suffix admission** (`sync::service_allows_suffix`), the one change to the gate - and the
  scope IS the security argument, written at the predicate: exactly the two inbox services,
  because identity chains must linearize from genesis (a truncated lineage is the forgery the
  usurper stamp catches) and ordinary content chains still promise their prefix is committed
  to. An inbox chain promises neither: its prefix is deliberately destroyed, its writers are
  the persona's own member-proven nodes, and the worst a gap can hide is a notice nobody
  kept. On those chains a gap adopts forward - verify the entry stands alone, discard any
  stale held prefix so holdings stay a contiguous range, chain onward. Everything else about
  admission is unchanged, and the pre-existing gate-under-attack suite still passes untouched.
- **The ring itself** (`inbox::enforce_retention`): after every fold, each tier chain trims to
  its depth (2048 trusted / 512 stranger; `RINGTOME_TEST_INBOX_KEEP` shrinks both under
  local-test, because eviction at production depth would need thousands of transcriptions to
  observe once) and the view rows whose entries aged off go with it - the view gained an
  `author_pubkey` column (user schema gen 9) so eviction can find them. Refuse-when-full is
  deleted; the gate always transcribes, and the floor is what pays.

What did NOT need building, and why it was checked rather than assumed: the wire already
carries `[floor..head]` (designed into sync v1 for exactly this day), the pager already
advances "by the seq actually read", and the journal's `⊇` invariant means pruning cannot
break recovery - replay resurrects, the policy pass re-prunes, idempotently. The chain_heads
floor memo is deliberately not raised at prune time: `local_frontiers` reads the entries
table directly so the wire is never wrong, and the frontier sweep's reconcile heals the memo
on its own beat.

The honest cost the build surfaced, now on the REFACTOR ledger: **the journal keeps its dead
frames.** Retention bounds what a node serves and holds live, not what it has ever written
down - one frame per notice ever accepted stays on the transcribing node's disk until journal
compaction exists, and compaction is its own careful project because the journal is the
recovery root.

Gates: full `just ci` green, 598 passing, exit code read before any pipe. The two tests that
matter: seven strangers through a keep-of-four pool - the oldest three evaporate, the newest
stands, the trusted friend's row never moves; and adopt-after-prune - a persona with an
already-pruned inbox grows a second device, which must admit the suffix or show an empty bell
forever, and doesn't.

## 2026-08-09 — eighty bytes of insurance: inbox cargo leaves the journal

Curtis: "can we simply not store an on-disk ledger for inbox chains? it's a kind of data that
doesn't really need to survive catastrophe anyways." Yes - and the design conversation earned
its keep twice on the way to the obvious-in-hindsight shape.

First: the naive cut arms a bomb. Skip the journal and a database rebuild loses the inbox
chains entirely; the device's next transcription would mint a fresh genesis at seq 0, and its
own siblings - still holding the old entry 0 - now possess two signed entries at one
position. Self-equivocation; the fork machinery would excommunicate a healthy device for
running a routine rebuild. What must survive is not the cargo but one fact per
locally-authored chain: **where it ended**.

Second: the first proposal for carrying that fact - fall back to the `chain_heads` memo -
was wrong, and Curtis caught why: the memo lives in node.db, which is the same beta database
engine the journal exists to distrust. "Leaning on database data like that might scuttle the
whole project." A recovery path that leans on the suspect is not a recovery path. The fix had
to be journal-class: a flat file, no database anywhere in the loop.

So: `record::heads` - one tiny JSON checkpoint per identity beside its journal, holding
`(seq, hash)` per (author, service) for the ephemeral chains, rewritten whole by
write-temp-fsync-rename, monotone (a replayed checkpoint can advance a head, never retreat
it). Bounded forever at roughly eighty bytes per inbox chain this node writes - two per
persona - where the journal alternative grew by a frame per notice, unbounded, on exactly the
flood surface.

The write-ahead order has a provable asymmetry that makes the whole thing simple:
**under-recording is fatal** (a rebuilt device re-signs a seq its siblings hold -
equivocation), so the checkpoint lands before the insert; **over-recording is harmless on
these services specifically** - the crash between checkpoint and insert leaves the file ahead
by one, a rebuilt device continues from the phantom position, and the resulting gap is
indistinguishable from pruning, which suffix admission already forgives. The failure the
ordering permits is the one the gate was built last hour to accept. The two features
interlock; neither is this simple without the other.

The sweep of paths, each closed: `imaol::append` checkpoints-instead-of-journals for
ephemeral services and falls back to the checkpoint when the database has no head; sync's
`store_entry` skips the journal for sibling inbox chains (no checkpoint needed - we never
append to chains we merely hold, and the sibling re-supplies its suffix); journal BACKFILL
(the lost-journal recovery flow) filters ephemeral entries so "the journal never holds inbox
cargo" is true on every path, not just the common one; and the rebuild-by-replay flow now
correctly resurrects everything durable and nothing ephemeral. The invariant's own module doc
carries the exception loudly, since "journal ⊇ database, always" is quoted in several places
and is now "for durable services".

REFACTOR's journal-compaction entry: deleted, resolved by removing the need. The privacy
claim sharpened with it: "a pruned prefix cannot leak" is now true of the disk, not just the
database - the checkpoint holds hashes and sequence numbers, nothing about who knocked.

Gates: full `just ci` green, exit code read before any pipe. The test that is the whole
point: write three notices, open a fresh database against the same checkpoint file, append -
and watch it continue at seq 3 linking the exact old head, no fork anywhere.

## 2026-08-09 to 08-10: Reads That Grow With History - the full-chain audit

Seven entries, kept whole in
**[`history/2026-08-chain-genesis-roundup.md`](history/2026-08-chain-genesis-roundup.md)**
rather than folded into a paragraph here, because the sequence is the point: the audit was
provoked by a wrong answer, its first fix could not be measured, its middle fixes kept turning
up bugs that had nothing to do with scanning, and it ended on a rule worth more than any of
the individual patches.

It started with three idle dev nodes at 23-34% CPU, a fold memoized on suspicion, and a
profile that immediately showed the suspicion had named the wrong function. Curtis then asked
for the general case - every place that walks a chain from genesis, identity chains exempt
because they are small and correctness-critical - on the grounds that YAGNI does not apply
here: the target is tens of thousands of entries from the outset. Twelve sites, seven fixed.

What shipped: `local_frontiers` and `missing_plan` read the chain-heads memo instead of
scanning the log on every sync exchange; `documents::materialize` left the save path, so
saving one note stops threading the whole notebook; the ingest path's whole-log revalidating
rebuild became a scoped view drop, so a stranger's revocation no longer buys N signature
verifications; the raw-log endpoint pages; journal backfill streams; and `entries_of_type`
now refuses services that have no bound rather than trusting its callers.

Two bugs fell out that had nothing to do with scanning - an `inbox_notices` view no rebuild
ever cleared, and a view/watermark mismatch that let an eviction on one document lane destroy
the other lane's rows and sweep an honest post out of its author's own feed, live through two
green CI runs. And no measurable wall-time: both A/B runs came back flat, because the
benchmark starts from empty databases. The justification is the asymptote and one profile,
stated as such.

The rule, which outlives the patches: **a read whose cost grows with an identity's history
needs a watermark, a cursor, or a named reason it is bounded.**

A small drift fixed on the way out (2026-08-10): `just test-data` named the first three dev
ports outright, which was true while `just start` and `start-two`/`start-three` were the only
ways to boot a network and quietly wrong from the moment `start-n` arrived - `just start-n 6`
got a generator that could only see half of it. It probes this checkout's dev lane for whoever
answers `/health` now, announces what it found, and says how to start a network when nobody
does. A probe cannot drift the way a baked list does.

And the correction the roundup leads with, because it belongs where people skim: **the CPU
symptom that provoked all this was never attributed.** The suspect could not have been the
cause - the databases are 6 MB with a 909 KB largest file, and no `GROUP BY` at that size
costs a third of a core. The profile that named it was a wall-clock sampler, which cannot tell
computing from waiting on a mutex. An empty node on the current binary idles at 0.3%, so the
cost is per-persona and there is a floor to bisect from; REFACTOR carries it as open.

## 2026-08-10 — the door stops confirming blocks

A question about the inbox tiers ("when someone is blocked, they can't even post in the
stranger tier?") turned up a property nobody meant to ship. Blocked was refused correctly, at
check (5), before classification — a blocked sender has never been able to take a stranger slot.
But the *answer* went back as `refusal::GATE`, and by 2026-08-10 that code had run out of
company.

`GATE` is coarse on purpose. Doctrine's line is that refusal leaks exactly one bit — "they are
not accepting this from you" — with below-floor, muted and over-quota sharing one code, because
distinguishing them turns a refusal into an oracle. The defence works while the set has
members. It stopped having them: **the ring buffer deliberately retired the quota check** (a
new notice always lands; the oldest stranger ages off the floor), and the pre-Trust classifier
refuses nobody, so `blocked` was alone under the code. One envelope, one probe, and a sender
knew. The two fixes that made the inbox better each removed one of the block's neighbours, and
nothing in the code could notice.

**A block is now answered `Accepted`.** `Verdict::Refused` became `Verdict::Blocked`, and every
verdict the gate can reach maps to the same wire answer — the sender is told the same thing
whether they were transcribed, dropped as already-pulled, or blocked. They retry nothing, which
is what they would also do against a node that was merely offline.

The doctrine took the amendment rather than an exception. *Words beat resets* is right because
a refusal tells a sender about **themselves** — too little standing, too much traffic — which
they can act on and are entitled to know. Whether you blocked them is a fact about **you**. The
distinction pays for the one place in this system where a node answers falsely, and it buys the
property the block was actually for: not "you cannot reach me", which invites evasion, but *no
signal at all*. The visible refusals that arrive with Trust report the sender's own standing
and stay spoken aloud.

The cop is written as an equality, not a mapping: `wire_answer(Blocked) == wire_answer(
Transcribed)`. Asserting "blocked maps to accepted" would only restate the match arm, and would
still pass for a fourth verdict added later that leaks.

Two stale comments went with it, both drift from the ring-buffer change: `accept`'s check-order
list still described a pool check whose own body says, twelve lines down, that it deliberately
does not do that, and `Verdict` still called itself "one verdict for blocked and over-quota
alike" after over-quota stopped existing. Small, but they were the exact comments a reader would
have trusted to conclude the oracle was covered.

## 2026-08-10 — the door learns to say "not you, me"

The block-oracle fix left the delivery door with two answers and three things to say. `Accepted`
meant the sender's business was concluded; `Refused` meant a fact about the sender or their
envelope that they could act on; and a node whose keystore was briefly locked, or whose database
was busy, had to pick one. It picked `Refused(GATE)` — and a refusal is retired by the sender's
outbox forever, correctly, because retrying a refusal is what a spammer does. So *our* transient
fault silently destroyed a notice that nobody had refused, and the sender was told it was their
own fault.

`DeliverMessage::Busy` is the third answer: the 500 to the other two's 200 and 4xx. It carries no
detail, deliberately — an internal failure is not the sender's to debug and its shape is not
theirs to learn — and it maps to `Outcome::Unreachable`, which is the one outcome the outbox
retries rather than retires. The backoff ladder and the expiry that already existed for a
recipient whose phone is asleep now cover a recipient whose node is having a bad minute, which is
the same situation from the sender's side and always was.

One behaviour changed beyond the mapping: **a busy door no longer ends the attempt.** The dial
ladder used to return on any answer, so one unlucky machine consumed the whole try. Busy is a
door that did not work, so the loop continues to the next candidate — the sender needs *a* node
of the recipient's, not that one — and only falls out as `Unreachable` when every door is busy or
silent.

That left `refusal::GATE` with no producer at all: the quota check is gone (the ring buffer),
the pre-Trust classifier refuses nobody, blocks answer `Accepted`, and now internal faults answer
`Busy`. It is kept, documented as unproduced, because below-floor refusal returns with Trust and
that one is a genuine spoken refusal. The useful invariant meanwhile: **the door's only refusals
are `MALFORMED` and `NOT_SERVED`** — one a fact about the envelope, one a fact about this node,
neither a fact about what the recipient thinks of you.

The new cop is small and pins the mistake that would be invisible: `Busy` and `Accepted` are both
fieldless, separated on the wire only by a tag, and confusing them turns "try again" into "your
job is done" — a notice lost with nothing logged anywhere.

## 2026-08-10 — one fact, one row: the bell stops saying it twice

Curtis found "User A follows you (stranger)" and "User A follows you" sitting in the bell as two
rows, and diagnosed it correctly from the symptom alone: A knocked while he did not follow them,
the envelope was transcribed, he followed them back, and the fold then derived its own row from
the very chain the envelope had been quoting. Two machines, each behaving correctly, describing
one event.

The gate enforces "a follow-edge produces no inbox row, ever" at transcription, which is the only
moment it *can* - but the relationship outlives the moment, and nothing retired the row that was
already correct when it was written. The handler's own doc claimed the transition already worked
("answering the door converts them to the derived path"): true of future notices, and nobody had
noticed it was false of the notice that prompted the answer.

`undelivered_twice` drops a delivered row when the derived list already holds the same
`(author, kind)`. The derived one wins on the merits rather than by ordering: folded from the
author's own chain under the sync gate rather than transcribed from a stranger's envelope,
current where the envelope is a snapshot of whatever was claimed at knock time, and carrying the
byline that answering the door is what buys. Suppression at read time rather than eviction,
because the inbox is a memo of chains that get refolded - a deleted row would come back on the
next rebuild, and the rule survives every rebuild by not being stored.

The cop that matters here is the third one, not the two obvious ones. The dedup matches on a
string that two modules declare independently - `notifications::KIND_PUBLIC_EDGE` and
`deliver::notice_kind::name(PUBLIC_EDGE)` - and if those ever drift the failure is not a crash or
a red test but this exact bug, quietly back in the bell. So a test pins them equal, and says why.

Two residuals, both recorded rather than fixed. The suppressed notice keeps its slot in the
stranger tier's 512 until it ages off the floor - real, since that pool is the flood surface, but
a chain entry cannot be surgically removed and the ring already has an answer. And the dedup sees
one page of each list, so a delivered row whose derived twin sits beyond a hundred rows survives;
at that depth the reader has scrolled far past the point where either row is news.

## 2026-08-10 — the sweep learns to wait for the shelf

`a repudiated device's posts are retracted from feeds` went red twice on the GitHub runner while
`just ci` stayed green locally, reporting an empty feed where one honest post should have stood.
Green-here/red-there is usually a scheduling difference, and it was — but the scheduling
difference exposed a real bug, not a flaky assertion.

`drop_views_fed_by` clears the document views and then, in a separate loop, clears their
watermarks. `Db::execute` takes `stmt_lock` per statement, so those are separate acquisitions
with a gap between them, and inside the gap `doc_heads` is empty while the POSTS watermark still
says "already folded". Every reader catches up before reading and every catch-up writes rows
before advancing watermarks — the fold ordering was never the problem — but a catch-up finds
nothing past an un-cleared watermark. So inside that window the shelf reads as legitimately
**empty**.

For every reader but one, that is a blank page for a millisecond. `retract_vanished` reads the
shelf to decide which journaled documents have vanished, concludes that all of them have, and
deletes them — permanently, because `feed_journal` is only ever written forward on a public move
that has already happened. The honest post is collateral, and nothing rewrites its row.

The fix is that `retract_vanished` now holds the author's ingest gate across the read and the
delete. Eviction already runs under that gate (`ingest_batch` holds it across
`refold_after_eviction`), so taking it here makes "the views are settled" true rather than
likely; `lock_ingest` is acquired in exactly one other place and `after_public_move` is never
called from inside it, so there is nothing to deadlock against. The rule worth keeping, because
it generalizes past this function: **the danger was never reading a transient view, it was
writing a deletion based on one.** A reader that only renders can be wrong for a millisecond; a
reader that destroys durable state cannot.

The test had its own, independent defect, and it is the reason two CI runs produced an ambiguous
message. `return t.includes("doomed-post") ? null : t` hands `settle` an empty array the moment
the feed is cleared — and `[]` is truthy — so the poll latched onto the transient and reported it
as the final answer. Both middle assertions now wait for *doomed absent AND honest present*, so a
future failure means "the honest post never came back" instead of "we sampled mid-refold". The
first and last `settle` in the same test always guarded correctly (`t.length >= 2`,
`t.includes(...)`); these two were the only unguarded ones in the suite.

Recorded honestly: the failure never reproduced on this machine, so the diagnosis rests on the
mechanism being readable in the code rather than on a red-to-green demonstration. The action is
the verification, and the test change is what makes its next answer unambiguous.


## 2026-08-10 — the door starts charging, and the dial is cut before it exists

Curtis: "there's a gaping proof-of-work-sized hole in our inbox implementation... it's still
completely trivial to have a box spin up 512 completely fresh identities and stuff a person's
inbox ring, yeah?" Yes, and cheaply: no rate limit on the delivery ALPN (by design - it is the one
channel that assumes no prior relationship), no stamp, and `classify()` sending every fresh
identity to the stranger tier. One keygen, three signatures, a QUIC dial, about a kilobyte.

Two things were already true. The **ring bounds the damage**: a flood fills the stranger tier and
evicts other strangers, and cannot touch the trusted tier, because they are different chains. And
the **stamp slot has existed since the envelope was designed**, empty, waiting.

The argument that had to be settled first was one I had written into the plan myself - a bullet
titled "Why not a small always-on price". Curtis drew the distinction it was missing: that argues
against a *significant* baseline pretending to be a defence, and says nothing about a trivial one
whose job is to make the machinery real. **A dial you have never turned is not a dial you can turn
confidently at 3am.**

What shipped: BLAKE3 hashcash, difficulty in leading zero bits, the challenge being the envelope's
own body with the stamp stripped - so a solved stamp is worth nothing on any other envelope, to any
other recipient, for any other kind. Calibrated rather than guessed: **19 bits, 32ms release and
40ms debug** on an M1, against **0.28us to verify**. That asymmetry is why hashcash and not Argon2:
memory-hard functions cost the verifier what they cost the solver, which under a flood is a CPU
amplifier aimed at the node being flooded. The stamp check therefore runs *before* the signature
checks - one hash to refuse, rather than three ed25519 verifications.

**Then Curtis took the dial away, and was right to.** The question that did it: does the sender
just pay whatever it is quoted? A malicious node could post engagement-bait, quote an enormous
price, and farm CPU out of everyone who followed it. Two holes fell out. The sweep re-solved on
*every* quote, so a door that simply always answers `NeedsStamp` could make a sender grind once per
retry for three days - fixed by refusing to re-grind for a price the envelope's existing stamp
already clears (the door is lying; `solve` is deterministic, so a second grind returns the
identical nonce). And the protocol ceiling was doing two jobs: "no door may demand more than this"
and "this message is not worth more than that to me" are different questions, and only the second
belongs to the sender.

Then he followed it down: **a price high enough to deter a real flood is also high enough that
honest phones stop paying it, at which point the only senders still willing are the attackers.**
That is an oblique refusal which costs the refuser nothing and the honest stranger everything -
worse than simply saying no. So the dial went before any of it was built: no flood detector, no
stress signal, no decay. What is left is a small fixed price, `RINGTOME_POW_REQUESTED_BITS` and
`RINGTOME_POW_WILLING_BITS` as boot config, and no runtime adjustment anywhere. The protocol
ceiling went with it - a ceiling only ever bounded how far a *dynamic* price could climb, and the
sender's own willingness is the whole answer without help from the protocol.

The knob exists for one reason and the comment says so: a price calibrated to tens of milliseconds
on 2026 hardware is a rounding error on 2035 hardware, and an operator should be able to keep it
honest without waiting for a release. Both numbers are logged at boot, and a node charging more
than it will pay warns about itself, because the failure either way is silent - an inbox quietly
emptier than it should be.

**The honest ledger, unchanged by any of it: this turns a zero-second attack into a twenty-second
attack.** A mild inconvenience, and that is the whole claim. What bounds the flood is still the
ring; what would actually close it is the flow floor, which needs Trust.

Process, because two of these nearly landed silently. The first `just ci` returned **101, not 0** -
a clippy `assertions_on_constants` error - while the task summary reported the wrapper's exit
rather than the recipe's; a later run reported 0 for a `just` that never ran at all, started from
the wrong directory. Only the recipe's own exit code is worth believing. Clippy was also right on
substance: the invariant it objected to belongs in a `const _: () = assert!(...)`, where there is
no moment at which it could be false.

And an error of mine that was load-bearing: the ceiling was documented at "about 17 seconds" by
extrapolation. Measured, **1.7s** - off by ten. Three asserted-then-corrected measurements in one
day (an overnight CPU average that was really a sleeping laptop, a post-wake spike reported as
steady state, and this) is a pattern rather than three slips. Measure before asserting; one window
is a story, not a number.

## 2026-08-10 — rebroadcast: the arc from "how do I share this" to "and the author can take it back"

One sitting, six slices, and the interesting parts are all places the design changed under
questioning rather than places the code went in. Recorded as one entry because the story only
makes sense in sequence.

### The shape, argued before anything was written

The question was how to share someone else's post through your network, and the tension was
stated up front: **copying content whole into your own chain is the easy replication model and it
destroys the original author's ability to delete or edit that content, ever.** The balance point
turned out to be one the system had already found for feeds - the author's shelf is
authoritative, everything downstream is a disposable copy that honours it - proven end-to-end
that same morning by the repudiation work, where a disowned device's posts were swept from a
follower's journal and its bodies un-served on nodes the author never touched. *A delivery memo
cannot launder disproven content*, generalised one hop out.

So: **a signed pointer on your chain, plus a pinned replica your node serves. Never a copy.** The
pointer is the durable social act (`(author, doc_id, version_seen)`, LWW, retraction by
omission); the replica is the virality, carrying the author's own signed entry and body so no hop
can launder provenance. **Silence preserves, speech deletes**: an author who merely goes offline
cannot retract, so their content survives through the replicas - the availability that full-copy
wanted - while an author who *actively* retracts is honoured by every honest node. Full-copy
trades the second away to get the first; this keeps both, and edits keep working too.

### What shipped, in order

**The pointer** (`service::REBROADCASTS`, its own chain). Its own chain rather than an entry type
on `posts` for a reason that bites twice: a view watermark is per `(author, service)`, so two
folds sharing a service fight over one cursor - and the separation is the *feature*, because a
reader's rebroadcast band is a different dial from their interest band. Memo-backed from birth
rather than after the fact: the full-chain audit's rule applied before it could be broken.

**The pin**, which turned out to be a different object than it looked. The obvious reading is
"keep a copy so we can serve it". The half that matters: **a pin is what keeps the author's
retraction reachable.** A copy nobody refreshes can never learn it was withdrawn - which is
exactly the permanence full-copy would have handed out, arriving by the back door. So a share
holds its author in the sync worklist past the moment every contact dial pointing at them goes to
nothing. The test says it plainly: with no subscriptions row anywhere, one share puts the author
in the worklist; withdrawing takes them out. It also lands cleanly on *Pull, Not Push* - a share
IS the accountable demand signal, so `detach` releases a departing persona's pins.

**Both notice halves.** Delivered (`notice_kind::REBROADCAST`) for an author who does not follow
the sharer, with the binding that makes it evidence rather than assertion: the pointer must name
the RECIPIENT as the shared document's author, or anyone could announce a share of anyone's work
to anyone. Derived (`KIND_REBROADCAST`) for an author who does. Building the derived half forced
a schema correction: notifications collapsed per `(reader, author, kind)`, which is right for
edges (a re-published edge is the same fact restated) and **wrong for shares** (two of your posts
shared are two facts, and collapsing would have silently dropped one). The key gained the object.
`doc_id` is `NOT NULL DEFAULT ''` rather than nullable because SQLite permits duplicate NULLs in
a primary key - a nullable object column would have silently un-collapsed the kinds that need
collapsing.

**The public tombstone**, which closed a hole nobody had noticed. Deleting a document wrote an
LWW set-add on the **doc-meta chain** - private, epoch-encrypted - so it reached the author's own
devices and nobody else. Every follower's feed and every rebroadcaster's replica went on serving
a post its author had taken down, forever, with no signal that could ever say otherwise. The
design's central promise was resting on a mechanism that did not exist. `POST_RETRACT` is the
public half: content-free by construction (sixteen bytes of doc id, asserted under 32 bytes by a
test), riding the POSTS chain so it travels wherever the documents travelled. The payoff needed
no new plumbing - `public_doc_ids` is the chokepoint every public surface already reads, and
`fanout::retract_vanished` already reconciled every reader's journal against it.

**The media budget.** Checked at the END of the bake, because a single upload passing the
per-file cap says nothing about a post embedding forty of them. Deduplicated by blob hash (one
image three times is one blob on every node that carries it), measured through a new
`FileStore::size_of` that reads blob metadata rather than pulling megabytes through memory to
learn a number the store already knew.

### Four design corrections, which are the real content

**Pins must never propagate with viewing.** Caught at design time, and the failure mode is
precise: if *seeing* a share ever created a chain subscription, density does the rest - in a
well-connected network everyone eventually sees everything once, and "pin a fragment of the
author's chain" degrades to every public persona synced to every computer. So pins are created by
the deliberate act of sharing, on the sharer's own node, and nowhere else. Readers hold a
**document fragment with an origin**, revalidated against **the edge it arrived by, never the
author** - which makes retraction cascade down the share tree over edges that already exist, and
adds zero new sync edges however dense the network gets.

**A tombstone is final for its document id.** This one arrived by starting to build the wrong
thing: an LWW comparison of retraction against versions, abandoned on discovering `doc_heads`
carries no `seq` - and then realising the comparison should not exist. Re-publishing after a
delete mints a NEW doc id ("the record is the record"), so "retracted then republished under the
same id" is not a state the system produces. Finality buys order-independence for free: fold the
tombstone first or the header first, both settle to withdrawn.

**The fold widens; it does not split.** Headers and tombstones share the POSTS chain and therefore
one watermark, so two folds would have skipped entries in silence. `catch_up_public_lane` now
folds both types in one seq-ordered pass, with an interleaving test as the cop. (The same
constraint that put rebroadcasts on their own chain - there the types belonged apart, here they
belong together, so the fold moved instead.)

**Preview tiers, proposed and withdrawn.** "A share's disk cost is bounded per doc" was wrong: the
transcode cap bounds each blob, nothing bounded how many a body referenced. The proposed fix - a
preview tier owed by fragments, full media fetched on play - was rejected on the grounds that a
hundred-track doc is not one post but a **Taxonomy** of them, and that viral transmission of the
*real bytes* is what keeps the network feeling fast. The bound moved to the source instead: cap
the post, carry everything. The honest cost of the whole retraction design, recorded as a
decision rather than discovered later: **you cannot fix a typo in a two-year-old post**, because
the edit window freezes content and the recourse is delete-and-repost under a new id.

### The trim that keeps it affordable

The unbounded-memory question - how does a node answer "is this still live? was it edited?" about
arbitrarily old documents without either deep search or memoizing everything forever - was split
by the same move the inbox ring made. **Edits are allowed only within a window of publishing**
(rolling state, O(posting-rate × window), never growing with history, and it kills the rug-pull as
a side effect since the window anchors at publish rather than at share). **Deletes are memoized
forever** because they are sixteen content-free bytes, and one-bit-per-document is exactly what
compact sets are for. The window is judged by the author's own claimed delta, not local receipt
time - receipt time diverges, since a fresh node syncing an old chain would find everything "in
window" and honour an edit every established node refused. Bloom filters carry the delete-sets
between nodes, **allowed to be wrong in one direction only**: bloom-negative means definitely
live, bloom-positive means fetch the signed tombstone, which is proof.

### Residuals

The feed does not show shares yet (`feed_journal.via_root` has waited since the pin slice), the
edit window and the delete-summary filters are unbuilt, and the fragment ledger - the piece that
lets a reader resolve content they do not already hold - is the last one. Two cops earned their
keep along the way: `conventions.rs` caught a new user-db call site and made the
once-per-edge-versus-once-per-persona judgment explicit, and the kind-string test now loops over
both notice kinds, because two modules declaring the same string independently is how a dedup
silently stops matching.

And a hole found in a cop rather than in the code: **the localization extractor silently skips
string literals written across two lines with a `\` continuation.** A refusal message went in
unlocalizable, `just strings` reported "+0 new", and `strings-check` stayed green. Long messages
are the most user-visible ones, and `tools/strings.mjs` already carries a comment about a
previous version of this same class of bug. Left unfixed, deliberately, rather than fold a
tooling repair into a feature commit.

## 2026-08-10 — the cop that could not see wrapped sentences

A side-quest off the rebroadcast arc, taken while it was fresh. Writing a publish-refusal message
the natural way for a long sentence - wrapped across two lines with a trailing backslash - put a
user-facing phrase into the source that `tools/strings.mjs` could not see. `just strings` reported
"+0 new". `strings-check` reported green. The phrase would have shipped unlocalizable, and the one
mechanism whose whole job is making that impossible said nothing.

The cause was one missing regex flag: `\bmsg!\(..."..."...\)` without `s`, so the `\\.` alternation
could not match backslash-newline and the entire `msg!` failed to match. **An extractor that finds
nothing looks exactly like a source with nothing in it**, which is why the failure was silent - and
why it selected for the LONGEST messages, since those are the ones anyone wraps.

Fixing it surfaced **six phrases that were already missing**, none of them mine: four adoption
errors, an annotation-size refusal, and the taxonomy cycle message. All long, all wrapped, all
invisible for as long as they had existed. 422 phrases became 428.

This was the second round of the same shape. The file already carries a comment from round one -
a pattern anchored without the trailing comma rustfmt leaves behind, which "silently skips exactly
the longest and most user-visible messages". Same failure, same selection bias, same silence. So
the fix is not just the flag:

- **`unescapeRust` is now its own named rule**, because a continuation is not an ordinary escape:
  `\` before a newline eats the newline *and* the next line's indentation, which the generic
  backslash-X unescape would have got wrong even once the pattern matched.
- **The tool no longer runs on import.** Its entry point is guarded, so loading the module has no
  side effects - which is what lets a test exercise the scanners at all. A tool that rewrites the
  catalog merely by being imported is its own footgun.
- **`integration/test/pure/strings.cjs` is the cop for the cop**, and every fixture in it is a
  WRAPPED form, because that is the shape both rounds shared. It was verified the only way a
  regression test is worth anything: the flag was removed again, three of the five tests failed,
  and the flag was put back. Two of the three cover span arithmetic rather than extraction -
  `syncSeeds` rewrites source in place using those offsets, so a drifting span corrupts files
  rather than merely missing a phrase, which is the worse of the two failures.

The rule this leaves behind, for any scanner whose job is to find things: **a finder that reports
nothing is indistinguishable from nothing being there, so it needs a fixture that proves it can
still find.** Every pattern in this file that matches source across a line break is now one
rustfmt decision away from the same silence.

## 2026-08-11 — the fragment ledger: a reader holds one document, not a subscription

The last piece of the rebroadcast arc, and the one the design had been deferring since the
pointer shipped. A reader following a sharer holds "B shared A's document D" and needs D's words.
The obvious implementation - start syncing A - is the one thing the design forbids, and the
reason is worth restating because it is what the whole slice is shaped around: **a chain pin must
never propagate with viewing.** In a dense network everyone eventually sees everything once, so a
subscription created by *looking* degrades to every public persona synced to every computer.

So the reader gets a **fragment**: the author's exact signed entry plus its blobs, fetched from
the ORIGIN that handed over the pointer, verified offline, and held with no sync edge to the
author at all.

### What shipped

`proto::fragment` is a one-request/one-answer ALPN. Four message types where three would have
compiled, and the fourth is the interesting one: **`Gone` and `Unknown` are different words.**
*Gone* is a fact about the document - withdrawn, drop it. *Unknown* is a fact about the node -
ask somebody else. Collapsing them would make a reader delete a live share every time it asked a
node that simply did not carry it.

`verify_fragment` checks the document id against the request, which is not ceremony: without it
"fetch what B shared" becomes "fetch whatever B feels like", and a hostile origin could answer
with a genuinely-signed document by the same author that is not the one the pointer endorsed.
The delegation walk moved out of `deliver::verify_claim` into a shared `walk_auth_path` - both
make the same offline claim about somebody else's key, and a second copy is a second place for
the "is not a chain from the claimed root" check to go missing.

The door **serves only what it already carries**, and never fetches on demand to satisfy a
stranger - that would make any node a lever for pulling arbitrary content onto any other. It
answers from its own copy of the author's chain first, then from its own fragment ledger, which
is what lets a fragment relay one hop further and survive both the author and the sharer going
dark.

Bodies ride the existing lane: `bodies::want` is a new additive note, because `reconcile`
replaces a set computed from held chains and a fragment's body has no such walk behind it. Without
it a shared document's words would have depended on one fetch succeeding, with no retry, forever.

### Four failed CI runs, and where the failures actually were

Every one was in a **seam**, and none in the parts that looked hard. The verification, the
framing, the `Gone`/`Unknown` design - all correct first time. What broke:

1. **The conventions cop caught a layering violation**: a raw `SELECT ... FROM entries` written
   into `record/documents.rs`, a table owned by `record/imaol.rs`. Fixed where it belonged
   (`imaol::entry_by_hash`), not where it was convenient.
2. **The candidate list was rebuilt from `stored_tree_leaves` alone** - the one address source
   that carries no addressing information, so every dial failed with "No addressing information
   available". `net::deliver::candidates` had solved this fifteen feet away, putting `fetched_via`
   first. Now shared.
3. **The sharer's own node dialled itself**, because it runs the same journaling path and the
   origin is itself. `net::deliver` already had the housemate answer: do it in-process.
4. **The test shared the wrong id.** A private `doc_id` rather than the public `post_id` that
   publishing mints - so every origin was asked for a document that exists on nobody's public
   shelf, and correctly answered `Unknown`. `repudiation.cjs` had the right idiom on line 399.

The fourth one hid behind an instrumentation gap: `journalable` returned `None` on `Unknown`
**silently**, so "every origin says it does not carry that" looked exactly like "the fold never
ran". Adding three debug lines - does this identity have a share chain, how many readers and
pointers, how much of the author's shelf do we hold - found it in one cycle after three cycles of
reading code. Those lines stayed, and `Unknown`/`Gone` now log too.

The lesson, recorded because it recurred all session: **when a distributed path fails twice,
instrument it rather than re-read it.** Three of the four fixes were correct and insufficient,
which is the signature of debugging by inspection on a path with real concurrency in it.

### What it proves, and what it does not

`integration/test/rebroadcast.cjs` now passes its headline case across three nodes in 259ms: Cleo
follows only Bob, has never heard of Alice, syncs no chain of hers, and ends up with Alice's post
in her feed - credited to Alice, bylined via Bob. No new sync edge anywhere.

Not proven yet: that the network **keeps** it. The node-death case - kill A and B, assert C still
serves from its own fragment - needs a self-hosting harness (the shared four nodes cannot be
stopped mid-run without breaking every other spec; `mainline.cjs` shows the shape). That test is
what turns "C can fetch it" into "the network keeps it alive", and it is the next thing to write.

One residual, small but visible: a fragment has no folded chain stamps of its own, so its
`published_ms` is the fetch moment. In a feed ordered by publication date a shared post will sort
by when it arrived rather than when it was written, which is wrong and will want the author's
claimed stamp carried in the fragment.

## 2026-08-11 — a stranger gets a name, and it goes in quotes

Curtis, on the bell: "when an unknown user - a stranger - sends a notification into my inbox,
they're just rendered as 'banana-boat' or some similar speakable version of their key... getting
followed by an identicon with an anonymized name isn't really very clear."

The rule he was questioning bundled two jobs, and only one of them was real.

**Bounding fan-out is real and stays.** Fetching a stranger's profile means syncing their chains;
a flood of stranger notices would become a flood of syncs, turning the inbox into an amplifier
pointed at its owner. Nothing here touches that.

**Stopping impersonation was never happening.** Hiding the name does not prevent anyone from
BEING "Bank Support" - it only makes honest strangers unreadable, while the hostile ones are
equally unreadable and equally free to try. The legitimate case paid the entire cost. Worse for
safety, arguably: "banana-boat followed you" gives a reader nothing to be suspicious *of*.

So the constraint to keep was **no fetch**, not **no name**, and those come apart cleanly.

### The design that was proposed, and why Curtis was right to kill it

The first proposal was to carry the sender's signed `profile-set` entry as evidence - verified
offline by the same auth-path walk, no sync - on the theory that a *published* name is
accountable where a per-recipient string is not. Curtis: "does it give them accountability? they
could just forge their whole profile chain from genesis, ending in 'Bank Support', couldn't they?"

Yes. A fresh identity's chain is attacker-controlled end to end, so "Bank Support" is a genuine
signed entry the moment they decide to sign it. **A signature proves authorship, never honesty**,
and accountability needs something to lose - which a throwaway identity does not have. What the
signed form would actually have bought is narrow: per-recipient lying would need equivocation
(self-proving, if anyone ever compares) instead of being free, while lying with a STALE entry
stays undetectable either way, since the recipient holds no copy of their chain head. That is not
worth an evidence field, a verification branch, and envelope bytes.

Which meant the defence was never going to live in the field at all.

### Where it does live: the rendering hierarchy

**The unforgeable thing holds the identity position.** The speakable words and identicon are
derived from the root and cannot be chosen; the claimed name is an annotation beside them, in
quote marks, never in their place. A stranger calling themselves "Ringtome Support" then reads as
an unknown key making a claim, which is exactly what it is. The quote marks are the whole safety
argument in one glyph - they say "their words about themselves" where an unadorned name would say
"this is who this is".

Shipped: `Envelope::display_name`, capped at 64 bytes (a name is shorter than a sentence, asserted
at compile time against the greeting's 280); read from the sender's OWN published profile rather
than taken as a parameter, because there is one honest answer to "what is this persona called" and
a parameter is how per-recipient names happen by accident; folded onto the inbox row at
transcription rather than decoded per bell read; and surfaced as `claimed_name`, its own wire
field. That last one is deliberate: sharing a field with the fetched-and-verified `author_name`
would let a future client render a claim where a verified name goes, and the distinction would
quietly die. Separate fields make the misuse require a decision.

### The bug the fix introduced, caught immediately

With strangers named and everyone else not, the bell read `<chip> "Gary" follows you · a stranger`
beside `<chip> follows you` - because `PersonChip`'s label is a hover tooltip, and `sentence()`
returns a bare verb phrase. **The unverified claim had become more prominent than the verified
name**, which is the precise inversion the whole design exists to prevent. Curtis spotted it in
one line.

Fixed by giving EVERY row a visible subject: a followed persona's real name (from the byline
cache, read off their own chain when we synced them) unquoted in the subject position, a
stranger's quoted, and the speakable form of the key when there is neither. Styled deliberately at
the same weight - the difference between them is the quote marks and the stranger tag, not colour
or boldness, because a reader should have to *notice* provenance rather than absorb it as
importance.

The pattern behind that mistake, and behind two others the same day (the via-line's hierarchy, the
share button's prominence): **a UI change reasoned about the element being added rather than the
row it lands in.** Locally right, globally wrong, three times.

### Residual

`an undeliverable notice waits` flaked once during this work and passed on rerun with an unchanged
binary - REFACTOR carries it with the diagnosis (a `settle` polling for the end of a four-hop
background chain, on a machine that had been running CI back to back for hours).

## 2026-08-11 — the tree, made real: four hops of edits and deletions with the fast lane off

Curtis: "If a fourth hop is not constructible in the design then we designed it wrong." He was
right, and the defect was a contradiction sitting inside one PROJECT_PLAN subsection: it
prescribed a STAR in one paragraph - every sharer pins the author, "one accountable demand edge
per (sharer-node, author)" - and reasoned about a TREE eight lines later ("...and so on to the
leaves"). Both were locally convincing. Both could not be true. The code faithfully built the
star, so every sharer subscribed to the author's whole chain (ten thousand shares of one post:
ten thousand full subscriptions - the exact fan-out the design forbids, arriving through the
door marked "accountable"), nobody ever relayed, `relayable` was dead code, and deletion
travelled exactly two hops and stopped.

The dissolving insight came from Curtis asking for star AND tree: **reachability never needed a
subscription.** "Is this document still alive" is one round trip on the fragment ALPN; the first
design conflated it with "sync their history", and only the second is expensive. So:

- **A share obliges a COPY, not a subscription.** The pin records "a persona here shares this
  document"; `rebroadcast_pins` stopped feeding the sync worklist entirely. Subscriptions are
  back to O(people you follow). The old unit test asserting the subscription -
  `a_share_keeps_its_author_synced_with_no_dial_at_all` - was a correct test of a wrong
  invariant; its inverse now stands guard.
- **Revalidation is star and tree, in that order**: ask the author (authoritative, jittered
  against the thundering herd a viral post would otherwise aim at its own author), fall back to
  the origin (who holds the content, and eventually the knowledge). The fast lane can be forced
  off under LOCAL_TEST (`RINGTOME_TEST_TREE_ONLY`), and the whole cascade suite runs that way,
  because a fallback that is never exercised has rotted by the time it matters.
- **The tombstone carries deletion past the second hop.** A node that hears `Gone` drops the
  words and keeps 48 bytes of fact (`fragment_tombstones`), and answers `Gone` itself thereafter
  - the only way a node that never held the author's chain can tell the next hop anything. Memo
  first, then forget: a crash between the two leaves a stale fragment the next sweep resolves,
  where the other order leaves a node that lies to everyone downstream.
- **A failed fragment fetch retries** (`fragment_wants`, the missing-bodies idiom). The share
  fold only re-runs when the sharer's chain moves, so "the pointer folded before the post
  synced" - a race measured in milliseconds - used to eat a share forever, silently. Found as
  "two pointers, one fragment" in the instrumentation; the want ledger is why the cascade seeds
  reliably now.

`cascade.cjs` proves it at full depth on a FIFTH integration node (echo, on the spare port lane -
the four-hop chain needs four p2p-capable nodes, and delta's inability to dial is delta's whole
job): edit in 3.8s, stacked edits converging on the newest, delete with the tombstone asserted at
both intermediate and leaf hops as the mechanism rather than the outcome, edit-then-delete. Each
scenario seeds its own document through the entire chain first - the first version shared one
document across every assertion, and the edit contaminated the deletes so thoroughly that a
day was spent chasing failures that were sequencing, not product.

Two real product bugs fell out along the way. **Deleting a published note never minted the
public tombstone**: the route asked `is_public` about the NOTE's id, and publishing mints a
SEPARATE public document (`published_as`), so the answer was always no and the retraction the
tombstone slice promised had never once fired. Curtis resolved the design correctly - deleting a
draft is housekeeping and must not cross the membrane; **unpublish is its own public gesture**
(`DELETE /posts/{post_id}`, "take it down" behind the edit unlock, warning that copies on
computers that never come back cannot hear it). And the eager outbox knock was missing from the
share path, so "someone shared your post" waited on a five-minute backstop beat.

The flake recorded yesterday (`an undeliverable notice waits`) failed a second time under five
nodes' load and got the fix its REFACTOR entry prescribed: the wait is staged on the
subscription row first, so each settle times one background hop and a failure names its stage.

What a long day of being wrong taught, kept for the next one: when a distributed path fails,
READ before reasoning (four of four wrong hypotheses were resolved by one debug line); a test
that shares state across scenarios is one test wearing several names; and a plan section that
argues two ways eight lines apart will be built one way and defended with the other.

## 2026-08-11 — a node that stops answering without stopping

The integration suite had no way to turn a node off. Every spec shares the rig's four nodes, so
"assert C still serves this when A and B are gone" could not be written at all: killing A and B
takes the next forty files down with them. The rebroadcast **node-death test** had been sitting in
NEXT_STEPS behind exactly that, described there as waiting on a self-hosting harness.

Two candidates were on the table - every spec boots and tears down its own nodes, or nodes learn to
go quiet on command. The second won, and the deciding argument was not that it is cheaper (it is):
**the two are not substitutes, and the quiet one is the sharper instrument for what these tests
actually claim.** "This reader needed nobody" is a stronger statement than "the other processes had
exited", and it leaves the partitioned node's HTTP surface up so a test can still interrogate it.
Killing a process additionally proves cold start, WAL replay, and a fresh UDP port with a dead
address cache - which is why `mainline.cjs` spawns its own nodes and will keep doing so. The
self-hosting harness is still the right tool; it is now the right tool for a much smaller set.

### Why it is a `/test/` route and not an admin instruction

The other shape considered was an admin-only instruction, alongside grant/revoke. Refused: that is
permanent production surface for **a node that silently stops talking to its peers while `/health`
stays green**, which is close to the worst outage this codebase could ship by accident, and it hands
a compromised admin account a partition button. `test_endpoints` already had the better posture -
the route is not *mounted* unless `RINGTOME_LOCAL_TEST` is set, so on a real node the path does not
exist rather than existing-but-forbidden. `Unplugged::arm` refuses outside local-test mode anyway,
because two locks cost one `if`. (A real operational *drain* is a legitimate future feature, and a
different design: it would withdraw serving records and refuse gracefully rather than blackhole.
A test's convenience must not get to invent it.)

### The four things that would have made it quietly wrong

- **Scope is per-ALPN, not "sync".** Peer traffic arrives over five ALPNs, and the fragment path is
  precisely the one the node-death test needs dead. A gate that only understood the word "sync"
  would have left the reader fetching the very document the test claims it already holds.
- **Both directions.** Inbound-only would leave an unplugged node still dialling out - an
  asymmetric partition, which is a real thing to test and a terrible default. `direction` asks for
  it explicitly.
- **A typo is a 400.** `alpns: ["fragments"]` silently refusing nothing produces a test that passes
  while proving the opposite of what it says. Names resolve through the ALPN table or the request
  fails, and `Refusals` can only hold strings that came out of that table.
- **The reset is a root hook, not a convention.** The failure worth engineering against is not a
  spec that forgets to plug a node back in - it is a spec that *dies mid-partition*, after which
  every later file fails on a network that isn't there and the diagnosis points at innocent code.
  So `withUnplugged` re-plugs in a `finally` (the belt) and `integration/roothooks.cjs` re-plugs
  anything this process touched after every test (the braces, which are what survives a hang). It
  costs one function call on the ~600 tests that never touch the gate.

### One table, and a cop to keep it honest

`build_endpoint` used to spell its five ALPNs inline; the gate needed the same list. Two lists of
ALPNs would drift the day a sixth protocol lands, leaving a gate that no longer covers the surface
it claims to - so `p2p::ALPNS` is now the single owner and the endpoint advertises what it holds.

The sharper risk is a seventh *dial site*. The gate is total only because every outbound connection
goes through `p2p::dial`; a call that reached for `endpoint.connect` directly would leave a partition
test passing while a whole protocol kept talking straight through the "partition" - failing silently,
and confidently. Nothing at runtime can notice that, so
`conventions.rs::every_outbound_dial_goes_through_the_gate` fails the build when `.connect(` appears
outside `net/p2p.rs` (plus `db.rs`, which is turso opening a file and no network at all). Verified
the only way a cop is worth anything: the bypass was planted back into `net/fragment.rs`, the test
went red naming the file, and it was removed again.

### Deliberately not built

A real partition usually looks like a **timeout**, and iroh has the higher-fidelity door for it -
`Incoming::ignore`, which answers no packet whatsoever. It can only be used before the handshake,
i.e. before the ALPN is known, so it cannot do per-protocol work; and every test using it would pay
a dial timeout in wall-clock. Deterministic and fast beat realistic and slow here, so refusals close
the connection instead. If some code path ever needs the timeout shape specifically, that door is
named in `Unplugged`'s doc and wants its own mode rather than a change to this one.

Also worth writing down: the gate stops the **transport**, not the directory. An unplugged node
still resolves serving records and still knows where its peers live. A test that needs a node to
*forget* its peers wants different scissors.

## 2026-08-11 — three documents about what kind of application this is

A conversation stretch, no code. It started as "how hard would it be to run the node behind a Godot
game?" and ended up reopening the packaging decision, so it produced [GODOT.md](GODOT.md),
[DESKTOP.md](DESKTOP.md) and [MOBILE.md](MOBILE.md) rather than a commit. **Nothing is decided:**
PROJECT_PLAN's *Delivery and Packaging* is unamended and still canon, and each new document says at
the top whether it proposes superseding a section or merely records why an idea keeps returning.
Registered in README's document list, which is the map.

Five findings did the work, and four of them are corrections to canon rather than new ideas.

### The Godot cost estimate was right about the renderer and wrong about the editor

*The Client Story*'s strike prices a game-engine client at "a renderer for a few dozen tags, not a
browser." That is literally true, better than it knew: `record/bake.rs` already parses Marquee in
Rust for the publication media pre-pass, so a gdext client links the same crate and gets the AST
free — the *second* implementation of the grammar in the tree, not a third.

The editor is where the estimate misses, in the cheap direction. The intuitive objection is that a
rich-text surface on `TextEdit` is a doomed multi-month project, and `js/doc/livemarquee.js` says
why that objection does not apply: the document never stops being plain Marquee source, styling is
projected onto the text, and "the editor's save machinery sees exactly the same thing a textarea
would: a string." There is no rich-text model in the system. Side-by-side (`js/doc/editor.js` names
all four modes) is a renderer plus a code editor with highlighting, and `CodeEdit` ships the
highlighter hook and the completion popup that `js/doc/completions.js` hand-rolls.

Which relocates the cost rather than removing it: with no single hard component left, what remains
is the long tail of ordinary data-bound screens. **Concentrated cost a solo project can beat with
one good decision; diffuse cost can only be declined** — so the shape is a narrow additive surface,
never a second complete client. The strike stands regardless, on its own terms.

### The Tauri rebuttal answers a question nobody asked

*Desktop mode: local server + system browser, NOT Tauri* rejects Tauri because "the app is already
a full HTTP server, so Tauri's core value (bridging a webview to native Rust) is a bridge we do not
need." Nobody picks a webview shell for the IPC bridge — they pick it for being an application:
one signed binary, its own window and dock identity, a tray, an updater. The section answered "do we
need IPC to Rust?" when the live question is "do we need to be an app?", and its own floor case
(auto-open the system browser, no GUI at all) is exactly the config-page feel that prompted this.

The skew argument in the same section survives and sharpens: "webview skew is a documented misery"
has a specific address here, which is **IndexedDB-on-WebKit versus the Dexie mirror**. That makes
it an argument for bundling Chromium rather than for shipping no shell.

Corrected the same day, when the two shells were compared properly rather than one-sidedly: Tauri on
Windows is Chromium (WebView2 is evergreen), so the exposure is macOS and Linux, not everywhere; and
*"we develop against real browsers and that is what ships"* splits in half, because the node serves
the UI over HTTP and so day-to-day development is Chrome-at-localhost under either shell. Tauri costs
the second half of that sentence, not the first. DESKTOP now carries the full comparison, the
three integration shapes (Electron-sidecar, Tauri-sidecar, Tauri-in-process), and the one experiment
that decides between them — **does the Dexie mirror survive WKWebView and WebKitGTK?** It plans
Electron regardless, on the strength of "when something breaks at 11pm, somebody has already hit it
and written it down," with the cost of skipping that experiment recorded rather than hidden.

### "No background sidecar on iOS, period" is about sidecars

*Phones: deferred, by design* concludes a phone "was always going to be a remote client of
always-on nodes, not a p2p citizen." The premise is true and the inference is not: in-process
linking lets a phone run the whole iroh stack. The conclusion survives on **background execution**
grounds instead, and the distinction is load-bearing, because "impossible" says be a terminal while
"foreground-only" says be an intermittent peer — which the sync design already accommodates (boot
catch-up, the gravedigger, the outbox rounds).

There is no middle option, checked in the code: `record/imaol::append` signs on the node, and
`tests/conventions.rs` nails the `entries` table to local authorship plus the sync gate. No
"client signs, node relays" door exists, so a phone is a peer or a terminal and nothing between.

### The arithmetic, and why the design survives it

A phone node up 30 minutes a day is p ≈ 0.02, so instantaneous availability needs k ≈ 150 replicas.
Hopeless on that metric — recorded so nobody rediscovers it. It is also the wrong metric: followed
content reads from the reader's own mirror, so phone-as-peer degrades to **staleness, not
unavailability**, and *Rebroadcast: Pointer Plus Pinned Replica* plus *silence preserves, speech
deletes* carry the rest. What has no mirror to hide behind: first contact, delivery to strangers
(whose own third mitigation assumes friends' always-on nodes), the `/id/` public web face, and push.

The reframe that makes it survivable, and the reason DESKTOP matters strategically: **the always-on
node does not have to be infrastructure anyone sets up — it can be the user's own desktop with
autostart at login.** That is what could let the federated half of the design become opt-in, which
*Always-on nodes are needed either way* currently rules out.

### What Dexie buys a local client

Of the five benefits *The Browser Is a View* claims, one is really reactivity rather than storage
(one `liveQuery` call site in `js/mirror.js`), offline reads are near-worthless when the node is
zero hops away, instant-boot is node-side snapshot cost misattributed to the client, multi-tab
coherence dies in a single-window app, and only "near-zero growth in bespoke read endpoints"
survives untouched — and that belongs to the stream protocol. Electron removes any pressure to act;
MOBILE carries the pluggable-store proposal, where WKWebView is mandatory. **A memory-only mirror
would discharge the "forget this browser" obligations by construction**, which is a privacy
simplification rather than a regression.

### Also found

`NOTES_APP.md` was deleted in `4684ccd` ("kill notes app") but is still linked from README's
document list and cross-referenced four times in PROJECT_PLAN as the discovery narrative. Its README
entry already says the canonical statements graduated to the Data Layer, so the pointers are
probably what should go — left alone pending Curtis, since editing canon's cross-references is a
call for the person who owns the canon.

No gates run: nothing outside `*.md` moved.

## 2026-08-11 — spike-tauri: a harness for the two questions Tauri has to pass

[DESKTOP.md](DESKTOP.md) names one experiment as the thing that decides Electron vs. Tauri, and
Curtis named a second the document had missed. `spike-tauri/` is the harness for both:

1. **Does the Dexie mirror work in a platform webview?** IndexedDB-on-WebKit is the highest-risk
   component in the client, and `js/mirror.js` is the whole read path.
2. **Can a platform webview run `video-ingest`'s browser-side encode?** The laundering premise -
   hostile decode happens in the browser, the server only ever sees our-encoder bytes - is what
   keeps the Rust video surface down to `rav1d` plus the `image` crate. It is also the question
   with a real chance of being fatal, and DESKTOP.md had not considered it.

### What it is

A Tauri v2 app that needs no `tauri-cli`, no npm, and no bundler: plain ES modules, `cargo run`.
`SPIKE_ORIGIN` switches the page between `http://127.0.0.1:<ephemeral>` (the shape where the node
serves the UI) and `tauri://localhost` (DESKTOP's stable-origin trick) - **both must be run**, since
storage is origin-partitioned and WebCodecs wants a secure context, so neither result implies the
other. `src-tauri` is its own cargo workspace, so `just ci` never builds Tauri.

The probes test the real thing rather than a model of it. `sync-vendor.sh` copies the **same Dexie
build the client ships** and video-ingest's actual `src/`, recording both versions in
`ui/vendor/VENDORED.json` so a result stays interpretable months later. The IndexedDB probe uses the
schema copied verbatim from `openMirror()` and performs what the live cache performs - clear-and-
replace per kind in one `rw` transaction across seven stores, then bulkPut/bulkDelete deltas, then
`liveQuery`. The video probe runs `ingestVideo()` itself.

### Three decisions worth keeping

**Decode and encode are reported separately**, because the two video failure modes are not equally
bad and one verdict would hide the difference: no AV1 *encode* is DEGRADED (the `frames` lane is the
designed answer; the cost is ~1.6MB becoming ~58MB), while no *decode* or no `AudioEncoder` is
BLOCKING (nothing can be laundered at all). On Linux the second is a live risk, because WebKitGTK's
media stack is GStreamer and H.264 is whatever the distro installed.

**A fixture failure is not an ingest failure.** The generate-a-clip button uses MediaRecorder, which
is itself under test, so its failure is reported in those words - the trap being a probe that blames
the pipeline for the harness.

**Outputs leave through `POST /save/`, not a download.** Webview download support is uneven; a POST
is not, and getting encoded bytes onto disk is what lets them be cross-checked against the Rust
decoders.

Every probe also checks its output **re-decodes**: a lane that succeeds while emitting something
unreadable is a failure we would otherwise discover on the server.

### Verified, and not

Verified on macOS: `cargo check`, `clippy` clean, `cargo build`, and the app boots - the harness
serves `index.html`, `probe.js`, and both vendored trees; path traversal is refused (404); the save
endpoint writes. **No probe has been run on any engine**, so every cell of the results matrix in
`spike-tauri/README.md` is empty, and the README says so rather than implying otherwise. Windows is
expected easy and uninteresting (WebView2 is Chromium); the old-LTS Linux row is the one most likely
to produce a bad answer and the one worth the most effort to obtain.

Scope boundary written down rather than assumed: this harness does **not** answer DESKTOP's
WebSocket-through-a-custom-scheme wrinkle, which is about the stream rather than storage or codecs.

### Also found

`sample_media/` is in README's workspace table but does not exist - the same class of stale map
entry as `NOTES_APP.md`, and both are still Curtis's call. `spike-tauri/` was added to that table
in this pass.

Gates: nothing in the workspace moved, so `just ci` was not run. The spike builds only from inside
`spike-tauri/src-tauri`, by design.

## 2026-08-11 — the Tauri spike ran, and both predictions were wrong

Two platforms probed (macOS 26.6.1 / WebKit 21624.4.5.11.5, and Ubuntu 26.04 LTS / WebKitGTK 2.52.3),
both in the `http` origin mode. Curtis's call on the evidence: **Tauri is sufficient for our
purposes.** DESKTOP's *deciding experiment* is answered and its risk paragraph amended accordingly.

**The mirror passes on both WebKit engines.** `liveQuery` fired and reacted - the disqualifying row -
and the 8MB Blob and ArrayBuffer round-trips came back byte-identical on both, which was the specific
worry. Dexie stays; the memory-mirror workaround is not needed for desktop. WebKitGTK is slower
(148ms vs 92ms on the snapshot, 272ms vs 53ms on the Blob) and fine.

**Both predictions in the docs were wrong, in opposite directions.** Linux was written up as the
dangerous engine and is the only one that reached the compact `av1` lane - WebKitGTK's MediaRecorder
muxes AV1, WKWebView's does not. And the mirror, written up as the risk, was never in trouble.

**The macOS row's real finding is about our code, not the engine.** MediaRecorder cannot mux `av01`
there, but `VideoEncoder.isConfigSupported` reports `av01.0.04M.08` supported - the same asymmetry
video-ingest recorded for Firefox, now on a second engine. Rebuilding the av1 lane on WebCodecs plus a
real WebM muxer, already video-ingest's top recommended improvement, would recover the compact lane on
macOS and would also sidestep the missing `HTMLMediaElement.captureStream` there, since a WebCodecs
lane needs no audio tap.

### The harness reported a FAIL that was its own bug

`LINUX.md` records `Verdict: FAIL - 1 failing: storage quota + persistence posture`, on
`navigator.storage is undefined`. Every load-bearing row passed. The step was documented in the README
*and in its own code comment* as informational and unable to fail a run, and was then implemented with
a `throw` - so **a category that existed only in a comment failed a probe it was written not to
fail.** WebKitGTK 2.52.3 has no StorageManager at all, which is the engine fact worth keeping; the
FAIL was noise on top of it.

Fixed by making the category real: `informational` is a flag on the step, the verdict filters those
out, and they no longer render as failures (a red FAIL beside "ImageDecoder absent (harmless)" invited
the same misreading). The raw export in `LINUX.md` is left as-exported rather than edited - a results
file that quietly corrects itself is worth less than one that shows its scars.

### Two things not to lean on

**WebKitGTK's AV1 support is a property of the install, not the engine.** Media goes through
GStreamer, so `MediaRecorder av01` depends on which plugins that distro shipped. `pickLane()` already
probes at runtime, so the product copes - but no Linux capability can be stated as a platform
requirement, which is harder to document than a uniform answer would have been.

**`canPlayType` is not evidence on WebKitGTK.** It answered `probably` for all seven probed types
*including HEVC*, because it reports GStreamer's registry rather than real decode capability.

### Still outstanding, and none of it blocks the shell decision

No **end-to-end ingest run** on either platform - so "video works" is an inference from a capability
matrix, and video-ingest's own history contains a case where that inference was wrong. Also the reload
check on both rows, the `scheme` origin mode everywhere, Windows as a formality, and an older Linux
(which the install-dependent finding above makes interesting rather than redundant).

Harness gained one thing along the way: it now reports `tauri::webview_version()` and the real OS
version, because **a webview's UA identifies nothing** - WKWebView reports a frozen
`Intel Mac OS X 10_15_7` regardless of the system, which made the first export uninterpretable.

Gates: nothing in the workspace moved. The spike builds only from `spike-tauri/src-tauri` and its
three probe modules pass `node --check`.

## 2026-08-11 — DESKTOP flipped to Tauri, node embedded from the start

The spike came back clean on both WebKit engines, so the shell decision was made and
[DESKTOP.md](DESKTOP.md) was rewritten as a Tauri plan. Not the sidecar shape it costed earlier -
**shape (3): the node linked in as a library, axum on Tauri's own tokio runtime, one process, one
binary.** In-process from the start rather than as a later optimization, because the sidecar's
problems are all problems it does not have.

**The clearest illustration of why:** the Electron plan needed a stdin-EOF watchdog so a crashed
shell could not orphan the node. In-process, that requirement does not exist. Same for the readiness
poll and most of the port-collision handling - deleted rather than solved. Packaging loses
`extraResources`, the asar exec restriction, and nested-binary signing; ~200MB becomes ~30-50MB; the
Chromium CVE treadmill becomes the OS's job.

**One genuinely open design question, recorded with three answers.** A shifting port drops per-origin
state (*Caveats that apply to desktop mode regardless*), so: (a) a persisted fixed port with page and
API same-origin - **recommended, because it is the configuration the spike actually validated and it
keeps CORS off the node's door**; (b) Tauri's custom scheme for the page with a cross-origin API,
stable forever but needs CORS and is untested; (c) serve HTTP straight into the axum `Router` through
the scheme handler, elegant, retires the port question, unvalidated, and the WebSocket still needs a
real listener. Took (a). **Under (a) the WebSocket wrinkle disappears entirely** - page and stream
share an origin - which is the second-largest simplification after the watchdog.

**What we are trading away, written down where it can be checked later:** "when something breaks at
11pm, somebody has already hit it and written it down" belongs to Electron by a wide margin, and it was
the strongest argument for a one-person project. Also live: stale engines on old OSes, which we cannot
patch, and whose shape the spike already showed - WebKitGTK capabilities vary by install, so we degrade
per machine rather than requiring a platform.

The `lib.rs` split is Stage 1 and is flagged as the one stage that can disturb the gates: it moves the
composition root, and `tests/conventions.rs` reasons about table ownership by file path.

Knock-on edits so nothing contradicts: README's document list now describes a Tauri plan; MOBILE's
*Tauri as the shell* section says it **converges** with desktop rather than diverging, since the
desktop plan now pays for the split, the in-process node and a working Tauri build on its own account -
**a phone client becomes a port of a shipping application rather than a new project**, which is the
biggest move in that document's estimate since it was written. MOBILE's "two shells against one UI"
residual is struck through rather than deleted, because its disappearance is part of the argument.

Outstanding editorial act, unchanged: PROJECT_PLAN's *Desktop mode: local server + system browser, NOT
Tauri* now contradicts DESKTOP by title. Canon has not been amended.

Gates: markdown only; nothing outside `*.md` moved.

## 2026-08-11 — canon amended: desktop mode is Tauri with the node embedded

PROJECT_PLAN's *Desktop mode: local server + system browser, NOT Tauri* is now **Desktop mode: Tauri,
with the node embedded (settled 2026-08-11)**. The rename is the point: that section's title carried
its conclusion, so a section that reversed had to lose it.

The amendment records the reversal rather than tidying it, because both original arguments failed
instructively. The first - "we already have HTTP on localhost, so Tauri's bridge is a bridge we do not
need" - **answered the wrong question**: nobody picks a webview shell for the IPC bridge, they pick it
for being an application, and the section's own floor case (auto-open the browser, no GUI) is exactly
the config-page shape that made this come up. The second, webview skew, was the strong one and was
**tested rather than argued away** - `spike-tauri/`, both WebKit engines, the mirror passes.

Also written into canon: in-process rather than sidecar *deletes* the orphan, readiness and
port-collision problems instead of solving them; the `lib.rs` split is mechanical because `crate::`
still resolves to the crate root inside a library, so the ~49 files using it are untouched; the
persisted-port answer to the stable-origin warning, which also makes the live-cache WebSocket
same-origin; and what we are accepting - stale engines we cannot patch, capabilities that vary by
install, and the loss of Electron's decade of battle-testedness, named so it can be checked later.

### Three consequential edits, because canon must not contradict itself

Renaming a section strands every cross-reference to it, so the same pass fixed the three places that
depended on the old position:

- ***The Client Story*'s desktop-delivery bullet** said the shell opens the system browser in app mode
  at a stable localhost port. Rewritten to one binary that is both node and window, keeping the part
  that was right (one installer, one signing identity, tray and autostart in the same executable).
- ***Caveats that apply to desktop mode regardless*** opened by noting the caveats "would cost the same
  under Tauri, so they are not arguments for it." That framing predicted its own survival correctly, so
  it is recorded as such - and two caveats now have settled answers rather than open warnings: the
  localhost-CSRF hazard is what the launch token closes, and the stable-port requirement is answered by
  persisting the port.
- **The Godot bullet's skew clause** rejected webview-in-Godot hybrids "for the same webview-skew reason
  as Tauri" - a reason that no longer exists. The strike stands; its stated grounds are now the narrower
  and more honest one, that a webview inside a game engine is a second rendering model fighting the
  first. A coherence problem, not a compatibility one.

Knock-on: DESKTOP's status block flips from "canon says the opposite" to "canon agrees" and its residual
from "amend canon" to what remains; README's trio framing no longer claims all three documents disagree
with canon, because one of them no longer does.

**Still predating this decision, and flagged rather than rewritten:** *Phones: deferred, by design*
(whose no-background-sidecar-on-iOS premise MOBILE corrects, and whose cost estimate this decision
materially lowers) and *Always-on nodes are needed either way* (against DESKTOP's autostart argument).
Both are Curtis's call.

Gates: markdown only; nothing outside `*.md` moved.

## 2026-08-11 — the author leaves the building

`cascade.cjs` already walked an edit and a delete to the fourth hop through both revalidation
lanes. But both lanes were **policy**: `tree` asks the tree because it was told to, `fast` asks the
author because she was there. Neither could prove the thing the share tree exists for - that a
reader who asks the author first, and gets nothing, still ends up with the right answer. The
fallback's code ran in every suite; the fallback's *trigger* had never once fired.

`/test/unplug` made the real case reachable, so the same three claims now run again with the fast
lane on and Alice's node dark:

- **A share is served onward while the author is dark.** The chain stops at Cleo, Alice goes
  offline, and only then does Cleo share to Dana. The copy Dana ends up with did not exist when
  Alice went away, so this is not inertia: the tree served a new reader a document whose author
  was unreachable throughout.
- **An unreachable author is not a deleted one.** Twelve seconds of sweeps - a dozen chances per
  hop to get it wrong - and the fragment, its version, and the feed row all stand, with no
  tombstone anywhere. If a failed revalidation were ever read as a takedown, closing your laptop
  would erase your work from everyone who shared it. *Silence preserves, speech deletes*, pinned.
- **An edit and a takedown each reach the fourth hop after their author goes dark.**

### The two-phase darkness, and why it is not theatre

The obvious way to write these is: publish the edit, unplug Alice, assert. That test passes with
the share tree carrying nothing at all - the sweeps run every ~1.5s here, so Cleo and Dana would
simply have learned it from Alice during the window before she went dark.

Alice's chain reaches Bob over the **sync** ALPN; readers ask her for documents over the
**fragment** ALPN. So her fragment door is shut *before* the act, which makes every subsequent
arrival provably second-hand, and her node goes fully dark before the deepest hop runs. That the
gate is per-protocol is what makes this expressible; it was the reason not to build a gate that
only understood the word "sync", and this is the payoff arriving one day later.

### Proven by planting the failure

Two false passes were possible here, and both were checked by making them happen rather than by
reasoning about them:

- Shutting **Bob's** fragment door as well made *an edit reaches the fourth hop* fail on exactly
  the assertion that says the revision came from Bob. So that test measures the B→C hop, not
  Alice answering quickly.
- Shutting **Cleo's** made *a takedown reaches the fourth hop* fail. Dana's only route to `Gone`
  really is Cleo's tombstone - the memo held by a node that never had Alice's chain and no longer
  has her words either.

Both were then removed and the suite re-run green. A test that has never failed is a claim nobody
has checked, and these are claims about data loss.

### Residual

`seed` was split into `seedToCleo` + `shareOnwardToDana` so a scenario can change the world between
the third hop and the fourth; `seed` is now their composition and the eight existing scenarios are
untouched by it.

## 2026-08-12 — Sam and four others

A viral post arrives over and over. Six people you follow pass the same thing along, six separate
pointers on six separate chains, and Curtis's instinct was that it should be one row in the feed
rather than six. It already was - `feed_journal`'s key is `(reader, author, doc)` and has been all
along - so the question turned out to be a different one: **what does the row SAY when six people
are behind it?**

The answer it gave was the worst of the three available. `via_root` took the newest sharer, so the
byline mutated under the reader while the words never changed, named somebody arbitrary, and dropped
the other five in silence. Not the introducer, not the crowd. Now the row leads with the
longest-standing sharer among the people still sharing it, and carries the rest: `via_others` with
faces and names, `via_count` exact even when the list is capped, and a hover that opens the roster.

### The plan was wrong, and the schema comment had said so all along

The design I proposed and defended was **no new table**: `rebroadcast_pins` is keyed
`(holder_root, author_root, doc_id)`, which is exactly "who shared what", and `subscriptions`
answers "does this reader follow them" - so the crowd was two indexed node.db reads away, with no
write path and no cleanup paths to forget. It was a good argument for a design that cannot work.

The test came back with `rebroadcast_pins` **empty** on the reader's node, and the reason was
written in the schema next to the column I had misread: `holder_root` is "the local persona whose
share obliges this node". `rebroadcast::fold` puts it plainer still - pinning is an obligation
hosted-only *and load-bearing*, because "fronting on a foreign persona's say-so would be push, and
*Pull, Not Push* forbids it", while journaling is delivery and must run for foreign sharers. The two
halves were deliberately split on 2026-08-10 after one guard was found doing both jobs. So a
reader's node holds pins for its own personas and never for the strangers whose shares fill its
feeds - which is the entire population of a crowd.

The lesson is not "read the comments". It is that **the query returning nothing looked exactly like
the feature not being wired up yet**, and the only reason it was diagnosed in one pass rather than
five was dumping the three tables into the failure output instead of reasoning about which was
likeliest.

So `feed_shares` exists after all, written beside the journal row in `journal_rows`, and the memo
argument I had waved away is the right one: the authoritative answer lives on each sharer's chain,
in their user database, and a page naming twelve sharers would open twelve encrypted files to draw
one screen - the fan-in thrash "one question, one database" exists to forbid.

### What survived from the derived design

The half that was right, kept: **the subscription filter still happens at read time.** A stored
crowd has two ways to go stale, and they are not the same kind of fact. "I unfollowed them" is
private to one reader and reversible, so it is asked when the question is asked - unfollowing
removes a name from the count with no delete anywhere, and re-following brings it back. "They
withdrew the share" is a fact about the world, so it is a real delete, in the same fold pass that
already drops the pin - outside the hosted gate, because the crowd is mostly other people's
computers.

Three delete paths in the end, each beside a deletion that already existed: a withdrawal
(`rebroadcast::fold`), an excised fragment (`excise_shared`), a persona leaving the node
(`identity::detach`). The fourth - unfollowing - never needed one.

### A byline is a claim in the present tense

Following from that: the rendered lead is NOT `feed_journal.via_root`. That column remembers who
brought the row and always will, which is right for history and wrong for a byline - crediting Sam
after Sam withdrew credits a recommendation nobody is making. So the lead comes off the live list,
and `sharedby.cjs` pins the consequence that makes the rule real: re-sharing does **not** hand the
lead back, because standing behind a post now dates from the re-share.

### The bug the schema bump found

The rig's five nodes were wiped between runs - four of them. `-e` was never added to the `rm -rf`
list when echo joined, so echo's database was the one that SURVIVED, invisibly, for as long as the
schema held still. Bumping the node generation to 18 turned that into the only node that refused to
boot. Fixed, with a note in the recipe pointing at the boot list beside it.

### Residual

Three things this slice found and did not fix, now in NEXT_STEPS: an orphaned share row (every
sharer withdrew, the row stays), a fragment that remembers only ONE origin while `feed_shares` now
knows the other five, and `remember` overwriting a fragment with an older version because nothing
checks that an arriving version is newer.

**This needs `just clean` on any dev network before it will boot** - node schema generation 17 to 18.

## 2026-08-13 — the fake network learns to pass things along

`just test-data` drew from a hat of thirteen actions and none of them was a share, so every
rebroadcast surface - the via-line, the crowd, the withdrawal - was invisible in dev data and
could only be seen by making it by hand. Two entries now close that: `rebroadcast-something`
and `withdraw-a-share`.

**The share is drawn from the persona's own feed, never from the roster.** That is the only
honest source, because you can pass along what has reached you, and what has reached you is
the product of follows, sync and time. Picking a random stranger's `doc_id` would have
exercised a path no button in the UI can reach - and would have failed on the handler's
`current_version` check anyway, which is the node refusing to endorse bytes it never read.
The version is omitted for the same reason the UI omits it: the honest answer to "what did
the sharer see" is what this node holds.

### Two findings, and the second one is the interesting one

**The dial nobody set.** `follow-someone` wrote `interest` and stopped, so a persona could
share correctly and reach *nobody* - `interest_rebroadcasts` is a separate rung, and
`subscriptions::edge_of` reads it separately. The action would have written valid pointers
that no other node ever journaled, and the feature would have looked broken in the data while
being perfectly correct in the code. The follow now draws the second dial independently
(~60%), because not every follow wants what you pass along, and `unfollow-someone` clears
both - an unfollow that left the rebroadcast rung standing would seed a relationship no UI
gesture makes.

**Uniform draws never make a crowd.** The first run: 240 actions, 11 live shares, 12 feed rows
arrived by rebroadcast, and **zero** with `via_count > 1`. A crowd needs two people a reader
follows to land on the same document, which random picking from twenty-row feeds essentially
never does - so the whole "Sam and four others" shape, built two days ago, would have had no
representation in dev data at all. Half the draws now prefer an item that arrived *by* a
share. That is not a thumb on the scale for the test case: re-sharing what was passed to you
is what virality IS, and the previous behaviour was the unrealistic one, a network where every
post is passed along at most once.

Verified on a scratch pair rather than argued: 10 personas x 30 actions, 0 failed, and a probe
across all twenty personas found 21 live shares, 24 rows arrived by rebroadcast, and 4 rows
carrying a crowd.

### And the comment the work walked past

`rebroadcast_handler`'s doc comment still described the feature's first day: "pinning the
author's replica so this node can actually SERVE what it points at ... is not here yet - so
today a share is a durable, syncing statement that readers cannot yet resolve to content unless
they hold the author's chain themselves." Every clause of that was false by 2026-08-11. Left
standing it was worse than no comment, because it tells a reader the share tree does not work -
the exact thing four hops of integration tests exist to say it does.

Rewritten to what runs: the pin is folded out of the chain by `rebroadcast::refresh_from` on the
frontier move the append causes, not written by the handler; and the copy is already in hand,
because resolving `version` reads `fragments`, so the ordinary path can only share what this
node already holds and can already serve.

Its **first line was wrong too**, and more cheaply: "withdraw a share by omitting `version`" -
which is precisely what the request struct four lines above says it is not, absence having been
given to "resolve it for me" when `retract` was added. Two stale sentences in one comment is the
argument for reading the whole of a comment when correcting any of it.

Gates: `just ci`, exit 0, 635 passing.

## 2026-08-13 — the revenant: a delete that did not stay dead

Every cascade test walked a deletion FORWARD, through a network where everyone hears in order.
No real network has that property, and the direction nobody had asked about turned out to be
broken: a sharer who slept through a takedown, offering the post back to a reader who had
already buried it, got it accepted. `cascade.cjs` now has *a document that was buried stays
buried*, and it failed on the first run exactly as predicted.

The reader ended up holding **a tombstone and a fragment at once** - privately knowing the
document was dead while serving it to anyone one hop further out, because `answer_for` consulted
its own copy of the words before its own memo.

### The stale sharer had to be built, not waited for

The shape needs a peer who never hears and still answers, which is not a state a test can reach
by timing. `/test/unplug`'s **direction** parameter is exactly it: Cleo's OUTBOUND fragment door
shuts, so no revalidation can ever tell her the post died and "silence preserves" keeps her copy
in good faith; her inbound door stays open, so she hands it to anyone who asks. The gate was
built with `direction` on the argument that inbound-only would be "a real thing to test and a
terrible default" - this is the first test to need it, two days later.

Alice's fragment door then shuts too, because otherwise Dana's next sweep would hear `Gone` from
the author a second time and quietly re-bury it - and the test would be passing on the author's
availability while claiming to test the reader's memory.

### Two guards, and the argument for the old order refuted itself

`fragments::remember` now refuses a fragment for an entombed document, and `answer_for` checks
the tombstone BEFORE the relayable copy. The old ordering was justified in a comment: last, "so
a re-published document (new id, but the same author deleting and reposting) is never shadowed
by an old tombstone" - which refutes itself, because a new id has a different tombstone key and
could never have been shadowed. What the order actually bought was the resurrection.

The guard lives in `remember` rather than at the three call sites because that is the single
door all intake lands on - first fetch, sweep, want-drain. `journalable` additionally declines
to dial at all for a buried document: correctness comes from the guard, but a stale sharer's
pointer is re-folded on every frontier move they make, so without it the node would fetch the
same dead document forever and discard it every time.

### The wrong turn, and what caused it

I first proposed a protocol change - `Gone` carrying the author's signed retraction so tombstones
could be dated - on the grounds that a permanent tombstone would black-hole a legitimate
re-publication. Curtis pushed back: deletion is final, and re-publishing means a new document.

He was right, and the codebase says so plainly in `retracted_doc_ids`: **"A tombstone is final
for its document id... re-publishing after a delete mints a NEW document id, so 'retracted, then
published again under the same id' is not a state the system produces."** What I had read instead
was `fold_retraction`'s comment, which describes a retraction losing to "a later re-publication"
and names `retracted_after` as the thing that compares them - **a function that has never existed
in this tree.** One grep, one hit, and the hit is the comment itself.

So a description of code nobody wrote outranked the code, and turned a one-line guard into an
argued case for a schema bump and a protocol change. The comment is rewritten to say what the
LWW stamp there actually settles (retractions against other retractions, so two of the author's
computers re-retracting land on one row), and to say what it does not. **A comment naming a
function is a checkable claim; this is the cheapest possible check and nobody had run it.**

### Proven by planting the failure

The unit test (`a_buried_document_is_not_taken_back`) had the guard cut out from under it and
went red on the exact assertion, then had it restored. The integration test failed before the
fix on the same claim. Neither is a test that has never failed.

### Residual

`Gone` still carries no proof - `Have` is self-proving and its opposite is a bare tag taken on a
relay's word. Not needed for finality, so not built, and not written into NEXT_STEPS as a task
either: it is a property of the protocol worth knowing, not a job.

Also found by reading and now in NEXT_STEPS: `published_as` survives a retraction, so
`Store::publish` would reuse a buried post id rather than minting the new one the model
requires - the same finality rule, possibly unenforced on the author's own side.

Gates: `just ci`, exit 0, 636 passing.

## 2026-08-13 — blooms out, cursors in: the delete-set summary loses to an empty answer

Canon amended: *Retraction, edits, and what a node must remember forever* no longer specifies
per-author bloom filters as the shippable delete-set summary. Retraction CURSORS replace them -
"what died since seq N?", asked of the origins a node already dials, answered with the signed
tombstone entries themselves.

Curtis opened the door himself ("I have a real tendency to introduce bloom filters into projects
that don't need them... this is a great offramp") and the offramp turned out to be paved by the
data, not by taste:

- **Delete-sets scale with regret, not the corpus.** The struck design's own arithmetic - "one
  bit per document ever published" - assumed the set grows with everything written. It grows
  with takedowns: an author of ten thousand posts retracts maybe fifty, and a bloom with a
  useful error rate over fifty elements is no smaller than the fifty doc_ids it summarizes.
  The previous bullet's tail ("one-bit-forever is exactly what compact sets are for") was the
  setup for the bloom and went with it.
- **Append-only + signed + sequenced means a cursor beats any summary.** The steady-state
  answer to "anything since N?" is empty - one round trip, no payload, no p to tune. A bloom
  cannot answer "nothing happened" better; it answers it with more machinery.
- **The bloom design already deferred to the exact protocol.** Bloom-positive → fetch the
  signed entry "which IS proof" - so the signed path had to exist and be correct regardless,
  and the filter was a cache in front of it: sizing knobs, inter-node skew, un-printable state,
  in the one path where a wrong "dead" is now permanent by design (the finality fix, same day).
- **The cursor's answer IS the missing proof.** A list of signed retraction entries plus
  delegation paths is the `Gone { entry, auth_path }` primitive the trust residual has been
  waiting for - so the batching design and the authentication fix turn out to be one slice,
  not two.

Re-entry criteria are written into the amendment rather than left as vibes: blooms come back
if a set turns huge, unenumerable, or held by a party that cannot be asked incrementally (the
someday-gateway checking arbitrary doc_ids is the named example). A decision, not an allergy.

This also answers the scaling question that prompted the review: a node's revalidation load is
O(relationships) for followed chains, capped at SWEEP_CAP=16 dials per beat for fragments today
(bounded but linearly stale at the tail), and O(origins) per beat under cursors - never
O(feed rows), never 500,000 asks.

NEXT_STEPS' trim-slice bullet renamed to match. Gates: markdown only; nothing outside `*.md`
moved.

## 2026-08-13 — Gone becomes signed speech: deletion proves itself like content does

Slice 1 of the deletion arc (PROJECT_PLAN, *Retraction, edits, and what a node must remember
forever*). `Have` always proved itself - the author's signed entry, verified offline at the
receiving edge, a relay unable to alter a byte. Its opposite was the one unauthenticated word in
the protocol: a bare tag, taken on the answering node's say-so. Under tombstone finality (three
days old) that had become the sharpest edge in the system - a lying origin could permanently
bury any document it had ever served, for its whole subtree, whenever the author was dark.

Now `Gone` carries `{ entry, auth_path }`: the author's own `post-retract` and the delegation
rungs tying its signer to their root. `verify_retraction` is the deliberate mirror of
`verify_fragment` - same checks, same edge, opposite claim - and its doc-id check carries the
same weight in the darker direction: without it, one genuine deletion in hand would be a
skeleton key for the author's whole shelf. `fragment_tombstones` stores the proof beside the
memo (node schema 18→19, **`just clean` before the next dev boot**) and the tombstone door
serves it onward verbatim, so the author's signature crosses nodes that never held their chain
and still verifies at the far end - the cascade's deepest assertion now checks exactly that.

An unprovable `Gone` is an error at the asking edge, like an unprovable `Have`: the next
candidate gets asked, and a node that cannot show the author's word for a death moves nothing.
Chosen by what each failure costs - a forged `Have` believed shows words the author never
signed; a forged `Gone` believed is a permanent burial. Hearsay is silence, and silence
preserves.

### The bug the proof requirement fixed by existing

`from_held_chain` answered `Gone` for any ever-published document missing from the shelf - and
`public_doc_ids` presents an EMPTY shelf under equivocation quarantine. So a quarantined
author's every document read as deleted to every fragment asker, which finality would have made
permanent for everyone downstream. Structurally impossible now: `Gone` needs the retraction
entry in hand, a quarantine has none to offer, and `documents::retraction_proof` returns the
only honest alternative, `Unknown`. What cannot be proven is not asserted - the rule fixed a
bug nobody had found yet.

The old wire shape is not a compatibility case: a one-element `Gone` frame fails to decode, and
a proto test pins that on purpose (`a_gone_without_its_proof_is_not_a_message`) - it is not the
old protocol, it is the attack.

### Proven

Proto: round-trips, the skeleton-key refusal (a retraction of X refused as an answer about Y),
wrong-kind refusal (a genuine doc-header is not a retraction), wrong-author refusal. Node: the
resurrection test round-trips the stored proof; the cascade asserts `length(entry) > 0` on
Cleo's tombstone and on Dana's - the latter being the whole slice in one row, the author's
signature at hop four, relayed by a node that could not have minted it, while the author's node
answered nobody.

Residual, unchanged: retraction cursors (slice 2) are now pure batching - "what died since
seq N?" answered with a list of exactly what the tombstone door already serves one at a time.

Gates: `just ci`, exit 0, 636 passing.

## 2026-08-13 — the reap: one ask covers the shelf

Slice 2 of the deletion arc, hours after slice 1, because the proofs made it pure batching:
`WantDeaths { since }` / `Deaths { proofs, cursor }` on the fragment ALPN, answered from a
death log that turned out to already exist - `fragment_tombstones` IS the log, once it gained
an AUTOINCREMENT id to be the cursor and (author, doc) stepped down to a UNIQUE constraint.
One table, because a tombstone that carries its proof is exactly one gossipable death. Node
schema 19→20 in the same uncommitted stack as 18→19; **one `just clean` covers both**.

The log has two tributaries. Deaths heard over the wire were already landing in it through
`entomb`. Deaths a node learns by HOLDING the author's chain - a follow's sync, a pin's - fold
into that persona's `public_retractions`, where a cursor ask could never see them; so the same
`after_public_move` hook that reconciles feeds now mirrors them out, proofs assembled at
mirror time (`fragments::mirror_retractions`, the `rebroadcast::refresh_from` pattern, one
user-db open per frontier move and the handle hot from the sync that fired it).

`reap()` rides the sweep beat: distinct origins plus distinct fragment authors (the same
star-and-tree order `revalidate` walks), one cursor each, pages of eight, every proof verified
at the receiving edge against the author it names - a log mixes authors and the relay vouches
for none of them. One bad proof skips loudly and the rest of the page stands; the cursor
advances regardless, because a stuck cursor re-serves the same page forever and the
per-document sweep is the backstop for anything a peer garbled.

### The bound that is not obvious until it is

**A death you never held is not your funeral.** A peer's log names every death it has heard,
and a node that buried them all would grow its forever-set with every deletion anyone it talks
to ever relayed - unbounded, and about documents it never carried. `apply_death` buries only
what this node holds; everything else is heard, skipped, and advanced past. The forever-set
stays demand-scoped: the regret of people you follow and of documents you actually carried.

### What this buys, measured against last week's arithmetic

Deletion latency stops scaling with the shelf. The per-document sweep runs 16 dials per beat
(politeness), so a 10,000-fragment shelf cycled every ~2 days and the hypothetical 500,000-row
node every ~108; the reap covers a peer's every death in one ask, O(peers) per beat, and the
steady-state answer is an empty page. The per-document dial remains for what it is still for:
edit freshness - which is why the EDIT WINDOW is now the only reason revalidation must visit
the whole shelf at all, and NEXT_STEPS says so.

### Proven by muting the door

Unit: since-N exactness, pagination without loss, one-row-per-death finality, cursors from
zero, the demand-scope filter (planted: guard inverted, test red on the right line). Proto:
round-trips and the oversized-page refusal. Integration, four shapes with per-document
revalidation PARKED first (`/test/revalidation` gained mode "none"; `/test/reap` rings one
pass, the `/test/derive` idiom): three deletions in one ask; a bystander death consumed but
not buried, cursor advanced past it; the fourth hop hearing the batch with the author dark;
and the steady state costing nothing.

Then the whole claim checked at once: `deaths_page` planted to answer empty, full suite run.
Exactly the three cursor tests failed, each on its load-bearing assertion, and *the steady
state is an empty page* correctly survived - an empty page is what the plant serves. No other
door delivered those deaths; the tests measure the cursor and nothing else. Plant removed,
`just ci` exit 0, 640 passing.

Also: the census cop caught the mirror's user-db open (count bumped with its per-edge
justification), the strings gate caught the "none" mode's error message, and clippy demanded
`LoggedDeath` be a struct - three gates, three findings, all cheaper than review.

## 2026-08-14 — the take-it-down button becomes reachable, and its first real use finds a hole

Curtis asked for UI to delete a post. It existed - `UnpublishButton`, "take it down", built
2026-08-11 with the tombstone arc - and he was right that it needed building anyway, because it
was reachable exclusively by page reload: the button rendered only when unlocked-but-closed,
and the unlock's own handler jumped straight into the composer (`setOpen(true)`), so the one
state that showed it could not be reached by any deliberate gesture. He unlocked a post to
check and found an editor and no button, which was the finding exactly.

Now it sits on your own posts directly. The second gate guarded nothing and its label ("open
this for editing") pointed the wrong way; the ask/confirm flow - which spells out what a
takedown can and cannot reach - was always the real breath.

### The aftermath made truthful

With the button reachable, the `published_as` residual (found by reading, 2026-08-13) was due:
unpublish wrote the tombstone and left the annotation, so the draft read "posted", stayed
sealed, and re-posting minted versions into the buried id - a 200 nobody would ever see, on
the exact path canon names as the recourse ("the recourse for a typo is delete-and-repost").
Three moves:

- `unpublish_handler` finds the note claiming the post (`Annotations::note_claiming`, a walk
  over the doc-meta view - once per human gesture, no index) and clears the claim. The draft
  is honestly a draft again; the button also releases this device's seal pref.
- `Store::publish` refuses to parent onto a claim whose post has no public head - the belt,
  for stale annotations arriving by sync from a device that has not folded the clear.
- The next publish mints the fresh id finality requires. `publish.cjs` pins the whole journey:
  post, take down, edit, post again → a NEW id, the old one still buried, the new words live.

### The hole the new test found on its first run

The takedown asserts came back red: the post was still on the author's public page. Not test
error - **`public_docs` and `public_head` never subtracted `public_retractions`.** The filter
lived in `public_doc_ids`, which every feed reconciliation and the fragment door consult - so
a takedown vanished from every reader's feed across the network while the author's own node
kept LISTING the post on `/id/{root}` and SERVING its words at the direct body URL, to anyone,
forever. Nothing had ever asserted the author's own anonymous surfaces: cascade watches feeds,
fragments and tombstones, and publish.cjs had no takedown shape until today.

Both now filter in SQL (keyset pages stay full, the file's own doctrine), and every
`public_head` caller was read before changing its meaning - all six want absence for a buried
doc: the body route stops serving, `fragments::current_version` refuses to let a retracted
post be newly shared, bake stops silently reusing a retracted media twin, publish gets the
belt above. The direct-URL claim is pinned in the test: 200 before the takedown, 404 after.

Gates: `just ci` exit 0, 642 passing. The new tests were red before the fixes - organically,
which is better than a plant.

## 2026-08-14 — the actions row learns one grammar

Three affordances sat on a post card in three dialects: the lock (icon, hover title), share
(icon PLUS a text label), take-it-down (text button, and its confirm as an inline strip that
reflowed the card). Now all three speak the lock's language - a glyph in a bordered chip at
the same scale, the words in the hover title.

The share button's "shared" state survives the label's removal by design that was already
there: `feed-share-on` fills the chip, and its CSS comment had promised "the state reads
without a label change being the only signal" since the day it was written.

The takedown's deliberation moved into the house modal (`modal.js` - "a modal reads as the
system stepping forward"), which is what it should have been from the start: a confirm that
reflows the card it is deciding about reads as part of the card, and a takedown is precisely
the system being asked to do something irreversible. Same warning words, same yes/keep-it
pair, Escape and the scrim to decline - and the modal refuses to close mid-flight while the
delete is in the air.

`just strings` retired the two labels the icons replaced ("share", "shared") - the catalog is
at 446. Gates: `just ui-check` 380 passing; strings clean. CSS rides the next `just start`'s
bundle.

### And the card stops outliving its own funeral

Field-tested minutes later: taking a post down left it on screen until a page refresh. The
original design said "the row goes on the next feed read; nothing is faked here" - but nothing
is faked the other way either: the 200 IS the tombstone landing on the chain, and a post its
owner just watched die staring back at them reads as the delete not having worked. The card
now retires itself on the confirmed write (the `markShared` discipline - reflect what the
server acknowledged, never the guess), with the early return placed after every hook so a
retiring card cannot trip preact's ordering. List state upstream still names the row; the
next feed read reconciles.

One catalog note riding along: the takedown warning's wording is Curtis's own edit ("removes
it from other people's feeds and shares, but very slowly") and the catalog is authoritative,
so `just strings` rewrote the call-site seed to match rather than the reverse. "Very slowly"
predates the retraction cursors by a day - deletion now travels one sweep beat per hop - and
Curtis kept it anyway, deliberately: "removing things from the internet is, notably, actually
impossible", and the one direction this copy must never err is over-promising what a takedown
reaches. The under-promise is the honest register for deletion, whatever the machinery's
current speed. A standing rule for this app's copy, not a stale phrase.

## 2026-08-14 — the last inch: the share tree reaches the reader's screen

Curtis asked whether an A-B-C-D chain with A asleep leaves D staring at an empty post with a
broken image, and the answer was worse: **every reader past the chain has stared at "these
words haven't reached this computer" since the day fragments shipped.** The distributed layer
was real - verified entries in the ledger, tombstones, four hops, author-dark, all proven -
and the last inch, store to screen, did not exist:

- The anonymous body route (`public_doc_bytes`) consulted `user_dbs` and nothing else; idface
  had zero fragment awareness. A fragment holder's node could not serve the words to its own
  browser.
- And the bytes were never there to serve anyway: the body-healing candidates (profile-via,
  askers, sync peers) all derive from a relationship with the AUTHOR, which a reader past the
  chain has none of - so `missing_bodies` rows aged forever with zero candidates.

Nobody saw it because every seat anyone had ever sat in was a chain-holding seat (sharer-side
node, direct follow, or a profile visit whose member fetch pulls the chain in), and the
cascade tests asserted `feed_journal` and `fragments` rows - the tables, never the surface.
The same class as the share button's `/api` 404: a well-tested layer under an untested inch,
found by asking the user's own question ("can the end device actually fetch this?").

### Three legs, and Curtis's test requirement drove all of them

- **`fragments::serving_header`**: the ledger serves a browser from the author's own signed
  entry - re-verified on the way out (the `tomb_proof` posture), tombstone consulted first
  (the entomb/forget crash window). `public_doc_bytes` falls back to it when no chain is held;
  a held chain stays authoritative.
- **The origin heals what it named** (`bodies::fetch_wanted` + origins as sweep candidates +
  an eager `heal_from` at fragment intake): whoever handed you the pointer holds, or knows who
  holds, the bytes it names.
- **The cascade asserts the HTTP surface at every hop**: `servedBody` - the exact URL
  PostEntry fetches - must return the words at C and at D in every lane, with the author dark,
  and after an edit (the SERVED words update, not just the feed row's title).

### The new assertion earned its keep inside its own slice

First full run: **17 failures**, all the new claim. The heal path I had just wired dialed the
right origin and fetched nothing - `fetch_missing_bodies` computes its fetch list by walking a
HELD chain's `doc_versions`, and a fragment author has no chain to walk, so the walk opened
with a refusal and healed zero. The ledger knew the exact hashes all along; nothing read it.
`fetch_wanted` is the ledger-direct fetch (a public blob's hash is the whole capability), run
first at every candidate. Second run: 642 passing, exit 0. A surface-level test catching a
bug in the very slice that added it is the whole argument for testing the surface.

### Still open, queued in NEXT_STEPS

Media doesn't hop: the `media_refs` walk where the body text lands, same origin, budget-bound
- and only then the media deletion story (orphan reaper, retract-the-twin, blob reaping),
virality before deletion, per Curtis. The "shipped end to end 2026-08-11" bullet now says what
was true: the data layer shipped then; the reader's screen was reached today.

Gates: `just ci` exit 0, 642 passing.

## 2026-08-14 — the reserved key becomes real: headers name what their bodies embed

Groundwork for implicit rebroadcast, cut where Curtis cut it: before a share can promise "the
post and its media," something signed has to SAY what the media is - and until today the only
way to know was parsing the whole body as Marquee. `DocHeaderPlain` gains `refs` (key 11), the
additive key the encoding comment had reserved from the start: the documents this body embeds,
derived at authoring time by the same parse that bakes media, so the set is knowable from the
entry alone - a fragment names its media before its body arrives, a sharer's pin has a
checkable shape, and no fold or sweep ever parses foreign Marquee.

Two caps now stand where one stood, and they price different things: `media_budget` (10MB,
confirmed in and unit-tested, dedup-by-blob) prices the BYTES; `MAX_REFS = 50` prices the
OBLIGATIONS - every ref is a fetch every sharer owes, and fifty distinct embedded documents is
already an album (Curtis: "the huge refchain starts to be awkward and it's good to set a limit
somewhere"). Counted on the distinct-target list so repetition cannot dodge it, refused before
a byte of bake work, and enforced at the proto's both doors - the encoder cannot mint an
over-count header and the decoder refuses one minted by other code.

**Private documents carry refs too** (Curtis's call, same message): derived in `Store::save` -
the one door every private save passes - own private embeds only, external links excluded
because a URL is not a document, duplicates counted once, and the caller's assertion always
overwritten, because refs is a claim about the body and the body is in hand. The fold persists
them (`doc_versions.refs`, user schema 13→14), which is what makes "which media does this note
hold?" - and its inverse, the unreferenced-media hunt - a column read instead of a
decrypt-and-parse of every body ever written.

Derivation lives at the two mints and nowhere else: `bake::publish` hands the baked twin set
(post-rewrite, so refs name what a reader's renderer will actually ask for) into the public
header; ingest's media saves and `save_public_media` write empty refs because a media document
is a leaf; `retitle` preserves what its head carried. The lying-author case is self-scoped
like every header claim - over-claim obliges your own sharers (budget-capped), under-claim
breaks your own images past hop one.

Proven: proto round-trips with empty-is-absent pinned byte-for-byte (old readers and old
entries agree), both cap doors red-tested; store tests for the derivation (the twice-embedded
image counts once, the URL not at all, plaintext embeds nothing), the fence at exactly fifty,
and the published entry carrying its refs through decode.

**User schema 13→14 rides the uncommitted stack - the next dev boot wants `just clean`.**
Gates: `just ci` exit 0, 642 passing; catalog at 447.

## 2026-08-14 — the 51st embed: refused at the gesture, rescued at the paste

The refs cap's first UX was inherited, not designed: a marquee note crossing fifty embeds hit
the server's refusal at AUTOSAVE, where the editor's error copy promises "it will keep
retrying" - true for the network blips it was written for, false for a refusal that no retry
can outrun. Nothing persisted past the 51st embed; the words lived in the tab; closing it lost
them (the unload flush eats the same 400). The body-size cap has failed saves through this
exact loop all along - the refs cap just made the treadmill easy to reach.

Two doors now stand in front of it, both Curtis's design:

- **The gesture refuses.** Picker, drop and paste-of-files all funnel through `captureFiles`,
  which counts the buffer's distinct own-document embeds (the real grammar, parsed - never a
  regex) plus the files in hand, and declines to start: no upload, no placeholder, no doomed
  autosave, and a self-clearing note where the gesture happened - "this page already embeds
  {n} files, and one page holds 50 - start another page for the rest."
- **The paste is rescued.** Embeds that arrive in the body as TEXT (paste is the door the
  funnel cannot see) are met at save time: everything past the first fifty distinct documents
  is replaced with refusal text that names what it displaced - ("sunset" removed - one page
  holds 50 embedded files) - which IS saveable. The rewrite lands in the visible editor
  (`setBody`; LiveMarquee already honors external replacement), never silently in the payload
  alone, which would fight the buffer forever.

The surgery is humble on purpose, and the tests pin the humility: the PARSE decides what
counts (`pure/embedcap.js` takes the AST; the marquee grammar punishes pattern-matching and
bake.rs says why), the string work only relocates what the parse identified, a rewrite is
trusted only after RE-PARSING under the cap, and a candidate it cannot cut confidently - an
opener spanning a blank line, a bare target with no `![` - is left alone to wear the server's
refusal. Best-effort rescue, exact backstop.

Counting mirrors the server's classification exactly: distinct documents (repetition is one
obligation, matching the budget's dedup), own documents only, a URL is none.

Residual, named: the "will keep retrying" copy still lies for any PERMANENT refusal the rescue
doesn't cover - the body-size cap foremost. The chip wants to learn the difference between
"will heal" and "needs your hand"; small, and it covers every future save-time refusal at once.

Gates: `just ci` exit 0, 650 passing (5 new pure tests, embedcap.cjs); catalog at 449.

## 2026-08-14 — the image rides the share: implicit rebroadcast, built

The rule canon now carries (*What travels with a share*): **a share is an implicit rebroadcast
of the post's media** - one pointer, one budget, one renderable whole, because nobody believes
they shared a post minus its picture. The signed header's `refs` (yesterday's slice) made it
buildable without parsing a byte of foreign Marquee: a post fragment's arrival obliges its
refs from the SAME origin - the pointer's edge is the media's edge, so a shared image survives
its author sleeping exactly as the post does - and `fragment_covers` refcounts why each media
fragment exists, so the deletion story composes instead of needing its own: a post's death or
an edit that drops an embed releases solely-covered media on the spot, locally. A doc two
shared posts embed is one fragment with two reasons. Node schema 20→21.

Deliberately NOT `fragment_wants`: the wants drain journals arrivals to the sharer's readers,
and an image is not a post - the covers table doubles as media's own retry ledger
(`heal_covers`, on the sweep beat, skipping the entombed).

Proven with real bytes end to end (`cascade.cjs`, *the image rides the share*): a webp through
ingest, the bake minting the public twin, the twin's fragment riding to hops three and four,
the IMAGE BYTES serving from each reader's own node at the URL their renderer asks - and the
takedown dropping post and image together at every hop.

### The resurrection the test caught on its first run

Steps one through five passed immediately; the takedown failed, and charlie's log told it
plainly: the cover cascade dropped the twin at 00:45:52, and seconds later the twin was back -
"still served", title "cat", every beat, forever. **The sweep's due list is a snapshot, and
rows die mid-pass**: the same pass that heard the post's `Gone` (and cascaded its media away)
went on to the twin's already-deleted entry from the stale snapshot, revalidated it against an
origin with no reason to say anything but `Have` - the author retracts the POST, never the
twin - and re-stored it. Uncovered but immortal, because every later beat revalidates the
re-stored row.

The fix is the general rule, not a media patch: **a sweep revalidates what is held, and what
died mid-pass is no longer its business** - one held-check per due row, which also protects
the reap's burials from the same stale-snapshot resurrection. Second run green.

Gates: `just ci` exit 0, 651 passing.

## 2026-08-14 — the reaper: deleted media leaves the intermediary filesystems

The file layer's first deletion path, and not a hand-rolled one: iroh-blobs refuses direct
deletes on purpose ("users should rely only on garbage collection") and exposes mark-and-sweep
with a protect callback - so the ledgers ARE the mark. `reaper::live_set` unions every
reference class a node has: every held identity's `doc_versions` (both lanes - public bodies
and thumbs, and the encrypted private bodies sharing the same store), the fragment shelf (body
from the column, thumb and preview decoded from the stored signed entries, STRICT - corruption
aborts rather than reaping blobs it can no longer name), and the wants ledger, because a blob
mid-heal is referenced by intent. **Any failure anywhere aborts the whole run** - the
documented use of `ProtectOutcome::Abort`, and the posture everything else leans on: a reaper
that cannot see every reference must not reap. Unarmed (before boot finishes) it aborts too.

Two rings around the races: a recent-put grace (a put returns its hash BEFORE the caller
writes the referencing row, and the reaper must not win that footrace), and tag hygiene - an
`add_bytes` tag is bookkeeping, never a reference, and iroh's mark treats tags as roots, so a
dead blob's tag would keep it immortal; tags outside the live set are dropped each round.

### The mark's one lie, caught by seven tests at once

The first live run: the image test PASSED - bytes reaped at Cleo, control blob standing - and
seven OTHER tests failed. The mark read `doc_versions`, and **the fold lags the chain**: a
save puts its blob and appends its entry, and the row only materializes on the next READ - a
window in which a fresh post's body has no row to protect it, unbounded in principle on an
idle node. The rig's short grace made it flagrant inside one CI run instead of eating
somebody's note in six months. The fix is fold-first marking: `blob_refs` runs
`catch_up_public_lane` for every held chain and the full keyed fold where this node holds
keys (`fetch_missing_bodies`' exact key-loading pattern) - the mark sees every row the chain
implies, never whatever the last read happened to fold.

Green now means more than it did: the whole suite runs beside a reaper sweeping every two
seconds, so every future CI run re-proves the mark's completeness incidentally.

What this deliberately does not do: reap on the author's own account. Chain rows protect
their blobs for as long as the rows stand - which the chain keeps forever - so the author-side
story remains the orphaned-twin reaper (NEXT_STEPS), now a query against the `refs` column.

Proven: the memory-store unit test (unarmed reaps nothing across many rounds; armed collects
the unreferenced and spares the referenced), and the cascade watching the twin's actual bytes
leave Cleo's filesystem by hash after the takedown while a live control blob survives.

Gates: `just ci` exit 0, 651 passing; catalog at 450.

## 2026-08-15 — the edit window: a day, then the words settle

The last trim slice from the 2026-08-10 design, width pinned by Curtis at ONE day. Three
voices, one rule:

- **The author's own door refuses with words**: past the window, `Store::publish` answers
  "this post has settled - posts can be edited for a day, then what you said is what you
  said" - and the composer SHOWS it (the swallow at `editing.post()`'s catch would have read
  as a broken button). The recourse is canon's: delete and repost, which the `published_as`
  release made real.
- **The resolver ignores**: late public versions are dropped before threading - admitted to
  the chain, invisible to every head. Genesis is the chain's own parentless minimum, never the
  header's carried claim, because a field the resolver can derive is a field it must not
  trust. Deterministic forever: the author's own two stamps, no local clock.
- **The shelf freezes**: `remember` ignores late versions and refuses moving geneses;
  the sweep excludes frozen rows outright. The revalidation population is now O(posting-rate x
  window) - the archive is never dialed again - and with deletion on cursors, the steady state
  the whole arc aimed at: O(peers) per beat, empty pages.

The anchor rides the signed header (`genesis_ms`, key 12), because a fragment holder has no
chain to derive it from. The forged-anchor worry died in design review (Curtis: "doesn't this
just create a repost that many nodes will never bother to carry?") - frozen holders never
re-ask, chain holders derive, so a forward-dated rewrite reaches only newcomers, wearing the
drift badge, contradicted by every established carrier. The freeze IS the containment.

Storage dividend: the reaper's author-side mark now protects only the display head's blobs for
frozen public posts - an edited viral post becomes one version of bytes and N small headers.
Media documents freeze from birth (no genesis, no edits, leaves by construction).

### Two self-inflicted reds, both instructive

Five edit-cascade tests failed on the first full run: the mint stamps the header's genesis
claim milliseconds before the entry's stamp exists, and the re-publish path re-DERIVED genesis
from the chain - so v1's claim and v2's differed by those milliseconds and the shelf's own
drift check refused every honest edit. The fix is the comment's own sentence made mechanical:
an honest author's genesis never moves because it is CARRIED forward verbatim from the
previous header, never re-derived. And 36 resolver tests went red when a two-step edit left
`materialize` without its threading loop entirely - restored with the honor rule in front.

Proven: resolver honor by pure claimed-stamp arithmetic (in-window head moves, late edit
invisible, private lane edits forever); shelf honor and genesis-drift refusal the same way;
and the cascade's two ends - the refusal with its words at the author's door, and a frozen
fragment's `checked_ms` standing still through five seconds of beats after demonstrably
moving while young. `/test/edit-window` is per-test runtime override, never boot-wide, or
every other suite's posts would freeze mid-flight.

**Node schema 21→22 (`fragments.genesis_ms`) - `just clean` before the next dev boot.**
Gates: `just ci` exit 0, 653 passing; catalog at 451.

## 2026-08-15 — any sharer will do: the ledger outlives the recorded origin

The `fragments` row remembers ONE origin - first server wins - while `feed_shares` knows every
sharer a local reader follows who stands behind the document. Until today only the death reap
consulted the ledger; edits, body bytes and covered media all hung on the recorded origin's
uptime while five other holders idled. Now the asking walks: `revalidate` tries author, then
origin, then the document's sharers (`fanout::sharers_of_doc` - the union over readers of the
per-reader byline ledger, which Curtis correctly pinned as NOT a node-wide sharer index; the
union is one query on the by-doc index the deletion paths already built, and its scope is the
right bound by construction - only relationships this node's own users created).
Introducer-first, capped at three fallback dials per revalidation. Blob healing gains the
per-author union; cover healing walks the covering post's sharers.

Test-first, and the test was designed around the false pass: dual-follow self-heals the
INITIAL fetch through the second sharer's own pointer, so the scenarios sit where the second
pointer cannot help. The per-ALPN gate makes each a mechanism assertion: the author's fragment
door shut (sync stays open - Sam's chain copy must keep updating) and the recorded origin
fully dark, so the second sharer is the only body in the universe that can carry the edit; the
origin's BLOB door shut before his share, so every entry arrives and every byte is refused and
the wants ledger fills with a candidate that then dies. First run: both red on their named
assertions. Third scenario - every source dark is silence, not loss, and not overreach - is
the permanent plant, green before and after. The premise itself is pinned in SQL before any
darkness: `origin_root = bob`, ledger knows two.

### The flake the walk flushed out

One old test failed on infrastructure: the raw SQL passthrough 400'd a settle loop's feed read
with turso's "concurrent use forbidden". Pre-existing by its own admission - `Db::query`'s
lock covered only ISSUANCE, and the returned stream outlived the guard, racing every
production statement on the shared connection; the walk's extra sweep traffic merely made the
collision likely enough for CI to find. Replaced with `query_drained`: the whole statement
drains under the lock, values extracted before release, and no caller can hold an open
statement across it any more. The open-statement rule at the top of `Db` was always the law;
now it is also the type's shape.

What remains of that residual family: the in-window stale-sharer EDIT rollback (24h-bounded,
self-healing; a same-chain seq comparison would shrink it further) and the orphaned share row.

Gates: `just ci` exit 0, 656 passing; catalog at 450.

## 2026-08-15 — arrival order is not authorship order: the rollback closes

The last data-integrity residual on the rebroadcast ledger. `remember` re-stored wholesale -
last answerer won - so which version a fragment holder had was a function of network ARRIVAL
ORDER: a sharer whose chain knowledge had fossilized could roll an edit back at every node the
author could not out-answer, and the multi-origin walk (same day) had widened the exposure in
both directions. Now an arriving version older by the author's own numbers changes nothing:
same-leaf-chain versions compare by `seq` - pure causal order, deliberately OUTRANKING the
stamps, because a skewed clock cannot reorder one device's own chain - and cross-device
versions by `(claimed stamp, hash)`, which is `display_head`'s own comparator, so fragment
holders and chain holders converge on the same version from the same author-signed numbers.

Curtis asked the right adversarial question first - "is this building a dependence on
wall-clock time into our distributed system?" - and the answer shaped the comment block: no
local clock, no network time, no cross-author comparison; the stamp functions as an
author-signed version label whose accuracy is never load-bearing (the hash tiebreak alone
makes the order total), and the thing REMOVED is a genuine nondeterminism - arrival order,
unreplayable and different on every node. The LWW-register move: max-merge is a semilattice;
overwrite is not. The same version still passes through, because the wholesale re-store is
how `checked_ms` advances and refusing an identical refresh would leave the row perpetually
due; a held entry that no longer decodes fails OPEN, because corruption must not wedge a row
against every future update.

### The test, and what its first red taught

The out-of-order construction is deterministic by ALPN: Bo's SYNC door freezes his chain
knowledge at v2 while his FRAGMENT door keeps answering; the world moves to v3; the author
goes dark; Rae's revalidation consults a fossil every beat, and twelve samples over many
beats assert the words never go backward. The pre-fix run went red one assertion EARLY, and
honestly: the rig boots tree-only, where Rae could never reach v3 at all with her origin
fossilized - single-origin fragility demonstrating itself at the arrival stage. The test
gained a fast-lane override on Rae's node, and the sampling property earned its red by plant
instead: ordering disabled, sample 1 caught `rollback-two` wearing `rollback-three`'s place.
Plant removed, unit test beside it (seq outranks a lying stamp; older cross-device stamp
refused; newer stored, whoever delivered it).

With this, the residual family from 2026-08-12 is closed whole: deletes cannot resurrect
(tombstone finality), deletions travel signed and batched, media rides and dies with its
post, any sharer serves, and no version of anything moves backward. What remains on the
rebroadcast ledger is UX-and-policy, not integrity: the orphaned share row, the orphan-twin
reaper, the drift badge, then replies.

Gates: `just ci` exit 0, 657 passing.

## 2026-08-15 — feed selectivity designed: one slider, two budgets

A design conversation, no code; PROJECT_PLAN gained *Feed selectivity: one slider, two
budgets* under the feed section. The chain of it: Curtis asked how practical trust-edge
implicit rebroadcast would be against the bootstrap problem; hop-0 ("people I trust")
died on its own selection effect - both dials live on one contact card, so
trust-without-interest is a person the reader looked at and DECLINED, the worst pool,
selected for with precision - and the real design became depth on the trust tree along
both-high links, where the gate's sociology (inner circles are sparse) does the bounding
budgets would otherwise have to. Depth 2 needs no new sync at all: a followed persona's
published edges are already in a held database.

Then the UI question that shapes it all: speculative content breaks "everything in the feed
was asked for", so the feed gains a selectivity slider - six stops, Explorer through high
interest only, a read-time floor over a per-row effective interest level with a defined
provenance precedence (author dial, sharer dial, path score, floor pool - which is also the
answer to "why am I seeing this?"). Acquisition and attention strictly separated: the slider
never touches what syncs. New users default to Explorer - the empty-room refusal. The slider
is also the trust-leak discourage-dial from the same conversation, one control instead of
two; and the top three stops are buildable today, the bottom three lighting up as pools land.

Nothing scheduled; the section records the argument so it does not have to be re-had.

## 2026-08-15 — feed convergence: the last-stop hole, pinned red

A design conversation with one test as its deliverable. Curtis asked whether a persona's
nodes converge on the same feed - "if Node A is the last stop in a rebroadcast chain, does it
share that with the same user on Node B, eventually?" - and the honest answer was NO, never:
the cohort is not part of the share tree. Node A can hold a share complete - the sharer's
chain, the fragment, the blobs, all behind doors that answer anyone who asks - and when the
sharer and author go dark for good, node B's candidate lists (sharer-chain sync, the fragment
walk, blob healing) all resolve to the departed. The sibling is never asked.

The divergence inventory (the fuller conversation is NEXT_STEPS' two slices): the last-stop
hole above; the journal window applied to catch-up with an in-memory boot-reset watermark, so
a node dark or merely rebooted through a burst permanently lacks rows its cohort has despite
holding the full chain (the window was designed for NEW-FOLLOW bursts, and the chronological
feed means background history fill sorts into the past rather than flooding the top - the
window can become pacing); and arrival-time attribution (`shared_ms`, the crowd's introducer)
making converged membership disagree about the lead sharer. What already converges: share
MEMBERSHIP when sources are reachable, this week's wants/multi-origin/cursor machinery having
turned the fetch-failure class into plain sync lag. The fix family is routing, not protocol -
cohort endpoints join three existing candidate walks; frontiers-never-views survives whole,
because a relayed chain is evidence the sync gate validates, and no journal row ever crosses
a wire. The thing deliberately NOT proposed: syncing the journal itself - same-owner privacy
would permit it, but it turns a disposable memo into a replicated structure with a conflict
story, to paper over an amnesia rather than cure it.

The test (*the cohort is part of the tree*, cascade.cjs): cora adopted onto a second rig node
via the daisychain ceremony, the sibling asleep through a share, the last stop loaded and
serving, author and sharer then dark forever, the sibling waking into a network where its own
cohort is the only holder. RED demonstrated live on the named assertion - "the share's feed
row reached the waking sibling" - then SKIPPED, deliberately: a standing red suite blocks
every interleaved slice (green before forward), so the red is recorded here, the skip carries
a loud unskip-me comment, and unskipping is the fix's first move. Both slices are in
NEXT_STEPS under *Feed convergence across a persona's own nodes*.

Also: one observed flake on the rerun ledger - *a delete reaches the fourth hop [fast]* went
red once ("Cleo dropped her copy": a fragment surviving a feed-row excise), green on the
clean rerun that proved it a flake by the standing rule. Recorded in case it recurs; no
mechanism identified.

Gates: `just ci` exit 0, 657 passing, 2 pending (the armed skip among them).

### Addendum: the simple diagnostic, and what gossip buys beyond shares

Same day, second test: `cohort.cjs`, *frontier gossip: the sibling that stayed up* - the
AM-node scenario verbatim, with the share machinery stripped out entirely. Two personas, one
follow, one post: the sibling sleeps, the awake node journals, the author leaves forever, the
sibling wakes into a network where its own cohort is the only holder - and the feed row never
comes. RED demonstrated live on the named assertion ("the sibling's frontier gossip carried
the followed author's post"; 657 others green), then skip-armed like its cascade sibling. The
two tests split the diagnosis on purpose: this one says whether the CHAIN lane broke, the
torturous one whether the share lane did.

Writing it sharpened the finding: the last-stop hole was never about rebroadcasts. Plain
follows diverge identically - an author who posts while one device sleeps and then goes dark
is unreachable to the sleeper forever. Which is also the inventory of what frontier gossip
buys beyond the share tree: the AM-node backfill for the whole followed universe; the
phone/desktop story's missing mechanism (a waking phone catches up from its own always-on
desktop in one session instead of forty cellular dials - the connective tissue between
MOBILE's intermittent-peer design and DESKTOP's your-desktop-is-your-infrastructure
argument); new-device bootstrap inheriting the granter's followed world through sessions it
already holds; household politeness (one device pays the external sync, siblings share); and
the future speculative pools inheriting cohort resilience for free, being just more followed
roots.

## 2026-08-15: the cohort joins the tree

The fix the two armed tests were waiting for, and it turned out to be routing, not protocol.
One new roster - `net::sync::cohort_endpoints`, every sibling endpoint of every hosted
persona out of `identity_peers`, liveliest first, self excluded - appended as the LAST rung
of four candidate walks, one consistent order everywhere: the follow-refresh hint ladder,
the fragment walk (endpoint-addressed, after author - origin - sharers), blob healing's
candidate list, and the reap (a sibling is not a persona in any fragment's tree, so its
death cursor is keyed `cohort:<endpoint>` and dialed directly; the drain loop extracted so
both doors share it).

The satisfying discovery: FRONTIER GOSSIP needed no new wire. The sync door's `wanted` gate
has answered for any persona the responder's users follow since pull-not-push was built -
so the whole chain half of "the sibling that stayed up" reduced to making the sibling a
dial candidate. Both armed tests unskipped as the first move and went green on the first
full run (with the rig gaining follow-refresh pacing knobs beside its sweep siblings).

The slice earned its keep twice: the fast test beat put the wake pass and the
stranger-mint guard test in the same window for the first time, and the guard caught
`sync_with_peer` minting an empty database - key, WAL, journal - for every unreachable
followed stranger on every attempt, in production since the wake pass landed. Two rounds to
pin it (mint-after-dial still minted once the cohort made dials SUCCEED - a sibling
politely answering "I hold nothing" is not a reason to mint a shelf): the shelf now waits
for a Hello that claims something to put on it. 659 passing, 1 pending; the census bumped
to 4 for net/sync.rs with the why in place.

### Same day: why the action was red while every local gate was green

CI had failed every run since the reaper landed - and the pasted tail showed the failure in
the ringtome binary's unit tests, which had passed locally four times that day. The culprit:
`recent_grace()` latched its value in a process-wide OnceLock, and the unit-test binary is
one process running many tests. The reaper test shrinks the grace to 50ms by env var, but an
alphabetically-earlier files test touches a store first; whoever calls first latches the
value for everyone. On a many-core Mac the reaper test's synchronous set_var fires early
enough to win; on the constrained runner it lost every time - the latch made TEST ORDER
load-bearing, and the two machines ordered differently. Proven locally by forcing the loss:
`--test-threads=1` reproduced CI's exact assert ("the unreferenced blob was collected").

Fix: the grace reads its env live on every use - an env scan per put/fetch and per GC
round, nothing hot - so no test can freeze it for another. Green at one thread, two
threads, and full parallelism; `just ci` exit 0, 659 passing. The invariant this restores
is the one CLAUDE.md leans on: green locally IS green on the action, which was true of the
recipe all along and false of the parallelism the two machines brought to it.

## 2026-08-16: the feed learns its history, and the gap becomes exact

The journal-fill conversation ("everything AFTER the follow point gets synced; one year of
history is fine") became two durable clocks in node.db (schema gen 23). `journal_marks` is
the forward high-water mark, persisted per author - it lived in sweep_marks, in-memory and
boot-reset, which quietly capped every catch-up at one page: a node dark through fifty posts
journaled the newest twenty and skipped the rest forever, despite holding the full chain.
`journal_for` now pages the shelf down until the gap to the mark closes (with an edit-window
slack on the genesis keyset, since edits move updated_ms without moving genesis), so
coverage after the follow point is contiguous - holes forbidden. `journal_fill` is the
backward dig: per (reader, author) because history is per relationship, one page per beat,
POSTS only (chain sync has never had a window, so the dig is local reads feeding local
writes - no dials), down to the year horizon. The 20-post window survives exactly as
designed: the new-follow burst-to-bound, with everything older arriving at the dig's pace.

A design candidate died in review before any code: "the journal is its own watermark"
(derive the dig floor from MIN(published_ms)) fails on precisely the amnesia case - a dark
window leaves coverage as two segments with a hole between, and a MIN-floor digs below the
OLD segment forever. The NEXT_STEPS two-clock design was right as argued.

The new integration test (journalfill.cjs - a 30-post late follow digs to the first post; a
25-post dark stretch journals exactly on the next arrival) caught a real gap on its first
run: coverage that begins at FOLLOW time (backfill + dig) recorded no mark, so the first
dark stretch after a fresh follow still fell back to newest-page-only. The follow's
backfill now anchors the mark - coverage and mark begin together, by construction. Unfollow
resets the dig with the rows it described (a stale cursor would leave a refollow hollow).
`just ci` exit 0, 660 passing; the share lane's history (fragment fetch per row) and
attribution-key convergence stay in NEXT_STEPS.

## 2026-08-16: second-order edges - the graph assembled, the fold kept home

The trust-and-discovery investigation's first built rung (PROJECT_PLAN: *Implicit edges*,
beside the selectivity design it feeds). Two memos, one per level, and the level split IS
the design. `edge_graph` (node.db, schema gen 24): what synced personas say publicly about
each other, one row per published statement, assembled from each mirrored persona's
`published_edges` view on the FOLLOWS_PUBLIC frontier-move edge - second-order where
`subscriptions` is first-order, consented by construction, a cache of public speech rather
than a new disclosure. `implicit_edges` (each persona's own db, user gen 15): the
composition - my dial toward a friend x their published band toward a stranger, min of the
two, per (target, lane, introducer). In the USER database deliberately: the reader's side
legitimately uses their PRIVATE trust dial (ranking your own feed is routing, not
disclosure), so a level derived from a withheld dial never leaves their own database.

The algebra from Curtis's design: two lanes that never mix (trust composes through trust;
taste composes through the REBROADCAST dial - "an implicit follow is a taste judgment");
raw ingredients over pre-collapsed scores (depth, level, introducer, introducer's vouch
count - banded promiscuity discounts happen at read, tuning never re-derives, and the UI
can explain rather than assert); per-introducer rows with MAX-not-sum rollup (the Sybil
doctrine); explicit dials beat implicit rows; blocked excludes at the fold. His derived-
rows-on-the-ledger framing died in conversation before code, by his own hand ("derived
data like that should never be on the ledger") - the ledger stays opinion, the memo carries
inference.

One choreography, no drift: the node fold rides after_public_move (probe-gated on the
follows-public chain) and nudges subscriptions::refresh_root for every reader dialing the
mover; the implicit fold rides subscriptions::refresh itself, where the store is already
open. Served raw at GET /api/identity/{root}/implicit. trust.cjs proves the pipeline
end-to-end in 706ms: three published vouches assemble into charlie's graph, compose into
cora's implicit set capped from both sides (the taste row comes out LOW through her low
rebroadcast dial beside her high interest dial - the lane keys on taste, provably), and a
withdrawn vouch recedes from graph and set alike. 661 passing; consumers (the slider's
pool, people search, first-contact standing) deliberately future work.

## 2026-08-21: the garbage-dial finding - a background loop is not a visit

Found mid-build on DISCOVERY slice 1 (the speculative pass at posts depth; full entry when
its gates go green), by the first full-suite run after the acquisition loop landed: 23 red,
a wall clock near forty minutes against CI's nine, and the strangest symptom in the pile -
an author's `push_to_askers` tasks sitting in dial limbo for three minutes and then all
completing in the same second, while a follower's feed settles expired one test over.

The cause was a candidate-list indulgence copied from the visit-time ladder.
`idface::fetch_foreign` tolerates hints that resolve to nothing by "falling back to dialing
them as the endpoint id they presumably are" - fine for a visit, because a human handed the
hint over once and the dead dial is paid once. The acquisition pass inherited that
tolerance INTO A LOOP: every unresolved identity key on its rung list (bare vouched roots
with no presence anywhere, unserved targets' root rungs, leaves with no live serving
record) became a dial "as an endpoint" every few seconds per node - each one a
guaranteed-dead lookup that still walks the whole discovery stack, relay and DNS included.
On the airport wifi the suite ran over (Curtis, live, mid-run), those lookups hang rather
than fail, and the shared endpoint's real dials - eager pushes, fan-out to askers - queued
behind junk. The suite didn't have a correctness bug there; it had a starvation bug, and a
bad network is what made it visible. A good network would have merely paid for it quietly.

The rule, now in the pass: a candidate earns a dial exactly two ways - it is an endpoint id
that once actually answered (a recorded via), or an identity key whose live serving record
resolved to an endpoint just now. An unresolved identity key is never dialed by machinery
that runs on a beat. And the dial rides inside the same timeout as the exchange it opens,
because address resolution is network work too.

Same run, second finding, recorded with its fix: a chain held only speculatively shadowed
the fragment ledger in `idface::public_doc_bytes` - the "held chain is authoritative" rule
assumed every mirror has a freshness contract (follow, visit, pin), and a hunch-held mirror
has none, so its silence is ignorance, not retraction. Cascade.cjs caught it the day the
pass landed: a stale mirror 404'd words the reader's own share machinery had already
delivered. The carve-out: for a speculative-only persona the fragment shelf answers first
(explicit beats implicit, applied to shelves); relationship-held chains keep the
authoritative rule unchanged.

## 2026-08-22: DISCOVERY slice 1 - the speculative pass at posts depth

The bytes gap's first working rung (DISCOVERY.md: *The pipeline*, stages 1-2, and *The
speculative pass*): content nobody asked for, acquired because trust vouches for it. Two
memos and a beat, node.db gen 25:

- **`speculative_demand`** - the rollup over each reader's `implicit_edges`, written by the
  implicit fold's own pass (`edgegraph::refresh_implicit` hands the composed rows over as
  values, so the memos ride one choreography). Top-K per reader by composed level, the
  banded promiscuity discount applied per path (<=50 vouches free, <=150 one band, beyond
  two - monkeysphere numbers), MAX across introducers and never sums, best introducer on the
  row, explicit dials excluded whole (an explicit "none" is an opinion speculation must not
  overrule). Budget 16 per reader; a cap, not pacing. Stamp-swept, so a withdrawn vouch
  recedes here on the beat it recedes from the implicit set.
- **`speculative_fetches`** - the quiet twin of `foreign_fetches`, deliberately a separate
  table because the two registries have opposite consequences: foreign_fetches opens the
  sync door and seats the directory; a speculative mirror serves nobody and announces
  nothing. Only member surfaces read it (idface serves a hunch-held persona to the node's
  own readers - reading was never serving).
- **`speculative::acquire_pass`** - the introducer-laddered quiet pull, 300s beat at lower
  priority than real follows: candidates are endpoints that once answered or identity keys
  whose serving record resolves NOW, introducer paths strictly before the target's own
  machinery, four pulls per beat, cooldown-rotated, detached-never-cancelled at the 8s
  deadline. Mirrors mint only on substance; a polite empty exchange stamps nothing.

Acceptance (speculative.cjs): an UNSERVED author - no serving record anywhere, so no ladder
resolves them and "goes dark" is the topology, not a stage direction - is vouched for by a
friend cora trusts; the post lands on cora's node and serves to her browser with her node
never learning the author's machinery exists (asserted from the author's node's own demand
ledger); the mirror stays out of foreign_fetches; withdrawing the vouch recedes the demand
row while the mirror waits for slice 4, on purpose.

The build took five red integration runs to go green, and the findings are the real ledger
(the garbage-dial entry above holds the first two; the rest):

- **The user-db create race, coalesced** (db.rs): two tasks minting the same persona's
  database each built a whole independent Db - two turso connections on one encrypted file,
  two journal handles on one .jnl - the loser's migration failing "table entries already
  exists" was the loud half, exchanges wedging behind the duplicate pair the quiet one. The
  race predates the pass (`fetch_foreign`'s parallel ladder could always hit it); the pass's
  beat made it every-run. `create` now coalesces through moka's `try_get_with`, the open
  rides its own task so a caller's timeout cannot cancel a half-built database out from
  under everyone parked behind it, and the cop (`concurrent_creates_coalesce_to_one_open`,
  16 racers) was planted-red against the old body before it was trusted.
- **Detach, never cancel** (speculative.rs, net::sync): aborting a sync mid-exchange leaves
  zombie connection state the next dial trips over - QUIC's own idle reaper takes minutes -
  and `sync_peers` was sequential with NO bound, so one wedged asker starved a root's entire
  fan-out pass after pass (the red cascade feeds' actual mechanism; run 1's "every push
  completed in the same second, minutes late" was the reaper finally clearing zombies).
  Deadlines now detach the task and move on, in the pass and in `sync_peers` both, and
  `sync_peers` holds a 30s per-peer ceiling.
- **The freshness-contract predicate** (`speculative::speculative_only`), third draft made
  honest: outward surfaces (the fragment door's held-chain shelf, `public_doc_bytes`) may
  speak with a held chain's authority only when a RELATIONSHIP keeps it current - hosted,
  member-fetched, followed. Draft one keyed on the speculative row and let an orphan mirror
  (a pull that died after minting the file) masquerade as relationship-held; draft two
  counted rebroadcast pins as a contract and was refuted by the 2026-08-11 correction
  ("a share obliges a COPY, not a subscription" - nothing refreshes a pinned author's
  CHAIN), which also falsified the fragment door's own header comment, now fixed. The door
  hiding hunch-held chains is doubly load-bearing: freshness (a stale mirror answered
  "Unknown" for words whose fragments the node held, and served yesterday's version of
  edited posts) and quietness (the sync door's wanted gate refuses speculative mirrors; a
  fragment door that answered from the quiet pile would let any peer probe out what this
  node speculates about).
- **A journaled share must leave the node able to answer for it** (fanout's share fold and
  `backfill_share`): the fold's shelf shortcut - "we hold the author's chain, journal from
  it, skip the fragment" - predates the pass and was sound while every held chain implied a
  relationship. A hunch-held mirror broke the implication from the OTHER side: the fold
  journaled the share off the mirror's shelf and minted no fragment, so the node's own
  reader saw the post while the fragment door - rightly hiding the hunch - had nothing to
  serve the next hop. Intermittent by pull timing, which is what made it the last one
  standing. The shelf shortcut now applies the same freshness-contract gate as the door:
  one predicate, every surface, or the surfaces disagree about what the node is.
- **Speculative bodies heal by the relationship that vouches for each rung**
  (net::bodies::sweep, two drafts): the AUTHOR-relationship rungs (profile-fetch via,
  askers, sync peers) exist only for real relationships, so for a hunch-held author they
  degenerated into junk dials - the introducer's `last_via` replaces them, since it already
  knows our interest and nothing else on the author's side should. Draft one cut the whole
  walk down to that one candidate and severed the SHARE rungs with it, breaking "heal from
  the other sharer" - but fragment origins and sharers are facts about the shares, not the
  author, and stand for hunch-held authors exactly as for strangers we hold nothing of.
  What no rung can supply waits for the next pull - staleness is the deal.

Gates: 663 integration passing at the clean baseline's 4-minute wall clock (a suite that
had ballooned to 40 minutes under the garbage dials), 331 unit + 4 conventions green,
clippy clean, `just ci` the formal seal. One void run recorded honestly: a suspended laptop
(seven 15-33 minute holes in the rig log) fails settle windows in whatever suite it lands
on; check the log's clock before believing a red that weird.

## 2026-08-22: CI red on a lint the local toolchain doesn't have yet

The slice-1 commit sealed green under `just ci` locally and failed CI's `lint` stage anyway:
clippy 1.98 (the action's `@stable`) grew `chunks_exact_to_as_chunks` and `-D warnings`
made it fatal at two sites - `record::documents::decode_refs` and the ffmpeg referee in the
audio tests. Local clippy is 1.96 and says nothing. Fixed as the lint suggests
(`as_chunks::<N>().0`; stable since 1.88), which is also simply better - the compiler now
knows the width, so the `try_from(..).expect(..)` ceremony goes with it. Lesson for the
"`just ci` IS the gate" line in CLAUDE.md: it holds only while local `stable` and the
action's `stable` agree. A red that is ONLY a lint, ONLY on CI, means the runner's toolchain
is ahead - `rustup update` before suspecting the change.

## 2026-08-23: the 25-minute CI red - two problems wearing one duration

CI on the lint fix (7a7104c) failed in 24 minutes against a 8-minute green baseline, which
read as "the second-order workstream inflated the build". Decomposed, it was three stacked
facts, none of them a local red (`just ci` on the same tree: 663 passing, 4m suite, exit 0):

- **~17 of the 24 minutes were cold compile** - and the cold was self-sustaining.
  `rust-cache` keys on the toolchain, stable moved to 1.98 mid-red-streak, and the action's
  default saves cache only on success: fail cold, save nothing, fail cold again. The
  test-profile rebuild alone was 11m41s. Fixed in ci.yml with `cache-on-failure: true`.
- **The one red test was a margin, not a bug**: publish.cjs's keyset-cursor walk - 23
  sequential publish round-trips on mocha's 5000ms default budget, the tightest-budget test
  in the suite. 1.1s on a dev machine; past 5s on a cold, busy runner where five rig nodes
  share 4 vCPUs with the workstream's new 2s beats. Same single failure in BOTH red runs
  (36a06cf warm-cache proved it wasn't the cache). Now `this.timeout(30000)` with the scar
  in a comment - a cap, not pacing.
- **The suite itself grew ~1 minute** (660 passing/4m green baseline -> 662/5m): mostly the
  two new settle-heavy files (trust.cjs, speculative.cjs), partly real background churn -
  `edgegraph::refresh_from` re-mirrors and re-folds at posting cadence, not dial-mint
  cadence (REFACTOR.md, 2026-08-23, with the fix shape).

The diagnostic lesson: a slow FAILING run's duration is not a build-time measurement.
Decompose by stage timestamps before believing "the code got slower" - here the code's
share of 16 extra minutes was about sixty seconds.

## 2026-08-23 (later): the cascade intermittent, run to ground

The "any sharer will do" family flaked in five of eight suite runs across the day (local and
CI, three different asserts, one describe block) - and the dig kept hitting the same wall:
every failure path in the heal machinery was silent, so a red run's log was indistinguishable
from a healthy one. Instrumentation landed first, findings second:

- **`p2p::dial` grew a test-only CONNECT ceiling** (`RINGTOME_TEST_DIAL_TIMEOUT_MS`, rig set
  to 1500ms): on a test rig the other side is on this machine or not going to answer, and
  QUIC's UDP means "not going to answer" is a full handshake ladder of silence even on
  loopback. Connect only - exchange ceilings keep production patience, because five rig
  nodes on four CI vCPUs can be CPU-starved into finishing slowly while very much THERE.
- **The heal paths speak now**: per-candidate outcomes in `bodies::sweep`, an exit line when
  the eager heal leaves wants standing, `edgegraph::refresh_from` errors at WARN (it has no
  backstop beat - a swallowed error there is a missing edge set, not a late one).
- One instrumented red run then named the bug in minutes: the sweep tried the DARK node's
  endpoint 165 times, the eager heal fired 431 times at the dark origin, and the living
  sharer's node appeared in neither candidate list even once. Full diagnosis and fix shape
  in REFACTOR.md ("Any sharer will do" can only name sharers the reader follows) - the
  deliverer of a fragment must become a remembered heal rung.

Also from the hunt: the diagnosis rides a probe idiom worth keeping - `/test/sql` polled
from OUTSIDE the suite while it runs (Content-Type: application/json required), which turns
any intermittent into a time series without touching the code under test.

## 2026-08-23 (evening): the deliverer rung and the fold gate - the flake tail cut down

The two fixes the day's diagnosis called for, built and soaked:

- **`fragment_deliverers`** (node gen 26): `Fetched::Have` now carries WHO SERVED the
  fragment - the endpoint that answered, captured in `fragment::ask`, the one place it is
  definitively known - and every intake arm stamps it per author (the
  `speculative_fetches.last_via` idiom). Both heal walks dial the deliverers first among the
  share rungs: already endpoint-shaped, no resolution ladder, no unresolved-key dial. This
  closes the diagnosed gap where a reader one follow deep held only dark candidates while
  the node that handed over the header was remembered nowhere.
- **The edge fold gates on the follows-public frontier's change mark**
  (`frontier::service_mark` + the sweep marks, equality-compared - a fingerprint is not
  ordered, and `held_at_ms` cannot tell two moves in one millisecond apart): a posts-only
  public move now costs one primary-key read where it re-mirrored the whole edge set and
  re-ran the per-reader fold. The suite's wall clock came back down with it.
  One self-inflicted lesson en route: the gate first recorded its mark BEFORE the fold, so a
  transient fold error on a loaded CI runner became edges missing until the chain's next
  unrelated move - trust.cjs red on CI, green locally, twice. **A mark that gates an
  event-riding fold with no backstop beat must move only on success**; a failed fold leaves
  it unmoved and the next hook retries at the pre-gate cadence.

Soak: four consecutive full-suite runs post-fix - two fully green (the first all day), two
with a single red each, neither in the heal-candidate family that previously failed every
other run. What remains is the body-arrival race tail, recorded in REFACTOR.md with the
diagnosis idiom that will crack it when it earns the dig.

## 2026-08-23 (night): the visit ladder converts to detach - the last cancel falls

The sharedby CI artifact delivered the cluster REFACTOR's visit-ladder entry had been
waiting for: three share pointers took 128 seconds - QUIC-idle-reaper time - to cross to a
node whose wake pass was dialing their host every four seconds, every dial wedged behind a
poisoned connection, then all three landed in one burst the moment it cleared. The entry's
own prescription applied verbatim: `idface::fetch_foreign` no longer aborts the also-rans
on first success and no longer cancels an exchange at its deadline - each exchange rides
its own task, deadlines and winners bound the wait and detach the work (the
`speculative::acquire_one` idiom), and a late also-ran leaves a warmer mirror. With this,
no exchange anywhere in the node is cancelled mid-flight.

Also from the same artifact, the fix that preceded it: the rig had never set
`RINGTOME_TEST_FOLLOW_STALE_MS`, so the wake-pass backstop was silently disabled across the
whole suite - every followed mirror "fresh" for a production 30 minutes, all test
propagation riding pushes alone. Wired to 2000ms, trust.cjs's class went green on CI (the
run that caught sharedby was the first with a pull road beside every push). The remaining
mystery - WHY exchanges to a live loaded node hang until something reaps them - stays in
REFACTOR.md, one suspect thinner now that the last aborter is gone.

## 2026-08-24: the tail dig's real finding - the logs had no clock

The residual-tail dig set out after a stalled share pointer and instead cleared every
suspect: the eligibility windows are sound (`fragment_wants` rows are born eligible), the
demand ledger registers askers, pushes deliver within a second, ingest persists, folds fire
per exchange, and the door answers honestly. The stall's mechanism remains uncaught - because
the dig's actual blocker was forensic, not mechanical: rig logs carry five nodes' interleaved
traffic with nothing marking where one test's choreography ends and the next begins, and the
night's wrong turns (a phantom re-delivery loop, a phantom frontier stall) were all artifacts
of reading the right evidence in the wrong window.

So the deliverable is the suite's clock, written into the evidence: **`/test/mark`** (a
LOCAL_TEST door that stamps a note into the node's log) and roothooks that post every test's
title to every rig node at START and END - 1326 marks per node per run, at the cost of two
fire-and-forget HTTP posts per test. With `journalable`'s branches also speaking now, the
share path has no silent step left. The tail keeps its REFACTOR entry, one instruction
shorter: read the marks first.

## 2026-08-24: the People page's suggested shelf - discovery gets a face

The first UI consumer of the trust arc (NEXT_STEPS: "surface implicit edges in the UI"):
a third shelf between "everyone you know" and "known around here" - exactly where its
people stand. **`GET /api/identity/{root}/suggested`** serves the reader's demand rollup
JOINED to `speculative_fetches`: a suggestion the node cannot render a face for is not yet
a suggestion; it becomes one on the beat its pull lands. Rows carry the speakable spelling
and bylines from the cache (one query, no database per face - the directory's discipline),
plus the best introducer's name for the row's right-edge byline ("via mara" - the
`PersonRow` widget grew an `aside` slot for exactly this, worn instead of a relationship
glance a stranger cannot have). Discounts and explicit-dial precedence come free: the
rollup already applied both, and the shelf excludes anyone on the contacts shelf besides,
covering the beat between a dial and the fold that notices it. A suggested persona also in
the directory shows on the suggested shelf alone - the vouch is the stronger claim.

Red-first both layers: the acceptance test (speculative.cjs, the suggested shelf naming the
vouched-for author via the friend) ran red on the absent endpoint before the endpoint
existed, and the unit cop (`suggestions_require_a_landed_mirror`) pins the join that makes
the shelf honest. Ownership gate is `store::open`, same as `implicit` - the rollup composed
through the reader's private dials, so only the reader reads it.

## 2026-08-24 (later): DISCOVERY slice 2 - speculative rows reach the feed, provenance attached

The bytes slice 1 acquired become feed rows (`feed_journal.suggested_via`, node gen 27):
`journal_for` grew its third reader criterion - the demand rollup, asked per author off the
same by-target index the acquisition pass uses - and speculative readers journal from the
NEWEST PAGE ONLY, however deep the mark-driven walk goes for real followers; the history
courtesy belongs to chosen relationships. The precedence ladder is two SQL clauses: the
speculative writer's `ON CONFLICT DO NOTHING` (a row that exists is never touched - real
beats speculative, and between two introducers the first keeps the byline, via_root's own
rule) and `suggested_via = NULL` in the real upsert (any follow or share arrival converts
the row in place - same primary key, marking shed, never a duplicate). The feed API ships
`suggested_via` + name beside the share byline fields, absent on every real row so old
clients render unchanged, and the post card wears "«chip» vouches for this author" in the
share line's seat - mutually exclusive with it by construction.

Red-first at both layers: the acceptance test (cora's feed carries the unasked-for post
marked and bylined, then her real dial sheds the marking in place) ran red on the
pre-slice binary; the conversion cop (`real_arrivals_convert_speculative_rows_and_never_the_reverse`)
was planted red against an upsert without the clearing clause before it was trusted.
Withdrawn vouches leave journal rows standing on purpose - hiding them is the slider's job
(slice 3) and deleting them is eviction's (slice 4).

## 2026-08-24 (evening): DISCOVERY slice 3 - the slider; attention becomes a choice

The pipeline's fourth stage (PROJECT_PLAN: "one slider, two budgets", built as designed):
six stops with their titles verbatim, Explorer the default, one control at the top of the
feed whose position is a persona-level private register (`feed_selectivity/stop`) - a fact
about the person's feed that syncs with them, unlike the per-device seal prefs. Pure
attention by construction: the filter is `pure/selectivity.js` running client-side over
rows already journaled, so moving the slider is instant, reversible, and network-silent in
both directions, and nothing about it ever changes what syncs.

The brain went in spec-first: the pure suite's `selectivity.cjs` (seven cases - the stop
ladder, the provenance precedence, silence-vs-none, promotion seen from the read side) ran
red before the module existed. The precedence (author dial → sharer rebroadcast dial →
path band → floor) both filters and sets emphasis - a speculative row arrives small and
quiet whatever its path score, because the path admits it without entitling it to size -
and the feed API ships `suggested_level` (the demand rollup's discounted band, read-time
joined only on pages that carry suggested rows) as the path rung's input. A reader's own
posts bypass the floor: the slider curates other people's claims on attention, and hiding
your words from yourself would read as loss. When the floor hides everything, the empty
state says so and points at Explorer, instead of claiming an empty network.

With slices 1-3 standing, the discovery arc is END-TO-END: vouch → quiet acquisition →
suggested shelf → marked feed rows → a slider the reader owns. Remaining: eviction (4) and
the headers depth (5), both order-independent maintenance.

## 2026-08-24 (night): cleared relationships stop haunting the rolodex

Found by Curtis on deck-tamer's People page: contacts with no trust or interest standing on
"everyone you know". The mechanism is the ledger's own shape - contact registers are
append-only LWW, clearing a dial writes "" and deletes nothing - so any set-then-cleared
relationship (test-data's `unfollow-someone`, or a real change of heart) left a collection
of empty registers that the mirror faithfully shipped and the shelf faithfully showed as
"nothing recorded yet". The fix is a shelf rule, not a mirror change: `standingFacts`
(pure/people.js, spec-first) keeps rows with ANY non-empty fact - a dial, a nickname, a
block - and the mirror keeps the cleared rows for what they are still good for (resolving a
once-known name). Cleared people land in their own bin instead of vanishing: "you used to
know", BELOW every current shelf (Curtis's call - you have to go looking, so idle browsing
never walks you past your unfollows, but a lost pointer is one scroll away instead of gone;
a persona's address is a key nobody writes down). The bin dedups against every shelf above
it: a cleared person who is now vouched-for or node-known shows there instead, under the
stronger present-tense claim - "cleared" means no opinion, and no opinion is exactly what
the discovery shelves are for.

## 2026-08-24 (night, cont.): the People search loses its button

One field, two jobs, told apart by the input instead of a click: typing filters the shelf,
and pasting a COMPLETE address navigates immediately - the "look up" button retired as
redundant (Curtis's call). The commitment moment the button provided moved into the parse:
`parseIdReference` alone is loose by design (anything hyphenated passes, so "sway-bro"
mid-type would have navigated out from under the typist), and only a segment whose key
actually decodes (`parseSpeakable`) is unambiguous enough to act on unasked. A decodable
key with lying words still navigates - the /id lens owns that refusal and says "did you
mean" better than a search box could. The address clears the query on its way out (it was
a destination, never a filter to come back to), and the dead-CSS cop caught the button's
orphaned styles on the first gate run, which is the cop working.

The first live keystroke found the deeper hole: typing "y" teleported to
apple-fifth-1111…1y, because BOTH twins' base58 decoders left-pad any fragment to 32 bytes -
"y" is a valid near-zero root if you let it be - and the JS strict gate trusted
`parseSpeakable`, whose bare branch trusted the decoder. The rule that fixes it is minted
into both languages in lockstep (pure/speakable.cjs and speakable.rs's parity test): **an
address's key must ROUND-TRIP** - decode then re-encode equals input - because keys only
ever come from `toBase58`, so everything canonical round-trips and nothing partial can. The
lenient decoders stay for the `?via=` hint path, where hints are dirty by doctrine and the
resolution ladder validates; the /id parse, which acts unasked, demands the round-trip.

## 2026-08-24 (later): the residual tail, caught with its mouth open - and closed

The instrumentation built for exactly this moment paid out in one read: a CI artifact whose
TEST MARKs bounded the failing window to the second, and a share path narrated at every
step. The story it told: sam's pointer reached rex's node in milliseconds; `journalable`
fetched the fragment from bravo in NINE milliseconds (bravo's door answered "have" 4ms
after the ask; the revalidation sweep confirms the fragment held from that moment on) - and
then the feed row didn't mint for 187 seconds, arriving on the next unrelated fold, 700ms
after the settle died.

The bug was the arm's last line: `held(...).await.ok()??` - a DATABASE RE-READ of the
fragment the arm had just stored, whose `.ok()??` swallowed a transient busy error on a
loaded node into "nothing to journal". Silently, and uniquely without retry: the want
ledger only mints on the Unknown arm, so a SUCCESSFUL fetch whose re-read hiccupped
stranded the row until the sharer's chain happened to move again. Every face of the tail
fits it - near-miss reds arriving all-at-once on a later fold, always under load, never
reproducible at leisure.

The fix removes the failure point instead of handling it: `row_of_verified` builds the
journal row from the verified fragment still in hand - the same bytes `remember` just
stored - in both arms that had the re-read (`journalable`'s tail and the wants drain's
arrival). Nothing needs the database to repeat what the arm is holding. The
hung-30s-exchange question (REFACTOR) stays open as its own mystery; the body-arrival tail
entry retires with this.

## 2026-08-24 (late): DISCOVERY slice 4 - mirror eviction; retention becomes real

Nothing ever evicted a mirrored persona before this: every chain that arrived stayed
forever, invisible while every mirror was asked for, a leak the moment speculation minted
mirrors on hunches that recede. `eviction.rs` is the retention edge: an hourly sweep whose
one judgment - a mirror nobody wants is holding chains nobody asked to keep - is a pure
conjunction of keepers (hosted, any dial, member-fetched, fragments standing, demand
standing, the mtime grace), each individually pinned by the keeper cop. The first draft
had one keeper too many - an open-handle check, which read as the cheapest in-use grace and
was actually "cached recently", keeping every mirror on a quiet node forever; the
acceptance test caught it on its first green-side run, which is red-first doing exactly its
job on the OTHER side of the fence.
Eviction takes the files (db, WAL, raw-entry journal, sealed key - the keystore grew
`remove` for exactly this) and every bookkeeping trace, each through its table's owner;
blobs stay the reaper's by refcount. Safe by the same shape that makes promotion clean:
every door that could re-mint a mirror acts only on the relationships whose absence
admitted the eviction, so if one returns, the mirror refetches with it - an eviction is
never a loss, only a release.

Acceptance red-first in the speculative family's own choreography: the withdrawn vouch plus
cora's cleared dial leaves the author wanted by nobody; the sweep empties the fetch
registry and the byline cache, the profile door answers 404, and the friend's followed
mirror survives the same sweep untouched. The slice-1 test's "the mirror waits for slice 4"
finally has its answer.

## 2026-08-24 (later still): the share fold gets a ceiling - the last unbounded inline wait

The CI reds that survived the re-read fix were the OTHER face: mark-bounded artifacts twice
showed `journalable`'s fetch produce no outcome for 60-187 seconds while the peer's door
had answered in milliseconds and the 8-second per-candidate timeout inside never fired. A
timer that cannot fire means the enclosing task was stuck inside a synchronous poll -
something on the node blocks, and the share fold (inline on the sync serve path) blocked
with it. The cause is still hunted (REFACTOR, the hung-exchange entry, now with the
task-starvation lead); the fold is immune meanwhile: its fetch runs on its own task under a
10-second ceiling, detached on deadline into the Unknown road, where the want ladder owns
recovery on the drain's beat. The spawn shape is the point - the stuck section rides the
spawned task while the fold's own task polls nothing but a timer and a join handle, so the
ceiling can always fire. Deadlines bound the wait, never the exchange, now everywhere the
fold touches the network.

## 2026-08-25: the stale serve, cornered in the storage layer - and honestly not yet caught

The CI artifact for the persisting sharedby red, read by its marks: the share write landed
with a 200 and an in-handler frontier move, charlie pulled the sharer every four seconds,
and bravo - the sharer's own host - answered `sent=0` for three minutes, going fresh at
exactly the next write to that database. `send_missing` plans off the entries table, so
this is the node's own read of its own hosted chain being stale: the flake family's every
"arrives on the next chain move" face, compressed into one storage-layer question.

The fetch helpers' error paths were found breaking the module's own open-statement rule
(an early `?` on a decode error exits without draining) and fixed drain-then-fail - but the
planted violation left the new cop GREEN on the test database, so that hole is a rule fix,
not a proven cause: turso's Rows drop finalizes there, and whether disk-WAL connections or
the CANCELLATION path (a dropped fetch future skips any drain) behave the same is exactly
what the dig must answer next. The decisive instrument is in place - the serve logs its own
frontier heads whenever it sends nothing - so the next stale-serve occurrence names its
branch in one line. The fold ceiling from earlier keeps green runs green meanwhile.

## 2026-08-25 (cont.): the instrument flips the verdict - the reader, not the server

One local recurrence with the serve instrument aboard settled what three days of theory
could not: bravo's serve-side heads ADVANCED across the failing window (10:1 -> 10:3) while
every serve sent 0 - the puller's claims covered the entries. Charlie has them. The stale
read is the reader's own share-fold view of the sharer's user database: entries ingested,
memo moved, fold reading the past - the stale pointer counts that appeared in every fold
narration were the bug showing itself all along. REFACTOR's entry is rewritten around the
inverted diagnosis, the instrument now carries both sides' heads, and the suspect space is
down to two: a second connection on one encrypted file (cross-connection WAL visibility),
or a pinned read snapshot surviving on the shared handle. One more narrated occurrence
should convict one of them.

## 2026-08-25 (cont. 2): narrowed to the verdict race

The completed instrument exonerated storage reads entirely: claims lockstep with the server
end to end, and the 62-second fold gap held zero frontier-moved verdicts across eight
successful ingests - unsticking in a burst when a posts-chain arrival forced a true. The
flake family's residue now lives in one place: `frontier::refresh`'s moved verdict under
concurrent exchanges, where the true-getter fires the hooks and every racer gets a silent
false. Verdicts now log with caller attribution; one more narrated window names the winner
whose hooks didn't cover the entry.

## 2026-08-25 (cont. 3): the settle era ends - 133 waits become rung beats

The switchover the flake war argued for: `/test/beat` rings any background pass NOW and
returns when it has completed, and the whole integration suite now sequences act -> ring ->
assert instead of racing timers under load. 133 propagation settles across 15 files became
explicit hops; seven remain, each because the WAIT is the property (two transcode jobs, the
iroh-blobs GC whose schedule is the library's, the edit-window freeze, frontiers'
stale-while-revalidate trigger, the demand-record serve-side write, and the cross-device
memo test that exists to prove the post-ingest hook fires unprompted). Blind sleeps died
with them - cascade's rollback sampling is now eight FORCED revalidations, every iteration a
guaranteed chance to get it wrong. The suite runs in 2 minutes, green, exit 0.

The beat vocabulary earned by four adjudication runs: `pull` (the fetch ladder, widened with
the cohort rung the way spawn_revalidate widens it), `fold` (the whole post-arrival hook
chain, unconditional), `eager-push` (FORCED - the loop's debounce reads "nothing new" as
quiet and a rung beat cannot afford that), `demand-push` (push_to_askers awaited - the fold
spawns it detached), `mint` (the delivered path's whole sending half: memo, statement,
knock, awaited end to end), `outbox`, `body-heal` (the eager body heal awaited - intake
spawns it detached, and no count of forced sweeps could deterministically land a fragment's
bytes), `fragment-sweep`/`bodies-sweep` (due-ness forced first: stamps zeroed, then swept),
`journal-fill`, `follow-refresh`, `speculative-acquire` (attempt stamps cleared first),
`evict`.

The catch of the day rode run 3: a rung mint one millisecond behind a dial's own write
nudge minted NOTHING - its contacts read missed the just-committed entry - while the
nudged sweep minted it three milliseconds after the beat returned. Two concurrent refreshes
folding the same private-register watermarks can interleave into a stale ledger read: the
same stale-fold-read family the verdict-race dig has been circling, caught red-handed on
the sending side and self-healing in the free-running loops, which is why it hid.
`subscriptions::refresh` now serializes per root, which makes any caller's refresh
read-your-writes for every write that committed before the call. publish.cjs's "dated"
test also fell to the faster suite (a profile read racing the publish's fold - a latent
flake that predates the switchover) and now folds first.

## 2026-08-25 (cont. 4): the share-arrival rung earns a name - and then names the real bug

The first post-switchover CI runs kept biting share hops (rebroadcast's via-less row,
cascade's seeds, sharedby's crowd counts), so the two-round arrival rung became `beat.cjs`'s
`shareArrives(host, sharer, author)` and every share hop in the suite rides it. Then the
next CI failure's artifact named the actual defect, and it was never a race the rung could
outwait: `journal_rows`' upsert read an existing row's `via_root IS NULL` as "this is a
follow row, and follows outrank share bylines" - but a SPECULATIVE row is also via-less, so
whenever the acquisition pass journaled a post before the share fold did (a cadence coin
flip, hence the flake's face), the real share's byline was dropped and `suggested_via`
cleared: a row credited to nobody, for an author the reader does not follow. The CASE now
converts a speculative row to the share's byline (marking shed) while a genuine follow row
still outranks any later share - pinned red-first beside the existing conversion cop
(`a_share_arrival_converts_a_speculative_row_and_keeps_its_byline`). The rung stays: its
first round's want-drain covers real first-ask misses, and the second is a belt against the
still-open fold-race family (REFACTOR).

## 2026-08-25 (cont. 5): the reaper's blind spot eats a 75-millisecond-old body

The other CI failure was journalfill's author refusing to publish its own trigger post -
"this note's words haven't arrived on this computer yet", about words created 75ms earlier
on that same computer ("blob not readable locally: encode error"). The artifact plus a read
of iroh-blobs' GC settled it: the round runs our protect callback (live-set walk + recent
ring) FIRST, then `clear_protected` (wiping write-time auto-protection), then mark, then
sweep - so a blob put between the ring's snapshot and the clear is in no net at all, and
the rig's 2-second GC cadence against journalfill's 55 rapid creates made the collision
routine on a slow runner. Grace could never fix it (the ring is read at snapshot time); the
one protection read AFTER the clear is a live TempTag, which `add_bytes` mints and our put
paths were dropping on return. The recent ring now HOLDS each put's temp tag for the grace
window - exactly the "referencing row is about to land" gap the ring has always stood for -
and prunes on every GC round as well as every insert, so expired tags release even on an
idle store (the reaper end-to-end test is the proof both ways). Pinned red-first:
`a_fresh_puts_temp_tag_outlives_the_put`. Production exposure was real but rare (30-minute
rounds); a user posting at the wrong moment could lose the body their header names.

## 2026-08-25 (cont. 6): the fold lane - the ownership model the flake family was about

The structural fix the whole 2026-08 dig argued for (and the settle switchover kept
re-proving one variant at a time): derived-state work is now serialized, generation-based
and drainable, per root (`fold.rs`). Every arrival path - both ends of a sync exchange, the
frontier backstop sweep, the body heal, the takedown - stops running the hook chain itself
and stops branching on `frontier::refresh`'s moved verdict, which under concurrency let one
caller fold its own snapshot while every racer stayed silent ("the data arrived, but the
derived state did not update until something unrelated moved"). Arrivals now `nudge` (bump
the root's generation; `nudge_ledger` when general-private entries landed, keeping the old
`ledger_moved` memo-cost gate as a nudge flavor); one single-flight worker per root runs
the chain - frontier memo, feed journal + edge graph + demand push, notifications, share
fold, subscriptions memo - snapshotting the generation before each run and looping until it
has covered the latest, so the last run always starts after the last write it covers:
read-your-writes, structurally, for every consumer at once. `drain` awaits "a run that
began at or after my nudge completed" - the test beat's `fold` pass is now exactly
`fold_now` (nudge + drain), the takedown drains before its 200, and the sync serve path no
longer runs any fold inline (the hung-exchange family's other half). The moved verdict
survives as an INFO log and the hooks' own cheap change gates, which serialization finally
makes correct. State machine pinned by unit tests (overlap detector, read-your-writes,
ledger-leg survival), violation planted and watched red per house custom.

## 2026-08-25 (cont. 7): the fold lane's shake run finds the immortal mirror

A repeat integration run over the fold lane went 678/1 - the speculative eviction test,
1-in-4 - and the rig log named it in minutes (what the deterministic suite is FOR):
`evictable`'s member-visit input read the ageless `foreign_fetches` list, and the
follow-refresh pass mints a visit row for any briefly-followed persona, so whenever that
cadence coin flip landed during the test's promotion phase, "cleared the dial" could never
evict - in the test or in production, where one profile view made a mirror immortal and
defeated DISCOVERY slice 4's whole premise. The first fix (age the visit by the eviction
grace) promptly failed the other way: the rig's zero grace made visits protect NOTHING and
the background evict loop ate freshly-visited mirrors in the fetch->dial gap (six reds in
one ci run). Where it landed: the member-visit input leaves the gate entirely - a fetch is
a WRITE, so the mtime grace already is the visit's freshness protection, without the
immortality - the evict BEAT forces grace zero ("evict NOW" gates on claims, never on
clocks, the forced-due posture of every sweep beat), the rig's background loop gets a real
grace (600s - the beat is the eviction driver in tests), and `evict_one`'s owner-forgets
walk now drops the visit row so the sync door and directory never claim a persona whose
database is gone. Retention-semantics change worth a look on review: a bare visit's claim
is now exactly one quiet grace window.

## 2026-08-25 (cont. 8): "the dial counts" - the last barrier class closes at the source

The next CI red ("the post reached sky, who follows ava", sharedby seed hop ONE, on a
4-minute runner) was not the share machinery at all: a dial's subscriptions-memo row is
derived ASYNCHRONOUSLY from the dial's own 200 (the nudged sweep), and a publish on a slow
box outran sky's memo - the fold then fired into a follower list two names long, and
nothing owed sky a row until ava's next move. fanout.cjs had documented the barrier
("the follow must be in the memo BEFORE the post") since its conversion; sharedby's,
cascade's, rebroadcast's and cohort's cast setups never got it because the settle era
absorbed the lag inside the feed settle. Two fixes, one class: every cast setup now folds
its readers before anything publishes (the belt), and the contact-dial PUT itself drains
the fold lane before answering (the fix) - a 200 on a `contact:` register now MEANS the
dial counts, read-your-writes at the API, for the person who follows someone and opens
their feed in the same breath. Every other private register keeps the fast path.
