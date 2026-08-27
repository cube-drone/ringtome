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
- A stranger's reply reaches the author by envelope only; whether it joins the visible
  conversation is the AUTHOR's call - the nod, slice 6's curation model (ruled
  2026-08-26, superseding an earlier "leaning no").

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
- **The feed never assembles a tree** (Curtis, 2026-08-26): replies land as separate
  reverse-chron entries, each wearing its quoted-parent context - browsing meets "C to B",
  then "B to A", then "A", and that is correct. The post's own page is where the visible
  tree assembles, and the only place.

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
2. ~~**Assembly + the thread.**~~ Built 2026-08-26 (node gen 29; acceptance in
   `comments.cjs`, the sweep planted red). The `post_replies` memo (`replies.rs`, node-
   level): two sources, two lifecycles - chain-held rows ride the fold lane
   (`refresh_from` in `fold::run_chain`, stamp-swept per replier so a deleted reply
   recedes on the fold that noticed) and fragment-held rows live and die with the
   fragment (`note_reply` at intake, `forget_reply` on the drop path, deferring to the
   chain sweep when the chain is also held). The cursor-paged read
   (`GET /api/id/{author}/posts/{doc}/replies`, keyset by claimed_ms + doc, oldest first,
   twenty a page) serves DIRECT replies per level; the permalink recurses per level to a
   depth cap with "continue this thread" beyond it, under a "replies known here" header
   and an honest "none known here yet" empty state. Honest-partial proven both ways in
   acceptance: the node holding the repliers' chains knows the thread; the author's node,
   holding neither, honestly knows nothing until slice 6's door.
3. ~~**The composer and the feed.**~~ Built 2026-08-26 (node gen 30; the links join
   planted red). The feed dresses reply rows from the replies memo - `replies::links_for`
   (which of this page's rows are replies) joined with `fanout::journal_cards` (the
   parent's title and stamp from the reader's own journal), two page-scoped node reads,
   never per row - so a reply carries `reply_to: {author, doc_id, name?, title?,
   published_ms?}` and renders with the quote-card ("in reply to" + the mini-card),
   exactly as partial as the memo and degrading to a bare "link". The permalink grew
   parent context above the post (same card, one hop up) and the reply box: plaintext,
   mints a real feed-bucketed document and publishes it with `reply_to` - a reply is an
   ordinary post, so it is editable in the feed app like any other - with the words
   staying in the box on refusal, and the fresh reply joining the thread ahead of the
   fold (the view-runs-ahead idiom). The share/reply pair collapses at render
   (`collapseReplyPairs`, pure and unit-tested): only a share-journaled row whose lead
   sharer's reply is on screen yields - a direct-follow row is first-class and never
   collapses, and the journal stays honest about both rows by ruling. Two lookup indexes
   landed with it (`post_replies_by_reply`, `post_replies_by_replier`) so the feed join,
   the fragment drop, and the fold sweep all walk an index.
4. ~~**Comment notices.**~~ Built 2026-08-27 (the mint planted red). `notice_kind::
   COMMENT` (3), both roads. Envelope: publish-with-reply seals the notice to the PARENT's
   author with the reply's own signed header as evidence - `verify_claim` checks the
   header's `reply_to` names the recipient, and the claim's doc is the PARENT (the
   reader's post, where the thread assembles and the bell's mini-card points). Derived:
   the notifications fold reads the replier's public replies beside their edges and shares
   (same single open) and upserts a `comment` row for hosted parent-authors who follow
   them, receding by diff when the reply leaves the shelf. **One act, one notice**: the
   reply's parent pin goes QUIET on both roads (`share_one` grew `announce`; the derived
   shares leg skips parent-pin rows) - the comment says everything "shared your post"
   would; the nested reply's ROOT pin still announces as the share it genuinely is. The
   tier fell out of the classifier unchanged: comment is not in the murmur arm, so it
   tiers by sender - trusted/stranger - exactly as ruled. The roads dedupe free: the
   gate's follow-edge rule refuses envelopes from followed senders, and the bell hides
   delivered copies for owned senders. One read-side rule landed with the slice (caught by
   the deleted-reply case): a delivered row from a sender the reader now PULLS never
   shows, twin present or not - the derived path owns the fact's absence too, and a stale
   stranger envelope must not resurrect a deleted reply.
5. **Polish and the named edges.** Parent-media covers proven; hollow rendering ("in reply
   to a retracted post"); the double-presence collapse audited; retraction-of-reply
   retracting its pins proven at depth.
6. **The author's thread door** (rulings 2026-08-26). The author is structurally the
   best-informed node about their own post's thread - every reply anywhere announces
   itself to them, by sync or by envelope - so their node serves a reply INDEX to anyone
   who asks: `WantReplies(post, cursor)` / `Replies` on the fragment ALPN, the
   death-cursor idiom verbatim - cursor-paged, answering with the repliers' own SIGNED
   evidence (header entries naming the parent), verifiable offline; the reader fetches the
   words through ordinary machinery. The author serves claims, never redistributes words.
   **Curation is the same bit as display**: trusted-tier replies are served automatically;
   an anonymous reply waits for the author's explicit "approve comment" nod before it
   joins the conversation - and a per-author client setting flips the default to
   auto-share-all, turning the choice into suppressing specific comments instead. Honest
   limit, stated: suppression mutes the author's amplification, never the reply's
   existence on its own author's chain. The "no comments" switch (NEXT_STEPS) is
   suppress-all. **Reading side**: visiting the permalink IS the demand - the node asks
   the author's door behind the render (the stale-while-revalidate idiom, budget-capped),
   the thread UI shows a quiet "looking for more of the conversation" indicator while the
   ask is in flight, and a refresh affordance re-asks on demand, because a hot thread is
   worth a second glance.

## What this deliberately is not

Not a shared discussion object: there is no thread document, no moderator-owned space, no
edit of anyone else's context. A thread is a fold over signed, self-owned posts - each
party's words on their own chain, each pin honoring its author's control, and the whole
thing assembles or degrades node by node, like everything else here.
