# Export

A persona, whole, as one `.zip` a person can keep, open and read without us:
every note, drawing, picture and post, plus their profile, contacts, chats and
bank, laid out as files and folders. Import comes later (_Not yet_).

## The ask (Curtis, 2026-10-09)

> between "content control" and "log out" in the your settings, a new section:
> "import/export" (phosphor icon: "package") - this takes the user to a page
> where they can generate and subsequently download a .zip containing their
> entire public and private identity, unencrypted, as a file tree: /public and
> /private at the top level, then organized into /buckets, then by taxonomy if
> present, with documents saved as .mq files (with annotations and metadata,
> including creation date, stored as meta directives in the file), .md files (no
> annotations), .yml.md files (md files with yml front matter containing
> annotations and metadata), .txt files (if the file was in a text format, not a
> mq format), .yml.txt files (like txt files but with yml front matter), and
> '.horsedrawing' files (a text format, with metadata, even if unlikely to be
> openable in anything but marquee). Creating exports is a queued background
> activity. Only one export can be active for a persona at a time: create a new
> export and it blows away the old one. We'll worry about "import" in a bit.

## Rulings (Curtis, 2026-10-09)

1. **Every rendering, side by side.** A Marquee note is written three times -
   `.mq`, `.md`, `.yml.md` - a plaintext note twice - `.txt`, `.yml.txt` - and a
   drawing once, `.horsedrawing`. Something in the folder opens anywhere.
2. **Media goes in, as its stored bytes**: `.avif`, `.png` (APNG), `.webm`,
   `.opus`, beside the notes in their folders.
