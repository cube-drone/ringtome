# Ringtome — Phones

**Status: a soft shape, not a plan.** Written 2026-08-11. PROJECT_PLAN's *Phones: deferred, by
design* is canon and this does not overturn it — but one of that section's premises is factually
wrong in a way that changes what the phone could be, and the correction is worth having on record
before anyone costs a phone client again.

The soft shape: **Tauri v2, the Rust node linked in-process, a deliberately narrow UI.**

Read with [DESKTOP.md](DESKTOP.md), which reaches a different answer for desktop and explains why
that is coherent, and [GODOT.md](GODOT.md), which needs the same `lib.rs` split this does.

## The premise correction

*Phones: deferred, by design* argues: "there is no background sidecar on iOS, period, so a phone was
always going to be a remote client of always-on nodes, not a p2p citizen."

The premise is about **sidecars**, and it is true — iOS permits one process per app, so
`fork`/`exec`/`posix_spawn` are unavailable and a spawned helper binary is not a thing that ships.
But **in-process linking sidesteps it entirely**: a phone can run the full iroh stack inside the
app. The conclusion survives anyway, for a different reason — iOS will not let it run in the
*background* — and the distinction matters, because "impossible" and "foreground-only" lead to
different designs. The first says be a terminal; the second says be an intermittent peer, which the
sync design already accommodates.

Android is the same story with different mechanics: a bundled binary can be exec'd if it is
packaged as a native library (since Android 10, W^X forbids exec'ing anything written to the app's
own writable data directory), and Godot/Tauri process-spawning support on mobile is absent anyway —
so in-process is the answer there too. Doze and the background-process reaper impose the same
foreground-only shape, and the only sanctioned escape is a foreground service with a permanent
notification, which is the wrong thing for this app to hold.

## There is no middle option

Checked in the code on 2026-08-11, because the tempting middle — "the phone holds a leaf key, signs
locally, and hands signed entries to a node that relays them over iroh" — would change everything if
it existed. It does not:

- `record/imaol::append` does the signing, on the node, holding the key.
- `tests/conventions.rs` nails the `entries` table to exactly two doors: local authorship via
  `record/imaol.rs`, and the validated sync gate in `net/sync.rs`. The architecture cop enforces it.

So there is no "client signs, node relays" door, and adding one is a protocol decision rather than
plumbing. Which leaves two shapes and nothing between them:

**The phone is a terminal.** No key on device, HTTP plus the live-cache WebSocket to a node with a
`RINGTOME_PUBLIC_URL`. Zero Rust on the phone, because this is precisely what `node/js` already is —
the PWA stopgap *Phones: deferred, by design* already commits to. What it gives up is the point: the
node holds the keys and does the signing, a reachable node with TLS is required, and the phone is
dead offline.

**The phone is a peer.** The full Rust stack in-process, foreground-only. Keys on device, offline
reads and authoring, syncs in bursts.

Nothing in between, because a leaf key that cannot author is decoration, authoring means canonical
CBOR plus the key tree plus chain rules plus epoch-key encryption for private chains, and even
having ported all of that you would hold signed bytes with no way to move them. **Transport is iroh
or nothing.**

## Why we want the peer

Not preference — necessity, given who is building this. The terminal shape requires a permanently
online node, which means either the average user sets one up (they will not) or this project hosts
public nodes. Hosting is a non-starter for a solo developer with no budget and no legal team:
*We Trust the Node Operator* and *Moderation and Operator Liability* are precisely about the
obligations a content-holding node takes on.

So the terminal shape is a bet that users bootstrap their own federation, and that is a big bet. The
peer shape is the one where the network never *requires* federated nodes — which would also let the
federated half of the design be toned down, and federation is complicated in a way that runs against
the p2p feeling the project is chasing.

## The availability arithmetic, honestly

A phone node is up while the app is open. Call it 30 minutes a day: p ≈ 0.02. For *instantaneous*
availability with k independent replicas each up at p, availability is 1 − (1 − p)^k, so 95% needs
k ≈ 150. At p ≈ 0.1 it is ≈ 29; at p ≈ 0.3 it is ≈ 9.

**Phone-only is hopeless on that metric.** Recorded so nobody has to rediscover it.

## Why the design survives it anyway

Instantaneous availability is the wrong metric for this network, and the reason is our own
architecture:

- **Followed content is read from the reader's own mirror, not from the author's node.** The mirror
  machinery plus `idface::refresh_followed_pass` mean opening someone's page hits a local copy. So
  phone-as-peer degrades to **staleness, not unavailability**, for exactly the content that matters
  most. This is the big one.
- ***Rebroadcast: Pointer Plus Pinned Replica*** makes popularity into replication — every
  rebroadcast adds a serving node, so heat and availability track each other.
- ***Silence preserves, speech deletes***: an offline author cannot retract, so their content
  survives through replicas by construction.
- **Anti-entropy plus boot catch-up converge over days.** The immediate first pass at boot is the
  catch-up (registered in `main.rs`), the eager-push doorbell batches local writes, and the
  gravedigger (`net/bodies::sweep`) and outbox (`outbox::sweep`) rounds exist specifically for peers
  that were asleep when news was minted. **A node that lives ninety seconds while someone uses the
  app is a supported shape, not an abuse of one.**

For a cozy asynchronous network, "your post reaches your circle within a day" is not a failure mode.
It is the vibe.

## What genuinely breaks

The things with no mirror to hide behind:

1. **First contact.** Following someone new requires reaching *them*, and there is no mirror yet.
   Two phone-only users may never overlap.
2. **Delivery to strangers.** *Delivery: one door, then your own sync* is explicit that the failure
   condition is "zero nodes of mine were reachable at delivery time," and its own third mitigation —
   sealed-envelope relays — is "your friends' always-on nodes as your answering service." If nobody
   is always-on, that gap has no floor.
3. **The public web face.** `/id/{seg}` (`idface.rs`, one URL and two audiences) needs a node the
   outside web can dial. Without web-public nodes the retro-web pages are visible only inside the
   app. That is a product change, not only an infrastructure one, and it deserves a deliberate
   answer.
4. **The authored-but-never-replicated window.** *The Ordering Contract* already names this as the
   genuinely fragile case; it widens considerably when the authoring device sleeps 98% of the time.
5. **Push notifications.** Already recorded in *Phones: deferred, by design* as the one structural
   gap, with an optional push-gateway role on hosted nodes as the likely answer. Unchanged by any of
   this, and it is the one item that seems to actually require somebody's server.

## The reframe that makes the bet survivable

**The always-on node does not have to be infrastructure anyone sets up. It can be the user's own
desktop, running the app with autostart at login.** p ≈ 0.3–0.5, no domain, no TLS, no VPS, no
operator liability for us — see [DESKTOP.md](DESKTOP.md), where this is Stage 4 and where the
argument is made in full.

Then the phone-as-peer question stops being load-bearing. Your desktop seeds your content and
answers your door; your phone is a peer of your own identity that syncs when open, authors offline,
and holds keys. **Phone-as-peer is worth having for offline authoring and key custody. It is a bad
foundation for the network's availability**, and we should not talk ourselves into believing
otherwise.

## Tauri as the shell

Tauri's backend is Rust, which is what makes it the right shell *here* even though
[DESKTOP.md](DESKTOP.md) plans Electron for desktop. That document's *Electron and Tauri, compared*
carries the full head-to-head and the experiment that decides it; the summary relevant here is that
Tauri's third shape — **the node linked in-process** — is the one that makes phones a port rather
than a separate project.

- The node runs **in-process** — which needs the composition root in `src/main.rs` split into a
  `lib.rs`, since `node/Cargo.toml` declares only `[[bin]]`. Mechanical: that file already wires
  modules and starts loops and implements nothing. [GODOT.md](GODOT.md) needs the identical split.
- **Tauri v2 targets iOS and Android**, so one Rust codebase covers the shell, the platform, and the
  node.
- The UI is the web UI we already have, not a rewrite.

The known snags:

- **`turso` pulls `bindgen` as a build dependency**, so cross-compilation needs libclang configured
  against each target's sysroot. The rest of the tree is deliberately pure-Rust with no C libraries
  (`node/Cargo.toml` is emphatic about this, and it is a real asset here) — turso is the exception
  that will cost an afternoon per platform.
- **iOS is WKWebView by App Store rule**, so the WebKit skew that [DESKTOP.md](DESKTOP.md) avoids by
  bundling Chromium is unavoidable on phones. Which brings us to the mirror.

## The mirror question

