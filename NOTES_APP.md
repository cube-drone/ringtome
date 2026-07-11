# The Notes App — the first application delivered on Ringtome

This is an **application spec**, not protocol doctrine: notes are the first thing *built on*
Ringtome rather than part of Ringtome itself. The app earns its place three ways: it is the
single-player product ("come for the tool, stay for the network" — NEXT_STEPS, the recommended
route), it is the daily dogfood loop that puts the operator inside their own sync machinery, and
it is the forcing function for the **private blob lane**, infrastructure that posts and media
(4M) reuse the moment they exist. Notes and posts are mirror reflections — private/mutable vs.
public/mostly-immutable — sharing one storage shape.

## What it is

Personal, end-to-end-encrypted, multi-device notes. Write on the laptop, read on the Pi; no
cloud account, no third party who *can* read them. Plain text in v1 (the 4M markup can be
adopted later as a rendering layer; the storage model below doesn't care).

## The storage model: mutable documents on an immutable spine

The chain is the spine, not the body bag:

- **A note on the chain is a small LWW register** in the existing private store: collection
  `notes`, key = note id, value = an encrypted header `{title, blob_hash, parent, saved_at,
  format?}` - `format` absent means plaintext, reserved so markup (v2) arrives without
  archaeology.
  One save = one ~200-byte chain entry. Bodies never ride the chain, so the private-record size
  caps are simply not the app's problem (they were always meant for register/set-sized facts).
- **The body is an encrypted blob**: XChaCha under the current **epoch key**, nonce prepended,
  content-addressed by ciphertext hash. Membership semantics come free: a newly adopted device
  (re-sealed epochs) decrypts every note; a revoked device reads its era and nothing after.
- **Mutation is discharged into droppability.** Each save writes a new blob and repoints the
  register; superseded blobs become unreferenced and garbage-collectable. Version history is a
  **retention policy** (keep last N, keep ancestors needed for merge), not chain law. Deleting a
  note is a register tombstone plus dropping its blobs — the *fact* of the note is permanent,
  its content is not (the deletability doctrine, applied).
- **Autosave is debounced at the client** (idle/blur, ~10s), so chain growth is dozens of
  entries on a heavy day, not keystrokes. The long-run ceiling is the already-designed snapshot
  + prefix-GC machinery (PROJECT_PLAN, Open Items: Snapshots) — the notes register is a
  fold-based view, exactly what snapshots exist to compact.

## The sync model: never silently lose words

**The acceptance scenario, verbatim from life:** start a draft on the phone; continue it on the
PC; a stale tab on the phone autosaves the old text. Whole-note LWW *fails this maliciously* —
the stale save carries the newest timestamp and silently destroys the PC afternoon. So the app's
one hard requirement: **no sequence of saves, syncs, tabs, or crashes may silently discard
written words.** Prevention where cheap, recoverability always.

The mechanism is causality, not a text CRDT — **a version DAG; git for notes:**

- Every save's header carries `parent`: the version hash it was edited from.
- A save whose parent is the current head is a **fast-forward** — the overwhelmingly common
  case, conflict-impossible by construction.
- Two saves sharing a parent are **detected divergence** (the thing Discourse couldn't see).
  With the common ancestor's blob retained, resolve by three-way merge: **automatic when edits
  don't overlap** (which is nearly every moved-between-devices draft), **keep-both-with-lineage
  when they do** — the note shows "diverged on two devices," both versions a tap away, merge UI
  optional and later. v0 may ship detect-and-keep-both with no auto-merge at all; the
  requirement is never-lose, not always-merge.
- Clients check the head before saving: if it moved, rebase (fast-forward the editor onto the
  new head) or fork knowingly — never blind-save. The stale tab becomes a detected sibling, not
  a destroyer.
- The plan's **unsynced indicator** doctrine applies verbatim: a device knows which of its saves
  no peer has acknowledged, and surfaces it like an unsaved document.

**On collaborative CRDT text, decided:** real-time co-editing is a non-goal — a text CRDT's
op-log would become a wire format inside the conformance boundary, a giant cost with no named
consumer. Asynchronous convergence-without-loss is the goal, and the DAG delivers it at
app-payload level with zero protocol changes. The CRDT door stays open exactly as PROJECT_PLAN
always said: richer merge rules arrive as new payload types on the same conflict-free substrate,
if a real collaborative feature ever names itself.

## Publication: the moment a note becomes a post

Notes turn out to be a prerequisite for posts in a deeper way than "build the editor first":
nobody authors in public. **A post's draft is a note**, with everything above applying to post
authoring for free — the never-lose-words DAG, the encrypted versions, the multi-device
continuation. What posts add is the **publication moment**, and the architecture dictates its
shape:

- **Publication is an act, never a flip.** A draft is epoch-key ciphertext on chains that never
  cross the identity boundary, so there is no "make public" bit that *could* be toggled.
  Publishing creates a **new artifact**: decrypt the draft, re-encode as a public payload
  (inline or public blob), sign it onto the posts chain. Accidental publication by
  misconfiguration is unrepresentable — the membrane is crossed only by a deliberate signing
  act (the same doctrine as serving records: publication is an act).
- **Editing history stays private, structurally.** Revisions, abandoned paragraphs, and the
  draft's age never cross; the post is born at publication with a public history of one. Not a
  policy — a consequence of copy-don't-flip.
- **Independent lifecycles, privately linked.** The note's header records
  `published_as: <post hash>`. Draft edits never auto-propagate (re-publish is another explicit
  act; post-*edit* semantics are 4M's tombstone/replace problem, not this spec's). Deleting
  either side leaves the other standing. A note never published is just a note — the correct
  degenerate case.

Sequencing consequence: the notes → posts order in NEXT_STEPS' recommended route is now a
dependency, not just a motivation call — the notes editor *is* the post composer.

## Prerequisite: the private blob lane

Blob transfer does not exist yet in any form; notes force it into existence, sized small:

- Two frame types on the existing member-proven sync connection: `BlobRequest(hash)` /
  `BlobData` — fetched after entry sync for referenced hashes we lack.
- The doctrine sentence that makes it general: **a blob inherits the sync boundary of the
  entries that reference it.** Private blobs are never served to unproven peers — existence,
  count, and size of your notes are themselves private (ciphertext alone is not the boundary).
- Node-side: encrypted blob store on disk, refcount GC driven by the materialized notes register
  (plus the retention policy's ancestor-keeping).
- iroh-blobs stays reserved for its real consumer — big *public* media in 4M, where
  serve-by-hash to anyone is the desired behavior.

## Taxonomy: external artifacts, never header data

*(The canonical statement now lives in PROJECT_PLAN, Data Layer: "Taxonomies: Documents About
Documents" - promoted there because addressing (slugs), feeds, and Marquee's computed widgets
all consume it. This section keeps the app-level view and the reasoning as discovered.)*

Streams (tags), trees (knowledge bases), and every other document ordering will matter and will
be load-bearing - and v1 deliberately ships a flat chronological list anyway, because the
organizing principles are settled:

**Taxonomies live outside the documents they organize.** Three proofs, each independently
sufficient: (1) *third parties curate* - someone else's reading list over your documents cannot
write into your headers, so external taxonomy must exist, and a second in-header mechanism would
be redundant; (2) *views mix boundaries* - "POSTS_PERSONAL" (your drafts interleaved with your
published output) is a private artifact referencing both public and private doc-ids, which
header data structurally cannot express (a tag riding a public post is public); (3) *the
publication membrane stays clean* - organizing metadata never rides the document, so nothing
needs stripping at the crossing, extending copy-don't-flip to metadata. Bonus: retagging never
manufactures a divergence conflict with a concurrent prose edit.

**Two shapes, chosen by the merge semantics each wants:**

- **Unordered membership (tags, streams-by-tag): LWW-element-sets** - the store's existing set
  collections, one per tag. Concurrent tagging from two devices merges automatically; membership
  has no ordering to fight over. Zero new machinery.
- **Ordered structure (trees, curated sequences, "BOOK ABOUT HORSES"): taxonomy documents** - a
  body that is an ordered arrangement of references, inheriting the full single-document
  machinery above: versioning, the divergence DAG (reorganizing a tree on two devices *is*
  editing a note on two devices), and the publication moment when a knowledge base goes public.
- Chronological streams are usually no artifact at all: a derivable view over a set.

**Reservations that hold from day one:**

1. **References are `(root, doc_id)` - identities, never version hashes.** Notes have stable ids
   already (the register key); the 4M post payload must carry a stable `doc_id`, or every edit
   shatters every tree that references it. The root is implicit within your own store and
   explicit for third-party curation - aligning with `ringtome://` addressing.
2. **Labels ride the payload; tags never do.** The plan's `labels` field (consent machinery)
   must travel *with* content - a stranger's server filters NSFW on bytes it carries without
   access to anyone's taxonomies. Tags are the opposite: organization that deliberately does not
   travel. Same-looking strings, opposite transport requirements, permanently separate.

## Markup: v2, and the plaintext era is the carrier

Notes are the 4M markup's intended first deployment, deliberately *after* a plaintext v1. The
staging buys three things: a **corpus before a grammar** (months of real notes tell the
vocabulary cut what constructs are actually reached for - empirical input to 4M's open
question), a **staged adversarial gradient** (the parser - strict from birth regardless -
debuts on your own friendly content and faces stranger content only later, at 4S), and a
**zero-migration vehicle** (bodies are opaque bytes; markup is a rendering layer over the same
blobs, keyed by the header's `format` field).

**The guard: no markdown-lite in the meantime.** The day-three itch ("I just want a bullet
list") is how unspecified pseudo-markup creeps in - a regex here, an innerHTML there, and
suddenly a second markup exists with no grammar and no vectors. Notes render as honest
plaintext until the real 4M parser lands. The itch is the corpus talking; write it in the
vocabulary notes, don't scratch it in the renderer.

## Non-goals (v1)

Real-time co-editing; rich text (plain text now; see Markup above); sharing
notes with other identities (that's the disclosure-lane machinery's future, not v1); full-text
search beyond client-side naive; any taxonomy UI (see Taxonomy above - the design is chosen,
the feature waits).

## Open questions

- [ ] Merge UX: what does "diverged on two devices" look like in cozy language?
- [ ] Retention default: keep-last-N versions — what's N, and is it user-visible?
- [ ] Blob frame size cap vs. chunking: notes are text and fit single frames; decide the cap now,
  chunking only when media (4M) actually needs it.
