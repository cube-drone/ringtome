# hrseAmp - music

A design draft (2026-10-12), with rulings and no open questions. Nothing built.

## The ask (Curtis, 2026-10-11)

> hrseAmp is for music. The default hrseAmp column is a list of all visible
> audio files in a tabular format - "visible" meaning both all of your personal
> private audio, as well as any audio files that have been made visible to you
> from the feed. Each column of the list is sortable: we can sort the list by
> title, album artist, album, length, filename, year, post date (which is either
> the our date or the date it became visible to us), bucket, score (which is...
> score, calculated the same way as for feed items, allowing us to bring things
> with lots of social buzz to the top of the list). Tags, track number and
> artist are visible but not sortable. Table columns can be hidden: by default
> "year", "filename", and "artist" are hidden already. Table columns are
> adjustable in size, things that don't fit are just hidden rather than wrapped.
> Table items can be selected, multi-selected, or "select all'd" (selecting
> everything that matches a filter). With a single or many items selected, we
> bring up the "file" page for a single or multiple audio files - allowing us to
> edit their properties in single or bulk.
>
> Above the table is a stack of filters - like the one in our feed browser. It
> lets us filter based on tags, artists, genres, "from" which allows us to pick
> "me" or any other person who might have shared audio files. There's a "feed
> curiosity" dial, still. In the same way we can save a specific feed filter, we
> can save a specific music filter: this is a _filter_. The default "all"
> filter, like the default "all" feed filter, is always implicitly available and
> contains all visible music. Filters are managed in a column called "Playlists"
> (hrseAmp has the same columnar app format as most other apps). Playlists
> contain Filters, Mixtapes, and Radio Stations. (more to come)
>
> At the bottom of hrseAmp is a non-negotiable page-wide music player: prev,
> play, next, stop, shuffle, tiny thumbnail, tracking for the current song,
> volume. It proceeds either forward or randomly through the current filtered
> set of songs. When proceeding randomly, the randomness is a little less random
> than we'd expect: it secretly creates a "shuffle" that doesn't group songs by
> the same artist or in the same album together and guarantees play of all songs
> before starting again - when it starts again it reshuffles but won't play any
> song in the last 5 songs of the previous shuffle in the first 5 songs of the
> next shuffle (unless the playlist is too small for this to matter). Shuffles
> are stable enough that you can move backwards and forwards with shuffle set
> and reliably get the same few songs, but if you refresh or reboot the app
> you're outta luck. If the user is satisfied with their music picks, they can
> expand the music player to fill the whole page, which keeps the controls in
> place and fills the rest of the page with a cassette with the wheels spinning
> (if the music is playing) and the current thumbnail, lightly blurred, as the
> backdrop.
>
> "Mixtapes": Mixtapes are a combination of a tag ("90's Jams", "Songs for
> Becky") AND a fixed, changeable order. Audio files (single and in bulk) have
> an "Add to Mixtape" option in the File stack that lets the user plop a bunch
> of them in a pre-existing or new mixtape. Since mixtapes are tags, songs can
> be in many different mixtapes at the same time. Mixtapes have a taxonomy under
> the hood.
>
> "Radio Stations": A radio station is a pie chart, allowing you to set the
> probability of songs coming up from any Filter, Mixtape or Other Radio
> Station. Playing a radio station operates via similar rules to a Shuffle but
> it's - well, a bit more abstract and mathy. (This is my favorite way to manage
> music, it's how I manage my personal music, and NO MUSIC APPS SUPPORT IT it
> drives me crazy why don't more apps support this).

## Rulings (Curtis, 2026-10-12)

1. **The player plays across the whole app.** Curtis: "users can just open a
   music TAB, but they can't really do that in the desktop app, right? Which
   means that the music app needs to be able to stick around and keep playing
   music as the user bops around in the app." The player belongs to the shell,
   not to hrseAmp's page (section 4).
2. **An unlock**: after File upload, H$ 5,000, marked experimental as Video
   upload is.
3. **Score**: the feed's own score, reactions on your own sounds included. "The
   score is the grand public score (which for private things IS just you)": a
   sound only you can see is scored by your reactions alone.
4. **Notebook**, for a feed sound, is the one its author filed it in. And a new
   **"By"** column: who made the file, as against who shared it ("From").
5. **Fewer columns, by folding.** Curtis: "can we have a 'title' column that
   picks the metadata title first, and the document title second, and an
   'artist' column that picks metadata album artist first, and metadata artist
   second ... I'm worried that we have WAY too many columns". "Filename" meant
   the document's title, which now folds into Title.
6. **Your own metadata on other people's sounds**: yes - your genre for their
   song, your tags. A tag you put on someone's song is a public label, as on a
   post ("That IS the correct behavior"), so you need a way to see only your own
   tags, or every tag you can see (section 3).
7. **Stretch goals, not now**: posting a mixtape ("I'm not a musician so the
   music publication chain can be a little wonk"), and play and skip counts
   ("could get VERY expensive on the chain").
8. **"Only mine"** is the filter strip's "me", which already exists.
9. **What it replaces** (Curtis's radio today): Liquidsoap and Icecast on his
   public server, pushing probabilistic-bucket stations for a few moods, with
   station ads, streamed to many places (Alexa speakers included, through a
   custom skill). What's wrong with it: it doesn't sync, so it can't play in the
   mountains; there's no skip ("bad song came up, gotta live with it"); and no
   good interface for adjusting it.
10. **Visible** is your sounds, your feed's at the curiosity dial, and anything
    in your mixtapes - not peeks or the front page on their own (section 1).
11. **The default columns** as section 2 proposes, "for now" - narrowed after
    using it to Title, Artist, Album, Length and Tags (2026-10-12).
12. **Everyone's tags by default**, with a chip to narrow to the author's and
    yours (section 3, reversing the draft's default).
13. **Station breaks are just a slice.** Curtis: "that's just another kind of
    playlist or mixtape, right, it's already accommodated for in the existing
    plan." His own stations play their ads by probability, which is what a slice
    at a weight does - so no separate "every N songs" kind.
14. **What a node keeps stays as it is**: everything published by everyone you
    follow, synced to your computer, by design (section 7, option 1). "This is
    going to remain a problem for future us ... right now the whole network is
    just ME and it's at worst about 10-100MB total." Storage budgets stay
    PROJECT_PLAN's open item.

## What's already here

- **Sounds as documents.** An upload becomes Ogg Opus (`media/audio.rs`), with
  its length (`duration_ms`), a cover from its embedded art or a waveform
  thumbnail, and its file's tags read into fields (`TAG_FIELDS`: track, artist,
  album, album artist, composer, genre, year, track number). They're editable in
  Files' sound panel (`doc/soundtags.js`), along with tags, description, date
  and cover. The node answers byte ranges, so a sound knows its length on
  opening and seeks.
- **Folder upload**, a few at a time (`doc/dropfiles.js`): a whole album in one
  drop.
- **Sounds in the feed.** A sound posted on its own is a post, and its fields
  travel with it as public labels (publishing restates a note's fields). A sound
  embedded in a written post is published as a separate public copy (a "twin",
  `record/bake.rs`), and **the twin carries none of the sound's fields**:
  someone reading it sees a title and nothing else. Every post with a sound
  wears the implicit tag `audio`, so the feed can already narrow to them.
- **Scores** (PROJECT_PLAN, _Scores and sort orders_): a post's score is the
  reader's own, computed on the reader's node from the reactions of people they
  follow and trust. "Hot" is time plus score.
- **The facet strip** (`facets.js`): three-state chips per row, an authors row,
  the curiosity dial, saved filters in a Feeds column with "all" at the top (the
  feed, 2026-10-11).
- **Columns** (`panes.js`): the apps' column layout, tuckable and resizable,
  widths kept per device.
- **Taxonomies**: ordered lists of documents, any author's, which notebook trees
  and books are built from.
- **Bulk editing** (`plans/BULK.md`): editing many documents' fields at once.

## The proposal

### 1. The library: every sound you can see

One table of rows, from three places (Claude's proposal; Curtis asked for
thoughts):

- **Yours**: every sound document in your mirror (format `opus`), in any
  notebook. They're already in the browser, so listing them costs nothing.
- **From your feed**: every sound in a post that reached your feed - posted on
  its own or embedded in someone's post - at the curiosity dial's stop, so the
  dial widens and narrows the library as it does the feed ("explorer" reaches
  friends of friends). A new door, `GET /api/identity/<root>/amp/library`,
  answers these from the reader's journal, each with the post it arrived in.
- **In your mixtapes**: any song you've put in one, wherever you found it. A
  song seen on someone's page or the node's front page, without following them,
  comes in this way: you keep what you chose to keep. Peeks and the front page
  aren't sources in themselves, since a peek is a passing look that expires and
  the front page is everyone on the node.

Each row: title, artist, album, track number, year, genre, length, tags,
notebook, by, from, date, score.

- **Title** is the sound's own title tag, else its document's title. **Artist**
  is its album artist, else its artist (ruling 5).
- **Posted by** is who made the file (its author, or the first in its copy chain
  for a copy); **Via** is who it reached you through - you, the person who
  posted it, or who shared it.
- **Date**: your own sound's date (its claimed date, else when you made it); a
  feed sound's, when its post reached you.
- **Score**: the feed's score for the post it arrived in; for your own sound,
  your reactions to it (ruling 3).
- **Notebook**: yours, or the one its author filed it in (ruling 4).
- **Its fields need to travel.** A sound posted on its own carries its fields as
  public labels; one embedded in a written post doesn't - its public copy (the
  "twin", `record/bake.rs`) is made without them, so it would show as a title
  and nothing more. Publishing must state the sound's fields on the twin, and a
  backfill like the web addresses' one covers twins already published.
- **Your metadata over theirs** (ruling 6): you can set fields on someone else's
  song - your genre, your album artist - kept privately on your persona, and in
  your table yours win. The file panel shows both: theirs, and yours beside it.

The table lives in the browser: a few thousand rows sort, filter and select
instantly there, and "select all" means "all that match" with no round trip.

### 2. The table

- **Columns**: Title, Artist, Album, #, Year, Genre, Length, Tags, Notebook,
  Posted by, Via, Date, Score. Shown by default: Title, Artist, Album, Length,
  Tags (Curtis, 2026-10-12). Hidden by default: the rest. Sortable: all but Tags
  and #. Sorting by Album keeps each album in track order. Posted by and Via
  (first drafted as "By" and "From", which Curtis found easy to mix up) say in
  their headers' hover what each means.
- **Widths** drag at a header's edge and are kept per device. A cell never
  wraps: what doesn't fit is cut with an ellipsis, and the whole value shows on
  hover.
- **Hiding**: a menu at the start of the header row lists every column with a
  tick - at the start, so a wide table never scrolls it out of reach (Curtis,
  2026-10-12). Below it, the playing song's row shows a speaker.
- **Selection**: a click selects one, ctrl- or cmd-click adds or removes one,
  shift-click selects a run, and "select all" selects every row the filter
  leaves. A double-click plays.
- **The file panel**: one row opens its sound panel; several open a bulk panel,
  each field showing its value or "mixed", where setting a field sets it on all
  of them. Every field shows unfolded there: title tag and document title,
  artist and album artist, composer. On someone else's song you edit your own
  layer (section 1). "Add to mixtape" is in both (section 5).

### 3. Filters, and the Playlists column

The filter strip above the table, the feed's chips over the library: tags,
artist, genre, from (me, or each person who shared sound with you), and the
curiosity dial. The header's search narrows by title, artist and album.

**Whose tags.** A tag is the author's, yours, or someone else's public label on
the song - and a tag you put on someone's song shows on it for anyone who trusts
you (ruling 6). The strip shows every tag you can see by default (ruling 12),
with a chip to narrow it to the author's and yours; the curiosity dial already
decides whose posts you see, and this decides whose words about them count.

A filter is a saved set of those picks, stored like saved feeds: a private
register on the persona, so it follows you to every computer.

The **Playlists** column lists, in three groups:

- **Filters**: "all" first, always there, then each saved filter.
- **Mixtapes**.
- **Radio stations**.

Choosing one sets what the table shows and what the player plays. Each has a
trash button, as saved feeds do.

### 4. The player

**It plays across the whole app** (ruling 1). The audio element, the queue and
the shuffle belong to the shell, not to hrseAmp's page, so the music keeps going
wherever you go in the app - which the desktop app needs, since it's one window
with no tabs.

- **In hrseAmp**: a bar across the bottom - previous, play/pause, next, stop,
  shuffle, a small cover, the song's title and artist, a scrubber with the time,
  and volume.
- **Elsewhere in the app**: a compact player in the dock's corner while music is
  playing - play/pause, next, the title - which opens hrseAmp when pressed.
- **Outside the app**: the browser's Media Session API, so the computer's media
  keys, the lock screen and the phone's notification shade show the song and
  control it, the Android app included.

It plays the current list: the table as filtered and sorted, a mixtape in its
order, or a station.

**Shuffle** builds an order for the whole list, then plays through it:

1. **Every song once per cycle.** The order is a permutation of the list.
2. **No neighbours from the same artist or album.** Built by a spread shuffle:
   group by artist, then interleave the groups so each artist is spread as
   evenly as the count allows (and albums the same within an artist). Where the
   list is mostly one artist, some neighbours are unavoidable, and the spread
   keeps them as rare as possible.
3. **A seam between cycles.** The next cycle's first 5 are none of the last
   cycle's last 5, by swapping them later into the order, unless the list is 10
   songs or fewer, where that can't be kept.
4. **Stable within a session.** The order is kept in memory as a list, so
   previous and next walk the same songs back and forth. A reload starts a new
   one.

If the list changes while playing (a filter picked, a song added), the shuffle
keeps the songs already played and reshuffles the rest.

**Expanded**, the player fills hrseAmp's page: the controls stay where they are,
and above them a cassette whose reels turn while playing, over the current
cover, lightly blurred.

### 5. Mixtapes

A mixtape is a name and an order. Under the hood it's a taxonomy titled
`mixtape:<name>` (as a notebook's tree is `wiki:<name>`), whose members are the
songs in order - yours or anyone's, since a taxonomy can hold any author's
documents. That makes a song in many mixtapes simple, and the mixtape's name
behaves as a tag in the filter strip ("in mixtape: Songs for Becky").

- **"Add to mixtape"** in the file panel, for one or many songs: a list of
  mixtapes and "new mixtape…". Added songs go to the end.
- **Opening a mixtape** shows the table in the mixtape's order, with a drag
  handle to reorder, and the player plays that order (shuffle still works).
- Removing a song takes it off the mixtape only.

### 6. Radio stations

A station is a pie: slices, each a filter, a mixtape or another station, with a
weight. The editor shows the pie and a slider per slice; weights are shown as
percentages and normalised.

Playing one, each next song is picked in two steps:

1. **Which slice.** By weight, at random. A slice that is itself a station
   passes the pick down to its own slices, so nested stations multiply out. A
   station that would include itself, directly or further down, is refused when
   it's added.
2. **Which song in it.** Each slice keeps its own shuffle (section 4) and gives
   its next song. So a slice plays all its songs before repeating any, however
   often it comes up.

Across slices, the station keeps a short memory of what it just played: a song
played in the last N picks, or an artist in the last few, is skipped in favour
of the slice's next. N scales with the station's size, so a small station still
plays. A slice whose songs are all used up for now is skipped, and the others'
weights stand in.

Previous goes back through what the station played; next after going back
replays forward along the same history before picking anew - the same "stable
within a session" as shuffle.

Stations are stored like filters, as a private register on the persona: a name
and its slices, each a kind, an id and a weight.

### 7. Playing in the mountains, and what a node keeps

Curtis's radio today can't play without the internet (ruling 9). Here, a song
plays from the computer you're on whenever its file is there.

**What a node holds today** (checked 2026-10-12, Curtis having asked): for a
person you follow, every public file they've posted - pictures, video, sound -
right after each sync (`documents::fetch_missing_bodies` walks every public
version and fetches each file, thumbnail and preview it lacks), up to the follow
ceiling of 5,000 posts. A peek fetches media only when opened. Your own files
are on every computer your persona is on. So a followed person's song is here
moments after they post it, and plays offline.

**The worry** (Curtis): "I am worried about this ballooning folks' feed storage
costs over time if they're injudicious about who they follow." Nothing caps it
today: PROJECT_PLAN lists storage budgets as an open item, and `storage.rs`
measures what each persona takes without acting on it. It's true already for
pictures and video; sound makes it bigger (a few megabytes a song, so a
musician's 500 songs is over a gigabyte, fetched whether or not you ever play
one).

**Ruled: as now** (ruling 14) - it stays a problem for later. The options
weighed, for when it comes back, all node-wide since they change the feed's
media too:

1. **As now**: everything from everyone you follow, at once. Simplest, best for
   the mountains, and grows with every follow.
2. **Big media on demand, under a budget** (Claude's recommendation): words,
   thumbnails and pictures stay eager; sound and video are fetched when first
   played, and kept under a node-wide budget for other people's media, the least
   recently played going first. A file's hash is all it takes to fetch it again,
   so an evicted song comes back the next time it's played, from anyone who
   still holds it. **Anything in one of your mixtapes is kept, fetched ahead,
   and never evicted**: your mixtapes are your offline collection, and a station
   built from them plays in the mountains. The cost: a followed person's song
   you've never played or kept isn't here offline.
3. **Per person**: a "keep their media" switch on each follow.

Offline, the player skips what isn't on this computer and moves on, rather than
stopping. And skip is just "next".

### Stretch goals

- **Posting a mixtape** (ruling 7), published as a book is, for someone else to
  play.
- **Play and skip counts** (ruling 7). A cheap first step: counts kept in this
  browser only, never on the chain, so "played" and "skipped" can be sorted and
  filtered on one computer.

- **A station as a stream** other devices can play, as Icecast does now (the
  Alexa skill): the node mixing a station into one endless audio stream at an
  address. Big, and probably later still.

## Slices

1. **The library and the table** - built 2026-10-12: your sounds, the feed's
   (the new door), and your mixtapes' (when there are mixtapes, slice 5); the
   folded columns with their sorting, widths, hiding and selection; the single
   and bulk file panels, with your own layer on others' songs.
2. **The player** - built 2026-10-12: owned by the shell, the bar in hrseAmp and
   the compact one elsewhere, Media Session, shuffle with its rules, and
   expanded mode.
3. **Filters**: the strip over the library, whose tags, saving, and the
   Playlists column with "all".
4. **Twins carry their sound's fields**: publishing states them on the twin, and
   a backfill for twins already published.
5. **Mixtapes**: the taxonomy, "add to mixtape", their order in the table.
6. **Radio stations**: the editor, nesting, and the picker.
7. **The unlock**: hrseAmp in the Market after File upload, H$ 5,000, marked
   experimental (ruling 2) - in the first slice that ships to people, really.

### What building slices 1 and 2 found

- **The door reads a memo, not databases.** `/amp/library` narrows the reader's
  journal to posts carrying sound (the public `audio` tag, from the node's label
  memo), then asks the node's `amp_sounds` memo (migration 0080) which documents
  the sound is, its title, length and thumbnail. An author's database is opened
  only for a post the memo hasn't read at its current version - once per
  version, never once per request.
- **One row per sound.** The same bytes uploaded twice are one document, and a
  song can be posted again; either way the library shows it once, from the
  newest post it arrived in.
- **Scores follow the dials.** The door brings the reader's stored scores up to
  their dials before reading them, as a "best" page does; without that, a score
  stayed 0 until the reader had opened "best".
- **Every feed sound is a twin today.** There is no publishing a sound document
  by itself: a post that is only a sound still embeds it, so its public copy is
  a twin, and every feed row shows a title and a length but no fields until
  slice 4.
- **A sound with no cover shows its waveform.** A thumbnail is always there - an
  embedded cover, else the waveform the ingest draws - so the player's thumbnail
  is never empty, though a waveform at 36 pixels reads as a dark square.

## Questions for Curtis

None open (2026-10-12). Smaller ones will come up as slices are built.
