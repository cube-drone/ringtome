# Web addresses - a post's place on the public web

A design draft (2026-10-11), with rulings. Slices 1, 2 and 3 built the same day.

## The ask (Curtis, 2026-10-11)

"In our private system, the way we handle URLs is fine, defensible, and all
links are portable. Outside of our private system, links _containing the
/ringtome url_ always point to a specific unit of content, which exists
somewhere on the ringtome-i-verse. But - this means that most posts on websites
look like:
`https://horsedrawingtycoon.com/ringtome/user/HVnmWLq8YSnyiUCupmHM6wP91yrwC6PpcynabWGVHRkL/post/a04aa229cb2c27344a0eaac31ebc2b2c` -
now, on horsedrawingtycoon.com, I've claimed the name "@cube-drone" - and that
name claiming system is doing me little good here, because the ringtome url's
identity takes precedence here, which makes it easier to find me IN the network,
but a lot harder to find this content on the public web. On top of that,
`post/a04aa229cb2c27344a0eaac31ebc2b2c` is not helping terribly much with
discovery."

What he imagines: "a single public per-user taxonomy object ... a whole
top-level-user taxonomy which lays out how the URL structure looks for this
user's public URL surface. This is automatically generated, based off of post
titles and buckets - combined with the top-level name claim, a post might live
at `horsedrawingtycoon.com/@cube-drone/cybergamer-canada--ad-viewmagic` - when
you hit that post, it automatically uses that link in the URL. It prefers this
strategy if-and-only-if the site has a FQDN (and maybe only if the user bothers
to claim a @name on this node): declaring 'this object has a permanent web
location' - we could even look up that object's internal ringtome notation FROM
that website if it's up and running."

## Rulings (Curtis, 2026-10-11)

1. **Notebooks are folders.** A post in a notebook of its own lives under it,
   `/@cube-drone/recipes/sourdough-loaf`; one in the feed, at the top level. A
   notebook whose name is a reserved word (section 4) gives no folder.
