# Ringtome — Project Plan

## Vision

Ringtome is a **distributed social network** built on the [Iroh](https://iroh.computer/) peer-to-peer network. 

Ringtome's aim is to provide a bunch of stupid horseshit from The Old Internet: IRC-style text chat, bulletin-board
style posting, geocities-style "simple website authoring", webrings, hit counters, webcomics, MIDI files, and
if we're feeling saucy maybe some mp3s. 

Users connect to **connector nodes** — lightweight Rust servers that provide authenticated access to the p2p network. 
Each user has a durable, portable cryptographic identity that can roam between nodes.

It's "lightly federated" - in ATProto or Mastodon, the fediverse operators need to build large, resilient monolithic
systems with uptime guarantees, backups, and a holistic view of their system's relationship with the whole network
(lest their reputation tank and their system get de-listed). 

The idea is that in Ringtome, your identity might live across several nodes at the same time - maybe you're running a node
on your PC, or a cheap VPS you set up, or a friend's PC. You might set up an emergency node on an old Raspberry PI. So long
as ANY of these devices are on the network, you're on the network. A public server node offers authenticated access to 
multiple identities, but a local node might simply protect a single identity behind a PIN code.

Ringtome works from a "private by default" nature - the idea is that 99.5% of the network is going to be bots or trolls,
and instead of trying to moderate them out of a public system in an automated fashion, (increasingly impossible)
you instead proceed by building out and explicitly modeling trust: you met Eve in person, so you know she's real,
she met Frank in person and so you're _pretty sure_ Frank is real, but only insofar as you trust Eve, and so on.
This is why identities are cheap and users are encouraged to run several - a main identity, a pseudonym for the
webcomic, a burner for the forum argument. Given that in a p2p network you can't trust that anybody isn't a cloud of
anonymous bots, it makes it much more _clear_ to users that they should not trust anybody if they, too, are empowered
to be a cloud of disposable identities.

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

- A node holds **only one leaf key per identity it agents**, never a root key or another node's keys.
- Each node has an **independent password** — compromising one node doesn't reveal credentials for any other.
- Any senior key can **revoke** the compromised leaf, cutting off the attacker's authority.
- The attacker gains the ability to impersonate **one node of an identity**, not the entire identity.
- A node that agents **several of a user's identities** necessarily knows they share an owner. A compromised or
  malicious node can reveal that linkage - the most serious privacy consequence of node compromise, and unrecoverable
  once out. Users who want an identity unlinkable even under node compromise should agent it from a separate node
  account (or separate node).

This is neither trustless (you do trust each node with its own leaf key and any secrets it has decrypted) nor fully trusting (the node never holds the root key, can be revoked, and cannot compromise other nodes). The key tree architecture exists specifically to make node compromise a **bad, privacy-harming, but recoverable event** rather than a fully catastrophic one.

**Be blunt about the web-UI boundary: a node that serves your client can *become* your client.** When you log into a
node's web UI, that node ships the JavaScript that holds your session, prompts for your password, and signs on your
behalf. A malicious one can therefore steal your password, sign statements as you, hide revocations from you, show
you fabricated trust state, coax you into publishing a private follow, or reset the monotonic memory that is supposed
to protect you from eclipse. This is the "trusted agent, like an email provider" model, stated at full strength - it
is acceptable *for a node you actually trust*, and it is why "only log in to nodes you trust" is a real security
requirement, not boilerplate. The strong guarantees elsewhere in this document (eclipse resistance via monotonic
memory, first-contact verification) hold for users on **self-hosted or trusted nodes, or a native/local client** -
they do **not** protect someone logging into a hostile node's web UI, because there the adversary is the client
itself. A future "dumb node, smart client" mode (native app, browser-extension signer, or passkey-mediated signing)
is the path to needing less trust in the node; v1 does not attempt it, and the product must not oversell its
trust-minimization to web-UI users.

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

The goal is a **total order on authority that any node can compute from local data alone** - no global view, no
synchronized clock, no online coordinator. This is what makes succession tolerant of partition and eclipse: two
conflicting statements can be ranked using only the statements themselves.

1. **Any key in the tree can authorize new child keys.** This makes it easy to add new devices or nodes.
2. **Seniority is the entire authority relation: any senior key can revoke any junior key, at any time.**
   Not just parent-over-child - *any* key that outranks another in the total order (rule 5) can revoke it. Seniority
   is not a mere tie-breaker for conflicting statements; it is the full descriptor of who-can-revoke-whom. (A parent
   can revoke its children because it is senior to them, not because parenthood is special.) This is what keeps
   revocation available when ancestors retire or disappear: as long as *any* key senior to a compromised key
   survives, the compromised key can be cleanly evicted.
3. **Each key carries a signed usurper list.** When a parent signs a child, it stamps the child with a
   **cumulative, append-only** list: the parent's own usurper list, plus the parent itself, plus every sibling the
   parent has *already* signed. So a parent signing children in sequence produces `A1: [R]`, then `B1: [R, A1]`, then
   `C1: [R, A1, B1]`. Entries can **never** be removed. A senior sibling never needs to know a junior one exists; the
   junior always carries the signed acknowledgment that it is junior.
4. **Authority is a key's full signed chain to the root, or it is nothing.** A statement presented without the
   complete chain of parent-signed authorizations backing every usurper entry is **invalid** - not low-priority,
   invalid. This blocks the obvious forgery: truncating your own lineage to hide a senior usurper sitting above you.
5. **Order is the rank-path, not wall-clock time.** To compare two keys, walk both up to their lowest common
   ancestor; they diverge into two of that ancestor's children; whichever child is senior (per rule 3's lists), that
   entire branch wins. Formally this is lexicographic order on the sequence of sibling-ranks from root to key. A
   brand-new child of the senior branch outranks a long-established child of the junior branch - that is correct and
   deliberate; birth *time* is not derivable under partition, branch seniority is.
6. **If the root disappears, children continue operating.** Any key can act as a root for its own subtree - spawning
   children, interacting with the network - and the rank-path order still totally ranks everyone without the root
   present.

**Consequence:** an honestly-built tree is *always* totally ordered, at any depth, across any partition, with no
tiebreaker needed - including cousins, who are ordered by their branches' seniority with zero global coordination.
(This is why the old "pass every new node up to the root" rule is gone: cross-cousin order is now derivable locally,
so the synchronization it required - which partition would have broken anyway - is unnecessary.)

### When Two Keys Cannot Be Ordered: Equivocation

Two keys are un-orderable **only** when, at their divergence point, neither sibling appears in the other's usurper
list. A key signing children in sequence always knows its own prior children, so it always orders them. Therefore the
*only* way un-ordered siblings arise is if **one key signed two children in two histories that were each unaware of
the other** - i.e., the same key equivocated. This is the sole case that needs a tiebreaker.

Crucially, equivocation is **not always malicious.** The identical graph is produced by an innocent accident:

- User runs `R` on a laptop, creates `A1` on a phone (`R` signs `A1: [R]`).
- Laptop dies; user **restores `R` from a backup taken before `A1` existed.**
- The restored `R`, unaware of `A1`, signs a recovery node `B1: [R]`.
- Now `A1: [R]` and `B1: [R]` exist - two children of `R`, neither acknowledging the other. Un-orderable.

A stale-backup restore (or the same key copied to two machines) is byte-for-byte indistinguishable from a malicious
equivocation. So the tiebreaker is not an exotic anti-attacker device; it is what stops an ordinary user's botched
restore from becoming a permanent split-brain.

**Resolution:** when (and only when) two keys are genuinely un-orderable, break the tie with a **fixed, immutable,
attacker-independent property** every node evaluates identically (e.g. lexicographically smallest pubkey). The goal
here is **convergence, not fairness**: every relying party must pick the *same* winner, even if it is not the "morally
correct" one. A split-brain is unrecoverable; agreeing on an arbitrary-but-consistent winner is recoverable, and
recovery is cheap because impersonation is the worst case (see threat model).

Note the tiebreaker is **grindable** - an attacker who intends to equivocate can pre-mine a vanity pubkey to win the
tie. This is acceptable: reaching the tiebreaker at all already means key compromise or duplication (a crisis), and
what the tiebreaker buys is convergence, not a security boundary. Grinding lets an attacker bias *which* branch wins;
it cannot manufacture a split-brain.

### Revocation Types: Retirement and Repudiation

A revocation is one statement type carrying a **disposition** that answers the question mechanism alone cannot:
*what happens to everything the revoked key already signed?* Both dispositions use the same propagation, the same
seniority rules, the same monotonic memory - a revoked key's server still physically holds the key material, so even
the friendliest departure must be a network-visible revocation. The dispositions differ only in the treatment of
history, and in who may assert them.

**Retirement Revocation** - "this key is closed, no prejudice."

- **All signed history is honored**, through a final sequence number in the key's statement chain. Posts, vouches,
  and - critically - **child authorizations** all stand. The subtree lives: chain validation asks "was the signer
  valid *when it signed*," so a retired key's descendants keep their full chains forever.
- **Self-issuable** (or by any senior). A retiring key honestly declares its own final sequence number, and that
  final word is trustworthy because the key is not adversarial.
- Backdating is blocked by the existing chain rules: a statement inserted "before" the retirement point means forking
  the chain, which is equivocation, detected and resolved as such.
- **Retiring the root works.** The identity born on Server A can leave Server A: the root retires, everything it
  built stands, and the senior-most surviving child (ideally the recovery key) becomes the effective top of the
  active tree. Migration off a first server is a routine act, not an identity-ending one.

**Repudiation Revocation** - "this key is hostile, quarantine it."

- **History after a cut-point is distrusted.** A compromised key can backdate signatures, so its own timestamps mean
  nothing; the repudiating senior asserts a conservative sequence number, and relying parties distrust everything the
  key signed after it. (Stored entries are already kept signed for exactly this retroactive filtering - see Data
  Layer.)
- **The subtree dies.** Child authorizations are signatures like any other and can be backdated, so none issued by
  the repudiated key can be trusted. Legitimate children caught in the blast are re-authorized from a surviving
  senior branch.
- **Issuable only by a senior key** - never self-issued. An attacker holding the key will not sign its own death
  warrant.

**Conflicts between dispositions** resolve by the ordinary seniority rules, with one note: a self-signed retirement
and a senior-signed repudiation of the same key can both exist (the "attacker eased out the door quietly" case). The
senior statement wins, and repudiation is the stricter claim - relying parties apply the quarantine.

### Recovery Planning

Structural seniority is fixed at signing time and cannot be honestly granted retroactively - a re-issued key with a
shortened usurper list *is* the equivocation attack, so there is no legitimate way to insert a senior key into an
existing tree. Identity durability therefore rests on a small amount of planning ahead, and the system should make
that planning happen by default:

- **Recovery key, minted at identity creation.** When an identity is created, the node generates a **recovery key as
  an early direct child of the root** and hands it to the user via the photo ceremony (a labeled QR photographed to
  the phone's camera roll - see The Cozyweb Surface, ceremony 1; file download as fallback). Because it is created first,
  it is structurally senior to every key added afterward - forever, with no propagation dependency. If the root and
  the daily-driver nodes are all lost or compromised, the recovery key outranks whatever survives.
- **Root key backup.** Users can export the root key itself (seed phrase, file, QR - see Enhanced Auth). A restored
  root outranks everything. The known hazard: restoring from a *stale* backup and then signing new children produces
  innocent equivocation (see above), which the tiebreaker resolves - convergently, though not necessarily the way the
  user hoped.

Authority statement types are **versioned.** Any future statement type that changes how relying parties rank keys
would make old and new clients rank differently - split-brain by version skew - so introducing one is a
protocol-breaking change by definition, gated behind a version bump.

### Recovery Flows: Passwords vs. Keys

Two failure modes wear the same "I'm locked out" face and must never share machinery. **Forgetting the node
password loses nothing cryptographic** - on an always-on node the leaf keys are sealed under the envelope key, not
the login password (see Key Storage), so the node still holds perfectly healthy keys and the user has only lost the
ability to prove themselves to *this node's web app*. That is a web-app problem. Actual key loss (dead node, lost
devices, compromise) is the rare case, and it alone runs the key-tree machinery.

**Flow A - forgot password (common): zero chain entries, zero new keys.** The recovery photo serves as the reset
*authentication factor*: scan the QR, the node derives the pubkey, confirms it is the identity's **designated
recovery key**, and resets the account password. The key signs a login challenge, never a statement; the tree is
untouched.

- **Only the recovery key is reset-eligible - this is load-bearing, not convenience.** The invariant: *presenting
  key K may grant at most K's own authority.* Access to a node is access to the keys that node holds, so
  any-tree-key-resets would let an attacker holding one compromised junior leaf walk up to the root-holding node,
  pass an "is this an Active member?" check, reset the password, and wield the root - converting a bounded leaf
  compromise into total takeover through the login layer, and turning revocation into a race the attacker wins.
  Authentication channels must respect the authority lattice or the lattice is decorative. An ordinary leaf is
  never reset-eligible, anywhere.
