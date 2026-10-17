# Groups - a shared roster, kept by everyone in it

A design draft (2026-10-14; section 2 settled and section 3 added 2026-10-15).
Nothing built.

A group is a set of people with one membership list that every member sees the
same way. People join by invite or link, or by asking. Members post to the group
and chat in it under their own names.

This plan replaces the sketch in PROJECT_PLAN's _Groups: Identity-Shaped_ (which
Curtis, 2026-10-14: "may have been wildly overwrought"). Two of that sketch's
ideas survive, the roster that _references_ identities and the plaintext lane
served only to members; everything else is new.

What Curtis ruled is under _Rulings_. Everything after it is Claude's proposal,
and nothing in it is settled until he rules.

## The ask (Curtis, 2026-10-14)

"Being able to tag groups of friends and then do things like 'invite only THEM
to a chat' or 'send content to just THOSE people' ... is kind of not sufficient
to the task. Groups have things like 'invite links' and 'everybody in the group
has access to a single, synchronized group membership list' - in our current
scheme, if someone 'joins' the Potato Bunch, every other member of the Potato
Bunch needs to tag that person with 'Potato Bunch' - tags are great for
fine-grained control from a single users' POV, but they don't really constitute
a complete group design."

## Rulings (Curtis, 2026-10-14)

1. **Nobody is added without agreeing.** An invite is an offer, and joining is
   the invitee's own act.
2. **The group is hosted on every member's computer**, not on a founder's node.
3. **Only members see the roster.**
4. **Some groups may be open to anyone**, with the bot and spam risk that
   brings.
5. **No founder is needed to keep a group going.** Other owners manage it.
6. **Owners are ranked by appointment, CROWN-style**, not by join order and not
   by vote. The senior owner wins a conflict. Members are a flat set; the
   ranking is among owners alone. (Curtis asked "can't we resolve that with
   owner tree-seniority, similar to how IMAOL/CROWN resolves conflicts?" and
   approved the shape below: "Yes please".)
7. **Members keep their own identity.** The group is plumbing underneath, never
   a persona anyone acts as in the UI.
8. **A group is private or public, chosen at founding and never changed**
   (Curtis, 2026-10-16). A private group's membership is members-only and it
   can't post in public. A public group's membership is public and it can. "It's
   too complicated to ask everybody in the group if they're ok switching to
   public, and 'public to private' might not be possible at all." The kind is in
   the founding statement, whose hash is the group's id, so a group of the other
   kind would be another group.

## What's already here

- **Contact tags and audiences** (PROJECT_PLAN, _Contact tags_):
  - one person's private labels on the people they know;
  - a sealed post whose audience is a tag;
  - every sealed door asks `seal_admits(holder, key document, subject)`.

  These stay as they are: fine-grained lists only their owner sees. A group is
  the shared counterpart, not a replacement.

- **The sign-up group** (`groups.rs`). A node whose sign-up password names a
  group makes every joiner and the node's administrators know each other: low
  trust and low interest both ways, with the group's name as a tag. It's
  pairwise, written once at the door, and not a roster. It becomes slice 7.
- **CROWN's seniority** (`proto/src/crown.rs`, PROJECT_PLAN _Rules Of
  Succession_):
  - a total order on a tree, computed from local data with no clock (the rank
    path, compared at the lowest common ancestor);
  - a birthmark tiebreak for equivocation;
  - "friendly departures are self-service; hostile ones need a senior".

  `Crown::build` works on key entries, so the owner tree reuses the rule, not
  the type.

- **The crowd** ([CROWD.md](CROWD.md)): relay pushes of 16 per hop, and holders
  that serve what they hold. Members of a group are each other's holders from
  the start.
- **Member proofs on the sync door**: today it serves a private chain only to a
  proven node of its persona. Groups extend that proof.
- **Rooms** ([CHAT.md](CHAT.md)): a room is a post, and a message is a line on
  it. A group's room is a room whose audience is the group.

## The design

### 1. What a group is

A group has an id and a **founding entry**: its name and its first owner, signed
by a key minted for the group at its creation.

- After founding, that key signs nothing more. It's kept as cold recovery, or
  dropped.
- Everything the group says after that, it says through its **members' own
  keys**: who's in, who's an owner, its name and description, its posts.
- Each entry is valid if the roster, as it stood when the entry was signed,
  allowed its signer to make it. With no clocks, "as it stood" means what
  section 3 says.
- The group id is the hash of the founding entry, so the id proves itself.

So the group has no key that someone must hold to keep it alive. That's how
ruling 5 holds without a founder: authority comes from the roster, not from a
key tree, and the roster is on every member's computer.

**A mark that says "group"** was planned for everywhere a persona-shaped thing
could be mistaken for a person. Since section 2 settled on lanes, a group is
never a persona at all, so there is nothing to mark: it has no key tree, no
chain of its own and no profile (slice 1b, 2026-10-15). What stays true is where
it never appears:

- the persona switcher, the People list or follow suggestions;
- search, `@name` slugs, the census or persona limits and storage accounting;
- the ActivityPub face ([ACTIVITYPUB.md](ACTIVITYPUB.md)).

Its page reads as a group page: name, description and members, not a person's
page.

### 2. Where its entries live (the main protocol question)

There are two ways to keep a roster that many people write.

- **(a) One group chain, written by many.**
  - Every member's entries go onto one chain, which is the group's.
  - It's one thing to sync, and one place to read.
  - But it's the first chain with many writers. Its validity depends on its own
    contents (the roster), and concurrent entries make it a DAG.
  - That's new chain machinery, at the bottom of the stack.
