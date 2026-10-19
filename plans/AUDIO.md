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

Rights (Curtis, 2026-10-12; section 8). He'd love to run a peer-to-peer
SoundCloud, and would be a lot less happy running a peer-to-peer Napster: a
published song with its title, artist and album filled in is the shape of the
second. It's an open protocol and a free app, so in the end it's the user's
choice; what the system can do is say how it wants to be used, and let an
operator say "not from my server".

15. **A tagged song is one whose artist or album is set.** A title alone is how
    a voice memo or a field recording gets named.
16. **The warning is a sign, not a fence**: "Keep Out; Or Enter, I'm a Sign".
    The app asks every time a person publishes something carrying a tagged song;
    an agent or the API publishing isn't asked - it's a speed bump, and a speed
    bump only needs to be where people drive.
17. **The operator's opt-out is total, over public chains**: a node can refuse
    tagged audio altogether - neither published by its people nor carried for
    anyone else. Private uploads are untouched: "I'm only concerned with users'
    public chains here."
18. **No record of who asserted what.** "Somebody else already asserted
    ownership of this" is unverifiable at scale, and "any time we're at risk of
    reinventing NFTs, it's probably time to look at our priorities."

Sound (Curtis, 2026-10-12; section 9). Casual listeners turn to an equalizer to
make up for poor speakers, to fit the music to the moment - his own furthest
reach was a dinner-party playlist with the "human speech" frequencies turned
down, so it sat behind the conversation - and for the look of it.

19. **No crossfade.** "I've never heard it done subtly enough to justify its
    effort and I wouldn't have it enabled, so I wouldn't build it."
20. **Loudness levelling, yes**: "a pretty easy slam dunk".
21. **A small equalizer, at the end**: "if anything, the WinAmpiness of it
    appeals more than the practicality."

Playing on Android (Curtis, 2026-10-12; section 10): on the phone, from Android
Auto, through wireless headphones, and on in the background while it plays -
"This is a huge priority, being able to play and sync my car tunes would be Very
Cool, here."

22. **Android playback is a priority**, and Tauri's web view can't carry it: it
    needs a native piece (section 10).
23. **A foreground service while music plays is right** - the media-playback
    kind, whose notification is the player itself and goes when the music does.
    MOBILE.md's "the wrong thing for this app to hold" stands for everything
    else.

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
  Posted by, Via, Date added, Score. Shown by default: Title, Artist, Album,
  Length, Tags, Date added, Score (Curtis, 2026-10-12). Hidden by default: the
  rest. Sortable: all but Tags and #. Sorting by Album keeps each album in track
  order. Posted by and Via (first drafted as "By" and "From", which Curtis found
  easy to mix up) say in their headers' hover what each means.
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

**Pins** (Curtis, 2026-10-18). Any filter, mixtape or station can be pinned. A
pinned one leaves its group for a "pinned" group at the top of the column,
wearing its kind's glyph, oldest pin first, and its list comes first in the
car's too. Pins are private registers like the filters (`amp_pins`, keyed
`<kind>:<id>`, valued with the moment pinned), so they follow you to every
computer; forgetting a list takes its pin.

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

### 8. Rights: a sign and a fence

**The sign** (rulings 15, 16). Publishing a post that carries a tagged song -
your own, or someone else's copied into your post, which republishes it - opens
a dialog first, every time:

> You're publishing a song that names its artist or album. You may not have the
> right to publish it. Nothing here hides where it comes from: it will be served
> from {node} and from the computers of the people who follow you. Do you have
> the right to publish this file?
>
> [Yes, publish it] [No, don't publish this]

The wording says what's true for the person reading it: on a hosted node like
horsedrawingtycoon.com it's the server's address that's out there, not their
home's, and either way other people's computers carry the file. The dialog lives
in the app only - the composer's publish, scheduling (asked when the time is
set, not when it comes round), and a book's rollout (once, for every page that
carries one). The node doesn't check: agents and the API publish as they do
today (ruling 16). Nothing is recorded (ruling 18). The app knows a song is
tagged from its own sound's fields, and a copied song's from the fields its
author said on its twin (slice 4).

