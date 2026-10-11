# Private dedup

One copy of each private file a persona holds. Uploading the same surprised
Pikachu a fiftieth time gives you the Pikachu you already have, and the
twenty-six tracks of an album share one cover. A design draft (2026-10-11);
nothing built.

## The ask (Curtis, 2026-10-11)

It started with cover art. A sound's embedded cover could become its thumbnail,
but "often a whole album comes with the same art every time, having 26 copies of
every album cover would be irritating". Then the general case:

> right now public files have a significant deduplication layer we get basically
> for free: files are stored under their hash. We don't support this for private
> files for the reason you just encountered: strangers could use private chains
> as a "file oracle" - but, honestly, deduplication of identical data is both a
> large space savings and _convenient_ - we don't want the same pikachu meme
> showing up 50 times in our blog to mean that we store the surprised pikachu
> image 50 times. That's not just a space savings, it's also a cognitive
> savings: people find mountains of duplicate content irritating and hard to
> sort around. Music thumbnails are likely the forcing function [...] One idea I
> had here would be a per-persona "document-version-file-hash" folded
> materialized view table: it can't be used as an oracle because it's node local
> and encrypted to the user in question, but it can at least be used to go "oh,
> we already have that".

And on the two open questions:

> I wouldn't allow key rotation to trigger a second copy of the file even: once
> knowledge that this file exists at all is out, the game is spoiled, I think?
> But private and public versions should still, probably, be separate, because
> "user x has saved document y" is a useful oracle we want to deny.

## Why private files don't dedup today

PROJECT_PLAN's _The File Layer_ says so outright. A private file is XChaCha
ciphertext under the current epoch key with a **random nonce**, stored under the
hash of the **ciphertext**. The same bytes uploaded twice encrypt differently,
hash differently and are stored twice. That's the price of the guarantee that
nobody, member or not, can precompute a private file's hash from content they
know. Convergent encryption would dedup, but it would hand out exactly that
confirmation oracle.

This plan keeps that guarantee. Dedup doesn't come from changing how files are
encrypted. It comes from the persona **remembering what it already stored**:
before encrypting a new file, ask "do I already hold these bytes?", and if so,
name the ciphertext already in the store. Nothing outside the persona's own keys
can ask that question.

There's already a small precedent (record/documents.rs `save_version`): saving a
body that appears anywhere in the same document's history reuses that version's
blob. This works because the header's `body_hash` fingerprint proves the two are
equal without decrypting either. It stops at the document's edge because
`body_hash` is keyed by `doc_id`. This plan widens the same idea from one
document to the persona's whole private lane.

## What stands already

Two facts from the code mean the store needs no changes:

- **Cleanup counts references, so a shared blob is safe.** The reaper (files.rs
  `gc_config`, `reaper::live_set`) marks every hash that something still names -
  held chains' `doc_versions`, the fragment shelf, the wants ledger - and sweeps
  the rest. Twenty-six versions naming one blob keep it alive, and deleting one
  track can never take the blob from the other twenty-five.
