# The Notes App — the first application delivered on Ringtome

This is an **application spec**, not protocol doctrine: notes are the first thing *built on*
Ringtome rather than part of Ringtome itself. In fact the app is now a thin skin over three core
primitives its design forced into existence — designing "private notes" turned out to be designing
**files**, **versioned documents**, and **taxonomies**, and all three have been promoted to
PROJECT_PLAN's Data Layer as canonical (The File Layer; Versioned Documents; Taxonomies). What
remains here is the application: **a note is a private versioned document with a plaintext (later
`.mq`) body, plus whatever taxonomies the user points at it.**

The app still earns its place three ways: it is the single-player product ("come for the tool,
stay for the network" — NEXT_STEPS, the recommended route), it is the daily dogfood loop that puts
the operator inside their own sync machinery, and it was the forcing function for the primitives
above — posts and media (4M) reuse them the moment they exist. A post is just a published note:
private/mutable and public/mostly-immutable are mirror reflections sharing one storage shape.

## What it is

Personal, end-to-end-encrypted, multi-device notes. Write on the laptop, read on the Pi; no
cloud account, no third party who *can* read them. Plain text in v1 (the 4M markup can be
adopted later as a rendering layer; the storage model below doesn't care).

## The storage model: the primitives, applied

The general machinery is canonical in PROJECT_PLAN (Data Layer: **Versioned Documents** for the
header/DAG model, **The File Layer** for encrypted content-addressed bodies). What the notes app
adds on top:

- **A note is a versioned document on the private `notes` chain** — headers epoch-encrypted like
  every private record, bodies as private files. Membership semantics come free: a newly adopted
  device (re-sealed epochs) decrypts every note; a revoked device reads its era and nothing after.
  `format` absent means plaintext — the v1 state; markup (v2) arrives via this field with zero
  migration. `refs` is empty in v1 (plaintext bodies reference nothing); its schema follows
  Marquee's target model when embeds exist.
- **Version history is a retention policy** (keep last N, keep ancestors needed for merge), not
  chain law. Deleting a note is a tombstone plus dropping its files — the *fact* of the note is
  permanent, its content is not (**Immutable Chains ≠ Immutable Content**, Doctrine). One honest
  asterisk: the header's `body_hash` (a keyed plaintext fingerprint, kept for no-op bouncing and
  merge detection) outlives the dropped bytes, so deleted content stays *confirmable* — never
  recoverable — to someone holding the epoch keys and a correct guess. Inert against prose;
  real against low-entropy secrets. Don't keep your PIN in a note you plan to delete.
- **Autosave is debounced at the client** (idle/blur, ~10s), so chain growth is dozens of
  entries on a heavy day, not keystrokes — and a save whose body is identical to its parent's
  writes nothing at all. The long-run ceiling is the already-designed snapshot + prefix-GC
  machinery (PROJECT_PLAN, Open Items: Snapshots) — the notes view is fold-based, exactly what
  snapshots exist to compact.

## Media retention: the deletability doctrine, one level down

Embedded media is baked into local blobs at authoring time (PROJECT_PLAN, *An Embed Is an Ingest*),
which lands a storage problem squarely on this app: the version DAG reaches back to a document's
inception, and rollback means old versions must stay *usable*. Read naively, that pins every image
a note ever referenced, forever - and the Pi with the 8 GB card loses. The escape is a rule this
spec already states about notes themselves, applied one level down to their pictures:

**The fact of an image is permanent; its bytes are not.**

- **References and provenance are text, and text is free.** Every version keeps its embed
  references and the origin URL each was baked from - a few dozen bytes apiece, riding in the body
  like any other markup, forever.
- **Bytes are retained for live heads.** A media blob referenced by the current version of some
  document is kept. One that isn't - an image swapped out three revisions ago - is unreferenced and
  garbage-collectable on exactly the same terms as a superseded body blob. Same refcount GC, no new
  machinery.
- **Rollback is exact for text and best-effort for media.** Roll back to an ancient draft and the
  words return verbatim; an image whose bytes were dropped returns as a placeholder naming where it
  came from, with a link. That is an honest degradation, and it is better than what version control
  usually does to large files.
- **The provenance URL is an epitaph, not a fallback.** The renderer must never quietly hotlink it
  when the blob is missing - that would resurrect every problem the bake exists to solve. It is what
  the placeholder *says*, and it is what makes dropping the blob a defensible act rather than a
  data-loss event.

(No dedup softens this for private files — random-nonce encryption means identical bytes store
twice, deliberately; see PROJECT_PLAN, The File Layer, for the oracle argument.)

## The sync model: never silently lose words

**The acceptance scenario, verbatim from life:** start a draft on the phone; continue it on the
PC; a stale tab on the phone autosaves the old text. Whole-note LWW *fails this maliciously* —
the stale save carries the newest timestamp and silently destroys the PC afternoon. So the app's
one hard requirement: **no sequence of saves, syncs, tabs, or crashes may silently discard
written words.** Prevention where cheap, recoverability always.

The mechanism is causality, not a text CRDT — the version DAG (PROJECT_PLAN, Versioned
Documents: `parents`, fast-forward, detected divergence, keep-both universal). The app-level
behaviors on top:

- **Trivial forks fold at read time, writing nothing**: heads carrying no distinct words -
  identical twins (the same fix made on two devices) and ancestor echoes (a revert to the fork
  point while the other side wrote on) - are folded by the materializer, deterministically, on
  every device alike. No merge entry is minted at detection; the DAG heals when the next
  ordinary save lists all true heads as `parents`. A rename never folds, and a revert *past*
  the fork point stays diverged - when in doubt, keep both.
- **Three-way merge is text's per-format capability**: automatic when edits don't overlap (which
  is nearly every moved-between-devices draft). v0 may ship detect-and-keep-both with no
  auto-merge at all; the requirement is never-lose, not always-merge.
- **Conflicts are presented IN the document; there is no merge UI, ever.** When edits genuinely
  overlap, the diverged document's displayed body is the merge output *with the conflict inline*,
  and the shape is **dispatched on the header's `format`** (the first behavior to actually differ
  between formats): git-style marker blocks for plaintext (per-hunk, with honest labels — "from
  your phone, yesterday 9pm"; chains are per-device, so attribution is free), a `:::conflict`
  directive wrapping `:::variant` blocks in Marquee (the renderers' shipped vocabulary —
  "version" was judged overloaded over in marquee; `label` and `when` are advisory display
  text rendered verbatim, so `when` carries civil time) - **per-hunk since 2026-07-25** (the
  whole-document presentation proved a cure worse than the disease in field testing: it
  discarded every cleanly-merged region to protect against occasionally splitting a block
  element). Marquee's block elements are largely line-tied, so line-boundary hunks usually
  land clean; when a hunk does split a multi-line element, the strict parse fails and clients
  degrade to showing source - honest and lossless, and resolution happens in the write view
  regardless. Whole-`:::variant` blocks remain the degraded form (three-plus heads, no usable
  fork point), exactly parallel to plaintext's whole-document fallback. Clean three-way merge is
  format-agnostic (Marquee source is still lines); only the *conflict* presentation forks. The editor is the merge tool. This text is **synthesized at
  read time, never written** — resolution is the user tidying it and saving, which lists all DAG
  heads as parents and heals the fork through the ordinary write. Properties that make it safe:
  there are no invalid states (saving half-resolved markers just means the document visibly still
  contains a tangle — lossless, resolvable later; markers are never parsed back, so text *about*
  conflict syntax can't confuse anything), Marquee's unknown-vocabulary shrug means a client
  that's never heard of `:::conflict` renders both texts in full (the degraded conflict is still
  a lossless conflict), and the one named client obligation is that **synthesized text starts
  clean, not dirty** — autosave must never commit the tangle the user hasn't touched. Three-plus
  logical heads merge per-hunk too (amended 2026-07-25, field-tested: three computers changing
  one paragraph came back as a whole-document wall): when the head set shares a **single** fork
  point, every head is diffed against it and aligned - disjoint edits weave fully clean, and a
  disputed region carries one variant per *distinct* proposal (two heads that wrote the same
  words fold to one variant, the twin-folding spirit). Degradation to the whole-document
  conflict ("every version in full") remains for what alignment can't stand on: no single fork
  point for the set (criss-cross among three-plus heads), or a GC'd fork body - lossless and
  conservative as ever. This resolves the merge-UX open question: "diverged on two
  devices" looks like your document, with both texts inline under gentle labels.
- **Clients check the head before saving**: if it moved, rebase (fast-forward the editor onto the
  new head) or fork knowingly — never blind-save. The stale tab becomes a detected sibling, not
  a destroyer. The watch signal is subtler than "did the head move" — field-tested twice: the
  device whose save *is* the display pick never sees it move, and two devices racing to resolve
  the same fork can leave every watched scalar (display head, head count, diverged flag)
  identical while the head *set* rotates underneath. The full judgment, scars and all, lives as
  a pure tested predicate (`js/lookout.js`); the load-bearing clause is "an editor that believes
  it is linear while the row says diverged has not yet presented that divergence."
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
  collections. Concurrent tagging from two devices merges automatically because the merge unit
  is the single `(doc, tag)` pair; membership has no ordering to fight over. Zero new machinery.
  *(Amended 2026-07-20: tags live in the annotation layer, grouped per-document on the `doc-meta`
  chain - not one collection per tag on `general-private` as first sketched here. "One
  ever-growing set per tag" vs "a search over annotations" turned out to be a false choice: both
  read directions are indexes over the same materialized table, so the wire shape is chosen on
  merge grounds alone. See PROJECT_PLAN, Annotations.)*
- **Ordered structure (trees, curated sequences, "BOOK ABOUT HORSES"): taxonomy documents** - a
  body that is an ordered arrangement of references, inheriting the full single-document
  machinery above: versioning, the divergence DAG (reorganizing a tree on two devices *is*
  editing a note on two devices), and the publication moment when a knowledge base goes public.
  *(Amended 2026-07-22: ordered structure decomposed to per-element facts too - a `tax:`
  collection on the doc-meta chain, each member a set element carrying `(parent, rank)`, order
  assembled by the materializer; taxonomy documents remain as the publication form. Same
  grounds as the tags amendment below: the wire shape is chosen on merge grounds alone, and
  two devices each adding to one list must union, not conflict - the "reorganizing *is*
  editing" analogy above is the part that didn't survive. See PROJECT_PLAN, Taxonomies.)*
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

- [ ] Retention default: keep-last-N versions — what's N, and is it user-visible?
- [x] ~~The conflict vocabulary: Ringtome host vocabulary, or upstream into Marquee's spec?~~
  Upstreamed: Marquee ships `:::conflict` / `:::variant` (0.6.x, both renderers, shared
  `mq-conflict`/`mq-variant` class contract; "version" was judged overloaded on their side).
  Ringtome emits their names. (Merge UX itself is resolved — conflicts present in-document;
  see The sync model.)
- [ ] Header encoding: reuse the private-register's string value (hex-encoded `file_hash`/`parent`)
  or a dedicated CBOR `NoteHeader` payload with binary fields and its own AAD? Leaning dedicated,
  since byte-level file encryption already exists for bodies. (Chunking is no longer a question -
  iroh-blobs handles it.)