**The fence** (ruling 17). A setting in the server's customization, beside the
search policy: "tagged audio - not from this server". With it on:

- **Publishing**: the bake pass refuses a post carrying a tagged song - your own
  or a copy - with words that say it's this node's choice, for everyone, agents
  included. This is the same point where slice 4 says a sound's fields on its
  twin, so the fields are in hand.
- **Carrying**: the node neither fetches, keeps nor serves another node's tagged
  audio. A twin is tagged when its author's labels on it set artist or album -
  the node's label memo knows, so the check costs no database. The posts still
  arrive and read as usual; the song in them says "not carried on this server",
  in the post and in hrseAmp, and its body door answers as for something not
  held. Switching it on stops the serving at once, and the reaper drops the
  bytes already held.
- **What it can't see**: a song published untagged, or before slice 4, says no
  artist or album, so it passes. The fence is the operator's word on what
  they'll host, not a detector, and stripping tags walks around it - as it walks
  around the sign.

### 9. Sound: levelling, and an equalizer

**Loudness levelling** (ruling 20). A library made of other people's uploads
swings in volume - a 1970s rip beside a loud modern master beside a phone
recording - and a shuffle or a station makes the jumps jarring. So:

- **Measured once, at the ingest.** The ingest already decodes every upload to
  samples before it encodes Opus (media/audio.rs, symphonia), so it measures the
  song's integrated loudness (EBU R128, in LUFS) on the way through; a file that
  arrives as Opus already is decoded once for the measure. It's carried on the
  sound as its length is, and said on the twin with the other fields (slice 4),
  so a feed song brings its loudness with it.
- **Applied as volume, downward only.** The player turns a song louder than the
  target down to it - a multiplier on the volume it already sets, so no Web
  Audio, and nothing to break the app-wide, screen-locked playing of ruling 1. A
  quiet song is left as it is rather than boosted (boosting would need a
  limiter, which is Web Audio). A song with no measure - from before this, or
  from a node without it - plays as it is.
- **One switch**, on by default, in the player's corner of hrseAmp; nothing to
  tune.

**A small equalizer** (ruling 21), for the Winamp of it as much as the use: ten
sliders in Winamp's bands, a handful of presets - "background" among them, the
dinner-party one, the voices' frequencies (about 1 to 4 kHz) turned down - kept
per computer. It means routing the sound through Web Audio, and on iOS Safari a
Web Audio context is suspended in the background, which can stop the music when
the screen locks. So it's off until someone turns it on, routes through Web
Audio only while on, and says plainly that it may stop background playing on
some phones.

### 10. Playing on Android: the pocket, the headphones, the car

**What the web view can't do.** Tauri v2 on Android draws the app in the Android
System WebView, and the WebView doesn't hand the page's Media Session to
Android's own - the browser Chrome does that, the WebView doesn't. So from the
web view alone: no player in the notification shade or on the lock screen; the
headphones' buttons go to whichever app last held Android's media session, not
to us; Android Auto never sees the app, because Auto only talks to an app that
declares a media browsing service in its manifest and gives it a tree to browse;
and once the app is in the background, Android's battery rules and its process
reaper stop the music before long - and the node with it, since it runs in the
same process.

