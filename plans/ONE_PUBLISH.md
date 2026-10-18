# One publish

Every kind of thing a persona publishes - words, a drawing, a book, a room - to
every place it can go - in public, into a group for its members, in public as a
public group - through one pipeline, so each step is written once, every road
behaves alike, and a new kind of post (a poll, a whiteboard, a game) is one new
piece rather than a new road per destination.

Curtis (2026-10-18): "Let's work on building the single unified publication
pipeline: hopefully we can conceptually simplify, have things work more
similarly (fix those bugs!) and prepare for more content types down the road."
Sealing and contact tags stay as they are for now ("we'll forget 2 for now").

Status: built (2026-10-18), slices 1 to 5. Nothing here changes the wire, the
chains or the fold.

## Why

An audit on 2026-10-18 found every destination re-implementing the same steps:

- The draft's date resolved four times (both publish doors, the drawing door,
  the book rollout), the schedule-or-now choice twice, the reply checks twice,
  `claim_public` four times, the labels restated three ways, and the media
  pipeline four times (the public bake, the group's `media_in`, room lines, the
  drawing doors).
- The client chooses a door in ten places; five call the group door with a raw
  `api()`, and only the public door has the shared baking poller.
- What the draft became is kept three ways: `PUBLISHED_AS`, `group_drafts`,
  `PUBLISHED_VERSION`.

The copies have drifted, and the drift is bugs:

1. **A scheduled reply, room or IM loses what it is.** The public plan keeps
   `at/by/settled/trusted_only/as_group` only, so on the day the sweep mints a
   reply as a top-level post and a room as a plain one.
2. **A future-dated edit of a live post is lost.** It's saved as a plan; on the
   day the sweep sees `PUBLISHED_AS`, clears the plan and mints nothing.
3. **A new chat room "in public, as a group" posts as a plain public room**: the
   picker offers it, `chat.js`'s `make()` reads only a group or a seal.
4. **A refused plan is kept on one road and spent on another**: a members-only
   group plan is spent (`publish_planned`), one as a public group is kept.
5. **The group road lacks the public road's guards**: the audio-rights fence,
   the media budget, the link scrub, stickers, web and foreign pictures; its
   drawing door mints a new media document on every republish; the book rollout
   never marks `made_with`; MCP sends a zone of UTC, which matters only for a
   draft its person dated in the app (MCP sets no dates itself).
6. **A scheduled post's onward hop was dropped**: the sweep minted with
   `onward: false`, whatever the draft's audience said.

## Rulings (Curtis, 2026-10-18)

1. **A future date on a reply or a room is refused**, with words. A reply
   answers what's there now and a room opens now; neither is scheduled, on any
   road. (Today the public road schedules them and loses what they are; a group
   posts them now with a future stamp on the header.)
2. **An edit of a live post publishes now and the post stays live.** A date
   can't take a live post back: a future date on one is not a schedule.
3. **A plan refused on its day is spent, and the draft says why.** The draft
   carries "not posted: <why>" until the author publishes or redates it.

## The shape

```
door        the publish, the drawing's, a group's two, the book rollout, the sweep
  -> where     To: Public | Group(id) | AsGroup(id); refuse(to, Asked); admit(to)
  -> date      when(claimed, Shape { answers, room, live }) -> Now | Later | refused
  -> schedule  Later: the Plan on the draft; the sweep replays it through the same steps
  -> body      the kind: a draft's words, or a drawing's laundered picture and its words
  -> media     embeds(): links made fit, the count cap, the rights fence, the missing
  -> sink      the destination mints, then owes: after_public + claim, or the group's labels
```

All of it is `node/src/publication.rs`, but for the kinds and the sinks, which
live beside what they mint.

- **Where it goes** is `To`, built once per door (`To::of(group, as_group)`
  refuses both at once). `refuse(&to, Asked { sealed, room, im, book })` is the
  one table of what can't go where; `admit(state, root, &to)` the one membership
  check; `live(...)` the one answer to "what is this draft already, there, and
  what date does it carry".
