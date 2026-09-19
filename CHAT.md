# CHAT - real-time rooms

Curtis's brief (2026-09-18): a chat "room" is posted, as a post, with a post's visibility and
virality - friends only, the people you trust, everyone - and whoever can see it may rebroadcast
it where the post's rules allow, making the room visible further. The creator can delete the
post, which removes the room for everyone. Anybody who can see the room joins a gossip space
of the machines that are live in it and chats, live, with everyone else there, in a Slack-like
interface using Marquee with our additions - user cards, the emoji picker. History is the hard
part: chat is faster and more ephemeral than the rest of the application, and people expect
instant access to all of it.

The rulings below were settled with Curtis on 2026-09-18, the three open questions among
them; what remains open is marked residual. The chain-key change comes first, as its own arc.

## The shape, in one paragraph

A room is a post whose format is `room`. Everything about who may see it, share it and be told
about it is the post machinery as it stands: the seal, the audience, the mention notice, the
share button and its refusal on sealed posts. A message is a signed entry on its author's own
chain, on a lane that belongs to the room, so a room's history is the union of its
participants' chains interleaved at read time - the sealed pair's design at N - and nobody
ever writes anyone else's record. Live delivery is gossip carrying those same signed entries,
so the fast lane and the durable lane carry one thing and the chain sync heals whatever gossip
dropped. Retention is count-bounded per participant the way the inbox's is, and the creator's
node keeps its own room whole, which is where "all of it" lives.

## Rulings (settled 2026-09-18)

1. **A room is a post.** Format `room`, minted and published like any post, carried on the
   POSTS chain with a title (the room's name) and words (its description, Marquee). It wears
   every post rule unchanged: open, or sealed to everyone the author trusts, a contact tag, or
   the people mentioned (*Contact tags*, rulings 4 and 5), or to the people they trust and
   onward (ruling 7); shares allowed on an open or onward room and refused on any other
   sealed one (*Post visibility*); the feed, the shelf and the front page show it
   as a card that says "a room" and opens it. Deleting the post is the takedown every post has,
   and a room whose post is gone is gone: no surface assembles it, and clients leave the space
   (ruling 10 has the two powers, close and delete, and what each one honestly does).
2. **Who may be in the room is who may open the post.** The seal's one question,
   `seal_admits(holder, key document, subject)`, is the room's door: an open room admits
   anyone; a sealed room admits whoever its seal admits, and the room's key IS the post's key.
   A participant in a sealed room seals their messages under that key, as a reply under the
   author's seal does (*Replies under the author's seal*). Being admitted later opens the
   history; being tagged out closes the future, and what was already read stays read - the
   bound every seal carries.
3. **A message is an entry on its author's own chain, on the room's lane.** Single-writer is
   foundational (*Chains: One Per Key, Per Service*): a room is N chains, one per participant,
   interleaved at read by the ordering contract, exactly the sealed pair's "two chains, not
   one" at any N. Nothing shared is ever written, so there is nothing to conflict, and the
   creator deleting the post cannot delete a participant's words - only orphan them, as a
   takedown orphans its replies. **The lane is per room**: a chain keyed `(author, CHAT, room
   id)` - the first per-instance chain class, which the sealed pair needs too and does not yet
   have (a wire change: the chain key grows a third element, absent for every existing
   service). The alternative, one CHAT chain per author carrying every room's messages tagged
   by room, is rejected: syncing one room would pull the author's every other room too, and a
   sealed room's traffic would ride beside an open one's under one gate. (Open question 1.)
4. **The room's lane is gated by the room's door.** A room chain is served to a requester who
   proves they may open the room post: the public predicate for an open room, the seal's for a
   sealed one - the gated lane's "predicate is the parameter" (*Lanes: Public, Gated,
   Private*), with the room post as the parameter. Being in a room means syncing every
   participant's room chain, which is what a follow means for posts. **There is no roster**:
   a room's membership is the set of people who have spoken, and it is learned two ways that
   cover each other. The creator's node is the directory of record - it archives every
   participant's chain, so it knows everyone who has ever spoken and answers "who is in this
   room" under the room's door. And every live node carries a **room frontier** on the gossip
   space - the set of participant chains it holds and each one's head - merged by union, so
   a newcomer joining while the creator's node is dark learns the set from whoever is
   present, and a returning node learns what it missed. Chains are then fetched from any
   peer that holds them, under the room's door at every fetch; every participant mirrors
   every other's, so nothing depends on an author being online. The bounds: a room with
   nobody live and the creator dark is unreachable, which is when nothing is happening in it;
   and a lurker who never speaks has no chain and is visible only as presence.
