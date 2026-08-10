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
