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
* obviously the feed should use swatch internet time rather than dumb old localized time, or maybe ... both
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
* Peer-set/discovery build, remaining bricks (Phase 1 SHIPPED 2026-08-07 - see HISTORY:
  universal serving records, derived peer set with revocation pruning, member-proven dialer
  upserts, leaf-first via minting + resolution, bare-root zeroth rung):
  * **Root announce rendezvous**: now needed only for personas whose FOUNDING node is gone
    (a founder's leaf is the root, so its serving record already makes bare roots resolve).
    Unauthenticated announce under a root-derived key; verified by chain-to-root at dial.
  * Equivocation quarantine residuals (2026-08-06): reader-facing "disputed" notice;
    evidence rows live outside the raw-entry journal (rebuild forgets a standing quarantine
    until proof re-arrives).
  * Fork-aftermath ceremony (the Mallowy case): owner-facing "your key doubled, here's the
    ceremony" flow; post-restore write-fence; the root-chain fork tiebreaker stays deferred.

### Popularity Problems

Making the 50k-in/50k-out user survivable. The follow ledger is assumed small in many places
(`subscriptions.rs` says so outright); every existing cap is on the read-a-page or dial-a-peer
axis, none on the follow-list axis. The steps, roughly worst-first:

* Fan-out journaling still runs inline in the frontier sweep — the delta watermark + chunked
  upserts shrank a move to ~1 statement per 100 readers per new post, so move it behind a
  spawned task only if it still measures as sweep lag (the recursion knot in
  `after_public_move` makes that non-mechanical)
* Author-side push polish: dials within the per-move cap (16, rotating via ask recency) are
  still sequential in `sync_peers` — worst case is cap × dial-timeout in a background task.
  Concurrent dialing (`buffer_unordered`) when that's measured to matter.
* `identity_demand` retention — the table never prunes (`identity_peers` prunes at 7 days);
  the wake pass's re-ask makes aggressive pruning safe, and the read side already windows
* Stream residual: docs + search rows still re-ship whole when any document moves — the
  roster's per-socket diff mechanism generalizes to them if note-hoarders ever feel it
  (doc rows grow with account lifetime, the same curve the private view had)
* People page: virtualize (50k mounted `<PersonRow>`s, each holding 4 liveQueries ≈ 200k live
  subscriptions); `/api/directory` is also unbounded
* Megabyte SQL literals: the 50k-term `NOT IN ('<hex>',...)` strings in the subscription memo
  rewrite and `excise_unfollowed` → temp table or join
* First-sync backfill stampede: every follow is "newly eager" ⇒ 50k user-DB opens through the
  128-slot LRU; frontier sweep stats every root (~100k syscalls/pass)
* Wake-pass starvation: 8 refreshes/minute means a full rotation over 50k follows takes days —
  the interest dial needs to actually tier the rotation, not just order it
* `missing_for_peer` buffers every missing entry in RAM before sending — stream instead
  (a new device joining a 50k-follow identity = ~200k entries held by the sender)

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