- **A blob says which epoch encrypted it.** Its first eight bytes are its epoch
  (`epoch ‖ nonce ‖ ciphertext`), and `decrypt_file` tries that epoch's keys. A
  version written in epoch 5 can name a blob from epoch 2. Every member can read
  it, because adoption re-seals every historical epoch key to a new device
  (PROJECT_PLAN's _Private Chains: Epoch Keys_). Every member holds every epoch.

## The rulings

1. **The scope is one persona's private lane.** Its private documents share one
   set of epoch keys, so any of them can name any blob the persona encrypted.
   Different personas never share, even on one node: different keys, and sharing
   would tell one persona's node what another holds.
2. **Public and private never share (Curtis).** A private upload whose bytes
   match one of the persona's public posts gets a ciphertext of its own, and a
   public post never names a private blob. Otherwise "this persona holds
   privately the thing they once published, or the thing someone else published"
   becomes answerable from storage, and that's the oracle we deny. Public blobs
   keep the dedup they already have: plaintext, addressed by its own hash.
3. **Key rotation doesn't break dedup (Curtis).** After a rotation, a new upload
   that matches a file from an older epoch names the old blob. It doesn't
   re-encrypt under the new key. A revoked device holds the old key and could
   read that blob, but it already could: it is the same file, from its own era.
   What the rotation closed still holds. The revoked device can't read new
   headers, so it never learns that a new document names the old blob, and the
   member gate stops shipping it anything after the rotation.
4. **Fingerprints are keyed, as a second wall.** The walls that matter are
   already there: prints travel only inside encrypted headers, and the view
   lives in the persona's database, which is encrypted at rest like every
   database (db.rs: Turso's page-level AEGIS-256, a key per database sealed in
   the node keystore). A keyed BLAKE3, with a key derived from the persona's
   **epoch-0** key (below), adds that a print is never a global identifier. If
   one ever escaped - a bug, a log line, a debugging dump of the view - a plain
   hash could be checked against any public list of known files ("this persona
   holds the surprised Pikachu"), and a keyed one can't without the persona's
   keys. It costs nothing, and it matches `body_hash`, which is keyed for the
   same reason.

## The fingerprint

```
print_key = blake3::derive_key("ringtome-v0/content-print", epoch_0_key)
print(bytes) = blake3::keyed_hash(print_key, bytes)
```

- **Why epoch 0:** it must be the same in every epoch, or a rotation would split
  the view in two, which ruling 3 forbids. Every member holds epoch 0 (adoption
  re-seals the whole history), and nobody outside the membership ever has. A
  revoked device holds it too, but by ruling 3 that costs nothing: it can't read
  the headers that carry prints after its era.
- **Why not reuse `body_hash`:** `body_hash` is keyed by `doc_id` on purpose
  (registry.rs: it kills global rainbow tables, so a dictionary attack has to be
  mounted per document), and merges, publishing's "do the words differ?" and the
  blob reuse above all lean on it. A print is the persona-wide twin with a
  weaker residual. For someone who already holds the keys, "is this text
  anywhere in the persona, including deleted documents whose headers survive?"
  becomes one hash instead of one per document. That residual is inherent and
  `body_hash` already concedes it document by document (NOTES_APP's asterisk).
  It is accepted here because such a person can decrypt everything anyway.

## Carried in the header, folded into a view

For the view to be a true fold - rebuilt from the chain on a new device, after a
restore or after a schema change, without decrypting every blob - each version
carries its prints **inside its encrypted header**. Strangers never see them;
only the people who can read the header can.

New optional header keys (registry.rs `DocHeaderPlain`; readers skip unknown
keys, so old readers decode new entries and old entries simply lack them):

| Key | Field          | The print of                                        |
| --- | -------------- | --------------------------------------------------- |
| 24  | `body_print`   | the body's plaintext (the crushed media, the words) |
| 25  | `thumb_print`  | the thumbnail's plaintext, when there is one        |
| 26  | `source_print` | the bytes the person uploaded, before the crush     |

The private lane only. A public version has no use for prints, since its blobs
dedup by plain hash already, and must not carry them. A plain print in a public
header would be the oracle ruling 2 denies.

The view, a migration rung in `migrations/user/`:

```sql
CREATE TABLE content_prints (
    print     BLOB    PRIMARY KEY,  -- keyed fingerprint (header keys 24-26)
    file_hash BLOB    NOT NULL,     -- the ciphertext in the file layer that holds those bytes
    doc_id    BLOB,                 -- for a source print: the document it became
    kind      TEXT    NOT NULL      -- 'body' | 'thumb' | 'source'
);
```

It is folded on every `doc_versions` append in the private lane, as the
document's other derived columns are. A row can outlive its blob, once every
document naming it is deleted and the reaper has swept. So a hit counts only if
the store still holds the blob; otherwise it is a miss, and the row is dropped
then. Re-uploading after that makes a fresh blob, which is right: the persona no
longer "has" it. A hit must also **hold** the blob until the new version naming
it has landed, as a fresh put is held (`files::Put`). Otherwise a sweep between
the lookup and the append could take a blob a moment before it is named again.
(Whether a deleted document's versions stay in `doc_versions` - and so whether
"deleted" really frees the blob - is to be checked against the reaper's live set
before building; the lookup rule above is correct either way.)

The preview clip gets no print. It is derived from its video, so a matching
`source_print` already finds it.

## Two levels, both wanted

### 1. Storage: the same bytes, one blob

Invisible to the person, everywhere a private blob is written:

- `save_version` (record/documents.rs): before `put_encrypted(body)`, look up
  `body_print`. On a hit, name that `file_hash`. This widens the existing
  in-document reuse; the in-document lookup by `body_hash` stays as the first,
  cheapest check.
- Ingest (ingest.rs): the thumbnail and the body alike.

This is what fixes the album. Twenty-six tracks embedding one cover make one
thumbnail blob, **provided the thumbnail encode is deterministic**: the same
cover in, the same AVIF bytes out. Settle that with a test before anything else.
If the encoder isn't deterministic (thread scheduling inside rav1e, say),
`thumb_print` is taken over the **cover's own bytes** instead of the AVIF's, and
the rule is written down in the field's comment. Either way, a hit also skips
the encode.

### 2. Documents: the same upload, one document

The cognitive saving: Files shows one Pikachu. An upload (`docs/binary`, and the
video and drawing doors that make media documents) computes `source_print` over
the bytes as they arrived, before the crush, which is lossy and would give two
prints for one upload. On a hit against a live document:

- **No new document.** The upload answers with the existing document's id,
  marked `existing: true`. Nothing is queued for ingest and nothing new is
  stored.
- **The editor embeds the existing document.** A post dropping the meme into its
  words embeds the one already held, so fifty posts name one document and the
  Files list shows it once.
- **The person is told.** A line where the upload landed, like "You already had
  this one: _surprised pikachu_." Copy to settle when it's built.
- **Filing:** uploading into a notebook the document isn't in adds it there. A
  document can be in several notebooks already, so nothing is copied.
- **Titles:** the existing title stands. A different name on the second upload
  is not a rename. A person who wants two named copies can use **copy**, which
  deliberately makes a second document: a new document naming the same blob, so
  it costs no storage either.

A sound's tags (the last entry in HISTORY on them) ride the same rule: a
duplicate upload adds no fields, because the document already has its own.

Import (import.rs) sees the same thing for free. Re-importing an export into the
persona it came from finds every picture already held. Import has to treat an
`existing` answer as "already here" rather than "created", which matters for its
books step, since a page it didn't create is not its to defer.

## Cover art as thumbnails: the forcing function

With storage dedup in place, a sound's cover becomes its thumbnail with no
copies to regret:

- **Reading it:** symphonia exposes a container's embedded pictures as `Visual`s
  alongside the tags `read_tags` already reads - ID3 `APIC`, FLAC `PICTURE`, the
  iTunes `covr` atom. Take the front cover (or the only one), decode it through
  the image lane's own decoder and limits (an embedded picture is upload bytes
  like any other), and make the usual 128px thumbnail.
- **The waveform stays as the fallback**, for the sounds that have no cover:
  voice notes, sound effects, a recording made in the app.
- **The stored sound still carries nothing.** The crush strips the container's
  metadata, cover included; the cover lives only as the thumbnail, a blob of its
  own.

## What existing documents get

Versions written before this carry no prints, and their headers can't be
rewritten. A background pass, the same shape as the search index's (search.rs
`index_pass`), decrypts each private media blob once, prints it and records the
row, so new uploads dedup against old ones. Backfilled rows are view rows only.
A new device rebuilding the view from the chain finds no prints in those headers
and runs the same pass. Duplicates already in the store stay as they are.
Merging them - pointing old versions at one blob - would need new versions of
documents nobody edited, so it is not part of this. A "duplicates" view in Files
that offers to fold them is possible later.

## What it costs and what stays true

- **No new oracle for strangers.** Prints exist only inside encrypted headers
  and in the persona's own database (encrypted at rest), keyed by a key only
  members hold. Blob hashes stay ciphertext hashes, unforgeable and unlinkable
  as before.
- **A timing difference only the uploader can see.** A duplicate upload answers
  at once, a new one queues for ingest. It is the persona's own upload, so this
  tells them only what they already have.
- **Storage accounting:** `persona_blobs` counts a hash once per persona, so the
  "in all" total drops as it should. A document's own size (Files' size chip)
  counts the blobs it names, so twenty-six tracks each show the cover. That's
  true of each and only overstated if they're summed; Files never sums them.
- **Groups' member lanes are untouched.** Their bodies are plaintext by design
  (_Groups: The Member Lane_) and dedup by plain hash like public ones.

## Order of work

1. **The determinism test:** encode one cover to a thumbnail twice, in two
   threads; compare bytes. Decides `thumb_print`'s definition.
2. **Prints:** `print_key` and `print()` in proto, and header keys 24-26 with
   their round-trip tests.
3. **The view:** the migration rung, the fold on append, and the drop with a
   version.
4. **Storage dedup:** `save_version` and ingest look up before encrypting. Unit
   tests: two documents with one body name one blob; deleting one leaves the
   other readable; a public version never names a private blob and the reverse;
   a rotation in between still reuses; a hit on a blob the store no longer holds
   is a miss.
5. **Document dedup:** `source_print` on every media door, the `existing`
   answer, filing, the line in the UI, and import's handling. An acceptance
   claim: the same picture uploaded twice is one document in Files.
6. **Cover art:** read the front cover, thumbnail it, keep the waveform as the
   fallback. A fixture with a cover in it.
7. **The backfill pass.**

Steps 1-4 make the album cheap; 5 is the Pikachu; 6 is what started it.