- **(b) Each member's group entries on their own chain, in a lane for the group;
  the roster is a fold** (recommended).
  - Ada's "I add Bea" is on Ada's chain. Bea's "I'm in" is on Bea's.
  - Each member's node folds the lanes of the members it holds into the roster.
    That's the same shape as the `post_replies` memo, folded from headers.
  - Every chain keeps one writer. Edits and takedowns stay the author's own, as
    they are today.
  - The cost is that the group is N lanes to sync, not one.
  - A newcomer gets them from any member, since every member holds them all
    (ruling 2), and the crowd's relay carries a new entry to everyone in a few
    hops.

**Settled: (b)** (Curtis, 2026-10-15). Chat has already built its shape
(CHAT.md, rulings 3 and 4):

- `CHAT` is a per-instance service, one chain per `(key, CHAT, room id)`, and a
  room's history is its participants' chains read together.
- The sync exchange is already scoped by instance (`instance_in_scope` in
  `net/sync.rs`), and each room's lane is served only through the room's door.

A group is the same thing with a roster. It's a new per-instance service,
`GROUP`, whose instance is the group id, served only through the group's door
(section 6). That answers the old question about service slots: one service, one
chain per member per group, and the gate is still a property of the slot.

**What N lanes cost**, against one shared chain:

- **Noticing a change** is one fingerprint compare per group, however many lanes
  it has. `net/frontier.rs` already folds a persona's several devices' chains
  into one digest, and a group's digest is the same construction keyed by group.
- **Finding which lanes moved** means swapping head lists, about 40 KB at 500
  lanes. That's fine at 500 and not at 10,000, where the digest has to be split
  into buckets so two nodes can narrow the difference down. Secure Scuttlebutt
  went the per-author way, hit this at scale, and fixed it the same way, with
  vector clocks of feed heads (epidemic broadcast trees), not by sharing a feed.
- **A newcomer's first sync** is N short fetches, not one long one.
- **One shared chain** would cost more, even for three people. Concurrent
  writers make it a DAG with merges. Takedowns become "remove someone else's
  entry from a chain you share". Its validity depends on a roster written in the
  same chain. And the clean fix for concurrent writers is a sequencer, which is
  a founder by another name (ruling 5).

### 3. Order without clocks: how every node reaches the same roster

A roster built from many lanes has to come out the same on every node, whatever
order the entries arrive in, with no trusted clock. Section 1's "as the roster
stood when the entry was signed" is made precise here.

**The idea is CROWN's.** When CROWN repudiates a key, the revoke carries
**anchors**: per `(service, instance)`, the seq and head hash of the prefix that
stands. Everything past an anchor is void, wherever and whenever it arrives
(`proto/src/crown.rs`, step 4; `registry::Anchor` already carries an instance).
A group does the same thing with its own lanes. **Every act that ends someone's
authority says exactly how much of their group lanes it lets stand.**

The rules:

1. **The group id is the hash of its founding statement**, cut to the 16 bytes a
   chain instance has. It's self-certifying, so nothing needs the group key
   after founding. It hashes the statement, not the entry that carries it,
   because that entry's own chain is keyed by the id.
2. **A member's own entries are judged on their own lanes.** A persona's lane
   for a group starts with its join entry. Its entries count until either its
   own leave entry, or the anchors of an owner's removal of it. A removal
   anchors each of the persona's device lanes for the group as the remover had
   folded them. A lane the remover hadn't seen at all anchors at nothing.
   Anything past an anchor is void: a post, a hide, an invite or a join.
3. **Authority is cited, not assumed.**
   - A join cites its grant: the invite, the link token, the trust entry or the
     approval. A join is valid only if the grant is.
   - An owner's act cites the appointment that makes them an owner.
   - A grant is valid if its signer held the authority at that point of their
     own lane. That means before any anchor against them.
4. **Removals only go downwards.** A junior owner can't remove a senior (section
   4), and owners compare by rank path. So ownership resolves top-down from the
   founder, then members' standing, then members' own entries. There's no cycle
   to break. Two owners removing each other can't both stand, because only the
   senior's removal is valid at all. **Rank is where the appointment was made,
   and it stays** after a demotion or retirement. If seniority were judged by
   whether the senior still stood, a junior's void act against them would come
   back to life the day a third owner demoted them, since nothing orders the two
   (found by the slice 1b suite). The cost is that a demoted owner can be
   removed only by an owner senior to the rank they held.
5. **Ending an owner anchors their subtree too.**
   - A hostile removal anchors the removed owner's lanes, and the lanes of every
     owner they appointed, transitively. All of them lose ownership; they stay
     members.
   - Acts before the anchors stand. Acts past them are void.
   - Retirement is the owner's own entry. It ends only their own ownership, and
     their appointees keep their rank (section 4).
6. **Revoking a link lists what it accepts.** A revocation names the joins under
   that token it had seen. A join under the token that it doesn't name is void,
   and that person can be re-invited. Arrival order never decides. **Closing an
   open group works the same way**: a join in an open group cites the setting
   that opened it, and the write that closes the group names the joins it
   accepts.
7. **A setting names what it replaces.**
   - Each change of name, description or join setting cites every head it
     overrides, so one write settles a conflict. The live value is the head of
     that history.
   - Two concurrent heads mean two owners changed it at once, and the senior's
     wins (ruling 6). A later change by anyone, citing the winner, moves on from
     there.
   - Hides and unhides work the same way, per post.
8. **Leaving ends membership, not ownership.** A leave names no appointment, so
   it can't say which ones it ends, and one made after a rejoin isn't among
   them. An owner who leaves writes a retirement first, and the app writes both.
9. **A ban is a removal plus a standing refusal.** Every later join by that
   persona is void until an owner's unban cites the ban.