**What it takes: a native player, in a small Tauri plugin**, on Media3
(Android's media library):

- **ExoPlayer plays the songs**, straight from the node at `127.0.0.1` as the
  page does, with the session the web view signed in with (Android's cookie
  store is shared, so the player's requests carry it).
- **The queue comes from the page.** hrseAmp's player (`player.js`) keeps the
  list, the order and the shuffle (section 4, `pure/shuffle.js`) - a shuffle is
  only an order - and on Android hands the native player the queue in order,
  with where to start, instead of playing it in an `<audio>`. The native player
  says back what it's playing, where it is, and when a song ends, and the bar,
  the compact player and the cassette show that. A press on the page's buttons
  is a command to the native player. A shuffle hands over two cycles ahead, and
  the native player asks for more as it nears the end; if the page is asleep and
  doesn't answer, it plays the cycle it has again rather than stopping.
- **A media service** (Media3's `MediaLibraryService`) holds Android's media
  session: the player in the notification shade and on the lock screen, the
  headphones' buttons, and the car's controls.
- **A foreground service while it plays** (ruling 23): the media-playback kind,
  its notification the player. It keeps the app, and the node in it, alive while
  music plays - so the node goes on syncing on the drive - and stops a little
  after the music is paused or stopped, as music apps do.

**Android Auto.** The media service answers Auto's browsing with a small tree:

- **Mixtapes**, each a playable list, in its order. The node knows them (they're
  taxonomies), so the service reads them from the node's own HTTP API.
- **Everything**, the whole library, shuffled.
- **Saved filters**, each a playable list. A filter is narrowed in the page
  (`pure/ampfilters.js`), so the page hands each saved filter's list to the
  native player whenever hrseAmp is open, and Auto plays the last one handed
  over - a little stale at worst. (The alternative, the node narrowing filters
  itself, is a port of the filter logic to Rust; worth it only if stale lists
  bite.)
- **Radio stations**, when slice 6 has them.

Voice search ("play Giorgio by Moroder") is Auto's next ask, and can wait.

**Cold starts.** Auto, or a headphone's play button, can start the media service
with the app closed, and the service needs the node to play anything. MOBILE.md
already names the node booting on Android's main thread as a risk of a "not
responding" kill; for this it has to boot off the main thread first.

**Offline in the car.** Songs from people you follow are on the phone already
(ruling 14); in a dead zone the player plays what's here and skips what isn't
(section 7). Section 7's option 2 - your mixtapes kept and fetched ahead - is
the car's natural offline set, if storage ever asks for a budget.

**Elsewhere, less sure.** The desktop app bundles Chromium (DESKTOP.md); if its
window is Chromium, the Media Session hrseAmp already sets should reach media
keys and the system's now-playing panel as Chrome does - one test to make sure.
iOS, if it comes: WKWebView can play in the background with the audio background
mode, but CarPlay, like Auto, needs native code and Apple's entitlement.

**Testing.** The Android build is CI-only, so each round trip is slow: a real
phone for the shade, the lock screen and the headphones, and Google's Desktop
Head Unit (Auto on a laptop) for the car.

**What building it found** (2026-10-12, three rounds, each a CI build and a
phone):

- **No plugin.** The player lives in the Android project Tauri generates
  (`desktop/gen/android`): `PlayerService.kt` (Media3's library service, its
  ExoPlayer and session), `PlayerBridge.kt` (the page's `__ringtomePlayer`, and
  its events back), `AutoLibrary.kt` (the car's tree), `NodeBoot.kt` and
  `ArtProvider.kt`. A plugin's packaging bought nothing for one app.
- **Every list comes from the page**, mixtapes too: the page hands its lists
  over whenever hrseAmp is open (`player.library`), kept in a file for the car.
  Reading mixtapes from the node's API was one more road to the same lists.
- **The cold start** boots the node from the service, on its own thread, through
  the shell's library (`NodeBoot_boot` in `desktop/src/lib.rs`): the same data
  directory and sign-ins as the window's, whichever comes first. Plays wait for
  it.
- **The car can't read the node's covers.** Auto fetches artwork itself, without
  the sign-in a thumbnail needs, so it showed none. `ArtProvider` serves
  thumbnails - only paths ending `/thumb` - under `content://` addresses that
  only Android Auto is granted, fetched with the sign-in and kept a day.
- **A sideloaded app isn't in the car's list** until Auto's developer settings
  allow unknown sources. Nothing to build; a store install won't need it.
- **A shuffle in the car keeps its place between drives** (Curtis, 2026-10-18).
  The lists are dealt by the page, so with the page asleep a list picked again
  dealt the same shuffle from its first song every drive. `AutoLibrary` now
  keeps the car's place in each list but mixtapes (the song, its index, how far
  in), and a list picked again goes on from there - from its top once played
  out, or once the page has dealt it anew.
- **The page waits for the player to connect** (Curtis, 2026-10-19: play on a
  freshly opened app sometimes did nothing until a new list was started). The
  bridge reaches the player through a controller that connects a moment after
  the page opens, and calls made before then were dropped - among them the
  restore's hand-over of the saved song, so the page held a song the player
  didn't. Now the bridge keeps early calls until it connects, the restore
  decides what the player holds only once the player has said (its state has a
  `count` from then on), and play on an empty player hands the song over again
  instead of toggling nothing.

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
3. **Filters** - built 2026-10-12: the strip over the library, whose tags,
   saving, and the Playlists column with "all".
4. **Twins carry their sound's fields** - built 2026-10-12: publishing states
   them on the twin. No backfill (Curtis: nothing has gone live yet).
5. **Mixtapes** - built 2026-10-12: the taxonomy, "add to mixtape", their order
   in the table.
6. **Radio stations** - built 2026-10-12: the editor, nesting, and the picker.
7. **The unlock**: hrseAmp in the Market after File upload, H$ 5,000, marked
   experimental (ruling 2) - in the first slice that ships to people, really.
8. **The sign** - built 2026-10-12 (section 8): the rights dialog in the
   composer, scheduling and book rollouts.
9. **The fence, publishing** - built 2026-10-12: the operator's setting, and the
   bake refusing a tagged song.
10. **The fence, carrying** - built 2026-10-12: no fetching, keeping or serving
    another node's tagged audio; "not carried on this server" in the post and in
    hrseAmp; the reaper's part. Sync, the body sweeps and the serving doors all
    move, so this one wants its own careful pass.
11. **Loudness levelling** - built 2026-10-12 (section 9): measured at the
    ingest, said on the twin, applied as volume downward only, one switch.
12. **The equalizer** (section 9): Winamp's ten bands and a few presets,
    "background" among them, through Web Audio only while it's on.
13. **Playing on Android** - built and verified on a phone 2026-10-12 (section
    10, _What building it found_): the shade, the lock screen, the background,
    headphones, the cold start and Android Auto, covers included. Planned as a
    priority (ruling 22), last, after a mobile usability pass of the UI, which
    it called for and got the same day. The steps it was built in: the node
    booting off the main thread; the plugin with Media3's session, the native
    player taking the page's queue, the foreground service while it plays, and
    the shade, lock screen and headphones; then Android Auto's tree
    - mixtapes, everything, saved filters - and stations once they exist.

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
  a twin, and a feed row's fields are the ones said on its twin (slice 4).
- **A sound with no cover shows its waveform.** A thumbnail is always there - an
  embedded cover, else the waveform the ingest draws - so the player's thumbnail
  is never empty, though a waveform at 36 pixels reads as a dark square.

### What building slice 3 found

- **The strip counts in the browser.** The whole library is already there, so
  each row is counted over what the other rows' picks leave, as the node counts
  the feed's (`pure/ampfilters.js`), and nothing goes to the node per click.
- **"From" is the via row**, the column's own word, with "me" leading it (ruling
  8). Artist and genre are the folded columns' values, so feed songs join those
  rows as their twins say their fields (slice 4).
- **hrseAmp's dial is its own.** It starts at the feed's stop and is kept in
  `amp_selectivity`, so moving it here doesn't move the feed. A saved filter
  carries its stop and whose tags.
- **Whose tags** needs the door to say which are the author's and the reader's:
  each feed row carries `tags` and `our_tags`. Reactions are tags, so a friend's
  like is one of everyone's tags, as on the feed's strip.
- **No tagging someone else's song yet.** Ruling 6 makes a tag on another
  author's song a public label, but the file panel offers only your private
  fields there, so "author's and mine" differs from everyone's only by other
  people's labels until the panel can tag.
- **Not gated on "Reactions, tags & filters".** The feed's strip is; hrseAmp's
  is part of the app its own unlock buys.

### After using slices 1 to 3 (Curtis, 2026-10-12)

- A filter keeps the header's search words with its picks, and choosing it puts
  them back in the box; "all" clears them. Saved feeds do the same.
- The Tags column draws tags as bubbles, without reactions, which the Score
  column shows instead: each emoji the song has collected, with how many people
  said it (`tag_counts` from the door). The column still sorts by the score.
- Delete sits at the head of the file panel, trash first, for one song or
  several; it deletes only your own. The bulk panel inside hrseAmp has no "move
  all to" (notebooks are another app's business here) and no header of its own.
- The cassette is a compact cassette: corner screws, a label round the window
  with the title on its top line and the artist under the window in Caveat, the
  reels high in the window, and the tapered edge with its holes.

### And after more use (Curtis, 2026-10-12)

- The file panel is a column of the house's kind (`panes.js`), left of the table
  beside Playlists: as wide as it's dragged, tucked to a rail by its head, and a
  tab in a narrow window. Its heading is ruled off, delete sits under it, and
  your like and dislike are its list's "score" row.
- The player keeps its list, its song, where in the song, and the shuffle with
  its order and place, per persona on this computer, so a refresh comes back
  paused where it was and previous walks back over the same songs. hrseAmp
  handing the same songs back keeps the shuffle's order.
- Filters take a year range and a length range ("3:30", or minutes); a song with
  no year is outside any year range.
- "date" is "date added", and it and Score are default columns. A table whose
  columns were already kept on this computer keeps its own choice.

### Probable duplicates (Curtis, 2026-10-12)

The same bytes uploaded twice are one document already, but the same song in
another encoding, or from someone else, is a second one: Curtis found three
copies of one track, all within five seconds of one another. A "probable
duplicates" chip on the strip shows only songs with a probable copy - the same
title once case, punctuation, a track number in front and a file extension are
set aside; the same artist where both say one (a song published before slice 4
says none); and lengths within five seconds - each set of copies together in the
table, so the ones to keep and the ones to delete sit side by side. A second
press leaves the copies out, as a tag's chip does (Curtis, 2026-10-12): one of
each stays - your own copy over someone else's, then one that says its artist,
then the first in the table - so a list or a shuffle plays a song once. A third
shows everything. It's saved with a filter like any pick. Copies are found
across the whole library, so a song whose copy another pick hides still shows.

### Saving into a filter (Curtis, 2026-10-12)

The filter last chosen in Playlists is remembered: once the strip differs from
it, "save to "name"" writes the strip back into it, beside "save as new". The
feed's saved feeds do the same.

### What building slice 4 found

- **Said at the bake.** The publish's bake pass is where a private sound and its
  public twin are both in hand, so that's where the sound's fields (media/
  audio.rs `TAG_FIELDS`) become the author's public labels on the twin
  (`bake.rs` `sound_fields_on_twin`). Every publish restates them, so a
  republish carries an edited field, takes back a cleared one, and a twin reused
  by a later post is brought up to date by it. A sealed post's twin says them
  under its key, as its other labels are.
- **Copies keep their credits.** Someone else's public sound embedded in your
  post is copied into your own twin, and its fields come with it: what its
  author said on theirs, restated on your copy.
- **No backfill** (Curtis, 2026-10-12): nothing has gone live, so twins
  published before this simply say their fields the next time their post is
  published.

### What building slice 5 found

- **A member is the sound itself**: your own private sound, or someone else's
  public twin (`member_root` names whose), so a mixtape holds anyone's songs and
  the same song in many mixtapes is simple.
- **Kept in a mixtape.** The library door reads the reader's mixtapes and keeps
  someone else's song in one even when it no longer arrives in the feed -
  unfollowed, or past the dial - from the node's memo of sound, which remembers
  it from when it did (marked `kept`). No database is opened for it.
- **Opening one** from Playlists clears the strip and the search and shows its
  songs in its order: headers don't sort, the first column is a drag handle, and
  a drop lands where the line shows (the member PUT's index, counted without the
  song). The strip and the search still narrow an open mixtape, keeping its
  order. Choosing a filter or "all" closes it.
- **In the file column**: "add to mixtape…" for one or many, which appends and
  leaves a song already there where it is, and "new mixtape…"; inside an open
  mixtape, "out of" it. Forgetting a mixtape leaves its songs where they are.
- **The strip's "mixtape" row**: a mixtape's name behaves as a tag, three-state
  like the rest, and a saved filter keeps it.

### What building slice 6 found

- **A slice is a saved filter, a mixtape, everything, or another station**, at a
  weight from 0 to 100; the pie and the shares are the weights normalised to
  whole percents. A new station starts as everything at half, so it plays while
  its slices are chosen. Adding a station that would hold itself, directly or
  further down, isn't offered; a loop two devices make anyway is cut where it
  closes.
- **The picker** (`pure/stations.js` `StationRun`): a leaf slice by its chance,
  a nested station's leaves scaled by its share; then the first song in that
  leaf's bag the memory allows - the bag a fresh artist-spreading cycle of the
  leaf's songs (`spreadOrder`), so a slice plays everything before repeating.
  Each slice loops on its own - a short list sooner, a huge one later - and the
  weights are exact: a slice chosen always plays (Curtis, 2026-10-12: the first
  version let the memory hand a turn to another slice, so a short list at a high
  weight lost most of its turns to a huge one). The memory - half the station's
  songs, up to twenty, and up to three artists - only chooses which of the
  chosen slice's songs plays: not one just heard through another slice, not a
  recent artist, where the slice has another; and never the same song twice
  running where it has a second. A short heavy list repeats, audibly - which is
  what its slider asks for.
- **A filter's slice is its picks, whose tags and its words, over the library as
  hrseAmp has it** - at hrseAmp's own curiosity dial, not the one the filter was
  saved with, since the library is fetched at one stop.
- **The player has a station mode.** Next and previous walk the station's
  history; the shuffle button rests, since a station picks its own order; the
  table's changes leave it alone. It survives a refresh as its history: the same
  song comes back, and once hrseAmp has the library, next carries on along the
  history and then picks anew. Until hrseAmp is opened after a refresh, next
  from elsewhere waits for it.
- **The view** replaces the table while a station is open: the pie, a slider per
  slice with its share and its trash, "add a slice…", the play button (lit while
  it's on the air), and what played lately. The station on the air wears a radio
  in Playlists.

### What building slice 11 found

- **Our own meter** (`media/loudness.rs`): BS.1770's K-weighting at 48 kHz, 400
  ms blocks stepping 100 ms, the -70 LUFS and relative gates. It reads a
  full-scale 1 kHz tone at -3.01 LUFS, the standard's own check. The decode lane
  meters the 48 kHz samples it encodes; the passthrough lane decodes its packets
  once with the libopus decoder (contained like the encoder's glue) for the
  measure alone, and both lanes agree on a sound to within half a decibel.
- **Kept as a field**, `loudness` ("-9.4"), as the file's own tags are - no
  migration - written at every new version, since it's a fact of the file. It
  travels to the twin with the other fields: `SOUND_FIELDS`, the tag fields and
  loudness, is what the bake restates and what the library door reads.
- **The target is -14 LUFS**, where the streaming services level. A song louder
  than that is turned down by the difference, as a multiplier on the volume; a
  quieter one, or one never measured, plays as it is.
- **The switch** sits beside the volume, on by default, kept per computer.

### What building slices 8 and 9 found

- **One question, asked two ways** (`rights.rs`): which tagged songs a draft
  carries - the author's own sounds by their fields, someone else's copied in by
  what their author said on theirs; media from the open web has no fields and
  passes. The bake asks it to refuse (the fence); a door,
  `POST /api/identity/{root}/tagged-songs`, answers it for the app (the sign),
  for a list of drafts or a notebook's pages.
- **The fence refuses before anything is baked**, so a refused post leaves no
  public copies of its songs behind, and its words say it's the operator's
  choice. The operator's switch is in the Server app's customization, beside the
  search engines (`audio_policy`, node rung 81).
- **The sign** asks in the house modal (`askYes`, beside `askText` in
  `modal.js`), from the one door every publish in the app goes through - the
  composer, the post page, Writer and scheduling - and once for a book's
  rollout. It names the songs, and where the file will be served from: the
  server's name, or "this computer" in the desktop app. Where the fence is up,
  the app says so instead of asking. Rooms and messages publish no songs, and
  aren't asked.

### What building slice 10 found

- **Not holding is not serving.** Blobs are served by hash to anyone who asks,
  ungated, so the way not to serve a song over the network is not to hold it.
  One rule, everyone's songs alike - this node's own people's published ones
  too: where the fence is up, a tagged song's audio file (a sound twin whose
  author's own label sets artist or album, read from the label memo) is
  - **not fetched**: the body walk after every sync, and the healer working the
    wanted ledger, both pass it by (and forget a want for it);
  - **not kept**: the reaper's mark phase takes it out of the live set, so the
    next round collects the bytes - half-hourly on a server; until then a peer
    already holding the hash could still fetch it from here;
  - **not served over HTTP**, at once: the public body door answers "this song
    isn't carried on this server - its operator's choice".
- **Only the sound goes.** The post and its words, the song's thumbnail, and an
  untagged song all carry as ever. A "tagged" label on something that isn't a
  sound changes nothing. Private files are untouched (ruling 17).
- **Said where it shows**: hrseAmp keeps the row, muted, with "not carried
  here", and never hands it to the player or a station; a post's player says the
  same sentence under itself, from one listener for the page that asks a failed
  `<audio>`'s door why.
- **The fence down** and the song is fetched again behind the next sync.

### How loud and how good: the house bitrate (Curtis, 2026-10-12)

A loved instrumental came out "absolutely flattened" at the ingest's old 48 kbps
stereo Opus - where the encoder narrows the stereo image and thins the top end.
The house rate is now **98 kbps for stereo and 49 for mono** (a voice or a field
recording, nearly always): sevens, for the septagon. 98 is transparent to most
ears on most music; YouTube's everyday Opus runs about 130-160. The 10 MB
document cap squeezes a stereo song past about 14 minutes now (29 before), and
nothing goes below today's floor. Songs already uploaded keep the rate they were
encoded at - lossy can't be unlossed - and an upload that arrives as Opus keeps
its own.

### Curtis's notes after a while with it (2026-10-13)

- **Stop ends listening**; pause is a breath. Stop lets the song go - the bar
  says "nothing playing", a station goes off the air, the compact player goes at
  once - and play starts the table again. The compact player also goes five
  minutes after a pause, and a song a refresh brought back waits in hrseAmp
  until it's played, rather than sitting over every app.
- **The now-playing column**, beside Playlists: what's playing from at its head
  (everything, the table narrowed, a filter, a mixtape, a station, or a file
  played from hrseFiles), then up to five songs that played, the one playing,
  and up to five to come - a station's each with the slice that picked it. A
  song pressed shows its file; double-clicked, it plays.
- **Where a song came from**: the bar says it beside the artist - a station's
  slice (a nested station's as "station › slice"), else what the list is - and
  "lately on the air" says it beside each song. A station's slices are kept with
  its history across a refresh.
- **Thumbs up and down** on the song playing, in the bar and the now-playing
  column: your own, private, the same register as your score on your own sounds
  (ruling 3). A thumbs-up song comes round twice a cycle of the shuffle (or of
  its station slice); a thumbs-down one sits out every second cycle. A list of
  nothing but thumbs-down still plays.
- **The cover pressed** brings out the file column with the song playing
  selected - from the compact player too, which opens hrseAmp first. A
  **right-click** on a song, or on one of several selected, brings out the file
  column too.
- **On a phone** the bar leaves out levelling and the thumbs, for room; the
  cassette's page carries the thumbs at its foot, and the now-playing tab has
  them too.
- **Mute** is the speaker beside the volume; the volume stays where it was.
- **Keys**, while hrseAmp is open only (elsewhere other tools want them): space
  plays and pauses, the arrows go back and on a song. Not while typing, nor
  under a modal.
- **The pie says how many songs** each slice holds, beside its name and under
  the pointer on the pie; a station's slice counts every song under it once.
- **While the cassette fills the page** the frame's header (hrseAmp's name, the
  search) goes. **A long title** is written smaller to fit the label, cut only
  past the smallest size. **Four cassettes**: the house's, a dark one, a teal
  one and a pink one, each song always on the same one.
- **Each cassette its own extras** (pure/cassette.js), chosen by chance seeded
  by the song's key, so a song always comes on the same one: an "A" or "B" side
  in a square beside the window; the tape's length (C-46, C-60, C-90, 60, 90)
  printed opposite it; "HORSE STEREO" on a wider band; a block of colour down
  the label's left or right edge or across its top; diagonal stripes growing
  wider at the band's end; the title and artist written classic (title on top,
  artist at the foot), centred, stacked on the top lines, or from the left; and
  one line to write on, several faint ones, or none; and the hand it's written
  in
  - Caveat, Audiowide, Major Mono Display, Atkinson Hyperlegible, Special Elite,
    Bungee, Orbitron or Bitcount, all loaded anyway. Each hand has its own sizes
    and room on the line, from its letters' measured width (Caveat's narrow,
    Major Mono's twice as wide), and a line still too long once drawn is
    squeezed to fit. All in the colourway's colours, as the cassettes are.
- **The cassette bounces to the music** (Curtis: "if it's terrible we can take
  it out"). Not a live analyser on the playing audio - that would put the player
  through Web Audio, which it keeps out of so a locked screen can't stop the
  music, and on Android the sound is the phone player's, out of the page's
  hearing. The song is read a second time instead, while the cassette shows:
  decoded at 8 kHz, low-passed at 150 Hz so the kick drum leads, and boiled down
  to how hard it kicks each 50 ms - its loudness above the last second's
  (`pure/bounce.js`). Each frame looks up where the song is (`now()`, counted on
  from the phone player's last word on Android) and lifts and squashes the
  cassette a little, settling between kicks. The last dozen songs' kicks are
  kept; nothing over 15 minutes is read; a song the browser can't decode, or
  anyone asking their computer for less motion, gets a still cassette.
- **A sound in hrseFiles** plays in the player the whole app shares (with
  hrseAmp unlocked): play and pause, the scrub, and "open hrseAmp" beside them.
  Going into hrseAmp then carries on through its table, as any list playing does
  when the table changes under it.
- Not yet: remote-controlling the players on your other devices (NEXT_STEPS,
  _Mixtape & Radio_); animated GIFs while the music plays (a loose idea, set
  aside).

## Questions for Curtis

None open (2026-10-12). Answered the same day: the fence is about public chains
only - a person's private uploads are their own business, tagged or not - and
the sign's words in section 8 stand.
