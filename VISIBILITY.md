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

## Trusted-only rulings (Curtis, 2026-09-01)

1. **Title public, body gated.** The header travels as today - existence, title, date,
   format, thumbnail are the post's public face; the BODY (and its media blobs) is the
   gated thing. The hollow card reads title + date + "for trusted readers".
2. **Trusted = any published trust band.** The author's FOLLOWS_PUBLIC edges, any level:
   "trusted only" means "people I've marked at all". Checked at serve time, so trust
   published later opens older posts, and revoked trust closes future serving (copies
   already delivered are the honest-parties caveat, as everywhere).
3. **Replies allowed.** A reply is the replier's own public speech; the thread is only as
   private as its least discreet participant, and that is their responsibility.
4. **Rebroadcast: allowed, and SHARER-SCOPED** (Curtis's design): every act is scoped by
   its own actor. The body gates by the AUTHOR's trust; the share pointer journals only
   into feeds of readers the SHARER publishes trust for - so the post travels through
   chains of trust umbrellas instead of appearing as hollow cards in strangers' feeds.
   Enforced at the journaling fold (honest-surface, like everything: the pointer entry
   stays an ordinary public statement on the sharer's chain). Re-sharing self-limits: the
   existing "can't share what it hasn't read" mint rule means every sharer can open the
   body, i.e. is author-trusted. "Trusted-only + no-rebroadcast" is then the strict tier:
   my network and nothing beyond it.

## Trusted-only mechanics (as designed before the rulings)

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

## Slice 2a built (2026-09-01): the HTTP door and the wire

Header key 16 (`trusted_only`, carried like `settled`); both doc memos and the feed journal
carry it (user gen 21, node gen 37 - `just clean`); the composer grows "only show to people
I trust"; the body route refuses untrusted sessions with honest words (thumbnail stays
public by the title ruling), checked at serve time against the author's published trust
edges; the card and the post page say "the author shares these words only with people they
trust" instead of the waiting dot. Acceptance in trusted_posts.cjs.

## Slice 2b - the remaining doors, in danger order

1. **The blob lane leaks.** Bodies travel node-to-node by content hash over the iroh-blobs
   ALPN, which serves the whole store to any peer - and the public header names the hash.
   Until this closes, a gated body is withheld from browsers but fetchable by any NODE that
   asks the blob door directly. iroh-blobs 0.103's provider events carry a
   permission-denied abort (`events.rs`: "the client does not have permission"), so the
   shape is an EventSender hook: deny gated hashes unless the dialing endpoint resolves
   (via `identity_peers` / serving records) to a persona the author trusts.
2. **Media twins.** A gated post's images are separate media documents; their headers must
   inherit `trusted_only` at the bake mints (store.rs inline-embed twin, bake.rs external
   twin) or the pictures stay public while the words are gated.
3. **Sharer-scoped share journaling** (ruling 4): the share pointer journals only into
   feeds the SHARER publishes trust for.
4. **Friendly-node display**: a trusted mirror re-serving the body applies the same
   published-trust check for its local readers (the HTTP gate already does this wherever
   the author's chains are mirrored, since it reads the author's own edges).

## Amendment (2026-09-01): discovery never carries a trusted-only post

Curtis: "Do trusted-only items show up in discovery? They shouldn't." They did - the
speculative journal lane took the newest page wholesale. Now filtered at the lane:
followers still get the (hollow, for the untrusted) row because they chose the author;
the speculative lane, which nobody chose, carries no gated posts at all.

## Slice 2b built (2026-09-01): sealed bodies, gated keys

The deny-hook design is retired before it was built, on Curtis's argument: serve-time
gating makes every holder an enforcement point, and "many nodes are malicious" is the
assumption. And against "isn't a careful key the same model as a careful hash": the hash
already has public jobs (signed beside the title, the ETag, the wants) so it cannot be a
secret, and even a secret hash leaves plaintext at rest behind every holder's door -
availability and confidentiality at war. Encryption makes them orthogonal.

Built: a trusted-only body is SEALED at mint under a fresh per-post key (epoch sentinel
u64::MAX, the private lane's own blob shape). `file_hash` names the ciphertext - public,
spreadable, harmless; `body_hash` keeps the keyed plaintext fingerprint for verification.
The key lives on the draft's private meta (`trusted_key`, device-durable, excluded from
publish replication like `published_as`) and in the node's `post_keys` memo (gen 38). The
blob lane needs no gate at all. The gated thing is the key: the HTTP door decrypts for
readers who pass the trust check, and a trusted reader's node earns the key once over the
fragment lane's `WantKey` door, whose release check ties the dialing endpoint - through
the peer ledger's signed serving records - to the author or a trusted subject. "Not here"
and "not for you" answer identically.

Residuals: media twins still mint plaintext (a gated post's pictures are not yet sealed -
next); key rotation on trust revocation is future-posts-only by the honest-parties floor;
the no-op publish bounce is skipped for sealed posts (nonce moves the ciphertext hash).

## Note (2026-09-02): key release requires having MET the trusted reader

The release check ties a dialing endpoint to a trusted persona through that persona s own
signed serving records, resolved from their identity chain - so an author who publishes
trust for a root their node has never fetched leaves that reader s key asks refused until
the chains are met. The app makes this a non-case (trust is dialed from a profile page,
which is the meeting), and the two-hop acceptance now performs the same ceremony.

## Amendment (2026-09-02): the feed never shows a sealed post its reader cannot open

Curtis: a hollow "shares these words only with people they trust" card in the feed is
worse than nothing. The feed read now drops trusted-only rows unless the author's
published trust names the reader (or the reader is the author) - checked live, so the row
APPEARS the moment trust is published, and fails closed where the author is unmirrored.
The journal still carries every row (the memo knows; the surface chooses), and the
permalink keeps its honest line for a direct visit.
