# Ringtome — Next Steps

Here's where we write out _things we're planning to work on_.

This is a loose plan of upcoming feature work and immediate near-term goals we are driving towards.

**Forward-looking only:** finished work leaves this file - full report in [HISTORY.md](HISTORY.md).

## Near-Term Goals

### Localization
* An in-ui way to cheat your presented language, for testing
 * just fully do french and spanish or something
* humanize the writing

### Private Notes

* Import/export bucket or whole persona
* Cross-bucket document transfer.
* Document history: let me go back in time
* GC: clean up unused docs and files (first customer: blank drafts - untitled, empty, unposted - which the feed stack now hides rather than lists, 2026-08-28)
* Document: list attached files (informs GC)
  * Produce a list of media files that aren't linked anywhere
* mp3 tags -> annotations (keep things like album artist)

### Public posts and fan-out

* @user (directed comments)
* pinned posts
* blocked/hidden tags
* content warning (18+)
* public taxonomy
* Search my posts
* Search my feed
* mini-links (the kind you see in replies and your notifications) need to display more content
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
* Save to bucket
* Node feed ("here's everything public hosted on this node")
* Node-observed feed ("here's everything public that anybody is looking at")
* more granular or time-limited blocks? ("block for 6 months")

### Inbox

Design settled 2026-08-09 - PROJECT_PLAN's *Arrival and Attention* (extended). The first kind
("someone you don't follow published an edge naming you") shipped the same day: the envelope
format and its offline verification, the `ringtome/deliver/0` ALPN, the gate at transcription,
both tiered inbox chains, the outbox with its backoff ladder, and the bell showing delivered
beside derived. What is left:

* **More notice kinds**: first-contact, the one bare-claim kind, which needs the capped
  greeting surfaced and its own smaller pool (commented-on and tagged-your-post are built,
  each with its evidence rule in `deliver::verify_claim`).
* **Sealed-envelope relays**: a friend's always-on node holding a notice for a phone that is
  never awake. Needs the envelope sealed to the recipient's epoch key, which direct delivery
  does not (iroh QUIC already encrypts point to point).
* **The transport tier**: pricing connection admission by shared public-edge standing.
* Encrypted peer-to-peer messaging? (that's DMs - the Sealed Pair, settled separately)

### Friends & Groups

A new kind of document that's held in an unencrypted chain that's not public,
but only shared with folks who match a predicate (either "friend" or "in a group").

Does a mutual follow+trust make a "friend"?

* Define and manage group membership
* Groups-only posts

### Public means public (Gateway)
* the public-HTML browser for this repo

### Node Management & Federation
* multiple-personas per user
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

* Peeks and budgets — [PEEK.md](PEEK.md) (2026-09-05): every exchange budgeted, a first
  look at a stranger held as a shape (identity, annotations, twenty posts as fragments)
  with a footprint and an expiry, the identity chain capped; public pins (a `pin`
  annotation, the pinned strip, pinned fetched first) as slice 4; five slices. Slices 1
  (admission and budgets) and 2 (the peek) built 2026-09-05; footprint and expiry next. Residual: a misbehaving peer
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
* tray sidecar, autostart, app-mode window
* signing the application so it can actually ship to mac/windows boxes
* consider: a tauri or embedded browser to offer a more encapsulated experience

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
* Chat
* Anki-Style Flashcards
* Minesweeper/Solitaire
* VN Engine
* Whiteboard/shared board
* Post Signatures

