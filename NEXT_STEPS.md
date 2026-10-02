# Ringtome — Next Steps

Here's where we write out _things we're planning to work on_.

This is a loose plan of upcoming feature work and immediate near-term goals we are driving towards.

**Forward-looking only:** finished work leaves this file - full report in [HISTORY.md](HISTORY.md).

## Near-Term Goals

### Demo Output
* report storage use per account
* on mobile People, folks' gigantic IDs are flattening their names
* "automatic-node-friendship" mode
 * only available with password-based registration
* limit registrations to N (100)
* A demo server (free registration, but it deletes all of its users after 7 days )
* An article on Managing Operator Liability
* every button in the entire mobile app is a little too small and delicate for human fingies, and some of the drawing tools are WAY too small
* the big-search crawl's residuals (HISTORY 2026-10-02 has what was found and cut):
    * the server's fold costs a median 851 ms with nothing else in flight; a laptop does a comparable persona in ~50 ms. Which leg, and is it the box (disk fsync? cores?) or the data (node.db's size)? A fresh 30 minutes of log after this deploy says whether the crawl is gone
    * one connection per persona: every read queues behind every write and fold statement, in arrival order. A read-only second connection would stop that - but the 2026-08 stale-read dig named cross-connection WAL visibility as a suspect, so it wants its own design
    * a turso statement runs inside one poll and holds its tokio worker while it runs: a heavy read can stall the runtime on a small box. Worth checking the server's core count; `spawn_blocking` for the heavy readers if it's low
* <- and -> arrows to navigate through books
* check if HorseBucks are actually using a bigint
* when I tag stuff in my personal feed (which is huge) it doesn't update right away
* everything I've posted to the public internet in the past 6 years clocks in at about 110 MB all-in
    * so following 10 of me would entail a solid gigabyte of load?
* feed/user search result highlighting

### Launch to Website
* Logging & graphs
* "Attract Mode"
* Migrate yer content
* report flow (and full-node blocks?)
* apparently the Posts page only deals with the last 5000 things, and we might need to deal with that the same way we dealt with Feeds... eventually.
* the Posts page can lose it's place while the Feeds page can't?
* a library of fun templates


### Actual Horse Drawing & Tycooning
* Multiplayer Drawing App (use chat as the heart)

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
* Find the write-to-echo lag on a big persona: a new note or a publish took seconds to reach the
  mirror on Curtis's node, where a 300-note scratch persona echoes in ~30 ms and a 750-doc list
  builds in ~90 ms. Time each leg on the real node - the write, the stream's wake (`gather`), the
  frame's size, the browser's `apply` - before guessing.
* Optimistic rows (js/pure/optimistic.js) for the writes still waiting on the stream: a new
  notebook (buckets.js), emptying a notebook, and the post-side surfaces outside the publish bar.

### Public posts and fan-out

* Better organization in Files
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

### Node Management & Federation
* **Starter contacts, the operator's own** (Curtis, 2026-09-28): every persona created on a node begins
  knowing the official Horse Drawing Tycoon 2 persona, Cube Drone and Tom (starters.rs, built). Later: the
  node operator edits that list in their settings, rather than an environment variable.
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
* **Linux: the webview may have to go** (Curtis, 2026-09-28, trying the desktop build on Linux):
  WebKitGTK showed no pictures - the node keeps every picture as AVIF, and whether WebKitGTK
  decodes AVIF depends on how the distro built it (SVGs, the identicons, drew fine) - and felt
  far slower than Chrome or Firefox. First step taken: every desktop app has the ordinary sign-in
  now, and on Linux the sign-in points to the system browser. Still open: whether Linux keeps a
  window at all, or opens the browser at launch instead, and **the way back with no tray** (stock
  GNOME shows none without an extension).

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

