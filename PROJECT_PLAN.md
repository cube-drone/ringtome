# Ringtome — Project Plan

## Vision

Ringtome has two primary goals:

* To be a **social network** built on the [Iroh](https://iroh.computer/) peer-to-peer (p2p) network.
* To be opinionated: this is not a _protocol_, or a _spec_, this is explicitly a product, and that product is
    designed with an aesthetic and a point-of-view. 

That aesthetic and point-of-view is "retro", specifically: Ringtome is intended to loosely 
 evoke the feeling of being on the world-wide-web, circa 1995-2005, without specifically binding to 
 a point in time. 

Any pointed notes about the fundamental untrustworthiness of nostalgia-goggles or the difficulty of appealing
 to a nostalgic cycle that is constantly rolling forward in time can be forwarded respectfully to `/dev/null` for 
 further consideration.

### Federation vs. P2P

Both federation and P2P are rife with problems that we hope to present a compelling solution to.

#### What Are We Hoping to Fix About P2P?

Peer-to-peer protocols like Secure Scuttlebutt or RetroShare are, and I say this affectionately as a nerd, 
_nerd shit_. They tend to assume that their users are extremely willing to learn about nodes and 
certificates and network topologies and maintain complicated cryptographic concepts in their heads.

I assert that public key cryptography, while common knowledge for technologists, is beyond the 
scope of most consumers' expected understanding of any given system.

Systems like SSB, Matrix, and Signal are object lessons in "the system is cryptographically pure enough to
present at least a good challenge to a state level actor", but as a result they often have to present
a user interface that is at least a little bit _cryptography shaped_.

One of the bigger problems about P2P is: phones. Phones tend to be terrible P2P citizens, spending most of their time
offline and heavily restricting background operation. It is conceptually easier to have a phone connect to a node that
does all of the complicated syncing than have the phone sync itself. 

#### What Are We Hoping to Fix About Federation?

Federation - the "email" model - you pick a provider, `@google.com` or `@compuserve.dingus` - and trust them to 
do all of the hard parts of p2p networking _for_ you. Now, instead of having to learn about public key cryptography,
you trust Google to learn it on your behalf. 

But:
 * Small nodes are not a safe place for your identity. `google.com` is unlikely to disappear in a puff of smoke, but
   `greg.hobby.casual.email` absolutely is.
 * Medium-sized nodes have to deal with all of the collective legal and moderation burden of fronting a 100, 1000, or 10,000 person
   community: expensive and difficult. 
 * There's enormous incentive in federated networks for single nodes to _get enormous_: solving all of these problems are
   easier with scale and financial resources.
 * So: on the web (federated), there are 10 big websites.
   There are 5 big email providers. The bigger they get, the less they care to federate with small players: gmail could stop
   carrying email from anyone that's not gmail, outlook, et al, and get a huge bump to their spam prevention while only excluding
   an increasingly small percentage of the network.
 * The most prominent federated social network, Mastodon, places an enormous amount of moderation load on the shoulders of
   network topology management: you can only see other nodes approved by your node operator, 
   and managing the set of nodes that you federate with is a 
   large job for node operators, who have to constantly perform difficult moderation operations against a large public network
   on behalf of their users.
 
### The Public Internet Is... A Lot

One of the problems of P2P networks is that you never know if you're talking to _real people_, or 10,000 lightbulbs.

Centralized networks used to be able to solve this somewhat: security, bot detection, and moderation comes at massive human cost,
and they're willing to bear that cost, because it's profitable! 

But, increasingly, LLMs are driving the costs of attacks up _faster_ than centralized networks can keep up. 

Past that, public content on the internet is increasingly driven by an algorithmic discovery model that prioritizes 
attention-grabbing, low-context, low-friction, endlessly-consumable content and grows to consume all public spaces.

So: any public space is going to be flooded with low-effort content until discovery becomes necessary, and discovery
will almost certainly select for the lowest common denominator of attention optimization - as a result, public internet
spaces trend towards cats with machine guns fighting bikini-clad ragebaiters while unboxing 
Pokemon cards (with Minecraft playing in the background to keep your attention).

## Ringtome: Federated-ish, Private-ish

Ringtome is a federated protocol, but one that's p2p shaped:

The reasons you can't trust small p2p nodes are:

* Security: you can't trust them.
* Ops: you can't trust them not to lose your data.
* Moderation: you can't trust their taste.

So, our model is partially about making it possible to trust small nodes - even, if users _are_ willing to learn a little
bit about public key cryptography, little self-hosted ones.

### Identity is a Tree

Identity isn't just portable, it's _accumulative_. Your identity is the sum total of all of your identities in a network: each 
can participate _as you_. Joining a new federated node adds one more leaf to your identity, growing it, making it more permanent
and harder to erase from the network.

Then, what about security? Well, these different identities are also _revocable_. If you trust a node with your identity and 
they turn out to be Bad Guys, you can simply take your ball and go home. 

The rules for this are _unbelievably complicated_, but users mostly don't have to think about them: 
as a broad "good enough" description of the rule, "senior" 
(via complicated rules explored later in the document, "senior" often means "older" but not always) 
nodes can always revoke "junior" nodes,
so if a user starts their network with a node they trust a lot (like something running on their own computer), 
they'll retain the ability to take their ball so long as they have the recovery code from that node 
(which we recommend storing on their phone as a picture of a QR code, or in their personal email: not great security but high recoverability). 

### Everything is Private, Social Networks are Closed Systems

Finally, moderation? Well, we solve moderation as best as we can by simply taking as much of it as possible out of the node
operator's hands - by making nodes smaller, by reducing the attack surface for legally dicey content, by taking "public posting" 
out of node operator's hands and instead forcing individual users to manage their own networks.

This is also a way of defending against the problem that _most of the network is likely to be bad actors_. Minting new identities
is free, so all it takes is one person with a fast CPU and they have 100 million users - but there is no public commons for them
to show up in.

Trust starts at zero by default: it's earned, by meeting people in person, or having friends vouch for them, and is intensely
user-configurable.  

This may prove to kill the network effect: we may be building an empty online crypt. Let's hope not.

As identities are cheap, users are also encouraged to generate as many of them as they need: if you want a main identity and
a pseudonym, go for it, champ! "This identity exists for real" is exactly the kind of unverifiable claim that modern social networks
are no longer able to reliably police without draconian measures. (Measures they are considering as we speak.)

### A Network That's Just Your Monkeysphere

Large protocols like ATProto or Mastodon focus on scaling communities up to 100,000 members or more. 
Shared public spaces with discoverability, trending, search, recommendations.

They are for answering the question: "What is everybody looking at right now that I might also like?"

Ringtome is for answering the question: "What are my friends doing? What are they interested in right now?".
It's expected that most users will have personal networks in the 0-200 user range. 

Things can still travel widely through the network, but not by being aggregated to the top of a global feed - 
instead, the old fashioned way - by being passed from person to person. It's technically _one network_, 
but you only see _your network_. If people get popular for being great at curating things that you like?
You can follow them, trust them, add them to your network, and if they _subsequently crash out_, unfollow them.

### Cozy Aesthetic // Hidden Internals

Do you want a network full of crypto-nerds and distributed systems developers? Okay, then the vocabulary of that
system can be filled with terms like "pubkey", "chain", "entry", "sync", "hash", "repudiate", "tree', and "node".

Broadly our goal is to reduce the amount of _p2p detail_ we surface to users until it's all-but-invisible: 
we avoid direct protocol vocabulary and prefer to present easy-to-understand abstractions, like 
"recovery key", "invite", and "vouch". 

This is also an aesthetic goal - the design is intended to evoke "sloppy", "amateur", "friendly", "chaotic",
it invites collaboration by being unpretentious. We don't want purity or cleanliness, 
we want sticky friction and the idea that this place encourages contribution at all skill levels. 

---

## Doctrine

The load-bearing laws of the system, each stated once — here — and referenced by name everywhere else. If you
catch yourself explaining one of these in full for the third time in three different sections, stop: it belongs
here, and that section gets a pointer.

**No Central Authority** This feels like a given, but it is kind of the load-bearing assumption of any p2p system.
There can't be any central trusted system holding the whole thing up because... that's... 
_what it means for a system to be decentralized_. Everything must always be computable from local, public data
alone.  

**No Clocks!** Time is a UI element — "when was this posted?" is a perfectly good thing to show a human — but we
can never trust it to be correct, so it is never allowed to be load-bearing. Ordering, authority, and freshness are
settled by *structure* — hash chains, seniority, monotonic memory — never by a timestamp a stranger could lie about.

**The Law of Conservation of Trust** - everything that can be abused sits atop the strata of trust, which is its
own, fully public network - (not just "the nodes you follow" but everyone you are personally willing to vouch for or against).
Trust can not be manufactured by any process, ("I have 10,000 kids who say I'm great") 
it comes exclusively through vouches, is limited, is the system's most precious resource.

**Not Hermetically Sealed** Private doesn't mean "nobody can find you" - in fact, you can and should make quite a lot
of your content public, and that content can be fetched, rebroadcast, and even surfaced to the broader web. 
Your output is publicly available, anybody can come along and look at it - what's private is what you pull, your input stream, 
where you choose who you trust and what you consume.

**You Can't Push Hosting Decisions On Others**, a.k.a. **Bounded Operator Liability** You can not say to another person, 
"rebroadcast this thing" - another person can decide "rebroadcast everything from this person I like", 
but the direction is always pull, never push. Any given node's operator's responsibility only extends so far as the
public-facing taste and judgement of their users (who can be forcefully ejected), and no further. 

**Pseudonymity, Not Anonymity** Your separate identities don't link to each other unless *you* link them — that is
the whole promise. We do not promise anonymity from network observers, and against a state-level adversary we are a
*terrible* choice. 

**Recoverability Over Prevention** On a p2p network you cannot prevent every compromise, so we don't pretend to.
Instead: make every cheat *undeniable* and every failure *survivable*. When two honest parties disagree we converge
on the same answer even when it isn't the "fair" one — a split-brain is unrecoverable; an arbitrary-but-agreed winner
is not.

**Allowlist Beats Blocklist** We never filter an adversary's content — no sanitizing their
HTML, no LLM-guessing their spam. That's a losing game played on their turf. We enumerate what's allowed,
rather than filtering out what we don't want to accept. 

**Names Are Pointers, Never Authority** Handles, slugs, contact names — all labels that resolve to a key. The *key*
is the identity. A name can be wrong, stale, stolen, or reassigned; it never grants anything on its own.

**Every Byte From The Network Is Hostile** Validation lives at the consumer — the renderer, the verifier — never at
submission. Signed garbage arrives via sync from strangers, and nothing upstream can be trusted to have checked it.
A responsible client validates everything itself. Even on data that looks like its own.

**Copy, Don't Flip** Crossing a membrane — draft to published, private to public — never toggles a bit; it mints a
*new* artifact. There is no "make public" switch that could be thrown by accident or by a bug, because the only way
across is a deliberate act that re-signs the content into its new home.

**Immutable Chains Doesn't Mean Immutable Content**: Just because signed entries are forever doesn't mean that
content has to be: we can point to content that gets dropped or modified. 
Retention is enforced by policy, not _the chain_. 


---

## Architecture Overview

- **Connector Nodes** are Rust servers running this protocol. They join the Iroh p2p network and serve a web UI.
- **Users** authenticate to a node via the web UI. The node acts as their agent on the p2p network.
- **Data replication** happens over Iroh between nodes. If a user connects to a second node, their data syncs to it.

### We Trust the Node Operator

Like with an e-mail provider, the user _trusts_ that their node operator knows what they're doing and won't ruin their day.

This is not a totally trustless protocol: there are lots of ways for a malicious node operator to get up to no-good
with a user's identity - the idea here is not perfect security, just that **a user can recover from this**.

A malicious node operator becomes privy to all of a user's secrets and can act on that users' behalf up until the moment
where their access to the identity is revoked. At that point, they _still have all of the users' old secrets_, there's a
concrete privacy loss at play here: this, again, is _bad_, but what malicious node operator does not have is forward
access to that users' secrets: once they're revoked, the damage is done but the day is not lost.

This is not end-to-end encryption: the "ends" of the encryption are the identity nodes, and those nodes are distributed:
this is a prioritization of your identity's _resilience_ and _ease of operation_ over its _privacy and security_.

Ringtome is, intentionally and up-front, a terrible choice for folks who are looking to maintain perfect secrecy 
against state-level actors: the most obvious attack is for them to run or subvert a popular node and simply look
at all of the user's secrets on that node without ever doing anything to seem suspicious. 

Mastodon stores all of your DMs in plain-text on the operator's box. 
Ringtome doesn't — private data is ciphertext at rest, so a stolen backup is useless without the node's keys. But
against a malicious operator who actively *wants in*? We might as well be plaintext: it's their node, they hold the
keys, they read it all.

#### The Node Operator Can Serve UI

Part of the reason for this compromise? The node operator can serve the Ringtome UI to the user - secure end to end encryption
requires that the "end" be completely under the users' control, and this is not the case with an operator-controlled UI
surface like _any web application_. 

The application, here, _is, in fact_ designed to be run locally as a single self-hosted trusted node, for users who are not
willing to make this compromise.  In fact, this is expected to be the _most common case_: we're a p2p network with federation-like
qualities, not a federated network.

## The CROWN Identity

"CROWN" is a backronym, a **Cryptographic Rank of Wandering Names**, describing a user's Identity: a 
**tree of ed25519 keypairs** with strict hierarchical authority, and succession and usurpation rules that make
the British peerage look ill-defined. 

### CROWN Structure

```
Root Key (K0) — the user's identity IS this public key
├── K1 (device/node key, created T1, signed by K0)
│   └── K3 (sub-key, created T3, signed by K1)
└── K2 (device/node key, created T2, signed by K0)
    └── K4 (sub-key, created T4, signed by K2)
```

Note that, in this order, even though K3 was born _after_ K2, K3 is the rightful heir to the throne.

### Rules Of Succession

The goal here is to have a **total order on key authority** that **any node can compute using only local, public data**.
There's no synchronized clocks or coordinators to prevent a civil war (**No Central Authority**, Doctrine) - it has to be something the system can calculate
on its own.

1. **The Bloodline Must Continue! Babies! Babies! Babies!** - any key in the tree can authorize new child keys.
        We encourage new devices and nodes.
2. **Succession Order Is Meaningful** - K3 carries revocation rights to K2 and K4.
3. **Simba Beats Scar** - 
    This isn't just "parent over child" or "earliest date wins" (because there is no date to win), 
    Any child that outranks another child carries revocation power over that child - in our example, K3 has
        authority over K2, **even if K2 is _older_**.
    * Wall-clock time is meaningless in succession order. 
    * To compare two keys, walk both up to their lowest common ancestor; they diverge into two of that ancestor's 
        children; whichever child is senior (per rule 3's lists), that entire branch wins. 
        Formally this is lexicographic order on the sequence of sibling-ranks from root to key. 
        A brand-new child of the senior branch outranks a long-established child of the junior branch - 
        that is correct and deliberate; birth *time* is not derivable under partition, branch seniority is.
4. **Don't Go Out Without Your Coat of Arms** - Every key carries its whole family tree at time of creation, 
    which is a cumulative, append-only list of _potential usurpers_, a _compact lineage bundle_.  
    * A parent signing children in sequence produces `A1: [R]`, then `B1: [R, A1]`, then
     `C1: [R, A1, B1]`. Entries can **never** be removed. A senior sibling never needs to know a junior one exists; the
     junior always carries the signed acknowledgment that it is junior.
    * If a stranger ever needs to compare two valid statements - contradictory revocations, for example - one of the
      two statements must contain evidence that the other statement wins.
    * Technically, _within the identity_, all participating nodes are replicating the full identity at all times, so
      the usurpation list is just a stamp
5. **How Are You Related to the King?** - A statement presented without the complete chain of parent-signed authorizations
    is **invalid** - not "low priority", just straight-up invalid, an obvious forgery.
6. **The King Has Amnesia After Being Hit By a Frying Pan** - The only way to create a contradiction in a well-meaning 
    system is for a parent to straight-up _forget it had a kid_. This seems unlikely and laughable, but it's possible: 
    a root node creates a child entry, then dies, is restored from a backup, and then creates a new child entry. 
    Now we have **equivocation**: two child nodes who both believe they have equal claim to the throne. This is not 
    necessarily a sign of malice (frying pans are everywhere, my dude) - so we resolve this with a tiebreaker:
    * The tiebreaker is based on a random, cosmetic feature that the child can not choose for themselves.
    * The winner is the _lexicographically smallest pubkey_ - essentially, the _child with the largest birthmark_. 
    * Prince `000aaa` was born lucky, prince `bbbfff` was not. 
    * Yes, an intentionally evil king can _grind out children until they have a birthmark-winning child_, 
        then forget their oldest. An intentionally evil king can also just revoke their oldest. 
7. **The King is Dead, Long Live the King** - Any key can act as a root for its own subtree - spawning children,
    interacting with the network, and the rank-path order still totally ranks everyone without the root present.
    If two warring brothers retreat to their own network partitions, each could pretend to be the identity _in full_
    until any evidence of their brother appears. 

### Revocation: What Happens When There's a Problem

Bloody ~~revolution~~ **revocation**! Civil war at last!

There are two kinds of revocation, soon to be three: repudiation, retirement ( and exit, TODO).

Revocations are signed statements that remove a node from the identity tree.

#### Repudiation

This is The Juicy One For Murders. Someone has misused your identity from a node and it's time for that node to be _excised_.
This is a removal _with prejudice_.

* Repudiation **must come from a senior node**. 
 * (TODO: A node can also repudiate itself, co-operatively, which is different from retirement because it kills the child tree)
* Repudiation **kills all of the node's children, as well**. The entire subtree goes down with the ship.
* Repudiation **distrusts all history after a cut-point** - and that cut-point can be _anywhere_ in logical history,
    so a node can have everything its ever done since its birth struck permanently from the record.

Some of our data structures will actually allow us to rewrite history in this way: others will simply not allow
the repudiated node _further_ access.

#### Retirement

This is the less juicy one: a node is being turned off intentionally. Maybe we're dumping a computer in the trash and we want
to make sure that nobody goes dumpster diving and retrieves a valid identity, but we don't want to kill its children.

A node can **retire**.

This one's a little harder, because what stops the dumpster diver from simply minting more, evil children? 
The answer is determined by the history baked in to the retirement document: new children won't be in that history
and will be distrusted.

* Retirement **can only come from the node that is being retired**. It is self-issuable and self-issued.
* The retirement chooses a point across all of its chains and signs that with its retirement, 
    a final call sign sealing its entire history. Anything written after this point is distrusted.
* It **does not kill the children**, they can go about their merry lives. 

### Recovery Planning

Structural seniority is fixed at signing time and cannot be honestly granted retroactively -
there is no legitimate way to insert a senior key into an existing tree. 

How do we recover when things go badly wrong?

- **Recovery key, minted at identity creation.** When any new identity node is created, the node generates a **recovery key as
  an early direct child of the root**. The user takes a photo of a QR code, that photo is their golden ticket: 
  a high-ranking identity stored on their person forever.

### Recovery Flows: Passwords vs. Keys

Two failure modes wear the same "I'm locked out" face and must never share machinery. **Forgetting the node
password loses nothing cryptographic** - on an always-on node the leaf keys are sealed under the envelope key, not
the login password (see Key Storage), so the node still holds perfectly healthy keys and the user has only lost the
ability to prove themselves to *this node's web app*. That is a web-app problem. Actual key loss (dead node, lost
devices, compromise) is the rare case, and it alone runs the key-tree machinery. The load-bearing invariant for
everything below: **presenting key K may grant at most K's own authority.**

**Flow A - forgot password (common): zero chain entries, zero new keys.** The recovery photo (QR code of the
oldest-child recovery key) serves as the reset *authentication factor*: scan the QR, the node derives the pubkey, 
confirms it is the identity's **designated recovery key**, and resets the account password. The key signs a login 
challenge, never a statement; the tree is untouched.

- **Only the recovery key is reset-eligible - this is load-bearing, not convenience.** Access to a node is access
  to the keys that node holds, so
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
  time-boxed override that **No Clocks!** (Doctrine) exiles from the key tree is perfectly legal here.
- **Per-identity scoping.** A node account may agent several identities; proof of one identity's recovery key
  grants access to *that identity only* (the reset re-homes the proven identity into a fresh or proven-only
  account), or a stolen photo for one pseudonym would breach the authority and linkage boundaries of its siblings.
- **The Node Can Do Other Stuff** - there are lots of ways to reset a password, and if the node wants to instead
  offer email password reset, or password-reset-by-phone: sure! Why not! 

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
- **Encrypt the key - and now the database too** (amended 2026-07-20). The original rule here ("encrypt the key,
  not the database") held while the per-user database was a mostly-public materialized view - public chains public
  by definition, private-chain payloads *already* ciphertext - so full-DB encryption would have taxed a public view
  to protect one small secret. The persisted-views ruling (Data Layer, The Substrate) changes what the database
  *contains*: it now holds decrypted private views (document tables, annotations, search indexes), so at-rest
  encryption stops being a tax and becomes the load-bearing boundary. Every database is encrypted at rest (the
  engine's native encryption), its key a random per-database secret sealed through the keystore under the envelope
  key. The leaf private key still never moves into the database: it stays a **small, separately-stored,
  envelope-encrypted key file** (more like `~/.ssh/id_ed25519` than a DB row), and the envelope-key residence rules
  below are unchanged - the database encryption is exactly as strong as envelope-key residence, no more, and claims
  no more.
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

**Node login is a separate concern from key encryption** - two jobs that are easy to conflate. **Login** gates
*access*: username + password, **Argon2-hashed** like any web app, establishing a session that authorizes the app to
use the envelope key. **Key encryption** at rest is done by that *envelope key*, never the password. On an always-on
node the two stay fully separate - Argon2 for login, ambient machine state for the envelope key, so the node signs
while no one is logged in - and only on the opt-in **lockable personal device** are they fused (the login password
doubles as the envelope KDF), which is exactly what makes that device unable to restart unattended.

### Adding a New Node

Node B mints a fresh keypair and shows its **public key**; that pubkey travels to Node A (QR, paste, or Iroh); Node
A's authorizing key (e.g. the root) signs it into the tree with the current usurper list; the signed authorization
travels back. Node B now holds its own private key plus signed proof of membership, and the user sets an independent
local password (the leaf sealed under B's own envelope key - see Key Storage). **The private key never leaves the
node that generated it.** The shipped ceremony wraps this in two request/grant copy-pastes (NEXT_STEPS M3).

### Threat Model

| Scenario | Outcome |
|---|---|
| Any senior key survives, junior key compromised | The surviving senior repudiates the compromised key (seniority, not parenthood, grants revocation authority - rule 2). Clean eviction, regardless of whether the root or the attacker's parent is still alive. |
| Senior-most surviving key compromised | Attacker holds the top of the derivable order; no surviving key outranks it, so nobody can revoke it. User must build a new identity. This is the genuine worst case. |
| Root gone, recovery key survives | The recovery key, minted as an early child at identity creation, is structurally senior to every later key. The user brings it online and it can repudiate anything junior. |
| Compromised/duplicated key equivocates | Detected as un-orderable siblings; resolved by the deterministic tiebreaker. All honest relying parties converge on the same winner (safe, not necessarily fair). |
| Node operator is malicious | Operator can exfiltrate the one leaf key that node holds (and any secret it has decrypted). Bounded to one node; **only use trusted nodes.** |

**Residual risks we do not fully close:**

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

**Pseudonymity, Not Anonymity** (Doctrine), applied to your own siblings: no observer, crawler, or platform-level
query can connect two of your identities from protocol data - there is no protocol data connecting them. What *can* connect them: the nodes that agent or front them (below), and the old-fashioned channels no protocol
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
  hook. Change it and followers see the change on next sync. (Names are **last-writer-wins** fields; the chain of past
  writes doubles as the name history. The merge rule's one canonical home is The Ordering Contract.)
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

**Device names (settled 2026-07-23; IMPLEMENTED).** The fourth member of the family, one hop
inward: your private label for **your own keys**. A key tree rendered as fingerprints - "I've
adopted `dd7ee7d7...` but I don't trust `039def...`" - is a statement for the utterly
deranged; the tree a person can hold is *asceticbot-curtis, macbook-curtis, and the spare
key*. The pieces:

- **Storage is a register collection** (`devices`, on general-private): key = leaf pubkey hex,
  value = the label, LWW. Synced to all the identity's own nodes by the existing member gates
  and structurally withheld from strangers - the greater internet never learns what you call
  your laptop. Renaming is an ordinary register write; no bespoke machinery.
- **Nodes carry names; keys are born labeled.** Every node has a configured name
  (`RINGTOME_NODE_NAME`; defaults to the machine's hostname - a desktop node is called what
  the computer is called - and a public operator sets the domain). Identity creation labels
  the founding key (the root doubles as the creating node's working leaf); an adopting node
  labels its own new key as its **first authored write** on the identity - a birth
  certificate. The recovery key gets no label: it is a *role*, rendered by rank ("the spare
  key"), and storing what is derivable from structure would be a second source of truth.
- **Disambiguation is derived, never stored.** Two visible keys sharing a name render with a
  pubkey-derived shortcode suffix (`macbook-curtis · 4f2a`), UI-side, only on collision. The
  common collision is *time*, not simultaneity: revoke the macbook, re-adopt the macbook, and
  history holds two keys both honestly named "macbook."
- **Names are pointers, never authority - enforced at the ceremonies.** A label is never the
  argument to anything: revocation targets pubkeys, confirmations echo the fingerprint and
  identicon. Any member device can rename any key (it's a shared private register), so a
  compromised-but-unrevoked device can vandalize labels - recoverable (history is on the
  chain), and a repudiation retroactively quarantines the hostile key's renames along with
  everything else it signed: label vandalism heals itself.

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
link); and stylometry needs no network access at all. This is why the promise is **Pseudonymity, Not Anonymity**
(Doctrine).

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

Two consequences:

- **A serving-follow is public.** If your follow causes your node to front an identity, that fronting appears in
  pkarr records. The UI must distinguish "follow quietly" from "follow and help host" or users will leak interest
  they meant to keep private.
- **This bounds operator liability.** A node operator's exposure is limited to what their own accountable users
  pulled in - a defensible position in a way "we rebroadcast whatever arrives" is not.

**Scope note (clarified 2026-07-22): this policy governs *hosting*, not sync initiation.** "Pull, not push" decides
what a node fronts - it does not require an invitation before two nodes that already hold an identity exchange
entries. Triggering a sync is network maintenance: the baseline is that hosts holding information they might want
to trade SHOULD sync, unprompted (the eager-push and anti-entropy loops do exactly this). Refusing contact for
specific identities is a legitimate future per-operator policy dial, not the default posture; the open question it
raises - a malicious operator spraying sync requests - is tracked in NEXT_STEPS (sync-request flooding bounds).

---

## Follows, Friendship, and Invitation

There is one relationship primitive: the **follow**, an Interest edge (a content subscription). "Friend" is not a
protocol object - a friend is a **mutual follow**, composed, exactly as a persona is just an identity. The one
guardrail carried down from the trust layer: the cozy word must never leak trust semantics. A follow (mutual or
not) ships zero Trust; the vouch stays its own scarce, deliberate act.

### Edge-Endpoint Visibility

Fully public follow graphs are how "Person X follows Guy We All Hate" happens; fully private ones make "do they
follow me back?" - a thing people legitimately want - impossible. The resolution is a principle every future
relationship edge will face:

**An edge is visible to its endpoints by default, invisible to everyone else, and any wider publication is a
separate, explicit act.** The controversy was never the endpoints knowing; it was third parties enumerating.

Mechanically, a follow has **three disclosure tiers**, chosen per-follow:

- **Quiet** - the follow lives on your private chain (synced only among your own nodes); you fetch their public
  content and tell no one. (The private-chain mechanism carrying it is implemented; the follow type itself is 4S.)
- **Tell them** - additionally, a signed "I follow you" statement is delivered **to the target's nodes only**,
  who store the receipt on their own private chain. This is the member-proof pattern generalized: *prove you are
  the subject of a datum, receive the datum.* Nobody can ask "who does A follow?" or "does A follow X?"; only
  "does A follow **me**?", and only by being me. Honest limit: a signed statement proves it was true when signed
  - unfollow is silent and receipts go stale. That matches the social norm every network's users quietly rely
  on, and endpoints who have already disclosed to each other can re-ask cheaply for freshness.
- **Help host** - the serving-follow: necessarily public (fronting appears in pkarr records regardless), per the
  Rehosting Policy above. The UI must keep this tier visibly distinct or users will leak interest they meant to
  keep private.

**Friendship forms at the second disclosed follow** - both parties hold receipts, and both UIs may show the badge
to the two of them. A *publicly visible* friendship is the voluntary-linkage move (Running Multiple Identities):
a statement cross-signed by both, bilateral consent, separate act.

### The Follow Ceremony Is the Vouch Moment

Following someone is exactly the right time to ask "do you actually know this human?" - so the UI offers the
vouch (and the contact name - see Display Names) on the same screen. The discipline: this is a **fork in the UI,
never a coupling in the data**. The follow writes an Interest edge; the vouch, if taken, is its own statement.
Nothing about taking one implies the other, mechanically - or the follow-mints-Trust attack returns wearing a
nicer sweater.

### Friend Tokens and the Bootstrap Problem

New users face a circularity: to be vouched for you need an identity; to have an identity without self-hosting
you need an account on someone's node; to get an account on a well-run (closed) node you need to be trusted -
which is a vouch. The cut is physical: **a token handed over in person is admission, and the IRL handoff is a
vouch occasion in artifact form.** (Direct descendant of api_old's invite codes + `invite_chain` - the autopsy's
"most Ringtome-shaped thing in the old codebase.")

One mechanism, two products, by flags - `{admission, auto_follow, vouch}`:

- **Friend Token**: "join my server; redeeming creates your account, your first identity, a mutual follow
  between us, and my vouch for you."
- **Open Server Invite**: the same with the vouch flag off (auto-follow optional) - admission without
  endorsement.

Design rules settled now, before it is built:

- **A token binds to exactly one identity, chosen at redemption.** The redemption ceremony is one flow: redeem →
  account → first identity → the token's social payload attaches to *that identity only*. Pseudonyms created
  later get nothing, or the token becomes a linkage oracle connecting the newcomer's whole future to the
  inviter.
- **Asymmetric vouch automation.** The inviter's vouch is automatic - minting a token for a specific human, hand
  to hand, *is* the deliberate act. The newcomer's vouch back is a one-tap confirmation ("Curtis invited you -
  do you know Curtis in person?"), because they haven't taken a deliberate act yet, and vouches stay meaningful
  only if every one is an act. Both retractable.
- **The forwarded-token hazard** (you hand Dave a token; Dave posts it on a forum; a stranger redeems and
  inherits your vouch) is bounded, not prevented: single-use, TTL on unredeemed tokens (cheaply-created things
  expire unless they earn persistence - see api_old Keep #11), and a "someone joined on your token" notification
  with one-tap vouch retraction. Recoverability over prevention, as usual.
- **Provenance is kept**: who-invited-whom persists node-locally (the `invite_chain` lineage), seeding the trust
  graph's audit trail.

Sequencing: tokens + admission are node-local and buildable early (a natural companion to 4C's registration
screens); the "tell them" disclosure lane needs an inter-identity delivery path (4S, adjacent to the sync
surface); vouch payloads remain Tier 5 as planned.

---

## Authentication

### Phase 1: Username + Password (Local Only) - IMPLEMENTED (M0)

- Users register with a username and password on a connector node.
- The password gates *access* (Argon2-hashed, verified at login); key material at rest is sealed under the node's
  **envelope key**, not the password - see Key Storage, whose lockable-personal-device mode is the one deliberate
  exception. Passwords are **never transmitted over the p2p network**.
- This is the simplest possible onboarding — no email, no phone, no external dependencies.
- A node account can agent **multiple identities**: one login decrypts the leaf keys of every identity the user has
  attached to that account, and the UI offers a switcher. The account-to-identities mapping is local to the node and
  never leaves it.
- **Password reset** is the recovery photo used as an authentication factor - recovery-key-only, per-identity
  scoped, cooling-off window; see Recovery Flows: Passwords vs. Keys in the Identity System section.

### Registration Modes

Who may create an account is **per-node policy** - the dial that actually bounds a node's exposure (**Bounded
Operator Liability**, Doctrine: liability lives on the write side, whom you host and can eject, never on hiding
public reads):

- **`closed`** - no registration at all (a personal node after its owner is aboard, or a device that hosts only you).
- **`trusted`** - accounts only for identities already in the operator's trust graph; no token needed, but it needs
  the trust layer live.
- **`invite`** - **the default**: accounts are created only by redeeming a token (see Follows, Friendship, and
  Invitation - the invite token is the admission mechanism, and the same artifact carries the friend/vouch payload
  when those layers are live). The first-account-becomes-`node_admin` bootstrap is unchanged: boot, register once,
  the node is yours, and you mint tokens from there. A personal node never notices this default.
- **`open`** - anyone may register, and the node **auto-closes admission once it reaches ~150 open-access users**, so
  a personal box cannot be accidentally dogpiled into a public utility. Allowed on purpose - some operators will
  throw caution to the wind with their eyes open - but it is an **explicit, loudly-named opt-in**, never a default a
  fresh operator discovers they'd made. An open-registration node is a public-facing role and inherits the
  public-exposure gates (the security pass, and the abuse tooling that gates open modes - see the ship tier):
  liability stays a decision someone made on purpose.

Today's rate-limited open registration becomes the `open` setting; the dial itself and tokens are early,
node-local work (no new protocol).

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

### Sequencing: The Graph Grows Before the Features Arrive (settled 2026-07-09)

Trust is the thesis, so it cannot ship *after* the social launch - and, decomposed honestly, it doesn't need to.
The **vouch payload** is a signed statement (private chains and the store layer already exist to carry it) and the
**flow computation** is known, decades-old math (Advogato) over a cozy-scale graph - pure crate code,
property-testable today. What is genuinely research is knob *calibration* and Sybil *validation*, and that is the
harness's job as an instrument and standing tripwire - **never a launch gate**, because the low-payoff principle
above already covers shipping ahead of exhaustive validation: v1 trust gates only annoyance-priced, reversible
surfaces.

The timing insight: **trust graphs need history, so the graph must start growing before the features that read
it.** Vouch statements go live with the invite tokens (Follows, Friendship, and Invitation) - every IRL token
handoff quietly writes an edge, and by the time feeds and floors arrive the graph is a living thing, not a cold
start. The seed crystal, not the retrofit. Consequently the social launch (Tier 4S) includes the trust floor on
its first low-stakes surfaces: social ships wearing its thesis. Deferred with honest labels, as refinements of a
running system: credibility (needs track records that don't exist yet), interest/taste recommenders,
graph-privacy resolution controls, and harness-driven knob refinement.

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
  ├── documents chain          (encrypted: versioned document headers - the notes app's spine)
  ├── doc-meta chain           (encrypted: annotations + tags - private facts about documents)
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
die with the device - irreducible in any offline-first design. Mitigations: **eager push** (implemented 2026-07-22,
`net::resync`: a node pushes fresh local writes to every known peer after a short debounce, shrinking the window to
seconds-while-connected) and an **unsynced indicator** (the authoring device knows which of its entries no peer has
acknowledged - surface it like an unsaved document; still future). Before retiring a lost key, survivors run a **straggler sweep** - gossip for entries above their known
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

### Displayed Time vs. Claimed Time

Timestamps carry no security weight, but they carry plenty of *UI* weight - "posted May 2, 2031, 3:35 PM" is an
important detail a human reads as fact, and individual machines' clocks are reliably unreliable (VMs, localization,
user preference; ask anyone who has shipped a networked client). This is **No Clocks!** (Doctrine) made concrete:
**there is no network time synchronization, ever, and admissibility never consults a clock** - a sync-to-peers scheme hands your
eclipse attacker your watch, and a gate that rejects "future" entries makes admission depend on the local clock,
forking honest nodes' views. Instead, each trust boundary handles time defensively at its own edge:

- **Authoring clamp (implemented).** A node signs `max(now, own chain head's claim)` - a key's own chain never goes
  backwards in claimed time. This closes a real LWW footgun: one write from a fast clock would otherwise beat every
  later, correctly-stamped write until reality catches up. (Equal-stamp ties fall through to seq, true authoring
  order.)
- **Receipt bound (implemented).** Each replica records `received_at_ms` per entry - a local, unsigned,
  never-synced fact. An entry cannot have been authored after it arrived, so display logic gets a per-node upper
  bound: render `min(claimed, received)` or hedge ("claims the future").
- **Client renders against its node's clock (with 4C).** The browser is the least trustworthy clock in the system,
  and the node is already its trusted agent: the node ships its `now` in API responses, the client computes a
  display offset. Lightweight client-local time sync, one hop, entirely inside an existing trust boundary.
- **Cross-device skew is surfaced, not corrected.** If your own identity's other node signs claims well past
  `received_at`, that's a UI notification ("your Pi thinks it's Thursday"), never a silent rewrite - the claims are
  signed, and other people's confusion is their signed assertion to own.

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

Enforcement follows from one fact: the revoked key is **still attacker-held**, so `seq <= final_seq` alone proves
nothing - the attacker can sign a fresh under-ceiling prefix at will, with perfect signatures. The sealed prefix is
therefore **a unit, verified by its hash**, and three rules make that concrete (implemented in `crown.rs` and the
sync gate):

- **Sealed prefix as the credited unit.** The key tree credits a ceilinged key's statements - child authorizations,
  revokes - only from a prefix held through `final_seq` whose entry there *is* `head_hash`. Contradicted, incomplete,
  or never-anchored chains credit nothing: fail closed, authority must be proven. A hash mismatch at the anchor is
  cryptographic proof of forgery and is recorded as evidence.
- **Seal-or-nothing at the gate.** Under-ceiling entries are stored only when stored ∪ incoming assembles the
  complete sealed prefix (walked down by hash link from the anchor itself). No provisional acceptance of partial
  under-ceiling prefixes - that is exactly the hole a still-held key forks into. Refusal is retriable and honest
  sync converges: the revoker's own nodes hold the prefix whole and ship it whole.
- **Proven-forgery eviction.** The attacker can race its forged prefix in ahead of the revocation. When the ceiling
  arrives, any *stored* chain whose entry at `final_seq` contradicts the anchor is deleted outright. This does not
  bend monotonic memory: that promise protects **honest history** from being forgotten, not cryptographically-proven
  fabrications - the revoker's signed anchor and the stored row cannot both be honest at one seq, and the anchor is
  the senior word. Incomplete-but-consistent stored prefixes stay (they may complete honestly later; the gate keeps
  them untrusted meanwhile).

### Private Chains: Epoch Keys and the Membership Boundary (IMPLEMENTED)

Private chains hold what must sync across your own nodes and never cross the identity boundary: contact names,
quiet follows, trust edges, settings. "Private" means *which sync boundary*, not *stored in one place* - so the
mechanism has two independent layers, and both are load-bearing:

- **Encryption (protects the bytes).** An identity has a sequence of **epoch keys** - 32-byte symmetric keys.
  Epoch `N` is published as a `key-epoch` entry on the identity-public chain, carrying the fresh key **sealed
  separately to every member** (NaCl sealed box to each member's X25519 encryption pubkey). Private records are
  XChaCha20-Poly1305 ciphertext under the current epoch key, on the `private` service chain; only the epoch
  number and nonce are visible. Each leaf's encryption pubkey is **parent-attested from birth** - field 2 of its
  authorize stamp - so any member can seal to any other without a round-trip; the root's (which has no authorize
  entry) rides in epoch recipient lists from epoch 0. The recovery key derives *both* its keypairs (signing +
  encryption) from the one photo seed, and is a recipient of every epoch - the offline spare key can always read.
- **The sync gate (protects the metadata).** Private chains are exchanged only with peers presenting a **member
  proof**: the peer's leaf key signs (root, its endpoint, our endpoint), channel-bound to the iroh connection and
  worthless replayed elsewhere, verified against the local tree (leaf must be Active). Unproven peers get neither
  private entries nor private *frontiers* - the count and cadence of private activity is itself private. Both
  directions enforce it (verify-then-reveal: a requester's first Hello advertises public frontiers only, since
  the responder's membership isn't known yet; a proven responder re-offers and the duplicate-skip absorbs it).

**Membership transitions are key events:**

- **Adoption**: the granting node re-seals every historical epoch key to the newcomer (one `key-epoch` entry per
  epoch, recipient list of one). A member is a member of the whole history; a new device materializes the full
  private state back to epoch 0.
- **Revocation - either disposition - rotates**: a fresh epoch sealed to every Active member except the target.
  The departed key's server still physically holds its old epoch keys, so the guarantee is exactly this: **it
  reads its era forever; the future is closed.** And because the revoked leaf stops being Active, the gate stops
  shipping it post-rotation ciphertext at all - forward secrecy backed by refusal, not just math.

Honest wrinkles, accepted for v1: two nodes racing a rotation can both mint "epoch N" (single-writer chains, so
not a fork) - readers try all keys for an epoch and the AEAD tag disambiguates; a member whose encryption pubkey
never reached the chain is skipped by rotation (fails closed, loudly logged, recoverable by re-seal); revocation
rotation happens on the revoking node and reaches others by ordinary sync, so a partitioned member keeps writing
under the old epoch until it hears - members hold old keys, so nothing is lost, but the boundary is eventual, not
instantaneous. The `identity-private` service is reserved and gated but has no writer yet.

### Open Items

- **Deletability: split headers from content from day one** (**Immutable Chains ≠ Immutable Content**, Doctrine). Chains store entry headers + blob hashes; content
  lives in droppable blobs (`iroh-blobs`). "Delete" = tombstone entry + drop the blob: chain integrity survives
  (headers remain), content is genuinely gone from cooperating nodes. The *fact* of a post at seq 41 is permanent;
  its content is not. Also keeps chains tiny. Retrofitting this split later is a protocol break, so it is v1.
- **Blob availability must not gate chain validity.** An entry whose blob is unfetchable (dropped, never shared)
  still validates as a chain link - validation is signatures and hashes only; fetching is best-effort.
- **Snapshots.** Replaying years of entries to materialize state is the classic cost of this architecture, and
  signed checkpoints solve it - plus two more problems at the same door: they make fold-based views (registers,
  sets) **suffix-safe** (fetch snapshot + tail instead of all of history), and they make prefixes **droppable**
  (a fronting node keeps snapshot + tail and garbage-collects the ancient entries; stacks with the header/blob
  split). Expect them to matter for performance broadly - even the profile, where history exists but nearly every
  client just wants the current state fast. The design, settled 2026-07-08: a snapshot is an ordinary signed entry
  (blob-split - state can be big) written by one of the identity's own nodes, containing the folded state **with
  its LWW stamps** (`(timestamp, seq, hash)` per key/element, so tail ops merge against it by the same total order
  as everything else) plus `(chain, seq, head_hash)` **anchors** pinning the exact cross-chain frontier it
  summarizes. Trust: the author is already the sole authority over its single-writer content, and any full-history
  replica (the identity's own nodes, at minimum) can replay the chains against the snapshot and hold signed,
  checkable proof of a contradiction - the same self-incrimination pattern as forks. **Red line: snapshots never
  cover the identity chains** - a "trust my summary of the key tree" entry would bypass rank-path validation;
  authority is always recomputed from full chains, only content state gets checkpointed. Not needed until chains
  are long; the entry format's additive fields mean no protocol prep is required.
- **Fork aftermath.** After the tiebreaker picks a winning fork (the innocent stale-backup case), the losing fork's
  entries are invalid. The client should offer to re-sign that content onto the winning chain as new entries, or
  the recovery silently eats the user's posts. Needs specifying before the recovery UX ships.
- **Device-attribution metadata.** Chains are per-key and keys are per-device, so a patient observer can see which
  device authored what. Same honesty class as the timing-correlation caveats in Hosting.

---

## Groups: Identity-Shaped, and the Complexity That Adds (SKETCH)

**Status: sketch, not doctrine.** Nothing here is committed; it is written down because the exercise turned up
real defects in machinery that *is* committed (see *The Adult In The Room*, at the end - the honest yield of this
whole section). Groups are not on any tier and want none of this built yet.

**The shower thought that started it:** a group of thirty people wants exactly what one person's five devices want.
Members join by invitation, members can be kicked, the kicked stop reading, there is shared private state and a
public face. That is the key tree, the revocation rules, and the epoch-key membership boundary - already built, all
three. **A group is an identity, and the machinery is already there.** Almost.

### What maps for free

- **The epoch-key membership boundary already is a group key.** "Sealed separately to every member," members trial-
  decrypt, and revocation of either disposition "rotates: a fresh epoch sealed to every Active member except the
  target." Read *member* as *a person* rather than *a device* and it is a group with forward-secure ejection,
  unmodified.
- **The member proof already is the group's sync gate.** Unproven peers get neither private entries nor private
  *frontiers*, so the volume and cadence of a private group's traffic is itself private. That property would have
  been expensive to design and is simply inherited.
- **Everything social is inherited.** A group has a profile, a posts chain, followers, slugs, taxonomies,
  publication-is-an-act. Following a group is following an identity. The notes app's version DAG was built so one
  person's devices could diverge without losing words; point it at thirty people and it is a collaborative wiki with
  the same guarantee, no changes.
- **Governance arrives pre-answered, and the answer is IRC.** Rule 2 makes seniority the entire authority relation
  and rule 5 makes it a *total order computable from local data*. For thirty people that is a strict pecking order:
  no peers, the seniormost can eject anyone, and no one can eject them. For a person this is obviously correct
  (your root outranks your laptop). For a group it is a **monarchy with a publicly computable line of succession** -
  which is a founder and their ranked ops, which is a sysop and their co-sysops, which is *precisely the Old
  Internet's governance model*, delivered exactly. Rule 6 even hands over succession: if the root vanishes, "any key
  can act as a root for its own subtree," so the group outlives its founder. Formation ceremony falls out for free:
  mint the group root, spawn N ranked co-founder keys, vault or destroy the root.

### The one structural decision: the roster references identities, it does not contain them

The tempting move - the group's tree *contains* its members' identity trees - is not constructible. A root key is
unparented by definition, and "structural seniority is fixed at signing time and cannot be honestly granted
retroactively," so no existing identity can be grafted under a group root. Two weaker versions were tried and both
fail on the same rock:

- **A key per member** (`root -> M_alice`, held by Alice on all her devices, epoch sealed to `M_alice`). Broken:
  the key is not device-scoped, so a compromised laptop *is* Alice, permanently. Worse, `M_alice` lives in the
  **group's** tree, so only a group senior can revoke it - Alice cannot remedy her own compromise, and the fix has
  to travel between trees.
- **A subtree per member** (`root -> M_alice -> M_alice_laptop, ...`). Fixes the sealing granularity but only moves
  the problem up a level: `M_alice` must still live on every device to authorize new ones, so a stolen laptop holds
  it and is thereby senior to Alice's *other* group keys. It also makes Alice mirror her device set into every group
  she belongs to, by hand, forever.

**The shape that works: the group's roster names member identity *roots*, and members act with their ordinary
personal keys.** The group holds no per-member keys at all. Alice proves membership with the chain from her leaf to
her own root (which she already has, for everything else) plus the group's admission entry for that root. The
group's epoch seals to **each of Alice's Active leaf encryption pubkeys**, read from her identity-public chain -
where they are parent-attested from birth, so no round-trip is needed.

The distinction that makes it work is the **unit of sealing**. Seal to a *member* and you cannot revoke part of
one. Seal to a *device* and revocation already works, because devices are exactly what the existing machinery
revokes. Alice repudiates a laptop: one statement, on her own chain, and every group she belongs to independently
*observes* it and rotates. One event, N reactions, **no directive crosses a tree boundary** - which is why nothing
cascades, conflicts, or double-fires.

Consequences:

- **A roster entry is a pointer, not a key.** Nobody holds it; there is nothing to steal. The secrets are all leaf
  keys, already device-scoped and already revocable.
- **Pseudonymous membership needs no invention**: join under a pseudonym identity. "Identities are cheap and users
  are encouraged to run several" already shipped that.
- **Adding a device costs the group nothing.** Alice holds the current epoch and seals it to her own new phone -
  the existing adoption flow, with Alice as the granting node.
- **Cost:** the group must sync every member's identity-public chain and recompute recipients from their Active leaf
  set. And group rotation is now triggered by events on *other people's* chains - a new kind of trigger, but an
  **observation of a public fact**, never a command.

### The invite tree, and what a repudiation blows up

Alice invited Bob; Bob invited Carla and Dave; Dave invited Edna. The invite edges are authority-conferring
signatures, so the group's authority structure *is* the invite tree.

Bob repudiates the key that invited Carla. **Carla's membership evaporates with no further act by anyone** -
repudiation already says history past the cut-point is distrusted and the subtree dies, and an admission is a
signature like any other. The blast follows the bad **edge**, not the bad **person**: if Dave was invited by a
*different* Bob key, Dave and Edna are untouched.

Two things this exposes:

- **The doctrine's wording is too narrow.** *Revocation Types* describes the blast in terms of "child
  authorizations" - a key-tree word. The rule is really that repudiation distrusts **every authority-conferring
  statement** the key made past the cut-point: child authorizations, group admissions, vouches, trust edges. An
  implementer reading it literally will kill the subtree in Bob's key tree and leave Carla sitting happily in the
  group. **This is a defect in shipped doctrine, not a group problem.**
- **The blast is fail-closed, which is the right way round.** The dangerous default (Carla silently stays, admitted
  by a key we now believe was in an attacker's hands) costs an action; the safe default is free. What Bob must think
  about is not "who else do I eject" but **"who do I re-invite"** - the existing "legitimate children are
  re-authorized from a surviving senior branch" move, and a repudiation should be able to carry those
  re-affirmations atomically so nobody gets ejected-then-readmitted. The UI owes Bob the blast radius before he
  presses the button; the group can compute it exactly.

### Validity is computed; secrecy is minted

Carla's *authority* dies instantly and for free - every node derives it from the chain, and from that moment her
signatures confer nothing. But **Carla still holds the current epoch key**, and no derived fact can take it from
her. Somebody has to mint a fresh one.

**She is silenced immediately and deafened eventually.** The dangerous powers (speak, invite, vouch) evaporate on
the instant; the passive one (read) lingers. That is the right way round, but the window is real, and - because the
repudiation is public - **Carla can watch it open.**

A *direct* revocation can close the window to zero by carrying its replacement epoch. A *derived* ejection cannot:
Carla's removal is not a statement anyone signed, it is a consequence everyone computed, and consequences cannot
carry keys. So the repudiator should rotate every group it ejects someone from, in the same act, where it can - and
where it cannot (the repudiating senior is an offline root with no group state), some remaining member's node must
notice an **ejection with no matching rotation** and mint one. Honest bound: Carla reads until that lands. The cost
is small, because she already has all the history; rotation only ever protected the future.

### Supergroups: public composition nests, private composition does not

A supergroup's roster names *group* identity roots, and its epoch seals to those groups' Active leaves - which are
**the nodes agenting the group**, not the humans inside it. To make a supergroup's private lane readable by members,
someone must re-encrypt it into each group's private lane; that re-encryption puts the supergroup's secret on every
member's laptop and makes its forward secrecy hostage to the most careless of hundreds. It also demands a *rekey
without a revocation*, which nothing in the model can verify.

So the boundary is a mechanism, not a judgment call: **the private lane reaches exactly as far as the epoch seals,
and no further.** Public composition - federation, shared feeds, co-signed announcements, webrings of groups -
nests freely and forever, because there is no secret to fan out. This is the same self-selection the epoch machinery
shows everywhere: it works precisely at the scale where a shared secret is meaningful, and gets expensive precisely
as it stops being.

### The Adult In The Room (the actual yield)

Groups did not break the epoch model. **Groups made visible that the epoch model was already underspecified**, at
the identity level, where it is shipped and IMPLEMENTED. Every item below is a live defect today, with one person
and five devices:

1. **Nobody is named as the minter.** "Revocation - either disposition - rotates" says a rotation happens; it never
   says *who performs it*. For a senior-issued repudiation the revoker is obviously online and can. For a
   **self-issued retirement** - which is explicitly allowed - the retiring key cannot, because an epoch you mint is
   an epoch you know. The one hard rule, and it is not written anywhere: **you may not sign the epoch that excludes
   you.** Everything else about rotation authority follows from that single line.
2. **Rotation is a free operation, and trying to gate it is a trap.** The tempting fix - "an epoch is only valid if
   it rides on a revocation" - buys nothing, because revocations are free to manufacture: rule 1 lets any key mint a
   throwaway child and rule 2 lets it immediately repudiate that child, yielding a well-formed revocation to hang a
   self-minted epoch on. And the fear was misconceived anyway: an Active member minting an epoch *they know* has
   gained nothing, because they already held the current one. **What secures rotation is that the recipient list is
   derivable, not that the minter is authorized** - every node computes the Active recipient set itself, so a
   rotation that quietly drops a member, or smuggles in a non-Active key, is malformed and rejected by everyone.
   Recipients are verified, never asserted. Given that, who mints does not matter, and rotation frequency becomes a
   *performance* question rather than a security one.
3. **Rotation liveness has no owner.** If nobody is obliged to mint, the departed read until somebody feels like it.
   The total order is already a leader election waiting to happen: any Active member may mint, seniority breaks
   ties, and a **rank-ordered backoff** (seniormost acts immediately, juniors wait and step in only if no senior
   has) yields one rotation in the common case, harmless duplicates otherwise. Duplicates *are* harmless - both
   epochs are fresh, neither is known to the target, and the junior one is discarded on convergence.
4. **Repudiation's blast radius is described in key-tree vocabulary** and must be generalized to every
   authority-conferring statement (above). Today, a repudiation would leave the wrong people inside things.
5. **A departing member wants a disposition that does not exist.** Retirement honors history but **the subtree
   lives** - correct for a root migrating off its first server, and exactly backwards for a person leaving a group,
   whose devices would remain members after them. Repudiation kills the subtree but quarantines the history and is
   senior-only. Departure wants *honor the history, kill the subtree, self-issuable* - a third disposition on the
   same statement type, and cheap. The distinguishing question turns out not to be the disposition at all, but
   **whether the retiring key is the top of a tree that should continue, or a member of someone else's tree that
   should not** - and the current text cannot tell those apart.
6. **"Because the key is not adversarial"** underwrites self-issued retirement. Safe when you hold both ends. Not
   safe for a person storming out of a community - and the tool for a hostile exit is repudiation, which is
   correctly senior-only. So friendly departures are self-service and hostile ones need a sysop. That is the right
   answer; it should be a stated one.

**The verdict:** groups being identity-shaped is real and worth the shower thought - the social layer, the sync
gate, and the governance model all arrive for free. But the *revocation-and-rotation* half of the identity model is
carrying more weight than it was specified to carry, and pointing it at thirty people is simply what made that
audible. **Fix it at the identity level, where it is already load-bearing and already shipped.** Groups can wait.

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
5  timestamp:  uint <= i64::MAX  // author's claimed wall-clock, ms since epoch; ADVISORY - never a security input
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
  decision to it. Though the wire type is a CBOR uint, a conforming reader MUST reject values above `i64::MAX`
  (and a writer never produces them): every clock in the system is signed 64-bit milliseconds, and admitting the
  astronomical upper half would only hand implementations a wrapping-cast footgun for zero representable dates
  anyone will live to claim.
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

### Slugs, Views, and the Personal Address Bar (settled 2026-07-09)

Raw addresses are cryptographic and ugly (`ringtome://3f9a.../public/8c2e...`); humans get two
readability layers, one personal and one author-owned - both pointers, never authority (per
Naming, above):

- **Personal display names in URLs.** The client renders contact names in the address bar -
  `ringtome://jeff/public/...` - a personal-only DNS. The load-bearing rule is
  **canonical-on-share**: aliases are display-only; copying or sharing always serializes the
  full identity form. Your local "jeff" never leaks into a context where jeff is someone else.
- **Slugs: an author-owned mutable namespace over immutable content.** A public LWW register
  maps slug → doc_id, so `ringtome://jeff/public/my-thoughts-on-cheese` resolves through the
  author's slug register to a document. Because the mapping is a *register*, retargeting is
  invisible to readers: slug an essay today, repoint it at a taxonomy when it becomes a series
  tomorrow - inbound links survive reorganization without redirects, something the web never
  managed. Slugs are author-scoped, so there is no global namespace to squat (same posture as
  contact names).
- **Resolution behaviors are author-declared.** A slug pointing at a plain document renders it.
  A slug pointing at a *taxonomy* consults the taxonomy's own `default_view` field: `index`
  (the auto-generated directory listing - the cozy Apache move) or `latest` (the blog move) -
  the author's choice, versioned like everything else. Readers override with **path-segment
  views**: `.../my-thoughts-on-cheese/latest`, `/earliest`, `/root`, `/index` (path segments,
  not `:suffixes` - the colon is already spent on identity hints). The view vocabulary is the
  same family as Marquee's `:::computed` roles: one set of taxonomy-view functions consumed by
  URLs and page widgets alike.
- **Liveness composes as expected**: a slug URL is maximally live (register → taxonomy →
  materialized head, every link mutable by the author); pinning any step means using the id or
  hash form for that step. The live/pinned duality, end to end.

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

---

## Content Markup: Fanciful, Constrained, Never HTML

User-authored content (pages, posts, profiles) is written in a **custom, deliberately weak markup language** - 
([Marquee](https://github.com/cube-drone/marqueemarkup)) a closed vocabulary in the spirit of BBCode/gemtext, 
with the clumsy expressiveness of the Old Internet as an explicit
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
  arrive via sync, and nothing upstream can be trusted to have validated them - **Every Byte From The Network Is
  Hostile** (Doctrine), markup included.
- **The language is [Marquee](https://github.com/cube-drone/marqueemarkup)** - a standalone product (Ringtome is its first embedder,
  not its owner), MPL-2.0 parsers, CC0 spec. Ringtome consumes it through an **embedder profile**: the language
  defines what a construct *means*; the profile defines what it may *do* here.
- **Links out are free; embeds are baked.** Scheme policy is **embedder profile, never grammar** - Marquee admits
  regular-web targets (a language that can't link a picture is useless outside Ringtome), and Ringtome's profile
  decides what they *do*. A link is the reader's choice and is free; an embed is *ingested* into a local blob at
  authoring time. **Not Hermetically Sealed** (Doctrine) at the markup layer. Full mechanism: *An Embed Is an
  Ingest*, below.
- **Protocol fit: the registry names the codec, never the dialect.** The type is `marquee` - unversioned, meaning
  no more and no less than "hand these bytes to a Marquee parser." The **dialect version travels in band**
  (Marquee's own `#!marquee N` line, absent meaning 0), and Ringtome never speaks it. This is forced, not stylistic:
  markup payloads are content-addressed blobs, and a blob's meaning must not depend on which entry referred to it -
  a version in the envelope would let the same bytes parse two ways from two referrers, which is a
  parser-differential manufactured by hand, in the one place this document least wants one. It is also the only
  version the parser actually reads: an unknown dialect is Marquee's single refusal, and a tag no parser consults is
  dead metadata inside a signed structure, which is worse than none.
  **The dividend: new vocabulary is not a wire-format change.** Adding a guestbook widget touches no registry, no
  version, no protocol - unknown vocabulary *shrugs* (renders its children as plain content, grants no capability),
  and that per-construct degradation is a strictly better forward-compatibility mechanism than a per-document
  version negotiation. Only a grammar change bumps the dialect, and a grammar change is refused rather than skipped.
  A second markup, if one ever earns its way in, is a second type id - which is what a codec registry is for.
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

### An Embed Is an Ingest (settled 2026-07-12)

The web conflates two gestures that want opposite treatment. **A link is the reader choosing to go somewhere; an
embed is the author causing the reader's client to fetch.** Ringtome separates them, and treats the second as what
it actually is: an upload.

- **Links out are free** - no dial, no interstitial, no reveal button. The reader chose to follow it.
- **Embeds are baked at authoring time.** The moment a draft says `![cat](https://example.org/cat.jpg)`, the node
  fetches it, runs it through the crunch filter (see Fidelity Caps), stores the result as a blob, and rewrites the
  target to that local blob. The author sees the crunched image immediately, in their own editor - which is also
  the only humane place to show someone what the crunch did to their picture. **An embed is an ingest**: pasting an
  image URL *is* an upload, and the UI should say so plainly, because the storage it consumes and the liability it
  creates are both real.
- **Past the size cap it isn't an embed, it's a link.** Ringtome declines to fetch-and-bake beyond a ceiling,
  exactly as every forum since phpBB has declined oversized uploads. Point at a multi-gigabyte file all you like -
  it will be a link, and the client will tell you it became one.
- **The origin URL rides along as provenance, permanently.** Mandatory metadata on every baked embed, not a
  right-click nicety. It is attribution (you have just copied someone's picture), it is the "go to original"
  affordance, and - load-bearing - it is what makes the blob *droppable* later (NOTES_APP.md, Media Retention).
- **Rich players are the honest exception.** A YouTube or Spotify embed is not bytes we may have; it cannot be
  baked. Those stay live and third-party, and looking at one tells Google you looked. The onebox card is a
  click-to-play surface by construction, so nothing phones home until the reader presses play - privacy arriving as
  a side effect of good page-weight design, which is the only kind anyone leaves switched on.
- **The bake happens twice.** In a draft the blob is epoch-encrypted; at publication it is re-encoded as a public
  blob and signed, exactly as the prose is - **Copy, Don't Flip** (Doctrine), applied to pictures. Draft original
  and published image are distinct blobs, independently droppable.

**What the bake buys** (none of it sold as privacy): no reader ever fetches a stranger's server, and it needs no
setting because nobody opts out of *fast*; link rot can't break a published page; the scanning machinery can see the
bytes; the crunch filter applies to *all* media, so **Everything Always Crunched** survives the open web. And
recentralization closes on its own - to a network that ingests images on sight, an external host is a **clipboard,
not a CDN**, so there is no `ringtome-imgur.com` to build.

**The honest cost:** the operator now *hosts* what their user embedded, so a vile embed becomes their problem in a
way a hotlink wasn't - the correct place for it to land (operator exposure is already bounded by their accountable
users), but a real increase, and a bake is a copy, so provenance is the least we owe.

*(This retired two earlier rules: embed-targets-unrepresentable-in-grammar, and a reader-facing proxy/direct/no-fetch
dial. The dial defended a promise the doc declines to make - **Pseudonymity, Not Anonymity** (Doctrine) - and on a
self-hosted node it was theater, since the proxy's IP is the reader's IP.)*

---

## Data Layer

### Local Database Strategy

Each connector node maintains:

- **Node database** (`node.db`): Node configuration, known peers, replication state, network metadata.
- **Per-user databases** (`users/<pubkey>.db`): Each user's data lives in their own database file — a **local
  materialized view** of that user's signed sync entries. The database file itself is never transmitted: when a user
  connects to a new node, the node syncs the user's entries via the Ringtome sync protocol (validating each against the
  key tree as it arrives) and builds its own database from them.

### Why Per-User Databases?

- **Isolation:** One user's data can't accidentally leak into another's queries.
- **Sync granularity:** replication scope is naturally per-user. A node only syncs (and stores) the users it agents
  or fronts.
- **Disposability:** because the database is a materialized view, it can be rebuilt at any time from the signed
  entries — after a schema migration, a corruption, or a Repudiation Revocation that retroactively quarantines
  entries. The signed entry log is the source of truth; the database is a query-shaped cache of it.
- **Offline-friendly:** a user's database is fully self-contained for serving and authoring while disconnected.

### The Substrate: Turso, Encrypted at Rest (settled 2026-07-20)

The database engine is **Turso** - SQLite rewritten from scratch in Rust (SQLite's dialect and
file format, MVCC, native at-rest encryption, Tantivy-backed full-text search). The move from C
SQLite + sqlx is a substrate swap, not a model change: everything above about what the databases
*are* survives verbatim. Why, honestly ranked:

- **Encrypted at rest, natively.** The persisted-views ruling (below) puts decrypted private
  state on disk; Turso encrypts the whole database file, with keys we wrap through the keystore.
  The alternatives were SQLCipher (a C fork of SQLite plus vendored OpenSSL - rejected on
  dependency grounds, explicitly not quality grounds) and hand-rolled sealed snapshots of
  in-memory databases (rejected: fails multi-tenant memory, next bullet).
- **Memory becomes cache-shaped, not dataset-shaped.** Views live on disk behind a page cache.
  Any design that materializes views into RAM - recomputed per read, or in-memory databases
  sealed to disk - holds every resident's *full* view in memory simultaneously, and a
  multi-account node on small hardware dies exactly there.
- **One toolchain.** The stack becomes Rust end to end; the database stops being the one C
  dependency the no-new-toolchains instinct had grandfathered in.

**The risk posture, stated plainly.** Turso is beta. This stack ships iroh and a from-scratch
media pipeline, so "experimental" is a consistent appetite - but beta is only acceptable in
front of *recoverable* state, and that is made true by construction rather than assumed:

- **The raw-entry journal.** Every entry accepted into a database is also appended, verbatim, to
  a flat per-identity journal file. Entries are already immutable signed CBOR envelopes (private
  payloads already ciphertext) - the journal is just what sync would send, written down, so it is
  nearly free. With it the entire SQL layer is derived state: entries tables, views, everything
  rebuilds by replay. The journal is deliberately plaintext: entries self-protect (signatures
  for integrity, epoch ciphertext for payloads), and a recovery artifact must be readable with
  zero key material - its confidentiality posture is the disk's, an accepted, named trade (the
  at-rest metadata of private activity). This is what covers the **single-device user**, whose
  chains would otherwise have exactly one copy sitting on a beta engine. Node-local non-chain
  state (accounts, password hashes, the ingest queue) is tiny and low-write: journaled or
  periodically dumped, same discipline.
- **The escape hatch is the export tool, not the file format.** Encryption voids "worst case,
  open the file with real SQLite" - stock SQLite cannot read an encrypted Turso database. The
  decrypt-and-dump tool and its CI dump/restore upgrade gate are **ship gates, not current
  invariants** (re-scoped 2026-07-22 by the User-1 rule, STYLE.md: until an install base
  exists there is no data to protect, and a Turso bump today may simply wipe and rebuild from
  the journal - which is what recovery actually rides anyway). Turso's version is pinned
  (`=0.7.0`) for reproducibility, not safety; the tool lands with Tier 6, before User 1's data
  exists to lose.

**Views persist now (the persistence dial, revisited).** The store's original discipline - views
recomputed in memory per read, never persisted, because "a decrypted view on disk would be a
second secret" - was always an argument about *plaintext at rest*, not about persistence. With
the database itself encrypted, that objection is answered structurally, and views become
ordinary tables: normalized and query-shaped (per-document version facts, annotations, tag
membership, full-text indexes over titles and descriptions), folded **incrementally** by
statement-atomic stamp-compare upserts (the `profile_view` pattern, generalized), watermarked
per chain (`(author, service) → seq`) so boot fast-forwards from the last fold instead of
replaying history. What survives untouched is the deeper invariant: **views are disposable** -
pure functions of the log, rebuilt by drop-and-replay, never a source of truth. And version-DAG
*resolution* (heads, logical-head folding, the merge rungs) stays in Rust: SQL holds facts, not
judgment - graph-shaped, rung-ordered logic is miserable as SQL and lives in code.

### The Store Layer (IMPLEMENTED)

Application code never touches chains directly. `node/src/store.rs` is the **data map** - one
table declaring every application variable's chain, merge rule, visibility, and materialization -
plus typed handles whose methods are exactly the CRDT's legal operations: an LWW register has
`set`/`all`, an LWW-element-set has `add`/`remove`/`elements`, an append-only log has
`append`/`page` and deliberately nothing else. The sync contract is stated once there: writes
land locally and immediately on this node's chain; reads are the merged view of all the
identity's chains; replication is per-identity, all chains at once; the only distinction is
public vs. members-only visibility. New features add a data-map row and a handle - never a sync
knob. (The identity chains are deliberately not stores: authority is not application data.)

### The File Layer

One **file object** for everything file-shaped in the system - private note bodies, public post
bodies, media - a content-addressed store of bytes built on **iroh-blobs** (BLAKE3, the same hash
as everything else). The store is content-agnostic: bytes in, hash out; it cannot tell a note from
a photo. (Born in the notes design - see NOTES_APP.md for the discovery narrative. Canonical
statement here; first implementation `node/src/files.rs`.)

- **Private files are encrypted, then stored.** A private file is XChaCha ciphertext under the
  current epoch key with a **random 24-byte nonce**, laid out self-describing
  (`epoch ‖ nonce ‖ ciphertext` - epoch numbers are already public, so readers know which keys to
  try), and content-addressed by the **ciphertext** hash. The random nonce makes every hash
  unforgeable and unlinkable: nobody - not even a member who knows the plaintext - can precompute a
  target file's hash or reverse a hash to known content. The deliberate cost: **no dedup for
  private files** (identical content encrypts differently every time). The alternative, convergent
  encryption, would dedup but hand out a known-plaintext confirmation oracle - the wrong trade for
  private data.
- **Public files are the same substrate with the encryption off.** Plaintext bytes, addressed by
  plaintext hash - so dedup returns exactly where it's safe (two posts embedding the same image
  share one blob), and serving is open because the content is public anyway.
- **Serving is ungated, because the hash is the boundary.** iroh-blobs is *dark by default*: it
  announces nothing to any DHT or index, has no enumeration primitive, and a fetch needs both the
  exact hash and a node address. Private hashes exist only inside encrypted headers, so only
  members ever hold one; an unproven peer has nothing to ask for, and would get useless ciphertext
  if it did. The one residual is **size** (disclosed to anyone holding a hash - member-bounded,
  pad-able later, ignorable for text).
- **No content discovery, ever, on either side.** Discovery is the taxonomy and identity layer's
  job: a hash never arrives naked - it arrives inside a signed document you synced, with
  provenance, and you reach its holder through the identity's serving nodes (pkarr). iroh-blobs is
  **pure point-to-point transfer**; its optional content-discovery layer stays off, private and
  public alike. Every blob is reachable only through the document that names it.
- **One global blob store per node** (iroh-blobs' redb-backed store), not per identity. Blobs are
  identity-agnostic at the storage layer (a request is a hash, carrying no identity to route on),
  and public dedup only works shared. The granularity is the mirror of SQLite's, on purpose:
  identity-scoped relational *ledger* → per-identity SQLite, precious, backed up; content-addressed
  reconstructible *cache* → one node-wide blob store, droppable, re-fetchable from peers and
  re-verified against its hash.
- **Retention is pin management.** A **pin** protects one blob from GC on behalf of one identity -
  the IPFS sense of the word, and *not* a taxonomy tag: tags are the user's plural organizing
  strings and never touch storage; a pin is singular retention machinery. (Implementation detail,
  named once: pins are iroh-blobs "tags," its GC-protection primitive.) The scheme: a pin is
  `(root, blob hash)`, named `<root_hex>/<blob_hash_hex>`, and the **invariant** is that after any
  retention pass, the pin set under an identity's prefix equals the live-hash set computed from its
  materialized views (document heads, ancestors kept for merge, and - once `refs` exist - the files
  those versions reference). Everything follows: a retention pass is idempotent set reconciliation
  (compute live set, diff, add/delete); pins are a rebuildable cache of the views exactly as the
  views are of the chains; deleting an identity is one prefix drop; and two identities pinning the
  same public blob hold independent pins, so no refcounts and no coordination. Not per-document
  pins (a document's retained history spans several hashes, and one pin protects one) and not
  per-version pins (the "why is this held" a longer name would encode is the view's job to answer,
  not the pin store's). GC is iroh-blobs' own, enabled via its `GcConfig`: collect whatever no pin
  protects - and until pinning is wired, GC stays off, which fails safe. A node-level accounting
  index (hash → account/size, for quotas and attribution) is deferred to the storage-budgets open
  question - pins already answer GC, and nothing else needs it before 4M.
- **The primitive, not the pipeline.** This layer is bytes ↔ hash, transfer, and GC - nothing else.
  Media *processing* (the crunch filter, EXIF stripping, type admission) sits above it and is 4M
  work.

### Versioned Documents

The general mutable-content model: **a document is a stable identity whose versions form a DAG,
with bodies in the file layer.** Born as the notes design and deliberately format-agnostic - a
note is a versioned document whose body happens to be text; the same machinery versions an image,
a tileset, anything with rolling states.

- **A version is a header entry on a chain.** Each save appends a small CBOR header
  `{doc_id, parents, file_hash, body_hash, title, format?, refs?}`; the body never rides the
  chain. A **version's identity is its entry hash** (BLAKE3, already unique); `doc_id` is the
  document's stable identity across versions - what taxonomies and publication reference, never
  version hashes. `body_hash` is a **plaintext fingerprint riding inside the encrypted header**
  (BLAKE3 keyed by doc_id, so no global rainbow tables): equality checks - the no-op save bounce,
  twin/echo detection in merge - never need the body bytes, and work even after old bodies are
  GC'd. It is a member-secret exactly like the body: never on a plaintext surface. The honest
  cost: a permanent fingerprint of droppable content - deleted words become *confirmable* (never
  recoverable) to a key-holder guessing low-entropy content, an accepted asterisk on deletability
  (NOTES_APP).
- **`parents` is a list from day one** - the git-commit model: zero at genesis, one for an ordinary
  save, two-plus for a merge, so reconvergence needs no format change even before any merge UI
  exists. Fast-forward when your parent is the current head; two saves sharing a parent are
  **detected divergence**, and the universal resolution is **keep-both-with-lineage** - never lose
  words. Auto-merge is a *per-format capability* layered on top (three-way merge for text; images
  simply keep both), never core machinery.
- **`refs` is a derived index** - the file hashes and doc-ids the body references, extracted from
  the body at save time so GC-reachability and backlinks never require decrypting every body. The
  body stays the source of truth.
- **Versions are whole-file snapshots, never diffs.** Encryption defeats storage-layer delta
  compression (random nonces destroy exactly the redundancy deltas exploit), and delta chains would
  reintroduce base-dependencies that break independent droppability. Retention bounds storage
  instead: debounced saves, skip-no-op saves, keep-last-N + GC.
- **Private documents and public documents share the model, not the history.** A post's draft *is*
  a private note; publication snapshots **one version** across the membrane as a new public
  artifact with a history of one (**Copy, Don't Flip**, Doctrine). The version DAG solves a
  private, multi-device drafting problem; public edit semantics are tombstone/replace (4M's
  problem).

### Taxonomies: Documents About Documents (amended 2026-07-22/23; lists + trees IMPLEMENTED)

Everything that *organizes* documents - tags, streams, folders, knowledge-base trees, reading
lists - is itself ordinary data, external to what it organizes. (Born in the notes design; see
NOTES_APP.md for the discovery narrative. Canonical statement here, because addressing, feeds,
and Marquee's computed widgets all consume it.)

- **Taxonomies live outside documents, never in header data.** Three independently-sufficient
  proofs: third parties curate (a stranger's reading list over your documents cannot write into
  your headers); views mix boundaries (a private list interleaving your drafts with your
  published posts is inexpressible as public header data); and the publication membrane stays
  clean (organizing metadata never rides the document, so nothing needs stripping at the
  crossing). One deliberate exception rides the payload: consent **labels** - a stranger's
  server filters on them without access to anyone's taxonomies. Same-looking strings, opposite
  transport requirements, permanently separate fields.
- **One merge shape, chosen twice (amended 2026-07-22).** Unordered membership (tags) is an
  **LWW-element-set** whose merge unit is the single `(doc, tag)` pair - concurrent tagging
  merges automatically, and no shape that stores a document's tags as one value survives two
  devices (whole-list LWW eats one side's tags: the stale-tab failure in miniature). Since
  2026-07-20 tags *live* in the annotation layer, grouped per-document on the doc-meta chain
  (Annotations, below) - "all docs tagged X" vs "all of D's tags" turned out to be a false
  choice, since both directions are indexes over the same materialized table. Ordered
  structure (curated sequences, "BOOK ABOUT HORSES") decomposes the same way -
  **per-element facts, never a document body**: a taxonomy is a stable minted id whose members
  are set elements in its `tax:<taxonomy_id>` collection on the same doc-meta chain, each
  element the `(root, doc_id)` reference, each value the member's **rank** (a fractional
  base-36 index - client convention, rebalanced by a burst of rewrites when it bloats;
  `record/rank.rs`). Order is assembled at read time (rank, element tiebreak), never stored as
  one value, because a taxonomy's commonest concurrent edit is two devices each adding an
  item, and any whole-value shape turns that obvious union into a manufactured conflict - the
  tags argument, verbatim. Same-element position races resolve LWW: one position wins, nothing
  leaves the list, history stays on the chain. Concurrent same-spot inserts land adjacent in
  tiebreak order - harmless for a curated list, which is exactly why NOTES_APP's no-text-CRDT
  ruling doesn't apply here: interleaving destroys prose, not reading lists, and no op-log
  wire format enters the conformance boundary (on the wire these are ordinary private
  records). Existence is a roster fact (the `taxonomies` set): an empty list exists, deletion
  is one remove, re-creating an id resurrects its members. Taxonomy-level facts (title,
  `default_view`, description) are annotations on the taxonomy's own id. An album is a `tax:`
  collection, full stop - still never metadata on its tracks. Chronological streams are
  usually no artifact at all: a derivable view.
- **Trees are composition, not structure (amended 2026-07-23).** A taxonomy placed as a
  member of another taxonomy IS the tree - the design considered a formal alternative (a
  `parent` slot in the member value, tree shape internal to one collection) and rejected it on
  one decisive ground: *where the cycle lives*. Parent pointers put a merge-created cycle **in
  the storage structure** - broken until a deterministic fold-time resolver repairs it, and
  that resolver silently rewrites someone's move: exactly the move the notes design refused.
  Composition cycles are just independent membership facts - storage never corrupts, and a
  loop is a *render* concern: traversal carries a visited set, and a repeat visit (a cycle, or
  a diamond's second parent) renders as a titled **stub-link**, the conflict-markers
  philosophy holding for shape. Prevention where cheap, recoverability always: `place` refuses
  the locally-visible cycle (the single-device mistake, including self-placement); the visited
  set absorbs what concurrent placement can still mint. What composition buys beyond the
  cycle story: interior nodes are themselves taxonomies (titled, describable, taggable for
  free - a "section heading" is a small titled list, no pseudo-documents); a sub-list can live
  under two parents (a DAG - the appendix cited from two chapters); and the same document can
  appear in two sections, because sections are separate collections. The honest costs, named:
  a cross-section move is two writes (remove + place; the race loses the remove and leaves a
  *visible, recoverable* duplicate - chosen over the parent-pointer model's atomic move that
  can corrupt), and multi-parent makes "the" breadcrumb path a UI arrived-from concern. The
  `parent` slot is retired **unused**; the fold-time cycle rule is retired *unslain*.
- **Taxonomy documents are the publication form** - now their *entire* jurisdiction.
  Publishing a knowledge base is the standard membrane crossing (**Copy, Don't Flip**,
  Doctrine): fold the collection, encode an ordered-references body, sign it public under a
  stable `doc_id` with a history of one; re-publish is another explicit act.
  Private/mutable collection and public/mostly-immutable document mirror the note → post
  reflection exactly. The honest cost of the working form, named: the version DAG's
  user-facing rollback ("restore yesterday's arrangement") is given up - the chain retains
  every edit in principle, and restore points can ride the snapshot machinery if a real need
  names itself. What this amendment retires is the analogy that chose documents first -
  "reorganizing a tree on two devices *is* editing a note on two devices" - retired because
  taxonomy edits decompose into element facts with obvious merge semantics, and prose does
  not. Third-party curation is unchanged: their chain, their collection, their published list.
- **References are `(root, doc_id)`** - stable identities, never version hashes (an edit must
  not shatter every tree pointing at the document). Relative forms elide the root via base-URI
  resolution (see Addressing); cross-identity references are fully qualified.
- **Taxonomies answer queries.** A taxonomy carries an author-declared `default_view`
  (`index` | `latest` | ...) - an annotation on the private working form, a payload field on
  the published document - and the view vocabulary (`latest`, `earliest`, `root`, `index`,
  `next-in-stream`, ...) is one function family consumed by slug URLs (Addressing) and
  Marquee's `:::computed` roles alike.

### Annotations: Private Facts About Documents (settled 2026-07-20; IMPLEMENTED)

Where does a description go? Audio's artist and album? The question forced a third category into
existence, and with it **the placement test** that decides every future "where does field X
live":

- **A function of the version's bytes → the header.** Width, height, duration, format, hashes:
  derivable from the file, changing exactly when the bytes change, riding free on the version
  save that is already happening. `title` is the single blessed human exception (listings need
  it without a second lookup) - and it is the cautionary precedent, not a pattern: every
  human-editable header field must buy its own answer to concurrent editing inside machinery
  built for body divergence (title's answer is its own field-wise merge rung). No second
  exception.
- **Cross-document structure → taxonomy** (above). An album is an ordered taxonomy;
  artist-as-grouping is a tag, or an ordered taxonomy when someone curates a discography.
- **A human assertion about one document → an annotation.** Per-doc, singular, editable, and
  decoupled from the version lifecycle: a description is edited without minting a version, and a
  new version never re-asks for it. It fails the header test (prose bloats every entry; edits
  must not write versions) and the taxonomy test (nothing cross-document about it) - so it is
  its own thing.

**The shape: the private store's CRDTs, grouped per document.** Annotations reuse `PrivatePlain`
wholesale - registers for fields, set-elements for tags - with everything the user asserts about
doc D in one collection, `annot:<root>/<doc_id>` (the full `(root, doc_id)` reference form, so
privately annotating *someone else's* document stays representable). `key` is the field name -
`description`, `artist`, `album`, `source`, `rating`, ... - a conventional vocabulary that is
client custom, never protocol; absent value means cleared; tags are set elements in the same
collection. Values inherit PrivatePlain's caps, with an annotations-layer cap of **2 KiB** on
descriptions: past a few hundred characters a "description" is becoming another document - write
one and reference it. Merge is the existing LWW stamp `(timestamp, seq, hash)` under the
authoring clamp, and last-writer-wins is the *correct* contract for a prose blurb precisely
because history stays recoverable - no new merge rungs, which is exactly what staying out of the
header buys.

**Its own chain, pre-graduated: `doc-meta` (service 7).** The graduation rule (features scribble
on `general-private` until cadence earns them a chain) gains a refinement: **skip the scribble
phase when the cadence is forecastable.** Here it is, twice over. (1) Annotation volume scales
with **library size**, not human decision count - a bulk media import writes tens of thousands
of registers in an afternoon, exactly the ingest-shaped traffic documents were evicted from
`general-private` for. (2) On an encrypted chain, **`service` is the only cleartext partition
key** - collections live inside the ciphertext, so co-located annotations would tax every
small-fact read with decrypt-everything, forever; and un-graduating later means re-asserting
state on a new chain and dual-reading the old one permanently. Mandatory mechanics, named so
they are not missed: a fresh AAD constant (domain separation from general-private records), the
`is_private_service()` line in sync (miss it and annotations leak to unproven strangers), and
the withheld-from-strangers test cloned for the new service.

**The ingest membrane holds.** The media pipeline strips embedded metadata (EXIF, ID3, OpusTags)
at ingest, forever - harvested metadata is a privacy leak and mostly junk. The authoring client
may *read* artist/album/title from the file before the bytes are laundered and offer them as
pre-filled annotations; persisting them is a deliberate user act (bulk import consents once per
batch, never silently per file). The pipeline launders; the user asserts - copy-don't-flip,
extended to metadata a second time.

**Rejected, so they stay rejected:** descriptive fields in the version header (the merge-rung
tax, above); a document's tags as one register value (whole-list LWW eats concurrent tagging);
tag collections grouped per-tag rather than per-doc (read direction is the materializer's job;
per-doc keeps a document's assertions, deletions, and exports single-collection); SQLCipher and
sealed-snapshot views (see The Substrate - dependency and multi-tenant-memory grounds
respectively).

### Replication over Iroh

- User data is synced between nodes using the **Ringtome sync protocol** (see Iroh Protocol Mapping below), not by replicating raw SQLite files.
- The per-user SQLite database is the local materialized view of synced data.
- Both nodes continue to sync the user's data bidirectionally as long as the user is active on both.
- Concurrent writes never conflict at the log layer; merge rules live at the semantic layer, stated once in
  **The Ordering Contract** (LWW for scalar state, set-merge for collections, rank-path - never time - for
  authority) and implemented node-side by the Store Layer's typed handles.
- **Entry validation:** Every incoming sync entry is validated against the current key tree. Entries are stored **signed** so that a Repudiation Revocation can retroactively quarantine everything a hostile key signed after its cut-point (see Revocation Types).

### The Browser Is a View: The Live Cache (settled 2026-07-23)

The web client is **not a peer**. It holds no keys, validates nothing, never touches
ciphertext, and never dials the network - it has exactly one sync partner forever, the node
that agents its identity, and what it syncs is not chains but **the view**. The architecture
arrived here on its own: chains → journal → disposable materialized views is already the
node's shape, and the browser adds one more disposable materialized view, one hop further out.

- **Downstream is a WebSocket, and it is read-only.** Per identity, the node streams **view
  deltas** - the same row shapes the persisted views hold (doc summaries, annotations, tags,
  taxonomy facts, profile fields), already decrypted, already folded - and the browser upserts
  them into an IndexedDB mirror (Dexie). The node folds once; every browser inherits the
  fold. This is what keeps the dual-implementation cost near zero: the browser reimplements
  *display* logic, never merge judgment - LWW rungs, DAG resolution, and conflict synthesis
  stay in Rust, stated once. A per-chain cursor rides the stream so a returning browser
  catches up incrementally; a browser with no cursor (or a doubtful one) drops the cache and
  re-streams from zero. **The cache is disposable** - a pure function of the node's view,
  never a source of truth: the Turso invariant, one hop out.
- **Upstream is HTTP POST, and every write is one.** No mutations ride the socket: actions
  arrive as the discrete, logged, rate-limited, cap-checked HTTP writes that already exist.
  The asymmetry is deliberate - a socket that only ever flows outward is easy to reason
  about, and the write surface stays one surface.
- **Optimistic writes are a shadow overlay.** The client applies its own POSTs to a shadow
  layer over the mirror immediately; the write lands on the node, folds, and **echoes back
  down the stream**, which clears the shadow. Until the echo arrives the change is visibly
  "on its way" - the first rung of the unsynced-indicator doctrine, free. (The second rung -
  "has any *other node* seen it?" - is peer-ack information the node must expose; still
  deferred, and slot-compatible with this same stream.)
- **Plaintext in browser storage is accepted, deliberately.** The persisted-views ruling
  leaned on Turso's at-rest encryption; IndexedDB has none, and the difference is accepted on
  ownership grounds: the browser runs on the *user's own machine* - private docs cached there
  live on hardware that is theirs, which is at least as sound as their plaintext living on a
  node they may not own. The obligations that make this a posture rather than a leak: a
  **"forget this browser"** control that drops mirror and shadow wholesale (logout offers
  it), and nothing is ever cached for an identity the session doesn't own.
- **The browser is never a device. Ever.** No leaf key, no signing, no adoption ceremony, no
  seat in the key tree - cancelled permanently, not deferred. Browser storage is evictable at
  the browser's whim, the XSS surface is real, and - decisively - it is unnecessary: the node
  signs, so a browser can be lost, cleared, or stolen with zero authority attached. The
  intermediate rung ("a browser that validates entries itself" - wasm-proto at the trust
  boundary) is likewise unplanned: the browser's trust in its own node is the same trust
  every HTTP read already extends (**We Trust the Node Operator**), and no consumer has named
  a reason to shrink it. Offline *writes* are out of scope by construction - an offline
  browser is a reading browser, and that is the accepted shape.

What this buys: a live UI (every view reactive), offline reads, instant boot from cache,
multi-tab coherence (one socket, BroadcastChannel fan-out - a client detail), and near-zero
growth in bespoke read endpoints. What it costs: the change-stream endpoint and cursor
bookkeeping on the node, the Dexie mirror + shadow overlay in the client. Sequencing
consequence, deliberate: this **precedes the notes UI** - once an identity's view streams and
its writes echo, the notes app is mostly rendering.

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

SSB's onboarding pain, precisely blamed: pubs transitively inflated the follow-graph hops math, every feed in
your slice replicated whole-from-genesis mandatorily, and clients rebuilt databases by replaying the entire log on
first run - and SSB *had* a header/blob split, which prevented none of it. Ringtome's escapes: no transitive
hops-amplification (fronting is direct demand - your node fetches who *you* follow, not who they follow),
incremental materialized views (full replay is an optional integrity ritual, never a startup cost), and - the
piece that needs a protocol commitment - **suffix-capable chains**. "Chains replicate whole" as a default would still recreate SSB's tail (follow a posts-every-minute bot
with a decade of history and you owe five million entries and verifications; a fronting node multiplies that by its
user count). The fix is cheap because **the hash chain already permits it - this is a git shallow clone.** If a node holds the *suffix* of a chain, the oldest held entry's signed
`prev_hash` commits to the entire missing prefix: everything held verifies as authored, and any later backfill must
hash-match the commitment already in hand or be rejected. `prev_hash` never required *possessing* the prefix - only
that any prefix ever accepted be *the* prefix. **Recently-rewritten LWW fields are correct from a
suffix** (an unseen older entry loses by definition) - but fold-based views are not: a register key or set element
last touched inside the unfetched prefix is silently *absent*, not stale (the store layer's two-question suffix
test). Snapshots exist to close exactly that gap. What shallow holding otherwise forgoes is fork detection inside
the unfetched prefix and complete history display - both acceptable to acquire lazily. Policy:

1. **Identity chains: always full, always first.** Tiny, security-critical, they are the authority context - never
   shallow.
2. **Content chains: suffix-first, backfill lazy.** Follow = head plus a small recent window; older history streams
   on demand (scrollback) or idle time. This is why the frontier is a `[floor..head]` range - designed into sync v1,
   because a protocol that assumes dense-from-zero storage bakes that assumption into every peer forever.
3. **Render at first entry, never at completion.** SSB's sin was as much UI as protocol: the app blocked on
   replication. Progressive display is a standing rule for every client.
4. **Fronting depth is a dial.** Fronting an identity promises its *availability*, not its infinite history:
   per-identity depth/size budgets, so a node fronting 500 users is not archiving 500 lifetimes.
5. **Snapshots close the fold gap.** Fold-based views (multi-key registers, sets) go suffix-safe only behind a
   signed checkpoint - design settled, build deferred with its trigger named (see IM-AOL Open Items: Snapshots).

The honest trade, named: shallow-held chains mean a node can serve recent content while deep history is only
*provably-committed-to*, not present. Archival completeness becomes a **role**, not a universal guarantee - an
identity's own nodes hold its own chains whole (agenting stays full-fat), and anyone may volunteer as a deep
archive. That is the same trade git made, and the right one.

### The Identity Tree Is Its Own Peer-Discovery Structure

There is no roster of an identity's nodes, no membership protocol, and no coordinator (**No Central Authority**, Doctrine). Each node's picture of the
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
security property below are one mechanism seen from two sides. (Implemented 2026-07-22 as `net::resync`'s two
background passes: debounced eager push on local change, plus a periodic anti-entropy exchange with up to k=3
randomly chosen peers per identity, first pass at boot.)

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
another identity, and the costume attack is handled where it belongs, in the UI: contact names bind to roots, and
the **root-derived identicon** shows wherever a display name does (one canonical treatment: Display Names and
Contact Names).

### `iroh-blobs` → The File Layer's Transport

The transfer and storage substrate for **every** file-shaped byte in the system - private
(encrypted) note bodies as much as public media; see Data Layer, The File Layer, for the canonical
design (this section is just the protocol mapping). Chain entries carry blob hashes; the bytes move
over iroh-blobs as pure point-to-point transfer - dark by default, no content discovery, second
ALPN on the same endpoint as sync.

`iroh-blobs` is unaffected by the revocation model because blobs are immutable and content-addressed — there is no concept of "author" or "write access" at the blob level. A blob is just bytes identified by a hash. (Revocation *of readers* is the epoch-key layer's job: a revoked member keeps the blobs it already fetched and cannot decrypt anything sealed after its rotation.)

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

Two limits to design around:

- **Discovery quality tracks opt-in.** If few edges are made discoverable, the overlay is sparse and the network feels like a void. There is real pressure to make the discoverable overlay generous, and every step toward "discoverable by default" re-exposes the association map. This dial needs ongoing tuning, not a one-time setting.
- **Hidden edges leak through visible ones.** Hiding a few edges in an otherwise-public neighborhood does not hide them well: surrounding public structure often lets an outsider infer the hidden edge by correlation. Per-edge privacy is weakest exactly when most edges are public - which is the state generous discovery pushes toward. Sensitive edges (activist, source, survivor) should be understood as protected only when the *neighborhood* is private, not just the single edge.

---

## Moderation and Operator Liability

Ringtome does not grow a moderation subsystem; it consults machinery it already has at the moments content changes
hands. Every mechanism in this section reduces to one shape: **an opinion, signed by an identity, weighted by the
reader's trust in its author, applied as node-local policy at a serving decision.** Admission, peering,
denunciations, hash lists - all instances of that shape. The section exists because a federated node operator is
the person legal reality actually visits, and the design owes them a defensible position, not a shrug about p2p.

### Public Means Public

Content is either encrypted or it isn't. Encrypted content is the *pull* side - your private input stream, whom you
trust, what you consume. Everything else is **public, and public means public**: a reachable node serves it to
whoever asks, over HTTP and Iroh alike, no standing in the network required.

The earlier posture here - "public-readable but never served to anonymous HTTP" - is retired. It contradicted
**Not Hermetically Sealed** (Doctrine), and worse, it protected nothing: public content served to even one follower
over Iroh can be rebroadcast to the open web by that follower the instant they choose, so withholding it from an
anonymous HTTP client at your own node buys zero privacy and costs a working web presence. If it is public, it is on
the web the moment anyone wants it there - own that instead of pretending otherwise.

What varies is never *what a node serves* but *whom it hosts* and *whether it is reachable*:

- **Admission is the real control**, and it is on the write side (**Bounded Operator Liability**, Doctrine). A node
  dials who may hold an account from `closed` (just you) through `trusted`, `invite`, and auto-capped `open` - see
  Registration Modes. Overload and liability are bounded by *whom you host and can eject*, never by hiding readable
  bytes.
- **Reachability is deployment, not policy.** A home node behind NAT may only ever be reachable by followers over
  Iroh; a VPS with a domain is a public HTTP endpoint. Serving *other identities'* public content to the web -
  fronting the broader network - is the further opt-in **Web Gateway** role (below), with its own liability.
- **No node must answer any particular request.** "Anyone *may* read" is not "every node *must* serve every
  request": a node still rate-limits, blocks abusers, and refuses to be an amplifier (**You Can't Push Hosting
  Decisions On Others**, Doctrine).

None of this weakens the moderation story, which was always about *ingress* - what a node hosts - not read access
(see The Three Funnels, next). And public still is not a megaphone: readable content is a website you can visit if
you know its address, not a global feed that finds you. Growth rides membership and vouch edges, as it always did.

### The Three Funnels: Why Moderation Load Stays Bounded

The nightmare - a reporting pipeline that cannot keep up with gobs of bots - assumes unbounded content inflow.
Pull-not-push means content lands on a federated node through exactly three funnels, each with an accountable
human attached:

1. **Your own users author it.** Admission is trust-gated; you inducted them. Kick, delete, done - ordinary
   hosting-provider remediation.
2. **Your users follow it in.** Every remote identity a node fronts exists because a specific local account
   demanded it. Remediation is severing the demand edge and talking to the user who created it - a name, a
   conversation, a small blast radius.
3. **Open mode**, if enabled, accepts unsolicited fronting - already opt-in, quota'd per source, and revocable
   when burned.

Moderation load is therefore proportional to **your community's behavior, not the network's size** (**Bounded Operator Liability**, Doctrine). Bots cannot
push; they must be pulled, and pulling requires an account or a follow from someone who has one. This is the same
structural insight as "no global timeline is the structural repellent": the megaphone not existing is not just
culture curation - it is the liability shield. (This is **Allowlist Beats Blocklist** (Doctrine) once more: an
LLM auto-moderator is a *blocklist over the adversary's content*; demand-driven serving is an *allowlist over
ours*. A small local model is decent at NSFW flagging, mediocre at
contextual hate speech, useless for copyright, and forbidden territory for CSAM - and it becomes an adversarial
target the moment it is load-bearing. LLM as triage for an operator's review queue on public-facing roles: fine.
LLM as verdict: never. If the design only works when a small model correctly identifies evil, the design does not
work.)

Field data that bounded ingress is tractable: the fediverse's IFTAS pilot ran hash-scanning for 8 Mastodon servers
(~30k monthly actives) and found ~4.3 matches per 100,000 media files - real (small operators *do* encounter this
material via federation; "not my cozy node" is false) but rare enough that quarantine-and-review pipelines keep up
easily once ingress is bounded.

### Four Abuse Categories, Four Machineries

Collapsing these into one "detect evil and hammer it" pipeline is the design error to refuse. Each category has
different legal duties and different correct machinery:

- **CSAM** - the only category where "ban the user" is never sufficient and affirmative legal duties exist (in the
  US, mandatory reporting to NCMEC under 18 U.S.C. §2258A, with preservation duties - so the pipeline on discovery
  is **quarantine + preserve + report**, emphatically not reflexive deletion). Detection is hash-list scanning
  (below) - **never a home-built classifier**: possessing or training on the material is strict-liability criminal
  territory with no self-declared research exception. Note also what the law does *not* demand: §2258A imposes no
  monitoring duty and the DSA forbids general-monitoring obligations - scanning is something a node *chooses* at
  its public-facing roles, not a protocol-wide obligation.
- **Copyright** - proactive detection is neither possible (no local model identifies a movie from blob chunks; no
  rights database exists to consult) nor required: the safe-harbor model is **notice-and-takedown plus a
  repeat-infringer policy.** What a node needs is response machinery - fast blob drop, root refusal, and for
  hosted nodes of size, a registered agent. Speed of removal matters; detection does not. (See also Fidelity Caps:
  a network that cannot carry high-fidelity media is a bad piracy channel by construction.)
- **Hate speech** - jurisdiction-dependent, operator-policy territory. Ban + drop locally; optionally publish the
  denunciation so nodes that trust your judgement inherit it (below).
- **NSFW** - not a removal problem at all: a **labeling and consent** problem. Self-claimed content labels on
  post/page payloads, operator-applied label overrides, reader-side filters. Room for a labels field must be
  reserved when the content types are designed (Tier 4M) - retrofitting label semantics into signed content is a
  protocol break in miniature.

### Policy Is Never Protocol

The sync gate refuses entries that are cryptographically *invalid* - broken chains, revoked keys. Operator
moderation is a **second, separate input** to the same gate: *valid, but refused here.* The two must never blur:

- A **denunciation is not a repudiation.** Repudiation is an identity's senior key evicting its own junior - an
  intra-tree authority act. A denunciation is a stranger's signed opinion about someone else's root. Reusing the
  key-tree revocation types for moderation would be a category error with teeth: other nodes must never mistake
  "this operator refuses R" for "R's chains are cryptographically dead."
- Refusal is **node-local.** A denounced identity's own nodes still serve it; followers who do not subscribe to
  the denouncer still fetch it. The maximum effect of moderation machinery is *refusal to carry* - never
  network-wide erasure. (Erasure of specific content is the blob layer's tombstone/drop, an authorial or operator
  act on cooperating nodes, exactly as the Data Layer designs it.)

### Denunciations: Negative Signal Without Negative Trust

Naive negative trust dies instantly in an open-identity network: minting a denouncer is free, so negative edges
from the open graph are botnet fuel. The flow model's Sybil guarantee is directional - it protects the supply of
*positive* signal and says nothing about negative. There is exactly one safe construction: **negative signal is
only ever an opinion carried over existing positive trust edges.** Not negative edges *in* the graph - negative
payloads *on top of* it. A botnet's million denunciations weigh zero because none of its authors are
flow-reachable; eleven flow-reachable friends independently publishing "this account is a stormfront bot" is
strong, usable signal.

Three rules keep it safe:

1. **Denunciations never touch the Trust computation.** They gate downstream policy (serve/front/admit/rank),
   never the substrate. Feeding them back into Trust would build the up-flow the layer boundary forbids, and let
   a clique excommunicate someone from the *graph* rather than from their own nodes.
2. **Weight-shared like every signal** (per **The Law of Conservation of Trust**, Doctrine). A denunciation carries
   the denouncer's weight, split across everything they signal, so an account that denounces 10,000 identities is a
   firehose whose individual denunciations round to zero.
3. **Refusal-to-carry, not excommunication** (per Policy Is Never Protocol). A clique of real, mutually-trusted
   humans brigading a victim can make the victim unwelcome in *their* neighborhood - roughly the power human
   communities have always had - not delete them from the network.

A denunciation is a signed statement on its author's chain (target root, reason class, optionally a blob hash -
see Hash Lists), revocable by its author, subscribable by anyone. "I trust Rache to moderate on my behalf" needs
no new primitive: it is **topic-scoped Credibility** - the score the trust layer already defines - where the topic
is moderation judgement. (Open, for the statement-type design: the reason-class taxonomy, and whether denunciations
live on the operator's identity chain or a node-key chain.)

### Operator Identity: Bind, Don't Adopt

Nodes already have keys (transport-level node keys, distinct from identity keys). The question is whether a node
should be welded into its operator's key tree. **No - bind, don't adopt.** Making the node key a child of the
operator's tree conflates machine compromise with personal-identity compromise, forecloses pseudonymous operation,
and drags succession machinery where it is not needed (dead node key = mint a new node, re-bind). Instead, reuse
the voluntary-linkage primitive ("I am also X"): the operator's identity publishes a signed **operator-binding
statement** - "identity O operates node N" - and trust in O reaches N through ordinary graph mechanics.

What the binding buys:

1. **Admission policy becomes automatable.** "Anyone vouch-reachable within 3 hops of the operator may register"
   is the difference between a 12-person node and a 500-person node *without* open registration - the scaling
   mechanism for trust-gated growth.
2. **Peering by operator trust.** Unsolicited fronting and open-mode sync weighted by trust in the bound operator;
   anonymous unbound nodes get the strictest quotas or nothing.
3. **Moderation delegation.** Subscribe to denunciation feeds and hash lists weighted by the author's
   moderation-Credibility.
4. **Abuse routing.** Reports and "your user is causing trouble on my node" conversations travel
   operator-to-operator along trust edges instead of an abuse@ inbox exposed to the anonymous world.

Two caveats, kept loud: **the operator's personal graph is an input to node policy, never identical with it** (a
personal vouch should not silently auto-admit; personal follows are not the node's subscriptions - node policy
chooses which levers to pull). And the fediverse's known failure mode applies: **operator trust clusters can
calcify into de facto blocklist authorities** (the fediblock wars). The structural mitigation is that
subscriptions are per-node and weighted, not binary and global - but any feature that makes subscribing to one big
list the path of least resistance is quietly rebuilding the authority this architecture claims not to have.

### Hash Lists and Scanning

Blocklists at blob granularity are denunciations carrying hashes, and they come in two kinds on one list:

- **Exact (BLAKE3).** Nearly useless on the web (any re-encode evades); **unusually strong here**, because blobs
  propagate *by their hash* - the same bytes get requested and re-served across nodes. One exact-hash denunciation
  kills that blob among subscribers network-wide; evading it means re-authoring and re-seeding a new blob, not
  re-sharing a link. Zero-cost to check (the blob store is already keyed by it).
- **Perceptual (PDQ).** Catches the re-encode. Computed locally at blob ingest - which means *decoding hostile
  media*, a classic vulnerability class: decoders run sandboxed, the same posture taken toward every other hostile
  byte.

**Operator-authored lists** are the established pattern, not a hack (StopNCII works exactly this way: victims hash
their own images locally; platforms block on the hash, and the image never travels). The workflow: report arrives
-> operator reviews -> **hash before dropping** -> the entry goes on the node's signed denunciation chain ->
trusted subscribers inherit the block. Distribution is trust-gated *on purpose*: a public hash list is an offline
evasion-testing oracle and (for perceptual hashes) a dictionary-attack risk - "shared along trust edges" is the
operationally correct model, not just the philosophically tidy one.

**CSAM lists are never distributable and never local.** The clearinghouse ecosystem (NCMEC, IWF, the Canadian
Centre for Child Protection) keeps hashes server-side and exposes vetted access or query APIs. The shipped default
backend is **Shield by Project Arachnid** (C3P): free, signup-keyed, accepts **locally-computed PDQ hashes** -
fingerprints go out, user media never does - returns exact/visual match classifications, and has an official Rust
SDK (`arachnid-shield`). Each operator signs up for their own key (the accountability chain behind the key is part
of the point; Ringtome ships no shared credentials). IWF's small-operator offering (Image Intercept) is a second
supplier to watch. The fediverse's IFTAS experience is the cautionary architecture note: their centralized
scanning intermediary cost $60k+/year and died of funding within months - so Ringtome's shape is **a scanner trait
at the blob layer** plus trust-edge republication: the few operators who run scanning publish their own blocking
*decisions* (their moderation acts - never the clearinghouse's list) as exact-hash denunciations, and the long
tail inherits protection by subscription, with no intermediary organization to keep funded.

Operational rules:

- **Scanning defaults are keyed to role.** Off/optional for a personal node serving its own author's content;
  on-by-default - arguably required by the software - for **open mode and gateway mode**, exactly the roles where
  strangers' media crosses the disk headed for the public.
- **Gateways fail closed:** if the scanning backend is unreachable, new unscanned media is held, not served.
- **A perceptual match is a lead, never a verdict** (Apple's NeuralHash collision lesson). Auto-*block* on match:
  fine - cheap, reversible. Auto-*report a human* on match: never - human review precedes reports.
- **On a CSAM match: quarantine + preserve + report.** The blob is sealed in a locker, not shredded (preservation
  is a legal duty where reporting is); the serving path goes dark immediately; the operator gets a "you likely
  have reporting obligations, here is where" prompt. Cache clean verdicts by exact hash so nothing is scanned
  twice.
- **Scope honesty:** scanning covers what a node can see - public chains and fronted blobs. Encrypted
  private-chain content is structurally unscannable, and the design says so proudly: promising to scan inside the
  private boundary is the chat-control position. The correct control for private content is the admission/trust
  layer, not the scanner. Likewise, perceptual hashes stop *casual redistribution* of known material, not a
  determined adversary with a re-render pipeline: a hygiene layer on the architecture, never the wall.

### The Web Gateway: A Distinct Role, Dual Opt-In

(Resolves the open decision in Resource Namespace and Access Protocol.) Some users genuinely want globally-public,
identity-attributed content - the webcomic case - and the network should serve them without every federated node
becoming an exit node. The gateway is therefore a **separate role with dual opt-in**:

- **The author opts in:** a signed gateway-eligibility statement scoping which of their public content may be
  re-served over HTTP.
- **The gateway operator allowlists that specific identity.** Nobody can opt themselves onto a gateway.

A gateway's liability is proportional to a **curated, enumerated list** - "we publish these 200 authors we chose"
is a defensible editorial position in a way "we relay whatever arrives" never will be. Curation is also the value:
a good gateway is a magazine, and its allowlist is taste made legible. An identity whose whole purpose is
distributing contraband can flag itself gateway-eligible all day; no operator has to take it, and the ones
vouch-reachable from operators won't. Gateway mode carries the strictest software posture: mandatory scanning,
fail-closed, hardened serving headers (below), and a genuinely separate serving domain - the one role where asking
the operator for real infrastructure is appropriate, because it is the one role that is *publishing*.

### The Media-Type Admission Test

Blob types are a **closed registry** - the same **Allowlist Beats Blocklist** (Doctrine) move as the markup
vocabulary, applied to bytes. A media type earns admission to the network when it has all three:

1. **A strict-parse validation story** - magic bytes and structural parse at ingest (in a sandboxed decoder), a
   typed renderer at display (never a generic "open this file" path). The declared type is *enforced, never
   trusted*: the attack is not `badtouch.exe` labeled honestly, it is a blob declared `image/png` whose bytes are
   a polyglot or script.
2. **A scanning story**, where its abuse category demands one - PDQ/Shield covers images and video, which are
   conveniently exactly the CSAM-relevant types.
3. **A metadata-privacy story** - what the format smuggles, and how it is stripped.

The v1 lineup that results:

| Type | Verdict | Why |
|---|---|---|
| **Bitmap images** | Yes, with the EXIF rule | Phone photos carry GPS - a deanonymization channel. Content-addressing means a node can't strip metadata post-hoc without changing the hash, so **stripping happens in the authoring client, pre-sign**, with an ingest-side "reject GPS EXIF" backstop for third-party clients. |
| **SVG** | No | Looks like an image, is actually an XML document carrying script and external references. Bitmaps only, until someone builds "parse SVG into a safe subset" as a project. |
| **Video** | Narrow profiles only | Container formats are the worst parsers in computing. Allowlist specific codec/container pairs (MP4/H.264+AAC, WebM/VP9) and let the browser's sandboxed media stack decode. |
| **Audio** | MP3 and - load-bearing aesthetic - MIDI | ID3 tags embed arbitrary junk: validate/strip at ingest. MIDI renders through a client-side synth, never a native handler. |
| **PDF** | No | JavaScript, launch actions, embedded files, forms - a document *platform*, not a document. Strongest future concession is "sandboxed pdf.js only," still a concession to resist. |
| **Generic file attachment** | Resist hardest | With the registry closed to markup/images/av/audio, there is *no surface* on which an executable arrives - not blocked, nonexistent. A tileset zip becomes a new *specific* type with its own validation story. |

On plaintext malware (base64 in a post body): unwinnable and therefore out of scope - anyone a filter could stop
can paste ciphertext instead. The defensible line is that **the network never puts bytes on a path to an
interpreter**: no execution context, no native-handler handoff, no one-click-open. Weird text a human must
manually extract and run is outside any threat model a protocol can hold.

**Origin isolation is software defaults, not operator labor.** The isolation never actually came from owning a
second domain - it comes from how blob bytes are served, and the node ships it: `Content-Type` set from the
*validated* type (never the declared one), `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: sandbox` (which gives every blob response a unique opaque origin - works on
`localhost`, requires zero operator configuration), `Content-Disposition: attachment` for anything not strictly
renderable, and blob serving bound to a **separate port** from the app UI (a genuinely different origin by
definition, free even on a Raspberry Pi; the client keeps session credentials where the blob origin can never
read them). The **separate serving domain** is asked only of the gateway role - the burden lands where the risk
lands: local operators configure nothing and get isolation from headers; publishers take on publisher
infrastructure. (Also load-bearing: the client renders blobs through its own typed renderers - decoded bitmaps
into constructed DOM, media elements for a/v - so blob bytes are never *navigated to* as documents in the first
place.)

### Fidelity Caps: The Crunch Filter (provisional)

Once photos and video exist, node disk space becomes a design surface. Full storage budgeting (quotas, eviction,
what a node owes the identities it agents and fronts) is an open question - but one provisional stance is worth
recording because it serves four goals at once: **media passes through an aggressive, lossy, retro-aesthetic
re-encode in the authoring client** - palette quantization, dithering, hard dimension caps, brutal video profiles.

- It merges with a pass that must exist anyway: the pre-sign metadata strip (EXIF) is already a mandatory
  authoring-time re-encode; crunch is the same pass with taste. (And constraint-as-identity is already this
  document's stated aesthetic bet - the Pico-8 lesson.)
- It bounds storage and sync cost to 1999 levels: ten thousand tiny GIFs are barely an inconvenience, and the
  day-long-sync problem stays dead.
- It is enforceable where it matters: the *aesthetic* is cultural plus default-client, but **size and dimension
  caps are ingest policy** - a node verifies and refuses oversized blobs regardless of which client authored them.
- It is quietly a moderation feature: **a network that only carries small, heavily-quantized media is a terrible
  distribution channel for high-fidelity contraband.** Nobody pirates a movie at 160p in 8 colors; fidelity caps
  make the piracy-exit-node problem structurally unattractive rather than policed.

One honest tradeoff: heavy quantization is a large visual transform, and perceptual-hash matching against
clearinghouse databases (built from originals and common re-encodes) degrades with transform distance - crunching
may cost some scanner recall. Scan at ingest *before* the blob is accepted, and accept that the fidelity cap
itself does much of the work the scanner would.

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
| Local database | **Turso** (SQLite rewritten in Rust) | Per-user local materialized views, encrypted at rest — settled 2026-07-20, see The Substrate |
| Login auth | **Argon2** | Node-login password hashing (verify user, then grant access to their key) |
| Key at rest | **envelope-encrypted key file** | Machine keychain (always-on) or Argon2-derived (cold device); databases separately encrypted under keystore-wrapped keys - see Key Storage |
| Signing / hashing | **ed25519** + **BLAKE3** | Identity keypairs, entry signatures, chain/blob hashes |
| Symmetric AEAD | **XChaCha20-Poly1305** | Key files at rest; reused wherever symmetric encryption is needed |
| Private-chain sealing | **NaCl sealed box** (X25519), via **dryoc** | Epoch keys sealed to members' encryption pubkeys (see Private Chains) |
| Frontend | **Preact + htm + esbuild** | The retro-OS web client - v1's only client, and the reference renderer for the content markup (see The Client Story) |

**Crypto dependency boundary (a standing policy, learned the hard way).** Our cryptography talks to the network
layer (iroh) in **bytes, never in shared typed crates** - 32-byte public keys in, opaque sealed blobs out - and we
prefer **reusing a primitive we already depend on over adding a new one**. iroh rides the frontier of the
`curve25519-dalek` ecosystem (it pins release-candidates), and twice now its transitive versions have collided with
crates we tried to add (pkarr, then the sealing libraries). The byte boundary makes us immune: dryoc's
`curve25519-dalek` is a different major version than iroh's, they never exchange a typed value, and Cargo simply
keeps both - so iroh's version weather stops at the edge of our types. This is the same bytes-not-structure
discipline the entry format uses for forgery-proofing, doing a second job. New crypto boundaries are rare (sealing
now; WebAuthn maybe later); reaching for a *third* new crypto crate to do a job the existing ones cover is the smell
to stop on. (Turso's at-rest encryption is engine-internal and does not open one: its cipher never crosses our type
boundary - we only wrap its per-database keys in the keystore, which is the existing XChaCha envelope doing its
existing job.)

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

## Project Structure

```
ringtome/
├── proto/     ← ringtome-proto: the conformance boundary (canonical bytes, chains, key tree, sync messages)
├── node/      ← the connector node binary (see node/README.md; store.rs is the application data map)
├── spec/      ← published test vectors ("this logical value MUST produce exactly these bytes")
├── api_old/   ← prior-generation codebase, reference only (see API_OLD.md)
└── *.md       ← the documents (README.md is the map)
```

The system as built is best read from the code's own maps: `node/src/main.rs` (composition root + the
background-loop registry), `node/src/store.rs` (the data map), `node/src/sync.rs` (the trust boundary),
`proto/src/lib.rs` (the conformance boundary).

---

## Open Questions

Questions still genuinely open. (Resolved questions are deleted, not archived - each answer lives in its
owning section, and git remembers the deliberations.)

- [ ] **Epoch rotation needs an adult** (raised 2026-07-13, and the highest-priority item here because it is a
  defect in *shipped, IMPLEMENTED* machinery, not a future feature). "Revocation - either disposition - rotates"
  never says who mints the epoch, and a self-issued retirement cannot mint its own. Six specific defects, with the
  reasoning and the proposed fixes, are enumerated in **Groups (SKETCH), The Adult In The Room** - the one-line
  core being *you may not sign the epoch that excludes you*, plus a derivable-recipient-list rule that makes rotation
  safe to leave ungated. Also queued there: generalizing repudiation's blast radius beyond "child authorizations,"
  and a third disposition for *departure* (honor the history, kill the subtree, self-issuable). Take up at the
  identity level; groups are not the forcing function, they were only the microscope.
- [ ] **Markup vocabulary v1:** which tags make the static-markup first cut, and which widgets (hit counter,
  guestbook, webring navigator) come first once the core ships? The *frame* is settled (Content Markup: Starting
  Posture - markdown-shaped strict core, directive skeleton, closed style vocabulary); the vocabulary itself waits
  on the notes app's plaintext-era corpus.
- [ ] **Storage budgets:** how much disk a node owes the identities it agents and fronts — quotas, eviction, and
  the crunch filter's enforceable size/dimension caps (see Fidelity Caps) as the likely anchor. Take up when media
  types land (Tier 4M/4S). ("What social features first?" resolved 2026-07-09: admission/tokens → notes → social
  + trust floor - see NEXT_STEPS, the recommended route.)

