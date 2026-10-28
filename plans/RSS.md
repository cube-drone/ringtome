# Horse's RSS

A design draft (2026-09-30), ruled on 2026-10-27 (_Rulings_, below). Slices 1 to
6 built 2026-10-27 (_Slices_).

A feed reader inside Horse Drawing Tycoon 2. You add feeds, which the node
fetches and turns into Marquee documents you read in the app, and you can pass
an item on to the people who follow you.

What Curtis asked for is under _The ask_. The sections after it began as
Claude's proposals; _Rulings_ says which of them Curtis took.

## Rulings (Curtis, 2026-10-27)

- **Feed items are posts** (second round): the same card, automatic tags,
  tagging, rebroadcast and copy, folded into the main feed. See _Feed items are
  posts_.
- **Tags on an item are private until it is rebroadcast.** They live in a
  register on the tagger's private chain. A rebroadcast is an ordinary post on
  the network: the tagger's tags go onto it as its own, and everyone else's join
  them as on any post. No new chain entry.
- **Every followed feed folds into the main feed,** and the "feed item" kind
  chip leaves them out.
- **The app is called Horse's RSS,** not hrseRSS™: it doesn't follow the
  hrse-name model the other apps use.
- **Items live in the node cache,** not on chains: _Where the items live_ stands
  as proposed.
- **A rebroadcast republishes the full text,** with the source metadata. The
  pointer-only narrowing in _Rebroadcasting_ is declined.
