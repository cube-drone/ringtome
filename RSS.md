# hrseRSS™

A design draft (2026-09-30). Nothing built.

A feed reader inside Horse Drawing Tycoon 2. You add feeds, which the node fetches and turns into
Marquee documents you read in the app, and you can pass an item on to the people who follow you.

What Curtis asked for is under *The ask*. The sections after it are Claude's proposals and are not
yet rulings: in particular *Where the items live*, which changes one part of the ask, and
*Rebroadcasting*, which narrows another.

## The ask (Curtis, 2026-09-30)

1. **A new app, hrseRSS™.** The user adds RSS feeds, and the list is saved on their **private
   chain**.
2. **Feeds in a column on the left, taggable.**
3. **Adding a feed makes the server fetch it** and convert each item into a **Marquee document** in
   an **RSS-specific bucket**. The item's images are downloaded, processed into server-friendly
   versions, and kept in that bucket. They aren't shown in the feed on their own.
4. **A background process refreshes every feed on the server** about **every 3 hours**. It checks
   whether the source is reachable, pulls the feed, converts new items, and updates old ones that
   have changed.
5. **More than one server.** A persona hosted on several servers may have several of them pulling
   the same feed. A server doesn't change documents it knows already exist elsewhere. If two
   servers pulled the same item and can't tell which takes precedence, pick one.
6. **The merged view.** With no feed selected, the app shows every item from every feed, newest
   first.
7. **Rebroadcasting an item** republishes it under the user's nameplate, carrying the item's RSS
   metadata so other people can find and follow the same source.
8. **Fetched once per server.** If many users on one server follow the same feed, it's fetched and
   processed once.

## Where the items live (proposal)

The ask puts each item on the subscriber's own chain, as a document in their bucket. The proposal
is instead: **the subscription is on the chain; the items are not.**

