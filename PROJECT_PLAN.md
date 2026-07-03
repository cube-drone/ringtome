# Rettro — Project Plan

## Vision

Rettro is a **distributed social network** built on the [Iroh](https://iroh.computer/) peer-to-peer network. 

Rettro's aim is to provide a bunch of stupid horseshit from The Old Internet: IRC-style text chat, bulletin-board
style posting, geocities-style "simple website authoring", webrings, hit counters, webcomics, MIDI files, and
if we're feeling saucy maybe some mp3s. 

Users connect to **connector nodes** — lightweight Rust servers that provide authenticated access to the p2p network. 
Each user has a durable, portable cryptographic identity that can roam between nodes.

It's "lightly federated" - in ATProto or Mastodon, the fediverse operators need to build large, resilient monolithic
systems with uptime guarantees, backups, and a holistic view of their system's relationship with the whole network
(lest their reputation tank and their system get de-listed). 

The idea is that in Rettro, your identity might live across several nodes at the same time - maybe you're running a node
on your PC, or a cheap VPS you set up, or a friend's PC. You might set up an emergency node on an old Raspberry PI. So long
as ANY of these devices are on the network, you're on the network. A public server node offers authenticated access to 
multiple identities, but a local node might simply protect a single identity behind a PIN code.

Rettro works from a "private by default" nature - the idea is that 99.5% of the network is going to be bots or trolls,
and instead of trying to moderate them out of a public system in an automated fashion, (increasingly impossible)
you instead proceed by building out and explicitly modeling trust: you met Eve in person, so you know she's real,
she met Frank in person and so you're _pretty sure_ Frank is real, but only insofar as you trust Eve, and so on.
This is why we have a system that allows users to spin up and manage multiple "Mask" public identities - given that
in a p2p network, you can't trust that anybody isn't a cloud of anonymous bots, it makes it much more _clear_ to users
that they should not trust anybody if they, too, are empowered to be a cloud of disposable identities.

The existing codebase (in `api/`) is a prior-generation Rust+Axum web service organized around multi-tenant communities. It will be used as a **reference and pattern library** but the new system will be built from scratch to reflect fundamentally different architectural assumptions.

---

## Architecture Overview

```
┌─────────┐       ┌─────────┐       ┌─────────┐
│  User A │       │  User B │       │  User C │
│ (browser│       │ (browser│       │ (browser│
│  or app)│       │  or app)│       │  or app)│
└────┬────┘       └────┬────┘       └────┬────┘
     │                 │                 │
     ▼                 ▼                 ▼
┌─────────┐       ┌─────────┐       ┌─────────┐
│  Node 1 │◄─────►│  Node 2 │◄─────►│  Node 3 │
│ (Rust)  │  Iroh │ (Rust)  │  Iroh │ (Rust)  │
│         │  p2p  │         │  p2p  │         │
└─────────┘       └─────────┘       └─────────┘
```

- **Connector Nodes** are Rust servers running this protocol. They join the Iroh p2p network and serve a web UI.
- **Users** authenticate to a node via the web UI. The node acts as their agent on the p2p network.
- **Data replication** happens over Iroh between nodes. If a user connects to a second node, their data syncs to it.

### Trust Model

A connector node is a **trusted agent** for its users — analogous to an email provider. The node serves the web UI, holds encrypted key material, and acts on the user's behalf. Users should only log in to nodes they trust (self-hosted, operated by a friend, community-run, etc.).

The system is **trust-minimizing, not trustless.** A malicious node operator who serves the web UI can exfiltrate key material — but the architecture deliberately limits what they can capture and makes compromise recoverable:

- A node holds **only one leaf key**, not the root key or any other node's keys.
- Each node has an **independent password** — compromising one node doesn't reveal credentials for any other.
- The parent key can **revoke** the compromised leaf, cutting off the attacker's authority.
- The attacker gains the ability to impersonate **one Identity node**, not the entire Identity.
- Every node has access to every Mask, but, if the mask derivation seed was decrypted on the compromised node, it can be **rotated** (the most serious consequence, but survivable).

This is neither trustless (you do trust each node with its own leaf key and any secrets it has decrypted) nor fully trusting (the node never holds the root key, can be revoked, and cannot compromise other nodes). The key tree architecture exists specifically to make node compromise a **bad, privacy-harming, but recoverable event** rather than a fully catastrophic one.

---

## Identity System: The Key Tree

A user's identity is a **tree of ed25519 keypairs** with hierarchical authority. The public key of the root node is the user's global identity.

### Structure

```
Root Key (K0) — the user's identity IS this public key
├── K1 (device/node key, created T1, signed by K0)
│   └── K3 (sub-key, created T3, signed by K1)
└── K2 (device/node key, created T2, signed by K0)
    └── K4 (sub-key, created T4, signed by K2)
```

### Rules

1. **Any key in the tree can authorize new child keys.** This makes it easy to add new devices or nodes.
2. **Parent always outranks child.** A parent key can revoke any of its children (and their entire subtree).
3. **Older sibling outranks younger sibling.** The parent knows birth order and signs it to all children, making it unforgeable. (Child A gets a record with Parent as a listed usurper, Child B gets a signature with "Parent" and "Child A" listed as potential usurpers, Child C gets a signed identity with "Parent",  "Child A" and "Child B" listed as potential usurpers...)
4. **When a child makes a new node, that node is passed up to parents**: So the root node should be aware of all of its descendants and the order in which they were added: this means that all new nodes should have every possible usurper listed with and impossible to remove from the identity. This means that older cousins also (broadly) outrank younger cousins.
4. **If the root disappears, children continue operating.** Any child can act as *a* root — spawning new children, interacting with the network.

### Designated Heir

A parent can sign a **priority statement** that overrides birth-order authority. This propagates to all (active, live) children: K0 can declare: *"K2 is my designated heir, not K1."* This allows a user to create a recovery node later and give it higher authority than older, potentially less-secure nodes. 

### Key Storage

- Each node generates and stores **only its own private key**, encrypted with the user's password on that node.
- **No private keys are ever transferred between nodes.** Only public keys and the chain of signatures (proving tree membership) replicate across the network.
- Each node has its own **independent password**. Nodes have no knowledge of other nodes' passwords. This limits blast radius: a compromised node only captures one password and one leaf key, not the user's credentials for every node.
- Encryption uses **Argon2** as the KDF to make offline brute-force attacks against the local key expensive.

### Adding a New Node

1. User is logged in on Node A (which holds a key that can authorize children — e.g., the root key K0).
2. User goes to Node B and initiates a connection.
3. Node B generates a fresh keypair (K1) locally and presents its **public key**.
4. The public key is transferred to Node A (QR code, copy-paste, or over Iroh).
5. On Node A, the user authorizes K1 — K0 signs K1's public key with the current family tree (and any designated heirs).
6. The signed authorization is sent back to Node B.
7. Node B now holds its own private key + the signed proof that K1 is a child of K0.
8. User sets a **local password on Node B** (independent of Node A's password) to encrypt K1's private key at rest.

### Threat Model

| Scenario | Outcome |
|---|---|
| Root key is online, child is compromised | Parent revokes child. Done. |
| Root key is gone, oldest child is compromised | Attacker wins by birth-order authority. User creates new identity. |
| Root key is gone, younger child is compromised | Older legitimate sibling outranks attacker. Safe. |
| Root key is gone, designated heir exists | Heir outranks all siblings regardless of age. Recovery works. |
| Node operator is malicious | Operator can exfiltrate decrypted keys. **Only use trusted nodes.** |

For a social network, the worst-case consequence of identity compromise is impersonation — annoying but not financially catastrophic. Users can create a new identity and re-establish relationships. This is an acceptable tradeoff for the portability and resilience benefits of the key tree model.

---

## Masks: Public-Facing Personas

The Identity (key tree) is a **private management layer** — it handles authentication, node management, and cross-node access. It never appears in public content.

A **Mask** is a public-facing persona that other people interact with. A single Identity can manage dozens or hundreds of Masks. Masks are cheap by design.

### Login vs. Identity vs. Mask

```
Identity (key tree, private, never public)
  "I Login to butts.node.place, which gives me access to l38f"
  │
  ├── Mask: "Curtis" (public persona, own profile, own content)
  │     └── posts, follows, profile history...
  │
  ├── Mask: "Corff Burblepunk" (separate public persona)
  │     └── posts, follows, profile history...
  │
  └── Mask: "Hats Ahoy" → later renamed "Hat Fan"
        └── post at T1: display name was "Hats Ahoy"
        └── post at T2: display name is now "Hat Fan"
        └── (same Mask pubkey — linkable to each other, but NOT to the other Masks)
```

- **From the outside, Masks ARE the identities.** Following, messaging, profile lookup — all happen at the Mask level.
- **The Identity-to-Mask link is private.** Outsiders cannot discover that "Curtis" and "Corff Burblepunk" are the same person.
- **Masks know their Identity.** The system can verify authorization internally.

### Key Derivation

Mask keypairs are **derived** from a shared **mask derivation seed** using a deterministic key derivation function:

```
mask_private_key = derive(seed, mask_index)
mask_public_key  = corresponding public key
```

- The **mask derivation seed** is generated when the Identity is created.
- The seed is encrypted and synced to all authorized nodes via the **Rettro sync protocol** (see Iroh Protocol Mapping below).
- Any authorized node can independently derive the same Mask keypairs — **no Mask private keys are ever explicitly synced.**
- Creating a new Mask is trivial: increment the index, derive, done.

### Why Derivation Matters

- **No key sync needed.** All authorized nodes derive the same Mask keys from the shared seed. The seed is a small secret (32 bytes), not a collection of private keys.
- **Rotation authority.** The Identity root key can mathematically prove it created a given Mask (by demonstrating the derivation). This makes the Identity the **undeniable authority** for Mask rotation and revocation.
- **Privacy preserved.** Given only a Mask's public key, you cannot reverse-engineer the Identity root key or the derivation seed.

### Operations & Authority

Mask operations follow the **same authority hierarchy** as the Identity tree. There are only two primitives:

- **Authorize** — create a new Mask, or rotate a Mask to a new key.
- **Revoke** — retire a Mask.

Every Identity in a user's tree can manage _every Mask that user controls_. 

Any Identity node can perform these operations — there is no root-only restriction. This preserves resilience: if the root key disappears, surviving children can still manage Masks.

When two Identity nodes issue conflicting Mask operations, the conflict is resolved by the existing hierarchy rules (parent > child, older sibling > younger sibling). **"Override" is not an operation** — it's a resolution rule that every node in the network applies independently when it encounters conflicting signed statements.

### Compromise Scenario

```
K0 (root)
├── K1 (compromised)
└── K2 (legitimate)

1. K1 maliciously rotates Mask M to a key it controls
2. K0 notices suspicious activity
3. K0 signs: "K1 is revoked"
4. K0 signs: "Mask M is rotated to new key Y"
5. Network sees both statements, applies hierarchy:
   → K0 outranks K1 (parent > child)
   → K1's rotation is invalid
   → K0's rotation is canonical
6. Nodes that temporarily accepted K1's rotation self-correct
   once K0's statements propagate (eventual consistency)
```

**Privacy tradeoff:** Rotation **reveals the link** between the Identity and the specific rotated Mask. This is accepted because:
- Rotation only happens during a compromise — already a crisis.
- Only the specific compromised Mask is linked; other Masks remain private.
- The alternative (no rotation authority) is worse.

If the compromise is severe enough (derivation seed itself leaked), the Identity generates a **new seed** and rotates all Masks. This is the "burn everything" scenario, but Masks are cheap — rebuilding is inconvenient, not catastrophic.

### Temporal Profile State

Each Mask's profile data (name, bio, avatar hash) is synced across nodes via the Rettro sync protocol. Entries carry timestamps, giving the profile a natural history.

When content is created, it references the Mask's public key and includes a timestamp. This enables:
- **"Who posted that?"** — look up the Mask's public key.
- **"What did they look like when they posted?"** — look up the Mask's profile state at that timestamp.
- **Name changes are visible:** A Mask that was "Hats Ahoy" at T1 and "Hat Fan" at T2 shows both names on the respective content, but both are clearly the same Mask (same public key).

### Discovery

Masks are discoverable via the same `pkarr` / Mainline DHT mechanism as any other public key. The Mask's public key is published to the DHT by whichever nodes are hosting it. Lookup works identically to the Identity discovery flow, but at the Mask level.

---

## Authentication

### Phase 1: Username + Password (Local Only)

- Users register with a username and password on a connector node.
- The password is used to encrypt/decrypt the user's key material locally. It is **never transmitted over the p2p network**.
- Password hashing uses **Argon2**.
- This is the simplest possible onboarding — no email, no phone, no external dependencies.

### Phase 2: Passkeys / WebAuthn (Planned)

- Passkey support as an additional (and eventually preferred) authentication method.
- Passkeys are ideal because the private key never leaves the user's device and the server only stores a public key credential — safe to replicate.
- Could serve as an independent backup of the user's root key.

### Phase 3: Recovery Helpers (Planned)

- Optional email verification for account recovery (self-hosted SMTP or pluggable provider — **no hard AWS dependency**).
- Seed phrase export of root key.
- Key export/import (QR code, file).
- Social recovery (M-of-N trusted contacts vouch for a recovery).

### Non-Goals

- **No mandatory external service dependencies.** A node operator should be able to run a fully functional node with zero cloud service accounts.
- **No centralized identity provider.** Identity is cryptographic, not tied to any server or service.

---

## Trust, Credibility, Interest, and Taste

For every other person in my network I keep four scores:

* **Trust** - my confidence that they are a real, distinct human, not a disposable bot.
* **Credibility** - my confidence in their judgement, about people and about accuracy in general.
* **Interest** - how relevant they, personally, are to me.
* **Taste** - how relevant their recommendations are to me.

The scores are genuinely independent. My dad is high Trust (I know him) but medium Credibility (poor opsec, low scam
literacy) and low Taste (too much fishing content). The Globe and Mail is high Trust and high Credibility (a
DNS-verified institution with journalistic standards) but only medium Interest. Gullible Gary is medium Trust (I have
met him) but very low Credibility (a parade of misinformation) and yet high Taste (he happens to follow good stuff).
Auteur X is only medium Trust (never met them) but very high Interest (they made something I love). Trust does not
imply Credibility, and Interest does not imply either.

But the four are **not peers.** Trust sits underneath the other three, and understanding why is the point of this
section.

### Why Trust comes first

In a p2p network identities are free: anyone can mint unlimited fake identities and link them however they like (the
classic **Sybil attack**). So any score that can be inflated by *making more accounts* is meaningless - the attacker
just manufactures whatever graph maximizes it. The one thing an attacker cannot fake is a vouch from a real human who
verified someone in the physical world ("I met Eve in person"). Those vouches are scarce.

Every other score is an aggregate over other people ("how many flagged this as a scam?", "who else liked this?"). The
moment you aggregate over people, the honest question is *how many real humans*, not *how many accounts* - and without
Trust that question has no answer. Trust is the denominator that turns a count of accounts into a count of humans. You
rarely read it directly; it is the weight that keeps every other score from being captured by a bot cloud. Get Trust
once and the others inherit its Sybil resistance for free.

### How Trust is computed

The tempting approach - "multiply trust along the best chain of vouches" - is exactly wrong. An attacker sets all the
edges among their own fakes to 100% (they own both ends, it is free), so a single vouch into their cluster propagates
undiminished to every fake behind it. Best-path makes each fake *clone* your trust.

Instead we use a **network-flow model** (the Advogato approach):

- **Vouching budget.** Each person has a fixed budget of trust to spread across people they have personally verified.
  This budget is the scarce resource an attacker cannot manufacture, and it is the *capacity* of their vouch edges.
- **Trust as shared flow.** My trust in a stranger is the flow that reaches them through the vouch graph, computed as
  **one joint flow to everyone at once** - not a separate calculation per person. This is the detail everything hinges
  on: under a single shared flow, a million fakes behind one vouch must *split* that vouch's capacity and each ends up
  with a trickle. (Computed per-person instead, each fake would independently receive the full value and the defense
  evaporates.) The result: the number of fakes I accept is capped by the capacity of the vouches *into* their cluster,
  no matter how many fakes there are.
- **Bounded horizon.** I only compute over the slice of the graph within a few hops of me (say 4), with trust fading
  each hop. This keeps the computation local (I never need the global graph, which also serves privacy) and it bounds
  my *lens*, not the network - Rettro can be millions of people; I just cannot personally vouch-path to all of them.
  Someone past my horizon is not "fake", just "not reachable through my web" - which is what non-web signals like DNS
  verification are for.
- **Deliberately simple.** Trust does not try to weight a vouch by how good the voucher's judgement is. (That would be
  Credibility, which is built *on* Trust - the dependency would be circular.) A careless friend who vouches for junk
  simply leaks their fixed budget into it, split across the junk. Everyone gets the same budget; that is the whole
  rule. We can refine this later, but Trust's correctness must never depend on the refinement.

Trust is a continuous number, but we also expose a simple **floor** for coarse gates ("below this, you cannot DM me or
appear in my feed") so features do not each have to reason about flow.

### The layer boundary: Trust flows down, never up

Credibility, Interest, and Taste all compute *over the Trust-weighted graph*, and the direction is strict:

- **Trust may weight the others (down - allowed).** Content from people I trust can rank higher; trusted follows can
  be suggested. This is the whole point of the substrate.
- **The others may never weight Trust (up - forbidden).** This is the rule that keeps Sybil resistance intact, and it
  is easy to violate by accident. In particular, **a follow is not a vouch.** Following someone is an Interest edge - a
  content subscription - and grants them zero Trust. All four combinations are normal: follow-and-trust (my dad),
  follow-but-don't-trust (a fun account I am watching speculatively), trust-but-don't-follow (a real person whose posts
  bore me), neither (a stranger). If a follow granted even a sliver of Trust, the attack writes itself: post fun
  content, harvest speculative follows from real people, and each becomes a scarce human vouch. Things that are cheap
  to elicit must never mint Trust.

**Signals carry the weight of the signaller, not the target.** If I follow `speculative.evil.ru` and Greg trusts that
*I* am real, then in Greg's feed my follow counts at Greg's-trust-in-me - a real human's worth of interest - even
though `evil.ru` itself gains no Trust at all. This is what stops "100 trillion lightbulb accounts" from drowning out
real people's interest signals: weight rides on the vouched-for signaller. Two guardrails make it safe:

- The weight is **bounded by Greg's trust in me and shared across everything I signal** - follow 10,000 things and
  each carries a ten-thousandth of my weight. One trusted human cannot be turned into a signal-laundering firehose.
- It is a **spotlight, not a transfer.** My interest illuminates `evil.ru` only for people who trust *me*, only while I
  keep following, and `evil.ru` still holds zero Trust of its own. It cannot re-spend my weight to reach people who do
  not trust me.

### The other three scores

- **Credibility** (medium stakes) is partly *earned*, not just vouched: it blends vouched credibility (propagating
  along trusted edges, and scoped by topic - good judgement about `#distributedSystems` is not good judgement about
  who is a bot) with an observable track record (did the things they called fake turn out fake?). Gaming it needs
  either a real track record or trusted edges, both already scarce.
- **Interest and Taste** (low stakes) are just a **recommender system** - collaborative filtering over the
  Trust-weighted graph, plus topic tags (boost `#computers`, bury `#fishing`). Worst case of a poisoned score is a
  boring feed, so these get to stay simple and loose; no Sybil hardening of their own, because they inherit Trust's.

### Privacy of the graph

A fully public trust graph is not actually a privacy win (and my mom might be hurt to see her low Credibility score).
The bounded horizon already means others only ever see a slice. On top of that, users control resolution and access:

- Viewers see **end scores only**, not how they were derived or who I personally added.
- Scores are **rounded** by access level - "close" contacts see finer detail (5%), "casual" ones coarser (25%),
  everyone else sees nothing.
- **Private nodes:** I can hide specific people entirely, excluded even from the calculations I share.
- **Public nodes:** I can make specific ones globally visible ("I trust the Globe and Mail").

### What actually makes this safe (and how we will check)

The flow model gives a real guarantee - fakes admitted are capped by the vouches into their cluster, for *any* graph
shape - but that guarantee is conditional on vouches being scarce, and **real people vouch carelessly all the time.**
No proof survives a false premise. So the load-bearing safety does not come from the metric being clever; it comes from
two things that hold even when careless vouches are abundant:

- **Low payoff.** Wire Trust into things where being wrong is cheap and reversible (feed ranking, bot floors), not
  into high-value irreversible powers. If winning Trust buys only some spam higher in a feed, gaming it is not worth
  the effort. This mirrors the identity model's stance on impersonation: annoying, not catastrophic.
- **Recoverability.** You cannot prevent a bad vouch in advance, but you can make its effect bounded, fading, and
  revocable the moment it is noticed.

Testing cannot prove any of this - Sybil resistance looks perfect until someone attacks, and a friendly beta of real
friends will never mint 10,000 fakes to show us the failure. So we build an **adversary-simulation harness** early and
run it hoping it *breaks*: generate an honest graph, inject fakes in the nastiest topology we can, and measure trust
extracted per attack vouch. It should stay flat as we add fakes; if it climbs, we have a bug (most likely the
per-person-vs-joint-flow mistake above). The harness also calibrates the knobs the theory is silent on - budget size,
horizon depth, fade curve, the feed/DM floor. It is a bug-finder and a dial, never our source of confidence.

---

## Data Layer

### SQLite Strategy

Each connector node maintains:

- **Node database** (`node.db`): Node configuration, known peers, replication state, network metadata.
- **Per-user databases** (`users/<pubkey>.db`): Each user's data lives in their own SQLite file. This is the unit of replication — when a user connects to a new node, their entire database syncs over.

### Why Per-User Databases?

- **Portability:** A user's identity and data is a single file. Easy to replicate, backup, export.
- **Isolation:** One user's data can't accidentally leak into another's queries.
- **Sync granularity:** Iroh replicates at the user level, not the node level. Only sync what's needed.
- **Offline-friendly:** A user's database is fully self-contained.

### Replication over Iroh

- User data is synced between nodes using the **Rettro sync protocol** (see Iroh Protocol Mapping below), not by replicating raw SQLite files.
- The per-user SQLite database is the local materialized view of synced data.
- Both nodes continue to sync the user's data bidirectionally as long as the user is active on both.
- When multiple nodes write to the same key, conflicts are resolved using **last-writer-wins by timestamp** for simple fields (name, bio, etc.). More complex data types can layer a CRDT library on top in the future.
- **Entry validation:** Every incoming sync entry is validated against the current key tree. Entries are stored **signed** so that they can be retroactively revoked if necessary.

---

## Iroh Protocol Mapping

Iroh provides composable protocols on top of its QUIC-based p2p connections, plus a discovery layer. Here's how each maps to Rettro:

### Rettro Sync Protocol → Identity Data & User Content

**Why not `iroh-docs`?** `iroh-docs` is a multi-writer key-value store where Authors sign entries with their own keypairs. However, it has **no protocol-level revocation** — once an Author has write access, their entries sync to all replicas forever. Since Rettro's key tree requires that revoked Identity nodes lose all authority, iroh-docs' trust model is fundamentally incompatible. A revoked node could keep writing garbage into the shared document indefinitely, and iroh-docs would happily sync it to every peer.

Instead, Rettro uses a **custom sync protocol** that runs over iroh QUIC bidirectional streams. This gives us control of the sync boundary:

**Architecture:**
```
Peer A ──iroh QUIC──► Rettro sync protocol ──validate──► accept/reject ──► local store ──► SQLite
                      (we control this)      (key tree)   (gate here!)      (clean)        (clean)
```

**Sync mechanism:** Nodes exchange **version vectors** (latest timestamp per author) to discover what each side is missing, then send individual signed entries. This is simpler than iroh-docs' range-based set reconciliation, but sufficient because the number of writers per user document is small (bounded by nodes in a key tree).

**Key tree sync** is handled as a special case — key tree entries (child authorizations, revocations, heir designations) are **self-authenticating** (each entry is a signed statement verifiable from the signature chain alone). The key tree syncs first and establishes the authority context for all other data.

**Entry validation:** Every incoming content entry is checked against the current key tree state. If the author's Identity node has been revoked, the entry is rejected at the protocol level — it never enters the local store. This is the critical advantage over iroh-docs, where filtering could only happen *after* data was already synced and stored.

For each user identity:
- The user's identity data (key tree, profile, content) is synced via the Rettro sync protocol.
- Each node in the user's key tree signs its own entries.
- Any non-revoked node can update data, and changes sync to all other nodes holding a replica.
- **Conflict resolution:** For simple fields (name, bio), we use **last-writer-wins by timestamp** among non-revoked authors. For more complex data in the future (e.g., collaborative content), we could layer a CRDT library like Loro on top.

### `iroh-blobs` → Large Content

Content-addressed immutable data, referenced by BLAKE3 hash. Used for:
- Profile pictures and media.
- Larger content payloads (posts with images, attachments).
- Sync entries store blob hashes as values — the actual data is fetched via `iroh-blobs`.

`iroh-blobs` is unaffected by the revocation model because blobs are immutable and content-addressed — there is no concept of "author" or "write access" at the blob level. A blob is just bytes identified by a hash.

### `iroh-gossip` → Real-Time Notifications

Epidemic broadcast messaging to topic subscribers (HyParView/PlumTree). Used for:
- Notifying followers that an identity's profile has changed.
- Real-time message delivery.
- Signaling that a sync is needed.

`iroh-gossip` is compatible with the revocation model because gossip is **ephemeral** — messages are broadcast and not persisted. Outbound gossip messages are signed so receivers can validate the author against the key tree and discard messages from revoked nodes. For private topics (e.g., DM signaling), per-topic encryption keys are rotated when a node is revoked.

### `pkarr` + Mainline DHT → Discovery (Liveness Signal)

The BitTorrent Mainline DHT via `pkarr` (Public-Key Addressable Resource Records) provides **decentralized, serverless identity discovery**.

- Each connector node **publishes** a signed record to the DHT for every user it hosts, keyed by the user's root public key.
- The record contains the node's current addresses (~1000 bytes max).
- Records **expire after a few hours** if not republished — this is a feature, not a bug. The DHT is a **liveness signal**: it answers "who is currently online and can serve this identity?"
- Nodes republish on a fixed schedule (hourly) as a background task.
- If all of a user's nodes go offline, their DHT record naturally expires, which is correct — there's nobody to serve the data.
- Anyone who has previously cached the user's identity data still has it. The DHT is only needed for first contact.

### Discovery Flow

```
Node X encounters public key K0
  → Check local cache (instant if we've seen this user before)
  → Miss? Query Mainline DHT for K0 via pkarr
  → Get back addresses of nodes currently serving K0's data
  → Connect to one of those nodes via Iroh
  → Sync K0's identity data via Rettro sync protocol (key tree, profile, content)
  → Cache locally
  → Future lookups are instant cache hits
```

Note what this flow already assumes: **you must know K0 to look it up.** pkarr resolves a key you name into addresses; it does not let you enumerate keys you have never heard of. So the DHT is a *lookup* channel, not an enumeration one - consistent with the graph-privacy model below.

### How people find each other (Discovery Channels)

Discovery is in direct tension with the trust graph's privacy, and the tension is not incidental: **discovering someone through a friend and mapping that friend's relationships are the same operation** (traversing their vouch edges). You cannot offer friend-of-friend discovery while hiding the friend-of-friend graph, because the discovery *is* the enumeration.

The vouch graph is the most sensitive dataset in Rettro - a real-world map of who has met whom - so we do **not** make it globally enumerable to power discovery. Instead, discovery runs on several channels, most of which never touch the graph:

- **Content and tags.** Peter posts under `#distributedSystems`; I find Peter by the content, no edge traversal needed. This is the primary channel and it keeps the network lively without exposing anyone's associations.
- **DNS-anchored identities.** I can find the Globe and Mail (or the Rettro seed account) directly by name, with no vouch path required. This is also how a brand-new user with zero vouches bootstraps a first trust edge.
- **Seed / directory accounts.** A curated on-ramp account (see cold-start) that follows and lists interesting real humans and masks, giving newcomers somewhere to start.
- **Opt-in discoverable overlay.** A *subset* of vouch edges that their owners deliberately mark discoverable. This is a strictly smaller, volunteered graph - "I trust the Globe and Mail" published on purpose - and it is the only graph strangers may traverse. The full trust graph stays private and still powers each user's own trust computation locally.

Two honest limits to design around:

- **Discovery quality tracks opt-in.** If few edges are made discoverable, the overlay is sparse and the network feels like a void. There is real pressure to make the discoverable overlay generous, and every step toward "discoverable by default" re-exposes the association map. This dial needs ongoing tuning, not a one-time setting.
- **Hidden edges leak through visible ones.** Hiding a few edges in an otherwise-public neighborhood does not hide them well: surrounding public structure often lets an outsider infer the hidden edge by correlation. Per-edge privacy is weakest exactly when most edges are public - which is the state generous discovery pushes toward. Sensitive edges (activist, source, survivor) should be understood as protected only when the *neighborhood* is private, not just the single edge.

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Language | **Rust** (stable, latest) | Currently 1.96.1 |
| Web framework | **Axum** | Carried over from old codebase |
| Async runtime | **Tokio** | Carried over from old codebase |
| P2P connections | **iroh** | QUIC-based, NAT-traversing p2p connections |
| Data sync | **Rettro sync protocol** | Custom protocol over iroh QUIC streams with key-tree validation |
| Content storage | **iroh-blobs** | Content-addressed blob storage (BLAKE3) |
| Real-time | **iroh-gossip** | Epidemic broadcast for live notifications |
| Discovery | **pkarr** / Mainline DHT | Decentralized identity lookup |
| Local database | **SQLite** via **sqlx** | Per-user local materialized views |
| Password hashing | **Argon2** | For encrypting local key material |
| Cryptography | **ed25519** | Identity keypairs (via Iroh's built-in key types) |
| Frontend | **Vanilla JS/CSS** | Carried over from old codebase (initially) |

### Removed Dependencies (vs. old codebase)

- ~~AWS SES~~ — no mandatory email provider
- ~~AWS SNS~~ — no mandatory SMS provider
- ~~Multi-tenant community model~~ — replaced by unified identity
- ~~Organization-scoped auth tables~~ — replaced by per-user databases

---

## Project Structure (Proposed)

```
rettro/
├── api/              ← OLD codebase (reference only)
├── node/             ← NEW crate: the connector node
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs           ← Entry point, Axum server, Iroh node setup
│       ├── config.rs         ← Node configuration
│       ├── identity/         ← Key tree, key management, signing
│       ├── auth/             ← Username/password, session management
│       ├── db/               ← SQLite connection management, per-user DB logic
│       ├── p2p/              ← Iroh networking, replication protocol
│       ├── api/              ← HTTP route handlers
│       └── error.rs          ← Error types
├── proto/            ← Shared protocol types (if needed for multi-crate)
├── web/              ← Frontend (JS/CSS)
└── PROJECT_PLAN.md
```

---

## Open Questions

- [x] ~~**Iroh integration depth:**~~ Resolved — custom Rettro sync protocol for data sync (iroh-docs is incompatible with revocable identity), `iroh-blobs` for content, `iroh-gossip` for real-time, `pkarr`/DHT for discovery.
- [x] ~~**Conflict resolution:**~~ Resolved — Rettro sync protocol validates entries against the key tree, rejects revoked authors, then applies last-writer-wins by timestamp for simple fields among valid authors. Complex data types can layer CRDTs (e.g., Loro) on top in the future.
- [ ] **What social features first?** Profiles? Posts/feed? Direct messages? Following?
- [ ] **Frontend approach:** Keep vanilla JS from old codebase, or adopt a lightweight framework?
- [ ] **Key tree serialization format:** How is the key tree stored and transmitted? Protobuf? CBOR? Custom?
- [ ] **Designated heir UX:** How does a user set up a recovery/heir key in a way that's easy to understand?

---

## Milestones

### M0: Skeleton
- [ ] New Rust crate (`node/`) with Axum + Tokio
- [ ] Basic config loading
- [ ] SQLite connection (node database)
- [ ] Health check endpoint
- [ ] Compiles and runs

### M1: Local Identity
- [ ] Ed25519 keypair generation
- [ ] Key tree data structures (create root, add child, serialize/deserialize)
- [ ] Username + password registration (Argon2-encrypted key storage)
- [ ] Login / session management
- [ ] Per-user SQLite database creation

### M2: P2P Foundation
- [ ] Iroh node boots alongside the Axum server
- [ ] Nodes can discover and connect to each other
- [ ] Basic "ping" protocol between nodes

### M3: User Data Replication
- [ ] Rettro sync protocol: version vector exchange over iroh QUIC streams
- [ ] Key tree sync (self-authenticating entries)
- [ ] Content sync with key-tree validation at the sync boundary
- [ ] User connects to a second node
- [ ] User's database replicates to the new node
- [ ] Bidirectional sync between nodes

### M4: Key Tree Operations
- [ ] Child key authorization (cross-node)
- [ ] Key revocation (parent revokes child)
- [ ] Sibling authority resolution
- [ ] Designated heir

### M5: Social Features
- [ ] User profiles
- [ ] Following / social graph
- [ ] Posts / feed
- [ ] Direct messages

### M6: Enhanced Auth
- [ ] Passkey / WebAuthn support
- [ ] Optional email verification (pluggable, no AWS dependency)
- [ ] Seed phrase key backup
- [ ] Key export/import
