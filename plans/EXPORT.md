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

## The tree

```
<name>-export-<date>/
  README.txt                     what this is, when it was made, what's missing
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

## Not yet

- **Import** (Curtis: "We'll worry about 'import' in a bit").
- **Links between notes** inside a `.md` still point at the app's addresses
  (`/api/identity/…/docs/…/body/…`); rewriting them to relative paths in the zip
  is the next step for a reader that wants the pictures inline.
- **Android**: the APK's webview has no download handler yet, so the download
  link does nothing there.
