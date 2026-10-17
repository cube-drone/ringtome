# Group rooms - chats that belong to a group

Curtis's ask (2026-10-16): "Chats" already has a main section and a private
messages section; add a section for every group you're in, holding that group's
chats. The new-chat form takes the posts' "only show to" picker, groups among
its choices. And work out how a group's chat runs on the server.

This is slice 5 of [GROUPS.md](GROUPS.md) ("rooms for groups: the standing room
and ad-hoc ones"), built on [CHAT.md](CHAT.md).

## Rulings (Curtis, 2026-10-16)

1. **A group holds as many rooms as its members start**, and founding a group
   opens its default room, **#general**.
2. **Who starts a room:** any member (GROUPS.md; not ruled otherwise).
3. **Group owners moderate every room in the group**, beside the room's creator,
   and **nobody deputizes** in a group's room: "they can't deputize other users
   the way that users can when they run a chat on their own".
4. **A removed member's lines stay**, "but a removed member shouldn't be able to
   keep posting in a room or seeing a room's output (tests for this pls)".
5. **Pictures, sounds and films** are said in a group room "just like they are
   in regular chat" - built with the rest, not deferred.

## The shape, in one paragraph

A group room is a room (CHAT.md, ruling 1: a room is a post) posted to the group
instead of to the public: a room post on its creator's lane for the group, as
any group post is. Its messages are what every room's are: entries on each
speaker's own `(speaker, CHAT, room doc)` chain, read together. Everything that
today asks "may this person open the room post?" asks the roster instead: a
current member may, nobody else may. So a group room reuses the room machinery
whole, chains, gossip, the directory, history, the archive and the floor, and
changes only where the room post is found and who its door admits.

## What changes on the server

1. **Posting a room to a group.** `roster::publish` already posts a draft to a
   group; it learns the room flag the public publish takes (`room: true`), so
   the header's format is `room`. The group's page and feed show it as the
   feed's room card, which opens the room. It wears the group's post rules: an
   owner may hide it, its author may take it down (delete, ruling 10) or
   republish it settled (close, ruling 10).
2. **Finding the room post.** `chat::room_head` reads public headers and held
   fragments today. A group room's header is on a group lane, so the node keeps
   a memo of the group rooms it holds,
   `group_rooms (room_author, room_doc, group_id, header)`, written by the
   group's derivation (`refold`) beside its other tables and swept as they are:
   a room taken down or hidden leaves it. `room_head` and `room_author_of` read
   it third. Migration rung 93.
3. **The door is the roster.** Each place a room's door is asked learns one more
   case, "a group room admits a current member":
   - `room_verdict` (reading, saying, the history door): the viewer is a member
     (`roster::is_member`).
   - `instances_dialer_may_hold` (the CHAT sync lane): the dialing node serves a
     current member, the proof the group's own lanes already ask
     (`roster::dialer_may_hold`).
   - The directory and reach answers (ruling 4): the same.
   - Mention notices: a line naming a member rings them, scoped to the door. A
     member removed or banned stops being admitted everywhere at once, since
     every check reads the roster as it stands. What their node already holds,
     it keeps: the bound every group post and every seal carries.
4. **Plaintext, like the group's posts.** A group's content is plaintext on its
   lanes and the boundary is who is served (GROUPS.md, section 6). A group
   room's messages are the same: unsealed entries, served only through the door.
   There is no room key.
5. **The topic rings bells; it never carries words.** Gossip has no door: anyone
   who knows a topic hears it, and a removed member knows every topic of every
   room they were in. So a group room's topic carries only a bell - "this member
   said something", the speaker's root - and whoever hears one pulls that
   speaker's chain through the sync lane's door (4), which refuses a removed
   member. The topic derives from the group id, the doc and the room post's
   first-version hash, which only a node served the group's lanes learns, so a
   stranger can't even hear the bells. A removed member still can, and still
   sees presence and typing; never a word.
6. **New lines from non-members are refused.** The chain fold keeps a group
   room's line only from a current member - or from someone who has gone
   (removed, or left) when the line is dated before the entry that ended their
   membership. So their lines from before stay, as their posts from before do,
   on every node, whenever it first sees them; their lines from after land
   nowhere. A removed member who backdates a line is the owners' to mute. A
   member's first line that arrives before their joining does is folded again
   once the joining arrives.
7. **Who to sync from.** A group room's chains are pulled from the creator's
   node and the directory as today, and also from the group's own endpoints
   (`roster::endpoints`): every member's node is a holder from the start.
8. **History.** Ruling 6 unchanged: the last ten thousand lines everywhere, the
   whole at the creator's node, full-sync for any member who wants an archive.
9. **Moderation.** The room's creator and the group's owners moderate it
   (`may_moderate`); nobody is deputized, and the deputy door refuses. A mute is
   a `mute` label on the room post said on the moderator's lane for the group,
   as the group's post labels are - a public label would name the group's post
   in public. Neither an owner nor the room's creator can be muted in it.
10. **Media is the group's.** A line's pictures, films and sounds become the
    group's media documents on the speaker's lane for the group, as a group
    post's do, marked `part_of` the room so the group's page never lists them as
    posts. They come to the other members' nodes with the group's lanes: a line
    naming one sets off a group sync on the reader's node.

## The standing room

A group holds as many rooms as its members start. Besides those, every group has
one default room, **#general**, so a new group has somewhere to talk before
anyone starts a room.

- **It is an ordinary group room** that a group setting names:
  `Setting::Room(Option<(author, doc)>)`, an owner setting like the picture.
- **The founding opens it.** An older group's owner opens one with
  `POST .../groups/{group}/general`, refused while the group's #general stands.
- **Owners may replace it** (point the setting at another room) but not delete
  another person's room; its creator's node archives it as any room's does.

## What changes in the app

- **The chats column** keeps its piles (the rooms, IMs, requests, what you left)
  and adds one per group you're in, after the rooms: the group's triangle and
  name as its divider, then its standing room, then its other rooms, newest
  first. A group with no rooms yet still shows its divider and a "start one"
  link for owners and members.
- **The new-chat form** swaps its own select for `AudienceSelect`, the posts'
  picker: everyone, people I trust (and onward), the people mentioned, your
  tags, your groups. A group choice posts the room to the group (1). A link from
  a group's section opens the form with that group chosen, as the group page's
  "new post" does for the feed.
- **The group's page** gains a "chats" line beside its posts: the standing room
  and how many others, linking into the chat app.

## Slices

1. **The server** - built 2026-10-16. The room flag on the group publish, the
   `group_rooms` memo (node rung 93), the door in its places, the bell topic,
   the non-member refusal, the group's endpoints as holders, #general at the
   founding, owners moderating, the group's media. Acceptance:
   `integration/test/grouprooms.cjs` - #general at the founding; a member's room
   read and spoken in from another member's node; a stranger refused at every
   door; a picture said as the group's media, reaching the other member and
   never a post; owners moderating and nobody deputizing; a removed member's old
   line standing everywhere, their new one reaching nobody, and nothing said
   after reaching them.
2. **The app.** The per-group piles, the shared picker on the new-chat form, the
   link from a group's section, the room card in the group's feed, the owner's
   #general button for older groups.