10. **A forked lane is handled the way CROWN handles it.** Two entries at the
    same `(lane, seq)` mean the device's key was duplicated. The fork rule picks
    the same winner on every node. An anchor names a head hash, not only a seq,
    so a duplicated key can't sign a fresh prefix under it.

**What this buys:**

- **Removal is retroactive to its anchors.** A spammer's flood, sent while their
  removal was still travelling, is void on every node once the removal arrives.
  Nobody has to hunt it down.
- **The cost is entry size, and it's bounded:**
  - a removal carries one anchor per device lane of the removed persona;
  - an owner's removal also carries one per subtree owner's device lane;
  - every other entry carries one citation.
- **The fold is a pure function of the entries.** It can be built and tested the
  way `crown.rs` is: every arrival order of a scenario must produce the same
  roster (slice 1).

**What it doesn't buy:** a removed member's node still has everything it synced
(section 5), and anything it learns of before the removal arrives, it learns.
Anchors decide what _counts_, not what was _seen_.

### 4. Owners: a ranked tree (ruling 6)

- **The founder is the root owner.** Every later owner is appointed by an
  existing owner. The appointment carries its lineage (the rank path from the
  root), the way a CROWN key carries its coat of arms.
- **Any two owners compare** at their lowest common ancestor:
  - the senior branch wins;
  - an equivocated pair (an owner who "forgot" an appointment and made another)
    falls to the birthmark: the lexicographically smaller root.
- **Day to day, every owner may do everything:** invite, approve, remove
  members, ban, appoint owners, rename, and change the group's settings.
- **In a conflict, the senior wins.**
  - A junior can never remove a senior.
  - When two owners each act against the other, only the senior's act stands.
  - When two owners make contradictory settings changes, the senior's stands.
- **Leaving is friendly and self-service.** An owner who steps down retires. The
  owners they appointed keep their rank, which was fixed when they were
  appointed.
- **Removal is hostile and needs a senior.** It goes the way a repudiated key
  does: the removed owner's appointment subtree loses ownership with them, and
  those people stay in the group as members. This is what defeats a rogue
  owner's sock puppets: they were appointed by the rogue, so they're all junior
  to the rogue, and they fall with them.
- **"The king is dead" holds.** Ranks compute with the founder absent, and
  juniors act freely until a conflict, so a founder who leaves takes nothing
  with them.
- **The stated cost:** nobody outranks the founder, so a founder who goes rogue
  can't be removed. They can abdicate (retire), and members can leave. Because
  every member holds the roster, **"start a new group with these people"** is
  one button (slice 6): a fork, which is the honest recourse, and the one every
  hosted group service also leaves you with.

### 5. Members

- **An invite reaches its invitee through their notifications** (Curtis,
  2026-10-15; a private chat was rejected because it needs communications
  already open). It's a notice on the envelope road strangers use
  (`net/deliver.rs`, notice kind 7, `group-invite`), judged by the invitee's
  inbox gate like any other:
  - **The invite is its own evidence.** The envelope carries the inviter's
    signed invite entry, which names the invitee and carries the group's
    **founding statement**. The statement's hash is the group's id, so the
    invite proves which group it's for, who founded it and what it was called,
    with nothing fetched. An invite whose founding isn't its group's opens
    nothing, in the gate and in the fold.
  - **Where to look is the node that knocked**: kept as one of the group's
    peers, unproven, so it opens no door.
  - **Nothing is fetched until it's opened.** The bell says "Ada invited you to
    the Potato Bunch"; opening it fetches the group from that node (the door
    already lets an invitee in), so the invitee sees whom they'd be joining.
    Joining then needs nothing more.
- **Joining is the joiner's act** (ruling 1). What makes an "I'm in" valid
  depends on the group's setting:
  - **Invite only**: it cites an invite from an owner. That's either addressed
    to them, or a link token, signed and with an expiry, a use limit, and
    revocable by any owner.
  - **Open to people a member trusts** (proposed default for "open-ish"): valid
    when any current member publishes trust for the joiner. A friend of a member
    walks in; a cold bot farm doesn't. Most of the internet has no trust graph
    to do this with, and we do.
  - **Open** (ruling 4): valid as it stands. Turning it on warns that the group
    will meet bots, and that the roster is now effectively public, since anyone
    can join and read it.
  - **Ask to join**: a request that an owner's approval turns into an admission.
- **Leaving** is the member's own entry, and needs no owner.
- **Removal** is an owner's entry. **A ban** is a removal that also refuses
  rejoining under that persona. Rejoining under a different persona can't be
  stopped in a pseudonymous system, and the copy doesn't pretend otherwise.
- **A member joins as whichever of their personas they choose.** Pseudonymous
  membership comes free.
- **What a removed member keeps:** everything their computers already synced.
  The UI never implies otherwise; the pessimism is the same as the deletion
  copy's.

### 6. The members' lane: content served only to members

**Rulings 2 and 3 together mean group content is plaintext, served only to
members.**

- A node serves a group's lanes, the roster and posts alike, only to a node that
  proves it hosts a persona on the roster. This extends today's member proof
  from "a node of this persona" to "a node of a persona on this roster".
- Nothing is encrypted per reader, so nothing has to be re-minted when someone
  leaves. A removed member's proof just stops working.
- This is the trade the old sketch named, and it stands: every member's node
  operator can read the group's content. _We Trust the Node Operator_ already
  says that much.