3. **No keys.** Content, not the means to be the persona: no signing keys, no
   spare key, and no sealing keys either (`trusted_key` is bookkeeping, dropped
   from every note's metadata). Moving a persona is what _add computer_ and the
   spare key are for; an unencrypted zip of keys is a stolen identity.
4. **Everything else of the persona**: profile, contacts and follows, chat
   history, and the bank ledger.
5. **Every version said, and every file hashed** (Curtis, 2026-10-09: "cheap to
   add now and expensive to add later"): each document's metadata carries
   `head`, the version exported, and `manifest.json` lists every file in the zip
   with its SHA-256 and size, and each rendering with its document's id and
   head. Import is additive (below) and needs neither today; an import that ever
   wants to merge an edit will anchor on them, and a zip made before they
   existed could never be.

## The tree

```
<name>-export-<date>/
  README.txt                     what this is, when it was made, what's missing
  manifest.json                  every file: its SHA-256 and size; a document's id and head
  public/
    profile.yml                  name, bio, colorway; avatar/banner beside it
    avatar.avif, banner.avif
    buckets/<bucket>/<section>/…/<title>--<id8>.mq|.md|.yml.md|.txt|.yml.txt
    unfiled/…                    posts whose note sits in no bucket, or has no note
  private/
    buckets/<bucket>/<section>/…/<title>--<id8>.<ext>
    unfiled/…                    notes in no bucket
    taxonomies.yml               every list that is not a notebook's own tree
    contacts.yml                 who you follow and trust, and what you said of them
    bank.yml                     every ledger line
    chat/<room>--<id8>.txt       what this computer holds of each room you're in
```

- **Buckets** are notebooks. A note in two notebooks is written in both.
- **Taxonomy** within a bucket is its notebook tree (`wiki:<bucket>`): a section
  is a folder, nested as deep as the tree is. Other taxonomies - reading lists
  that live outside any notebook - are listed, with the paths of their members,
  in `private/taxonomies.yml` rather than inventing folders.
- **Names** are `<title as a file name>--<first 8 hex of the doc id>`: two notes
  titled "untitled" never collide, and the id ties a file back to its document.
- **Public** is what the persona published: its posts, opened - a trusted-only
  post the author sealed is written unsealed - under the bucket of the note it
  was published from.

## The formats

- **`.mq`**: the Marquee source, with a `:::meta` directive at the top carrying
  the metadata - `id`, `title`, `created`, `updated` (ISO 8601), `display_date`,
  `tags`, `buckets`, `published_as`, and every other annotation field but the
  bookkeeping (_Rulings_ 3). Marquee's own metadata form (SPEC, Document
  metadata), written by the parser crate's serializer so the quoting is right.
- **`.md`**: the same note through `marquee_markdown::to_markdown` - lossy, no
  metadata.
- **`.yml.md`**: that Markdown under YAML front matter holding the metadata.
- **`.txt` / `.yml.txt`**: a plaintext note as it is, and under front matter.
- **`.horsedrawing`**: YAML front matter, then the drawing's canonical JSON body
  (plans/DRAWING.md). The pictures its strokes place are exported as media.
- **YAML** is written by hand: every scalar is a JSON string, which YAML reads
  as a double-quoted scalar - no YAML library, and no value can break the file.

## The machine

- **One queue, one at a time, node-wide** (`export.rs`): an export is a lot of
  reading and compressing, and a server with many people should run them in
  turn. A persona's export is _queued_, then _running_ with its progress, then
  _ready_ (its size and when) or _failed_ (why).
- **How far it has got** (2026-10-09, after a large account's export came back
  to nothing): _gathering_ (reading what there is, before the total is known),
  then _writing_ - a step per document and post, then the profile, lists,
  contacts, ledger, chats and README - which the page draws as a bar, a share
  and _N of M_. The state is written beside the zip (`<root>.json`) whenever it
  changes kind and every two seconds while it runs, so a node that stopped
  mid-export says so afterwards - _interrupted_, and how far it got - rather
  than offering to start again as if nothing had happened. At most two files
  wait in memory for the zip's thread at once.
- **One per persona.** Starting a new one cancels any queued or running one and
  deletes the last zip; the new zip replaces it when it is whole (written as
  `.partial`, then renamed - backup.rs's rule).
- **Where it lives**: `<data>/exports/<root>.zip`. A restart forgets the queue
  but not the file: a zip on disk is a ready export.
- **Who may ask**: the persona's own signed-in account (`store::open`), for
  starting, asking after and downloading. The work itself opens the store the
  way background passes do (`store::open_agented`).
- **Downloading**: a browser takes the file from
  `GET /api/identity/{root}/export/download`. The desktop app shows it in the
  file manager instead (`ShellRequest::Reveal`, as backups do) - a webview
  downloads nothing, and `Save` holds a file in memory, which a large export
  must not.

## What is left out, and said so

- A note whose body has not reached this computer yet is listed in `README.txt`,
  not written.
- Deleted notes are not exported. Version history is not exported: each note is
  its current text.
- Chat is what this computer holds of each room, which for a busy room is its
  recent history, not all of it.

## Import (built 2026-10-09)

**Additive only** (Curtis, 2026-10-09): "if I edit a document and re-import it,
nothing should happen, it only adds New documents, New annotations, et-al. When
running the import operation, it should display a list of 'Document <title>
skipped: It already exists!'"

- **A document is known by its id**, the `id` in its `:::meta` or front matter,
  or the `--<id8>` at the end of its file name. One whose id this persona
  already holds is skipped, whatever its words say now, and the import's report
  says so: _Document <title> skipped: It already exists!_ Nothing is ever
  overwritten, merged or deleted, so an import cannot lose anything, and
  importing the same zip twice adds nothing the second time.
- **One document, several files.** A note's renderings (`.mq`, `.md`, `.yml.md`;
  `.txt`, `.yml.txt`) are one document: the import groups them by stem and reads
  the richest one - `.mq`, then `.yml.md`, then `.md`; `.yml.txt`, then `.txt` -
  so a note exported three ways is imported once, not three times.
- **A file with no id** - a Markdown file written somewhere else and dropped
  into the folder - is a new document, in the notebook and section its folder
  names. Its id is made from its place in the zip and its bytes, so the same
  file imported twice is one document, skipped the second time; a file changed
  since is a new one.
- **Annotations, notebooks and sections add, never change.** A tag the document
  lacks is added; a field it has is left as it is, even if the file says
  otherwise; a notebook or section membership is added, never removed. For a
  document that already exists this applies only to what is missing - which is
  why moving a file to another folder and re-importing adds it to that notebook
  too, and takes it out of nothing.
- **Into a fresh persona** every id is new, so everything is created. Dates are
  signed, so the original creation date becomes `display_date`.
- **Posts are republished** (Curtis, 2026-10-09). A post is signed by the
  persona that made it, so another persona cannot take it over - only say it
  again, as a post of its own. It reaches followers' feeds as new, dated the day
  it was first said, and earns what publishing earns. It is said from the note
  it was published from when the zip holds that note, else from a note made of
  its words under the post's own id - so a second import finds it held. A post
  whose note this persona has already published is skipped. Two kinds are never
  said again, and the report says so: a **reply** (it belonged in somebody
  else's thread) and a **room** (a chat room starts fresh).
- **Contacts are re-applied** (Curtis, 2026-10-09): follows, trust and the
  persona's own notes on each person are set again - which, from a new persona,
  reaches each of them as somebody new following them.
- **Bank and chat never import**: the ledger is derived from the persona's own
  chains, and a room is its author's. They stay in the zip, to read.
- **Servers don't take imports** unless their administrator allows them (Curtis,
  2026-10-09: "by and large the direction we want is for users to export their
  personas from servers to personal devices and not the other way around"):
  _allow users to import_ on hrseServer's Backups page, off by default
  (`import_policy`, node rung 76). The desktop app always takes them.
- **The machine** (`import.rs`): the zip is the request's body, streamed to disk
  and held to the node's upload cap (`RINGTOME_MAX_UPLOAD_BYTES`), then imported
  in the background under the same one-at-a-time permit as exports. One import
  per persona at a time, and at most four waiting on the whole node - each holds
  its upload on disk. Pictures, video and sound go through the ordinary ingest
  queue under their own ids. The page shows the import's report, line by line.
- **Safety rails** (2026-10-09), for a zip nobody should trust:
  - every name is kept inside the import's folder (no `..`, no absolute path; a
    symlink is written as the text it holds);
  - unpacking is held to the bytes actually written, not the sizes the zip
    claims - four times the upload cap, between 1 and 16 GiB, so a server's 128
    MiB unpacks to at most 1 GiB - and to 250,000 files, and stops while the
    disk still has 1 GiB free;
  - no file is read whole unless it fits what a document of its kind may be (the
    document cap for words, the upload cap for media, 8 MiB for a details file);
    a larger one is skipped and said so;
  - a drawing must be drawing JSON - one that isn't is skipped - and is kept in
    its canonical form;
  - a notebook's sections stop 16 deep;
  - a post is said again only from a note this import made, so a zip can never
    publish a note the persona already had.

## Not yet

- **Imports larger than the upload cap**: a desktop app's cap is 1 GiB, less
  than a persona with years of pictures; and a server that allows imports holds
  them to its own (128 MiB by default).
- **Links between notes** inside a `.md` still point at the app's addresses
  (`/api/identity/…/docs/…/body/…`); rewriting them to relative paths in the zip
  is the next step for a reader that wants the pictures inline.
- **Android**: the APK's webview has no download handler yet, so the download
  link does nothing there.
