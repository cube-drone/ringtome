# ActivityPub - a persona the fediverse can follow

A design draft (2026-10-14). Nothing built.

A persona served from a node with a real domain answers to Mastodon and the rest
of the fediverse as an ActivityPub actor: `@cube-drone@horsedrawingtycoon.com`.
Someone on Mastodon can find it, follow it, see its public posts in their home
timeline, and boost them. The persona follows nobody back yet.

What Curtis asked for is under _The ask_. Everything after it is Claude's
proposal, and nothing below is a ruling until he makes it. The questions that
need him are gathered under _Open questions_.

## The ask (Curtis, 2026-10-14)

"I'd like for Personas that are served _from a FQDN_ to participate as public
ActivityPub nodes. They can't follow anybody else yet, but they _can_ be
followed and shared."

So:

1. **Only from a domain.** A persona takes part only on a node with
   `RINGTOME_PUBLIC_URL`.
2. **Followable.** A fediverse account can follow the persona, and its public
   posts reach that account's timeline.
3. **Shareable.** A fediverse account can boost a post.
4. **Not yet following.** The persona doesn't follow fediverse accounts, so
   there's no reading side: no fetching of remote posts and no fediverse
   timeline in the app.

This reverses the cut in [API_OLD.md](API_OLD.md) §12 ("deliberately _not_
ActivityPub"). That cut was about **federation**, and it still stands:
Ringtome's own sync, key trees and directory stay as they are. What this adds is
a **window**, a one-way face onto the fediverse, the same kind of thing the
public pages, RSS and the sitemap already are.

## What's already here

- **The node's domain and the persona's name.**
  - `RINGTOME_PUBLIC_URL` gives the base (`nodeface::public_base`).
  - An `@name` slug exists only on a node that has one
    (`webpath::has_public_url`, `slugs.rs`).
  - `/@cube-drone` resolves through `slugs::resolve`; an old name 301s to the
    current one.
  - Together, these are the WebFinger handle.
- **Stable addresses.**
  - `/ringtome/user/<short>` is the persona.
  - `/ringtome/user/<short>/post/<hex>` is a post. That form never moves
    ([WEB_ADDRESSES](WEB_ADDRESSES.md), ruling 5).
  - The pretty `/@name/path` form is the canonical one for people.
- **What's public, and whether it may be indexed.**
  - `post_page` already serves hosted personas' open posts only: never sealed
    ones, and 410 for a takedown (`documents::was_retracted`).
  - `crawl::indexable` already says whether a persona wants to be found.
- **Words as HTML.** `reading::words_html` renders Marquee to HTML on the server
  (cached), for the reading copy.
- **Pictures as public twins.** Baked at publish (`record/bake.rs`) and served
  at `/ringtome/user/<short>/doc/<twin>/body` and `/thumb`.
- **A hook on new public posts.** The fold lane (`fold::run_chain`) runs
  per-service legs when a persona's public chains move.
  `nodeshelf::refresh_from` is the precedent: it runs only for personas hosted
  here (`is_agented`) and re-derives from `documents::public_docs`.
- **A retry queue.** `outbox.rs` has the shape: a node.db table, 30 s backoff
  doubling to an hour, and giving up after three days. Its delivery is iroh, not
  HTTP, so ActivityPub needs a queue of its own in the same shape.
- **Safe outbound HTTP.** `net/unfurl.rs` vets every DNS answer on every
  redirect hop, pins the vetted IP and rate-limits. Every fetch of a remote
  actor goes through it.
- **RSA, without a new crate.** `aws-lc-rs` is already in the tree (through
  rustls), and it generates RSA keys and signs and verifies PKCS#1 v1.5 SHA-256,
  which is what Mastodon's HTTP signatures use. The `rsa` crate stays out: it
  carries an unfixed timing advisory (RUSTSEC-2023-0071).

## The proposal

### 1. Who is an actor

A persona is an actor on a node when all three hold:

- the persona is hosted here;
- the node has `RINGTOME_PUBLIC_URL`;
- the persona holds an `@name` here.

The `@name` is the fediverse username, because a handle like
`@HVnmWLq8YSnyiUCupmHM6wP91yrwC6PpcynabWGVHRkL@horsedrawingtycoon.com` is no use
to anyone. See open question 1 for whether it's automatic.

**The actor's `id` is the address that never moves:**
`https://horsedrawingtycoon.com/ringtome/user/<short>`, not `/@cube-drone`.

- ActivityPub ids are permanent; Mastodon keys follows on them.
- An `@name` can change.
- With the stable id, a rename becomes an `Update(Person)` with a new
  `preferredUsername`, and Mastodon carries the followers over. An id that
  changed with the name would orphan every follower.
- The actor's `url` (the link people click) is the pretty `/@cube-drone`.

**One node, one actor.** A persona hosted on two nodes with two domains is two
actors (open question 4). Each node's `@name` is its own (slugs.rs: "a node fact
that means nothing on any other node"), so its fediverse face is its own too.
Each node keeps its own followers and delivers to them. `alsoKnownAs` can name
the other faces later.

### 2. The discovery surface (read-only)

- **WebFinger.**
  `GET /.well-known/webfinger?resource=acct:cube-drone@horsedrawingtycoon.com`
  returns JRD with a `self` link to the actor id (`application/activity+json`)
  and a `profile-page` link to `/@cube-drone`. An old `@name` answers too, with
  the current actor, the way its page 301s.
- **Content negotiation** on the existing addresses.
  - An `Accept` of `application/activity+json`, or `application/ld+json` with
    the ActivityStreams profile, gets JSON. Everything else gets the page, as
    now.
  - This works on `/ringtome/user/<short>`, on `/@name`, on
    `/ringtome/user/<short>/post/<hex>`, and on a post's pretty path (which
    answers with the post's stable id).
  - It's what makes pasting any link into Mastodon's search box work, and
    pasting a post's link is how most boosts of a stranger's post start.
  - The HTML gets `<link rel="alternate" type="application/activity+json">`.
  - **Every negotiated response says `Vary: Accept`.** The persona's page is
    cached by CDNs for five minutes, and without it a CDN would hand the JSON to
    a browser, or the page to Mastodon.
- **The actor (`Person`).**
  - Name, bio as `summary`, avatar as `icon` and banner as `image`.
  - Public profile fields as `PropertyValue` attachments.
  - `publicKey` (section 4).
  - `inbox`, `outbox`, `followers` and `endpoints.sharedInbox`.
  - `discoverable` and `indexable` both read `crawl::indexable`: one switch for
    search engines and fediverse search alike.
  - Its `published` is the persona's creation.
- **The outbox.** An `OrderedCollection` of `Create(Note)`, newest first, paged
  20 at a time. Mastodon doesn't backfill from it, but it reads the count, and
  other software reads more.
- **Each post (`Note`)** at its stable id (section 5).
- **The followers collection.** The count alone (`totalItems`), with no list of
  who. Mastodon hides lists by default too, and they're nobody's business.
- **NodeInfo.** `/.well-known/nodeinfo` and `/nodeinfo/2.1`: software
  `ringtome`, the version, and open registrations if the node takes signups.
  This is what fediverse directories and some clients read.

Slice 1 alone is enough for a boost. Someone pastes a post's link into Mastodon,
it fetches the Note, and they boost it. The `Announce` that arrives at the inbox
is acknowledged and set aside (section 6).

### 3. Following

The inbox, `POST /ringtome/user/<short>/inbox`, plus a shared `/inbox` for the
node:

1. **Verify the HTTP signature** (draft-cavage, which Mastodon sends, plus RFC
   9421 when it's present).
   - Fetch the signer's actor through the unfurl guard, keeping a cache table.
   - Check `Digest`/`Content-Digest` against the body and the `Date` within a
     few minutes.
   - Check that the signer is the activity's `actor`.
   - Anything unsigned or mismatched gets 401. Everything else is acknowledged
     with 202 before any work.
2. **`Follow`** of an actor here:
   - record the follower: actor id, inbox, shared inbox, and when;
   - queue an `Accept(Follow)` to their inbox.
   - Follows are accepted automatically; there's no "locked account" yet.
3. **`Undo(Follow)`** removes the follower.
4. **`Delete`** of the follower's own actor removes them everywhere here.

When a remote server is in "authorised fetch" mode, it refuses unsigned GETs. So
the node needs an **instance actor**, `/actor` (an `Application`, the shape
Mastodon itself uses), with an RSA key of its own to sign the GETs it makes.
Inbound GETs of our own actors and posts stay unsigned and public, because
everything they show is already public.

### 4. Keys

Mastodon's HTTP signatures need RSA, and a persona's keys are ed25519. So each
actor here gets an **RSA-2048 key of the node's own**:

- minted on first need with `aws-lc-rs`;
- sealed in the keystore like the node's iroh and VAPID keys;
- published as the actor's `publicKey` (`#main-key`).

It's a credential of this node's fediverse face, not of the persona. It signs
nothing in Ringtome, and Ringtome never trusts it. A second node serving the
same persona has a different one, which is honest, since it's a different actor.

The persona's own ed25519 root may later ride along as an
`assertionMethod`/`Multikey` (FEP-521a), so fediverse software that cares can
see which Ringtome identity is behind the actor. Not in the first slices.

### 5. What a post looks like there

**A `Note`, always, titled or not** (open question 2).

- Mastodon shows a `Note` in full.
- For an `Article`, older Mastodon showed only the title and a link, and newer
  Mastodon still shortens it.
- A titled post's title leads the content as `<p><strong>…</strong></p>`.

The fields:

- **`id`**: `/ringtome/user/<short>/post/<hex>`.
- **`url`**: the pretty path.
- **`content`**: `reading::words_html`, kept to what Mastodon's sanitiser keeps
  (paragraphs, breaks, links, emphasis, lists, quotes, code). Embeds the
  fediverse can't show become links.
  - A post over about 5,000 characters, or a book's page, is sent as its first
    paragraphs, followed by a link: "Read the rest on horsedrawingtycoon.com".
    The whole text is always one click away, and a timeline doesn't fill with a
    chapter.
- **`attachment`**: the post's pictures as `Image` documents pointing at their
  public twins, with alt text when the post has it. Mastodon shows four. Sounds
  and video as `Audio`/`Video` where the twin exists.
- **`tag`**: the post's public tags as `Hashtag`s, so it shows up in those
  hashtags' timelines on servers that receive it.
- **Addressing**: `to: Public`, `cc: followers`. A public post goes out as
  "public", never as "unlisted".
- **`published`** and **`updated`** come from the signed header.

**To check before building:**

- Thumbnails are AVIF. If Mastodon won't process AVIF for remote media, the
  actor's `icon`/`image` and the attachments need a JPEG or WebP rendition. Bake
  already mints twins, so it can mint one more.

### 6. Delivery

On the fold lane, a leg like `nodeshelf::refresh_from` runs for actors here
whenever the posts chain or the profile moves.

- **It compares the public posts against what it last sent** (`ap_sent`: doc id,
  version, sent).
  - A new post → `Create(Note)`.
  - A changed version → `Update(Note)`. Mastodon shows it as edited.
  - A takedown → `Delete` (`Tombstone`), and the post's id then answers 410 as
    the page does.
  - A changed profile → `Update(Person)`.
- **It doesn't backfill.** A persona who takes an `@name` doesn't push their
  history at their first followers; Mastodon wouldn't show it in a timeline
  anyway.
- **One delivery per shared inbox**, not per follower. A Mastodon server with
  forty followers gets each post once.
- **The queue** (`ap_deliveries`) has `outbox.rs`'s shape: signed at send time
  with the actor's key, 30 s backoff doubling to an hour, given up after three
  days. A server that has failed for three days straight has its followers set
  aside rather than queued forever.
- **Deletion copy stays pessimistic** (as everywhere else). Mastodon honours
  `Delete`, but copies on other servers are their operators' business. What the
  app says about a takedown already promises no more than that.

**Leaving:** when a persona leaves the node, or gives up its `@name` and takes
no other, `Delete(Person)` goes to its followers, and the actor answers 410.

### 7. What arrives and is set aside

The persona can't follow anyone, so inbound activity has no timeline to land in.

- **`Announce`** (a boost) and **`Like`**: acknowledged with 202 and dropped in
  slice 2. A later slice counts them (open question 3).
- **`Create`** (a reply to a post here, or a mention): acknowledged and dropped.
  Showing replies from the fediverse beside Ringtome's own is its own design:
  they're unsigned by any Ringtome key, and moderation here _is_ the trust
  graph.
- **Everything else** gets 202 and is ignored. A 4xx would make the sender
  retry.

### 8. The app's side

- **On the persona's settings**: "Followable from the fediverse as
  `@cube-drone@horsedrawingtycoon.com`", with a copy button, shown only where
  it's true.
- **The follower count, and a list.**
  - The list holds handles and their servers, with **remove**, which sends
    `Reject(Follow)` and drops the follower.
  - That is the whole of moderation in this design: the persona chooses who gets
    their posts delivered. Anyone can still read them on the web.
- **For the operator**: a list of refused domains (`RINGTOME_AP_BLOCKED`):
  - the inbox refuses them;
  - nothing is delivered to them;
  - fetches of their actors are refused.

### 9. Tables and modules

`activitypub.rs` (with `activitypub/` for the signature code and the JSON
shapes) owns these node.db tables (tests/conventions.rs), in one new migration
rung:

- `ap_followers`: persona root, actor id, inbox, shared inbox, followed when.
- `ap_sent`: persona root, doc id, version, sent when, deleted.
- `ap_deliveries`: inbox URL, signing actor, body, tries, next try, created.
- `ap_actors`: a cache of remote actors (id, inbox, shared inbox, public key,
  fetched when) for signature checks.

The RSA keys live in the keystore, not a table.

## Slices

1. **Visible.**
   - WebFinger, NodeInfo, the instance actor, actors and Notes by content
     negotiation, `Vary: Accept`, and the outbox and followers counts.
   - An inbox that verifies signatures and answers 202 to everything.
   - Done when Mastodon finds `@cube-drone@horsedrawingtycoon.com`, shows the
     profile, and boosts a pasted post.
2. **Followable.**
   - `Follow`/`Undo`, `Accept`, the delivery queue, and Create/Update/Delete on
     the fold lane.
   - Done when a Mastodon follower sees a new post in their home timeline, then
     the edit, then the takedown.
3. **In the app.** The handle, the follower count and list, remove, and the
   operator's refused domains.
4. **Later, each its own decision**:
   - counting boosts and likes;
   - replies from the fediverse;
   - `alsoKnownAs` across a persona's nodes;
   - FEP-521a;
   - and, much later, following back, which is the reading side.

## Testing

The rig can't run a Mastodon, so it gets a **fake fediverse server**: a small
Node script in the integration harness. It:

- serves an actor with an RSA key;
- signs and sends `Follow`/`Undo` the way Mastodon does;
- receives deliveries and checks their signatures with a verifier of its own;
- answers or refuses signed GETs.

The SSRF guard already lets the rig through (`unfurl.rs`), so the fake server on
localhost is reachable.

Beyond the fake:

- **Pure tests** of the signature code against published draft-cavage vectors,
  and a round trip.
- **Before slice 2 is called done**: a real Mastodon account follows a scratch
  persona on horsedrawingtycoon.com, and Curtis watches a post arrive, change
  and go.

## Open questions

1. **Automatic, or a switch?** The proposal makes every persona with an `@name`
   on a domain followable, since claiming the name is already the act of going
   public there, and the posts are already on the web. The alternative is a
   switch on the persona, off by default. Recommended: automatic, with the
   switch added in slice 3 for anyone who wants out. Turning it off sends
   `Delete(Person)`.
2. **`Note` for titled posts too?** Recommended, for the reason in section 5.
   `Article` is more correct and is shown worse.
3. **Boosts and likes from the fediverse**: dropped in slice 2. Should a later
   slice show them as a count on the post, as notifications, or not at all?
4. **Two domains, two actors.** Is a persona with followers on two nodes'
   fediverse faces acceptable for now? The alternative, one actor shared across
   nodes, needs one node to be "home", which Ringtome has deliberately never
   had.
5. **Personas without an `@name`** on a domain node: not actors at all
   (proposed), or actors under their short key?
