# Crawling - the public site, readable by search engines

A design draft (2026-10-11), with rulings. Slices 1-3 built the same day.

## The ask (Curtis, 2026-10-11)

"How do we make this whole (public) site comfortably crawlable by search
engines?" It follows the web addresses arc (`WEB_ADDRESSES.md`), which gave
every public post a readable path and a canonical address.

## Rulings (Curtis, 2026-10-11)

1. **The reading copy is hidden from people while the app loads, by script.**
   Curtis first asked about mounting the content 5000px below "Loading…". That
   sits close to the off-screen text search engines name as hidden-text spam,
   gives the page a scrollbar while it loads, and gets read aloud by screen
   readers. Instead, a line in the head marks `<html class="js">` before
   anything draws, and the CSS hides the copy and shows "Loading…" only then.
   Browsers see what they see today; crawlers and readers without JavaScript see
   the copy. It's the same content the app then shows.
2. **Indexed by default, with two opt-outs.** A person opts out in application
   settings; an operator opts the whole node out in the server's settings.
   Neither is shown unless the node has a public URL. The person's switch is
   stored on the persona, not the browser, because the node answers crawlers
   with no browser involved. Opted out means `noindex` on their pages and
   nothing of theirs in the sitemap.
3. **A persona switched off the node's front page is not indexed either.** The
   switch exists on the node (`/api/identity/<root>/listed`, honoured by the
   front page and the people page) but nothing in the app sets it, so this arc
   adds it to settings, beside the search-engine one.
4. **A node-wide feed, yes.** Google takes RSS and Atom as sitemaps for what's
   new, and a feed reader can follow the whole site. Feeds stay the recent
   window: a person's is the newest 50 posts (rss.rs), and the whole archive is
   the sitemap's job. Asked whether very large feeds are a problem: they are -
   every reader re-fetches the whole file each time it polls, many cut long ones
   off, and search engines don't read a whole archive from a feed. Paged feed
   archives (RFC 5005) exist but few readers follow them.

## What a crawler sees today

- **A head, for some pages.** A hosted persona's page and each of their open
  posts get a head written by the server (idface.rs `persona_page`,
  `post_page`): title, description, picture, OpenGraph, `og:url` and
  `<link rel="canonical">`, and on a person's page an RSS link to `…/rss.xml`.
  Everything else gets the shell's bare head.
- **No body.** Every page's body is `<div id="app">` holding "Loading…". The
  words, the lists of posts and the links between pages exist only once the
  JavaScript runs. Google renders JavaScript, slowly and on its own schedule;
  Bing does sometimes; most others, and every link-preview bot, don't.
- **Nothing to find pages by.** No `robots.txt`, no sitemap, and no plain
  `<a href>` from a person to their posts, or from the front page to its people.
- **Some wrong answers.**
  - A path naming nothing falls back to the person's page with a 200: a "soft
    404", which search engines count against a site.
  - A taken-down post answers like any missing one, where a 410 says "gone,
    don't come back".
  - An old @name redirects with a 307 (temporary), where a 308 tells a search
    engine to move its index to the new name.
- **No language.** `<html>` has no `lang`.

Already right: a persona this node doesn't host answers 404, so a node never
offers search engines its copy of someone else's posts, and sealed posts never
have a public head.

What helps: the Rust Marquee renderer is already in the build
(`marquee_html_renderer`, used by the ePub export), so the server can render a
post's words as HTML itself.

## The proposal

### 1. A reading copy in every public page's body

The server writes the page's content as plain, semantic HTML inside
`<div id="app">`, and the app replaces it when it mounts - the same words the
app would show, just ready before any JavaScript runs:

- **A post**: `<article>` with the title as `<h1>`, the author as a link to
  their page, the date as `<time datetime>`, the words rendered from Marquee
  (pictures as `<img alt>` at their public addresses), its tags, and links to
  the notebook folder it's in. A book's page also lists its book's contents.
- **A person**: their name, bio and picture, then their posts newest first, each
  a link with its title and date, a page at a time, with `rel="next"` to the
  next page (the existing keyset cursor).
- **A folder** (`/@name/recipes`): the same list, narrowed to the notebook.
- **A book**: its title page and table of contents, every page a link.
- **The front page** (`/feed`) and **the people page**: the node's recent posts
  and its listed people, as links.

