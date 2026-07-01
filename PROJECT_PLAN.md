# Rettro — Project Plan

## Vision

Rettro is a **federated, distributed social network** built on the [Iroh](https://iroh.computer/) peer-to-peer network. Users connect to **connector nodes** — lightweight Rust servers that provide authenticated access to the p2p network. Each user has a durable, portable cryptographic identity that can roam between nodes.

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

A malicious node operator who serves the web UI can exfiltrate key material, just as any website can serve malicious JavaScript. This is an accepted limitation of the web trust model. The system does not attempt to be trustless — it aims to be *federated* with *portable identity*.

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
3. **Older sibling outranks younger sibling.** Birth order is determined by the *parent-signed creation timestamp*, making it unforgeable.
4. **If the root disappears, children continue operating.** Any child can act as *a* root — spawning new children, interacting with the network — but cannot claim to *be* the root.
5. **Conflicts resolve by hierarchy.** In a dispute between siblings, the older sibling wins. In a dispute between parent and child, the parent wins.

### Designated Heir

A parent can sign a **priority statement** that overrides birth-order authority. For example, K0 can declare: *"In the event of my disappearance, K2 is my designated heir, not K1."* This allows a user to create a recovery key later and give it higher authority than older, potentially less-secure device keys.

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
5. On Node A, the user authorizes K1 — K0 signs K1's public key with a creation timestamp.
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

### Identity vs. Mask

```
Identity (key tree, private, never public)
  "I am l38f, I log in and manage my nodes"
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
- The seed is encrypted and synced to all authorized nodes via `iroh-docs`.
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

Each Mask maintains its own `iroh-docs` Document with profile data (name, bio, avatar hash). Since `iroh-docs` entries carry timestamps, the profile has a natural history.

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

- User data is synced between nodes using `iroh-docs` (see Iroh Protocol Mapping below), not by replicating raw SQLite files.
- The per-user SQLite database is the local materialized view of the user's `iroh-docs` Document.
- Both nodes continue to sync the user's data bidirectionally as long as the user is active on both.
- When multiple Authors (nodes) write to the same key, `iroh-docs` keeps all entries. Our application layer resolves conflicts using last-writer-wins by timestamp for simple fields (name, bio, etc.).

---

## Iroh Protocol Mapping

Iroh provides three composable protocols on top of its QUIC-based p2p connections, plus a discovery layer. Here's how each maps to Rettro:

### `iroh-docs` → Identity Data & User Content

An `iroh-docs` Document is a **multi-writer key-value store** with efficient peer-to-peer sync. Each document is identified by a `NamespaceId` (a public key) and can have multiple **Authors** (each with their own keypair) writing to it.

**Sync mechanism:** `iroh-docs` uses **range-based set reconciliation** — peers recursively compare hash fingerprints of data partitions to efficiently discover what each side is missing. This is not a CRDT; it's a set-union protocol. When multiple Authors write to the same key, **all entries are preserved** (keyed by `(namespace, author, key)`). The application layer decides how to resolve conflicts.

For each user identity:
- The user's identity data (name, bio, avatar hash, key tree) is stored as an `iroh-docs` Document.
- Each node in the user's key tree is an Author with write access.
- Any node can update the profile, and changes sync automatically to all other nodes holding a replica.
- **Conflict resolution is our responsibility.** For simple fields (name, bio), we use **last-writer-wins by timestamp**. For more complex data in the future (e.g., social graphs, collaborative content), we could layer a CRDT library like Automerge on top, using Iroh as the transport.

### `iroh-blobs` → Large Content

Content-addressed immutable data, referenced by BLAKE3 hash. Used for:
- Profile pictures and media.
- Larger content payloads (posts with images, attachments).
- `iroh-docs` entries store blob hashes as values — the actual data is fetched via `iroh-blobs`.

### `iroh-gossip` → Real-Time Notifications

Epidemic broadcast messaging to topic subscribers (HyParView/PlumTree). Used for:
- Notifying followers that an identity's profile has changed.
- Real-time message delivery.
- Signaling to `iroh-docs` that a sync is needed.

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
  → Fetch K0's iroh-docs Document (name, bio, avatar, key tree)
  → Cache locally
  → Future lookups are instant cache hits
```

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Language | **Rust** (stable, latest) | Currently 1.96.1 |
| Web framework | **Axum** | Carried over from old codebase |
| Async runtime | **Tokio** | Carried over from old codebase |
| P2P connections | **iroh** | QUIC-based, NAT-traversing p2p connections |
| Data sync | **iroh-docs** | Multi-writer key-value sync (set reconciliation) |
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

- [x] ~~**Iroh integration depth:**~~ Resolved — use `iroh-docs` for data sync, `iroh-blobs` for content, `iroh-gossip` for real-time, `pkarr`/DHT for discovery.
- [x] ~~**Conflict resolution:**~~ Resolved — `iroh-docs` preserves all entries from all Authors; our application layer uses last-writer-wins by timestamp for simple fields. Complex data types can layer CRDTs (e.g., Automerge) on top in the future.
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