- **Read state is one watermark per feed,** on the private chain.
- **The translator already exists:** `cube-drone-marquee-html-import`
  (marqueemarkup's `rust/html_import`, shipped in 0.9.0). It parses with
  html5ever through `scraper`, resolves relative links against a `base_url`, and
  reports what it dropped. _Converting_ below is what it does, not what has to
  be built.

## The ask (Curtis, 2026-09-30)

1. **A new app, Horse's RSS.** The user adds RSS feeds, and the list is saved on
   their **private chain**.
2. **Feeds in a column on the left, taggable.**
3. **Adding a feed makes the server fetch it** and convert each item into a
   **Marquee document** in an **RSS-specific bucket**. The item's images are
   downloaded, processed into server-friendly versions, and kept in that bucket.
   They aren't shown in the feed on their own.
4. **A background process refreshes every feed on the server** about **every 3
   hours**. It checks whether the source is reachable, pulls the feed, converts
   new items, and updates old ones that have changed.
5. **More than one server.** A persona hosted on several servers may have
   several of them pulling the same feed. A server doesn't change documents it
   knows already exist elsewhere. If two servers pulled the same item and can't
   tell which takes precedence, pick one.
6. **The merged view.** With no feed selected, the app shows every item from
   every feed, newest first.
7. **Rebroadcasting an item** republishes it under the user's nameplate,
   carrying the item's RSS metadata so other people can find and follow the same
   source.
8. **Fetched once per server.** If many users on one server follow the same
   feed, it's fetched and processed once.

## Where the items live (proposal)

The ask puts each item on the subscriber's own chain, as a document in their
bucket. The proposal is instead: **the subscription is on the chain; the items
are not.**

- **On the private chain** (the user's own facts, which travel to all their
  computers):
  - the feeds they follow, and the tags on them;
  - anything they _do_ with an item: copy it into notes, save it, rebroadcast
    it. The moment an item is acted on, it becomes the user's own document, like
    any other copy into notes.
- **In a node-level item cache** (`rss_feeds`, `rss_items`, owned by `rss.rs`,
  beside `node_shelf`):
  - every item of every feed anyone on the node follows, as converted Marquee,
    keyed by `(feed, item id)`;
  - its images as content-addressed blobs, which the blob store already shares
    between everyone.

Why:

- **"Fetched once" becomes "stored once".** On chains, fifty users following one
  feed means fifty copies of every item. Each copy would be a chain entry synced
  to every one of that user's computers, forever. A busy feed of 50 items a day
  is about 18,000 entries a year per subscriber.
- **An item isn't the user's words, and a chain entry is signed by the user's
  key.** Putting a newspaper's article on your chain has your key vouching for
  text you didn't write.
- **Point 5's conflict disappears.** Each server's cache is its own, and there's
  nothing to merge, so "pick one" is never needed. As a chain design, point 5 is
  merge-hostile in exactly the way worth flagging: two servers writing their own
  versions of the same document, and a tiebreak.
- **Point 4's updates become trivial.** A changed item is overwritten in the
  cache. On a chain, every revision is a new version that every device syncs.

What it costs:

- **Missed items.** A computer that's been off (the desktop app) fetches for
  itself when it wakes. Items the feed has dropped by then are missed there,
  even if the user's server saw them.
- **The fix, as a later slice:** a device asks the user's other nodes for their
  cached items. Item ids are stable across nodes (below), so caches agree on
  what's the same item.
- **Read state** (if we want it) is a user fact and goes on the chain as one
  watermark per feed, the way the bell's "mark all read" works. It doesn't need
  a row per item.

## Fetching

- **Reuse `net/unfurl.rs`'s guards:**
  - http/https only;
  - every DNS answer on every redirect hop must be a public address, and the
    connection is pinned to the vetted address;
  - a timeout;
  - the global outbound rate bucket.
- **Caps and identity:**
  - the size cap grows for feeds: 5 MB a feed, and the newest 200 items kept per
    feed;
  - one fetch per feed URL per node, after normalising the URL (scheme and host
    lowercased, fragment dropped), which is point 8.
- **Politeness:**
  - send `If-None-Match` / `If-Modified-Since`, and a `304` costs nothing;
  - honour the feed's own `<ttl>` or `Cache-Control` when it asks for _less_
    often than 3 hours;
  - honour `429` and `Retry-After`;
  - add jitter, so a node's feeds don't all fire at the top of the hour.
- **Unreachable sources back off** (3h, 6h, 12h, a day). After a month of
  failures the feed is marked quiet in the app, and fetching drops to weekly.
- **A per-account cap on subscriptions** (a few hundred), since one account can
  otherwise make the node a crawler.
- **Parsing:** RSS 2.0, RSS 1.0 and Atom. The `feed-rs` crate is the likely
  choice. Whatever parser is used must never expand entities or read a DTD: a
  feed is hostile input, and the entity tricks (billion laughs, external
  entities) are the classic attacks on XML.
- **HTML too much to parse** (2026-10-28, built): html5ever slows quadratically
  with nesting depth and with one tag's attribute count - 5 MiB of nested lists
  took two minutes of CPU. Before any parse, a scan that reads tags as the
  tokenizer does refuses HTML that nests past 512, carries a tag with more than
  256 attributes, or is over 512 KiB; such an item keeps its words, stripped
  without a parser. Translation runs on a blocking thread, never on the threads
  that answer requests.
- **Google News sitemaps** (Curtis, 2026-10-27, built): some sites, Serious Eats
  among them, offer a `<urlset>` with `news:` entries where a feed would be.
  Each entry that has a `news:title` becomes an item with its title, address,
  date and hero picture, and nothing to read in place. A plain sitemap is
  refused: a site's every page, untitled, is not a feed.
- **Item identity:** the feed's `guid` / `id`, else its link, else a hash of
  title and date. A content hash detects changes, so point 4's update is
  re-convert-and-replace.

## Converting: HTML to Marquee, never HTML

A feed item's body is someone else's HTML. The app's own page has no
Content-Security-Policy, so HTML that gets rendered as HTML is one sanitizer bug
away from running as the signed-in user. The rule: **translate, never
sanitize.**

- **The translator:**
  - parse the item's HTML with a real parser (html5ever) and walk the tree;
  - emit Marquee for an allowlist: paragraphs, emphasis, headings, lists,
    quotes, code, http/https links, and images;
  - everything else disappears, because Marquee has no way to express a script,
    a style, a form, an iframe or an event handler.
- **Where it lives:** `marqueemarkup/rust/html_import`, published as
  `cube-drone-marquee-html-import`, so the translator belongs to the markup, not
  to Ringtome.
- **Body choice and links:** prefer `content:encoded` or Atom `content` over the
  summary. Resolve relative URLs against the item's link.
- **Images:**
  - fetched through the node (`fetch_media_bytes`), baked into the node's own
    formats, and kept as the item's embeds;
  - so the reader's browser never loads a remote image, and no tracking pixel
    learns who read what;
  - capped at twenty images per item, and 1×1 images dropped;
  - an image that fails to fetch becomes a link.
- **Enclosures** (podcast audio, video) are links, not downloads, at least at
  first.
- **A CSP for the app page** is worth adding regardless (`script-src 'self'` at
  least), as a second layer under all of this.

## The app

- **Three columns,** on the panes machinery (resizable, tuckable):
  - **feeds**, with their tags and the tag cloud, as the Notes app does;
  - **items**;
  - **the reading pane**.
- **No feed selected: the merged view** of every item, newest first, by the
  item's own date. An item dated in the future, or far in the past, is filed at
  its fetch time instead.
- **Adding a feed:**
  - paste a feed's URL, or a page's (the node looks for its
    `<link rel="alternate">`, the tag our own person pages now carry);
  - if the feed is a Ringtome persona's own `rss.xml`, the app offers to
    **follow the persona** instead, since that's the better version of the same
    thing.
- **An item wears its feed's name and icon** where a post wears its author's,
  and the house chips (copy into notes last).
- **HorseBucks:** reading earns nothing, and an item copied into notes isn't
  "words written". A rebroadcast earns like any post.

## Feed items are posts (Curtis, 2026-10-27)

The ask, second round: **a feed item looks like a post and acts like one.**

- **The same card.** `PostEntry` (`js/postentry.js`) draws an item. Where a post
  has its author's banner, an item has **the feed's**: a circle with the feed's
  logo, then the feed's name and its site's address.
- **The same capabilities:**
  - **automatic tags:** image, audio or video, and micro, short, medium or long,
    with the post thresholds (`length_tag`, `media_tag` in
    `record/documents.rs`);
  - **tagging**, up to two tags, as on somebody else's post: private, in the
    register `rss_tags` (key: feed id and item id), until the item is
    rebroadcast;
  - **rebroadcast**, to everyone or to one group;
  - **copy into a notebook.**
- **In the main feed.** Items from followed feeds are folded into the main feed
  beside everything else, and every filter there applies to them.
- **Horse's RSS's merged view is that feed too:** the same stream and filters,
  narrowed to feed items. The feeds column picks one feed, as an author chip
  would.

### What that means for the machinery

Today everything in the feed is keyed by `(author root, doc id)`, and the card,
the routes and the filters all assume the author is a persona with a chain.
These are the joins:

- **An item's identity:** `(feed id, item id)`. Both are hashes of what the feed
  itself says (its normalised URL; the entry's guid), so **an item is the same
  item on every node** that follows the same address.
  - The feed takes the author's slot as `rss:<feed id>`, a string that can never
    be a root, so nothing that looks up a person can be fooled by it.
  - The item id fills the doc id's slot. It is 16 bytes like a doc id.
- **The main feed is `feed_journal`** (`fanout.rs`), a row per reader. When the
  refresher keeps a new item, it journals a row for each persona on this node
  that follows the feed, with format `rss`. Paging, sorting, the updates bar and
  the server-side filters (`search::Narrow`) then work unchanged.
  - Following a feed backfills its kept items into the follower's journal;
    letting go removes them.
  - **A new kind, "feed item",** joins post, reply, rebroadcast, book and room
    on the kind chips, so the main feed can leave them all out, and Horse's RSS
    narrows to only them.
  - **Feeds join the author chips,** by name.
- **Automatic tags are worked out when the item is kept,** from the converted
  body's word count and the item's enclosures and media (a podcast's audio, a
  video, or pictures). They are stored with the item, since there is no author
  chain to sign them; the filters read them where they read a post's implicit
  tags.
- **The card** draws a `FeedBanner` where it draws `PersonBanner`.
  - The banner keeps the date and the chip deck.
  - The deck drops what only an author can do (unpublish, edit, pin) and the
    links built from an author (QR, the post's own page). "Copy link" copies the
    item's original address.
  - The title links to the original, and the body door is the node's cache:
    `/api/identity/{root}/rss/{feed}/{item}/body`.
- **The feed's logo** is fetched with the feed, from its `<image>` or `<icon>`,
  else the site's favicon. It is kept small and served by the node, never
  hot-linked. With no logo, the circle shows the feed's initial.
- **Rebroadcast** is ruled full text: it publishes a post of the user's own,
  carrying the item's title, words and link, the source (the feed's address and
  name, and the item's id), and the user's private tags on the item as its own.
  It reads "via _The Source_" with a **subscribe** chip. To a group, the same
  post lands in the group. Once published it is an ordinary post, so others tag,
  rebroadcast and copy it as any other.
- **Copy into a notebook** copies the cached Marquee body, its title and the
  original link into a new private note, with the feed as its provenance.
- **Unread** stays the per-feed watermark: a "new" dot on an item newer than its
  feed's mark, and opening Horse's RSS marks what it showed.

## Rebroadcasting

Ruled 2026-10-27: **the full text**, as the ask had it. What follows is the
narrower proposal it replaced, kept for its reasoning; the source metadata, the
"via _The Source_" line and the **subscribe** chip still stand.

The proposal was: **republish the pointer, not the article.**

- **The item's words aren't the user's.** A full copy under their name, served
  by their node to strangers (and possibly the front page), is a copy of
  somebody's article with the wrong byline on it.
- **The rebroadcast is a post** carrying:
  - the item's title, its link, and its summary (the feed's own `<description>`,
    which the source publishes to be quoted);
  - the source metadata: the feed's URL and title, and the item's id;
  - the user's own words, if they add any.
- **It reads as "via _The Source_"**, with a **subscribe** chip that adds the
  feed to the reader's own list of feeds, which is point 7's discovery.
- **Ruled:** full text, every feed.

## Slices

1. **Subscriptions and the cache.** The subscription register on the private
   chain, the fetcher with its guards, the node-level cache with plain-text
   items, the 3-hour worker, and a bare list. **Built 2026-10-27**
   (`feedreader.rs`, `js/apps/rss.js`), and more than the slice asked: the tags,
   the tag column and the per-feed watermark are in, and each item's body is
   already kept as Marquee through the importer, waiting for slice 2's pictures
   and slice 3's reading pane. Horse's RSS is a Market unlock (2,500 HB, nothing
   required first: Claude's pick, Curtis's to change). Not yet: a feed followed
   on another computer starts being fetched here only once the reader is opened
   here.
2. **Items as posts on the node.** Automatic tags kept with each item; the
   feed's logo, fetched and served; the body door; an item shaped like a
   `FeedItem`. **Built 2026-10-27** (node rung 0109).
3. **The card.** `FeedBanner` and the item's chip deck in `PostEntry`; Horse's
   RSS's items drawn as cards. **Built 2026-10-27** (`js/feedbanner.js`).
4. **Into the main feed.** Items journalled into `feed_journal` for followers,
   with backfill and letting go; the "feed item" kind and feeds as author chips.
   Horse's RSS's merged view becomes the feed stream with its filters, narrowed
   to feed items. **Built 2026-10-27**: the stream moved out of the feed app
   into `js/feedstream.js` so both apps can use it.
5. **Tagging** feed items, privately. **Built 2026-10-27.**
6. **Copy into a notebook**, and **rebroadcast** (full text), to everyone or to
   a group, with the "via" line and a **follow** chip. **Built 2026-10-27**;
   **follow instead** for Ringtome feeds is not.
7. **Images through the node** in item bodies, the reading pane if the card's
   "see more" is not enough, and **sharing caches** between a persona's own
   nodes.

### How slices 2 to 6 came out

- **The joins** are where _What that means for the machinery_ said: the feed's
  author spelling `rss:<feed id>` reaches `profiles::bylines` (the feed's name),
  `annotations::for_posts` and the tag cloud's window (automatic and private
  tags), the narrowed walk's tag picks, the search's word bags, the kind row
  (`rss`), the author chips, and the stop rule (a followed feed's item passes
  every curiosity stop, as a group post does).
- **Horse's RSS's doors** are the feed's own handler over journal rows of format
  `rss`: `rss/feed` for every feed, `rss/{feed}/feed` for one, each with its
  `labels`. Choosing a feed is `?feed=` in the app's address, which the feed's
  name on any card links to.
- **The per-feed tag column** now narrows only the feeds column; the merged view
  is every feed (the stream knows no set of feeds).
- **Unread** stays the feeds column's counts; the cards wear no "new" dot.
- **Rebroadcast** asks the node for a draft in the reader's feed notebook (the
  item's title and words, its source beneath them, the reader's tags on it, and
  `source_feed`, `source_name` and `source_link` as fields), then publishes it
  as the composer does. Publishing states every draft field as a label, so the
  source travels with no protocol change, and every card reads it as a "via"
  line with a follow chip. Once per item and place (`rss_rebroadcasts`); taking
  it back is taking the post down.
- **Copying** gives the note the item's words with its source beneath them, and
  the reader's tags; it names no provenance, since a feed has no root.

## Open questions

- **How long items live.** Forever, or the newest _n_ per feed? The cache makes
  either cheap; chains would make "forever" the only answer.
- **Private feeds** (URLs with a token in them): allowed? The URL would sit on
  the private chain, but the node's cache would hold the items for anyone else
  on the node who followed the same URL. That's correct, but the node should
  never merge two users' private-token feeds into one fetch unless their URLs
  are identical.
