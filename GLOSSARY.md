# Glossary

The project's vocabulary, grouped by layer. Terms marked *(planned)* exist in PROJECT_PLAN but
not yet in code. The second section is the Cozyweb language mapping — which of these words users
are ever allowed to meet, and in what costume.

## Identity

- **identity** — a person(a). Cryptographically: a tree of ed25519 keypairs. The root's public
  key *is* the identity's global name, forever.
- **root key** — the keypair whose pubkey names the identity. May go cold, retire, or die without
  ending the identity.
- **key tree** — all of an identity's keys, related by signed authorizations, totally ordered by
  seniority. Computed locally from chain entries by any relying party (`proto::keytree`).
- **leaf key** — a key held by one node to act as the identity there. A node holds only its own
  leaf, never the root or another node's leaf.
- **recovery key** — a keypair minted at identity creation as the root's *first* child, handed to
  the user (the photo ceremony) and never persisted by the node. Structurally senior to every
  later key; the break-glass credential and the only reset-eligible key.
- **rank path** — a key's position as the vector of birth indices from the root (root `[]`, first
  child `[0]`, its second child `[0,1]`). Lexicographic comparison of rank paths *is* the
  authority order.
- **seniority** — the entire authority relation: any senior key may revoke any junior one.
  Determined by rank path; birth order, never wall-clock time.
- **usurper list / stamp** — the cumulative list of already-senior keys a parent signs into each
  child's authorization. The child's portable, self-incriminating credential; validators recompute
  it from the parent's chain and reject mismatches.
- **authorize** — the statement admitting a new key to the tree (entry type 1).
- **revoke** — the statement ejecting a key (entry type 2), with a **disposition**:
  - **retirement** — "closed, no prejudice": anchored history honored, children live.
    Self-issuable.
  - **repudiation** — "hostile, quarantine": everything beyond the anchors distrusted, the
    subtree dies. Strictly-senior-issuable only.
- **anchor** — a `(service, seq, head_hash)` triple in a revocation, pinning the exact prefix of
  the revoked key's chain that remains trusted. The hash is what makes backdating impossible.
- **ceiling** — the per-chain consequence of anchors: entries at or below it stand; beyond it,
  refused.
- **equivocation / fork** — one key signing two different entries at the same sequence number.
  The only way un-orderable siblings arise; indistinguishable between malice and a stale-backup
  restore; resolved by the **tiebreaker** (lowest child pubkey) for convergence, not fairness.
  A fork condemns the key.

## The log (IM-AOL)

- **IM-AOL** — Identity-Managed Append-Only Log: the data structure under everything. Per-key,
  per-service signed hash chains.
- **entry** — the atomic unit of signed history. On the wire: an **envelope** `[body, sig]`; the
  signature covers `domain-tag || body-bytes`, so verification slices and never re-encodes.
- **chain** — one key's entries for one **service** (identity-public = 0, profile = 2, posts = 3,
  …), dense sequence numbers (**seq**), each entry's **prev_hash** pinning its predecessor's
  exact bytes.
- **entry hash** — BLAKE3-256 of the envelope bytes; the entry's name; what chains link and
  anchors pin.
- **payload** — an entry's type-specific body: **inline** (small, canonical CBOR) or a **blob**
  reference (32-byte hash of droppable external content — delete = drop the blob, the signed
  header survives).
- **canonical CBOR** — the deterministic byte encoding (shortest-form, sorted keys, NFC text).
  One logical value, exactly one accepted byte encoding; strict readers reject everything else.
- **type registry** — the append-only namespace of service ids and entry-type ids
  (`proto::registry`).
- **materialized view** — a query-shaped projection of the log (e.g. `profile_view`). Disposable
  by design; **rebuild** wipes views and replays the log, re-validating every link.

## The network

- **node** — a Rust server running this protocol, agenting identities for its users. Distinct
  from a key: a node *holds* keys.
- **endpoint** — the node's iroh transport identity (its own keypair — never an identity key;
  signature domains keep the roles apart).
- **sync** — the custom replication protocol over iroh QUIC: a **symmetric exchange** of Hello
  (frontiers) and entries, both directions, identity chains first.
- **frontier** — a per-chain held range `[floor..head]`. A range, not a high-water mark, so
  chains can someday be held shallow (git-shallow-clone style) without a protocol break.
- **validation gate** — the checks every arriving entry passes *before storage*: strict decode,
  signature, chain contiguity, tree membership, ceilings. Sync is the trust boundary.
- **adoption** — the add-a-node ceremony: the joining node mints a leaf and emits a **request
  code**; the root's node authorizes it and emits a **grant code**; the joining node syncs,
  finds its authorization on-chain, and starts agenting.
- **agenting** — holding a leaf key and acting for an identity (writing, signing). Contrast:
- **fronting** *(planned)* — serving an identity's public data without holding any key. Serving
  requires no authority; authoring does.
- **serving record** — a small signed statement published under a leaf key: "this leaf serves
  root R at endpoint E." A pointer, never an authority — trust always comes from chain-to-root
  verification at sync time.
- **endpoint record** — endpoint id → socket addresses; transport plumbing (iroh's own discovery
  in mainline mode, simulated by the local stub otherwise).
- **directory** — where records are published/resolved: `off`, `local:<path>` (the shared-folder
  DHT stand-in), or `mainline` (the real BitTorrent DHT via pkarr).
- **publication is an act** — the doctrine that nothing about an identity reaches public
  infrastructure as a side effect; serving records exist only after an explicit "serve" step,
  because a DHT publish is an irrevocable, scrapeable disclosure.
- **monotonic memory** — a relying party never un-learns: the highest-authority statement seen
  is remembered forever, so eclipse can delay truth but not roll it back. (Implicit in the
  append-only store today; becomes an explicit component for remote identities.)

## Trust *(planned — Tier 5)*

- **vouch** — "I met this human": the scarce, in-person-verified edge everything Sybil-resistant
  is built on. A follow is *never* a vouch.
- **trust / credibility / interest / taste** — the four scores; trust underlies the rest and is
  computed as joint network flow over vouch edges within a bounded horizon.
- **contact name** — your private, never-synced-outside-your-identity label for someone; binds to
  the root, not the display name, which is what defeats costume attacks.
- **display name** — an identity's mutable self-claim. **identicon** — the unforgeable visual
  derived from the root pubkey that disambiguates it.

## Cozyweb language mapping

The UI teaches at most two or three concepts, each in domestic clothing. Everything in the left
column is **banned from the UI permanently** (PROJECT_PLAN, The Cozyweb Surface).

| engine room | the UI says |
|---|---|
| identity / key tree | you; your persona(s) |
| recovery key + photo ceremony | your **spare key** — "take a picture, keep it safe" |
| adoption (request/grant codes) | "**invite this computer to be you**" (QR handshake) |
| vouch | "**I know this person for real**" |
| node / agenting | your computers / your places |
| serve + publish record | **share** (sharing is what makes you findable) |
| sync, chain, entry, seq, hash | *(invisible — no costume; they simply never surface)* |
| revoke / repudiate | *(surfaces only inside recovery flows, as "lock out that computer")* |
| pubkey | *(never text; rendered as the identicon)* |