5. **Live is gossip, and gossip carries the same entries.** Each room has an iroh-gossip
   topic; every live machine of every participant joins it, bootstrapped from the creator's
   node and the peer ledger's rows for the participants it already knows. A message is signed
   and appended to its author's room chain first, then published on the topic; a receiving
   node verifies it as it verifies any entry (signature, chain, authorization path) and folds
   it in place, out of order if need be, since the chain sync is what settles order. Gossip
   may drop, duplicate or reorder and nothing is lost, because the chains are the truth and
   sync heals the gaps at the next beat. A sealed room's topic id is derived from the room's
   KEY (`BLAKE3("ringtome-chat/" || key)`), so only key-holders can compute it, and its
   messages are ciphertext on the wire as they are at rest; an open room's topic derives from
   the post id. Presence and typing are gossip only, ephemeral, never persisted - the sealed
   pair's rule.
6. **History: recent everywhere, whole at the creator's.** A node keeps the last ten thousand
   messages of a room, and each participant's chain is pruned below that cutoff - the inbox's
   suffix machinery with a floor the room sets, so a room stays cheap to hold for everyone in
   it however many are in it (the settled question below has the numbers). **The creator's node keeps every participant's room chain
   whole**: the room is the creator's post, the archive is the room's, and "instant access to
   full history" is scroll-back that asks the creator's node for the prefix below the local
   floor, served under the room's door like everything else. Any operator may press
   **full-sync** on a room and their node holds it whole from then on - the volunteer archive;
   a sealed room's archive stays with nodes that can evaluate its gate. The honest bound, stated once: if the creator's node is gone and nobody
   else archived, history above everyone's floor is gone with it - which is what a room's
   creator deleting the post does on purpose, arriving by accident.