2. **A path changes only by hand.** Retitling doesn't move it, and with ruling 1
   in mind (Claude's reading), neither does moving the post to another notebook:
   the folder is the one it was published from. A renamed path's old form
   redirects.
3. **Untitled posts get the date and a few of their words**:
   `2026-10-11-today-i-drew-a-horse`, under their notebook's folder if they have
   one. Amended the same day from "the date and a counter": a counter is chosen
   by whichever computer publishes, so two computers publishing on the same day
   would both pick `2026-10-11-3` (Curtis: "VERY likely to accumulate clashes
   across disparate services"). Everything after the date comes from the post
   itself, so every computer arrives at the same path:
   - up to five words, or about 40 characters, of the plain words, with markup,
     links and embeds removed;
   - with no words at all (a picture or a sound alone), the first six characters
     of the post's id: `2026-10-11-a04aa2`.

4. **A book's sections are folders**: `/@cube-drone/grimoire/potions/<page>`.
   The book itself is its notebook's folder (_Books_, ruling 2: "the notebook is
   the book"), so `/@cube-drone/grimoire` is the book's title page, and a page
   lives under it like any other post under its folder. Like any path, moving a
   page between sections doesn't move it (ruling 2).
5. **A plain notebook's folder is the person's page, filtered to it**:
   `/@cube-drone/blog` shows the page with the "blog" chip picked, the same view
   as `?bucket=blog` (the picks in the address, 2026-10-11). The folder stays in
   the address bar rather than becoming the `?bucket=` form, since it's the
   better link. Curtis: "we just built a feed browser that lets us pass in the
   bucket as an argument, right? it could just do that".

A page and a post wanting one path (a note in a book's notebook posted on its
own before the notebook became a book; once it is one, its notes have no publish
of their own, _Books_ ruling 6) is the ordinary clash: whichever had the path
first keeps it, and the other takes the id suffix.

Ruled from Claude's recommendations ("Sounds good, let's get buildin'"):

4. **Paths are labels on each post** (2b), and a persona's whole address list is
   derived from them. It's what keeps peeks working (section 2).
5. **The long `post/<hex>` form doesn't redirect.** The page answers at both,
   and the path form wins through `<link rel="canonical">`, `og:url` and the app
   rewriting the address bar. `post/<hex>` is the address that never moves, and
   a redirect would make it depend on the node's path index being current, which
   a stale peek isn't. Search engines treat canonical like a redirect for
   choosing which address to show.

## What's already here

- **Node slugs** (PROJECT_PLAN, _The node's public face_, rulings 6-7;
  `slugs.rs`): `@cube-drone` is a node fact, first come first served, meaning
  nothing on any other node. `node.tld/@cube-drone` is the persona's page. A
  persona holds a current name and its last, which redirects.
- **Slugs, settled and never built** (PROJECT_PLAN, _Slugs, Views, and the
  Personal Address Bar_, 2026-07-09): "an author-owned mutable namespace over
  immutable content. A public LWW register maps slug → doc_id ... inbound links
  survive reorganization without redirects." Author-scoped, so nothing to squat.
  A slug may later point at a taxonomy (a series), with views (`/latest`,
  `/index`).
- **The post page's head** (idface.rs `post_page`): title, OpenGraph and
  description for a hosted persona's open post, with `og:url` the long
  `/ringtome/user/<short>/post/<hex>` form. The page's words are drawn by the
  app, not the server (the residual under _The node's public face_: full
  pre-rendering "stays possible if crawlers ever need the words").
- **Public labels on a post**: publishing restates the draft's tags and
  notebooks on the post, in public, as the author's own annotations. A post
  already carries public facts beside its words.

So most of the pieces exist. What's missing is the path itself: a readable name
for each public post, owned by its author, and a node that answers it under the
@name.

## The proposal

### 1. Two halves: the node's @name, the author's path

`https://horsedrawingtycoon.com/@cube-drone/cybergamer-canada--ad-viewmagic`
splits into two halves with different owners, and the split decides most of what
follows:

- **`@cube-drone`** is the node's: its name for this persona, valid on this node
  only (ruling 6 stands).
- **`cybergamer-canada--ad-viewmagic`** is the author's: the post's path, a
  public fact of the post that travels with it. Any node holding the persona can
  answer it as `/id/<root>/cybergamer-canada--ad-viewmagic` (the 2026-07-09 slug
  design, built at last), and a node that has given the persona an @name answers
  it under that name too.

The pretty URL is therefore only as permanent as the node and the @name (Curtis:
"once a website goes up the operator will probably try and keep it up"). The
path half survives a move to another node under the persona's real address.

### 2. Where the paths live (proposal: on the posts, indexed per persona)

Curtis pictures one per-persona object holding the whole surface. Two ways to
get that:

- **(a) One per-persona register**, path → post, on the public chain. A single
  object to read, and a path can later point at a taxonomy (a series) as
  2026-07-09 wanted. But it's a new public collection (a protocol addition), and
  the author's node must keep it in step with every publish, retitle and
  takedown.
- **(b) A public `path` label on each post** (recommended), alongside the tags
  and notebooks publishing already restates. Each node that holds the persona
  folds those labels into a per-persona index (a memo, like the shelf), and that
  index is the "taxonomy object": it gives the whole surface in one read,
  derived rather than stored. Nothing new on the wire, a takedown removes its
  path with it, and two computers publishing at once merge as labels do.

**(b) keeps peeks working** (Curtis, 2026-10-11: "Does /id/<userId>/<path> break
our ability to peek at content?"). A peek holds the author's whole public
annotations chain: it's one of the four chains a peek exchanges (net/sync.rs
`PEEK_SCOPE`: identity, profile, follows, annotations), and the labels
publishing restates live there. So a node that only peeks at the author reads
`path -> post` from what it already holds, then fetches the post by id over the
fragment route as it already does for any post a peek never held (PROJECT_PLAN,
_Peeks_, ruling 4). That covers every post with a path, not just the newest
twenty a peek carries, and a followed persona past the follow ceiling resolves
old paths the same way. (a) would be a new chain that peeks don't carry, and
would have to join `PEEK_SCOPE`. The one gap is a post published since the last
look: an id link skips this by going straight to the fragment route, but a path
has to be looked up first. So a path the peek doesn't know refreshes the
annotations once before answering "not found".

(b) can grow into (a) later: a path that points at a series is a register entry
added beside the labels, not a replacement for them.

### 3. How a path is made

At first publish, from the title:

- **Slugified**: lowercase, letters and digits kept in any script, a run of
  anything else becomes one hyphen. A colon, dash or other separator between
  words becomes `--`, so "CyberGamer Canada: Ad ViewMagic" becomes
  `cybergamer-canada--ad-viewmagic`. The grammar matches node slugs', without
  the length floor.
- **Unique within the persona**: a clash takes the first six characters of the
  post's id, `sourdough-loaf-a04aa2`, never a counter. The id is random and
  already the post's, so two computers can't both claim one path; the worst case
  is two distinct paths.
- **An untitled post** (most micro posts) gets the date and its first few words,
  or the date and its id's first six characters if it has no words (ruling 3).
- **Notebooks are folders** (ruling 1): a post in a notebook of its own lives
  under it, `/@cube-drone/recipes/sourdough-loaf`, and one in the feed at the
  top level. The folder's name is the notebook's, slugified the same way.
- **Replies, rooms and media twins** get no path. Their own addresses are fine,
  and they aren't what a reader arrives at from the web. A book's pages already
  have the book's address.

**Stable once given.** Editing a post's title doesn't move its path: links on
the web already point there, and neither does moving the post to another
notebook (ruling 2). The author renames a path by hand, in the publish panel.
The old path stays on the post as a former path and redirects, so nobody else
(no other post of theirs) can take it, exactly like an @name's "last".

### 4. When the path is used: always, and the @name when there is one

The first draft gated the pretty form on the node having a public URL and the
persona an @name. Curtis, 2026-10-11: "since the document taxonomy lives within
the ID, this may not be necessary?" Right: the path is the persona's, so it
works on every node, under the persona's real address, with no @name and no
public URL:

- `/ringtome/user/<short>/cybergamer-canada--ad-viewmagic` on any node that
  holds the persona. The identity half is still long, but the post's half reads.
- `/@cube-drone/cybergamer-canada--ad-viewmagic` on a node where the persona has
  claimed that name. The @name only shortens the identity half, and only there.

So the gate moves. Every post with a path uses it, and its **canonical address**
is the shortest form the node can vouch for: the @name form where the persona
has one here, otherwise the identity form. The public URL decides only whether
that address is written out absolute (`https://horsedrawingtycoon.com/...` in
`og:url` and copied links) or left relative to the site it's read on. Either
way:

- the post page answers at it, and at the long `post/<hex>` form, which doesn't
  redirect (ruling 5);
- `og:url` and `<link rel="canonical">` name it;
- the app, landing on the post page by any form, writes it into the address bar
  (`history.replaceState`);
- "copy link" and share buttons hand it out.

**In signed words, the identity form with a path is fine; the @name form
isn't.** `/ringtome/user/<root>/<path>` names no origin, so a document may carry
it, and it stays live as the author renames: an old path redirects, the
2026-07-09 "maximally live" slug link. `/@name/...` is one node's fact, so the
paste rewrite (below) turns it into the identity form. A reference that must
never move still uses `post/<hex>`.

**Paths share the segment space after `<short>/`** with the routes already there
(`post`, `doc`, `room`, `book`, `docs`...). Those words are reserved: a title
slugified to one of them takes the id suffix, and a notebook named one never
becomes a folder (ruling 1).

### 5. From the pretty URL back to the post

"We could even look up that object's internal ringtome notation FROM that
website." Every pretty page says what it is:

- **In its head**:
  `<link rel="alternate" href="/ringtome/user/<root>/post/<doc>">` and a
  `ringtome:post` meta carrying `<root>/<doc>`, so an unfurler or another node
  reads the identity off the page itself.
- **At a door**: `GET /api/node/at/@cube-drone/<path>` answers
  `{ root, doc_id, canonical }`.
- **At paste time**: the composer's paste rewrite already strips an origin off
  an identity path, and a path form needs nothing more. A pasted @name URL is
  resolved through that door and stored in the identity form, so the signed
  words name the persona, not the website. The rule for names holds (_Naming_):
  a pretty URL only answers "which post?", and the post is then verified against
  its root like any other.

### 6. What it doesn't fix by itself

The post page's words are drawn by the app. A crawler that runs no JavaScript
reads the head (title, description, picture) and nothing more. Readable URLs
help people and unfurlers right away. Helping search engines find the words
needs the server to put them in the page (`<noscript>` or a pre-rendered body).
That residual already exists under _The node's public face_, and it's the
natural next slice after this.

## Slices

1. **Paths** - _built 2026-10-11._ `webpath.rs` makes a path at first publish
   (`identity/routes.rs` `post_path`, from `after_posted`, so a book's pages get
   theirs on rollout too) and keeps it on every republish. A book gets its
   notebook's folder (`books.rs`). Uniqueness is checked against the author's
   own store (`imaol::path_holders`), so two quick publishes can't miss each
   other the way they could through the node-wide table. No slugifier in JS
   after all: paths are only made on the node, and the client only reads them.
   The node-wide label table already indexes by value, so it serves as the index
   (`annotations::post_at_path`, `path_of`) with no new memo. Resolved at
   `GET /api/id/<seg>/at/<path>`; the page head at `/ringtome/user/<seg>/<path>`
   with `<link rel="canonical">` and `ringtome:post`. On the client,
   `pathpage.js` catches a path under a person and shows the post page,
   `PostPage` swaps an id address for the path in the address bar,
   `parseRingtome` reads a `path` kind (so a pasted path rehomes, and a link
   card resolves it), and the person page stays alive under a path as under a
   post. The card hides the `path` label.

2. **The canonical address** - _built 2026-10-11._ The node answers
   `/@name/<path>` (`nodeface::slug_path_page`) with the post's head, and sends
   an old name on to the current one with the path kept. The head's canonical
   address and `og:url` take the @name form where the persona has one. The
   client routes `/@name/<path>` through `SlugPage`. The address bar takes the
   shortest form, from the id form or the identity path form, once the author's
   profile says their @name. Folder pages (ruling 7): `/api/id/<seg>/at` answers
   a one-segment folder with the notebook a post under it was filed from
   (`annotations::folder_notebook`), and the person page narrows to it
   (`usePicks`'s `base`). The address carries only the picks beyond the folder,
   and unpicking the notebook goes to the person's page. "copy link" hands out
   the shortest form; a card learns the author's @name ahead of the press
   (`GET /api/node/slug-of/<root>`, `links.js` `useSlugOf`). The book's payload
   names each page's path, the reader's links carry it, and turning a page
   (still by id, so the reader doesn't remount) puts the page's path in the
   address bar.
3. **The way back** - _built 2026-10-11_ (Curtis: "I want people to be able to
   pull links from horsedrawingtycoon and comment on them from their own apps").
   Built at render time rather than paste time: the words stay as the author
   wrote them, and the link becomes in-app when it's shown.
   - The website's node answers `GET /api/node/at/<name>[/<path>]` with the
     persona, the post or folder, and its own key (`nodeface::at_name`).
   - The reader's node answers `GET /api/web-address?url=`
     (`webpath::web_address`): its own addresses here, another node's asked
     through the unfurler's guarded fetch and kept an hour. It's gated as the
     unfurler is.
   - In the app, a link to another node's `/@name/...` is asked about on hover
     or focus, and opens here
     (`/ringtome/user/<them>/post/<id>?via=<their node>`). A plain click before
     the answer waits for it, and follows the link as written if there's none.
   - A pasted one becomes our card for the post (`turbolinks.js` `atPlugin`),
     falling back to the web's card.
   - The People app's paste box opens a post's address, `/ringtome/` or another
     node's `@name`, where it had taken only people.
4. **Renaming and retiring**: a path editor in the publish panel, former paths
   redirecting, a takedown releasing them.
5. _(Later, separate)_ the words in the HTML for crawlers.