Nothing new is said: only what the page already shows a stranger, read from the
same memos the anonymous doors read.

### 2. Being found: `robots.txt` and a sitemap

- **`/robots.txt`** allows the public pages, disallows `/api/` and the app's own
  routes (`/ringtome/` apps, settings), and names the sitemap.
- **`/sitemap.xml`**: every indexable post, book and person on the node, each
  with its canonical address and `<lastmod>`. Over 50,000 entries it becomes a
  sitemap index with one file per persona. Only on a node with a public URL,
  since a sitemap's addresses must be absolute and must belong to the site.

### 3. Right answers

- 404 for an address that names nothing, including a path under a person.
- 410 for a taken-down post.
- 308 for an old @name, so the index moves with the name.
- `<html lang>` from the persona's language when one is set, else the node's.
- JSON-LD in the head, `SocialMediaPosting` for a post and `ProfilePage` for a
  person, which search engines read for titles, authors and dates.

### 4. Who is indexed

Only what this node is the home of: hosted personas' open posts, never a
followed or peeked persona's copy (already 404). Beyond that, a person indexed
unless they or the node opt out, or they're off the front page (rulings 2 and
3).

## As built (2026-10-11)

Curtis: "I'd do slices 1-3 now, just crack through the whole thing".

- **Right answers.** `idface::deep_page` answers every address under a person,
  under `/ringtome/user/` or `/@name/`:
  - the post it names, with its own head;
  - a notebook folder;
  - the person's page for their own routes (documents, rooms, history);
  - 410 for a post taken down (`documents::was_retracted`);
  - 404 for anything else (a sealed post stays 200: its page is for its trusted
    readers).

  An old @name redirects with a 308. A post's head carries `SocialMediaPosting`
  JSON-LD and a person's `ProfilePage`, and every person's page names its
  canonical address. Not done: `<html lang>`. The node doesn't know what
  language its people write in (only the interface's), and claiming English for
  every page would be wrong more often than leaving it out, since search engines
  read the language from the words themselves.

- **Reading copies** (`reading.rs`), rendered with the Rust Marquee renderer:
  - a post: title, author, date, words, the author's own tags (not the automatic
    size and medium), and a page's book or a book's contents;
  - a person: their posts as links, 30 at a time, with `rel="next"` and
    `?before=`;
  - a folder: the same, narrowed to it;
  - the front page (`/feed`) and the people page: as links.

  The template puts the copy in `$BODY$` inside `#app`. A line in the head marks
  `html.js`, and CSS hides the copy (and, without scripts, the app's empty
  shell, which otherwise pushed the copy below the fold). The app also removes
  the copy before it draws, so the rendered page holds the words once.

- **Being found** (`crawl.rs`):
  - `/robots.txt`;
  - `/sitemap.xml`, an index of `/sitemap/node.xml` and one
    `/sitemap/<person>.xml` each (their page and every post with a page of its
    own, at its canonical address, with `lastmod`);
  - `/feed.xml`, the node-wide feed - from the node's shelf memo alone, never an
    author's database per item, so an item is a title, author, date and address
    (an untitled post reads "A post by …").

  Who is indexed is `crawl::indexable`: a public URL, the node not opted out
  (`search_policy`, node migration 0079, the Server app's switch), the person
  not opted out (the profile field `search = no`, application settings' new "On
  the public web" section), and the person listed on the front page (the same
  section, which sets the existing `node_listing` at last). Anything else gets
  `noindex` and is left out of the sitemap. Every canonical address comes from
  one place (`webpath::post_address`, `person_address`), RSS links included.

## Slices

1. **Right answers**: the 404s, 410 and 308, `lang`, and JSON-LD. Small, and it
   stops the site being marked down for soft 404s.
2. **Reading copies**: posts and books first (the pages search engines land on),
   then persons and folders with their paged lists, then the front page and
   people page.
3. **Being found**: `robots.txt`, the sitemap, the node-wide feed (ruling 4),
   and the choices of who is indexed (rulings 2 and 3): the two opt-outs and the
   front-page listing switch in settings, shown only with a public URL, as
   `noindex` and sitemap membership.
4. _(Later)_ checking it all with a crawler's eye: a fetch with no JavaScript,
   Google's Rich Results test, and Search Console on the real site.
