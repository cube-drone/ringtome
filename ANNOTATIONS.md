# Annotations — what a post is said to be, by whom

*The public-annotations arc (rulings 2026-08-29). Today tags, description, claimed date, and
bucket are private facts on a document's `doc-meta` lane; publishing a note copies its
header and body into a public post and none of that. This arc makes annotations public
speech — the author's and everyone else's — carried the way everything public here is
carried: signed on the speaker's own chain, reached by subscription or virally with the post,
and filtered by the reader.*

## The problem

A tag is currently a filing tool: it never leaves your persona. But "what is this post?" is
the most useful thing a network can say about a post, and the two people who can say it are
the author (who filed it) and the readers (who react to it). Neither can speak today.

## The shape (rulings, 2026-08-29)

1. **A public annotation is a statement on the SPEAKER's chain**: `ANNOTATIONS_PUBLIC`, a new
   service, holding LWW statements keyed `(target author, target doc, key, value)` — one
   statement per tag (`tag=saucy` present or retracted), one per single-valued key
   (`description`, `bucket`, the claimed date). Mine when I annotate my own post, my friend's
   when they tag mine "goopy". Same statement, same fold, whoever speaks; retraction is the
   empty statement, like an edge. Never a shared object: nobody edits anyone else's label.
2. **Publishing replicates the draft's annotations, ALL of them, bucket included** (Curtis).
   Copy-don't-flip holds: the draft keeps its private facts; the public post gets public
   statements minted beside it, on the author's own chain. The bucket comes too because
   publication already comes only through a bucket you chose to publish from, and publishing
   a whole "therapy" bucket would itself be the decision — the bucket name is not a leak, it
   is the label. "Within reason" is caps: counts and lengths, never a category exclusion -
   a tag is 32 characters (Curtis, 2026-08-31), anything else the wire's 1024, and a label
   past its cap is refused with words, never quietly shortened.
3. **Later edits are statements, not versions.** Posts freeze after the edit window; tags on
   the signed header would freeze with them. The chain is what keeps annotations mutable for
   life; the fragment's snapshot (below) is what keeps them viral.
4. **Two roads to a reader, the rebroadcast idiom.** By subscription: a node syncing an
   annotator's chain folds their statements into the node-level `doc_annotations` memo.
   Virally: a post's FRAGMENT carries every annotation the relaying node knows for that post —
   the author's and third parties' alike — each as `(annotator, signed entry, auth path)`,
   verified at the receiving edge against its own annotator exactly as a reply proof is. The
   network carries all it knows (Curtis: "posts carry all known non-blocked annotations").
5. **The reader decides what shows.** Acquisition and attention split, as for the feed: the
   memo holds everything that arrived; a persona-level display register says which
   annotators' labels render — the author's only, the author's plus people I follow, or
   everyone's (the default, ruled 2026-08-31: a label is a claim under a name, and the name
   is the safeguard) — and a blocked annotator's never render, whatever the stop.
   Read-time, network-silent both ways.
6. **Provenance is always on the label.** The author's annotations render plain; anyone
   else's carry the annotator's byline — "goopy — Mara". Labels are never merged into one
   anonymous cloud: every one names a human, the crowd rule, the byline rule.
7. **A third party's annotation of your post is news** — `notice_kind::TAGGED`, both roads,
   the COMMENT envelope's twin (evidence: the annotation entry naming the recipient's doc).
   A murmur, not first-class: it is closer to a share than a conversation.

## Consequences worth saying out loud

- The description key has one author who matters; a third party's "description" is a
  comment-shaped thing. The display register may treat non-author descriptions as tags-grade
  (shown only at "everyone"), and the UI shows one description: the author's.
- A public bucket annotation is the seed of a browsable public collection ("Curtis's blog") —
  NEXT_STEPS' "make a whole bucket public in one fell swoop" grows from it, not before it.
- Search over public tags is a consumer, deliberately after: the memo precedes its consumers.

## Invariants

- Annotations are the speaker's signed claims; no relay can mint, alter, or re-target one.
- Everything verifies offline at the receiving edge, per statement, against its annotator.
- Nothing grows with history unbounded: per-post annotation counts are capped at mint and at
  relay; memo reads are page-scoped by the posts on screen.
- Explicit beats implicit; blocked beats everything — at read.
- The memo is disposable: rebuildable from held chains plus held fragments.

## Slices, in order

