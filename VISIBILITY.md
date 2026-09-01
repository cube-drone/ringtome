# VISIBILITY - the author's flags on a post

Curtis's ask (2026-09-01): at posting time, two flags.

## Rulings

1. **"Settled" (no rebroadcast / no comment).** A wish, not cryptography: "people with
   malicious clients (or screenshots) could still rebroadcast or comment, but at the very
   least from our POV that is a settled post." Carried in the SIGNED header (key 15), so
   any holder checks it offline, like the reply link. Every surface we control honors it:
   the share button and reply box don't render; a friendly node's rebroadcast mint refuses;
   a reply publish naming a settled parent refuses; the author's door serves no replies and
   drops COMMENT envelopes about it. Tags stay allowed - a label is the labeller's speech
   about the post, not participation inside it.
2. **"Trusted only"** (slice 2, designed - not yet built): the node releases the post's
   CONTENT only to nodes serving users the author trusts; everyone else can see there WAS
   a post but not what it contained.

## Trusted-only mechanics (for ruling before slice 2)

- **What travels**: the chain entry must survive for the chain to verify, so the header
  travels; the BODY is the gated thing. Two candidate shapes: (a) header as today, body
  fetch gated - existence, title and date public, words gated; (b) external-payload header
  (hash-only on the chain), everything but existence gated. (a) is nearly free; (b) hides
  the title too but reshapes the wire. **Open question for Curtis: is the title public?**
- **Who counts as trusted**: the author's PUBLISHED trust edges (FOLLOWS_PUBLIC bands) -
  already public, already folded everywhere.
- **How a node proves its users**: it doesn't have to claim anything - the serving records
  are signed by each identity's OWN chain, so "endpoint E serves trusted person P" is P's
  own signed statement. The gate: release the body to endpoints appearing in the serving
  record of at least one trusted persona; over HTTP, to sessions whose signed-in persona
  the author trusts. Friendly nodes apply the same check for their local readers.
- **Interplay**: trusted-only WITH rebroadcast allowed means the pointer spreads and the
  body stays gated - the existing hollow rendering is exactly the read for it.

## Slices

1. **Settled.** Header key 15 + `settled` through PublicText/save/publish; doc memo
   columns (user gen 20); refusals at the four doors; UI checkbox at the composer, hidden
   share/reply affordances, a quiet "the author settled this post" note. ~~(building)~~
   Built 2026-09-01 (user gen 20; header key 15; acceptance in settled_posts.cjs).
   Residuals: a COMMENT envelope about a settled post still transcribes to the bell (only
   malicious clients can send one - honest repliers are refused at publish); feed cards of
   OTHERS' settled posts still render the share button until the feed dressing carries the
   flag (the mint refuses with words either way).
2. **Trusted-only.** After the title ruling above.