7. **The room view.** A Chat app at `/home/chat`: the rooms this persona may see (room posts
   in the feed and on followed shelves, plus rooms joined by link), each with its name, who is
   live, and an unread mark moved by a deliberate act, never by scrolling (*One Cursor*). A
   room is the message list newest at the bottom, the composer - Marquee with the user-card
   picker and the emoji picker, Enter sends, Shift-Enter breaks a line - and a presence rail
   of live participants. Messages render with the card's own machinery: a mention is a user
   card, a message that names you rings the bell as a post mention does (the mention notice,
   scoped to the room's door). Scroll-back pulls earlier history as ruling 6 describes.
8. **What a message is not.** Not editable and not deletable after the fact beyond the post
   rules every entry has: an author may retract their own message (a retraction entry, honoured
   by every honest client, the bound being what was already read). No reactions, no threads,
   no media in the first cut - each is a slice of its own, and each is a decision (a reaction
   is an annotation on a message; a thread is a room whose parent is a message; media rides the
   blob lane under the room's door).
9. **What a participant takes on, and how they leave.** To verify another participant's
   messages a node needs their key tree, so being in a room mirrors each participant's
   identity-public chain and profile at headers depth - small, public, the discovery
   pipeline's own shallow mirror - and nothing else of theirs: not their posts, not their
   follows, not another room. **Leaving is a first-class act and it is local**, since there is
   no roster to leave: the node stops syncing the room's chains, drops its memo and the
   mirrors it held only for that room, leaves the gossip space, and the bell stops ringing
   for mentions there; the participant's own past messages stay on their chain, retractable
   one by one. **Mute** keeps a room without its noise - no bell, no unread mark - for a room
   worth coming back to. **Block** is the block the whole system has, a private fact the
   node enforces everywhere: a blocked participant's messages are hidden, their room chain is
   no longer mirrored here, and their mentions never ring. For an open room being flooded,
   leaving is the reader's remedy and deleting the room is the creator's; anything finer is
   open question 2.
10. **Close and delete are two powers (settled 2026-09-18).** They answer different needs
   and the post machinery already has the shape of each. **Close is the settled wish** on
   the room post - the same flag that turns a post's comments off, set at any time through
   the door that exists: the post stays, the history stays, every participant may still
   read, and no honest client appends another message to any room chain, nor serves one
   minted after the close. A wish, not cryptography, honoured exactly by honest parties.
   It is the lifecycle act - the conversation ended, the record stands - and ruling 6's
   archive keeps its promise through it. **Delete is the takedown every post has**, the
   rarer and stronger act: the creator disowns the room and no honest surface assembles
   it. What it does to the messages is stated honestly: it ORPHANS them, as a takedown
   orphans replies. A room of twelve is twelve chains, single-writer; the creator can
   strand the other eleven's words, never destroy them, and each participant's own
   messages stay on their chain, retractable one by one (ruling 8). Neither power is
   "close" collapsed into "delete": letting one person hide a whole conversation from
   everyone else is a bigger power than deleting one's own post, and close gives the
   creator the moderation outcome without it. Slice 2's message gate refuses an entry
   whose room post is settled; the takedown's own machinery does the rest.
11. **Media rides the room the way it rides a share (settled 2026-09-18).** "Chats should
   carry embedded media content." A message is a 16KB entry and a picture is not, so a
   message never carries bytes: it carries REFERENCES, exactly as a post does, and the
   post's media machinery is reused whole rather than given a chat-shaped twin. Today the
   room composer is a bare textarea, and a message that pasted a reference to a published
   picture renders only for readers who FOLLOW the speaker - the twin lives on the speaker's
   posts chain, which the room lane (ruling 4) does not carry, so a reader who reached the
   room by link sees a broken image, and in a sealed room the born-public twin leaks the
   picture while the words stay sealed. The plumbing, in the order it stacks:
   - **Say bakes.** The say door runs the publication bake on the message body: the
     picker's private media documents become public twins, the references are rewritten to
     them, and the message's refs are derived from the rewritten body, as `bake::publish`
     does for a post. The composer swap (the post composer with its colon emoji picker and
     its bang image picker, in place of the textarea) is the last step, not the first,
     because a picker's output means nothing until say bakes it.
   - **The wire.** `ChatMessage` gains an additive `refs` list of the twins the body embeds,
     capped as a header's refs are (`MAX_REFS`), and the reader's fold trusts a message's
     refs the way it trusts a header's: a claim about the body, self-scoped, over-claim
     obliging the speaker's own archives and under-claim breaking the speaker's own images.
   - **The reader's obligation.** The memo fold, seeing a message with refs, mints cover rows
     with a new covering kind - a room message, never a post - and wants the twins: the
     header over the fragment lane's `Want`/`Have`, the bytes over blobs by hash, first from
     the creator's node (the archive, ruling 6, holds them) and then from the speaker's own
     nodes. The serve side's fragment gate learns the room rule the sync lane already has:
     a twin a room message names is served under the room's door to a dialer the room
     admits. No fold or sweep ever parses foreign Marquee - the refs say what to fetch.
   - **Retention.** A pruned message releases its covers, so media dies with the line on a
     budgeted node and lives at the archive; the archive's obligation grows from messages to
     bytes, and a room gets a MEDIA budget beside its message budget - the post's
     `media_budget` per message, and a room-wide ceiling the operator's full-sync accepts
     knowingly. The reaper's rule holds: a twin nothing covers is nobody's to keep.
   - **Sealed rooms seal their twins.** A twin embedded in a sealed room is sealed under the
     room's key, title included (the sealed-bodies machinery, sealed titles slice 2), not
     born public - and its key is the room's key, so admission to the room is admission to
     the picture and nothing new is granted. Until that lands, a sealed room's say REFUSES
     a body with media rather than leak it: refusal is honest, a public twin is not.
   - **Deletion comes free.** The twin is a document on the speaker's posts chain, so the
     speaker's ordinary takedown tombstones it and the fragment lane's revalidation carries
     the death; retracting the message (ruling 8) releases its covers the way an edit
     releases a post's. Sound and video ride the same road - the crush trilogy already
     makes every upload a bounded twin, and a room line embeds whatever a post can.

## Slices

0. **The chain key.** `(author, service, instance)` on the wire and in the node - its own
   arc, no chat in it, green under the existing suites before slice one. **Built 2026-09-18**
   (*Chains: One Per Key, Per Service*): `ChainId`, `Frontier` and `Anchor` each carry an
   optional instance, absent on the wire when none; `entries`, `equivocations` and
   `chain_heads` carry it as a column; `imaol::append_on` writes a per-instance chain and
   the crown keeps a ceiling per instance.
1. **The room post.** Format `room` on the wire, the mint, the card on the feed and the shelf,
   the share rule, the Chat app listing the rooms a persona may see, and the room's door
   (`seal_admits` with the room post as the key document). No messages yet: a room you can
   enter and find empty. **Built 2026-09-18.** `doc_format::ROOM` (7); a Marquee draft in
   the `chat` bucket publishes with `room: true` and the mint carries the format forward,
   so once a room, always a room; the card says "a room" and opens it; the kind row and the
   node shelf know the word. The Chat app (`/home/chat`) opens rooms with the composer's
   audience list and lists the rooms a persona may see: its own, the ones its feed carries
   through the feed's gate, and the ones it entered by link (a private `rooms` register,
   emptied by leave). The door is `GET /rooms/{author}/{doc}`: an open room admits anyone
   who holds the post, a sealed one whoever `seal_admits` admits with the room post as the
   key document. The `rooms` suite: ada's open and sealed rooms; bea, trusted, lists and
   enters both; cal, a stranger by link, enters the open one, is refused the sealed one, and
   leaves; the share rule is the post's own.
2. **The room lane.** The per-instance chain key in the proto crate and the store; the
   `CHAT_MESSAGE` entry type; the gated sync predicate; the room-floor retention with suffix
   admission; a `room_messages` memo folded from the chains; the door that serves a room's
   recent history. Messages arrive by sync alone, on the beat: slow, complete, and honest.
   **Built 2026-09-18.** `service::CHAT` (13, public, suffixed) and `entry_type::CHAT_MESSAGE`
   with a payload naming the room's author and carrying the words, or their ciphertext under
   the room's key. The Hello gained an instance scope: a per-instance chain travels only on
   an exchange that names its instance, so a room's lane never carries a persona's other
   rooms, while the identity and profile ride beside it at headers depth (ruling 9). The
   serve side accepts a room-scoped exchange for any persona when the room named is one this
   node is in, holds such a persona at the room scope, and drops a sealed room's instances
   for a dialer serving nobody its seal admits. A persona's OWN computers carry its room
   chains whatever the scope, as they carry everything (2026-09-18: a message said on one
   computer never reached the persona's other one, because the device mesh's sync is
   unscoped and the lane rule had kept room chains off it). A participant's node pushes its chain to the
   creator's node after every message; a reader's node asks the creator's node who has
   spoken (`WantRoom` on the fragment lane, under the room's door) and pulls each speaker's
   chain from it, on entering, on a slow beat for rooms opened lately, and on demand. The
   `room_messages` memo folds from every CHAT chain a node holds on the fold lane's CHAT leg
   and prunes to the room budget beside the chains. Doors: say, history (sealed words opened
   with the reader's key; nothing said after a close), sync. The `chat_lane` suite: a
   follower's words reach the creator's node and the creator answers; a stranger by link
   pulls both and is heard back; a sealed room's words open for the trusted reader and the
   stranger may neither enter nor pull; closing refuses the next message and stands the
   record.
3. **Live.** iroh-gossip as a dependency; a topic per room; publish-after-append; verify and
   fold on receipt; presence and typing. The room view becomes live. **Built 2026-09-18.**
   `iroh-gossip` on the node's endpoint, its ALPN in the one table the accept loop and the
   test gate share. A room's topic id is blake3 over a domain and the room's KEY for a
   sealed room - no key, no topic - and over the post's name for an open one. A hosted
   persona's node joins the topic when the persona opens the room's live socket
   (`GET /rooms/{author}/{doc}/live`), bootstrapped from the creator's endpoints and every
   known speaker's, whose paths the room's sync already taught the endpoint. A message is
   appended to the speaker's chain first, folded, then published on the topic as the same
   signed entry; a receiving node checks the frame names the room and its author, then
   ingests it through the gate sync uses - the speaker's own database, their key tree, the
   chain's link - folds, and tells its sockets the floor moved. A speaker it holds nothing of,
   a gap beneath the message, or a lagged topic is the durable lane's to heal: the node pulls
   the room. Presence and typing are beacons on the same topic - "here" for thirty seconds,
   "typing" for six - never persisted, and the socket says who is here. The `chat_live`
   suite: two sockets hear each other arrive, a message crosses with no beat rung and the
   socket says so, and typing is a beacon.
4. **History.** The creator's node as archivist; scroll-back below the room's window; the
   full-sync button. **Built 2026-09-18.** The creator's node never prunes its own rooms, and
   neither does a node whose operator pressed full-sync (`room_archives`, node schema 51).
   The history door pages the local memo and, when the page runs short on a node that is not
   the archive, asks the creator's node for what lies beneath over the fragment lane
   (`WantRoomHistory`, answered as a run of `RoomHistory` frames ended by an empty one, each
   entry verified here and attributed only to a speaker whose tree this node holds); served,
   not kept, so the budget stays the budget; the door says whether more lies beneath. The
   room page reads earlier pages when the floor reaches its top, keeping its place. Full-sync
   (`POST`/`DELETE …/archive`, the node admin's) marks the room and walks every speaker's
   chain down from this node's floor to its beginning - a room chain now backfills beneath
   its floor on the room's lane, and a prune reconciles the frontier memo so the next Hello
   claims the true floor. Suite: `chat_history.cjs`, with the rig's room budget at eight.
5. **Media.** Ruling 11, in its stated order: say bakes; `refs` on the wire; covers and
   the fragment-lane fetch under the room's door, served by the archive; the room's media
   budget and release on prune; sealed rooms seal their twins (refusing media until they
   do); then the post composer in the room, pickers and all. Suite: a picture said in an
   open room renders for a reader who reached the room by link and holds the speaker at
   room depth; the archive serves the twin; a pruned line takes its picture with it; a
   sealed room refuses media until its twins seal, then seals them. **Built 2026-09-18**,
   sealed twins included - the post machinery already sealed a twin under a key with a
   named holder (a reply's twin under its parent's seal), so a room's twin seals under the
   room's key with the room post as holder in the same pass, and no refusal was needed.
   `ChatMessage.refs` (key 3, additive); the say door's `bake_words`; cover rows keyed by
   the message hash (`fragments::cover_for_message`, `release_covers`), walked off the
   memo fold's path and released by the prune; the public body door reads the shelf for a
   persona whose held chain lacks the document, which a room-depth persona's always does;
   the room composer is the post composer's live surface (`LiveMarquee` with `keys` and a
   `placeholder`), pickers and uploads into the chat bucket. Media from the open web is
   refused in a room. Suite: `chat_media.cjs`.
6. **Mentions and the bell.** A message naming a persona rings their bell under the room's
   door, and the user-card picker knows the room's participants.

## Settled questions and residuals

- **Settled 2026-09-18: the per-instance chain.** The chain key grows a third element,
  `(author, service, instance)`, absent for every existing service and required for rooms -
  its own arc before slice one, landing green under the existing suites with no chat in it.
  Curtis's reason reaches past chat: "the person-to-person chat is basically just a special
  case of chat room - we'd want those chains encrypted by a key only visible to both players,
  but that's essentially the 'only show to [users mentioned in this post]' stack writ large."
  So the sealed pair is a room of two, sealed to the people mentioned, and the DM section of
  the plan is amended when that room is built rather than designed twice.
- **Settled 2026-09-18: moderation is a published mute, and moderators are named.** "Rooms
  need moderation, in particular ones that are publicly accessible." A mute is the creator's
  ask, worded as the settled wish is: a public annotation on the room post naming the muted
  persona, honoured by every honest client - their messages hidden for every reader, their
  room chain no longer mirrored or archived - and not cryptography, since a malicious client
  shows them anyway. The muted are told nothing (a block is the one refusal that is not
  spoken), and the mutes travel with a share, as every annotation on the post does. A
  **moderators list** is a second annotation the creator publishes, naming personas whose
  mutes honest clients honour as the creator's own; it grows one persona at a time, or by a
  contact tag from the People page - a UI nicety only, since the tag is private and never
  travels: adding by tag resolves to the tagged roots at that moment, and the list names
  roots. A sealed room has the seal as well: untag them, and their future closes.
- **Settled 2026-09-18: a room budget, a speaker ceiling, and full-sync by choice.** The
  unit of retention is the room, not the participant: a node keeps the last **ten thousand
  messages** of a room, no knob, and each participant's chain floor is derived from that
  cutoff (the suffix machinery prunes each chain below the room's ten-thousandth most recent
  message), so a ten-person room keeps about a thousand of each and a ten-thousand-person
  room keeps a few from most and many from the talkative. The budget bounds the chains synced
  without a cap being written down - at most as many speakers as appear in the window - and a
  ceiling of the thousand most-recently-active speakers sits under it for the one cost the
  budget does not bound, the identity mirror each speaker needs. The creator's node keeps the
  room whole. Any operator may press **full-sync** on a room, which tells their node to hold
  every participant's chain whole from then on - the volunteer archive, one button, so a
  popular room survives its creator's node going dark.
- **Rate limits and floods.** A room's gossip topic is reachable by whoever can compute it; for
  an open room that is everyone, and the inbound gate's stamp and standing do not apply to
  gossip. The room's door is the gate at sync; the topic needs one of its own.
- **The DM is a room of two** (settled with question 1): the same slices, a narrower door.
