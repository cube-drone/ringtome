# Ringtome — Next Steps

Here's where we write out _things we're planning to work on_.

This is a loose plan of upcoming feature work and immediate near-term goals we
are driving towards.

**Forward-looking only:** finished work leaves this file - full report in
[HISTORY.md](HISTORY.md).

## Near-Term Goals

### Demo Output

- every page, on load, has a "flash of default-colored content" before adopting
  my color scheme: can we load the color scheme _with the HTML_ ?
- every button in the entire mobile app is a little too small and delicate for
  human fingies, and some of the drawing tools are WAY too small
- vim mode i needs it
- the big-search crawl's residuals (HISTORY 2026-10-02 has what was found and
  cut):
  - the server's fold costs a median 851 ms with nothing else in flight; a
    laptop does a comparable persona in ~50 ms. Which leg, and is it the box
    (disk fsync? cores?) or the data (node.db's size)? A fresh 30 minutes of log
    after this deploy says whether the crawl is gone
  - one connection per persona: every read queues behind every write and fold
    statement, in arrival order. A read-only second connection would stop that -
    but the 2026-08 stale-read dig named cross-connection WAL visibility as a
    suspect, so it wants its own design
  - a turso statement runs inside one poll and holds its tokio worker while it
    runs: a heavy read can stall the runtime on a small box. Worth checking the
    server's core count; `spawn_blocking` for the heavy readers if it's low
- check if HorseBucks are actually using a bigint
- when I tag stuff in my personal feed (which is huge) it doesn't update right
  away
- everything I've posted to the public internet in the past 6 years clocks in at
  about 110 MB all-in
  - so following 10 of me would entail a solid gigabyte of load?
- feed/user search result highlighting
- An article on Managing Operator Liability
- Probably a bad idea: An open demo server (free registration, but it deletes
  all of its users after N days ) (why not: we still are responsible for what we
  host for that 7 days)
- stacked updates (3 updates are available...)

### Launch to Website

- Logging & graphs
- Migrate yer content
- report flow (and full-node blocks?)
- apparently the Posts page only deals with the last 5000 things, and we might
  need to deal with that the same way we dealt with Feeds... eventually.
- the Posts page can lose it's place while the Feeds page can't?
- a library of fun templates

### Actual Horse Drawing & Tycooning

- Multiplayer Drawing App (use chat as the heart)

### AI agents (MCP)

- Connect real assistants (claude.ai, ChatGPT, Claude Code) to a public node
  running the MCP build: nothing but the suite and hand-driven clients has
  spoken to it yet (plans/MCP.md).
- OAuth (oauth.rs): self-registered clients are capped at 5,000 a node but never
  pruned - forget ones that never connected after a while.

### Chat

- Opus took a crack at fixing chat search losing visible context, but wasn't
  smart enough; revisit with Fable

### Notifications

- Change the favicon when stuff happens

### Localization

- An in-ui way to cheat your presented language, for testing
- just fully do french and spanish or something
- humanize the writing

### Private Notes

- Import/export bucket or whole persona
- Document history: let me go back in time
- GC: clean up unused docs and files (first customer: blank drafts - untitled,
  empty, unposted - which the feed stack now hides rather than lists,
  2026-08-28)
- Document: list attached files (informs GC)
  - Produce a list of media files that aren't linked anywhere
- mp3 tags -> annotations (keep things like album artist)
- Find the write-to-echo lag on a big persona: a new note or a publish took
  seconds to reach the mirror on Curtis's node, where a 300-note scratch persona
  echoes in ~30 ms and a 750-doc list builds in ~90 ms. Time each leg on the
  real node - the write, the stream's wake (`gather`), the frame's size, the
  browser's `apply` - before guessing.
- Optimistic rows (js/pure/optimistic.js) for the writes still waiting on the
  stream: a new notebook (buckets.js), emptying a notebook, and the post-side
  surfaces outside the publish bar.

### Public posts and fan-out

- Better organization in Files
- Edit-orphaned twins: a re-bake mints a fresh media twin and the old one stays
  public on the author's own shelf (fragment holders reconcile theirs). Found
  2026-09-05 beside the takedown fix (`retract_post` entombs a buried post's
  twins); the edit door should retire the twins its new refs no longer name,
  with the same "nothing else names it" check.
- External video in public posts? (private works, but linked-external?)
- Envelope-kept reply evidence has no deletion road: a stranger's reply noted
  from its COMMENT envelope outlives its deletion on the parent-author's node
  (and in their reply count) until that node ever meets the replier's chain or
  fragment. Surfaced 2026-08-27 by the count acceptance; candidates: revalidate
  evidence on the fragment ALPN like a fragment, or age it on the door's own
  beat.
- A sealed label rides the chain only (2026-09-10): the fragment road's proofs
  never carry one, so a reader who learns a sealed post by fragment holds its
  labels only once the annotator's chain reaches them. Fine while chains sync;
  revisit if fragments become the main road for sealed posts.
- Save to bucket
- Rate limits on the anonymous doors (PROJECT_PLAN's The node's public face,
  residuals): the front page is the first thing a scraper finds; a per-address
  budget beyond the paging.
- Node-observed feed ("here's everything public that anybody is looking at")
- more granular or time-limited blocks? ("block for 6 months")

### Node Management & Federation

- **Starter contacts, the operator's own** (Curtis, 2026-09-28): every persona
  created on a node begins knowing the official Horse Drawing Tycoon 2 persona,
  Cube Drone and Tom (starters.rs, built). Later: the node operator edits that
  list in their settings, rather than an environment variable.
- use the spare key to build a new identity, create a new spare key
- currently spare key account recovery reveals a hugely important secret to
  potentially a low-level node: bad!
- declare a "management persona"
- storage management
- reporting flow
- full-node blocks ("do not carry this user")
- Registration management:
  - Capped registrations (We can only have 30 accounts on this node)
  - Viral nodes (registration with invites from anybody on the node already)
  - Slow-viral nodes (^ they only get limited registration codes)
  - Trust nodes (registration if the node has already heard of you and trusts
    you)
- CSAM scanning & blocking (with API key)
- Passkey security for users
- Email password recovery (with API key?)
- Hostile pass: deep security review

### Safety

- sync-request floods: malicious nodes can DDoS with sync-requests, probably?

### Sync

- A flake in `follow_ceiling.cjs` (seen 2026-10-06): "scrollback backfills
  beneath the floor" reached 260 of 300 posts once under a full `just ci`, then
  passed three times alone and in the next full run, on the same tree. Paging
  back stops short under load; find what it races before it turns up red on
  `main`.
- Peeks and budgets — PROJECT_PLAN's "Peeks, ceilings and pins" (2026-09-05):
  every exchange budgeted, a first look at a stranger held as a shape (identity,
  annotations, twenty posts as fragments) with a footprint and an expiry, the
  identity chain capped; public pins (a `pin` annotation, the pinned strip,
  pinned fetched first) as slice 4; five slices, all built 2026-09-05.
  Residuals: a misbehaving peer for the rig, a backoff on "busy", snapshots.
  Residual: a misbehaving peer for the rig, so the deadlines and the flood
  ceiling get a proof beyond the unit gate.
- Frontier refresh grew 4 -> 27ms per fold across an 8x80 test-data run
  (2026-08-28's quadratic hunt left it as the one unexamined tail):
  `memo_public_anchors` or the fingerprint walk scales with something - find
  which, with the "fold legs" line.
- Shallow sync: our first sync from a dense user is yuuuuge
- Detected equivocation kills the key that generated it
- After a restore-from-backup, try to sync with ANYONE ELSE to make sure we
  aren't accidentally equivocating
- What's the UI for this?

### Mixtape & Radio

- a mp3 browser

### Desktop

- **Linux: the webview may have to go** (Curtis, 2026-09-28, trying the desktop
  build on Linux): WebKitGTK showed no pictures - the node keeps every picture
  as AVIF, and whether WebKitGTK decodes AVIF depends on how the distro built it
  (SVGs, the identicons, drew fine) - and felt far slower than Chrome or
  Firefox. First step taken: every desktop app has the ordinary sign-in now, and
  on Linux the sign-in points to the system browser. Still open: whether Linux
  keeps a window at all, or opens the browser at launch instead, and **the way
  back with no tray** (stock GNOME shows none without an extension).

### Server nodes

Two tasks, split on purpose (Curtis, 2026-09-25): packaging for the widest range
of deployments, and then an easy path for people who want one.

- **Sample compose files** - documented, with and without a bundled HTTPS proxy.
- **Restore from a backup in the Server/Device app** - the Backups page makes,
  lists and downloads them (2026-09-25); putting one back still means stopping
  the node and unpacking by hand.
- **A wedged node** - the supervisor restarts a node that exits, not one that
  stays up and stops answering `/health`; a liveness watchdog is the missing
  half, if a wedge is ever seen.

### Revalidation (2026-10-07)

A body or thumbnail asked at a bare address is revalidated at every use, and the
node can only say 304 after the work it would do to serve it: a private body
opens the whole store (ownership, two keystore files, every epoch key unsealed,
the fold's catch-up, the head row); a public one checks the shelf and the peek,
re-verifies a fragment's proof or catches the public lane up. An address that
names its version is answered `immutable` and never asked again - done for
private thumbnails (`?v=<head>`, 2026-09) and Drawing's pictures (`?v=`, the
private body door, 2026-10-07). Left:

- **Images embedded in notes** - a note's text carries
  `/api/identity/…/docs/<doc>/body/<name>.<ext>`, bare, and the marquee renderer
  has no image hook to add the doc's head (its hooks are `turbolink`,
  `directive` and `span`). One `image` (or `src`) hook in
  `@cube-drone/marquee-react-renderer`, and `doccache.js`'s `versionedBodyUrl`
  does the rest.
- **Public post words on every card** (`/id/…/docs/<doc>/body`) - feed rows
  carry no version the node can check. `updated_ms` is the head's time, but a
  fragment's header has no time of its own and two edits can share a
  millisecond, so the safe version is the content hash: a `feed_journal` column
  for it (a node rung, and the fan-out writes), and the public door answering
  `immutable` when `?v=` is the hash it serves.
- **Kept tags for public words: measured, not built** (2026-10-07). With the
  kept stores and kept private body tags in (HISTORY), a private body's
  revalidation answered from memory costs the node about 0.2 ms; a public post's
  words, from a held chain, about 1-2 ms (debug build, the node's own
  `time.busy`). The public answer depends on far more than the private one -
  speculative, peek and hosted state, the posts floor, the fragment shelf
  (rewritten constantly by `checked_ms`), takedowns, `?via=`, the reader - and
  can fetch over the network mid-request, so a cache there costs a dozen
  invalidation inputs, one of them a takedown that must never answer 304, to
  save a millisecond or two a card. Not unless a fragment-served stranger's post
  (which re-verifies its proof per request; not measured) shows a cost that
  earns it.

### Sync status (plans/SYNC_STATUS.md)

- **horsedrawingtycoon.com's discovery records** - its DHT publishing times out
  ("Publish query timed out with no responses", "All relays responded with
  unexpected responses"); the address memory (step 7) works around it between
  computers that have talked, but a stranger still can't find the server by id.
  Worth a look at outbound UDP from that machine, and at iroh's own relay and
  discovery lines in its log.
- **Tune the cloud's thresholds on a real large sync** - the starting numbers (5
  s or 50 entries, 10 bodies, 10 s of network work, 3 s hold, 5 s linger) were
  agreed, not measured.
- **The busy faces, seen** - the debounce and the precedence are unit-tested and
  the idle cloud was seen in a page; an arrow or the sun hasn't been watched on
  a real screen yet.

### Query plans (the 2026-10-07 audit)

Every production statement in `node/src` was run through `EXPLAIN QUERY PLAN`
against freshly migrated node and user databases, and the scans, sorters and
correlated subqueries traced to their callers; HISTORY's Turso 0.8.2 entry
re-planned them all. Plans on an empty database are taken to be production's:
Turso keeps no statistics. Each fix goes the way the fold read's did: a timing
test, the change, then a plan assertion so it cannot come back. Worst first:

- **The peek-expiry claims flaked once under the full suite** (2026-10-07) -
  `peek_footprint.cjs`'s three ("the shelf came again" 0 vs 20) failed in one
  `just ci` of four on the same code, passed alone twice. Timing under load,
  most likely (the evict beat and the look's refetch); unproven - if it comes
  back, its node logs say whether the refetch ran.
- **Scratch's slow idle room-sync passes** - about 1.2 s with 4-8 ms of lock
  wait. "room-sync" is `chat::sync_pass` (`lib.rs:649`), not the pulse the audit
  first blamed: it reads the small `rooms_open` table, then pulls each open room
  over the network, so the time is probably the network's. The full log line's
  `db_exec_ms` says which.
- **Left as they are, with the reason** - the market's emoji window walks every
  tag annotation (`annotations.rs`, `emoji_noted_between`), once a day over a
  month at most, as its own comment accepts; public post listings scan and sort
  the persona's heads (`documents.rs`, the public lane's pages), one row per
  post, cheap until somebody posts thousands; `storage::all` (`storage.rs`, 761
  ms once on scratch) serves only the admin People list. Each is a partial index
  or a per-persona memo away if it starts to show.
- **`entries_page` needs an index before it is routed** - the POSTS log pages
  (`imaol.rs`, `entries_page`) sort every POSTS entry by
  `(timestamp_ms, seq, entry_hash)` per page, and its row-value cursor cannot
  seek. Nothing but its own tests calls it yet (`store.rs`'s `AppendLog::page`,
  Tier 4S); whoever routes it owes it a user-ladder index on
  `(service, timestamp_ms, seq, entry_hash)` and the continuation shape
  `rows_after_cursor` uses.
- **A slow single-row lookup on scratch** -
  `SELECT 1 FROM identities WHERE root_pubkey = ?1 AND account_id = ?2`, a
  primary-key read, logged over 250ms once; the timer starts after the statement
  lock, so only a file-lock wait or a machine stall explains it. Unplaced: if it
  recurs, its neighbours in the log say which.
- **Keep the audit as a standing test** - a test that pins the plan of every hot
  statement, so a planner surprise (or a Turso bump) fails CI instead of
  surfacing in a server's logs. Turso's known quirks, for whoever writes it: a
  range on a column after an unpinned one is not seeked (pin `instance`); it can
  pick a worse index over a fully pinned primary key; row values never seek;
  `IN (…)` on a non-leading column scans.

### Marquee Promises

- Marquee provides fixtures for drop-in functionality: do we still have a use
  for those?
- Marquee provides tools to build whole websites: do we still plan to let users
  host a geocities-style-page?
- We could do better marquee completion; right now we hardcode a bunch of
  Marquee stuff but we could do better at pulling Marquee information directly
  from the spec or active version.

### Mobile

- oh this one's hard as fuck
- idk defer defer
- does this connect to a federated node or fully run the protocol in rust?

### Real-Time Chat

- The "seed" is shared, like a Post would be, and can be rebroadcast, also like
  a post would be

### Weird Ideas

- Anki-Style Flashcards
- Minesweeper/Solitaire
- VN Engine
- Whiteboard/shared board
- Post Signatures