- **Even recovery-key reset is an escalation channel - the one deliberate one** (the root outranks the recovery
  key, and reset on the root's node wields the root). Every recovery credential in every system is definitionally
  an escalation channel; the design response is that the exception is singular, designated, and guarded by
  **node-local policy**: a cooling-off window ("reset completes in 24h; any logged-in session can cancel"), rate
  limits, and notification to the identity's other devices once gossip exists. Note the layering: the *protocol*
  forbids clocks because relying parties cannot share one, but a node's own login policy is node-local - the
  time-boxed override that the no-clock principle exiles from the key tree is perfectly legal here.
- **Per-identity scoping.** A node account may agent several identities; proof of one identity's recovery key
  grants access to *that identity only* (the reset re-homes the proven identity into a fresh or proven-only
  account), or a stolen photo for one pseudonym would breach the authority and linkage boundaries of its siblings.
- Phase 3's optional email tokens are a later *convenience* for this same flow; the photo-as-factor means Phase 1
  ships password reset with no email infrastructure at all.

**Flow B - actual key loss (rare): the tree machinery, ending in photo rotation.** At a fresh node: scan the QR;
the recovery key authorizes **its successor recovery key first** (see designation, below), then the new device
key; repudiate whatever was lost or hostile; the old recovery key **self-retires** with anchors at its final head.
Retirement seals the old photo into a souvenir - everything it legitimately did (including authorizing the new
branch) stands; anything signed beyond its anchors is invalid - which matters because the scan just exposed its
seed to the scanning device. Each recovery consumes and reissues the artifact ("Your spare key worked! Here's a
fresh one - take a picture. The old photo won't work anymore."), shrinking the skeleton-key window to
until-first-use. **Recovery never mints a new identity**: the identity *is* the root pubkey; a "fresh start" would
orphan every follow, vouch, and page. New keys in the same tree, always.

**Designating "the" recovery key.** v1 rule: the **leftmost spine** - the recovery key is the root's first child
by construction (rank `[0]`), and because a retiring recovery key authorizes its successor *first*, the current
recovery key is always the unique Active key on the all-zeros path (`[0]`, `[0,0]`, ...). Derivable from pure tree
structure, zero new format; fragile only in that Flow B's mint order is a convention that must be kept loudly.
Graduation path: an additive `role` attribute on `authorize` (passes the ignorability test - an old reader treats
the key as ordinary and *fails closed* on reset eligibility; ranking is untouched), natural to add when Flow B is
implemented. A future relaxation exists if ever needed - "reset with any key strictly senior to everything the
node holds" is escalation-free by the invariant - but "only the spare-key photo unlocks you" is the v1 story a
user can hold in one sentence.

### Key Storage

- Each node generates and stores **only its own private key**, never a root key or any other node's key.
- **No private keys are ever transferred between nodes.** Only public keys and the chain of signatures (proving tree membership) replicate across the network.
- **Encrypt the key, not the database.** The per-user SQLite database is a mostly-public materialized view (public
  chains are public by definition; private-chain payloads are *already* ciphertext), so full-DB encryption
  (SQLCipher etc.) is the wrong tool - it taxes a public view to protect one small secret. Instead the leaf private
  key is stored as a **small, separately-stored, envelope-encrypted key file** (more like `~/.ssh/id_ed25519` than a
  DB row). Keeping it out of the DB is deliberate: the DB stays safe to back up and replicate freely, and the one
  genuine secret is handled directly.
- **The envelope key must be readable unattended on boot** - this is a hard requirement, not a preference. Network
  resilience demands nodes be **trivially restartable** (a node in a bad environment may reboot several times a day
  and must come back *signing* with no human present), so **no human secret can be required at boot.** Autonomous
  restart and password-on-boot are mutually exclusive, and autonomous restart wins for any node meant to stay live.
  The envelope key therefore comes from **ambient machine state**:
    - **Default: an env var or `0600` file** the process reads on boot (systemd unit, Docker secret, `.env`) - the
      same way every always-on service handles at-rest secrets. Reboot, read, decrypt leaf key, resume signing.
    - **Hardening: OS keychain / DPAPI / Secret Service / TPM** - same unattended-boot behavior, but the envelope
      key is machine-bound so a *copied disk image or backup* does not carry it. A strict upgrade over the env var
      against the leaked-artifact threat; identical autonomous-restart behavior.
- **What this protects, honestly.** Both sources preserve autonomous restart and cover the **separated-artifact**
  window (leaked `.db` / data-dir backup that does *not* include the env var or keychain entry). Neither protects
  against an attacker who owns the running machine or grabs a *full* machine image - but that is already the threat
  model's accepted case ("a malicious node can exfiltrate decrypted keys"), so no claimed guarantee is lost.
- **Opt-in exception: lockable personal device.** On a device you *deliberately* want inert when you are away (a
  laptop), the envelope key can be **password-derived (Argon2 KDF)** so the key stays locked until you log in. This
  trades away autonomous restart *on purpose* - it is only for nodes not trying to stay live, and is never the
  default.
- Each node's at-rest protection is **independent** - compromising one node yields one leaf key and, at most, one
  password or machine secret, never credentials for any other node.

**Node login is a separate concern from key encryption.** Two distinct jobs, easy to conflate:

- **Login (authentication):** a user logs into the node's web UI with username + password to prove they may act as
  their identity on this node. This uses **Argon2 as a password hash** - store a salted hash, verify on login -
  exactly like any web app, independent of anything cryptographic. Login establishes a session; the session
  authorizes the app to use the **envelope key** to decrypt that user's leaf key and sign on their behalf.
- **Key encryption (at rest):** the leaf key is decrypted by the *application* with the *envelope key* (above),
  **not** the login password.

So the password gates *access*; the envelope key does the *decryption*. On an **always-on node** (the default) these
stay fully separate: Argon2 hashes the login password, the machine reads the envelope key unattended on boot, and the
node signs while no one is logged in. Only on the opt-in **lockable personal device** are they fused - the login
password doubles as the Argon2 KDF for the envelope key - which is exactly what makes that device unable to restart
unattended.

### Adding a New Node

1. User is logged in on Node A (which holds a key that can authorize children — e.g., the root key K0).
2. User goes to Node B and initiates a connection.
3. Node B generates a fresh keypair (K1) locally and presents its **public key**.
4. The public key is transferred to Node A (QR code, copy-paste, or over Iroh).
5. On Node A, the user authorizes K1 — K0 signs K1's public key with the current family tree (the cumulative usurper list).
6. The signed authorization is sent back to Node B.
7. Node B now holds its own private key + the signed proof that K1 is a child of K0.
8. User sets a **local password on Node B** (independent of Node A's password) to encrypt K1's private key at rest.

### Threat Model

| Scenario | Outcome |
|---|---|
| Any senior key survives, junior key compromised | The surviving senior repudiates the compromised key (seniority, not parenthood, grants revocation authority - rule 2). Clean eviction, regardless of whether the root or the attacker's parent is still alive. |
| Senior-most surviving key compromised | Attacker holds the top of the derivable order; no surviving key outranks it, so nobody can revoke it. User must build a new identity. This is the genuine worst case. |
| Root gone, recovery key survives | The recovery key, minted as an early child at identity creation, is structurally senior to every later key. The user brings it online and it can repudiate anything junior. |
| Compromised/duplicated key equivocates | Detected as un-orderable siblings; resolved by the deterministic tiebreaker. All honest relying parties converge on the same winner (safe, not necessarily fair). |
| Node operator is malicious | Operator can exfiltrate the one leaf key that node holds (and any secret it has decrypted). Bounded to one node; **only use trusted nodes.** |

**Residual risks we do not fully close** (named honestly rather than papered over):

- **First-contact eclipse.** A brand-new relying party with no prior memory of an identity, fed a lie in isolation,
  has nothing to detect the lie against. Monotonic memory (below) protects *returning* relying parties but not
  first contact. An attacker who controls a fresh peer's entire view can show it a stale/forged authority state.
- **Concurrent-cousin resolution is safe, not fair.** The tiebreaker guarantees everyone agrees; it does not
  guarantee they agree on the key the user would have *wanted*. Grinding can bias which branch wins.

For a social network the worst-case consequence of identity compromise is **impersonation** - annoying, not
financially catastrophic. Users can build a new identity and re-establish relationships. The design goal is therefore
**convergence + recoverability**, not prevention: make cheating undeniable and every failure survivable, rather than
attempting (impossible) partition-and-eclipse-proof election of the "correct" successor.

### Freshness: Monotonic Memory and the Revocation Ceiling

Ranking conflicting statements solves *ordering*; it does not solve *freshness* - "has this key been revoked since I
last checked?" Absence of a revocation is unprovable in an open network (an eclipser simply withholds it). Two
primitives blunt this without requiring an always-online authority:

- **Monotonic memory (cheap, always on).** Each relying party remembers the highest-authority statement it has *ever*
  seen for an identity and never silently accepts a lower one. Eclipse can *delay* new information but cannot make a
  relying party *forget* a revocation it already saw. This converts eclipse from "grants stale authority" into merely
  "delays first delivery" - and it is essentially free. (It protects returning parties, not first contact; see
  residual risks.)
- **Revocation ceiling (opt-in, per-operation).** For the rare high-stakes operation, a relying party may *require* a
  recent positive attestation from a superior key rather than trusting "valid until revoked." This flips eclipse to
  fail-*safe*: withholding the fresh attestation denies the action instead of granting it. The cost is that it needs a
  superior online, which fights "root can vanish" - so it is a per-operation dial, off by default. Ordinary social
  actions stay long-lived and fail-open (surviving an offline root); only the few dangerous operations opt in.

Propagating revocations **through the trust graph** (rather than random DHT peers) further raises the bar: eclipsing
someone across many trust-weighted paths is far harder than across a handful of random peers. The trust substrate
doubles as an eclipse-resistance layer for authority propagation.

---

## Running Multiple Identities

There is exactly **one identity primitive** - the key tree. A "persona" is not a protocol concept; it is what a
client calls one of the several identities it manages. Users are expected and encouraged to run more than one:

```
Node account on butts.node.place (username + password, local to that node)
  │
  ├── Identity: "Curtis" (own key tree, own profile, own content, own trust position)
  │     └── posts, follows, vouches, profile history...
  │
  ├── Identity: "Corff Burblepunk" (a completely separate key tree)
  │     └── posts, follows, profile history...
  │
  └── Identity: "Hats Ahoy" → later renamed "Hat Fan"
        └── post at T1: display name was "Hats Ahoy"
        └── post at T2: display name is now "Hat Fan"
        └── (same root pubkey — its history is linkable to itself, but not to the other identities)
```

- **One login, many identities.** A node account (see Authentication) can agent any number of identities: one local
  password, several leaf keys, a persona switcher in the UI. Creating a new identity is two keygens and a signature
  (root + recovery key), cheap enough to be disposable.
- **No linkage exists anywhere.** Two identities share no keys, no records, no cryptographic relationship of any
  kind. There is nothing connecting "Curtis" and "Corff Burblepunk" - not a hidden record, not a commitment, nothing
  to leak. The only places the linkage exists are the node accounts that agent both (see Trust Model) and the user's
  own head.
- **Each identity carries its own everything.** Its own succession machinery, recovery key, trust position, vouches,
  and reputation. A pseudonym starts from zero and earns its own name - vouches made for your main identity do not
  transfer, because a transfer would *be* the link.
- **Voluntary linkage is a cross-signature.** To prove two identities share an owner, publish a statement signed by
  both roots ("I am also X"). Nothing needs to be pre-arranged at creation time.

**The promise, stated plainly:** separate identities are **pseudonymous from one another, not anonymous.** No
observer, crawler, or platform-level query can connect them from protocol data - there is no protocol data connecting
them. What *can* connect them: the nodes that agent or front them (below), and the old-fashioned channels no protocol
controls - writing style, posting schedule, what you talk about. Users should hear this up front, not discover it.

### Temporal Profile State

Each identity's profile data (name, bio, avatar hash) is synced across its nodes via the Ringtome sync protocol.
Entries carry timestamps, giving the profile a natural history.

When content is created, it references the identity's root public key and includes a timestamp. This enables:
- **"Who posted that?"** — look up the identity.
- **"What did they look like when they posted?"** — look up the profile state at that timestamp.
- **Name changes are visible:** an identity that was "Hats Ahoy" at T1 and "Hat Fan" at T2 shows both names on the
  respective content, but both are clearly the same identity (same root pubkey).

### Display Names and Contact Names

Three layers refer to an identity, in decreasing forgeability and increasing personal trust:

- **The identicon** (derived from the root pubkey) is the true, unforgeable identity - it never changes and cannot
  be copied.
- **The display name** is a *self-claim*: mutable, unverified, in the public profile, synced to followers. It always
  shows, because even with zero other data, seeing that an identity claims to be "FART DRAGON" is a useful first
  hook. Change it and followers see the change on next sync. (The name is a **last-writer-wins (LWW)** field: when two
  of your own nodes set it at different times, the later timestamp wins, so all replicas converge on one value; the
  chain of past writes doubles as the name history. LWW is used throughout for simple scalar fields where overwriting
  is the intent - see Data Layer.)
- **The contact name** is *your* private annotation - a local label you assign, stored on your private chain,
  **never synced to anyone.** Like saving someone in your phone under a name that helps *you* remember them. It
  overrides the display name in your UI.

Render rule: the contact name wins when set, but the self-claim stays visible on expand - `Dave (claims "FART
DRAGON")` - so you keep the joke, and you can still notice when someone changes their public presentation.

**Contact names are the anti-impersonation tool, because they bind to the root, not the name.** The costume attack
(someone copies a friend's display name and avatar under a different root) fails outright: an impostor can copy the
name "Dave," but cannot become *your* "Dave," which points at a specific root. So the UI cue is: an identity you have
saved renders with a "known contact" marker; an identity merely *claiming* a familiar display name does not. The safe
path (save the people you actually know) is also the natural one, and the *absence* of the known-contact marker on a
familiar-looking name is the warning.

Two constraints:

- **Contact names sync within your identity, never outside it.** They live on the private chain, so they replicate
  across all *your own* nodes (save someone as "Dave" on your phone, they are "Dave" on your laptop) but never cross
  the inter-identity boundary to followers, fronting nodes, or the public - like everything private, "private" means
  *which sync boundary*, not *stored in one place*. Consequently, name *suggestions* for a stranger ("who is this?")
  may be drawn only from aggregated **public display names** across the trust graph ("the roots you trust mostly
  render this identity as 'Curtis'"), never from anyone's private contact names. A convenience feature must not
  puncture the private-chain guarantee.
- **Contact-name collisions are local and yours.** Nothing stops you saving two roots as "Mike"; the client should
  warn, but there is no global namespace to police - which is precisely why contact names have no squatting or
  scarcity, unlike index names.

Contact names are adjacent to vouching (both are "I have personally pinned this root as someone specific") but kept
separate: you can save a public figure you have never met, and vouch for a real human you never bothered to save.
The UI may offer them together, but they are distinct gestures.

### Hosting and the Colocation Problem

pkarr records are public metadata: anyone can query a batch of pubkeys and **cluster identities by their address
sets.** Two identities consistently served from the same addresses belong to the same person, with high confidence,
for free. An identity's unlinkability is therefore bounded by **the crowd of the nodes serving it** - colocation on a
node hosting 500 users says almost nothing; colocation on a personal Raspberry Pi with one user says everything.

The design lever is that **serving requires no keys.** Content is signed and blobs are content-addressed, so any
cooperating node can replicate and serve an identity's public data without any ability to author as it. This splits
the roles:

- **Authoring** happens wherever the identity's leaf keys live.
- **Serving/fronting** is delegable: the pkarr record points at whichever nodes *serve* the identity, and those can
  be large multi-tenant community nodes where the crowd is big. Different identities can front through different
  nodes, keeping their address sets disjoint. The personal node authors and pushes over p2p sync; well-populated
  nodes face the public.

Guidance to make explicit in the UI: **fronting all your identities from a single-user personal node publicly links
them.** Users running the celebrated self-host setup (the PC, the cheap VPS, the emergency Pi) should front
identities they want unlinked through community nodes, or accept the linkage.

Honest limits: fronting through big nodes defeats address clustering, not everything. Timing correlation (identities
online in the same windows, posting seconds apart) accrues to any patient observer regardless of hosting; the
fronting nodes themselves learn which identities one origin pushes to them (they become trusted parties for that
link); and stylometry needs no network access at all. This is why the promise is pseudonymity, not anonymity.

### Rehosting Policy: Pull, Not Push

Anyone *can* serve any identity's content - but no node is obligated to serve anything. If any identity could walk up
to any node and say "rehost this for me," attackers distributing CSAM or hate speech would reliably turn the whole
network into loud, nasty rebroadcasters. So replication is **demand-driven**: a node fronts an identity because
someone accountable *on that node* asked for it, never because the identity requested it.

The mechanism is the concepts we already have, chained:

- **Trust** gates who gets an account on a node (the operator's admission policy).
- **Follow** is the demand signal: when a node's own users follow an identity, the node fronts it.
- **Serving** is allocated only along that demand. Nobody can *push* content onto a node; they can only be *wanted*
  onto it.

Per-node policy dial: **closed nodes** front only what their users follow. **Open nodes** may accept unsolicited
fronting as a public service, with per-source quotas so they make poor amplifiers - and can tighten to follow-driven
mode if burned.

Two consequences worth stating now:

- **A serving-follow is public.** If your follow causes your node to front an identity, that fronting appears in
  pkarr records. The UI must distinguish "follow quietly" from "follow and help host" or users will leak interest
  they meant to keep private.
- **This bounds operator liability.** A node operator's exposure is limited to what their own accountable users
  pulled in - a defensible position in a way "we rebroadcast whatever arrives" is not.

---

## Authentication

### Phase 1: Username + Password (Local Only)

- Users register with a username and password on a connector node.
- The password is used to encrypt/decrypt the user's key material locally. It is **never transmitted over the p2p network**.
- Password hashing uses **Argon2**.
- This is the simplest possible onboarding — no email, no phone, no external dependencies.
- A node account can agent **multiple identities**: one login decrypts the leaf keys of every identity the user has
  attached to that account, and the UI offers a switcher. The account-to-identities mapping is local to the node and
  never leaves it.
- **Password reset** is the recovery photo used as an authentication factor - recovery-key-only, per-identity
  scoped, cooling-off window; see Recovery Flows: Passwords vs. Keys in the Identity System section.

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
  my *lens*, not the network - Ringtome can be millions of people; I just cannot personally vouch-path to all of them.
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

## The Identity-Managed Append-Only Log (IM-AOL)

The IM-AOL is the data structure underneath everything: the key tree, revocations, posts, follows, and profile state
are all entries in signed append-only logs. Retirement's "final sequence number," repudiation's "cut-point,"
equivocation detection, the sync protocol's version vectors, and the rebuild-the-SQLite-view story all resolve to
properties of this one structure.

### Chains: One Per Key, Per Service

Every key in an identity's tree maintains its own set of **chains**, one per service:

```
Key K1 (the leaf on your VPS) maintains:
  ├── identity-public chain    (key-tree statements: authorizations, revocations)
  ├── identity-private chain   (encrypted; node-management data, synced only to own nodes)
  ├── posts chain              (public content)
  ├── public-follows chain     (serving-follows, vouch publications)
  ├── private chain            (encrypted: quiet follows, trust edges, settings)
  └── ...future services get their own chains
```

- **Single-writer:** a chain is appended to only by its own key. Your phone's key writes to your phone's chains;
  your VPS's key to the VPS's. No coordination, no consensus, works fully offline.
- **Identity/content separation:** the identity chains are tiny and security-critical - every relying party fetches
  them to validate authority, without wading through post history. Content chains are bulky, low-stakes, and fetched
  only by followers and fronting nodes.
- **Public/private separation is per-chain, not per-entry:** private entries live on their own encrypted chains
  rather than encrypted-inline on public ones, so the count and timing of your private activity is not public
  metadata, and public chain continuity is verifiable without seeing gaps.

### Hash Chaining

Each entry is `{seq, prev_hash, type, timestamp (claimed), payload or blob hash, signature}`. Sequence numbers are
dense (no gaps); `prev_hash` is the hash of the previous entry; the signature covers everything, `prev_hash`
included. This buys three properties:

- **The past is welded shut.** Altering any historical entry changes its hash, which breaks the signed `prev_hash`
  in the next entry, and so on - tampering forces re-forging everything after the point of change, which every
  holder of any later entry will detect.
- **The head vouches for the whole history.** Trusting the hash of entry 812 transitively pins every byte back to
  entry 1. One small commitment seals an entire prefix - this is what makes snapshots and revocation anchors work.
- **Forks are self-proving.** The only way to rewrite is to sign a *second* entry at the same `(chain, seq)` - and
  anyone holding both holds portable, checkable proof of equivocation. A fork on any single chain condemns the key
  (it proves duplication or compromise), feeding the identity layer's equivocation rules.

### Custody vs. Authorship

**Only K1 can append to K1's chains - but everyone can hold them.** Being one of an identity's nodes means
continuously replicating **all** of that identity's chains; being a follower or fronting node means the same for the
public chains. Every copy of a signed chain is exactly as authoritative as any other; there is no "original."

This is what makes device loss survivable. Phone in the toilet: the phone's *key* can never sign again, but its
chains live on every replica. A surviving senior key retires the drowned key (final seqs = the highest any replica
holds), the chains freeze - permanently valid, permanently served - and the new phone gets a fresh key with fresh
chains. **The identity's history is the merged view of all its keys' chains**, recomputed by every reader from
replicas; losing a device costs a keypair, never a history.

**The genuinely fragile window: authored-but-never-replicated entries.** Posts written offline that never synced
die with the device - irreducible in any offline-first design. Mitigations: **eager push** (a node offers new
entries to every reachable peer immediately, shrinking the window to seconds-while-connected) and an **unsynced
indicator** (the authoring device knows which of its entries no peer has acknowledged - surface it like an unsaved
document). Before retiring a lost key, survivors run a **straggler sweep** - gossip for entries above their known
frontiers - so retirement does not guillotine entries sitting one hop away.

### The Ordering Contract

1. **Within a chain, order is cryptographic fact** - dense sequence numbers, hash-chained.
2. **Across chains, order is advisory.** Entries carry claimed wall-clock timestamps used for display interleaving
   and simple LWW state; timestamps are claims, not facts, and **nothing security-relevant may depend on them.**
3. **The one exception: hash anchors.** An entry may embed the hash of another chain's entry, which verifiably
   proves "that entry existed before this one" (you cannot hash what does not exist yet). Anchors are the only
   trustworthy cross-chain causal facts in the system, and the only ones any mechanism may rely on.

**Concurrent writes never conflict at the log layer.** Two keys writing "simultaneously" write to different chains -
both entries simply exist. Conflicts exist only at the *semantic* layer, where each data type declares its merge
rule: authority statements resolve by rank-path (never time); simple state (bio, display name) resolves by LWW on
claimed timestamps with a deterministic tiebreak, since the stakes are cosmetic and convergence is what matters;
additive content (two posts) does not conflict at all. Richer future types bring their own merge rules (CRDTs) to the
same conflict-free substrate.

### Anchored Revocations

A revocation statement (either disposition) carries, for **every chain of the affected key**, a
`(chain_id, seq, head_hash)` triple. The hash - not just the seq - is load-bearing: it pins the exact entry and,
transitively, the entire prefix beneath it. A revocation is a **closing seal across the whole bundle of chains**.

- **Retirement:** the key anchors its own true final heads. Everything in the anchored prefixes is honored history;
  anything claiming to sit beyond an anchored head is invalid, and anything claiming to sit under one but outside
  the anchored prefix requires a fork - self-proving equivocation.
- **Repudiation:** the senior anchors the frontier it has seen - a conservative boundary. Everything within the
  anchored prefixes is trusted; everything beyond or on any fork is quarantined **regardless of claimed timestamp.**
  The attacker cannot backdate around the seal: inserting an entry "before" the cut means rewriting a hashed prefix
  (impossible) or forking below the head (self-incriminating). The anchor converts "distrust everything after time
  T" (unenforceable) into "distrust everything not in this exact hashed prefix" (mechanically checkable) - it is
  what makes repudiation implementable. The straggler sweep applies here too, as the emergency allows: gossip for
  missing entries before signing, so legitimate unsynced entries are not needlessly quarantined.

### Open Items

- **Deletability: split headers from content from day one.** Chains store entry headers + blob hashes; content
  lives in droppable blobs (`iroh-blobs`). "Delete" = tombstone entry + drop the blob: chain integrity survives
  (headers remain), content is genuinely gone from cooperating nodes. The *fact* of a post at seq 41 is permanent;
  its content is not. Also keeps chains tiny. Retrofitting this split later is a protocol break, so it is v1.
- **Blob availability must not gate chain validity.** An entry whose blob is unfetchable (dropped, never shared)
  still validates as a chain link - validation is signatures and hashes only; fetching is best-effort.
- **Snapshots.** Replaying years of entries to materialize state is the classic cost of this architecture. Signed
  "state as of seq N" checkpoints solve it; not needed for v1, but the entry format should reserve room.
- **Fork aftermath.** After the tiebreaker picks a winning fork (the innocent stale-backup case), the losing fork's
  entries are invalid. The client should offer to re-sign that content onto the winning chain as new entries, or
  the recovery silently eats the user's posts. Needs specifying before the recovery UX ships.
- **Device-attribution metadata.** Chains are per-key and keys are per-device, so a patient observer can see which
  device authored what. Same honesty class as the timing-correlation caveats in Hosting.

---

## Canonical Encoding, Signature Domains, and Versioning

This is foundational, not a late detail: the byte representation of an entry *is* what gets hashed, signed,
chain-linked, and anchored. If two implementations disagree about how a logical entry becomes bytes, they compute
different hashes for the "same" entry - and a legitimate entry looks like a forgery, or two nodes "converge" on
byte-different state that no longer verifies. Changing any of these rules after data exists breaks every prior
signature and snaps every hash chain, so they are decided now.

### The core rule: hash and store the author's original bytes; never re-serialize

The signed, hashed object is **the exact serialized bytes the author first produced.** Those bytes travel the network
verbatim; every node hashes and verifies *the bytes it received*, and stores them unchanged. **A node MUST NOT
re-serialize an entry it intends to hash, forward, or store** - re-encoding is permitted only for ephemeral local use
(display, indexing) whose output never re-enters the log. This single rule makes serialization determinism a
non-issue by construction: canonicity only matters when two parties independently encode the same object, and here
there is only ever one encoding - the author's - which everyone copies. It also makes additive evolution safe: an old
node that cannot interpret a new field still forwards the *original bytes* intact, so newer nodes see the field and
the hash still matches.

### Format: canonical CBOR

Entries are encoded as **deterministically-encoded CBOR** (RFC 8949 §4.2: sorted map keys, shortest-form integers,
no indefinite-length items). CBOR was chosen because it is the one widely-supported, cross-language (IETF standard,
implementations everywhere, the substrate under COSE/WebAuthn) format that targets *both* schema evolution
(self-describing, old readers skip unknown fields) *and* specified deterministic encoding. Its determinism is
defense-in-depth behind the store-original-bytes rule: the rule is the primary guarantee, CBOR's canonical mode is
the belt to its suspenders if a bug ever causes a re-encode. (postcard was rejected for tying the ecosystem to one
language's serializer; protobuf for making canonicity an explicit non-goal.)

- **Strings are NFC-normalized** before encoding, so "the same" text is never two different byte sequences.
- **Unknown types/fields are carried forward** verbatim, never dropped - this is what makes old nodes safe to run
  against newer data.

### Hash: BLAKE3-256

All hashing - entry hashes, `prev_hash` chain links, revocation anchors - uses **BLAKE3, 256-bit output (32 bytes)**.
This matches `iroh-blobs`, which is already BLAKE3-content-addressed, so one hash algorithm covers the whole system
(entry chains and blob refs alike) rather than two side by side. BLAKE3 is fast (parallel/SIMD, faster than SHA-2),
cryptographically strong, and its native `derive_key` / keyed mode is a clean primitive for the signature-domain
separation below. The hash is a **versioned parameter** (recorded via the version tag), not a baked-in constant, so a
future entry version could switch algorithms without making old entries unparseable - crypto agility without betting
the system on "BLAKE3 is never broken."

### Concrete entry schema (v0 - IMPLEMENTED in `ringtome-proto`)

The implementation of record is the `ringtome-proto` crate; the byte-level authority is
`spec/test-vectors/entry-v0.json` ("this logical entry MUST produce exactly these bytes, this hash, this
signature"). The shape below deviated deliberately from the earlier provisional sketch in one way: `sig` is not a
field *inside* the entry map, because that would force verifiers to re-serialize.

An entry on the wire is a two-element CBOR array - the **envelope**:

```
Envelope = [ body: bstr, sig: bstr(64) ]     // sig = ed25519("ringtome-v0/entry" || body-bytes)
```

The body is itself canonical CBOR (an integer-keyed map), but it travels, hashes, and verifies **as bytes**: a
verifier slices the received envelope and never re-encodes anything (the COSE trick). This makes the
store-original-bytes rule structural - re-encoding during verification is exactly where canonicity bugs become
forgery bugs. Body fields (keys ascending; unknown keys above 6 are skipped and carried through, which is the
additive-evolution mechanism):

```
0  v:          uint (= 0)   // version tag; selects layout + hash + sig algorithms
1  type:       uint         // type-registry id (authorize, revoke, profile-set, post, ...)
2  chain:      [bstr(32) author-pubkey, uint service-id]
3  seq:        uint         // dense per-chain sequence number, no gaps
4  prev_hash:  bstr(32)     // BLAKE3-256 of the previous envelope's bytes (zero for seq 0)
5  timestamp:  uint         // author's claimed wall-clock, ms since epoch; ADVISORY - never a security input
6  payload:    [0, bstr inline-cbor] | [1, bstr(32) blob-hash]
```

- The **entry hash** = `BLAKE3-256(the exact envelope bytes as the author produced them)` - never a re-encoding.
  This is what `prev_hash` links and revocation anchors pin.
- `sig` covers the whole body via the domain-separated preimage, so `seq`, `prev_hash`, `chain`, and `type` are all
  authenticated (this is what makes the hash chain and anchoring sound).
- `payload` is header-vs-blob split (see IM-AOL Open Items): small values inline (hard cap 8 KiB; whole envelope
  capped at 16 KiB), large content as a droppable blob hash, so deletion drops the blob while the signed header
  survives.
- `timestamp` is present for display ordering and LWW of cosmetic fields only; ADVISORY so no one wires a security
  decision to it.
- Decoding is **strict**: non-minimal integer heads, indefinite lengths, out-of-order map keys, non-NFC text, and
  tags/floats are rejected outright. One logical value has exactly one accepted byte encoding; entries are hostile
  network input and lenient parsers are how "the same" entry grows two hashes.

### Signature domains

Every signature is computed over a **domain-separated preimage**: a context tag prefixes the bytes - implemented
today as `ringtome-v0/entry` for chain entries, with future contexts like `ringtome-v0/pkarr-record` following the
same pattern. This makes a
signature valid in exactly one context - a signature over a chain entry can never be replayed as an authorization,
and vice versa. Cross-context signature-replay bugs are common and stupid; domain separation eliminates the class.

- **Ringtome identity keys and iroh node keys are distinct key types** even though both are ed25519-shaped; the
  protocol never treats a signature from one as valid in the other's role.

### Versioning and the type registry

- Every entry carries an explicit **version tag** and a **type** drawn from a registry (`chain-entry`, `authorize`,
  `revoke`, `profile-set`, `post`, ...). New types and new fields are added additively; old fields are never removed
  or repurposed.
- **Protocol version negotiation** happens at connection setup; the version tag on each entry lets a node apply the
  right validation rules to historical entries written under older versions.
- Any future change that alters how relying parties *rank* or *validate* entries is a breaking change gated behind a
  version bump (this is the same rule already noted for authority statements).
- **Test vectors are mandatory:** the spec publishes "this logical entry MUST produce exactly these bytes and this
  hash / this signature," so independent implementations stay bit-compatible. These are the conformance boundary.

### A debug tool, not text on the wire

Binary sacrifices human readability, which is recovered cheaply by a `ringtome inspect <entry>` tool that
pretty-prints the decoded structure. Readability is wanted only when a human is debugging - exactly where a tool
serves it - not on the wire, where the audience is machines hashing and verifying.

---

## Addressing: `ringtome://` URLs

The IM-AOL is the storage substrate; `ringtome://` URLs are the interface to it. An address names *whose* data and
*what* within it, and deliberately does **not** name *where* - location is resolved at lookup time via pkarr, because
identities are multi-homed and roam.

```
ringtome://<root>[:<nodeID>][(<hint>[:<hint>...])]/[path]
```

### The three slots, each with one job

- **`root`** — **authority.** The identity's root public key. This is the *only* trusted element in the URL: any
  data served for this address must present a signature chain terminating at `root`, or it is discarded. The name is
  self-certifying - given `root`, you can verify content from anyone, with no trusted host.
- **`nodeID`** (optional) — **provenance and preferred first contact.** The key of the node that minted the URL.
  Because minting the URL is itself a proof the node was alive at t=0, `nodeID` is the single best liveness bet - so
  it is contacted *first*. It doubles as durable "signed by" metadata: even after every routing hint has rotted,
  `nodeID` still records which node authored this URL. (It is implicitly the first hint - never list it again inside
  the parens.)
- **`(hints)`** (optional) — **reachability.** An unordered, best-effort set of additional pubkeys, biased toward
  nodes that were online at production time, offering more pkarr entry points so discovery does not hinge on any one
  node. Hints are **keys, never addresses** - a key delegates freshness to pkarr (self-healing while its owner is
  online); an address would freeze a routing snapshot into the string and rot. Hints are never trusted; they are
  verified against `root` on arrival and discarded on failure.

### Resolution order

Try `nodeID` first (freshest liveness evidence), then hints in parallel, then resolve `root` itself as the
always-correct backstop. Verify whatever answers against `root`; use it; ignore anything that fails to chain. A stale
or malicious non-root element costs at worst a wasted connection attempt, never a wrong answer. A new node
bootstraps identically: resolve any resolvable element, sync, and thereafter learn the rest of the tree through the
anti-entropy mesh - the URL only has to yield *one* live first contact.

### Graceful degradation

Every shorter form is valid and a consumer that understands the full form handles all of them:

- `ringtome://<root>/path` — minimal, always correct, slowest (root may be cold).
- `ringtome://<root>:<nodeID>/path` — + provenance; the natural form for a URL that has been sitting around.
- `ringtome://<root>:<nodeID>(h1:h2)/path` — + fresh reachability; the natural form for a just-minted, immediately-
  shared URL (chat, QR at a meetup), which commonly resolves in one hop with no DHT round-trip at all.

A full URL whose hints have gone stale simply *becomes* a shorter one in practice - it never breaks, it only gets
slower. This is the intended failure mode.

### View vs. log, identity vs. resource

- **Bare form** (no path) is the **identity URL** - it names the identity itself (a client typically renders the
  profile).
- **Path form** (`/profile`, `/posts/<id>`) names a **resource** within the identity.
- By default a resource resolves to the node's **reconciled view** (the merged, current-state object). The
  underlying IM-AOL entry streams are available as an explicit option (e.g. a log/raw modifier), for consumers that
  want to verify or re-merge themselves rather than trust the server's materialization.

### Costs to keep in mind

- **Verbosity is a privacy dial.** More hints reveal more of which keys belong to one identity (a linkage /
  enumeration signal). Fine for a public identity being broadcast anyway; a client should **not** auto-populate hints
  for identities the user treats as pseudonymous - bare-root, or root plus a single fronting-node hint, is the
  privacy-friendly form.
- **Length.** ed25519 keys are ~50 chars each in z-base32; a shareable default should stay short (root + nodeID +
  2-3 liveliest hints), reserving longer hint sets for robustness contexts (QR codes, config files) rather than
  bios.

### Naming: Human-Readable Names Are Pointers, Never Authority

A `ringtome://` URL is unspeakable by design - a ~50-char root key is the price of a self-certifying, decentralized
name (this is Zooko's Triangle: secure + decentralized + human-meaningful, pick two; the URL picks the first two).
Human-readable names are a layer *on top*, and the invariant that keeps them safe is absolute: **a human name only
answers "which root?"; `root` remains the sole authority; resolution always ends in sync-and-verify-against-root.**
Whoever answers "which root" can misdirect first contact, but can never forge content, impersonate an established
root, or deceive people who already know the root - so naming lives entirely outside the security core. The raw URL
is the infohash-equivalent; names are how you find it.

Three tiers, by technical bar:

- **Indexes (mass-market).** A directory site maps `some-name -> ringtome://root`, exactly like a BitTorrent
  tracker maps a name to an infohash. Near-zero bar: type a name, register a pointer. Ringtome may run a reference
  index (`pub.ringtome.ca`); others can run their own; they **compete and are disposable** - an index can go down
  while the network stays up (thepiratebay vs. BitTorrent), because the protocol never depends on one. An index is
  **non-authoritative by construction**: it can lie about which root a name points at (bait-and-switch on first
  contact), but nothing more, so it must present mappings as "this name points here," never "verified to be them."
- **DNS-anchored domains (power users / institutions).** `curtis.lassam.net` doubles as name and trust anchor, but
  gates on domain ownership - an enthusiast's tool, not a mass-market one. The binding must be **bidirectional**:
  the domain publishes the root, *and* the identity's profile DNS-pin claims the domain; a resolver accepts only if
  both agree (otherwise anyone could publish a record claiming your root).
- **Contact names (post-first-contact, conversational).** Once you have met an identity, your client files its root
  under a local name ("Eve") and you never touch the URL again. Secure + meaningful, sacrificing *global* (my "Eve"
  is not yours). See Display Names and Contact Names for the full model; this is how humans refer to each other
  anyway.

**The one piece of this that is protocol, not ecosystem:** clients **pin a name -> root mapping on first
resolution** and treat a later change as an *event to surface*, not a silent redirect (monotonic memory, applied to
names). This is what stops a compromised index from hijacking an established relationship - the index is for first
contact only; after that the client remembers the root. Confusable-name attacks ("cvrtis") are further caught by the
**root-derived identicon** (the name may collide; the image will not) and by showing trust-graph context rather than
letting the index adjudicate truth. Everything else about indexes is "someone builds a website," and the doc means
that literally - it is liberating, not hand-waving.

### Resource Namespace and Access Protocol

A path addresses a typed resource, with the public/private axis **first** because it mirrors the sync boundary:

```
ringtome://<url>/public/name        (LWW-register)
ringtome://<url>/public/links       (set)
ringtome://<url>/public/            (index: lists resources and their CRDT types)
ringtome://<url>/private/config     (map of typed fields; self-only)
```

- **The prefix is an access namespace, not a folder.** `/public/*` is served across the inter-identity boundary to
  anyone who can resolve the identity; `/private/*` is **unservable** to non-self requesters as a hard rule - a
  request for it from anyone outside the identity's own node set returns "not authorized," never the data. Access is
  legible from the path, not buried in per-field config.
- **Each leaf declares its CRDT merge type** (LWW-register, set, counter, log-of-entries), and `/public/` itself is
  a discoverable index so a client can render an unknown identity without hardcoding field names.
- **Keep it flat.** `/public/name`, `/public/bio`, `/public/links`, `/private/config` is plenty for v1. Deep
  document trees (`/public/profile/contact/email/...`) are the MongoDB-document trap wearing a URL; resist until a
  feature demands depth.

**Transport: request/response over QUIC, but not HTTP's assumptions.** Reads are modeled as HTTP-like RPC over iroh
bidirectional streams (open stream, write request, read response) - familiar and correct for point reads. But four
HTTP assumptions are false here and each is load-bearing:

- **No origin server.** The URL is locationless; a read is "ask *some* replica (resolved via pkarr), verify its
  answer against `root`," not "fetch from the authority." Trust comes from the signature chain, not from who answered.
- **Responses are signed data, not authoritative bytes.** Any replica can answer, so a response is IM-AOL entries
  (or a reconciled view) the client verifies chain-to-root itself. This is the view-vs-log choice: a trusting client
  accepts the responder's reconciled view; a paranoid one requests the log and re-merges.
- **Auth is by key, mutual, at the transport.** iroh authenticates *both* endpoints by node key, so "may this
  requester read `/private/*`?" is answered by the connection itself - is the peer's node key part of my identity's
  tree? No cookies or tokens; the transport identity *is* the authorization. (This is a place QUIC is better than
  HTTP, where the client is normally anonymous.)
- **The important verb is sync, not fetch.** One-shot request/response fits "show me `/public/name` now," but
  ongoing replication ("keep me current on this identity's posts") is anti-entropy over long-lived bidirectional
  streams - a subscribe/stream shape QUIC suits and HTTP is awkward at. There are two interaction styles: read-as-RPC
  and sync-as-stream; do not force the second into the first.

**Open decision: is there a web gateway?** If `ringtome://` URLs must be dereferenceable by ordinary web browsers, we
need an HTTPS gateway (`https://pub.ringtome.ca/<root>/public/name` proxying into the p2p layer) - HTTP at the edge,
QUIC-native inside. If only Ringtome nodes ever dereference them, the native protocol can be whatever shape fits and
never pretend to be HTTP. This choice affects how public a resource's addressing needs to be, so it should be settled
before the first content types are designed.

---

## Content Markup: Fanciful, Constrained, Never HTML

User-authored content (pages, posts, profiles) is written in a **custom, deliberately weak markup language** - a
closed vocabulary in the spirit of BBCode/gemtext, with the clumsy expressiveness of the Old Internet as an explicit
design goal. Users never author real HTML, and clients never render user bytes as HTML. This is a security decision
first and an aesthetic one second:

- **User HTML on the node's origin would be the worst vulnerability class this system could have.** The web client's
  session is what authorizes *signing*. The trust model already concedes "a node that serves your client can become
  your client" - user-authored HTML served from that origin is strictly worse: any *author you view* could become
  your client. Script in a viewed page = exfiltrated session = statements signed as the victim, achieved by a
  stranger posting a page. And "sanitize a safe subset of HTML" is a graveyard - MySpace's Samy worm is the
  canonical, era-appropriate fable. A sanitizer is a blocklist over an adversary's language; a custom markup is an
  allowlist over ours.
- **The render rule:** markup blobs are parsed by a strict grammar into an AST of a closed vocabulary, and clients
  render by constructing UI themselves (DOM nodes, native controls). User bytes are never passed to anything
  `innerHTML`-shaped. Enforcement lives **at the renderer, never at submission** - signed blobs from strangers
  arrive via sync, and nothing upstream can be trusted to have validated them. Every markup blob is hostile input:
  the same posture the protocol already takes toward every other byte on the network.
- **Embeds reference blob hashes only, never URLs.** Real HTML means a tracking pixel in a post deanonymizes the IP
  of every reader - unacceptable for a network promising pseudonymity. Blob-hash-only media means every fetch goes
  through `iroh-blobs` via the reader's own node; the read-side deanonymization channel is closed structurally, not
  by policy.
- **Protocol fit:** `ringtome-markup` is an ordinary versioned type in the type registry. The version tag tells
  every renderer which dialect it is parsing, new tags arrive additively, and the existing "old readers skip unknown
  fields" rule supplies forward compatibility.
- **A small closed vocabulary is what keeps multiple clients affordable.** Rendering all of Ringtome correctly means
  implementing a renderer for a few dozen tags, not embedding a browser. This is what keeps future native, phone,
  and game-engine clients feasible for small teams (see The Client Story) - it was never true of "arbitrary HTML,
  good luck."

**The expressiveness ladder** - ship rungs 1 and 2; rung 3 may never need to exist:

1. **Static markup (v1):** text, headings, links (`ringtome://` and pinned web links), blob-hash images, and the
   shameless tags - marquee, blink, rainbow text, tiled backgrounds, autoplaying MIDI as a media type. The promise
   is a sandbox with the clumsy charm of Old HTML.
2. **Interactivity as platform widgets, never user code.** Hit counters, guestbooks, webring navigators,
   under-construction banners: each is a *tag* whose behavior is implemented by the client and whose state is
   implemented by the protocol (a hit counter is a protocol feature wearing a `<counter>` tag). Users compose
   widgets; they do not script them - the HyperCard move. 90% of the "alive page" feeling at 0% of the
   code-execution risk. Added one widget at a time, after the v1 core.
3. **Actual user scripting** (the ActionScript nostalgia rung): a tiny interpreted language - no network access, no
   ambient UI access, budgeted execution, explicit capabilities only. The Pico-8 lesson says brutal constraints
   become a community's aesthetic identity, so this could be wonderful - but it is a whole product in itself.
   Deferred indefinitely, and possibly forever if the widget vocabulary is good.

---

## The Cozyweb Surface: Language, Ceremony, and Who Gets Summoned

A system's onboarding friction is a filter, and the *flavor* of the friction selects the flavor of the survivors.
SSB's frictions (pubs, key discipline, day-long syncs, terminal-adjacent tooling) selected for people whose hobby is
infrastructure, and its culture calcified around them; founding populations are sticky and do not re-roll. Ringtome's
technical design should therefore be treated as a recruiting instrument, and its user-facing surface as the thing
that decides who stays. Several existing design decisions are load-bearing here and must be protected as such:

- **The pitch leads with aesthetics, never infrastructure.** Webrings, geocities pages, MIDI files recruit people
  who miss *making things* - a founding population that produces culture rather than infrastructure discourse. The
  moment the public pitch leads with "distributed" or "cryptographic," the filter flips.
- **The single-player floor is cold-start armor.** The cozy-OS client must be fun before the network has people in
  it (decorate a page, play the toys). Week one should reward decorating, not configuring.
- **Vouch-driven growth shapes culture.** Growth along in-person trust edges expands through real social graphs, not
  ideological affinity. The trust graph doubles as the founding-population curation tool.
- **No global timeline is the structural repellent.** Private-by-default + trust-gated visibility + demand-driven
  fronting means the megaphone does not exist. The audience-seeking crowd (the free-speech-absolutist attractor
  every censorship-resistant p2p system summons) bounces off a network that offers strangers no audience - no
  moderation fight required. Protect this property when designing any "discovery" or "public square" feature.

### The language budget

Users are taught **at most two or three novel concepts, ever**, each wearing a domestic name. Protocol vocabulary is
**banned from the UI permanently**: node, key, keypair, chain, entry, sync, sign, hash, pubkey, revoke, repudiate.
If a concept cannot earn one of the two-or-three teaching slots, it must be invisible instead. (Signal is the
existence proof: millions of users carry keypairs and safety numbers with zero awareness, because the crypto
surfaces only at one designed moment, wearing clothes.)

### The three ceremonies (the only places cryptography may surface)

1. **The recovery key, at identity creation: the photo ceremony.** The spare key is presented as a **QR code and
   the user is asked to photograph it with their phone** - because the camera roll is the most durable archive
   normal people possess (cloud-synced, searchable, survives every device death, never "cleaned up" like a
   Downloads folder), and because users photograph backup codes anyway; designing the ceremony *as* the inevitable
   behavior is harm reduction. Specifics:
   - **Payload is versioned and self-describing** (`ringtome-recovery:v0:<root-pubkey>:<recovery-seed>`), so a
     future scanner knows what it is and which identity it recovers. Protocol surface: gets a spec line and a test
     vector when the first scanner is built.
   - **A labeled artifact, not a bare code:** the QR is framed with the identity's identicon and display name -
     "Spare key for **Curtis** - keep this photo safe" - so the photo explains itself years later. Lean into the
     aesthetic: a charming SUPER OFFICIAL SPARE KEY certificate is a photo people keep.
   - **Creation blocks until the user confirms capture** ("Take a picture of this with your phone. I'll wait."),
     with file download as the fallback for printer people. Display-once stands: the node never persists the
     secret (the M2 API contract).
   - **Emergency framing, never routine login.** Reusable across crises (new machine, dead node, locked out), not
     a sign-in method: every scan exposes the seed to the scanning device, and devices authorized by the recovery
     key join the senior-most branch (correct in a real recovery, surprising if habitual).
   - **Priced caveats:** the camera roll is a leak surface (shared albums, screen-shares, cloud compromise) -
     acceptable at "casual online identity" stakes, where cloud compromise already means email compromise and the
     loss of every recovery scheme. While the root lives, a leaked photo is recoverable (root repudiates the
     recovery key and mints a replacement - which is, note, junior to keys born in between; original supremacy
     cannot be re-granted). After root retirement the photo is the identity's unrevocable skeleton key, which is
     why the artifact says "keep this photo safe" in human words.
   Never "back up your seed," never "ed25519."
2. **Adding a device or node** - framed as *"invite this computer to be you"*: a QR handshake between something you
   are already holding and something new. The key tree underneath is engine-room.
3. **Vouching** - framed as *"I know this person for real."* A statement about the physical world, not a
   cryptographic act; its gravity should feel social ("don't say it if you don't mean it"), not technical.

Everything else - identity keys, chains, sync state, revocation mechanics - stays engine-room forever. The
identicon/contact-name design already carries the hardest disguise: the key becomes a picture you recognize, never a
string you read.

### Culture seeding (the handoff)

The first wave will be node-running nerds regardless - for a while, running a node is the only door in, and that is
fine *if the handoff is planned*: nerds as hosts and janitors, artists as the culture (the itch.io shape - invisible
infrastructure people behind a front page that celebrates weird art). The product surface must celebrate **pages,
comics, and MIDI crimes**, never uptime, node counts, or replication topology. Watch what the "front page"
equivalent celebrates in every era of the network; that is the filter for wave two, and wave two - not wave one -
decides what Ringtome is.

---

## Data Layer

### SQLite Strategy

Each connector node maintains:

- **Node database** (`node.db`): Node configuration, known peers, replication state, network metadata.
- **Per-user databases** (`users/<pubkey>.db`): Each user's data lives in their own SQLite file — a **local
  materialized view** of that user's signed sync entries. The SQLite file itself is never transmitted: when a user
  connects to a new node, the node syncs the user's entries via the Ringtome sync protocol (validating each against the
  key tree as it arrives) and builds its own database from them.

### Why Per-User Databases?

- **Isolation:** One user's data can't accidentally leak into another's queries.
- **Sync granularity:** replication scope is naturally per-user. A node only syncs (and stores) the users it agents
  or fronts.
- **Disposability:** because the database is a materialized view, it can be rebuilt at any time from the signed
  entries — after a schema migration, a corruption, or a Repudiation Revocation that retroactively quarantines
  entries. The signed entry log is the source of truth; SQLite is a query-shaped cache of it.
- **Offline-friendly:** a user's database is fully self-contained for serving and authoring while disconnected.

### Replication over Iroh

- User data is synced between nodes using the **Ringtome sync protocol** (see Iroh Protocol Mapping below), not by replicating raw SQLite files.
- The per-user SQLite database is the local materialized view of synced data.
- Both nodes continue to sync the user's data bidirectionally as long as the user is active on both.
- When multiple nodes write to the same field, conflicts are resolved using **last-writer-wins (LWW) by timestamp** for simple scalar fields (name, bio, etc.): the write with the later timestamp wins, so every replica converges on one value without coordination. LWW is only appropriate where overwriting is the intent and a lost write is harmless - it must **never** gate anything security-relevant, because timestamps are attacker-controllable claims (a compromised node can stamp a far-future time and win forever). Collections use set-merge instead (two nodes adding different items both survive), and authority conflicts resolve by rank-path, never by timestamp. More complex data types can layer a CRDT library on top in the future.
- **Entry validation:** Every incoming sync entry is validated against the current key tree. Entries are stored **signed** so that a Repudiation Revocation can retroactively quarantine everything a hostile key signed after its cut-point (see Revocation Types).

---

## Iroh Protocol Mapping

Iroh provides composable protocols on top of its QUIC-based p2p connections, plus a discovery layer. Here's how each maps to Ringtome:

### Ringtome Sync Protocol → Identity Data & User Content

**Why not `iroh-docs`?** `iroh-docs` is a multi-writer key-value store where Authors sign entries with their own keypairs. However, it has **no protocol-level revocation** — once an Author has write access, their entries sync to all replicas forever. Since Ringtome's key tree requires that revoked Identity nodes lose all authority, iroh-docs' trust model is fundamentally incompatible. A revoked node could keep writing garbage into the shared document indefinitely, and iroh-docs would happily sync it to every peer.

Instead, Ringtome uses a **custom sync protocol** that runs over iroh QUIC bidirectional streams. This gives us control of the sync boundary:

**Architecture:**
```
Peer A ──iroh QUIC──► Ringtome sync protocol ──validate──► accept/reject ──► local store ──► SQLite
                      (we control this)      (key tree)   (gate here!)      (clean)        (clean)
```

**Sync mechanism:** Nodes exchange **version vectors** - per-chain *held ranges* `[floor..head]`, keyed by
`(key, chain)` (see IM-AOL) - to discover what each side is missing, then send individual signed entries. Dense
per-chain sequence numbers make gaps detectable; claimed timestamps are never used for sync state. The frontier is a
range, not a single high-water mark, because content chains may be held shallow (below). This is simpler than
iroh-docs' range-based set reconciliation, but sufficient because the number of chains per identity is small
(bounded by keys in the tree times services).

**Key tree sync** is handled as a special case — key tree entries (child authorizations, revocations) are **self-authenticating** (each entry is a signed statement verifiable from the signature chain alone). The key tree syncs first and establishes the authority context for all other data.

**Entry validation:** Every incoming content entry is checked against the current key tree state. If the author's Identity node has been revoked, the entry is rejected at the protocol level — it never enters the local store. This is the critical advantage over iroh-docs, where filtering could only happen *after* data was already synced and stored.

### Shallow Sync and the Day-Long-Sync Problem

SSB's onboarding pain deserves precise blame, because it is easily mis-remembered. It did *not* sync the whole
network to everyone: replication was scoped to your follow graph within 2-3 hops, and post-initial syncs were cheap
deltas. What actually hurt: (1) **pubs poisoned the hops math** - a pub followed thousands, so "2 hops from me"
transitively became most of the active network; (2) **every feed in your slice replicated whole, from genesis,
mandatorily** - validation and indexing both required complete chains, and nothing could ever be deleted, so the
entry fee grew monotonically forever; (3) **the infamous "indexing..." screen was local** - clients rebuilt their
databases by replaying the entire on-disk log, on first run and on app updates. Notably, SSB *already had*
lazily-fetched content-addressed blobs - a header/blob split alone does not prevent any of this. Ringtome's real
escape hatches are: no transitive hops-amplification (fronting is direct demand - your node fetches who *you*
follow, not who they follow), incremental materialized views (per-entry updates; full replay is an optional
integrity ritual, never a startup cost), and - the piece that needs a protocol commitment - **suffix-capable
chains**. "Chains replicate whole" as a default would still recreate SSB's tail (follow a posts-every-minute bot
with a decade of history and you owe five million entries and verifications; a fronting node multiplies that by its
user count). The fix is cheap because **the hash chain already permits it - this is a git shallow clone.** If a node holds the *suffix* of a chain, the oldest held entry's signed
`prev_hash` commits to the entire missing prefix: everything held verifies as authored, and any later backfill must
hash-match the commitment already in hand or be rejected. `prev_hash` never required *possessing* the prefix - only
that any prefix ever accepted be *the* prefix. Better still, **LWW fields are correct (not just plausible) from a
suffix**: an unseen older entry loses LWW by definition. What shallow holding forgoes is fork detection inside the
unfetched prefix and complete history display - both acceptable to acquire lazily. Policy:

1. **Identity chains: always full, always first.** Tiny, security-critical, they are the authority context - never
   shallow.
2. **Content chains: suffix-first, backfill lazy.** Follow = head plus a small recent window; older history streams
   on demand (scrollback) or idle time. This is why the frontier is a `[floor..head]` range - designed into sync v1,
   because a protocol that assumes dense-from-zero storage bakes that assumption into every peer forever.
3. **Render at first entry, never at completion.** SSB's sin was as much UI as protocol: the app blocked on
   replication. Progressive display is a standing rule for every client.
4. **Fronting depth is a dial.** Fronting an identity promises its *availability*, not its infinite history:
   per-identity depth/size budgets, so a node fronting 500 users is not archiving 500 lifetimes.
5. **Snapshots stay reserved, with a named trigger.** Signed "state as of seq N" checkpoints become necessary only
   when suffix + LWW stops sufficing (set-types with removals, counters). The entry format reserves room; not v1.

The honest trade, named: shallow-held chains mean a node can serve recent content while deep history is only
*provably-committed-to*, not present. Archival completeness becomes a **role**, not a universal guarantee - an
identity's own nodes hold its own chains whole (agenting stays full-fat), and anyone may volunteer as a deep
archive. That is the same trade git made, and the right one.

### The Identity Tree Is Its Own Peer-Discovery Structure

There is no roster of an identity's nodes, no membership protocol, and no coordinator. Each node's picture of the
tree is simply **its local frontier of the identity chains**: every key it knows about is an authorization entry it
has synced. That picture is signed (never wrong), possibly stale (missing the newest branches), and converges through
sync itself:

- **Who:** the chain frontier is the peer list. **Where:** pkarr resolves keys to current addresses, and its
  record expiry doubles, unchanged, as the liveness signal for the identity's own nodes.
- **Juniors sync upward from birth:** a new key's signed ancestry (its usurper list) tells it exactly who its
  seniors are, and in the common case it was just talking to its parent's node anyway.
- **Cousins learn of each other through diffusion:** K4's authorization is an entry on K2's identity chain, so it
  reaches K3 through *any* sync partner who has seen that chain - no direct contact needed. News of new keys
  spreads epidemically; any connected set of nodes converges completely.
- **The handshake accepts unknown-but-valid keys.** A key never heard of before may knock, presenting its full
  chain-to-root - which is self-authenticating (rule 4) and is checked against locally-known revocations
  (monotonic memory) before anything is trusted. Refusing unknown-but-valid keys would deadlock tree discovery;
  accepting them is what makes it self-healing.
- **Partition is latency, not damage.** Two halves of an identity that cannot talk accumulate separate
  single-writer chains; whenever they reconnect, everything merges with zero conflict. The only thing that makes a
  partition ugly is the same *key* signing in both halves - equivocation, already handled.

**Sync discipline:** each node syncs with a few peers per interval (k = 3-5), **selected randomly over its full
known peer set - never a fixed subset.** Anti-entropy between up-to-date peers is a kilobyte frontier exchange, and
epidemic spread reaches every node in O(log n) rounds, so this keeps traffic linear rather than n^2 even for
absurdly node-rich identities (the design center is 2-5 nodes). The random selection is not just a traffic rule: it
keeps the sync graph well-connected so no node ossifies into a chokepoint by habit - the traffic discipline and the
security property below are one mechanism seen from two sides.

**The adversary in the mesh lies only by omission.** A malicious-but-not-yet-repudiated node cannot forge others'
entries (signatures), cannot truncate chains undetectably (hash chain + dense seqs), and cannot lie about its own
ancestry - its credential *is* its parent-signed usurper list, a confession of exactly who outranks it. What it can
do is withhold: claim ignorance of a branch, or sit on the revocation that targets itself while syncing everything
else helpfully. Omission only works on victims for whom the withholder is a **cut vertex** - their only path to the
rest of the identity. Against anyone with a single honest sync partner, the withheld entry arrives by another route
and monotonic memory makes the arrival permanent. So in steady state this degenerates to the eclipse residual risk
already named in the threat model.

**The exception is onboarding, and it gets a corroboration ladder.** At the moment a key is created, its recruiting
parent is naturally its entire view of the identity - a free cut vertex. A malicious recruiter can present a pruned
universe: no cousins, no inconvenient revocations. The defense is corroboration from **any source independent of the
recruiter** - rank is not what matters, independence is; chain entries are self-authenticating regardless of who
serves them, so even a junior cousin or a mere fronting node can reveal a hidden branch or revocation. A newly
authorized key climbs this ladder:

1. **Reachable seniors** from its own usurper list (a signed, unfakeable contact sheet).
2. **Anyone serving the identity:** query pkarr from the key's own network position and sync with whatever nodes
   answer.
3. **Nothing reachable: proceed uncorroborated, and keep retrying.** The key operates with its worldview flagged
   unverified; every later sync with any independent party is a corroboration opportunity, and monotonic memory
   makes late-arriving truth land permanently.

The ladder must not be a hard gate, because the sole-survivor recovery case (root dead, one key rebuilding, recovery
key cold in a drawer) would deadlock it *forever* - every senior dead, cold, or the recruiter itself. And in the one
case where corroboration is genuinely impossible *and* the recruiter is malicious, the recruiter is the senior-most
surviving key, compromised - the threat model's documented worst case, which no onboarding rule can save. A gate
that only closes when it cannot help should be an attempt, not a gate. A pruned worldview still requires eclipsing
the child's entire network view rather than merely being its sole informant - and the corroboration attempt doubles
as tree repair, since it is exactly the anti-entropy that heals whatever partition made seniors unreachable.

### Encountering Your Own Identity in the Wild

Casual browsing doubles as tree-integrity patrol. If a node fetches content signed by a key whose chain terminates
in **its own user's root** but which it has never seen, the standard handshake applies (verify chain-to-root, check
local revocations, sync) and the merge routes the stranger-you to existing machinery: a **legitimate lost branch**
(sync is the repair - you now know your own shape better), a **stale-backup fork** (equivocation, innocent flavor:
tiebreaker plus fork-aftermath re-signing), or a **hostile branch** (the encounter hands you the proof; a senior key
repudiates with anchors). The owner is the best-positioned auditor of their own tree, and this makes every read of
the public network a free audit. **The trigger is root equality, nothing softer** - matching names, avatars, or bios
must never start this flow, or lookalikes gain a lever to get your node treating them as kin.

Someone using your *name* with a different root is not a protocol event at all - cryptographically it is simply
another identity, and the trust layer already handles it (your vouchers reach your root, not the costume; strangers
who trust neither of you were never promised the ability to tell strangers apart). The defense is UI: derive a
unique **identicon from the root pubkey hash** and show it wherever a display name appears, so Curtis (afe8...) is
visually distinct from Curtis (ff3e...) at a glance, and flag name/avatar collisions with non-matching roots when
they cross the user's view.

For each user identity:
- The user's identity data (key tree, profile, content) is synced via the Ringtome sync protocol.
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

**Records are keyed by node keys, not the root.** pkarr records are keyed by *and self-signed by* the pubkey they
live under - so a node can only publish a record keyed by a key it actually holds. Since nodes never hold the root
key (and the root may be cold, retired, or gone), records are keyed by each **node's own key**:

- Each online node **publishes a record under its own node key**, containing its current addresses (~1000 bytes),
  plus the chain proving that node key is authorized to serve the identity (chain-to-root, verified by the resolver).
- **Discovery is via the node keys in the URL** (`nodeID` / hints), not via the root. The root is the *authority*
  you verify against; it is not a resolvable address. This is why bare `ringtome://root` alone does not reliably
  resolve - it needs a hint, a cache hit, or an index to supply a live node key to look up. This is a feature, not a
  gap: the online nodes are exactly the resolvable ones, and the root need not be online at all.
- Records **expire after a few hours** if not republished. Each node **republishes its own record on a fixed
  schedule** (e.g. hourly) as a background task, for as long as it is online. The record is thus a **liveness
  signal**: it answers "which of this identity's nodes is currently online and reachable?"
- If all of an identity's nodes go offline, all their records expire, which is correct - there is nobody to serve
  the data. Anyone who previously cached the identity's data still has it; the DHT is only needed for first contact.

### Discovery Flow

```
Node X wants ringtome://<root>:<nodeID>(<hints>)/...
  → Check local cache (instant if we've seen this identity before)
  → Miss? Resolve the node keys from the URL (nodeID first, then hints) via pkarr in parallel
  → Get back the current addresses of whichever of those nodes are online
  → Connect to one via Iroh; it presents its chain-to-root
  → Verify that chain terminates at <root>; discard the responder if it does not
  → Sync the identity's data via Ringtome sync protocol (identity chains first, then content)
  → Cache locally (including freshly-learned node keys, which widen future resolution)
  → Future lookups are instant cache hits
```

Two things this flow assumes. First, **you must know a node key to look one up** - pkarr resolves a key you name
into addresses; it does not let you enumerate keys you have never heard of, so the DHT is a *lookup* channel, not an
enumeration one (consistent with the graph-privacy model). Second, **trust comes from the chain-to-root check, never
from who answered** - any node may respond; only one presenting a valid chain to `<root>` is believed.

### How people find each other (Discovery Channels)

Discovery is in direct tension with the trust graph's privacy, and the tension is not incidental: **discovering someone through a friend and mapping that friend's relationships are the same operation** (traversing their vouch edges). You cannot offer friend-of-friend discovery while hiding the friend-of-friend graph, because the discovery *is* the enumeration.

The vouch graph is the most sensitive dataset in Ringtome - a real-world map of who has met whom - so we do **not** make it globally enumerable to power discovery. Instead, discovery runs on several channels, most of which never touch the graph:

- **Content and tags.** Peter posts under `#distributedSystems`; I find Peter by the content, no edge traversal needed. This is the primary channel and it keeps the network lively without exposing anyone's associations.
- **DNS-anchored identities.** I can find the Globe and Mail (or the Ringtome seed account) directly by name, with no vouch path required. This is also how a brand-new user with zero vouches bootstraps a first trust edge.
- **Seed / directory accounts.** A curated on-ramp account (see cold-start) that follows and lists interesting identities, giving newcomers somewhere to start.
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
| Data sync | **Ringtome sync protocol** | Custom protocol over iroh QUIC streams with key-tree validation |
| Content storage | **iroh-blobs** | Content-addressed blob storage (BLAKE3) |
| Real-time | **iroh-gossip** | Epidemic broadcast for live notifications |
| Discovery | **pkarr** / Mainline DHT | Decentralized identity lookup |
| Local database | **SQLite** via **sqlx** | Per-user local materialized views |
| Login auth | **Argon2** | Node-login password hashing (verify user, then grant access to their key) |
| Key at rest | **envelope-encrypted key file** | Machine keychain (always-on) or Argon2-derived (cold device); DB itself unencrypted - see Key Storage |
| Cryptography | **ed25519** | Identity keypairs (via Iroh's built-in key types) |
| Frontend | **Preact + htm + esbuild** | The retro-OS web client - v1's only client, and the reference renderer for the content markup (see The Client Story) |

### Removed Dependencies (vs. old codebase)

- ~~AWS SES~~ — no mandatory email provider
- ~~AWS SNS~~ — no mandatory SMS provider
- ~~Multi-tenant community model~~ — replaced by unified identity
- ~~Organization-scoped auth tables~~ — replaced by per-user databases

---

## Delivery and Packaging

**One binary, two modes, chosen by config - not two codebases.** The node and the personal-desktop app are the same
Rust binary with different switches flipped:

| | Node mode (hosted / always-on) | Desktop mode (personal) |
|---|---|---|
| Bind | public port | `localhost`, stable default port |
| Tenancy | multi-tenant (Argon2 login) | single-tenant, auto-login (the OS user *is* the tenant) |
| Envelope key | env var / file, upgradeable to keychain | OS keychain |
| Lifecycle | always-on service | tray shell + autostart |

Because these are config seams (bind address, tenancy, auto-login, envelope-key source), they must be **configuration
from the start**, never hardcoded assumptions - which the config-driven design already gives us. Picking one to ship
first does not close the door on the other.

### Node-first as the bootstrap

Ship **node mode first** (`testnode-N.ringtome.ca` sample nodes; enthusiasts run their own from the binary). It is
the path we can walk now, the old codebase's HTTP patterns port directly, and iteration is fast. But name the trap
honestly: hosted-first is a **decentralized system deployed centrally** - the median early user's keys live on *our*
nodes, so for them the self-sovereign story is aspirational, not actual (email works this way - most people use
Gmail). This is an acceptable bootstrap, but it has gravitational pull toward *staying* centralized, because once
keys live on our nodes, "move to your own machine" is a migration nobody bothers to do. Guard against it: make
**self-hosting a first-class, documented, easy path from day one**, and ship desktop mode *before* hosted usage
calcifies - the moment hosted-first feels like it is working is the moment to ship desktop, not later.

### Desktop mode: local server + system browser, NOT Tauri

The app is *already* a full HTTP server, so Tauri's core value (bridging a webview to native Rust) is a bridge we do
not need - we already have the universal one: HTTP on localhost. Desktop mode is therefore the same server bound to
localhost, plus a **minimal native shell** (tray icon: status light, log tail, "open in browser", quit - or, at the
floor, just auto-open the system browser with no GUI at all) that opens the user's real browser at the localhost
port. This is the Syncthing / Jupyter / Plex model: proven, and it dodges Tauri's worst tax - cross-platform webview
skew (WebView2 vs WebKitGTK vs WebKit), which is a documented misery. We develop against real browsers and that is
what ships; the node's JS UI is reused verbatim.

### The Client Story: one client, carried by the web

**V1 ships exactly one client: the retro-OS web app** - Preact + htm + esbuild (the old codebase's proven
toolchain), served by the node itself, styled as a cozy fake retro desktop: draggable windows, chunky bevels, dumb
built-in toys (a paint program, a solitaire clone, a guestbook), and the modem icon behind which you discover the
other people. The "ship a game, let users discover the network hiding inside it" arc lives *inside* this client -
a fake OS with games in it needs no game engine. The web carries the whole aesthetic: CRT/scanline effects are a
canvas/WebGL overlay, "juice" is easing and sound, and the browser's autoplay restriction is played straight as a
period-authentic "click the speaker icon to enable sound" ritual.

- **The API is strictly client-agnostic.** The web client is the *reference* client, never a privileged one: no
  web-UI-private endpoints, and the HTTP API is documented and versioned with the same discipline as the protocol
  surface (test vectors, type registry). This is the cheap, load-bearing rule that keeps every future client
  possible - including ones we do not build (see Phones).
- **Game-engine client (Godot): struck from the roadmap.** The temptation is real (native retro effects,
  unrestricted audio, gamey features), but a social network is a large amount of data-bound, text-heavy, accessible
  UI - exactly what game-engine UI toolkits are worst at - and a solo project's novelty budget is already fully
  spent on the protocol layer. The markup AST keeps the door open at near-zero cost (a future client implements a
  renderer for a few dozen tags, not a browser); a game-engine client is justified only if a genuinely gamey
  product layer someday demands one, and it is on no path to v1. Webview-in-Godot hybrids are rejected for the same
  webview-skew reason as Tauri.
- **Desktop delivery = the tray sidecar opens an app-mode window.** Desktop mode's "minimal native shell" (tray
  icon, autostart, status light) is the node binary itself; "open Ringtome" launches the system browser in app mode
  at the stable localhost port. One binary, one installer, one signing identity - the Ollama/Syncthing pattern,
  which the last few years have made a normal consumer shape, not a nerd shape.

### Phones: deferred, by design

**V1 targets computer desktops.** Early Ringtome lives or dies on *creators* - page authoring, markup, running
nodes - and creation happens at desks. Phones dominate at the consumption-at-scale phase, which is exactly when
"native app pointed at a well-populated federated node" becomes the correct architecture anyway: there is no
background sidecar on iOS, period, so a phone was always going to be a remote client of always-on nodes, not a p2p
citizen. Three decisions keep the phone door open without walking through it now:

- **PWA stopgap:** the retro-OS web client works in phone browsers from day one, and installed PWAs get web push on
  modern iOS/Android. "Our phone app is a website" is period-appropriate.
- **Native apps are designed-for but deferred** - ideally community-built against the documented client-agnostic
  API (the Mastodon path: the ecosystem's best phone clients were third-party). The small markup vocabulary is what
  makes a *correct* third-party client a reasonable weekend-project size.
- **Push notifications are the one structural gap, recorded now and solved later:** APNs/FCM require a server
  holding push credentials - an awkward fit for p2p. The likely answer is an optional **push-gateway role** that
  hosted nodes can opt into. Noted here so it does not ambush whoever builds the first phone client; no design work
  now.

### Always-on nodes are needed either way

Neither model escapes running always-on infrastructure: **p2p social content needs someone awake to serve it** (the
fronting / rehosting problem; cf. BitTorrent seeders). A desktop app online only while its window is open is a poor
p2p citizen - its content vanishes when the laptop closes unless an always-on node fronts it. So we run server nodes
regardless; the only question a packaging choice answers is whether the *user's keys* also live there. Node-mode work
is therefore never throwaway - those nodes become the seeders/fronts the desktop model also needs.

### Caveats that apply to desktop mode regardless (do not forget these)

These are the irreducible price of shipping a background service to non-terminal users - and note most of them would
cost the same under Tauri, so they are not arguments for it:

- **Localhost is not automatically safe.** A malicious web page you visit can make requests to `localhost:PORT`, so
  the local server needs CSRF / origin-checking even though it is "just local" (Syncthing shipped exactly this bug).
- **Use a stable port, not a floating one.** The browser treats `localhost:3000` and `:3001` as different origins, so
  a port that shifts between launches silently logs the user out and drops per-origin state. Pick a fixed default,
  fall back only on collision, and persist the choice.
- **Autostart is the real work of the tray shell.** The status light is trivial; keeping the node running (ideally
  launching at login, so the identity stays live) is per-OS fiddliness (launchd / Task Scheduler / XDG autostart) -
  and it is fiddly in Tauri too.
- **Code signing does not go away.** Any distributed executable needs Mac notarization / Windows signing or users hit
  scary warnings - equal cost across all packaging approaches.

---

## Project Structure (Proposed)

```
ringtome/
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

- [x] ~~**Iroh integration depth:**~~ Resolved — custom Ringtome sync protocol for data sync (iroh-docs is incompatible with revocable identity), `iroh-blobs` for content, `iroh-gossip` for real-time, `pkarr`/DHT for discovery.
- [x] ~~**Conflict resolution:**~~ Resolved — Ringtome sync protocol validates entries against the key tree, rejects revoked authors, then applies last-writer-wins by timestamp for simple fields among valid authors. Complex data types can layer CRDTs (e.g., Loro) on top in the future.
- [ ] **What social features first?** Profiles? Posts/feed? Direct messages? Following?
- [x] ~~**Frontend approach:**~~ Resolved — v1 ships exactly one client: the retro-OS web app (Preact + htm +
  esbuild), serving as the reference renderer for the content markup. Client-agnostic API as the standing
  discipline; Godot struck from the roadmap (markup AST keeps that door open); phones deferred to
  native-app-on-federated-cluster, ideally community-built (see The Client Story / Phones / Content Markup).
- [ ] **Markup vocabulary v1:** which tags make the static-markup first cut, and which widgets (hit counter,
  guestbook, webring navigator) come first once the core ships? The renderer's strict grammar and the
  `ringtome-markup` type-registry entry need specifying alongside the first content types.
- [x] ~~**Serialization format:**~~ Resolved — deterministically-encoded CBOR, with the hash-and-store-original-bytes rule, domain-separated signatures, version tags, a type registry, and published test vectors (see Canonical Encoding, Signature Domains, and Versioning).
- [x] ~~**Recovery key UX:**~~ Resolved — the **photo ceremony**: the recovery key is a labeled QR the user
  photographs with their phone, creation blocks until capture is confirmed, file download as fallback, emergency
  framing throughout. Full design (payload scheme, artifact, caveats) in The Cozyweb Surface, ceremony 1. Node-side
  API contract shipped in M2 (secret returned exactly once, never persisted); the ceremony UI lands with the first
  client (M4).

