# One feed

Group posts in the same feed as everything else, filtered like everything else;
and a group's state folded the way the rest of the node folds, cached by a
stamp, never rebuilt on a read.

Status: proposed (2026-10-16). Replaces the separate group journal of
[GROUPS.md](GROUPS.md) slice 4b. Nothing here changes the wire, the chains or
the fold's verdicts: it is how one node stores and reads what it already holds.

## Why

**The feed was split on a reason that didn't hold.** Slice 4b gave group posts a
table of their own (`group_journal`, node rung 86), merged with `feed_journal`
at read, because "other surfaces read that one, and a public surface can't list
a group post that was never in its tables". That rule is about a persona's
shelf, which feeds the public pages. `feed_journal` doesn't: every surface that
renders its rows is scoped to the reader (`reader_root = ?`), and the public
pages, the node's front page, RSS, the crawl and the persona pages read shelves
and `nodeshelf`. The agent reads it through the signed-in feed route.

**The split costs every feature twice, and most were missed.** Group posts are
left out of hot and best without a chip, the tag cloud's counts, the search
index's bodies and the curiosity dial's stop, and `dress_feed` patches their
labels in by hand. Curtis's "show me Group A and Group B, tagged Flarb" should
be one query over one table, and every view the feed has should see group posts
without being taught to.

**The group's state is folded against the grain of the node.** Every other memo
is kept by upserts the newer statement wins, a stamp sweep, or writes made only
on change, with no transactions and no window where a table is empty
([CACHE.md](CACHE.md); `fold.rs`; `edgegraph.rs`, `replies.rs`, `profiles.rs`).
Whole-history folds with retroactive verdicts are cached by a write stamp, as
the key tree is (`imaol::load_key_tree`, by `entries_mark(IDENTITY_PUBLIC)`).
Groups do none of this:

- every GROUP move re-inserts the persona's whole group history
  (`roster::refresh_inner`, no watermark);
- every read folds the group's whole history (`current` → `folded`), and the
  body route does it once per card;
- every refold clears `group_people` and `group_journal` and writes them again,
  so a reader can find them half-written (the 2026-10-16 bug, where a page's
  burst of body requests failed one another, was this, and its fix only
  serialized the refolds).

## What would break, and what has to change

`feed_journal`'s maintenance assumes every row is a post on its author's public
lane. With group rows in it, unchanged, it would:

- **delete them**: `retract_vanished` drops any row whose doc isn't on the
  author's public shelf, and runs unconditionally once after boot;
  `excise_unfollowed` drops a member's group posts when you unfollow them;
- **touch them by mistake**: `excise_shared`, `retitle_shared`,
  `bump_room_time`, and the cross-reader scans `sealed_rows` (key prefetch) and
  `rooms_in_feeds` (the chat pulse), each by author and doc with no notion of a
  group;
- **collide**: the key is `(reader, author, doc)`, so a public post rebroadcast
  into a group (allowed, GROUPS.md §7) would be one row for both.

And group labels never reach `doc_annotations`, the label memo scores, chips and
the tag cloud are built from (GROUPS.md 4a: they ride the group lane), so group
posts score nothing and add no chips.

## The design

### 1. One journal

`feed_journal` gains `group_id BLOB NOT NULL DEFAULT x''`: empty for a public
post, the group's id for a group post. The primary key becomes
`(reader_root, author_root, doc_id, group_id)`, so the same post public and in a
group are two rows. The time index gains nothing: a group pick is a filter on
rows already met by time.

- **Public maintenance is scoped to public rows.** Every statement in
  `fanout.rs` that writes, updates or deletes by author or doc adds
  `AND group_id = x''`: `retract_vanished`, `excise_unfollowed`,
  `excise_shared`, `retitle_shared`, `excise_suggested`, `bump_room_time`, and
  the upserts' conflict target. `sealed_rows` and `rooms_in_feeds` read public
  rows only. A test in `node/tests/conventions.rs` holds the line: every
  `feed_journal` statement outside the group writer names `group_id`.
- **Group rows are written by the group, for its readers.** After a refold
  (section 3), roster writes one row per hosted member who may see the post, by
  the same upsert fanout uses, then sweeps that group's rows it didn't stamp:
  `DELETE FROM feed_journal WHERE group_id = ?1 AND noted_ms < ?2`. A member who
  left, a post taken down, a post hidden from a reader: each is a row that stops
  being written and is swept. Never a clear. The ownership test
  (`tests/conventions.rs`) adds roster.rs as a writer of `feed_journal`, for
  rows with a group only.
- **What a group row carries** that a public row already has a column for:
  title, format, published (its claimed date, or its first version's genesis),
  updated, settled, dated, minted. What only a group row needs: `hidden` (an
  owner hid it; only owners and its author have the row) and `owns` (the reader
  owns the group: the card offers the hide), and `noted_ms`, the stamp the group
  writer's sweep reads. Three columns, zero on every public row. The group's
  name comes from `group_rosters` at dressing, by id, so a rename doesn't
  rewrite a group's rows.
- **Reads filter, nothing merges.** `group=` and `not_group=` become
  `group_id IN (...)` / `NOT IN`; no group picked shows both. `feed_rows`,
  `narrowed`'s group half, the merge in `feed_handler` and `group_journal` go.
  Hot, best, the tag cloud, the search index and the dial see group rows because
  they read the one table.
- **Search.** `post_search` and `post_terms` are keyed by author and doc,
  node-wide, and filled by walking each reader's journal. A group post's words
  come through the group's door (`idface::public_blob` on the shown version's
  file hash, as `rejournal` reads them now). `search::body_facts` learns that
  door for a row with a group. The words sit in node-wide tables, as a sealed
  post's do, and are only ever met through a reader's journal.

