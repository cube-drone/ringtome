# Caching

A plan (2026-10-13). Stages 1-7 built the same day (HISTORY); what was built
before it was written is under _Already done_.

The node keeps almost nothing in memory. Every request rebuilds its answer from
SQL, and a persona's database has one connection: under load, a request costs
roughly the number of statements it sends times the wait for each one's turn.
This plan keeps what's asked for again and again in RAM, invalidated exactly -
by the write counts the node already keeps - rather than on a timer, and stops
the work that's repeated for nothing: polls that never end, dials to computers
that aren't there, loops that recompute what hasn't changed.

## The ask (Curtis, 2026-10-13)

After a day of slow pages under an upload: "CDN page caching is all well and
good, but we also have our own RAM to work with, here, and our application makes
precious little use of real actual caching to speed things up for the end user -
a lot less accessible memory, but we have full control over it and can
invalidate cache as soon as it becomes a problem." Then: an audit of the whole
codebase for "easy, high-impact low-effort cache wins", and this plan, done "in
the recommended order".

## What the day measured

From the live server's logs (`request db time`, `taxonomy tree steps`,
`slow statement`), with an agent uploading ~3,000 songs into the main persona:

- **Opening a private note:** 46-72 statements, 5 ms of work, 1-15 s waiting.
- **A notebook's tree** (8 notes): 123-129 statements, 6-15 s, 85-90% waiting.
- **Listing a notebook** of 698 documents: 108 s (one statement a document -
  batched the same day).
- **An anonymous post page:** 16 s, then 5.8 s on a refresh; its words and
  thumbnail 3.5-5 s each - every one a CDN miss (`no-cache`).
- **What held the connection:** every append's chain-head lookup, ~500 ms each
  (25 µs anywhere it could be reproduced; memoized the same day), and the
  doc-meta view's whole-table read, ~400 ms.
- **Background:** `sync-anti-entropy` and `sync-eager-push` hitting their 120 s
  timeout every pass, `fragment-revalidation` 42 s, `room-pulse` 62 s.
- **The browser:** one open document fetched ~25 times in 2½ minutes.

## Principles

1. **Invalidate exactly, never on a guess.** `db::writes_to(db, table)` counts
   every write statement through the `Db` handle, per table per database; a
   cache stamps the count _before_ it computes and trusts its answer while the
   count stands. A write racing the computation leaves the stamp behind, so the
   next read recomputes. Timers are only a backstop (sessions, below), never the
   rule.
2. **Stamp after the catch-up.** A cache over a folded view reads its stamp
   after that service's catch-up, or entries that arrived but aren't folded yet
   are served stale until something else folds them. The catch-up is near free
   when nothing is new (`fold_memo`).
3. **Cache facts, never verdicts.** Who may read a sealed post, whether a
   session is valid, whether a viewer is trusted: decided per request, from
   cached facts at most. No cache holds decrypted private bodies, sealed
   plaintext, a sealed title, or a refusal.
4. **A takedown is never served from a cache.** Every cache in front of public
   words stamps on what a retraction moves (the POSTS chain, `doc_heads`,
   `public_retractions`), and content-addressed caches (bytes by hash) sit
   _behind_ the gate that checks the post is still up.
5. **Bounded, by a budget the node knows.** Per-persona caches live in `moka`
   caches weighed by size, each a share of one memory budget sized to the
   machine the node runs on (Stage 5), so a node evicts the least-used instead
   of growing - and a phone or a Pi isn't asked for a server's share. A cache
   miss is always correct, only slower.
6. **Measured.** Each stage names the log line or count that shows it worked,
   checked on the live server after it ships (_name the falsifying question_).

## Already done (2026-10-13)

