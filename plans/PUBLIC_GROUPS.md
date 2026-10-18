# Public groups

Curtis's ask (2026-10-17): "a different option at creation that allows users to
publish not just within but also On Behalf Of a group. All public group members
are visibly part of the group, and anybody following a user in a group will also
see All Group Public Posts for public groups they're in. Group Public posts
shared by a group-member you're friends with, but not directly posted with them,
follow the same visibility and curiosity rules as rebroadcasts: if you don't
want their rebroadcasts, you also don't want to hear from their groups - however
if your friend posts publicly as a group member, that counts as a direct post
from them."

This is slice 12 of [GROUPS.md](GROUPS.md), whose section 10 sketched it, and
whose ruling 8 settles that the kind is chosen at founding and never changed.

## Rulings (Curtis, 2026-10-17)

1. **Public is chosen at founding.** The founding statement says which kind, and
   its hash is the group's id, so a group of the other kind is another group.
   Nothing is in the wild yet, so the kind goes into every founding's preimage:
   groups founded on dev nodes before this stop verifying.
2. **Two lanes per member device**: a public lane holding the roster and the
   group's public posts, and a members-only lane holding everything else. Posts
   "within" the group stay members-only.
3. **A public post as the group is the poster's own public post**, on their own
   public chain, and the group's because their public lane says so. Ruling 7 of
   GROUPS.md holds: nobody acts as the group. Bill posts as Bill, shown as "Bill
   (Cheese Group)".
4. **Membership is public.** Anyone can see who is in a public group.
5. **Followers of a member get the group's public posts.** Following Dave brings
   Cheese Group's public posts, with Dave as their via, under the rebroadcast
   dial: if you don't want Dave's rebroadcasts, you don't want his groups'
   either. Dave's own post as the group is a direct post from Dave, under the
   ordinary follow.
6. **A public group's page is open to anyone**, signed in or not: its face, its
   members and its public posts. Members-only posts stay members-only.
7. **Following a group directly** brings every member's public posts as the
   group's, built in this round.
8. **Hiding and removal stop the carry.** An owner's hide stops a public post
   being the group's. Removing a member stops carrying everything they ever
   posted as the group's. The posts stay on their authors' own chains, as
   theirs.

## The shape

### Two lanes, one fold

Every member device has a members-only lane for a group,
`(device, GROUP, group id)`. A public group adds
`(device, GROUP_PUBLIC, group id)`: service 15, per-instance, plaintext, and
served to anyone.

The fold (`proto::roster::build`) already judges membership lane by lane. Each
lane joins on its own; a second computer's lane cites the persona's earlier join
(`Grant::Device`). Content counts while its lane is a member, and a removal or
leave cuts every lane its anchors name. So a public lane is one more lane of the
persona. The fold names it by a lane id derived from its device,
`public_lane(device) = blake3("ringtome-v0/group-public-lane" ‖ device)`, and
`build` is unchanged:

- **Public-lane entries:** the founding, invites, joins, links, appointments,
  demotions, removals, unbans, retirements, leaves and settings. Also the
  group's public posts (`GroupEntry::Public`, below) and owners' hides of them.
- **Members-only-lane entries:** documents, labels, member pins, and owners'
  hides and pins of members-only posts. The lane's first entry is a join:
  `Grant::Founder` for the founder, otherwise `Grant::Device` citing the
  persona's public-lane join.
- **A removal or a leave** anchors every lane the writer's node holds for the
  persona, as now, which is both lanes of every device.
- **A node outside the group** holds only the public lanes. It folds the roster,
  the face and the public posts, and never sees the content.

### A public post as the group

Publishing chooses "public, as Cheese Group" (a public group's members-only
"Cheese Group" stays beside it):

1. The draft publishes through the public door as ever: the poster's public
   chain, their key, their labels, their replies.
2. Their public lane gets `GroupEntry::Public { doc, retract }`, naming the
   post. That is the claim, and it counts while the lane is a member.
3. Taking the post down retracts it on the public chain, and the lane says
   `retract`.

`Roster::public_posts` is the pointers that count: by a current member, not
hidden, not retracted (ruling 8). The derivation writes them to
`group_public_posts (group_id, author, doc, claimed_ms)` on every node that
holds the group's public lanes. That table is what the cards' public band, the
group's public page and the carry all read.

### The carry (ruling 5)

On a reader's node:

1. **Following Dave brings Dave's public lanes.** `instance_in_scope` lets a
   `GROUP_PUBLIC` chain travel on any exchange, as a chain with no instance
   does. So an ordinary follow sync of Dave carries his public lane for every
   public group he's in.
2. **The group's other public lanes come from its machines.** The node runs a
   public sync for every public group whose lanes it holds and that a local
   reader cares about: one exchange per named persona, scoped to identity,
   profile and `GROUP_PUBLIC`, from a group endpoint (`group_peers`, members'
   peers). The door serves `GROUP_PUBLIC` to anyone, and never `GROUP`.
3. **The derivation journals.**
   - For every local reader dialed in for Dave's rebroadcasts, the group's
     public posts by members other than Dave are journaled with Dave as their
     via. That is `journal_shares_by`'s road, so the post itself comes from its
     author or its holders, as a share's does.
   - Dave's own posts as the group are his public posts, journaled by the follow
     as ever.
   - A post that stops being the group's (hidden, or its author removed) leaves
     the rows its via made.
4. **Following the group directly** (ruling 7) is
   `group_follows (local_root, group_id, followed_ms)`. It journals every public
   post as the group's to the follower, with no via.

### What anyone sees

