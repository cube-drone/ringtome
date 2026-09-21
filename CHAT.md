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

12. **An IM is a room sealed to one person (settled 2026-09-20).** Curtis: a button on
   anybody's page opens "a Chat window that's sealed to Just Them". A two-person chat is not
   a second chat system - it is a room (ruling 1) wearing the pair's rules: sealed to exactly
   one other person through the post's own audience (*Contact tags*, ruling 5) with one
   member, and marked `im` on the SIGNED header, so every door knows what it is holding
   without opening a seal. The header says THAT there is a pair, never who: the audience
   stays the author's own memo, as every audience is. *Direct Messages: The Sealed Pair*
   argued the case for two - "the only size at which membership is not a mutable object" -
   and this is that shape carried by the room machinery rather than an epoch of its own: the
   key is the post's key, the pair is the author plus the one person the seal admits, and
   there is no roster, no admission and no ejection. What differs from a room, and why:
   - **Nobody owns it.** The post has an author because a post does; the conversation does
     not. Both sides keep the WHOLE of it - both are its archive (ruling 6), both sync it
     whole and neither prunes it to a budget, because a room only its pair can hold is not
     a cache to trim. An IM never falls off the sync beat either, however long since anyone
     looked.
   - **No moderation, no takedown.** Mute, the deputy's badge, close and delete are refused
     at the door and absent from the chrome. Every one of them is a power over the other
     person's record, and between two people the honest powers are to stop talking and to
     block. There is no third party to protect anybody from.
   - **It does not travel.** A sealed post that is not "onward" already refuses shares, and
     an IM is never onward, so there is nothing to pass along. The room's post does sit in
     the feed - for the two of them, which is what sealing to one person means (Curtis,
     2026-09-20) - and the chat window carries no link to it: the post is the plumbing,
     not the conversation.
   - **Trust is not a dial here - except over media.** "Hide lines from people you don't
     trust" has no say in an IM: it is one person's words, and if you did not want them you
     would not be in it. The VEIL is a different question and it stands (Curtis, 2026-09-20):
     a picture arrives unasked wherever it is said, so a stranger's media waits behind a
     click here as it does in a room. The room rule exempts the CREATOR, because you chose to
     enter their room; the exemption lifts in a chat for two, where the creator is the other
     person and opening a chat with you is not a relationship with you. One rule, with its
     own vectors, read by the chat floor and the feed's room card alike
     (`js/pure/chatveil.js`).
   - **One chat per pair.** Opening a chat with somebody who already has one open with you
     opens theirs. Which side minted the post is bookkeeping - the window wears the other
     person's face and their name as this reader calls them TODAY (a nickname when one is
     set, else the name they answer to now), never the title the post was minted under.
   - **Its own shelf.** The chats column files IMs between the rooms and the rooms one has
     left.

13. **A chat from a stranger is a request (settled 2026-09-20).** Curtis, reading what ruling
   12 had built: "any user can start a chat with any other user, sight unseen, no trust
   relationship at all?" Yes - and *The Inbound Gate: One Floor, Three Surfaces* names a DM
   as the first of its three surfaces, gated by a trust floor that has not shipped, so the
   gate's only live refusal today is a block. The answer taken (Curtis's choice among the
   floor, requests, and both) is **requests**, which leaks nothing to the sender and needs no
   number nobody has yet:
   - **A request is an IM opened by somebody this persona has not placed** - no trust and no
     interest on their own ledger - and not yet accepted. A dial will not do as the test: the
     chat machinery writes one itself when it pulls a room, and a relationship is something a
     person says, never something their computer says for them.
   - **It rings nothing.** No bell for the words, and none for the chat's post either - "they
     mentioned you in a post" pointing at a chat's plumbing is news about nothing. The chats
     column's own pile is where it waits, because that is where it can be answered.
   - **It syncs nothing.** Looking at a request is not accepting it: its words are pulled once
     so there is something to judge, and the room goes on no beat and into no register.
   - **Three answers.** Accept - which joining is, and which saying something also is, because
     talking to somebody IS agreeing to talk to them. Block, which ends it. And walking away,
     which leaves it sitting there and tells them nothing at all.
   - **What it is not.** It is consent, not safety, and not spam-proofing: the knock still
     costs proof-of-work and the stranger tier is still a ring, and neither of those is what
     this is for. The floor returns when Trust ships, in front of this rather than instead of
     it.

