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

Status: slice 1 built (2026-10-18). Nothing here changes the wire, the chains or
the fold.

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
Ask         what was asked, from any door: the draft, the destination, the wishes
  -> resolve   once: made_with, the date, the reply, the refusal table
  -> schedule  a future date on a new post: the whole Ask is the plan; done
  -> body      the kind makes its body: words, a drawing's picture, a book page
  -> media     one pipeline; the destination says where each picture goes
  -> sink      the destination mints and owes its after-duties
```

- **The `Ask`** (`node/src/publish.rs`): `draft`,
  `to: Public { seal } | Group(id) | AsGroup(id)`, and the wishes - `settled`,
  `reply_to`, `room`, `im`, `part_of`, `tz_offset_min`. Every door (the two HTTP
  doors, the drawing doors, the book rollout, the sweep, MCP, import) builds
  one; it serializes, so **the plan is the Ask** and the sweep replays exactly
  what was asked.
- **Resolve** owns the rules every road shares: the date and its rulings, the
  reply's parent (each destination answers where the parent lives - the public
  shelf or the group's lanes - through one interface), and one refusal table for
  the combinations (sealed x room x IM x as-group x book x future date).
- **Body** is the kind's one job. Words are the draft's Marquee or plaintext; a
  drawing is its laundered picture plus words that embed it; a book page is the
  page's words. A new kind adds a body maker and a card.
- **Media** is one pipeline, told by the destination where a picture lands (a
  public twin, sealed or not, or a group media document) and remembering it
  once, so the guards hold everywhere and a republish reuses what it made.
- **Sinks** mint and owe what follows: the public chain plus `after_posted`; the
  group lane plus its labels; as the group, the public sink plus the claim. What
  a draft became is answered by one function over the sink's own record.

The client gets one `publishTo(choice, draft, wishes)` beside
`pure/audience.js`, which every surface calls, and which carries the baking
poller for every door.

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
2. **One door in the client.** `publishTo` and the ten call sites through it.
   Fixes bug 3.
3. **Sinks.** The three destinations as sinks; the books' pages, book post and
   update go through them; `claim_public` in one place; one "what did this draft
   become".
4. **One media pipeline.** The group road gets the public road's guards; the
   drawing doors reuse their media document on republish.
5. **Kinds.** The drawing doors become a body maker on the one door; the book
   rollout's pages likewise. The worked example for a new kind is written down
   here: a poll, its body and its votes as replies.