1. ~~**The wire and the mint.**~~ Built 2026-08-29 (user gen 18; acceptance in
   `public_annotations.cjs`; the replication planted red). `service::ANNOTATIONS_PUBLIC` (12) and
   `entry_type::PUBLIC_ANNOTATION` (12), the `PublicAnnotation` statement (target, key,
   value, present) with the codec's own caps (key 64, value 1024 - a relay cannot be made
   to carry a novel), re-exported beside `Rebroadcast`. The speaker's `public_annotations`
   view folds LWW per (target, key, value) exactly as rebroadcasts fold per (author, doc),
   retraction kept as a tombstone so an older statement cannot win it back. Store accessor
   `public_annotations().say/of`; HTTP `GET/PUT .../public-annotations/{author}/{doc}` and
   `DELETE .../{key}/{value}`. Publish restates every annotation the draft carries - tags
   (capped at 32), every set field, and its buckets - about the fresh post, best-effort
   beside the publish like the pins, and as a DIFF against what the chain already says
   (an untouched re-post mints nothing; a tag removed from the draft is retracted in
   public on the next post). The permalink read carries the author's own
   statements from the author's shelf, so a mirror-holding node answers too - which is the
   sync scope proven: the new service is public by the roster's default, and it crossed
   the wire with the rest of the persona untouched.
2. ~~**The memo and the reads.**~~ Built 2026-08-30 (node gen 32; acceptance in
   `public_annotations.cjs`). `doc_annotations` (`annotations.rs`, node-level), one row per
   (target, annotator, key, value), folded on the fold lane as its own leg - gated on the
   annotations chain moving, incremental by stamp, a retraction deleting the row. The
   feed dresses every row with every known label (author's first, others bylined by
   annotator name), and the permalink merges the author's own shelf statements
   (read-your-writes) with the memo. UI: label chips - the author's plain, anyone else's
   dashed with "— name"; buckets read "in blog", descriptions "about …", and the author's
   description is the one description. The display register (`annotations_display/stop`,
   persona-level, a select beside the selectivity slider) filters at the client through
   `pure/annotations.js`: author-only / author + followed / everyone (the default since 2026-08-31),
   blocked never, and no persona signed in reads as author-only. Proven across two nodes: the
   author's labels dress a follower's feed; a friend's tag arrives by subscription
   naming the friend, and its retraction takes the row with it. The fragment road (every
   surface on nodes holding only a fragment) is slice 3.
3. ~~**Viral.**~~ Built 2026-08-30 (node gen 33; the two-hop acceptance in
   `public_annotations.cjs`). `Have` grew a fourth field: the annotation proofs the
   answering node chose to attach - each the ANNOTATOR's own signed statement with its
   delegation path, byte-budgeted (6KB, author's labels first, so the ones most worth
   carrying are the last dropped) under the 16KB frame. `verify_annotation` binds every
   proof to its annotator AND to exactly the post it rode with - a relay can withhold a
   label, never re-target one - and retractions ride like anything else, folding as the
   chain would. Received proofs are noted into the memo and KEPT (`annotation_proofs`),
   so the next hop's fragment carries them onward: virality is a relay of proofs, never
   hearsay - proven two hops out, where a node that has met nobody but its own introducer
   holds both the author's and a friend's labels, each still signed by its own annotator.
   Revalidation refreshes for free (every Want re-learns). Named residual: a retraction
   reaches fragment-held labels only when some fragment carries it or the annotator's
   chain is met - the reply-evidence residual's sibling, same road when it is built.
4. **Others' labels.** ~~Third-party tagging UI on any post~~ (built 2026-08-30: "+ tag"
   on every post card for any signed-in reader, an × on labels you authored; tagging your
   OWN post also files the tag on the private draft via its `published_as` back-reference,
   so the publish diff cannot retract it - best-effort for sync lag only, since the draft
   chain reaches every member device; said/unsaid labels ride the card's overlay). Identical labels
   collapse into one chip - most-agreed first, names smashed ("Jeff Dorp and 3 others") -
   and a chip you have not said yet is itself the agree button (2026-08-31).
   ~~`notice_kind::TAGGED` both roads~~ (built 2026-08-31, at Curtis's ask: the comment
   notice's twin - a murmur, the lowest ring whoever sent it. Envelope road: the tag PUT
   seals the annotation entry itself to the post's author when that is somebody else;
   `verify_claim` binds it by `target_author == recipient` and refuses a withdrawal. Derived
   road: the notifications fold reads the annotator's public annotations when that chain
   moves, one `tagged` row per (reader, annotator, post) under the follow-edge rule, receded
   by diff. The bell reads `labelled "goopy"` - the claim carries the
   label's own words on both roads (`detail`, 2026-08-31) - with the post's card).
5. **Collections.** Public buckets as browsable pages; search over public tags.

## What this deliberately is not

Not folksonomy-as-truth: there is no global tag namespace and no vote count, only people
saying things under their own names, and a reader choosing whose words to weigh.