### 2. One label memo

`doc_annotations` gains `group_id BLOB NOT NULL DEFAULT x''`, part of its key. A
group's `Label` entries are folded into it (the fold already knows which count:
`labels_of`, last write by received order, then `labels_that_stand`), by the
same note-and-forget statements a public label uses. So:

- scores (`score::labels_moved`) count a group post's reactions, and hot and
  best rank it like any post;
- the chips, the tag cloud and `for_posts` see its tags with no patching;
- **the public reads exclude group rows**: every `doc_annotations` read a public
  surface makes (the shelf's labels, the persona page's facets, the public
  post's annotations, the web-path lookup) adds `AND group_id = x''`. The same
  conventions test checks it.

The group lane stays the only road a group label travels: this is a memo of what
the group fold counted, kept where the readers already look.

### 3. The fold, cached by a stamp

The group fold stays whole-history (a late removal voids what's past its anchor;
a senior's write can flip a register), and stays the pure function of the
group's lanes it is. So it is cached, as the key tree is:

- **A per-group stamp.** `group_rosters` gains `lanes_seq`, bumped in the same
  statement that inserts a new lane entry for that group (only when one lands:
  `INSERT OR IGNORE` that inserts nothing doesn't move it). Not the node-wide
  `writes_to("node","group_lanes")`, which moves on every GROUP move by anyone.
- **A cached fold.** `folded(group)` keeps `(lanes_seq, Roster, lanes)` per
  group in RAM, bounded by the memory budget (budget.rs). A read takes the stamp
  before computing (CACHE.md, principle 1), folds only when it moved, and keeps
  the answer. Every read route uses it; the body route's per-card fold becomes a
  map lookup.
- **Derived tables only when the stamp moved.** `refold` compares the stamp with
  the one it last derived from (`group_rosters.derived_seq`) and returns at once
  when they match. When they don't, it writes `group_people` by stamp sweep and
  the journal rows and labels by section 1 and 2's upsert-and-sweep. One group's
  derivation at a time (the per-group lock stays); no table is ever cleared.
- **Arrival by watermark.** `refresh_inner` reads only a persona's GROUP entries
  past its watermark, as `catch_up_annotations` does, rather than re-inserting
  their whole history at every move.

### 4. What stays

The wire, the lanes, the fold's verdicts, the group door, the group's own routes
(roster, posts, hide, labels, publish), the post's own page, and the card.
`GET .../groups/{g}/posts` keeps its answer; it reads the cached fold.

## Slices

Each lands green on its own, in this order, with the claims that prove it.

1. **The fold cached, the memo never cleared.** `lanes_seq`, the cached
   `folded`, `derived_seq`, `group_people` by stamp sweep, the journal's rewrite
   by upsert-and-sweep (still `group_journal`), arrival by watermark. No feed
   change yet. Claims: the twelve-at-once body claim (2026-10-16) stays green; a
   refold with nothing new writes nothing (a count of `group_journal` writes
   before and after); the feed never shows a group with its posts missing while
   a refold runs (a reader polling during a burst of arrivals). A scratch probe:
   body requests per second on a page of fifty cards, before and after.
2. **Public maintenance scoped.** `feed_journal.group_id` with its key, every
   fanout statement scoped, the conventions test. Still no group rows written.
   Claims: the whole fanout suite unchanged; the conventions test catches an
   unscoped statement (a deliberately unscoped one, in the test's own fixture).
3. **Group rows in the one journal.** Roster writes them, `group_journal` is
   read nowhere, then dropped in the same rung. Claims: everything in
   `groupposts.cjs` and `groupinvites.cjs`, unchanged, against the new table;
   new ones: a public post rebroadcast into a group is two rows, and taking one
   down leaves the other; unfollowing a fellow member keeps their group posts; a
   reboot keeps every group row (`retract_vanished`'s boot pass); hot, best and
   the tag cloud show a group post with no chip picked.
4. **One label memo.** Group labels folded into `doc_annotations`, the public
   reads scoped, the conventions test. Claims: a group post's reaction moves it
   in best; its tag is a chip; a public tag cloud, a persona's public page and a
   public post's annotations never show a group label (a stranger's reads, as
   `groupposts.cjs` "nothing public lists or serves it" does).
5. **Tidy.** `roster::feed_rows`, `GroupFeedRow`, the merge in `feed_handler`,
   `narrowed`'s group half, `dress_feed`'s label patch, gone. NEXT_STEPS' 4b
   residuals (best and hot without a chip, tag counts, the journal rewritten
   whole) struck.

## Open questions

1. **A hidden post's row.** Section 1 keeps it only for owners and its author,
   as the journal does now. Alternatively every member keeps the row with
   `hidden` set and the read filters; simpler writes, and an unhide moves no
   rows. The cost: a hidden post's title sits in rows of readers who may not see
   it. Proposed: as now, rows only for those who may see it.
2. **The curiosity dial.** Group rows would meet the dial's stop like any row.
   Is a group post subject to "only people I trust a lot"? Proposed: a group is
   somewhere you chose to be, so its posts pass every stop; the group pick is
   the filter for them.
3. **Speculative rows.** A discovery row (`suggested_via`) is public-only and
   stays so.

## Risks

- **`fanout.rs` is the node's most delicate code.** Slice 2 changes no behaviour
  on its own and lands before any group row exists, so a mistake there shows as
  a red fanout claim, not a lost group post.
- **The rung rewrites `feed_journal`'s key**, the node's biggest table. SQLite
  can't alter a primary key: the rung copies the table. On a node with a large
  journal that's a slow first boot; measure on the busiest dev data before
  shipping, and say so in SERVER.md's upgrade notes if it's long.