14. **A chat for two answers to its key, and a node holding its words is in it (settled
   2026-09-20).** Found while testing ruling 13: a line said in an IM reached the other side
   perhaps half the time under load, and the half that failed failed forever - the word was
   on its sayer's chain and nowhere else. Three things had to be true for the first word of a
   chat to arrive, and none of them was:
   - **The creator's node must know who to ask.** Its directory of a room is the people it
     has already heard from (ruling 4), which at the first word is nobody. It also knows who
     the SEAL admits - for an IM, the one other person - and that is who it now asks. The
     push a say makes is one attempt at the first endpoint that answers; nothing stood behind
     it.
   - **The other node must serve its own words.** A sealed room's lane asks who the dialing
     endpoint serves, off the peer ledger - and a pair who do not follow each other have no
     such rows about each other, so the answer was nobody and the lane stayed shut. An IM now
     answers to the room's KEY, as an onward room does (ruling 7's door). The reservation
     that keeps a plain sealed room strict - its audience can change, and an untrust must
     stop what comes next - does not apply to a pair, which is the one size whose membership
     cannot change (*Direct Messages*), so there the key is the whole story.
   - **A node that has SPOKEN in a room is in it.** "In" was `rooms_open` or one's own post,
     which is a window being open, not a record being held. A node holding a room's words is
     in that room by the only definition the lane needs, so the memo answers too.
   Each of the three was reverted in turn and the claim failed each time, which is how they
   are known to be load-bearing rather than plausible.

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
   door, and the user-card picker knows the room's participants. **Built 2026-09-19.**
   `ChatMessage.mentions` (key 4, additive, capped): the personas the body's user cards
   name, derived at say, never the speaker, and in a sealed room only those the seal admits
   - in the clear on the chain, which travels only under the room's door, so the notice can
   be checked without the room's key. The notice is `notice_kind::ROOM_MENTION` (6), the
   mention's own envelope road: the message as evidence, its `doc_id` the room and its
   `detail` the room's author. Two follow-edge exemptions, since no fold reads a room
   chain: the inbox gate accepts it from a followed sender, and the bell keeps it. A left
   room rings nothing - the recipient's own `rooms` register says so, and the door accepts
   and keeps nothing. The bell's row reads "mentioned you in <room>", a link into the room
   worn as its name. The `@` picker in the room offers who has spoken there first, then
   contacts and the directory. Suite: the feed suite's bell claim.
7. **Closing & Deleting Rooms.** **Built 2026-09-19.** Both powers are ruling 10's and
   both doors already stood: close is the settled wish re-published on the room's own draft
   (the page finds the draft on the mirror by its publication), delete is the post's
   takedown. Close is one-way - a re-publish carries the settled wish forward, so a closed
   room stays closed; the record stands. The rooms door and the enter door answer `closed`,
   the column wears the settled mark, the header the chip, and the owner's header holds
   "close" and the trash, the takedown confirmed in the house modal with the honest word
   about orphaned chains. Suite: the feed suite's owner claim - closed here and there, the
   next word refused, the wish never lifted, the takedown gone from every list.
