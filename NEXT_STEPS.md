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
* GC: clean up unused docs and files
* Document: list attached files (informs GC)
  * Produce a list of media files that aren't linked anywhere
* mp3 tags -> annotations (keep things like album artist)

### People

* Search my people / all visible people

### Public posts and fan-out

* Posts link to a post-specific page (each post has its own location)
* obviously the feed should use swatch internet time rather than dumb old localized time, or maybe ... both
* Search my posts
* Search my feed
* Posts can be annotated with tags, emoji, description, buckets
* Make a whole bucket public in one fell swoop.
* **Rebroadcast — shipped end to end 2026-08-11** (PROJECT_PLAN, *Rebroadcast: Pointer Plus
  Pinned Replica* and its two network subsections; HISTORY has the arc and the fragment slice).
  Pointer, pin, both notice halves, public tombstone, media budget, feed with `via_root`, and
  the fragment ledger. What is left:
  * **The node-death test** - kill the author's and the sharer's nodes, assert a reader still
    serves the share from its own fragment. Needs a self-hosting harness: the shared four nodes
    cannot be stopped mid-run without breaking every other spec (`mainline.cjs` shows the shape
    - spawn/waitHealthy/stopNode, pointed at local discovery rather than the real DHT).
  * **The edit window** and **delete memo + bloom summaries** - the two trim slices that bound
    what a node must remember forever. Designed, unbuilt.
  * **UI**: nothing renders `via`/`via_name`, and there is no share button.
  * Then replies (rebroadcast + comment, parent-plus-root pinning leaning), and "share this
    user to my network" after that.
* Save to bucket
* Node feed ("here's everything public hosted on this node")
* Node-observed feed ("here's everything public that anybody is looking at")


### Inbox

Design settled 2026-08-09 - PROJECT_PLAN's *Arrival and Attention* (extended). The first kind
("someone you don't follow published an edge naming you") shipped the same day: the envelope
format and its offline verification, the `ringtome/deliver/0` ALPN, the gate at transcription,
both tiered inbox chains, the outbox with its backoff ladder, and the bell showing delivered
beside derived. What is left:

* **More notice kinds**: commented on / tagged / rebroadcast your post - each needs its own
  evidence rule in `deliver::verify_claim`; and first-contact, the one bare-claim kind, which
  needs the capped greeting surfaced and its own smaller pool.
* **Sealed-envelope relays**: a friend's always-on node holding a notice for a phone that is
  never awake. Needs the envelope sealed to the recipient's epoch key, which direct delivery
  does not (iroh QUIC already encrypts point to point).
* **The transport tier**: pricing connection admission by shared public-edge standing.
* Encrypted peer-to-peer messaging? (that's DMs - the Sealed Pair, settled separately)
* Notification Badge (3 new!)

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
* Shallow sync: our first sync from a dense user is yuuuuge
* Detected equivocation kills the key that generated it
 * After a restore-from-backup, try to sync with ANYONE ELSE to make sure we aren't accidentally equivocating
 * What's the UI for this?

### Mixtape & Radio
*  a mp3 browser

### Trust
* advogato-style joint flow calculation to determine how much we trust a person who we've never met, but exists somewhere in our trust graph
* using trust & rebroadcast rules to surface content to users
* adversarial simulation

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

### Weird Ideas
* Anki-Style Flashcards
* Minesweeper/Solitaire
* VN Engine
* Whiteboard/shared board
