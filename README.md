# ringtome

**Two names, one repository** (2026-09-25):

- **Ringtome** is the _protocol_: signed append-only chains, roaming key-tree
  identities, sync over [iroh](https://iroh.computer/), the trust web. The
  `ringtome` node, the `ringtome-proto` crate, the wire (`ringtome/sync/0`), the
  signature domains and the test vectors all keep the name.
- **Horse Drawing Tycoon 2** is the _consumer application_ built on it - the
  desktop app, the UI people actually use, at
  [horsedrawingtycoon.com](https://horsedrawingtycoon.com). The sequel to a
  tycoon game about drawing horses, built on a bar bet eleven years ago; the
  social network lives inside the dumb game, which is exactly where it should
  live.

When a sentence is about bytes, chains or peers, it says Ringtome; when it is
about what a person installs, opens or sees, it says Horse Drawing Tycoon 2.

A cozy p2p retro-web social network: IRC-flavored chat, bulletin boards,
geocities-style pages, webrings, hit counters, MIDI files. Identities are
cryptographic key trees that roam between nodes; content lives in signed
append-only logs replicated over [iroh](https://iroh.computer/); trust is
modeled explicitly instead of moderated retroactively. Private by default,
lightly federated, unapologetically Old Internet.

> This README is the **map**. The full design — with every decision's reasoning
> — is [`PROJECT_PLAN.md`](PROJECT_PLAN.md), which is canon; if the two
> disagree, this file is the one that's wrong. Don't read the plan
> cover-to-cover: grep its headers and read the sections you need (see _The
> documents_, below).

## The documents

- [`PROJECT_PLAN.md`](PROJECT_PLAN.md) — the doctrine: architecture, identity
  model, trust model, threat model, every load-bearing design decision with its
  reasoning. Edited in place; always current. **Too big to read whole — that's
  accepted**: grep the `##`/`###` headers, read the sections your task touches,
  and follow its cross-references by header name.
- [`NEXT_STEPS.md`](NEXT_STEPS.md) — the trajectory: where the ladder stands,
  the standing residuals, and the unordered tiers ahead. Forward-looking only.
- [`HISTORY.md`](HISTORY.md) — the delivery log: what shipped when, with status
  notes and residuals as recorded at the time. New work appends at the bottom in
  full detail; when the tail grows unwieldy it is folded into the era narrative
  above it. Read the tail for recent status.
- [`history/`](history/) — extracted investigation logs. When one thread runs
  long enough that folding it would cost the story (the entries only make sense
  in sequence), it moves here whole and HISTORY keeps a pointer entry in its
  place. Two so far:
  [`2026-08-popularity-problems.md`](history/2026-08-popularity-problems.md),
  the 50k-follow audit and its two days of consequences; and
  [`2026-08-chain-genesis-roundup.md`](history/2026-08-chain-genesis-roundup.md),
  the full-chain audit — every read whose cost grew with an identity's history,
  and the rule that came out of fixing them.
- Public annotations, books, and peeks/ceilings/pins are sections of
  `PROJECT_PLAN.md` now (their working documents were folded in on 2026-09-06;
  the moment-by-moment record is `HISTORY.md`'s).
- [`GLOSSARY.md`](GLOSSARY.md) — the vocabulary: protocol terms, plus the
  engine-room ↔ cozy-UI language mapping.
- [`STYLE.md`](STYLE.md) — the house style: naming, comments, module shape,
  testing doctrine, and the pragmatism rules; the patterns every new file is
  expected to hold.
- [`REFACTOR.md`](REFACTOR.md) — the ledger: known compromises and queued
  cleanups (tech debt is a mortgage; this is the current balance). Completed
  entries are deleted — git is the archive.
- [`plans/`](plans/) — the plans: one design document per app, feature or
  delivery shape, drafts and built alike, plus the signing guide. **A new plan
  is written here.** So far:
- [`ACTIVITYPUB.md`](plans/ACTIVITYPUB.md) — a persona served from a domain as a
  fediverse actor: found by WebFinger, followed and boosted from Mastodon, its
  public posts delivered as Notes. A one-way window onto the fediverse, not
  federation; the persona follows nobody yet. A design draft (2026-10-14);
  nothing built.
- [`AUDIO.md`](plans/AUDIO.md) — hrseAmp, for music: a sortable, filterable
  table of every sound you can see (your own and the feed's), a player with a
  shuffle that spreads artists and albums, saved filters, mixtapes (a taxonomy
  per mixtape) and radio stations (weighted pies of filters, mixtapes and other
  stations). A design draft (2026-10-12); nothing built.
- [`BULK.md`](plans/BULK.md) — doing one thing to many documents in Writer,
  Drawing and hrseFiles: Shift-click or "select all" beside the count, then
  delete, move (to a notebook, or a new one), tag, untag from the combined tags,
  date, and for sounds their artist, album and cover. One request per document
  on the existing routes, four at a time. Built 2026-10-11.
- [`CACHE.md`](plans/CACHE.md) — what the node keeps in RAM, invalidated exactly
  by its write counts, and the repeated work it stops: the media poll, write
  counts per service, a memory of computers that don't answer, a memory budget
  sized to the machine (phone, computer, server, Pi), the doc-meta view kept
  current, the public face, whole-table reads, and the browser. Nine stages from
  the 2026-10-13 audit; all nine built.
- [`CHAT.md`](plans/CHAT.md) — real-time rooms: a room is a post, a message is
  an entry on its author's own chain on the room's lane, live is gossip carrying
  the same entries, history is recent everywhere and whole at the creator's.
  Rulings settled 2026-09-18; the chain key's third element comes first as its
  own arc, then five slices.
- [`COMMODITIES.md`](plans/COMMODITIES.md) — seven horse commodities in
  hrseBank's Market: a price walk derived from the date, the same on every
  computer, drifting a little faster than bonds pay, and nudged at most 5% by
  what the node sees the network doing - drawings, words, reactions positive and
  negative, follows, chat, posts. Horse Financial's second instrument. Built
  2026-10-06.
- [`CRAWLING.md`](plans/CRAWLING.md) — the public site readable by search
  engines: a server-written reading copy in every public page's body, a
  `robots.txt` and sitemap, the right status codes, and a choice of who is
  indexed. A design draft (2026-10-11); nothing built.
- [`CROWD.md`](plans/CROWD.md) — a popular persona served by its followers'
  nodes: a published follow makes a node a holder, the author's node (and its
  "busy" refusal) refers askers to holders, holders pass moves on, and the wake
  pass asks a holder first and the author now and then. Rulings settled
  2026-10-11; all seven slices built 2026-10-11 to 2026-10-13: a node answers
  strangers about a persona it only follows quietly only when it serves more
  than ten personas, the author's node refers askers to holders (in its "busy"
  refusals too), a fetch asks them when the author is dark, a holder pushes new
  posts on to the nodes that asked it, a follower's refresh asks a holder first
  and the author every six hours or so, and missing files heal from holders.
- [`DEDUP.md`](plans/DEDUP.md) — one copy of each private file a persona holds:
  a keyed fingerprint of every private blob, carried in its encrypted header and
  folded into a per-persona view, so an upload the persona already holds names
  the existing blob, or returns the existing document. Public and private never
  share; key rotation doesn't split it. Album cover art as sound thumbnails is
  the forcing function. Storage and upload dedup and cover art built 2026-10-11;
  import's folding is still to come.
- [`DRAWING.md`](plans/DRAWING.md) — the horse-drawing app: a drawing is a
  versioned document whose body is its strokes, undo is a recorded removal, and
  two histories merge by putting both sets of strokes together (on the node,
  held to the browser by shared test vectors); copies and publications are
  pictures of it.
- [`EPUB.md`](plans/EPUB.md) — a notebook, or a public book, as an `.epub`:
  Marquee rendered as XHTML, pictures converted into the book, drawings painted
  on the node, links between pages made links between chapters - cached by a
  hash of every page's version.
- [`EXPORT.md`](plans/EXPORT.md) — a persona, whole, as one `.zip`: notes in
  every rendering (`.mq`, `.md`, `.yml.md`, `.txt`, `.horsedrawing`), media,
  posts, profile, contacts, chats and bank, in folders by notebook and section -
  a queued background job, one per persona, no keys.
- [`GROUPS.md`](plans/GROUPS.md) — groups: one roster every member sees alike,
  kept on every member's computer and folded from their own entries; owners
  ranked by appointment, CROWN-style, so no founder is needed; content served
  only to members. Replaces PROJECT_PLAN's _Groups: Identity-Shaped_ sketch. The
  roster, invites, group posts and the groups app are built (2026-10-15/16);
  Proposed: public groups (a public roster, members posting as themselves for
  the group, carried to their followers) beside private ones, chosen at
  founding; and what a group owns (shared notebooks, drawings, playlists).
- [`GROUP_ROOMS.md`](plans/GROUP_ROOMS.md) — chats that belong to a group
  (GROUPS slice 5): a room posted to the group, its door the roster, its
  messages the room machinery's own; the standing room; a pile per group in the
  chats column. Proposed 2026-10-16.
- [`HORSE_BASED_CURRENCIES.md`](plans/HORSE_BASED_CURRENCIES.md) — HorseBucks
  and the other currencies: never transferable, a balance is a fold over the
  persona's own ledger that may go negative and is never rolled back, interest
  measured in HorseTicks rather than time, exact bigint balances shown in
  broken-number notation, wealth-gated posts honoured by the reader's own node,
  and a daily public heartbeat. A design draft (2026-09-29); nothing built.
- [`MARQUEE.md`](plans/MARQUEE.md) — Marquee, upstream: what we've found in the
  markup language's libraries and handed over, each open item written up to be
  handed over as it stands (where, what, why it matters here, a suggested fix),
  and what later releases fixed. The running list, not a design.
- [`MCP.md`](plans/MCP.md) — Horse Drawing Tycoon 2 for AI agents: the node
  serves the Model Context Protocol at `/mcp`, behind the existing API key
  (never a cookie); a small set of task-shaped tools dispatched through the
  node's own router, so every rule a door enforces holds; no drawing tools;
  unlocks bind the agent; posts made with a key tagged "AI agent" or "API key"
  so readers can filter them; other people's words fenced and attributed; OAuth
  last, its token an ordinary `rtk_` key. A design draft with rulings
  (2026-10-06); Built (2026-10-06), but for drawing, struck: `/mcp` answers,
  with the reading and writing tools, chat and the bank, the guide, the
  provenance tags, OAuth for claude.ai and its kind, a page in settings saying
  how to connect one, and (2026-10-11) notebooks, their trees, and an hour's API
  key for what the tools don't reach.
- [`NETWORK.md`](plans/NETWORK.md) — the machine table: every machine this node
  talks to, by the name it announces, with how reliably it answers, kept across
  restarts and shared by every kind of sync; hrseServer™'s Network page, open to
  every user, showing it with their own links; and group sync by gossip, three
  partners a pass, two by reliability and one check-in slot. Rulings settled
  2026-10-17.
- [`ONE_FEED.md`](plans/ONE_FEED.md) — group posts in the one feed journal,
  filtered like any post, and a group's fold cached by a stamp rather than
  rebuilt on every read (built 2026-10-16; replaced GROUPS.md slice 4b's
  separate journal).
- [`ONE_PUBLISH.md`](plans/ONE_PUBLISH.md) — every kind of post to every
  destination (public, a group's members, in public as a group) through one
  pipeline: one destination value with one refusal table and one membership
  check, one date rule and plan, one media pre-pass, each destination's sink,
  and one `publishTo` in the client; with a poll worked as the next kind.
  Rulings and all five slices 2026-10-18.
- [`PUBLIC_GROUPS.md`](plans/PUBLIC_GROUPS.md) — a group whose membership is
  public and whose members post in public as it: two lanes per member device (a
  public roster lane, a members-only content lane), a post as the group that is
  the member's own public post claimed on their lane, followers of a member
  getting the group's posts under the rebroadcast dial, following a group
  itself, and an open page for anyone. Rulings and all five slices 2026-10-17.
- [`QR.md`](plans/QR.md) — QR codes of a person and of a public post: the web
  address where the node has a public URL, else a `ringtome://` address only the
  Android app opens, and an "open in the app" button on a phone's web page.
  Built 2026-10-12; the app's half awaits a phone.
- [`RSS.md`](plans/RSS.md) — hrseRSS, a feed reader: subscriptions on the
  private chain, items fetched once per node into a shared cache and translated
  to Marquee (never rendered as HTML), images through the node, a merged
  newest-first view, and a rebroadcast that carries its source. A design draft
  (2026-09-30); nothing built.
- [`STOCK.md`](plans/STOCK.md) — hrseStock, a stock market in tags: a tag's
  price is its posts over 30 days, published daily by an exchange so every
  computer trades on the same numbers; lots on the private chain like hrseBonds,
  a two-day hold, and exchanges of your own for H$ 100,000,000. Parked
  (2026-10-06): sparse networks, centralisation, a protocol change.
- [`SYNC_STATUS.md`](plans/SYNC_STATUS.md) — making a sync visible: adoption
  that answers at once and syncs in the background, instalments instead of
  timeouts, a cloud always in the task bar's corner (an arrow down or up for the
  persona's own sync, a sun when the node is busy for others, debounced to the
  chunky), each computer's sync state and a Sync now button on _Your computers_,
  and a _This computer_ tab of counts and a sync code to compare between
  devices. A design draft (2026-10-07); nothing built.
- [`TEXT_HELPERS.md`](plans/TEXT_HELPERS.md) — buttons that write Marquee for
  people who don't know markup: effects, text style (font, size, colour), link
  and blocks (a quote on every line, a starter table), each acting on the
  selection - or on "text", inserted and selected - and changing a span already
  there rather than nesting another. Built 2026-10-10.
- [`TOASTS.md`](plans/TOASTS.md) — short messages that fade by themselves, above
  the quickbar at the right on a desktop and across the lower third on a phone:
  errors that were `alert()`s, "moved to X · open it", and chat and bell alerts
  while you're in the app, carried down the live stream from the node's
  attention watcher, one per room until you look. Built 2026-10-11.
- [`UNLOCKS.md`](plans/UNLOCKS.md) — the paywall as tutorial: a new player
  starts with Drawing, the Bank and Nags and buys the rest from the Market with
  HorseBucks; unlocks on the private chain as ledger spends, gates in the client
  only, contracts hidden until their unlock is owned. Built 2026-10-05.
- [`WEB_ADDRESSES.md`](plans/WEB_ADDRESSES.md) — a post's place on the public
  web: `node.tld/@name/<path>`, the node's @name in front of the author's own
  path for the post, made from its title at first publish and kept stable. The
  path travels with the persona and works on every node; the @name only shortens
  the identity half where one is claimed. With the way back from it to the
  identity path. A design draft (2026-10-11); slices 1-3 (paths, the canonical
  address, the way back) and the backfill built the same day.
- [`CUSTOM_DOMAINS.md`](plans/CUSTOM_DOMAINS.md) — a person at their own web
  address: the persona's profile claims `cube-drone.com`, a TXT record names the
  root back, and only when both agree does a node serve the domain (routing by
  `Host`, certificates through Caddy's on-demand `ask`) and every node make it
  the canonical address. The claim travels with the persona; DNS decides which
  node answers. A design draft (2026-10-15), with rulings (2026-10-16); nothing
  built.
- **The delivery-shape trio** — what kind of application this is, one document
  per candidate surface. Their relationship to canon differs and each says which
  at the top: **DESKTOP is canon-aligned** (PROJECT_PLAN's _Desktop mode: Tauri,
  with the node embedded_ was rewritten to match it on 2026-08-11), while MOBILE
  and GODOT still **disagree with canon on purpose** — the first correcting a
  premise in _Phones: deferred, by design_, the second recording why an idea
  _The Client Story_ struck keeps returning. Read them together; they constrain
  each other.
  - [`DESKTOP.md`](plans/DESKTOP.md) — a Tauri shell with the node **linked
    in-process**, one binary, plus the rollout and the recurring signing costs.
    The decision itself is canon as of 2026-08-11 (_Desktop mode: Tauri, with
    the node embedded_); this document is the execution plan, and it keeps the
    Electron comparison as the record of how the decision was made.
  - [`SIGNING.md`](plans/SIGNING.md) — the paperwork DESKTOP.md's Stage 4 waits
    on, and the only document here addressed to the operator rather than the
    code: what to enrol in (Apple, Azure Artifact Signing), the eligibility
    traps, where each secret lands, and what proceeds unsigned meanwhile.
  - [`SERVER.md`](SERVER.md) — running a Ringtome node on a server: which
    release download is which, the container image, the settings, HTTPS (the
    operator's own proxy or CDN, with recipes for Caddy, nginx and a CDN), the
    peer-to-peer port, the data directory that IS the node, and why every
    upgrade takes a backup first.
  - [`MOBILE.md`](plans/MOBILE.md) — the soft shape for phones: Tauri v2, the
    node linked in-process, a deliberately narrow UI. Corrects a factual premise
    in _Phones: deferred, by design_ and carries the availability arithmetic for
    a network with no always-on infrastructure.
  - [`GODOT.md`](plans/GODOT.md) — the game-engine client, still struck from the
    roadmap by _The Client Story_, with the properly-costed argument for the day
    a gamey product layer asks for it.
- [`API_OLD.md`](plans/API_OLD.md) — salvage report on the prior codebase:
  patterns kept, patterns cut, cautionary tales.

**Suggested first hour:** this file top to bottom; PROJECT_PLAN's _Vision_ and
_Doctrine_ sections; GLOSSARY skimmed for unfamiliar terms; then NEXT_STEPS to
see what's in motion.

## The shape of the system

Seven load-bearing ideas; everything else hangs off one of them. Each pointer
names a PROJECT_PLAN section.

1. **Identity is a tree of keys** (the CROWN): a root keypair authorizes
   children, children authorize grandchildren; authority is ordered by
   rank-path, never by time. Revocation (retirement / repudiation-with-anchors)
   and a recovery key minted at creation make key loss and key theft survivable.
   → _The CROWN Identity_.
2. **All content is signed append-only chains**, one per `(key, service)` —
   dense sequence numbers, hash links, canonical CBOR,
   store-the-author's-original-bytes. Merge semantics live above the log and are
   stated once: LWW for scalars, set-merge for collections, rank-path for
   authority. → _The Identity-Managed Append-Only Log (IM-AOL)_, _Canonical
   Encoding_.
3. **Private by default**: private chains are epoch-key ciphertext, membership
   is key possession, and a revoked device reads its era and nothing after.
   Anything public is a deliberate signing act that _copies_ content across the
   membrane — there is no "make public" flip anywhere in the system. → _Private
   Chains_, _Doctrine_ (Copy, Don't Flip).
4. **Databases are disposable views of the log.** Per-identity Turso databases
   (encrypted at rest), incrementally-folded materialized views, and a raw-entry
   journal file per identity; the signed entries are the only source of truth
   and everything else rebuilds by replay. → _Data Layer_, _The Substrate_, _The
   Store Layer_.
5. **Files are content-addressed blobs; mutable content is versioned
   documents.** One iroh-blobs store for every file-shaped byte (private =
   encrypt-then-hash, random nonce, no dedup by design); a document is a stable
   `doc_id` whose versions form a DAG of whole-file snapshots — divergence is
   detected and kept-both, never silently merged. Organization (tags, trees,
   annotations) lives _outside_ documents. → _The File Layer_, _Versioned
   Documents_, _Taxonomies_, _Annotations_.
6. **Sync is a custom protocol over iroh QUIC** with a validation gate: every
   entry is checked against the key tree before it is stored, which is what
   makes revocation real (and why iroh-docs wasn't usable). Chains can be held
   as suffixes (git-shallow-clone style); discovery is pkarr signed records on
   the Mainline DHT. → _Iroh Protocol Mapping_, _Shallow Sync_, _Discovery_.
7. **Trust is explicit and flow-computed**: signed vouches from real-world
   invites seed a graph; an Advogato-style joint-flow computation prices Sybils
   out; moderation stays node-operator policy, never protocol. → _Trust,
   Credibility, Interest, and Taste_, _Moderation and Operator Liability_.

## Workspace

| path                | what                                                                                                                                                                                                                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proto/`            | **ringtome-proto** — the protocol layer: canonical bytes, signing, chains, the key tree, sync messages, serving records. Pure (no IO); the conformance boundary. See [`proto/README.md`](proto/README.md).                                                                                                                                          |
| `node/`             | **ringtome-node** — the connector node: HTTP server, accounts, storage, iroh sync, discovery, ingest, and the embedded Preact UI (`node/js`, `node/html`, baked into the binary). The one binary. See [`node/README.md`](node/README.md).                                                                                                           |
| `supervisor/`       | **ringtome-supervisor** — the stable parent of a server node: runs it, installs signed releases, backs it up, rolls a failed update back (binary and data). Shares a wire contract with the node, not code. See [`supervisor/README.md`](supervisor/README.md).                                                                                     |
| `node/integration/` | The JS integration suite: boots real nodes, drives real HTTP, proves multi-node scenarios (`just integration`).                                                                                                                                                                                                                                     |
| `plans/`            | Design documents: one per app, feature or delivery shape (see _The documents_). New plans go here.                                                                                                                                                                                                                                                  |
| `spec/`             | Test vectors ("this logical value MUST produce exactly these bytes"). Prose specs land here too, eventually.                                                                                                                                                                                                                                        |
| `video-ingest/`     | Spike (kept deliberately): browser-side video normalization to safe intermediary formats — the reference implementation and input contract for the upload UI. See its README.                                                                                                                                                                       |
| `spike-tauri/`      | Spike: does a Tauri webview support the two features the client cannot lose — the Dexie mirror and `video-ingest`'s browser-side encode? A probe harness that produces a fillable results matrix; its own cargo workspace, so `just ci` never builds it. See [`spike-tauri/README.md`](spike-tauri/README.md) and [`DESKTOP.md`](plans/DESKTOP.md). |
| `sample_media/`     | Fixture media for exercising the ingest pipeline.                                                                                                                                                                                                                                                                                                   |
| `default_media/`    | The app's own pictures, compiled into the node (`node/build.rs`, `node/src/builtin.rs`). Every PNG here is in every persona's files, tagged by its folders (`sticker/bodies/body_1.png` is `body_1`, tagged `sticker` and `bodies`), and nobody can delete it. Add a file and rebuild to ship it; remove it and rebuild to take it away.            |

(`data/` and `scratch/` are runtime output from local test runs, not source.)

## Quickstart

```sh
cd node && just install && just start       # server + UI watchers in one terminal (Ctrl-C stops everything)
```

Other useful commands (from `node/`, unless cargo):

```sh
cargo build                 # everything
cargo test                  # all Rust tests (proto is the fast loop: cargo test -p ringtome-proto)
just integration            # boot two throwaway nodes, run the full JS integration suite
just ui-check               # the fast JS gate: rebuild the bundles, eslint, the pure-module tests
just ci                     # ui-check + check + lint + unit + integration — what the action runs
just mainline-smoke         # OPT-IN live test against the real Mainline DHT (publishes throwaway records)
cargo run --bin ringtome    # run a node (see node/README.md for configuration)
./target/debug/ringtome inspect <hex>   # pretty-print any signed entry
```