- **The date** is `claimed` and `when`, with the three rulings below; a schedule
  is a `Plan`, the JSON every road already wrote, so plans made before this read
  the same. The sketch had the whole request serialized as the plan (an `Ask`);
  ruling 1 made that unneeded - nothing scheduled is ever a reply, a room or an
  IM, so `at`, `by`, the wishes and the destination are the whole of it, and the
  sweep re-reads the seal from the draft as the door does (`public_seal`).
- **Media** is `record::bake::embeds`, read by the public bake, a group's post
  and a room's line: the links made fit for readers (`public_links`), the count
  cap and the rights fence before a byte is baked, and the pictures that name
  nothing, left out. Each destination then lands a picture its own way (a public
  twin, or the group's media document), and prices the bytes alike
  (`media_budget_of`).
- **Sinks**: in public, `bake::publish` then `publication::after_public`
  (`after_posted`, then `claim`, which is the claim as the group or nothing); in
  a group, `roster::publish` / `post_version` and its labels; a picture post,
  `docs.publish` with its twin or `roster::post_picture`.
- **Kinds**: words are the door's own; a drawing is
  `identity::routes::publish_drawing`, the one drawing publish behind both its
  doors. A new kind is a body maker like it, and a card.

The client has one `publishTo(root, doc, what, opts)` beside
`pure/audience.js`'s `publishRequest`, which every surface calls.

## Slices

1. **The date and the plan** (built 2026-10-18). `node/src/publication.rs`:
   - `claimed` reads the draft's date; `when(dated, Shape, now)` is the rulings
     (now, `Later(at)`, or refused), unit-tested; `Plan` is the one plan type,
     the JSON every road already wrote; `schedule`, `posted`, `refused` and
     `settle` keep the draft's `publish_plan` and `publish_refused`.
   - Both publish doors and both drawing doors ask `when`, with the post the
     draft already is where it's going (`live_public_date`,
     `roster::live_date`). An edit of a live post answers `date_kept`, and the
     publish bar says so.
   - The sweep mints a public plan through `public_seal`, the door's own seal
     reading, so an audience and its onward hop hold (bug 6). A refusal spends
     the plan and says why on the draft (the bar shows "not posted on its day:
     ..."); the node's own trouble leaves the plan for the next pass; still
     baking leaves it too.
   - Bug 1 goes by ruling 1 (no reply or room is ever scheduled), bug 2 by
     ruling 2, bug 4 by `settle`.
   - The `Ask` itself - the whole request as one value every door builds - comes
     with the sinks (slice 3), where the doors' remaining steps meet.
   - Acceptance: `scheduled_posts.cjs` (a reply and a room refused a future
     date; a live post's future-dated edit publishes now, keeping its date),
     `groupposts.cjs` (the same on a group), `publicgroups.cjs` (a plan as the
     group refused on its day after its poster's removal: spent, with why).
2. **One door in the client** (built 2026-10-18).
   - `pure/audience.js` `publishRequest(choice, fields, also)` says where one
     publish goes and what it asks there, unit-tested; `doc/publish.js`
     `publishTo(root, doc, what, opts)` sends it - words or a drawing's picture,
     to the public or a group's door, the rights sign first on every words door,
     the bake poller on the public one - and names the answer alike (`post_id`,
     `group`). Only `doc/publish.js` calls a publish door now.
   - Through it: the publish bar (its surfaces pass one `prepare()` - save, then
     `{ words: true }` or `{ picture }` - in place of `publish` and
     `publishToGroup`), the feed's composer, both reply roads, a new room, a
     room's close, a new IM, and the post card's and the diff page's updates.
     The drawing's two door functions are gone.
   - The composer's choice is its pick, else the draft's standing choice: its
     picker starts at everyone for every post, so everyone there is nothing
     picked, and a copy of a sealed post keeps its seal.
   - Bug 3: a room's picker offers no "in public, as a group" (`AudienceSelect`
     `asGroups`), and a room asked as one would be refused in words by the door.
     The book column's picker is `AudienceSelect` with no seals, and reads the
     choice with `groupOfChoice` and `asGroupOfChoice`.
   - A refused plan says why on the feed's draft too.
   - Acceptance: `integration/test/pure/audience.cjs` (`publishRequest`), and
     `harness/publish-to-probe.mjs`, the real composer and chat in jsdom: to
     everyone, into a group, a copy of a sealed post keeping its seal, a room
     into a group, and no "as a group" in the room picker. A drawing's picture
     isn't driven (jsdom has no canvas); its doors are the server's, unchanged.
3. **Where it goes, and what each place owes** (built 2026-10-18).
   - `To`, `refuse`, `admit`, `claim`, `after_public` and `live` in
     `publication.rs`, unit-tested. Through them: the public publish and its
     drawing door (as the group, refused or admitted by the table; the claim
     after the mint), a group's publish, drawing door and planned publish (one
     membership check), the book rollout (`To::of`, the table with `book`, and
     the book's claim through `claim`) and the sweep. The old refusal strings
     ("as-the-group-is-open", "a-groups-book-isnt-sealed", "one-place-for-a-
     book") are `publication.*` now, in the same words; `live_public_date` and
     `roster::live_date` answer through `live`.
   - The drawing door reads its seal as the words' door does (`public_seal`, its
     `trusted_only` now optional), so a copy of a sealed drawing keeps its seal.
   - Books' page dates are `publication::claimed`.
   - Not done: the book post and its update are minted by `books.rs` itself
     (`save_public_text` - they're no draft's, so no door's); they owe their own
     key memo and labels as before.
4. **One media pipeline** (built 2026-10-18). `record::bake::embeds` is the
   pre-pass every destination reads; a group post and a group room's line now
   have the public road's link scrub, rights fence, missing-picture drop,
   built-in stickers (adopted first; a picture still being made is refused in
   words) and media budget (`media_budget_of`, by the sources' blobs, said
   before a picture is minted); a public room's line too has the link scrub and
   the fence. Not done, on purpose: a group post still refuses pictures from the
   web or from someone else's post - the public road downloads those into public
   twins, which a members-only post can't carry; a members-only download is the
   residual. A drawing republished mints a new picture on both roads and keeps
   the old one, which the post's history still shows.
5. **Kinds** (built 2026-10-18). `identity::routes::publish_drawing` is the
   drawing kind: its draft read, its picture laundered, then the destination's
   sink - a public twin and the post, or `roster::post_picture` - and its
   `published_head` stamped on either road (a group's drawing had none, so its
   bar couldn't tell it had changed). Its two HTTP doors are a few lines each.
   Acceptance: `groupposts.cjs` (a group post's media read as the public road
   reads them: a missing picture left out, a notebook's name off a link, a
   built-in sticker adopted and carried; a group drawing's `published_head`),
   and every area the roads reach - drawings, groups, public groups, group
   rooms, rooms, IMs, books, group books, combinations, scheduled and dated
   posts, MCP.

## A new kind, worked: a poll

What a poll would take now, road by road:

- **The body**: a `Format::Poll` whose words are the question and its choices (a
  small JSON or Marquee block), made by a body maker as `publish_drawing` makes
  a drawing's: read the draft, check it's a poll, hand the destination its
  words. Every destination, the date rulings, the plan and the sweep come with
  it, because they're `To`, `when` and the sinks, not the kind's.
- **The votes**: replies, each naming one choice. A reply already goes to the
  public post or the group's lanes by the same reply roads, takes comments-off
  and the reply rules, and counts in the replies memo; a poll's card tallies its
  replies by choice. No new entry type on any lane.
- **What it still touches**: `Format` and its allow-lists (`documents.rs`'s
  mergeable and publishable formats, the group's "words only" check), the card
  (`postentry.js`), the composer's way to make one, and MCP's kind filter.

## Residuals

- A group post can't carry a picture from the web or from someone else's post: a
  members-only download, landing as the group's media document, would.
- A book page with a future date mints at once under that date: books have no
  schedule, and none of the rulings says what a dated page should do - it wants
  one.
- MCP sends a zone of UTC; it matters only for a draft its person dated in the
  app.