- `heads_for` asks 500 ids a statement (a notebook's summaries, one query).
- **The no-op catch-up is kept** (`imaol::rows_past_watermarks`, `fold_memo`):
  per `(service, entry_type)`, stamped on `entries` and the service's watermark
  moves; when it must ask, its seeks wait for the connection once (`Db::hold`).
- **The tree read reads doc-meta once** (`Store::doc_meta`, `DocMeta`).
- **Appends remember their chain's head** (`imaol::HeadMemo`).
- **Public pages carry a CDN window** (`crawl::public_cache`): a tenth of the
  time since the post changed, five minutes to a year, counted from the node's
  start.

The first two and the head memo all stamp on the persona's whole-table `entries`
count, which an upload moves on every song - so under exactly the load they were
built for, they miss. Stage 2 fixes that.

## The stages

In this order. Each is its own batch: built, gated (`just ci`), in HISTORY,
handed over before the next starts.

### Stage 1 - the media poll (built 2026-10-13)

An open image, song or video asks the node for itself every two seconds for as
long as it's open. A media document's detail always has `body: null`
(`documents.rs`, `resolve`: media bodies are served by the binary route), and
`useDocDetail` (`js/doc/detail.js`) retries while the body is null - the waiting
room meant for a note whose blobs are still travelling. `rememberDoc`
(`js/mirror/doccache.js`) refuses a null body too, so reopening one misses the
cache and starts the loop again. This is the ~25 fetches of one document.

- Retry only when `body == null && !media`; remember media details.
- The editor and drawing waiting room (`js/doc/session.js`, the lookout effect)
  can start a second load while one is out: skip while `opening`/`waiting`.

Done when: an open media document makes one request; a pure test pins the retry
rule.

### Stage 2 - write counts per service (the keystone; built 2026-10-13)

`entries` holds every chain of the persona; one count for the whole table means
an upload's doc headers invalidate the caches of doc-meta, general-private,
identity, posts and every other service.

- Count inserts per `(database, service)` at the two production insert sites:
  `imaol::append_on` and the sync store path (`net/sync.rs`). Bumped before the
  statement, whatever its outcome, like `note_write`.
- The stamp for a service is
  `(its inserts, every entries write not attributed to a service)`. Deletes
  (sync's evictions, `imaol`'s prune), scripts and anything unforeseen raise the
  second term and invalidate everything - safe by construction.
- A conventions test: every `INSERT INTO entries` outside tests is a counted
  site.
- Move the existing memos onto it: `fold_memo` per service; `HeadMemo`; `OPENED`
  on IDENTITY_PUBLIC (where key epochs arrive); `revalidate::kept` on
  DOCUMENTS_PRIVATE.

Done when: on a test store, an append to one service leaves the other services'
kept catch-ups standing (counted with the request tally); live, a note opened
mid-upload is a handful of statements, not ~50.

### Stage 3 - computers that don't answer (built 2026-10-13)

`net::p2p::dial` remembers computers that answered (`REACHED_AT`) and nothing
about ones that didn't. A sleeping laptop is dialled per persona, per pass, per
document, each until a 30 s timeout: anti-entropy samples up to three peers for
each root in turn (4 personas × 30 s = the live 120 s), revalidation tries the
author, origin, sharers and cohort for each of 16 documents at 8 s each.

- A map `endpoint → (dark until, strikes)`: a connect failure marks it dark, 60
  s doubling to 10 minutes; a dark endpoint is refused at once. `dial` gets a
  connect deadline of its own (~10 s) so it sees the failure - callers' outer
  timeouts drop the future before it can.
- Any success, and any inbound connection from it (`remember`), clears the mark.
  "Sync now" clears the marks of that persona's peers. An `unplugged` refusal
  never marks. The rig's nodes restart constantly: short or off under
  `local_test`.
- Per-pass memos in `bodies::sweep`: the cohort once a pass, each origin's
  endpoints once a pass. (Fragment revalidation's were left: threading a memo
  through `fragment::fetch` buys what the dark marks and Stage 4's key-tree
  cache already do - no dial to a dark computer, no key tree rebuilt.)

Safe because it only delays: a push with no peer reached leaves the root dirty
and retries; anti-entropy samples again next pass. Done when: the live
`slow background pass` lines for sync and revalidation fall from tens of seconds
to about one timeout per dark computer per window.

### Stage 4 - the rest of the small wins (built 2026-10-13)

Each small, each its own commit inside the stage.

1. **Eager push** (`net/resync.rs`, `eager_root`): fingerprints every persona's
   frontier every second - 1 + 2N node statements a second, nearly always to
   learn nothing changed. Skip the read while the root's entries count stands,
   still calling `observe` with the last fingerprint so its clocks move. The
   frontier paths that rewrite `chain_heads` without an entries write
   (`reconcile_from_entries`, the drops) clear the root's stamp.
2. **The stream's badges** (`routes.rs`, `serve_stream`): every write wakes
   every open tab's stream, and each recounts notifications and unread chat -
   15-30 statements a tab a write. One count per persona, shared by its tabs and
   stamped on the tables it reads; and coalesce wakes (~250 ms) either way. The
   count's side effect (`BELL_FIRST_SEEN` stamps) runs on real recounts.
3. **The key tree** (`imaol::load_key_tree`): rebuilt on every append, every
   exchange's membership check, every candidate lookup - the whole identity
   chain read and every signature checked. Kept per root, stamped on the
   IDENTITY_PUBLIC count (a revocation is an identity entry); dropped on
   `evict_mirror`. The same cache holds the decoded identity entries for
   `outbox::auth_path` and the unsealed epoch keys for `open_agented`, inbox,
   ingest and replies.
4. **`OPENED` keeps the signer on a miss**: only the epoch-key unseal depends on
   new entries; the signer and enc keypair are gated on `identities` alone.
5. **keyprefetch** (`keyprefetch.rs`): asks ~800 statements every 30 s, opening
   other authors' databases, before its in-memory "tried" check - check that
   first; keep the settled set stamped on `post_keys` and `post_key_grants`.
6. **Node tables in RAM**: `identities` (72 call sites, several a second) and
   `identity_peers`, stamped on their tables; slugs and web paths (`node_slugs`,
   a per-author `doc_annotations` path map); public profile fields
   (`profile_view`); `has_public_equivocation` (one statement on every public
   read).
7. **Sessions and API keys** (`auth.rs`, `auth/keys.rs`): one MCP tool call
   resolves its key 4-8 times. Keyed by token hash, stamped on `sessions`,
   `accounts`, `api_keys`; expiry checked against the clock in memory; a miss
   always asks the database; a refusal is never kept; and a 30 s ceiling in case
   anything edits node.db from outside the node. Security-sensitive: its own
   commit, its own review.
8. **MCP's persona list** (`mcp.rs`): `personas()` re-resolves every persona's
   standing per tool call; kept per account, stamped on `identities` and each
   root's identity and profile counts. Every later call still checks ownership.

Done when: the per-second node statement rate with nobody using the node drops
to about nothing; an MCP tool call's auth costs no statements after the first.

As built: slugs, web paths and public profile fields moved to Stage 7, which
reads them for the public face; MCP's persona list is kept fifteen seconds by
the caller's key rather than stamped (the tools hold no node state to stamp
with), and `edit_profile` drops it; the stream coalesces to a rebuild a second
rather than sharing one badge count per persona - the documents part was already
shared per stamp, and a beat bounds the rest.