- **The public group page** (`GET /api/groups/{group}/public`, no session): the
  face, the members with their bylines, the owners, and the public posts. It's
  served by any node that holds the group's public lanes. The app's page is open
  to the signed-out web too.
- **A persona's public groups** on their profile: `GET /api/id/{root}/groups`
  lists the public groups the node knows they're a member of.
- **The card** of a public post the group counts wears the group's band, as a
  post within a group does, but bigger, with a bigger triangle. After the
  group's name it says "(public)", and a post within a group says
  "(group-private)", each small, italic and fainter than the name (Curtis,
  2026-10-17). It links to the group's open page.

### The open page is a feed (Curtis, 2026-10-17)

"Can we give the public groups outward-facing page a full-feed view with filters
and such?" The open page lives at the group's address in People, inside the
app's frame with its header, signed in or out. Its public posts are the feed's
cards, with the filter strip and the header's search:

- `GET /api/groups/{group}/posts` and `/labels`, to anyone, answer as a
  persona's shelf does (`idface::group_feed_json`, `group_labels_json`). They
  read each counted post from its author's shelf as this node holds it, else
  from the fragment ledger, and narrow it by the same words and picks.
- Every node holding a public group fetches the posts it counts but doesn't
  hold, from their authors, in the background of the group's derivation, as a
  share's fragment is fetched. So its feed fills wherever the group is held.
- Members see the same feed on their own page of the group, as the first of
  three tabs under its header: "public posts", "private posts" and "chats"
  (Curtis, 2026-10-17), so a long run of public posts never buries the members'
  own. The last two show only to members, and a private group has just those
  two. Each tab is its own address, `?tab=`.

### What a member sees

- **Founding** offers "public" or "private", saying what public means: the
  roster is public, and public posts as the group reach your followers.
- **Joining a public group** says so (GROUPS.md section 10).
- **Publishing** offers "public, as {group}" for each public group you're in,
  beside "{group}" (members only).

## Slices

All five built 2026-10-17. Acceptance: `integration/test/publicgroups.cjs`
(eight claims, across four nodes).

1. **The lanes.**
   - `Founding.public` is in the signed preimage, and in the founding's and an
     invite's encoding (key 8). `service::GROUP_PUBLIC` is 15, and
     `roster::public_lane(device)` names a public lane in the fold.
   - The memo's `device` column holds the fold's lane id (`lane_device`), so
     `lanes_of` and the primary key are unchanged; rung 98 adds `service`.
   - Writers route by kind (`lane_service`). A members-only lane joins first
     (`join_content_lane`). A join to a group this node doesn't hold fetches it
     first, so its kind decides the lane. A leave anchors every lane but its
     own, which is the members-only one in a public group.
   - The door: `instance_in_scope` passes `GROUP_PUBLIC` on every exchange.
     `GROUP_SCOPE` carries both lanes. A stranger is served the public lanes
     because the group's door names it no instance.
   - Proto tests cover a roster from public lanes alone, a members-only lane
     counting from its own join, a removal cutting both lanes, and the kind
     signed into the id.
2. **Posting as the group.**
   - `GroupEntry::Public { doc, retract }` (kind 16).
   - `Roster::public_posts` holds the posts a counted claim makes the group's
     and none retracts, by a current member, not hidden. A hide names the claim,
     on the public lane, so outsiders carrying the post hear it.
   - The public publish takes `as_group`, refusing it on a sealed post, a room,
     an IM and a schedule. Taking a post down retracts its claims.
     `group_public_posts` is rung 99, and so is `group_rosters.public`.
   - The card wears the group's band, bigger, saying "(public)".
3. **The carry.**
   - `group_carries` (rung 100) is what this node carried and through whom, so
     an ended carry withdraws exactly its rows (`fanout::withdraw_carried`).
   - Readers are each member's rebroadcast-followers here, never the member. The
     rows go `fanout::journal_shares_to`'s road, asking each post's author
     rather than the via: a member's node holds the group's lanes, not its
     members' public posts.
   - The group-sync beat's `public_pass` keeps the public lanes of a public
     group this node isn't in, if someone here wants it carried. It finds the
     group's machines by the gossip choice, else where the group was said to be,
     else each member's keys resolved through their serving records, as a follow
     does. It runs the carry again on every pass, because a share's retry would
     journal a late post to the author's rebroadcast-followers, who aren't the
     ones it was carried for.
4. **Following a group.** `group_follows` (rung 101). `GET`, `POST` and
   `DELETE .../groups/{group}/follow`; the `POST` takes `via` and `members` for
   a node that holds nothing of the group. Followers are carried with an empty
   via: every member's post as the group, direct. An unfollow withdraws those
   rows, unless the reader follows the author.
5. **The open page and the app.**
   - `GET /api/groups/{group}/public` and `GET /api/id/{seg}/groups`, which
     answer 404 and nothing for a private group.
   - `publicgroup.js` is the page at `/ringtome/groups/{group}`, signed in or
     out. A non-member landing on a group's member page sees it.
   - Founding offers "public". The join note says what joining a public group
     means.
   - The audience picker offers "in public, as a group" (`as-group:<id>`) in the
     feed's composer and Writer's bar.
   - A persona's card lists their public groups.

## What's still open

- **Drawings and schedules.** Drawing's door takes no `as_group`, and a post as
  the group can't be scheduled yet.
- ~~The cost of the public pass~~ (settled 2026-10-17). Outside the group it
  runs a group's pass every ten minutes, at once when whom it carries for
  changes, and every beat on the test rig (`public_pass_due`). It re-runs the
  carry only while a counted post isn't here yet. The group digest
  (plans/NETWORK.md) turns its exchanges into one question per partner when
  nothing moved.
- **The UI wants a look in a browser.**