8. **Deleting & Editing Messages.** **Built 2026-09-19.** Both are later entries on the
   speaker's own chain, never changes to earlier ones: a delete is a message that `retracts`
   the line (the same key a reaction's take-back uses), an edit a message whose words
   `edits` (key 7) the line. The memo remembers a line's fate on its row - deleted, or the
   newest edit's words - so the floor shows the new words in the old line's place, marked
   "(edited)", with its reactions intact, and a deleted line leaves the floor, the count and
   the badge; the archive hands a page's edits over with the page and never serves a deleted
   line. Only one's own lines, held here and not already deleted. The hover menu's edit loads
   the words into the composer under an "editing a line" banner; delete asks first. Suite:
   the feed suite's edit-and-delete claim.
9. **Emoji Responses.** **Built 2026-09-19.** Slack's shape: an emoji said in answer to a
   line is a message on the reactor's own room chain (`ChatMessage.reacts_to`, key 5, the
   target's hash; the body its shortcode, sealed as the room's words are), filed by the
   fold in `room_reactions` (node schema 52) rather than among the lines, served by the
   history door stacked under its target - once per person per emoji, most-said first, who
   on hover - and by the archive with the page it answers. Hovering a line shows its menu:
   the smiley opens the picker (the post card's palette, shared through `emoji.js`), and a
   line of one's own also shows edit and delete, unwired until slice 8. Un-reacting is
   built: clicking a pill one is in takes the emoji back - a message that `retracts` (key 6)
   an earlier entry of the speaker's, one per standing copy, which the fold marks withdrawn
   in the memo (the chain keeps both; the stacks stop counting). The same key is slice 8's
   delete. The rooms badge and the bold ignore reactions. Suite: the feed suite's reaction
   claim, take-back and re-say included.
10. **The Mute List**
11. **IMs.** **Built 2026-09-20** (ruling 12). The header grows `im` (key 23), absent when
   false and carried forward on re-publication - once an IM, always an IM. The publish door
   checks the shape rather than the word: a room, sealed to `@mentioned`, naming exactly one
   person who is not the author, else it refuses. The chat's words ARE that user card, so
   the audience, the mention notice that tells the other person it exists, and the feed card
   all come from the one thing the mint writes. `GET /ims/{other}` answers the chat already
   going - mine by its audience memo, theirs by the rooms this persona may see - and the
   client mints only when that 404s, which is what keeps one chat per pair. The refusals:
   mute and deputize at the room's doors, close at the publish door, delete at the takedown
   door. Every word said in an IM names the other person, so the room-mention notice is the
   road that reaches them (the settled question below has why), and the room's door and the
   chats column both ask the key lane before refusing.
   `archivist_here` says yes to any node holding an IM (only the pair can hold one),
   so neither side's budget ever prunes it, and the sync beat picks up IMs however stale.
   The chats column files them under "IMs" between the rooms and the left pile; the window
   wears the other person, drops the trust filter, the post link, leave, close and delete,
   and offers the block in their place.
   **Ruling 14, the same day:** the first word of a chat now arrives without the sayer's push
   landing - the creator's node asks whoever the seal admits, at the address it has, showing
   the room's key at a door that a chat for two answers to, and a node that has spoken in a
   room serves it. Claim: bea says a chat's first word with her node dead to the network, and
   ada's node goes and gets it.
   **Ruling 13, the same day:** an IM from somebody this persona has not placed lists as a
   REQUEST - its own pile in the column, no bell (the chat's post is hushed too), no sync, no
   join - until it is accepted by the button or by answering, which the say door treats as
   the same act. Suite: `ims.cjs`.

## Settled questions and residuals

- **Settled 2026-09-20: an onward room answers to the key, not to the creator's list.**
  A room passes along like the post it is (the room header's pass-along button). A public
  room travelled whole already; an onward one went halfway, because the room's chains come
  from the creator's node and that node judged a dialer by the CREATOR's trust, which an
  onward reader is outside of by construction. Curtis: "it makes sense to have the node
  return a trusted+onward chain to anyone who can prove that they hold the key that could
  read that chain." So it does. The dialer's Hello carries a **room-key proof** per room it
  asks about - `blake3` keyed with the room's key over the room id and both endpoints of
  the connection, the member proof's idiom with a shared secret in place of a signature -
  and the room's fragment doors take the same proof. A sealed room marked onward opens to
  it; a plain sealed room keeps the strict gate, because there the author's list is the
  whole story and an untrust must still stop what comes next. The reasoning, stated once:
  the words are ciphertext to anyone without the key, the key travels the trust web the
  author asked for, and the proof binds to the connection, so overhearing one buys nothing.
  The address stays what it is everywhere else in the system - not a capability. Proven by
  the onward suite: the room passes along, the reader it reaches reads it on the key alone,
  and someone handed only the address gets nothing.

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
  shows them anyway. **The room hears it** (Curtis, 2026-09-20, amending the first cut's "the
  muted are told nothing"): a moderation act in a shared room is not a block, which is the
  one refusal that stays unspoken, so muting says a line in the room naming both people, and
  lifting it says another. The mutes travel with a share, as every annotation on the post
  does. **Built 2026-09-20**: the creator's own `mute` labels on the room post, sealed with
  the room when it is sealed; this node honours them for every surface it serves - the floor,
  the count, the badge - so an honest client gets it for free; the roster still names the
  muted and sits them last, which is where the creator lifts it; and the line rides a
  `notice` on the message (kind and subject), with a plain sentence in the body so a reader
  that does not know the kind still reads what happened. The doors are
  `POST`/`DELETE …/rooms/{author}/{doc}/mutes/{who}`, the creator's alone. **A muted reader
  is told by the room, so their own page says it plainly** (Curtis, 2026-09-20): the composer
  stands down behind "you've been muted by the room", the line menu with it, and their own
  node's say door refuses - an honest node does not grow a chain whose words no floor will
  show. The moderators
  list is built too (**2026-09-20**), as deputies: a second label the creator publishes
  naming a persona whose mutes count as the creator's own. Only the creator hands the badge
  out and takes it back - a deputy deputizes nobody - and a deputy may mute anyone but the
  creator and another deputy, since a mute war between deputies is not moderation. The room
  hears both acts, as it hears a mute. Adding by contact tag remains a UI nicety nobody has
  built. A
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
  **Built 2026-09-20** as ruling 12 and slice 11.
- **Settled 2026-09-20: a private chat reaches the other person by three roads, and none of
  them is the feed's gate.** Curtis opened a chat with somebody who followed him back and
  trusted nobody, and they saw nothing at all - not in their chats, not in their bell. Every
  surface that would have shown it was waiting on the same thing: away from the author's node
  an audience of ONE is unknowable, so the feed's gate refuses until this computer holds the
  room's key, and the only thing that asked for the key was the notification fold - which
  asks on behalf of followers, and had not run. A chat sealed to one person cannot depend on
  the road built for posts sealed to a crowd, so it has its own. **Every word said in an IM
  names the other person**, which makes it a room mention - the one notice the follow-edge
  rule exempts, because no fold reads a room chain - so the bell rings whether or not they
  follow, trust, or have ever heard of the speaker. **The room's door asks the key lane
  before refusing**, since a local "no" for a sealed room may only mean "this computer has
  not asked yet", and holding the room's key IS admission: every word in the room is sealed
  under it. **The chats column judges an IM the way its door does**, asking the lane once for
  the room rows it could not judge, the lane's own refusal memo keeping "once" honest. The
  claims: a word rings the bell trusted or not; a chat with a stranger who follows nothing
  arrives, opens and reads; a chat this computer has never asked about still lists.