### Stage 5 - the memory budget (built 2026-10-13)

The node runs on a personal computer (plenty of RAM, rude to use it all), a
server (plenty, rude _not_ to use it), a VPS or a Raspberry Pi (little, and an
out-of-memory kill is easy), and a phone (little, and rude to use it all) -
Curtis's phone has 12 GB, his server 16 GB (Curtis, 2026-10-13). The caches
after this stage hold real memory, so the node first learns how much it may use:
one budget for all of them, which each cache takes a share of. No cache knows
where it's running.

**What it is running on.** The node can tell, mostly:

- **The shell says.** The desktop shell embeds the node and already hands it a
  per-launch secret; the Android app launches it too. Each sets
  `RINGTOME_DEVICE` (`computer`, `phone`) before the node starts. With no shell,
  the node is a **server**.
- **The machine says how much there is.** Total memory (Linux and Android
  `/proc/meminfo`, macOS `sysctl hw.memsize`, Windows `GlobalMemoryStatusEx`),
  and on Linux the tighter of that and the cgroup's `memory.max` - a container,
  or a systemd unit with `MemoryMax=` - since that's the line the kernel kills
  at, not the machine's size.

**The default budget**, from those two:

| Running on | Share of memory                       | Floor | Ceiling | Curtis's machines |
| ---------- | ------------------------------------- | ----- | ------- | ----------------- |
| server     | 25%, leaving 1 GB for everything else | 32 MB | none    | 16 GB → 4 GB      |
| computer   | 5%                                    | 32 MB | 1 GB    | 16 GB → 800 MB    |
| phone      | 2%                                    | 32 MB | 256 MB  | 12 GB → 245 MB    |