- **On the private chain** (the user's own facts, which travel to all their computers):
  - the feeds they follow, and the tags on them;
  - anything they *do* with an item: copy it into notes, save it, rebroadcast it. The moment an
    item is acted on, it becomes the user's own document, like any other copy into notes.
- **In a node-level item cache** (`rss_feeds`, `rss_items`, owned by `rss.rs`, beside `node_shelf`):
  - every item of every feed anyone on the node follows, as converted Marquee, keyed by
    `(feed, item id)`;
  - its images as content-addressed blobs, which the blob store already shares between everyone.

Why:

- **"Fetched once" becomes "stored once".** On chains, fifty users following one feed means fifty
  copies of every item. Each copy would be a chain entry synced to every one of that user's
  computers, forever. A busy feed of 50 items a day is about 18,000 entries a year per
  subscriber.
- **An item isn't the user's words, and a chain entry is signed by the user's key.** Putting a
  newspaper's article on your chain has your key vouching for text you didn't write.
- **Point 5's conflict disappears.** Each server's cache is its own, and there's nothing to merge,
  so "pick one" is never needed. As a chain design, point 5 is merge-hostile in exactly the way
  worth flagging: two servers writing their own versions of the same document, and a tiebreak.
- **Point 4's updates become trivial.** A changed item is overwritten in the cache. On a chain,
  every revision is a new version that every device syncs.

What it costs:

- **Missed items.** A computer that's been off (the desktop app) fetches for itself when it wakes.
  Items the feed has dropped by then are missed there, even if the user's server saw them.
- **The fix, as a later slice:** a device asks the user's other nodes for their cached items.
  Item ids are stable across nodes (below), so caches agree on what's the same item.
- **Read state** (if we want it) is a user fact and goes on the chain as one watermark per feed,
  the way the bell's "mark all read" works. It doesn't need a row per item.

## Fetching

- **Reuse `net/unfurl.rs`'s guards:**
  - http/https only;
  - every DNS answer on every redirect hop must be a public address, and the connection is pinned
    to the vetted address;
  - a timeout;
  - the global outbound rate bucket.
- **Caps and identity:**
  - the size cap grows for feeds: 5 MB a feed, and the newest 200 items kept per feed;
  - one fetch per feed URL per node, after normalising the URL (scheme and host lowercased, fragment
    dropped), which is point 8.
- **Politeness:**
  - send `If-None-Match` / `If-Modified-Since`, and a `304` costs nothing;
  - honour the feed's own `<ttl>` or `Cache-Control` when it asks for *less* often than 3 hours;
  - honour `429` and `Retry-After`;
  - add jitter, so a node's feeds don't all fire at the top of the hour.
- **Unreachable sources back off** (3h, 6h, 12h, a day). After a month of failures the feed is
  marked quiet in the app, and fetching drops to weekly.
- **A per-account cap on subscriptions** (a few hundred), since one account can otherwise make the
  node a crawler.
- **Parsing:** RSS 2.0, RSS 1.0 and Atom. The `feed-rs` crate is the likely choice. Whatever parser
  is used must never expand entities or read a DTD: a feed is hostile input, and the entity tricks
  (billion laughs, external entities) are the classic attacks on XML.
- **Item identity:** the feed's `guid` / `id`, else its link, else a hash of title and date. A
  content hash detects changes, so point 4's update is re-convert-and-replace.

## Converting: HTML to Marquee, never HTML

A feed item's body is someone else's HTML. The app's own page has no Content-Security-Policy, so
HTML that gets rendered as HTML is one sanitizer bug away from running as the signed-in user. The
rule: **translate, never sanitize.**

- **The translator:**
  - parse the item's HTML with a real parser (html5ever) and walk the tree;
  - emit Marquee for an allowlist: paragraphs, emphasis, headings, lists, quotes, code, http/https
    links, and images;
  - everything else disappears, because Marquee has no way to express a script, a style, a form, an
    iframe or an event handler.
- **Where it lives:** a new crate beside `marqueemarkup/rust/markdown` (the Markdown converter is
  the precedent), so the translator belongs to the markup, not to Ringtome.
- **Body choice and links:** prefer `content:encoded` or Atom `content` over the summary. Resolve
  relative URLs against the item's link.
- **Images:**
  - fetched through the node (`fetch_media_bytes`), baked into the node's own formats, and kept as
    the item's embeds;
  - so the reader's browser never loads a remote image, and no tracking pixel learns who read what;
  - capped at twenty images per item, and 1×1 images dropped;
  - an image that fails to fetch becomes a link.
- **Enclosures** (podcast audio, video) are links, not downloads, at least at first.
- **A CSP for the app page** is worth adding regardless (`script-src 'self'` at least), as a
  second layer under all of this.

## The app

- **Three columns,** on the panes machinery (resizable, tuckable):
  - **feeds**, with their tags and the tag cloud, as the Notes app does;
  - **items**;
  - **the reading pane**.
- **No feed selected: the merged view** of every item, newest first, by the item's own date. An
  item dated in the future, or far in the past, is filed at its fetch time instead.
- **Adding a feed:**
  - paste a feed's URL, or a page's (the node looks for its `<link rel="alternate">`, the tag our
    own person pages now carry);
  - if the feed is a Ringtome persona's own `rss.xml`, the app offers to **follow the persona**
    instead, since that's the better version of the same thing.
- **An item wears its feed's name and icon** where a post wears its author's, and the house chips
  (copy into notes last).
- **HorseBucks:** reading earns nothing, and an item copied into notes isn't "words written". A
  rebroadcast earns like any post.

## Rebroadcasting (proposal, narrower than the ask)

The ask republishes the item under the user's nameplate. The narrowing: **republish the pointer, not
the article.**

- **The item's words aren't the user's.** A full copy under their name, served by their node to
  strangers (and possibly the front page), is a copy of somebody's article with the wrong byline on
  it.
- **The rebroadcast is a post** carrying:
  - the item's title, its link, and its summary (the feed's own `<description>`, which the source
    publishes to be quoted);
  - the source metadata: the feed's URL and title, and the item's id;
  - the user's own words, if they add any.
- **It reads as "via *The Source*"**, with a **subscribe** chip that adds the feed to the reader's
  own hrseRSS, which is point 7's discovery.
- **Open question for Curtis:** whether full-text republishing is wanted anyway, perhaps only for
  feeds whose licence says so (`<copyright>` / Creative Commons).

## Slices

1. **Subscriptions and the cache.** The subscription register on the private chain, the fetcher
   with its guards, the node-level cache with plain-text items, the 3-hour worker, and a bare list.
2. **The translator.** HTML to Marquee, and images through the node.
3. **The app.** Columns, tags, the merged view, and the reading pane.
4. **Rebroadcast** with source metadata, **subscribe** from a rebroadcast, and **follow instead**
   for Ringtome feeds.
5. **Sharing caches** between a persona's own nodes, so a device that was off catches up.

## Open questions

- **The items' home.** The cache (proposed) or each subscriber's chain (as asked)? Everything else
  in this document assumes the cache.
- **Rebroadcast contents.** Pointer and summary (proposed), or the full text?
- **Read/unread:** wanted? And per feed or per item?
- **How long items live.** Forever, or the newest *n* per feed? The cache makes either cheap;
  chains would make "forever" the only answer.
- **Private feeds** (URLs with a token in them): allowed? The URL would sit on the private chain,
  but the node's cache would hold the items for anyone else on the node who followed the same URL.
  That's correct, but the node should never merge two users' private-token feeds into one fetch
  unless their URLs are identical.
