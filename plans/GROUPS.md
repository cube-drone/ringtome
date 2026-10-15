# Groups - a shared roster, kept by everyone in it

A design draft (2026-10-14). Nothing built.

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
  pairwise, written once at the door, and not a roster. It becomes slice 6.
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
  allowed its signer to make it.

So the group has no key that someone must hold to keep it alive. That's how
ruling 5 holds without a founder: authority comes from the roster, not from a
key tree, and the roster is on every member's computer.

**A mark that says "group"** goes everywhere a persona-shaped thing could be
mistaken for a person, so that ruling 7 holds. A group never appears in:

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

**The open technical question for (b):**

- One service slot per group per member would be many chains.
- One "groups" service, with entries tagged by group, would break the old
  sketch's rule that "gating is a property of the service slot, never a flag an
  entry could have wrong".

Settle it in slice 1, by reading how services and the sync door's gates are
keyed today.

### 3. Owners: a ranked tree (ruling 6)

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
  one button (slice 5): a fork, which is the honest recourse, and the one every
  hosted group service also leaves you with.

### 4. Members

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

### 5. The members' lane: content served only to members

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
- **Blobs** (a picture in a group post) are plaintext too, so the blob door
  needs the same member check before it serves one. Today a blob is served to
  anyone who has the hash. This is the one place the design costs new machinery
  rather than reusing it.

**Why not today's sealed audiences**, with a group as one more kind of audience?

- A sealed post's key is released by its author's node, one request per reader,
  after `seal_admits`. A post to a 1,000-person group would be 1,000 key
  requests to one node, often a desktop. The crowd can't spread that, because
  only the author's node can make the judgement.
- That puts a ceiling in the low hundreds. The members' lane has no such
  ceiling: any member serves any member.

### 6. What members do with it

- **Post to the group.** A post addressed to the group goes in the poster's own
  lane for it, under their own name. It's edited and taken down as it is today.
- **The group's page** gathers members' posts, newest first. An owner can
  **hide** a post from the group's page: a hide entry the fold honours. They
  can't delete it, since it's the member's.
- **The group's room.** Each group has one standing room, and any member can
  start more, with the group as their audience.
- **Mute** a group, per member, in the bell and in the feed.
- **Notifications** for invites, approvals and removals (your own), and for
  mentions in the group.
- **People.** Your groups appear beside your tags, drawn differently, since a
  group is shared and a tag is private. Joining a group sets no trust or
  interest dials on its members. Being in a group with someone isn't trusting
  them. There's an optional "say hi to everyone".

### 7. Scale

With the members' lane, the crowd makes a big group cheap to keep in step. Every
member is a holder, the relay is 16 wide per hop, and any member answers any
other. For 10,000 members, worked from the constants, not measured:

- **The roster** is about 10k rows, a couple of MB per member node.
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

### 8. Abuse

- **Invites from people you don't trust arrive as requests**, the way messages
  do, and are rate-limited per sender.
- **Reports** about a post in a group go to the group's owners first. The
  author's node operator keeps their ordinary takedown powers.
- **A group page used to harass someone** (a public group page, an open group's
  name) is subject to the same operator takedown as any persona's page.

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
   - The group mark, and settling section 2's question.
   - Owners and seniority, invites to people, joining, leaving and removal.
   - The fold, and the extended member proof on the sync door.
   - The claims: two members on two nodes see the same roster after a join and
     after a leave; a stranger's node is refused the roster; the senior wins a
     mutual removal; a removed owner's appointees are demoted.
2. **Group posts and the blob door's member check.**
   - Post to the group, and the group's page, with hiding.
   - The claim: a removed member's node is refused a picture it doesn't already
     hold.
3. **Links and the join settings**: invite links, open to people a member
   trusts, open, and ask to join.
4. **Rooms for groups**: the standing room and ad-hoc ones.
5. **The People side**: groups beside tags, mute, notifications, and "start a
   new group with these people" (the fork).
6. **The sign-up group becomes a real group.** `groups.rs` admits the joiner to
   the node's group instead of pairing them with every member.
7. **For phones**: membership without keeping the media.

## Open questions

1. **Section 2: one group chain, or members' lanes and a fold?** Recommended:
   lanes and a fold, with the service-slot question settled in slice 1.
2. **Default join setting** for a new group: invite only, or open to people a
   member trusts?
3. **Can the group itself speak?** A pinned rules or welcome post signed "the
   Potato Bunch" rather than by an owner. With no group key in use, it would be
   an owner's post marked as the group's. Is that wanted?
4. **Is the roster visible to members as names, or only as a count** for groups
   that want it? Ruling 3 says members see it. This asks whether a group may
   choose to hide it even from them (a support group, say).
5. **The soft ceiling**: 500, or something else?
