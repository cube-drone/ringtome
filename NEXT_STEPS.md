# Ringtome — Next Steps

Here's where we write out _things we're planning to work on_.

This is a loose plan of upcoming feature work and immediate near-term goals we are driving towards.

**Forward-looking only:** finished work leaves this file - full report in [HISTORY.md](HISTORY.md).

## Near-Term Goals

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
* Search my posts
* Search my feed
* Posts can be annotated with tags, emoji, description, buckets
* Make a whole bucket public in one fell swoop.
* Rebroadcast: explicity share this post on my network, share this user to my network
* Save to bucket
* Node feed ("here's everything public hosted on this node")
* Node-observed feed ("here's everything public that anybody is looking at")

### Inbox

A place to store messages for an individual user.

* someone annotated your post
* someone followed you
* Encrypted peer-to-peer messaging?

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

### Marquee Promises
* Marquee provides fixtures for drop-in functionality: do we still have a use for those?
* Marquee provides tools to build whole websites: do we still plan to let users host a geocities-style-page?
* We could do better marquee completion; right now we hardcode a bunch of Marquee stuff but we could do better at
    pulling Marquee information directly from the spec or active version.

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
* within a persona, how are we managing our peer set? can we learn about new identity rows?
* Equivocation quarantine residuals (2026-08-06): the shelf goes silently dark while fork
  evidence stands - a reader-facing notice ("this identity's public history is disputed")
  beats unexplained emptiness; and evidence rows live outside the raw-entry journal, so a
  rebuild-from-journal forgets a standing quarantine until the proof re-arrives by sync.
* Fork-aftermath ceremony (2026-08-06, the Mallowy case - PROJECT_PLAN's "stale-backup fork,
  innocent flavor"): an innocent restore-from-backup fork condemns the key like any fork
  (doctrine - intent doesn't sign), and recovery exists mechanically (retire the doubled leaf
  anchoring one branch - the evidence rows hold BOTH envelopes, so either is anchorable -
  adopt a fresh key, re-sign what the anchor dropped) but is neither surfaced nor guided.
  Wants: an owner-facing "your key doubled, here's the ceremony" flow. Related prevention: a
  post-restore write-fence (hold signing until one sync round completes) turns most stale-
  backup forks into fast-forwards. The unhandled hard case: a fork on the ROOT's own identity
  chain - the plan's deferred tiebreaker, no senior left to adjudicate.

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

### Mobile
* oh this one's hard as fuck
* idk defer defer
* does this connect to a federated node or fully run the protocol in rust?
