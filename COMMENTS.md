# Comments — rebroadcast plus your own words

*The conversation arc (2026-08-26). PROJECT_PLAN's "Replies are rebroadcast plus a comment
(second cut, deliberately after)" pulled forward as canon, its open questions ruled, and the
work sliced. The "deliberately after" is satisfied: plain rebroadcast shipped whole — pointers,
fragments, covers, retraction cursors, the edit window, share notifications, the murmurs tier,
and the post permalink the thread renders on.*

## The problem

People want to talk about posts. The model must survive this network's physics: no shared
writable objects, every word on its author's own chain, deletion that composes, context that
degrades gracefully with node death, and costs that never grow with thread depth or history.

## The shape (rulings, 2026-08-26)

**A reply is a quote: rebroadcast + your own comment doc, linked.** Your words are yours
forever, on your chain, an ordinary post in every mechanical respect — tombstones, the edit
window, freezing, shares of it, notifications about it all apply with zero new cases. The
context is a replica that honors its author's control: if they retract the post you replied
to, your reply stands over "in reply to a retracted post" — the hollow rendering composes.

1. **The link lives on the comment's signed header** (beside `refs`, the precedent for a
   header naming what its doc depends on): `reply_to` (author root + doc id) and
   `thread_root` (likewise; equal to `reply_to` when replying to a top-level post, copied
   from the parent's own claim otherwise). Verifiable, travels with every fragment and
   share, resolvable offline. The rebroadcast pointer is untouched — its LWW-per-(author,
   doc) semantics stay exactly as built. A lied-about root is self-scoped: their reply
   renders under the wrong thread, and any holder of the parent can see the mismatch.
2. **A reply pins parent-plus-root, never the ancestor path.** Two pointers minted with the
   comment (deduped when the parent is the root). Depth-N stays O(1) per reply; context
   degrades hop by hop; a hot root pinned by every direct replier is the named, accepted
   cost.
3. **A reply IS a recommendation** (Curtis, overruling the draft's pin-flavor split): the
   minted pointers are ordinary rebroadcasts — share-fold journaling, via bylines, crowd
   counts and all. Commenting on a thing spreads it into your network; that is an
   indication of interest at the very least, and if someone does not want a post in their
   network, they should not comment on it. One pointer kind, one semantics, no flavor
   flag.
4. **Replies are ordinary posts in followers' feeds**, rendered with the parent as quoted
   context (the mini-card idiom, grown). Context-free "@rando, I disagree" is exactly what
   this design exists to prevent. A per-reader dial for quieting replies can ride the
   selectivity machinery later if lived use asks.
5. **Comment notices are first-class, not murmurs** (`notice_kind::COMMENT`): a comment on
   your post is conversation — follow-grade signal — tiered trusted/stranger by sender
   like public-edge, with the derived twin for followed repliers and the mini-card
   rendering. The murmurs tier keeps what barely matters; this matters.
6. **Assembly is honest-partial.** Nobody's chain holds "all replies to P". The node folds
   reply headers from chains it syncs, fragments that arrive, and comment notices into a
   replies memo; the permalink shows **"replies known here"**, cursor-paged (a thread is a
   read whose cost grows with history, so it ships with a cursor or not at all). This is
   pull-not-push applied to conversations, stated as a decision.
7. **The pin covers the parent's media** — same rule one level, budget per covered post,
   riding the existing `fragment_covers` refcounts. A reply over a hollow parent is the
   degraded case that already renders.

**The pin lives and dies with the comment**: deleting your reply retracts its pointers the
same way un-sharing does — the parent replica obligation was the reply's, and the reply is
gone. (The comment doc's tombstone and the pointer retractions mint together.)

## Consequences worth saying out loud

- A follower of yours may meet a thread twice: the parent journaled by your share (bylined
  via you) and your reply as your own post. The feed's quote-card rendering should collapse
  the pair; the journal stays honest about both rows.
- The author of a hot post hears every reply as a first-class notice, gated by the same
  door as follows — flow ranking (Trust) is where reply-flood pressure goes when it comes.
- A stranger's reply reaches the author by envelope only; the author's node holds the
  reply's evidence and can render it. Whether it joins the public "replies known here"
  memo before the author engages is slice 4's judgment call, leaning no (an unadmitted
  stranger's words appear to the AUTHOR, not to the author's readers).

## Invariants

- A comment is an ordinary public post; every existing rule (edit window, tombstones,
  freezing, fragment lifecycle) applies unchanged, and any new special case is a design
  smell.
- Reply links are the author's own signed claims; no relay can mint, alter, or re-parent a
  reply.
- No cost grows with depth: parent + root, never the path.
- No read grows with history unbounded: the replies memo pages by cursor.
- The rebroadcast chain's semantics are untouched: one pointer kind, recommendation
  included.

## Slices, in order

1. ~~**The wire and the mint.**~~ Built 2026-08-26 (user gen 17; acceptance in
   `comments.cjs`, five claims; the root-copy planted red; proto pins the pair rule -
   a thread root without a parent is not a shape the codec carries, either way round).
   `reply_to` + `thread_root` ride the signed header as additive map keys beside `refs`,
   wire-absent for a non-reply, carried forward on re-publication like genesis (an edit
   must not re-parent a conversation), and round-trip the whole storage path
   (`doc_versions` and `doc_heads` grew the columns - the heads memo reconstructs headers
   from columns, the slice's one field finding). Publishing with `reply_to` resolves the
   parent from its held header (mirror shelf first, fragment shelf second; a blind reply
   refuses with words), copies the root from the parent's own claim, and mints the
   parent-plus-root pins through the SAME share act as the rebroadcast button
   (`share_one`, factored) - notice, backfill, eager knock and all, because a reply is a
   recommendation. Your own posts pin nothing; pins are best-effort beside the publish
   (the words must not fail with a pointer); a deleted reply retracts its pins
   (`unpublish`, reading its own links before the tombstone lands). The single-post JSON
   serves both links, so slice 2's thread rendering has its data waiting.
2. **Assembly + the thread.** The replies memo (node-level, folded on the fold lane),
   the cursor-paged replies read on the single-post surface, and the permalink rendering
   the thread: parent context above, replies below, "replies known here" honesty in the
   copy.
3. **The composer and the feed.** Reply box on the permalink; the feed's quote-card
   rendering of replies (and the share/reply pair collapsed).
4. **Comment notices.** `notice_kind::COMMENT` both roads (derived for followed repliers,
   envelope for strangers), first-class tier, mini-card in the bell linking to the thread.
5. **Polish and the named edges.** Parent-media covers proven; hollow rendering ("in reply
   to a retracted post"); the double-presence collapse audited; retraction-of-reply
   retracting its pins proven at depth.

## What this deliberately is not

Not a shared discussion object: there is no thread document, no moderator-owned space, no
edit of anyone else's context. A thread is a fold over signed, self-owned posts - each
party's words on their own chain, each pin honoring its author's control, and the whole
thing assembles or degrades node by node, like everything else here.
