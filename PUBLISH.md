# PUBLISH - publishing from Writer

Curtis's brief (2026-09-02): a "publish" button on a document in Writer. Publishing crosses
private -> public through the same door the Feed uses, but bucket-aware: the post carries its
tags, its bucket, and its PREFERRED DATE. Posts show in feeds like any other, except that a
past date sorts the post into that past, and a future date holds it back from other users
until the date.

## Rulings (Curtis, 2026-09-02)

1. **The date rides the signed header** (key 17, `dated_ms`), so every surface sorts alike -
   the shelf, every feed journal, fragments carried by strangers. `genesis_ms` stays "when it
   was minted": the edit window's anchor. Display and sort use `dated_ms ?? genesis_ms`.
2. **A past date sorts into the past.** The post is still NEW to a node that just learned it
   (fresh-arrivals bar, notifications): "my friend published an old diary entry" is news.
3. **A future date is a SCHEDULE, not a sealed entry.** Nothing touches the public chain
   until the date; the draft carries a `publish_at` mark on its private meta (device-durable),
   and the author's node mints it when due. A sealed-but-present entry would leak existence
   and title; a scheduled one does not exist yet.
4. **Editing a past-dated post** anchors on mint time, never the claimed date - otherwise a
   post dated 2019 could never be corrected. Changing the date after publishing is allowed
   within the edit window (it re-sorts everywhere) and frozen after, like the words.
5. **Scheduled posts show to their AUTHOR** - in their own feed and on their own persona card,
   sorted to the top (a future time is later than everything that exists), marked
   "scheduled". Other users see nothing until the mint.
6. **Status icons**, each in its own colour from the current scheme: private = `detective`
   (teal), public = `globe-hemisphere-west` (gray), scheduled = `clock-countdown` (peach).
7. **A bare date is a day, at the publication's own hour** (Curtis, 2026-09-02): backdating
   a Friday-8PM post by three days makes it Tuesday 8PM, not Tuesday midnight. The claim is
   in the author's LOCAL time - the browser's timezone offset rides every publish, so the
   header carries one stamp for every reader.
8. **Taxonomy is not an annotation.** The tree is a separate private structure; a public
   position would need its own public form later (a published composed taxonomy). This arc
   carries date, bucket, and tags only.

## Slices

1. ~~**The date on the wire.**~~ Built 2026-09-02 (header key 17; user gen 22; acceptance in
   dated_posts.cjs; the header resolves the local claim with the browser's offset, a bare
   day at the publication's own hour). Header key 17; doc memos and the feed journal carry `dated_ms`;
   the publish door reads the draft's `date` field into it; every sort surface (shelf keyset,
   feed journal stamp, fragment-journaled rows) uses the dated stamp; the edit window keeps
   genesis. Acceptance: a past-dated post lands in the past on a follower's feed and on the
   author's shelf.
2. **Scheduling.** A future date at publish writes `publish_at` on the draft's private meta and
   mints nothing; a sweep on the author's node mints when due (the mark names the minting
   device, so two devices cannot race); the author's feed and card show the scheduled draft
   at the top with the badge.
3. **The Writer button and the status icons.** Publish from the document surface through the
   same door; the three icons with their colours on every list row.
