# Scanning: pictures, CSAM and the operator

_A design draft (2026-11-02). Built: steps 1 to 4 of the order, 2026-11-02 (see
HISTORY)._

What an operator needs so that hosting other people's pictures doesn't become
their liability, when the operator is one person and not an organization
(Curtis, 2026-11-02: "I am super not an organization: I'm a guy. Regular dude.
Project Arachnid _shouldn't_ give me access to their API"). It amends
PROJECT_PLAN's _Hash Lists and Scanning_, which assumed every operator signs up
for their own Shield key: most Horse Drawing Tycoon 2 operators won't, and
shouldn't, so nothing here depends on one. [MODERATION.md](MODERATION.md) uses
the fingerprints this plan computes.

Not legal advice. The duties sketched below are worth checking with whoever
reviews the terms.

## Rulings

1. **Liability comes from knowing and not acting, not from not scanning.** No
   law we know of requires an individual operator to scan proactively; the
   duties start with knowledge - act, preserve, report (in Canada, the mandatory
   reporting act covers people providing an internet service to the public, and
   Cybertip.ca takes reports). So the first thing to build is what an operator
   does the moment they find out.
2. **Scanning lives in front of the node, not in it** (Curtis, 2026-11-02:
   "Other node operators can use Bunny, Cloudflare, or other CSAM-scanning
   intermediary layers to protect themselves"). An upload-scanning CDN checks
   pictures before they reach the node, and reports matches itself. The node's
   part is to route every stranger's upload through its public HTTPS address, so
   whatever sits in front of it applies.
3. **A CSAM report never carries the picture.** It names the item; the picture
   stays where it is.
4. **Fingerprints of our own decisions are ours to use.** A picture the operator
   has removed is refused when it comes back re-encoded or cropped, from anyone,
   with nobody's permission needed.
5. **No clearinghouse is required.** A scanner interface stays, so an operator
   who is an organization can plug in Shield or another API, but nothing depends
   on one.

## Scanning in front of the node: Bunny's Upload Scanning

What hdt.com uses, and what SERVER.md will point operators at as one example of
the kind. From Bunny's documentation
([Upload Scanning](https://bunny.net/docs/shield/upload-scanning), and the
[launch post](https://bunny.net/blog/introducing-bunny-shield-upload-scanning-the-end-of-risky-uploads/)),
read 2026-11-02:

- It scans uploads **inline, before they reach the origin**: multipart form
  files, base64-encoded strings and raw request bodies, up to 100 MiB on the
  Basic plan.
- CSAM detection turns each picture into a PDQ hash and checks it against a
  third-party database (unnamed; Bunny says it is bringing this in-house).
- On a match the upload is blocked at the edge, "before they can be stored,
  accessed, or executed"; the event is logged with the content redacted; and
  "positive CSAM results are automatically reported to authorities through the
  third-party partner".
- CSAM detection is on every plan, free up to 1% of clean requests (250,000
  scans a month on Basic), then $0.70 per million.

What that covers: every upload a browser makes to the node, since uploads arrive
in the clear (the node crushes them), and every report picture, since those
travel over HTTPS too (MODERATION.md). So an attacker can't use the report
queue, or an ordinary upload, to put CSAM on hdt.com's disk.

What it doesn't:

- **Anything arriving peer to peer.** Blobs synced from other nodes over iroh,
  and outside pictures a publish downloads (`record/bake.rs`, an outbound
  fetch), never cross the CDN. Ruling 4's refusal list is for those.
- **Video, probably.** PDQ is a still-picture hash.
- **Device nodes**, which have no CDN. They don't take strangers' uploads or
  strangers' reports, so they don't need one.

Operators who accept reports from strangers (MODERATION.md) or open registration
are **strongly advised** to put an upload-scanning layer in front of their node;
SERVER.md says so, and the node admin settings show the advice beside the
switches that open the door.

## When an operator finds out: quarantine

From a report, a match the operator hears about, or their own eyes. One action
on any picture the node holds:

- **Quarantine**: the blob is sealed - kept, not deleted, because preserving it
  can be a legal duty - and stops being served everywhere on the node at once:
  web, app and sync.
- **What to do now**: a page saying the operator likely has duties to report and
  to preserve, where to report (Cybertip.ca in Canada, NCMEC in the US, the
  local equivalent elsewhere), and what the node has kept for them.
- **The fingerprint** goes on the node's private refusal list (below), so the
  picture can't come back.
- **Release** after the preservation period, or if the operator was wrong.

The node never fetches a reported picture by itself to look at it; a human asks
for it.

## Fingerprints: PDQ

PDQ (Meta's perceptual hash) is a fingerprint for any picture, not only CSAM:
re-encodes, resizes and crops of the same picture land close together.

- **Every picture is fingerprinted once.** Uploads at crush (`src/media.rs`),
  where the picture is already decoded, so no new decoder of hostile bytes;
  pictures arriving by sync on the same decode lane, after the fact; drawings
  from their rendered image. The result is cached by blob hash. As built
  (`src/prints.rs`): on demand, not swept - the first time a picture entry, a
  reader's card or the refusal list needs a picture's print - from our own
  crushed AVIF, so an upload and a peer's copy hash from the same bytes.
- **A Rust crate, checked first.** `pdqhash` (Apache-2.0) and `yume-pdq` exist;
  whichever is used must reproduce Meta's reference outputs before anything
  trusts it.
- **Video**: a few keyframes' fingerprints, later.

### The node's private refusal list

What the operator quarantined, by exact hash and PDQ. Refused at upload, at sync
and at serve. **Never published**: a public list of perceptual hashes lets an
attacker test edits until one gets past, and CSAM fingerprints are never
published anywhere. Nobody labels anything "CSAM" in public.

### Community picture entries

The same fingerprints ride MODERATION.md's lists, for pictures that are merely
unpleasant - the operator's or any moderator's "excise this image from my
network" - and travel by the same trust. Their rule: **an exact match acts at
the entry's level; a PDQ near-match only ever warns.** Perceptual hashes can be
collided as well as evaded: an adversary can build pornography that fingerprints
like someone's popular drawing, report it, and have the drawing blocked
everywhere in good faith. Warn-only means a collision can put a click-through
over an innocent picture, never take it away, and a reader can overrule it like
any entry.

## Not admission limits

An earlier draft of this plan (mine, never ruled on) held new or unvouched
accounts' pictures back from the public until they had been around a while.
Pulled (Curtis, 2026-11-02: "There are already a lot of ways for node operators
to restrict users' access"): registration policy, sign-up groups, the trust
gates and account removal already let an operator decide who posts here.

## The order

1. Quarantine and the "what to do now" page.
2. Report pictures over HTTPS, and the advice in SERVER.md and the admin
   settings.
3. PDQ at crush and on the decode lane, with the refusal list.
4. Picture entries on the community lists (MODERATION.md).
5. The scanner interface, for operators with a clearinghouse key.

Tests use a fake matcher that "matches" a picture the test chose. Real material
is never used.

## Open

- **The refused upload's response** - undocumented (searched 2026-11-02; Shield
  logs each block with its rule, through the API only). Settled by design
  instead: the node's own errors have a known JSON shape, so an upload answered
  by anything else is "refused before it reached this server", whatever the
  status. No need to know Bunny's code, and it holds for any CDN.
- **Whether matches put the CDN account at risk** - not settled. Bunny's abuse
  procedure treats CSAM reports as the exception to its 48-hour
  notify-and-respond process ("Unlike DMCA or CSAM reports, we do not suspend
  Pull Zones or remove content for general abuse allegations"), but that is
  about content Bunny serves; an upload blocked at the edge is never stored or
  served. Nothing says whether scan matches count against the customer. Ask
  Bunny support - an attacker flooding hdt.com with CSAM uploads to get its CDN
  suspended is the attack left.
- **Video** - undocumented; the docs speak of input types, not formats, and PDQ
  is a still-picture hash. Assume video isn't checked until Bunny says
  otherwise.
- How long "preserve" is, and what an operator must keep.
