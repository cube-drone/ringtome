# Ringtome — Next Steps

Here's where we write out _things we're planning to work on_.

This is a loose plan of upcoming feature work and immediate near-term goals we are driving towards.

**Forward-looking only:** finished work leaves this file - full report in [HISTORY.md](HISTORY.md).

## Near-Term Goals

### Chat
* 2-way encrypted p2p chats (we already have most of this)
* Opus took a crack at fixing chat search losing visible context, but wasn't smart enough; revisit with Fable

### Notifications
* Have the app pop a real notification when stuff happens
* Change the favicon when stuff happens

### Localization
* An in-ui way to cheat your presented language, for testing
 * just fully do french and spanish or something
* humanize the writing

### Private Notes

* Import/export bucket or whole persona
* Document history: let me go back in time
* GC: clean up unused docs and files (first customer: blank drafts - untitled, empty, unposted - which the feed stack now hides rather than lists, 2026-08-28)
* Document: list attached files (informs GC)
  * Produce a list of media files that aren't linked anywhere
* mp3 tags -> annotations (keep things like album artist)

### Public posts and fan-out

* Better filters in Lost & Found
* Edit-orphaned twins: a re-bake mints a fresh media twin and the old one stays public on
  the author's own shelf (fragment holders reconcile theirs). Found 2026-09-05 beside the
  takedown fix (`retract_post` entombs a buried post's twins); the edit door should retire
  the twins its new refs no longer name, with the same "nothing else names it" check.
* External video in public posts? (private works, but linked-external?)
* Envelope-kept reply evidence has no deletion road: a stranger's reply noted from its
  COMMENT envelope outlives its deletion on the parent-author's node (and in their reply
  count) until that node ever meets the replier's chain or fragment. Surfaced 2026-08-27
  by the count acceptance; candidates: revalidate evidence on the fragment ALPN like a
  fragment, or age it on the door's own beat.
* A sealed label rides the chain only (2026-09-10): the fragment road's proofs never carry
  one, so a reader who learns a sealed post by fragment holds its labels only once the
  annotator's chain reaches them. Fine while chains sync; revisit if fragments become the
  main road for sealed posts.
* Save to bucket
* Rate limits on the anonymous doors (PROJECT_PLAN's The node's public face, residuals): the
  front page is the first thing a scraper finds; a per-address budget beyond the paging.
* Node-observed feed ("here's everything public that anybody is looking at")
* more granular or time-limited blocks? ("block for 6 months")

### Public means public (Gateway)
* the public-HTML browser for this repo

### Node Management & Federation
* use the spare key to build a new identity, create a new spare key
* currently spare key account recovery reveals a hugely important secret to potentially a low-level node: bad!
* declare a "management persona"
* storage management
* reporting flow
* full-node blocks ("do not carry this user")
* **Hosted Deploy Story** - Ringtome on docker hub, with deployment instructions
* Registration management:
  * Capped registrations (We can only have 30 accounts on this node)
  * Closed nodes (no registration)
  * Invite nodes (registration with invites from node op)
  * Viral nodes (registration with invites from anybody on the node already)
  * Slow-viral nodes (^ they only get limited registration codes)
  * Trust nodes (registration if the node has already heard of you and trusts you)
* CSAM scanning & blocking (with API key)
* Passkey security for users
* Email password recovery (with API key?)
* Hostile pass: deep security review

### Safety
* sync-request floods: malicious nodes can DDoS with sync-requests, probably?

### Sync

* Peeks and budgets — PROJECT_PLAN's "Peeks, ceilings and pins" (2026-09-05): every exchange budgeted, a first
  look at a stranger held as a shape (identity, annotations, twenty posts as fragments)
  with a footprint and an expiry, the identity chain capped; public pins (a `pin`
  annotation, the pinned strip, pinned fetched first) as slice 4; five slices, all built
  2026-09-05. Residuals: a misbehaving peer for the rig, a backoff on "busy", snapshots. Residual: a misbehaving peer
  for the rig, so the deadlines and the flood ceiling get a proof beyond the unit gate.
* Frontier refresh grew 4 -> 27ms per fold across an 8x80 test-data run (2026-08-28's
  quadratic hunt left it as the one unexamined tail): `memo_public_anchors` or the
  fingerprint walk scales with something - find which, with the "fold legs" line.
* Shallow sync: our first sync from a dense user is yuuuuge
* Detected equivocation kills the key that generated it
 * After a restore-from-backup, try to sync with ANYONE ELSE to make sure we aren't accidentally equivocating
 * What's the UI for this?

### Mixtape & Radio
*  a mp3 browser

### Desktop
Settled, staged and under way in [DESKTOP.md](DESKTOP.md): Tauri v2 with the node linked in,
one process. Stage 1 (the `lib.rs` split) is built; the rest, in order:
* ~~Stage 2 — the shell, in-process, dev only~~ built 2026-09-21: `just desktop`
* ~~Stage 3 — the per-launch token, and no login screen~~ built 2026-09-21
* ~~Stage 4 — packaging and signing~~ built 2026-09-22/23: `just release-*`, Mac signed and
  notarized, Windows signing by Azure OIDC (its first signed run is the proof still owed)
* ~~Stage 5 — autostart and the tray~~ built 2026-09-24: `desktop/src/tray.rs`; close hides,
  start at login on by default, one instance, quiet restart for updates
* ~~Stage 6 — auto-update and a release channel~~ built 2026-09-23: `desktop/src/update.rs`,
  update-on-quit; proven only once two releases carry it

### Server nodes
Two tasks, split on purpose (Curtis, 2026-09-25): packaging for the widest range of deployments,
and then an easy path for people who want one.
* ~~**Packaging**~~ built 2026-09-25: the server binary (glibc 2.31, built natively in Debian 11,
  x86_64 + aarch64) on every release as `ringtome-server-...`, the same binaries as a multi-arch
  image on `ghcr.io/cube-drone/ringtome` (distroless/cc), release builds defaulting to `prod` +
  `mainline`, `RINGTOME_P2P_PORT`, and `SERVER.md`. Unproven until a tag runs the new jobs.
* **An easy path, later** - documented sample compose files (with and without a bundled HTTPS
  proxy), and a small supervisor that fetches and verifies new binaries (the desktop updater's
  minisign key and manifest), takes a backup of the data directory before each upgrade (the
  migration ladder never goes back down), and restarts the node.

### Marquee Promises
* Marquee provides fixtures for drop-in functionality: do we still have a use for those?
* Marquee provides tools to build whole websites: do we still plan to let users host a geocities-style-page?
* We could do better marquee completion; right now we hardcode a bunch of Marquee stuff but we could do better at
    pulling Marquee information directly from the spec or active version.

### Mobile
* oh this one's hard as fuck
* idk defer defer
* does this connect to a federated node or fully run the protocol in rust?

### Real-Time Chat
* The "seed" is shared, like a Post would be, and can be rebroadcast, also like a post would be

### Weird Ideas
* Anki-Style Flashcards
* Minesweeper/Solitaire
* VN Engine
* Whiteboard/shared board
* Post Signatures