- **Blobs** (a post's body, a picture in it) are plaintext too, and **the hash
  is the boundary**, as it is for every blob (Curtis, 2026-10-15). The blob lane
  has no gate anywhere: `files.rs` serves any hash to anyone who asks, and the
  hash, unforgeable and unlinkable, is the capability. Only members are served
  the lanes that name a group's blobs, so only members ever learn their hashes.
  A removed member never learns what's posted after their removal. What they can
  still fetch is a body or picture from a post they were served before it, which
  they were entitled to read. The plan once had a member check on the blob lane
  here; it would have put a lookup on every blob the node serves, to close only
  that case.

**Why not today's sealed audiences**, with a group as one more kind of audience?

- A sealed post's key is released by its author's node, one request per reader,
  after `seal_admits`. A post to a 1,000-person group would be 1,000 key
  requests to one node, often a desktop. The crowd can't spread that, because
  only the author's node can make the judgement.
- That puts a ceiling in the low hundreds. The members' lane has no such
  ceiling: any member serves any member.

### 7. What members do with it

**A group post is a post, with everything a post has** (Curtis, 2026-10-15):
tags, dates, pins, scheduled posting, the works. The group's lanes therefore
need the annotations a persona's public posts get from their annotation chain,
on the group's side of the door. And **group posts live in your feed** with
everything else, filterable, with an implicit saved feed filter for every group
you're in. **You post to a group from Writer or the feed's composer**, with the
group as the post's target; the group's page is for reading it and keeping it,
not for writing (its quick composer goes).

How each post feature carries over:

- **Labels ride the group lane.** Tags, description, mentions and web path are
  the same `PublicAnnotation` statement a public post's labels are, as their own
  entry type on the `GROUP` service, so they travel only through the group's
  door and the roster fold counts them like any entry (void past a removal's
  anchor). Publishing to a group restates the draft's labels on the poster's
  lane as public publishing does (`restate_labels`: the same diff, the same
  skips). Anyone in the group may label anyone's post, as anyone may a public
  one. A public label on a group post is refused, and so is taking one back
  (2026-10-16): either would name the post on the labeller's public chain. The
  node knows a group post by the group journal and its own personas' group
  drafts.
- **The bell hears a group's labels from its lanes** (2026-10-17). A member
  named in a group post by its author, and a member whose group post another
  member labels, get a bell row (`group-mentioned`, `group-tagged`) folded by
  the group's derivation from the lanes their node holds. Every member's node
  holds them, so the group stands in for the follow, and no envelope is sent:
  the gate would drop it as already pulled. The row names its group, its card
  opens the group post, and a label taken back, a post taken down or hidden, or
  a member gone takes the row with it. Labels taken before node rung 94 carry no
  time and never ring.
- **The date and comments-off ride the post's header**, as they already do for
  any post (`dated_ms`, `settled`). The sealed bits don't: a group has no seal.
- **Scheduled posting** keeps its plan on the draft (`publish_plan`), which
  gains an optional group; the publish-due sweep posts through `roster::publish`
  when it names one.
- **Pins** (Curtis, 2026-10-15) come in two layers, each a register per post:
  - **Owner pins**: an owner pins any post; only owners unpin one, the senior
    winning a disagreement, as with hiding.
  - **Member pins**: a member pins a post; any member may unpin it.
  - **The group's page shows owner pins first, then member pins**, then
    everything else, newest first. An owner can unpin anything, either layer.
- **Your feed.** Group posts reach the feed through a journal of their own,
  merged with `feed_journal` at read on the same cursor, never written into it.
  Other surfaces read `feed_journal`, and slice 2's rule holds: a public surface
  can't list a group post that was never in its tables. A group post's card
  names its group. The feed's filters gain `groups`, with "not in a group" as
  the public-only feed, and the Feeds column shows **one implicit feed per group
  you're in**, made from your groups rather than stored, so it comes with
  joining and goes with leaving.
- **Writing.** The feed's "only show to" select and Writer's publish bar list
  your groups beside Everyone and the sealed audiences; choosing one publishes
  there.

- **Post to the group.** A group post is a document like any other post (Curtis,
  2026-10-15): a `DocHeader` with versions, a body blob, its pictures as media
  documents, edits as new versions and takedown as the usual retraction. What
  makes it a group post is where it lives: on the poster's own lane for the
  group, not their public posts chain, and served only through the group's door.
  **Publishing chooses a destination**: the public, or one of your groups. In
  the app it's one "who can see this" picker, with your groups beside Everyone
  and the sealed audiences, but a group is a place, not a seal:
  - **One group per post.** A document lives on one chain, so posting to two
    groups makes two documents.
  - **Rebroadcasts** (Curtis, 2026-10-15):
    - **Into a group: yes.** A public post shared into a group is a rebroadcast
      whose pointer goes on the sharer's group lane instead of their public
      rebroadcast chain. The replica is the public one it always was, so the
      author's edits and retraction reach it as they reach any rebroadcast. The
      share button asks where it's going, Everyone or one of your groups, as the
      composer's picker does. The author may never see the share, or what the
      group says about it; that's no more than a link pasted into a group chat
      anywhere else.
    - **Within its own group: no.** Every member already has the post, so a
      share would only bump it.
    - **Out of a group: no**, to the public or to another group. The share
      button refuses, as it does for a sealed post. The author chose the
      audience, and a share out breaks that promise. It also couldn't work
      without a leak: a pointer would aim the world at something it can't fetch,
      and making it fetchable means serving a copy outside the group. If it's
      ever wanted, the precedent is sealed posts' "people I trust, and onward":
      a per-post setting by the author, "members may share this out", never the
      sharer's choice.
  - **Replies stay in the group**, on the replier's own lane for it.
  - **No seal inside a group.** The group is already members-only.
  - **Nothing public lists or serves it**: not the anonymous `/id` door, the
    shelves, RSS, the crawl or the front page. Members read it through the
    group's own routes.
  - **The roster fold counts it like any entry on the lane**: while its author
    is a member at that point, and void past a removal's anchor.
- **Where groups live in the app** (Curtis, 2026-10-15): a **Groups tab in
  People**, beside today's page of people, listing the current persona's groups
  (People is per persona, like everything else in the app), the invites waiting
  for them, and founding one. A group opens at its own address under People,
  `/ringtome/people/groups/{id}`.
- **The group's face** (Curtis, 2026-10-16): a name, a picture, a banner and a
  description (its bio), as a person has. **Owners only** set them, as owner
  settings. A setting names what it replaces (rule 7 of the fold, above), so a
  junior owner's later change wins, and seniority settles only two changes made
  without seeing each other. The picture and banner are media documents on the
  setting owner's own lane for the group, never posts, fetched by every member's
  node with the group's other pictures. **The face is shown to anyone who asks**
  a node that holds the group: an invitee needs to know whom they'd be joining,
  and a public group shows it. Nothing else of a private group is. The group's
  id is what anyone asking must know.
- **The group's page** is shaped like a persona's: the group's details on top
  (its banner with the picture and name on it, its description, the roster with
  owners marked, and an owner's management controls), and its posts beneath,
  newest first. Only a member sees any of it. The posts are the feed's own
  cards, from the feed narrowed to the group, as a persona's page lists the
  feed's cards for one person; each opens at its own address inside the group,
  `/ringtome/people/groups/{id}/posts/{doc}`, there to members alone (Curtis,
  2026-10-16). "Members" is the disclosure a person's page keeps your
  relationship in: closed, under its heading, a line or two of faces at a glance
  (the founder, the owners, whoever posted last), each naming its person on a
  point; open, the whole roster, each name with a cowboy hat (founder or owner)
  or a cow (member) beside it that says which on a point, with the invited and
  an owner's invite there rather than on the group's front page, and at its foot
  whoever was removed or banned and isn't back, so an owner can invite the
  removed back or lift a ban (Curtis, 2026-10-16: a banned persona nobody can
  see is lost for good). An owner can **hide** a post from the group's page: a
  hide entry the fold honours. They can't delete it, since it's the member's. A
  hidden post is out of sight for members, but owners see it, faded, to show it
  again, and so does its author, so they know it was hidden (Curtis,
  2026-10-15). An owner's own post isn't theirs to hide: they take it down.
- **The group's room.** Each group has one standing room, and any member can
  start more, with the group as their audience.
- **Mute** a group, per member, in the bell and in the feed.
- **Notifications** for invites, approvals and removals (your own), and for
  mentions in the group.
- **People.** Your groups appear beside your tags, drawn differently, since a
  group is shared and a tag is private. Joining a group sets no trust or
  interest dials on its members. Being in a group with someone isn't trusting
  them. There's an optional "say hi to everyone".

### 8. Scale

With the members' lane, the crowd makes a big group cheap to keep in step. Every
member is a holder, the relay is 16 wide per hop, and any member answers any
other. For 10,000 members, worked from the constants, not measured:

- **The roster** is about 10k rows, a couple of MB per member node.
- **10k members is at least 10k lanes per group.** Noticing a change is still
  one digest compare; finding the moved lanes needs the bucketed digest from
  section 2. That's a slice of its own, owed before a group passes a few
  thousand members, and not needed for the 500 default.
- **Churn of 1% a day** is about 100 entries, each reaching 10k nodes once.
- **A change reaches everyone** in about four relay hops on the lazy tick:
  minutes, not seconds. The same goes for a removal, so a removed member can
  still be served for those minutes by a node that hasn't heard yet.
- **Posts cost each member's node storage.** Every member's node holds every
  group post. A busy 5,000-member group with pictures is a few MB a day: fine on
  a server, noticeable on a phone. So a "member, but don't keep the media"
  setting is planned for phones and metered nodes, which fetch pictures when
  they're opened.

**No protocol ceiling.** A soft default of 500 members, which owners can raise,
until a real big group is measured. Past a few hundred, the limit is human, not
technical. A group that big is a forum: feeds flood, moderation becomes a job,
and an open one attracts bots.

### 9. Abuse

- **Invites from people you don't trust arrive as requests**, the way messages
  do, and are rate-limited per sender.
- **Reports** about a post in a group go to the group's owners first. The
  author's node operator keeps their ordinary takedown powers.
- **A group page used to harass someone** (a public group page, an open group's
  name) is subject to the same operator takedown as any persona's page.

### 10. Two kinds: private groups and public groups (ruling 8)

**Why there are two.** A group speaking in public, with its membership private,
can't be had (Curtis, 2026-10-16). Every road that brings a private group's
public post to an outsider points at its members, the more so on a sparse
network:

- **Carried by members** (each member's followers get the group's posts): an
  account that follows only Dave answers "is Dave in it?", and a few such
  accounts sort a whole roster out. Delivery that depends on membership is an
  oracle for it, whatever the card says.
- **Followed directly, under pseudonymous speaker keys**: whoever you got the
  group from is probably in it, and the node that serves its lane points at
  whoever that node hosts.
- **A key the group holds**, or a persona the members act as: the machinery this
  plan dropped (_What it replaces_) and ruling 7 forbids, and it still leaks by
  the two roads above.

So the choice is made once, at founding, by what members agree to when they
join.

**A private group** is what's built: its roster, its posts and everything it
owns (section 11) are members-only, served by refusal to anyone else. It has no
public voice at all, so nothing it does reaches outside to be read back.

**A public group** has a public roster, and so may speak in public:

- **Its roster lanes are public**, its content lanes members-only: two lanes per
  member per public group. The old sketch's rule decides it: gating is a
  property of the service slot, never a flag an entry could have wrong. So a
  public group can still hold members-only posts and shared things beside its
  public ones.
- **A public post is the poster's own public post**, on their own public chain
  with their own key, marked as the group's: "Bill (Cheese Group)". Checkable
  against the public roster, answerable to its author, and no key held or
  rotated by anyone.
- **Members carry it, worked out by the reader.** You follow Dave; Dave's public
  roster entry says he's in Cheese Group; so your node journals Cheese Group's
  public posts with Dave as their via, the row a rebroadcast makes, written by
  nobody. No member signs a statement they didn't make, and no node writes N
  entries per post. It answers to the rebroadcast dial a followed person already
  has ("their recommendations, not their musings"), so someone in fifty groups
  floods nobody who didn't ask.
- **Following the group itself** brings every member's group-marked posts.
- **Joining says so.** A public group's join screen says your membership will be
  public, and that its public posts will reach your followers through you
  (ruling 1).

Ruling 7 holds in both kinds: nobody ever acts as the group. Bill posts as Bill.

### 11. What a group owns (proposed, 2026-10-16)

Posts are the first thing a group holds, not the only one: a shared notepad, a
shared hrseAmp playlist, a shared drawing, a group's wiki (Curtis, 2026-10-16).
Each is members-only content, in either kind of group, on members' lanes and the
fold like everything else here: no new identity, no new handle.

- **A shared document accepts versions from any member's lane**, each naming its
  parents, and the fold merges them; a group post accepts versions only from its
  author's. The apps reach a group's things through the group's routes, and
  "belongs to the Potato Bunch" is a label on a notebook, never a persona to
  switch to.
- **Concurrent edits are the ordinary case.** A fork used to be one person on
  two computers; here it is two people at once, and the merge is what they see.
  Each kind needs one that holds up (and the merge-hostile rule applies: say so
  before building anything that edits entries in place, reads pixels, or
  compounds approximate geometry):

  | Kind                 | Its merge                                                                                        |
  | -------------------- | ------------------------------------------------------------------------------------------------ |
  | A note               | Line-wise three-way, as Writer's notes merge now.                                                |
  | A drawing            | Stroke by stroke, as drawings merge now (DRAWING.md).                                            |
  | A notebook, its tags | Sets of adds and removes, as a persona's are.                                                    |
  | A playlist           | An ordered list: positions that merge (a key between neighbours), never the list rewritten. New. |

**A removed member's edits (the rule shared documents stand on).** Section 3
voids a removed member's entries past the anchor. For a post that's clean: the
post goes. For a shared document it isn't: Bea edits the notepad, is removed
with an anchor before that edit, and Cal has already written on top of Bea's
version. The draft rule:

1. **A void version changes nothing.** Its effective content is the merge of its
   parents' effective contents, as if it had never been written.
2. **A counted version's own change stands**, on its parents as they effectively
   are: a three-way merge whose base is its recorded parents' merge, one side
   its own content, the other its parents' effective merge.
3. So **Bea's words leave every descendant, unless someone counted made them
   theirs.** Text of Bea's that Cal kept unchanged is base on one side and gone
   on the other, so it goes; text of Bea's that Cal edited is Cal's change, and
   stays as Cal's.
4. **It is the fold's, at read, cached by the group's stamp** (ONE_FEED.md,
   section 3): a late removal recomputes the document, nobody rewrites history,
   and every node reaches the same text from the same lanes.
5. **What came before the anchor stands**, as it does for posts.

Drawings take it stroke by stroke and playlists entry by entry. A persona needs
the same rule for a revoked computer's edits, so it is written once for both.

**Owners' tools.** Any member can wreck a shared notebook, so: revert (a new
version with an old one's content, never history rewritten), lock (an owner's
register on the thing: owners only may write it), and a group setting for who
edits by default.

**Cost.** Every member's node holds everything the group owns: fine for notes
and playlists; a group that collects audio and video wants the storage budgets a
persona has.

### 12. A lesson from drafting sections 10 and 11

The first drafts of section 10 gave the group a persona with a crown, then
posting keys, then a group persona the members acted as, each time because the
persona's key tree already does "many signers, one identity" and promised reuse.
The 2026-07-30 sketch had refused each of those, with reasons (_Groups:
Identity-Shaped_ in PROJECT_PLAN: a key per member, a shared epoch secret, the
group as an identity whose keys someone holds), and ruling 7 forbids the last.
The kernel is three things: the roster's fold, members' own lanes and keys, and
refusal at the door. A new group feature is built from those or it says, before
anything else, why it can't be.

## What it replaces

PROJECT_PLAN's _Groups: Identity-Shaped_ gets a pointer here, and is marked as
replaced.

Kept from it:

- the roster references identities rather than containing them;
- members act with their ordinary keys;
- the plaintext lane served only to members, and its stated trade;
- the departed keep their era, and the future is closed to them.

Dropped:

- the whole membership as an invite tree, ranked by join order;
- the merge rules for ejection against admission among members. Ejection now
  needs an owner, and owners are ranked, so a concurrent admission and removal
  falls to seniority like any other conflict between owners;
- the group as an identity whose keys someone must hold.

## Slices

1. **The founding entry and the roster.**
   - **1a, the fold, in `proto`** (built 2026-10-15, `proto/src/roster.rs`). A
     pure roster fold beside `crown.rs`: the group entries, section 3's rules,
     and unit tests that replay each scenario in every arrival order and get one
     roster. No network, no node.
     - Scenarios: a join, then a leave; a removal while the removed member is
       still posting; a junior trying to remove a senior; a hostile removal
       demoting a subtree, while a retirement keeps one; concurrent setting
       changes; a revoked link with joins in flight; a ban and a rejoin; a
       forked lane.
   - **1b, on the wire and in the node** (built 2026-10-15:
     `node/src/roster.rs`, `node/integration/test/rosters.cjs`). The `GROUP`
     service per instance, invites to people, joining, leaving and removal. Also
     the fold over held lanes, and the group's door at the sync lane.
     - **The door** opens to a dialer that speaks for someone the roster counts:
       a member, an owner, or someone an invite still waits for. It knows who a
       dialer speaks for by the member proof of the exchange itself (a member
       pushing their own lane), or by what an earlier proof told it, kept per
       group, since the peer ledger keeps proofs only for personas hosted here.
     - **An invite only opens the door if it could let its invitee in**: one a
       join has used is spent, and one made before the invitee's removal must
       readmit it. A leftover invite kept serving a removed member the group in
       the suite, removal and all.
     - **Nobody needs a directory yet.** Invites, appointments and removals name
       people, so a node learns whom to pull by folding what it holds, and an
       invite carries every node the group has been heard at.
     - **A sync is push, pull, push.** The first push carries the member's key
       tree to a node meeting them for the first time, so the second one's proof
       can be checked.
     - **Entries travel with a sync**: the person's own, or a group-sync beat,
       once a minute (an hour on the test rig, so no claim races it).
     - The claims: two members on two nodes see the same roster after a join and
       after a leave; a stranger's node is refused the roster; a junior's
       removal of a senior changes nothing; a removed owner's appointees are
       demoted; a removed member's posts past the anchor vanish on a third node
       that saw them first.
2. **Group posts are documents** (built 2026-10-15: `node/src/roster.rs`,
   `node/integration/test/groupposts.cjs`).
   - `DOC_HEADER` and retraction entries on `GROUP` chains. As built, they are
     read from the group memo like the roster, never folded into a persona's
     document views: those feed every public surface, which read them filtered
     to the public lane, so a group post can't reach one. The public pipeline
     (`bake::publish`) stays the public chain's; `roster::publish` is the
     group's: your own pictures become media documents on the lane, the words a
     body blob, and publishing the same draft again is an edit. Pictures from
     elsewhere, and other people's, are refused for now.
   - The roster fold counts them like any entry on the lane; `GroupEntry::Post`,
     slice 1b's stand-in, goes.
   - After a group sync, the node fetches missing bodies and pictures from the
     group's nodes; the reaper counts group documents as live.
   - The group's page: its posts newest first, with hiding.
   - The claims: a member's post, with a picture, reaches every member's node
     and reads there; a stranger's node is never served it and no public door
     lists or serves it; an edit and a takedown reach members as they would for
     any post; a removed member's later posts are void everywhere.
3. **Links and the join settings**: invite links, open to people a member
   trusts, open, and ask to join.
4. **Group posts are whole posts** (section 7, "How each post feature carries
   over"), in this order:
   - **4a, labels** (built 2026-10-15: `node/src/roster.rs` "Labels",
     `groupposts.cjs`): the annotation entry type on group lanes, its fold, and
     the restatement at publish.
     - A `PUBLIC_ANNOTATION` entry on a `GROUP` chain is a label; the roster
       fold counts it (proto `GroupEntry::Label`, never a group entry's kind).
       The public label fold reads `ANNOTATIONS_PUBLIC` only, and so does the
       fragment proof, so a group's labels reach no public surface.
     - Settled as public labels are: the last said about a (who, post, key,
       value) in the order this node received it, then the public rules
       (`annotations::labels_that_stand`: an author's own reaction falls, anyone
       else's tags stand two to a person).
     - Publishing restates the draft's labels through the public path's own
       `draft_labels` (tags, fields, notebooks, mentions), adding the pictures'
       kinds and the length, and diffs against the poster's labels on the lane.
       The public-only ones stay out: the web path, the draft link, the sealed
       audience.
     - Any member tags any post (`POST .../docs/{doc}/labels`).
   - **4b, the feed** (to be replaced: [ONE_FEED.md](ONE_FEED.md) puts group
     posts in the one feed journal and caches the fold; built 2026-10-15:
     `group_journal`, node rung 86; `roster::feed_rows`; `groupposts.cjs`): the
     group journal, the merge at read, `groups` in the filters and the implicit
     feeds.
     - Every refold writes each hosted member's rows: the posts they may see
       (not hidden from them), with the group's name, the post's labels and its
       words for the search. A version unchanged since the last refold keeps its
       words unread. The group-sync pass refolds every group it keeps, so a node
       that gains the table in an upgrade fills it within a pass.
     - The feed in time order merges the two journals on the same cursor. Every
       filtered view (search, chips, and best or hot with a chip) judges group
       rows by the same chips, off what the row carries
       (`Narrow::admits_group_post`). `group=` and `not_group=` are the groups
       row; picking a group leaves only its posts.
     - A group post's card names its group, reads its words through the group's
       door, takes tags through the group's labels route, and offers only its
       author's takedown and, to an owner, the hide (2026-10-16): no share,
       profile or front-page pin, QR code, or copy into notes. Its address is
       inside the group (2026-10-16; until then it had none).
     - The Feeds column lists one feed per group you're in, under "all", made
       from your groups rather than stored (`pure/groups.js` `groupFeeds`).
   - **4c, writing** (built 2026-10-15: `roster.rs` publish and
     `publish_planned`, `scheduled.rs`, `doc/publishbar.js`, `apps/feed.js`,
     `groupposts.cjs`): the group as a target in the feed's composer and
     Writer's publish bar; scheduling to a group; the page's quick composer
     goes.
     - The feed's "only show to" lists your groups (under "your groups", shown
       whenever you're in one, unlock or no unlock), and Writer's bar has "post
       to", Everyone or a group. Once posted, the bar says "posted in" the
       group, with view, update and unpublish there
       (`GET .../docs/{doc_id}/groups` says where a draft went; a takedown
       forgets it). Drawings don't offer it: a group post is words.
     - A group post's header carries the draft's claimed date and comments off,
       as any post's does, and sorts by the claimed date.
     - A future date is a plan naming the group; the publish-due sweep posts it
       through `roster::publish_planned` while its author is still a member, and
       spends the plan either way.
   - **4d, pins** (built 2026-10-16: proto `GroupEntry::Pin`, `MemberPin`,
     `Roster::owner_pins`, `member_pins`; node rung 92; `roster.rs`
     `pin_handler`; `postentry.js` `GroupPinButton`; `groups.js` the pinned
     strip; `groupposts.cjs`). Any member pins any post (Curtis, 2026-10-16). An
     owner's pin is an owner's act, wire kind 14, a register per post settled as
     a hide is, by seniority. A member's is a member's own act, kind 15, counted
     while they're in, and members have no ranks, so concurrent heads settle by
     hash. A post an owner pinned is in the owners' layer alone. Unpinning takes
     away what the caller may: an owner, every pin on the post; a member, a
     member's pin (anyone's), never an owner's. The journal row carries the pin
     (0 none, 1 member, 2 owner) for the card and the page: owners' pins first,
     then members', above the rest.
5. **Rooms for groups**: the standing room and ad-hoc ones.
6. **The People side**: the Groups tab and the group's page come first, with the
   app for slices 1 and 2; then groups beside tags, mute, notifications, and
   "start a new group with these people" (the fork).
   - **First part built** (2026-10-15: `node/js/groups.js`, `apps/people.js`,
     `node/integration/test/groupinvites.cjs`). Invites travel as notices
     (section 5); People has its two tabs; a group's page shows its details,
     members and owners with an owner's verbs (invite from your contacts, make
     owner, demote, remove, ban), joining and leaving, and its posts beneath
     with a quick composer, takedown and hiding.
   - **The group's face built** (2026-10-16: proto `Setting::Picture`,
     `Setting::Banner`, setting kinds 3 and 4 holding a document id or empty
     bytes for none, and `Roster::picture`, `banner` and `face_docs`, every
     document a counted face setting ever named, which `listed()` keeps out of
     the posts; `roster.rs` `settings_handler`, `set_face_handler`,
     `clear_face_handler`, and the face door, `GET /api/groups/{g}/face` and the
     current picture's and banner's bytes at `/api/groups/{g}/face/{doc}`, with
     no session; `groups.js` `GroupHero` and `GroupFaceEditor`; the Groups tab
     shows each group's picture; `groupposts.cjs`). A replaced picture's address
     answers nothing; the face door serves only the face as it stands. A node
     that doesn't hold the group knows nothing of its face: reaching another
     node's is for public groups (slice 12).
7. **The sign-up group becomes a real group.** `groups.rs` admits the joiner to
   the node's group instead of pairing them with every member.
8. **For phones**: membership without keeping the media.
9. **One feed** ([ONE_FEED.md](ONE_FEED.md), built 2026-10-16): group posts in
   `feed_journal`, their labels in `doc_annotations`, the fold cached by a
   per-group stamp. It replaces slice 4b's separate journal, and slices 10 to 13
   build on its cached fold.
10. **The kind in the founding** (ruling 8): a founding with no kind is private,
    so every group so far keeps its id; the founding's wire key, and the app's
    choice when founding.
11. **Group-owned notebooks** (section 11): a notebook and its notes on members'
    lanes, versions from any member, the removed-member rule, revert and lock.
    Text first, since its merge exists, and it settles the rule the others stand
    on.
12. **Public groups** (section 10): the roster lanes split from the content
    lanes, a public post marked as the group's, the carry worked out by the
    reader under the rebroadcast dial, following a group, and the join screen
    that says so.
13. **More that a group owns**: drawings (their merge exists), then playlists
    (ordered-list merging, new).

## Open questions

1. ~~Section 2: one group chain, or members' lanes and a fold?~~ **Settled
   (Curtis, 2026-10-15): lanes and a fold**, on a per-instance `GROUP` service
   as chat's rooms are.
2. ~~Default join setting for a new group: invite only, or open to people a
   member trusts?~~ **Invite only** (Curtis, 2026-10-15).
3. ~~**Can the group itself speak?** And might a group post publicly?~~
   **Settled (Curtis, 2026-10-16): by kind, ruling 8.** A private group can't; a
   public group's members post as themselves, marked as the group's (section
   10). Section 12 says how the drafts got there.
4. ~~Is the roster visible to members as names, or only as a count?~~ **Not for
   now** (Curtis, 2026-10-15): members see the roster (ruling 3). A hidden
   roster can come later, as a setting.
5. **The soft ceiling**: 500, or something else?
6. **The removed-member rule** (section 11) is a draft: is "their words leave
   every descendant unless someone counted made them theirs" the behaviour
   wanted?

**Owed after slice 1b** (in NEXT_STEPS): a send-side door when this node dials
(it sends its group lanes to whatever node it dialed), one exchange per group
rather than one per persona per node, and the app's side, since 1b is routes
only.

7. **A hostile removal: do the subtree's acts before the anchors stand?**
   Section 3, rule 5, says yes, so a rogue's sock puppets' removals of real
   members stand, and those members have to be re-invited. The alternative is
   voiding every act of a removed subtree. That's a cleaner undo, but it reaches
   back into acts that were valid when they were made, which is what anchors
   exist to avoid.