A 1 GB VPS or Pi lands near the floor whichever it is; a big server gets a big
cache. The 25% is deliberately a quarter, not most: the node's own databases
keep page caches, media transcodes run beside it, and the blob store reads
through the OS's file cache - all memory the budget doesn't count.

**The operator says.** `RINGTOME_CACHE_MEMORY` overrides the default - a size
(`2GB`, `512MB`) or a share (`40%`); `0` turns the RAM caches off (every cache
then misses, which is always correct). SERVER.md documents it beside
`RINGTOME_MAX_OPEN_DATABASES`.

**The split.** Each cache built in the later stages takes a share, enforced by
its `moka` weigher - roughly: the doc-meta views 40%, public bytes 25%, public
text and pages 15%, the whole-table reads 20%. The small tables of Stage 4
(identities, slugs, sessions, the key trees) are kilobytes and sit outside it.

**Pressure.** A budget set at boot doesn't know what else the machine starts
doing:

- **Phones** tell apps when memory runs short (Android's `onTrimMemory`); the
  app passes it to the node, which drops its caches. The phone kills the biggest
  apps first, and a node that sheds on request is a small one.
- **Linux** every 30 s reads available memory (`MemAvailable`, or the cgroup's
  headroom); under 10% of the total, the node drops its caches and logs that it
  did.

**Said out loud.** One line at boot -
`cache budget 4.0 GB (server, 25% of 16 GB)` - and the budget with what's in use
on the node's status page, so an operator can see whether the setting is doing
anything.

Done when: the boot line is right on a laptop, the server, the phone and a
memory-limited Linux service (`MemoryMax=`, checked by hand on the server - the
rig runs on macOS); the budget arithmetic has unit tests per row of the table;
`0` turns the caches off with the suite still green.

As built (`budget.rs`): the pressure beat reads `/proc/meminfo` and the cgroup's
headroom on Linux - which covers Android too, its kernel being Linux - so no
`onTrimMemory` bridge was needed; elsewhere (macOS, Windows) there is no reading
and no shedding. The budget is said in the boot line, not yet on the status
page. Windows' memory isn't read: there, the floor.

### Stage 6 - the doc-meta view in RAM (built 2026-10-13)

Every title, tag, bucket membership and list in a persona: the ~400 ms
`SELECT … FROM private_registers` behind every tree read, every move, every
filing, every annotations or buckets listing, every notebook listing. Kept per
persona, and **kept current rather than dropped**: the fold that writes the rows
to SQL applies the same change to the view in RAM, so it stays valid through an
upload. A write to `private_registers`/`private_set_elements` by any other path
(a rebuild, a migration) moves a count the fold's own writes don't account for,
and the view reloads.

- `Documents::deleted`/`pinned` and the per-collection seeks read from it.
- Bounded by its share of the memory budget (Stage 5): tens of KB to a few MB a
  persona.

Done when: a tree read, a move and a notebook listing issue no doc-meta
statements when nothing is new; live, `taxonomy tree steps` shows `tree_ms` in
single milliseconds.

### Stage 7 - the public face in RAM (built 2026-10-13)

1. **Serving facts** for `public_doc_bytes` (`idface.rs`): per `(root, doc)`,
   the file and thumb hash, format, sealed-or-not, seal holder, last change -
   stamped on the POSTS count, `doc_heads`, `public_retractions`,
   `equivocations`, and node `identities`. A `304` costs no statements. The
   trusted-viewer check stays per request. Free first: the same row is read
   twice, and the "not here yet" lookup runs even with the facts in hand.
2. **Bytes by hash**: thumbnails and media from the blob store, in a
   size-weighed `moka` (~128 MB). Content-addressed, never stale; behind the
   facts gate.
3. **A post's text by its content hash**: plain words, first picture, rendered
   HTML - a person's page renders 30 posts a request, RSS 20, the post page its
   own twice.
4. **Rendered pages**: the post page, the person page's reading copy, RSS, the
   sitemaps, `/feed` and `/people` - stamped as above, plus `profile_view` and
   the node tables they read. RSS, the sitemaps and the node feeds get
   `crawl::public_cache` (they send no `Cache-Control` today). `/feed` and
   `/people` read bylines from `persona_profiles`, as `node_feed_handler` does,
   instead of opening each author's database.

Done when: an anonymous post page, its words and thumbnail answer in
milliseconds on a busy persona; a takedown is a 404 on the next request (an
integration claim).

As built: serving facts kept for hosted personas only (the hot case; peeks,
hunches and fragments keep their careful path), against the posts chain's mark,
`doc_heads`, `public_retractions` and `equivocations`; public blobs by hash in a
`moka` cache weighed to the public-bytes share, 4 MB a blob at most; rendered
words by a hash of what was rendered; a post's derived words and first picture
by its body's hash; public profiles against `profile_view`; `Cache-Control` on
RSS, the sitemaps, `robots.txt`, `/feed.xml`, `/feed` and `/people`. Whole
rendered pages were left: the CDN holds them now, and with these parts kept,
building one costs a fraction of what it did. Slugs and web paths stay read per
request - `doc_annotations`, which they live in, moves with every label on the
node, so a cache over it would rarely stand.

### Stage 8 - whole-table reads per list

The docs-list, by-tag and by-bucket handlers and the stream each re-read whole
tables for decoration: `list_heads`, `private_implicit_tags` (three whole
reads), `search_rows` (a whole doc-meta view, `doc_heads` and `doc_search` with
every document's words), `published_edges`, `rebroadcasts`,
`public_annotations`, `annotations::for_posts` (one node statement a post). Each
kept per persona as an `Arc`, stamped on its own tables after the catch-up.

- `search_rows`' fingerprint reads whether bodies are present, which no table
  write marks: keep it only when every row matched without asking the blob
  store.
- Free first: the list handlers call `implicit_tags()` - a whole search-index
  refresh - where `implicit_tags_as_indexed()` does (the stream keeps the index
  fresh); `held_of` and `public_implicit_tags` are N+1 loops to batch.

### Stage 9 - the browser

- **In-flight de-duplication** in `net.js`: one request per URL at a time for
  GETs (answers shared read-only).
- **The notebook tree fetched twice**: `useBookTree` (`doc/bookcol.js`) asks the
  same URL as the tree pane, uncached, on every list↔note move; cache it the way
  the pane does, and only for a book.
- **A stale-while-revalidate cache** for notebook facts, the amp's settings,
  feed cards' bodies and post heads: the last answer at once, refreshed behind.
- **Chat uploads** watch the mirror row for `media` instead of polling the node
  every second.
- **A note just saved** is remembered as saved, stamped with the head it will
  have, so reopening it doesn't fetch.
- **Mixtapes** fetched one by one as they change, not all when one does.
- **Hidden tabs** stop polling (notifications, chat rooms, the feed's look); the
  balance corner asks every 30-60 s, not 10.

## What we won't cache

- **Decrypted private bodies and thumbnails** - plaintext in RAM, and the
  browser's ETag and `immutable` copies already answer repeats.
- **Permission verdicts, sealed words, sealed titles, post keys** - per viewer.
- **Negative answers on the public body route** - headers travel ahead of
  bodies, and a share's fragment can land any second.
- **The reaper's live set** - a stale "nobody uses this blob" deletes one
  somebody does. If ever, its own plan.
- **`fanout::retract_vanished`'s view of what's public** - it deletes on what it
  reads, under `lock_ingest`, on purpose.
- **Anti-entropy's work** - pulling what changed elsewhere is the point; only
  the dark-endpoint skip applies.
- **Secret keys** beyond what `OPENED` holds today.

## Open questions

- **Bank catch-up's whole-list reads** (chat lines, reactions, emoji, edges, the
  banked set) once a minute per open corner: section skips on unchanged source
  counts look safe (lines are idempotent), but the bank has burned us before -
  after Stage 8, if it still shows in the logs.
- **`writes_to` counts writes that change nothing** (`frontier::refresh_moved`'s
  unconditional `DELETE`, `census`'s `UPDATE` every pass): conservative, so
  safe, but caches on those tables miss more; guard those statements when a
  cache wants them.
- **Open database handles cost memory too.** Each persona's open database keeps
  a page cache of its own, and `RINGTOME_MAX_OPEN_DATABASES` (128 by default) is
  sized for file descriptors, not RAM. On a phone or a Pi the budget should
  probably set it, and each handle's page cache, as well - measured before it's
  decided.
- **The 500 ms chain-head lookup** was never explained - only routed around. If
  another statement inherits it once `HeadMemo` holds, the server's I/O is the
  cause, and that's a different plan.
