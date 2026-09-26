# Ringtome — Next Steps

Here's where we write out _things we're planning to work on_.

This is a loose plan of upcoming feature work and immediate near-term goals we are driving towards.

**Forward-looking only:** finished work leaves this file - full report in [HISTORY.md](HISTORY.md).

## Near-Term Goals

### Launch to Website
* Actually Deploy the Thing (Registration Off)
* API Keys for automated autopost?
* Everyone subscribed to ringtome at boot
* "How Many People are Subscribed to Me?"
* Logging & graphs
* "Attract Mode"
 * Select a user as the "primary display user"
 * Let them choose a front page document or use their top pin or something.
 * An automatically generated "get started with HDT" page that contains links to the HDT deliverables?
   OR special marquee tags for HDT deliverables
* RSS for website users
* Migrate yer content
* Visual identity
* report flow

### Actual Horse Drawing & Tycooning
* Drawing app
* Multiplayer Drawing App (use chat as the heart)
* HorseBucks and Other Currencies

### Chat
* Opus took a crack at fixing chat search losing visible context, but wasn't smart enough; revisit with Fable

### Notifications
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
* Registration management:
  * Capped registrations (We can only have 30 accounts on this node)
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
* **Local accounts, shaped later** (Curtis, 2026-09-25): signing in to the desktop app with a
  password instead of the launch token's auto-login, and whether one computer should host several
  people's accounts at all. A first cut (the app listening on the LAN) guessed the second one wrong
  and came out again; nothing is needed yet.

### Server nodes
Two tasks, split on purpose (Curtis, 2026-09-25): packaging for the widest range of deployments,
and then an easy path for people who want one.
* **Sample compose files** - documented, with and without a bundled HTTPS proxy.
* **Restore from a backup in the Server/Device app** - the Backups page makes, lists and downloads
  them (2026-09-25); putting one back still means stopping the node and unpacking by hand.
* **A wedged node** - the supervisor restarts a node that exits, not one that stays up and stops
  answering `/health`; a liveness watchdog is the missing half, if a wedge is ever seen.

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