**IndexedDB-on-WebKit is the most notorious compatibility surface on the web platform**, and the
mirror is Dexie. On a platform where WKWebView is mandatory, that is the highest-risk component in
the client. Worth asking what it is buying, and the answer is less than expected when the node is
zero hops away.

*The Browser Is a View: The Live Cache* claims five benefits. Against an in-process node:

| claim | on a phone with the node in-process |
|---|---|
| live UI, every view reactive | **Survives** — but this is `liveQuery` as a *reactivity* engine, not storage. One call site (`js/mirror.js`). Replaceable by any store with subscriptions. |
| offline reads | **Near-worthless.** If the node is down the app is down; there is nothing to read offline *from*. |
| instant boot from cache | **Misattributed.** On localhost the round trip is nothing; what the cache saves is the node reassembling a full snapshot, which is a node-side concern and solvable node-side. |
| multi-tab coherence | **Gone.** One window. |
| near-zero growth in bespoke read endpoints | **Survives completely** — but it belongs to the stream protocol, not to Dexie. Kept either way. |

So the shape to reach for is **a pluggable backing store behind the existing seam** — memory for
local clients, Dexie for remote ones (hosted browser, PWA) — rather than deleting anything. The
codebase is unusually well positioned for this: `integration/test/pure/conventions.cjs` enforces one
owner for Dexie, and there is exactly one `liveQuery` call site, so nothing has reached around the
seam. Preact is already in the tree, so `@preact/signals` behind `mirror.js` is the obvious cheap
answer for the reactivity half.

Residuals, both small: `mirror/prefs.js` needs to survive a reload (remembered view mode per
document), which is localStorage-sized rather than IndexedDB-sized; and `mirror/doccache.js` holds
document bodies, where memory-only means a reload refetches — free against a local node, though with
a 10MB body cap it wants a small LRU rather than everything resident.

**One genuine bonus:** *The Browser Is a View* owes obligations *because* the mirror persists — a
"forget this browser" control that drops mirror and shadow wholesale, and the invariant that nothing
is cached for an identity the session does not own. A memory-only mirror discharges both by
construction. Nothing to forget when the process exits.

## What "highly simplified UI" means

Unsettled, but the principle is clear: **the phone client should decline surfaces, not reimplement
them.** [GODOT.md](GODOT.md)'s finding applies here too — the cost of a client is diffuse across the
long tail of ordinary screens, and diffuse cost can only be declined.

A first cut at the split:

- **In:** the feed, reading personas and documents, light authoring, DMs, notifications, presence in
  whatever form it takes.
- **Out:** key management ceremonies, adoption, node admin, taxonomy editing, anything with a
  ceremony that wants a keyboard and a big screen. The desktop app is where an identity is
  administered; the phone is where it is used.
- **Editor modes:** `read` certainly; `plain` and `side` plausibly (`js/doc/editor.js` names all
  four). The `interactive` live-preview mode is the expensive one and the least suited to a small
  screen.

## Open questions

Named rather than resolved, so they do not ambush whoever picks this up:

1. **Does the phone hold a leaf key at all?** *Adding a New Node* has a ceremony, and a device that
   is lost or stolen is exactly what *Revocation* covers — but a phone is the most-lost device
   anyone owns, and the retirement/repudiation cost of routine loss deserves thought before we hand
   phones seats in the key tree.
2. **App Store review risk.** A p2p network syncing arbitrary user content invites the UGC
   guidelines' moderation requirements. Our answer — *Moderation and Operator Liability*, trust is
   explicit and moderation is operator policy — means on-device the *user* is the operator. Whether
   review accepts that is unknown, and the exposure lands on a solo developer with no legal team.
   This is the risk most likely to make the whole direction moot, and it is cheap to research early.
3. **Metered-network posture.** Anti-entropy with up to 3 random peers every `RINGTOME_RESYNC_INTERVAL_SECS`
   is written for a machine on mains power and unmetered bandwidth. A phone needs a cellular policy
   and a battery policy; neither exists.
4. **Where presence lives**, if a gamey layer ever happens — the ephemeral-tier question is stated
   in [GODOT.md](GODOT.md) and applies identically here.
5. **Two shells against one UI**, if both this and [DESKTOP.md](DESKTOP.md) proceed. A knowing
   maintenance cost, mitigated by the client-agnostic API rule that makes both possible — and
   avoidable outright if desktop ever lands on Tauri-in-process, which is the one outcome where a
   single shell covers all three platforms.
