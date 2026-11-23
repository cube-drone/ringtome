# Published mixtapes

A mixtape, posted: a cassette in the feed with a tracklist and a "play now", the
songs travelling with it. This is AUDIO.md's first stretch goal ("posting a
mixtape ... published as a book is, for someone else to play"), asked for in
full on 2026-11-22. Section 4 is the rulings, with one still open; section 5
says what is built.

## The ask (Curtis, 2026-11-22)

"I'd like to be able to publish a mixtape - either to the greater public, sealed
to people, or to a group." In his words, by part:

- **Publishing.** "In the mixtape browser, a 'publish' row, just like the one in
  hrseWriter and hrseDrawing - with a 'post to' selector." One destination at a
  time: "not 'public' and 'group Terry', just one or the other."
- **A new kind of post.** "A mixtape is legitimately a totally new post type
  from anything we've done before." It "sits in a regular post envelope, with
  the poster's name and standard post options - like 'rebroadcast' or 'show a QR
  code for this' - but the way a mixtape is displayed is as a generated cassette
  ... with the mixtape's name on it, followed by a tracklist, and a 'play now'
  button that takes the user to that mixtape in their own hrseAmp (and starts
  playing it from the first track)."
- **The songs come too.** "Mixtape individual tracks are all shared, as well,
  when a mixtape is shared."
- **In the reader's hrseAmp.** "It shows up in a new hrseAmp 'playlists' row for
  any user who follows that user: 'friends' mixtapes'."
- **In the author's.** "A new hrseAmp 'shared playlists' row for any mixtapes
  the user has shared - clicking on them, the user can see any playlists they've
  shared (and with whom) - changing them lets them republish the playlist with
  more or fewer tracks."
- **Loose songs.** "If you have audio tracks that you've gained from a user that
  don't come from a mixtape (maybe they came from a post), they go into an
  implicit mixtape: 'Garf Barfunkel's Tracks'."
- **Deleting, and the trash.** "A user can delete a shared mixtape, or a single
  shared track from another user, removing it from their storage (if that was
  the only copy). Deleted shared tracks go into a 'trash' row in hrseAmp, where
  the user can choose to undelete them (re-requesting them from the original
  source)."

## 1. What's already here

- **A mixtape is a taxonomy** titled `mixtape:<name>` (`amp.rs` `MIXTAPE`,
  AUDIO.md section 5): a name and an order. A member is the sound itself - the
  author's own private sound, or somebody else's public copy of one
  (`member_root` says whose).
