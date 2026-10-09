# ePubs

A notebook, or a public book, as one `.epub` a reader can carry off to an
e-reader. Built 2026-10-09 (`node/src/epub.rs`).

## The ask (Curtis, 2026-10-09)

> an ePub is just a bunch of HTML files zipped together, more or less, right? So
> it would be pretty trivial to take a notepad and, in taxonomy order, compile
> it into an ePub and download it (maybe as an option in Taxonomy). Public books
> could be downloaded as ePubs as well. We could keep the compiled ePubs around
> as a cached file for a while, maybe with a hash of all of the contained
> members' versions so that it doesn't get stale...

## What it took

Three things made it more than trivial, each settled before it was built:

1. **XHTML, not HTML.** An ePub's pages must be well-formed XML. Curtis added an
   XHTML output mode to Marquee (0.9.3, `Output::Xhtml`), and the node renders
   every page through it - the first server-side Marquee rendering the node
   does.
2. **Everything inside the book.** A reader is offline, so a page's pictures are
   files in the book, and a link from one page to another leads to that page's
   chapter - Marquee 0.9.3's `Profile::link_target`, asked for for this
   (plans/MARQUEE.md).
3. **Drawings painted.** A drawing is strokes, and only a browser painted them
   - until the node learned to (`drawing_paint.rs`, plans/DRAWING.md).

## The book

- **In this order**: `mimetype` (first, stored), `META-INF/container.xml`, the
  package `OEBPS/content.opf`, `nav.xhtml` (the contents), a title page, a page
  per chapter, `style.css` (Marquee's own, and pictures fitted to the page), the
  pictures. EPUB 3; no NCX.
- **A notebook**: its `wiki:<bucket>` tree in order - a section a section, a
  page a chapter - then the notebook's pages the tree doesn't place. Every page
  the owner keeps, hidden from the published book or not: this copy is theirs. A
  drawing in it is a page of its picture; so is a picture document.
- **A public book**: its cover, its own pages, then its sections, as the book's
  JSON orders them, every page read as its reader may read it. A page taken down
  is left out. A book or a page **sealed for trusted readers** is theirs
  (2026-10-09): opened with the key of a persona on their session the seal
  admits - the book reader's own door (`trusted_viewer`, `key_for`) - its
  pictures with its page's key; for anyone else a sealed page is left out and a
  sealed book refused whole.

## The cover

The first picture on the title page - the book's first page, a public book's own
cover page - when it has one (Curtis, 2026-10-09): `cover.xhtml` first in the
reading order, the picture marked `cover-image` in the package and named by the
`<meta name="cover">` older readers look for. A book whose first page has no
picture has no cover, and opens on its title page.

## The ePub's own rules (the renderer profile, ours - not upstream)

- **Pictures** are JPEG, or PNG where any of them is see-through, no larger than
  1600 on a side - ePub readers take neither AVIF nor WebM
  (`media::image::book_picture`). A drawing embedded in a page is painted.
- **No sound or video**: the renderer's quiet placeholder.
- **Turbolinks** are their plain link; **emoji** their character.
- **A link** to a page of the book goes to its chapter; to the web or mail,
  where it went; to anything else in the app, which a reader can't follow
  offline, nowhere - its words stay, the link goes.

## The cache

`<data>/epubs/<hash>.epub`, the hash over the format's version (bumped when what
a book holds changes), the book's shape, and the version of every document
read - each page and each picture. The same book is the same file; an edit
anywhere in it is a new hash. A file nobody has asked for in 30 days goes, and
the folder is held to 512 MiB, the least recently asked for first. At most two
books are made at once on a node.

A sealed book's file is a readable copy of sealed words on the node's disk -
which already holds the keys that open them, so it gives nobody new a way in.
Who is asking is checked before the cache is consulted, so a cached copy is
never handed to someone the seal doesn't admit, and "sealed" is part of the
hash, so a sealed book's file is never one an open request could find.

## Made in the background

A large book takes a while (Curtis: "very large ePubs ahoy"), longer than a
proxy waits for one request. The first ask that finds no cached file starts the
making and answers `202` with how far it has got - a step per picture and per
page - and every ask after it, until it is done, is answered from that, before
the book is gathered again. Done, the next ask downloads it. A build is known by
its notebook, or by its book and the account asking (or "anyone"): a trusted
reader's copy may hold pages a stranger's doesn't, and a poll only ever reaches
a build its own asker began. The button and the chip ask every second and a
half, and show the bar (or, on a chip, the percentage) meanwhile.

## Who may have one

- A notebook - `GET /api/identity/{root}/buckets/{bucket}/epub` - its persona's
  own signed-in account. The **ePub** button in the notebook's tree toolbar.
- A public book - `GET /ringtome/user/{seg}/post/{book}/epub` - anyone, from any
  node that holds its author: the one hosting them, or one that follows them (as
  the book's own pages are served, `idface::public_doc_bytes`). The **ePub**
  button on its own line under the book's title in the reader, and an **ePub**
  chip on a book's card in the feed, beside its link.

The page saves it as it saves any file (net.js `saveFile`): a download in a
browser, a save dialog in the desktop app.

## Not yet

- A cover image; the book's language (every book says `en`).
- Video as its poster frame, rather than the placeholder.
- An `epubcheck` run in CI: the acceptance checks the zip's order, every page's
  well-formedness and what lands where, not the whole EPUB specification.
