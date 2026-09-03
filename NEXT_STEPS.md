# Ringtome — Next Steps

Here's where we write out _things we're planning to work on_.

This is a loose plan of upcoming feature work and immediate near-term goals we are driving towards.

**Forward-looking only:** finished work leaves this file - full report in [HISTORY.md](HISTORY.md).

## Near-Term Goals

### Localization
* An in-ui way to cheat your presented language, for testing
 * just fully do french and spanish or something

### Private Notes

* Import/export bucket or whole persona
* Cross-bucket document transfer.
* Document history: let me go back in time
* GC: clean up unused docs and files (first customer: blank drafts - untitled, empty, unposted - which the feed stack now hides rather than lists, 2026-08-28)
* Document: list attached files (informs GC)
  * Produce a list of media files that aren't linked anywhere
* mp3 tags -> annotations (keep things like album artist)

### Public posts and fan-out

* Search my posts
* Search my feed
* Publishing from Writer — [PUBLISH.md](PUBLISH.md) (2026-09-02): slices 1 (the date on
  the wire) and 2 (scheduling) built; the Writer button and status icons next
* A race in public_annotations.cjs ("the relayed proof names its carrier", seen red once on
  2026-09-02, green on the clean-tree rerun): cal's node admits ada speculatively through
  bea's vouch, the acquisition pass pulls ada's chain on the rig's 2s beat, and the chain
  fold's note overwrites `learned_via` relay→chain before the test reads it. Settle it one
  of two ways: keep the FIRST road on conflict (the forensic reading - how it first got
  here is what the dossier wants), or have the test accept either road. Curtis's call.
* Post visibility — PROJECT_PLAN's Post visibility: arc closed 2026-09-02 ("settled" and
  "trusted only" built, sealed bodies and pictures, key lane, feed/discovery filters);
  the one deferred direction is sharer-scoped share journaling, with its trigger pinned
* Public annotations — the arc, rulings pinned and sliced in [ANNOTATIONS.md](ANNOTATIONS.md) (2026-08-29): tags, description, date, and bucket go public at publish, third parties annotate on their own chains, everything rides virally, the reader chooses whose labels show
* Video in public posts: the private half shipped 2026-09-03 (a video the ingest already
  crushed bakes a WebM twin with its poster, sealed under a trusted post's key; acceptance in
  video_posts.cjs). Two residuals: (1) the EXTERNAL half - a video URL at publish time has no
  lane, because the node cannot decode the codec zoo (video-ingest/README.md: that laundering
  is the browser's job at upload) - refused with the road named; (2) done the same day: header key 18
  `animation` and the `-loop` spelling, drawn looping by marqueemarkup's renderers - which
  lands in ringtome when 0.7.2 publishes (bump the deps; add a render claim for the loop
  attributes to pure/mediakind.cjs then). (3) done the same hour: the upload flow
  respells the reference from the crushed document. The public twin also carries no
  hover-preview clip; nothing public reads one yet.
* Make a whole bucket public in one fell swoop.
* Disable rebroadcasts (disable comments shipped as slice 6's suppress-all switch; a UI control for the mode register is still owed - PROJECT_PLAN's Replies)
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

* "followers-only" posts?
* "friends-only" posts

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
* Frontier refresh grew 4 -> 27ms per fold across an 8x80 test-data run (2026-08-28's
  quadratic hunt left it as the one unexamined tail): `memo_public_anchors` or the
  fingerprint walk scales with something - find which, with the "fold legs" line.
* Shallow sync: our first sync from a dense user is yuuuuge
* Detected equivocation kills the key that generated it
 * After a restore-from-backup, try to sync with ANYONE ELSE to make sure we aren't accidentally equivocating
 * What's the UI for this?

### Mixtape & Radio
*  a mp3 browser

### Trust
* Users in your extended trust network get access to the higher-priority higher-tier messages bucket?

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
* Anki-Style Flashcards
* Minesweeper/Solitaire
* VN Engine
* Whiteboard/shared board
* Post Signatures