- **A book is the precedent** (`books.rs`, PROJECT_PLAN's _Books_): a notebook
  published whole. A sweep on the author's node publishes each page through the
  ordinary publish door, marked `part_of` the book, so the fold keeps pages off
  feeds; then the book itself mints - format `BOOK`, its body the published tree
  as JSON naming pages by public id. Republishing is the same id at a new
  version, and a ledger says which pages changed. It is resumable, because a
  page whose media is still baking stops the pass.
- **A sound already crosses the membrane.** A private sound embedded in a post
  is published as a separate public copy, a "twin", carrying its fields - track,
  artist, album - as public labels (`bake.rs` `sound_fields_on_twin`). Somebody
  else's public sound embedded in your post is **copied** into a twin of your
  own, credits and all. A sealed post's twin says its fields under the post's
  key.
- **One publish** (ONE_PUBLISH.md, `publication.rs`): every door goes through
  `To` (public, a group, as a group), the date rules, and a sink per
  destination. "A new kind is a body maker ... and a card."
- **The rights sign and fence** (AUDIO.md section 8, `rights.rs`): a tagged
  song - one with an artist or album - asks its publisher to say they may share
  it, and a server whose operator refuses tagged audio refuses the publish.
- **The cap on embeds**: fifty distinct documents to a post (`bake::embeds`). A
  book's pages are not embeds, and are not counted by it.
- **What a node keeps**: every public file of everyone a persona here follows,
  fetched after each sync (`documents::fetch_missing_bodies`), unless everyone
  here who follows them declined that _kind_ (`subscriptions::declined_hashes`,
  2026-11-20) - and a declined kind may also be deleted (`purged_hashes`), which
  the blob reaper carries out. That machinery is per person and per kind. There
  is nothing per document.
- **The cassette** (`player.js`, `pure/cassette.js`): `cassetteLook(key)` draws
  a cassette from a key - its colours, its side, its length, the hand its label
  is written in - the same every time for the same key.
- **The library door** (`amp.rs` `library_handler`): one row per sound in the
  reader's feed at the curiosity dial, plus anything in their own mixtapes.

## 2. The shape

### The post

A new document format, `MIXTAPE`, public only as `BOOK` and `ROOM` are. Its
title is the mixtape's name. Its body is the tracklist as JSON: for each track,
in order, the public document its song is and what a card needs to draw the line
without opening it (title, artist, album, length).

**The draft is a note** (built 2026-11-22, where the first sketch had a
book-style rollout). The private side stays a taxonomy, and the node makes a
Marquee note of it on request (`PUT .../amp/tapes/<id>/draft`): the mixtape's
name for a title, one embedded sound per track for words - the author's own
sounds by their private address, anybody else's by their public one. The note is
kept by its taxonomy in the persona's private `mixtape_drafts`, and being named
there is what makes a publish of it mint a mixtape. So a mixtape is published by
**the door every note takes**: where it goes, when, sealed or not, scheduled,
edited, taken down - none of it is the kind's own. The room is the precedent
("the draft is Marquee and the publish says 'room'").

The publish's bake does the rest as it does for any post that embeds sound: an
own sound becomes a public twin carrying its fields, somebody else's is copied
into a twin with its credits (ruling 1), the rights fence and the count are said
before a byte moves.

**The tracks are the post's refs**, as any post's media are (ruling 8). So they
go wherever the post goes - a follower's node holds them, and so does the node
of somebody who only follows a person who rebroadcast it - and a takedown of the
mixtape takes them, by the road every post's media takes (`orphaned_twins`). A
mixtape is **the one post over the media budget** (`bake.rs`
`MAX_POST_MEDIA_BYTES`, 10 MB, whose comment and PROJECT_PLAN's _What travels
with a share_ both name the mixtape as the case deferred): it is capped by its
count instead, thirty. One thing is still the kind's own: a track taken off at a
republish is taken down then (ruling 6), where an ordinary post's dropped
picture is left standing.

(Built for a day the other way - tracks named in the body alone, fetched on
demand - which kept shares small and meant a reader could see a mixtape they
could not play.)

Everything the envelope does comes with it and needs nothing new: the poster,
rebroadcast, the QR code, replies, reactions, comments-off, tags, the score.

### Where it goes

The publish row's "post to" is the one every surface has: public, sealed to
people, or one group. Fixed at the first publish, as a book's is; to move a
mixtape is to take it down and publish it again.

- **Public**: tracks are public posts, the mixtape a public post.
- **Sealed**: each track sealed to the mixtape's audience, its fields said under
  the key, as a sealed post's twins are now.
- **A group**: each track one of the group's media documents, the mixtape a post
  on the group's lane. The group's "words only" check learns the kind.

### The card

In a feed, on its own page, and in a group: the cassette (drawn from the post's
id, the mixtape's name written on the label), the tracklist - number, title,
artist, length - and "play now". Its reading copy, for a crawler and a reader
without scripts, is the name and the tracklist as plain HTML.

"Play now" goes to that mixtape in the reader's hrseAmp and starts the first
track.

### In hrseAmp

The Playlists column gains rows, each present only while it has something:

- **friends' mixtapes**: every mixtape post in the reader's feed, at the same
  curiosity dial the library uses. Opening one shows its tracks in its order,
  read-only: no drag handle, no "out of".
- **`<name>`'s Tracks**: one per person, implicit - every sound of theirs the
  reader holds that no mixtape of theirs names. Computed when asked, stored
  nowhere.
- **shared playlists**: the reader's own published mixtapes, each saying where
  it went and to whom. Opening one shows what is published beside what the
  mixtape holds now, and "republish" when they differ.
- **trash**: section 3.

### Republishing

A new version of the same post. A track added is published; a track taken off is
taken down - unless another published mixtape of the author's still names it.
Readers' cards and their hrseAmp rows follow the new version.

## 3. Deleting, and the trash

Today a reader can decline a _kind_ of a person's files. This is finer: one
document. It needs:

- **A private ledger** of what the persona threw away, by author and document.
- **The node's two halves**, shaped as the kind-level ones are: it stops
  fetching a trashed sound (`fetch_missing_bodies`), and the reaper stops
  keeping it on this persona's account. The same rule as for kinds decides
  whether the bytes actually go: only when nothing else on the node points at
  them - another persona here who still wants it, a rebroadcast, a report - and
  a quarantined file stays whatever anyone asks.
- **The library** leaving trashed sounds out, and the **trash** row listing
  them. Undelete strikes the ledger line, and the next sync fetches the file
  again from its author or anyone who still holds it.

Trashing a whole mixtape trashes each of its tracks and hides the mixtape from
"friends' mixtapes". The copy under-promises, as all deletion copy here does: a
file goes when the reaper next runs, and comes back only if someone still has
it.

## 4. Rulings (Curtis, 2026-11-22)

Asked as seven questions; six answered the same day.

1. **Somebody else's song on my mixtape is copied** into my own lane, as
   embedding it in a post does now: "Yeah, copy." My audience can always play
   it, it is mine to take down, and the rights sign is shown for it.
2. **"I don't want this mixtape" and "unpublish" are two things, and both are
   built.** The first is a reader throwing a mixtape someone shared with them
   out of their own storage (section 3); the second is its author taking it
   down.
3. **Thirty tracks.** "That's all the songs that will fit on a real cassette
   tape. If a user puts a 31st item in their mixtape, grey out the 'publish' bar
   with a 'this playlist is too large to publish (>30 tracks)' error." The
   mixtape itself may hold more; it is publishing that stops at thirty.
4. **The rights fence: undecided.** "This one ... I'm not sure about." On a
   server that refuses tagged audio, a mixtape with tagged songs could be
   refused whole, naming them, or published without them. Until it is ruled,
   slice 1 **refuses whole**: it publishes nothing that wasn't asked for, and
   loosening it later is a change nobody's published mixtape has to survive.
5. **"Play now" plays, hrseAmp bought or not**: "Play anyways."
6. **A track taken off at a republish is taken down**, and followers' nodes drop
   it as they drop any takedown: "removal should cascade."
7. **A person's loose song stays in "`<name>`'s Tracks"** when the reader puts
   it on a mixtape of their own: "it stays in Garf's tracks."
8. **A rebroadcast carries the songs** (2026-11-23). Asked whether a reader
   could see a mixtape and not have its tracks: "if someone you follow
   rebroadcasts a mixtape, you should download the tracks because _someone you
   follow rebroadcast them_ ... That's not an on-demand thing, you just get them
   automatically because you're part of a network that makes that available to
   you." The cost is the one the media budget exists to bound - everyone who
   follows a sharer downloads the whole tape, at every hop - and what bounds it
   here is the thirty tracks, "don't sync audio from this person", and the
   trash.

## 5. Slices

In the order that lets each be seen working before the next.

1. **The kind, in public.** _The node's half built 2026-11-22_: the format; the
   draft a note made of the taxonomy; publishing by the ordinary door; the
   tracklist; thirty tracks; takedowns of dropped tracks and of the whole.
   `mixtape_publish.cjs`, across three nodes: one post in a follower's feed and
   none of its songs, her node holding them; a rebroadcast reaching somebody who
   never followed the author, songs and all; a song taken off taken down;
   thirty-one refused; the takedown taking the songs. _The publish row built
   2026-11-23_ (`doc/tapepublish.js`): the bar Writer and Drawing wear, over an
   open mixtape of your own - "publish…" makes the draft, the bar publishes it,
   and every publish brings the draft up to the mixtape first. Greyed past
   thirty tracks, with ruling 3's words. Groups are offered since slice 6, and a
   sealed mixtape is offered and untested.
2. **The card.** _Built 2026-11-23_ (`doc/mixtapecard.js`): the cassette
   (`player.js` `CassetteArt`, pulled out of the player's own), the tracklist,
   and "play now", which plays the tape in the app-wide player from its first
   track and takes a reader who owns hrseAmp there. _Still to build_: the
   reading copy; MCP's kind filter, the feed's kinds, search.
3. **Play now, and "friends' mixtapes".** _Built 2026-11-23._ The library door
   answers `tapes` - the mixtape posts in the reader's feed, at its dial - and
   the Playlists column lists them under "friends' mixtapes", each with whose it
   is. Opened, one is the table in its own order (read from the post's words),
   with no drag handle, no "out of" and no publish row. The card's "play now"
   goes to it (`?tape=<author>/<post>`); the author's own card opens the mixtape
   it was published from.
4. **"Shared playlists", and republishing.** _Built 2026-11-23._ The row lists
   each of the reader's mixtapes whose draft stands published, with where it
   went; opened, it is the mixtape under its publish row. The ledger is one
   stamp: a publish marks the draft with the version that went out
   (`published_head`, as a drawing's does), the row brings the draft up to the
   mixtape whenever its songs or name change, and "update" is offered when the
   two differ - with "published with N tracks - the mixtape holds M now". _Not
   built_: the two lists side by side, track by track; and a song's own fields
   changing (a new title) does not offer the update.
5. **Sealed.** _Works as built, proved 2026-11-23_ (`mixtape_publish.cjs`, "a
   mixtape, sealed"): the tracklist and each song sealed under the post's key; a
   stranger and an untrusted follower refused; a trusted follower on another
   node handed the tracklist and every song. _In hrseAmp, built the same day_:
   the library lets a sealed mixtape through for a reader the feed's own gate
   admits (`readable_feed_rows`), marked `sealed`, its songs as rows read off
   its open header. Its name and its songs' names are under the key, so hrseAmp
   asks the body door for each sealed mixtape's words once per version and names
   the row and the songs from them. Every other sealed sound stays out of the
   library, as before. _Somebody else's song on a sealed mixtape, built the same
   day_ (Curtis: "unseal it and copy it into our own lane unencumbered"): that
   song is public already, so its copy in the author's lane is public too, and
   so is what it says of itself. The tracklist, the mixtape's name and the
   author's own songs stay under the key. What this shows the untrusted: that
   song, by its name, in the author's lane, named by the sealed post's open
   header. A song that reached the author sealed still cannot go on a mixtape of
   theirs - the copy reads only what is public.
6. **Groups.** _Built 2026-11-23_, in two passes.
   - _The door and the card._ A mixtape's draft goes through the group's own
     publish door (`roster::publish`), which knows it for one
     (`amp::is_tape_draft`) and makes a post of the `mixtape` format on the
     poster's lane: each song one of the group's media documents (your own, or a
     copy of somebody else's public one), the words their list in the draft's
     order, songs only, thirty at most. It is the one group post over the media
     budget (Curtis: "relax the cap for mixtapes"). A song taken off is taken
     down in the group at the next publish, and taking the mixtape down takes
     its songs - unless something else standing in the group names them. The
     card is the same card; its songs play through the group's door (`player.js`
     `soundSrc`, a row's `group`). The publish row offers your groups.
   - _hrseAmp._ The library door lists each mixtape posted in the reader's
     groups with its `group`, and its songs as rows read off its tracklist. The
     Playlists column has a section per group that has any (Curtis: "a section
     per group-that-has-mixtapes"), under the group's name; your own, posted in
     a group, is under "shared playlists" saying which.
   - `mixtape_group.cjs`, across two members' nodes: the post on the group's
     page as a mixtape, its songs playing at the other member's node, her feed
     and her hrseAmp, nothing public, a dropped song gone, the takedown taking
     the rest.
   - _Not built_: a group's song on a mixtape of your own (it plays there, and
     cannot be published - it is the group's, not public); tags and thumbs on a
     group's song from hrseAmp; the storage it costs a phone, which waits on
     "member, but don't keep the media" (GROUPS.md).
7. **"`<name>`'s Tracks".** _Built 2026-11-23_, in the "friends' mixtapes"
   section, one row per person. The library marks each sound a mixtape in the
   feed names (`taped`), so a song posted on its own _and_ put on a mixtape is
   the mixtape's. Read-only, newest first.
8. **The trash.** The ledger, the fetch and the reaper, the row, undelete.

Slices 5 to 8 don't depend on each other. Slice 8 is the only one that touches
storage and the reaper, and is the one to run the full gate for.

## 6. What this costs

- **A wire addition**: document format 9. A node that predates it shows what it
  shows for any format it can't read.
- **Storage**: every published track is a public document on its author's chain,
  priced as a post's media is (`media_budget_of`), and held by every follower's
  node. A hundred-track mixtape is a few hundred megabytes in each.
- **Shares that are not small**: a rebroadcast of a mixtape is the whole tape,
  to every follower of the sharer (ruling 8).
- **A second deletion ledger** beside the kind-level one. They have to agree
  about a file both of them name: declined by kind _or_ trashed is not fetched;
  kept only when neither says otherwise.
