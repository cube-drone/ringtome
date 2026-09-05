# BOOKS - publishing a whole notebook

Curtis's brief (2026-09-03): "publish a whole book or knowledge base in one go" - a notebook
whose taxonomy holds dozens of documents, some private, the tree changing over time. What
reaches feeds is not thirty-eight posts but one glob: the book, and later "GRIMOIRE updated:
chapter 4 page 3, chapter 4 page 4 …". The plan already framed it (PROJECT_PLAN, the kernel
layering): "roll out a whole-book update is just re-publishing a composed taxonomy as a new
public version"; and taxonomy-of-posts publication was "its own design, deliberately
deferred". This is that design.

## Rulings (Curtis, 2026-09-03)

1. **A book is a Writer column, not an app.** The Wikibook app died because its editing and
   browsing surface was Writer's; a book's difference is its publication flow, which is one
   column - "Publish", beside tags, items, and tree - holding a switch, a ledger, hidden
   marks, and one button. The reader's side (a table of contents, page navigation) is a
   public page, which no app owns. If a Book app ever earns a tile it will be because the
   reader-side surface grew a private face.
2. **The notebook is the book.** A bucket-level switch, "publish as a book", changes what the
   whole bucket's publication means. The book is minted once, with a stable public id the
   bucket's private meta remembers (`published_as_book`, the `published_as` pattern); every
   rollout after the first is a new VERSION of that document, never a new book.
3. **Hidden never publishes.** A section or a single document can be marked hidden - a
   private fact beside the taxonomy, never on the document - and no rollout carries it. A
   document that becomes hidden after it was published is retracted at the next rollout.
4. **Pages get no feed items of their own.** A page is a real public post (a permalink, a
   turbolink, a rebroadcast of its own) carrying one new signed header fact, `part_of`
   (the book's id). The fold skips journaling a part as a standalone feed row, the way it
   skips a trusted-only row the reader cannot open - a rule of the fold, not a courtesy of
   the client. The book launches as one glob: the book post, and the pages behind it.
5. **What reaches feeds is the book and its updates.** One post per rollout, threaded under
   the book like a reply under its parent: the first says "GRIMOIRE published" with every
   page; later ones say "GRIMOIRE updated" with the pages that changed, as refs - the header
   cap of fifty is why the update lists changes rather than the whole book, and why the
   book's own body carries the full table of contents instead of refs. A reorder with no
   page changes is a book version and a quiet update the author can suppress.
6. **Once a book is published, per-document status goes away** (UI-side). Inside a book
   bucket the editor's publish bar becomes a book bar - "part of GRIMOIRE, changed since the
   last rollout" - and Writer's rows wear "changed / new / hidden" marks instead of the
   detective, globe, and clock. What the column tracks is the DIFF against the last rollout:
   new pages, changed pages, removed pages, moved pages; "publish changes" rolls it out.
7. **A page under a living book is updatable while the book lives.** The 24-hour edit window
   stays for ordinary posts; a book is edited for years. Why that is safe (Curtis): a post's
   edits and deletions have to be checked for and propagated continuously across its
   lifespan - the window bounds that work - whereas a book's update is a DISTINCT NEW EVENT
   ("this book has been updated, the following pages changed …"), so readers learn of
   changes the way they learn of anything else: a new post arrives. The dossier keeps every
   version's history exactly as it does today.
8. **A rollout is a plan, executed in the background.** Dozens of bakes are not one HTTP
   request with a modal: "publish" writes the plan on the bucket's private meta (the
   scheduled-publish shape - device-durable, naming the minting leaf), the sweep mints
   pages, the book version, and the update post in order, and the column shows progress
   and the outcome. A failed page stops the rollout with its reason; nothing half-lands on
   the feed, because the update post is minted last.
9. **The book has no generated body; it carries the tree.** The book document's payload is
   the published composed taxonomy itself - sections, order, page references - and the
   reader gets a BROWSER over it: a navigable tree to page through the whole thing,
   essentially Writer in read-only mode (the list, the tree, the reading pane), over public
   documents instead of private ones. No table-of-contents prose is minted; the tree is the
   table of contents.
10. **Wishes are the book's.** Settled and trusted-only are set on the book at its first
    rollout and inherited by every page (a trusted book seals every page under the book's
    key). Scheduling a book is not in this arc. Unpublishing a book retracts the book and
    every page.

11. **The title page** (Curtis, 2026-09-04). A book adopts the first page in reading order
    as its title page: the book is titled by it, the book's feed post carries that page's
    words in full and then the table of contents, and the Publish column shows the borrowed
    title with a link to the page it comes from. The book's tags are the union of every tag
    on every page in the book (its notebook rides as its bucket, as a post's would).

## Slices

1. ~~**Book mode and the Publish column.**~~ Built 2026-09-03: the switch and the hidden
   marks live in two private kv collections (`books`, `book_hidden` - no header, no document
   change); the Publish column shows the ledger (new / changed / current / hidden), the
   sections with their hidden ticks, and the button, disabled until slice 2; the editor's
   bar inside a book speaks for the page's standing and carries "hide from the book";
   Writer's rows wear hidden / pending / current. The ledger reads `published_version`,
   which the rollout will record (slice 2) - until then every page is new. Pure
   `pure/books.js` with claims. The bucket switch; hidden marks on sections and
   documents; the ledger against the last rollout (the rollout records, per page, the private
   version it published - `published_version` beside `published_as` - so "changed" is a
   comparison, not a guess); the book bar in the editor; Writer's rows wearing the ledger's
   marks. Nothing public yet: this slice is the private bookkeeping and the surface.
2. ~~**The book document and `part_of`.**~~ Built 2026-09-03: header key 19 `part_of`
   (user gen 24 on the doc memos); pages publish through the feed's own door carrying it and
   the book's wishes, and record `published_version`; the fold keeps parts off the author's
   journals and shelf (a share of a page still journals - "a rebroadcast of its own"); the
   book is a public document of format `book` (wire id 6, `application/json`) whose body
   is the tree - sections, order, pages by public id - minted onto a stable id the bucket's
   `books` fact remembers; the rollout is a plan on the private kv (`book_rollout`, naming
   the device, written by `POST /books/{bucket}/rollout`) that the book-rollout sweep
   carries out, resumable page by page, the book minted last; the column polls it. The feed
   and the shelf draw a book as its table of contents with page links. A trusted book seals
   each page under its own key and the book under one kept in the `books` fact - the key
   lane serves per-post keys, and one key per page costs nothing (a deviation from ruling
   10's wording, not its intent). Acceptance in book_posts.cjs. Header key for `part_of`; the fold rule that keeps
   parts out of feed journals; the page publish through the existing door with `part_of`
   and the book's wishes; the book minted with the tree as its payload (a public form of the
   composed taxonomy: sections, order, page references); the first rollout as a background
   plan with progress in the column. Acceptance: a notebook of pages rolls out,
   the follower's feed shows one book post and no pages, every page has a permalink and
   opens from the book.
3. ~~**Updates.**~~ Built 2026-09-04: a rollout after the first reads the book's last
   payload back, re-publishes pages whose head moved (under their ids), retracts pages the
   book named that it no longer does (removed from the notebook, or hidden since - their
   notes become drafts again), mints the book's new version, and - when anything changed -
   one update post, "GRIMOIRE updated", a Marquee list of the changed pages as links and the
   removed ones by name, threaded under the book as a reply; a rollout that changed only the
   order re-mints the book quietly. The plan reports `changed`, `removed`, `update`. The
   feed draws an update as an ordinary post under "in reply to: GRIMOIRE"; a bespoke card
   can come with the reader. Acceptance in book_posts.cjs. A second rollout diffs, re-publishes changed pages under their ids, retracts
   removed and newly-hidden ones, mints the book's new version and the update post threaded
   under the book; the feed card for an update ("GRIMOIRE updated: …"). Acceptance: edit two
   pages, hide one, roll out, the follower sees one update naming two pages and the hidden
   page's permalink is gone.
4. ~~**The reader.**~~ Built 2026-09-04: at the book's permalink, Writer in read-only mode
   over the public tree - the tree on the left with the open page marked, the reading pane
   on the right, previous / next and "n / N" along the top, the first page open when none
   is asked for (Curtis: "just start at the first page"); a page's own permalink lands in the reader too with that
   page open (a page is a place in a book first), and "this page on its own" is there for
   the bare post. Route `/id/:seg/post/:book/:page`. The book's tags sit under the table of
   contents (each page's tags ride the payload), and selecting them filters the table to the
   pages carrying every selected tag - Writer's own rule (Curtis, 2026-09-05). Amended the same day: no "this page on
   its own" link, and a page's page threads, replies, and dossier on the BOOK - comments live
   in one place (Curtis: a per-page thread is "a place for comments to get very lost"). The shelf gained "+ books". Acceptance:
   a rebroadcast of the book reaches the sharer's follower as the book alone, no pages.
   Reading order is pure (`readingOrder`, `neighbours`). Writer in read-only mode over the book's public tree: the list, the tree,
   the reading pane, page navigation (previous, next, up) - at the book's permalink; the
   persona shelf's "+ books" toggle; a rebroadcast of a book as one pointer.
5. ~~**Unpublish, and the edges.**~~ Built 2026-09-05: `DELETE /books/{bucket}` takes the
   book down whole - every page it names, every update threaded under it, the book itself -
   with the takedown's own steps (notes back to drafts, the fold drained) and the bucket's
   facts forgetting the id, so the next rollout mints a fresh book (a tombstone is final).
   The column offers "unpublish the book" through the house modal, in both states of the
   switch: switched off with a book still public it says so, and a re-published page keeps
   its book (`part_of` is carried like the reply link, so the ordinary bar cannot make a page
   a standalone post). Hidden after publish landed with slice 3. Taking a book down; switching book mode off for a bucket
   that was published (the book stays public until taken down; the switch only changes
   what the next publish means); hidden after publish.

## Residuals named at the start

- Scheduling a rollout (ruling 10).
- A section published on its own (a chapter as a book) - out of scope; hide the rest.
