# Unlocks

A design draft (2026-10-05). Nothing built.

Horse Drawing Tycoon 2 hands a newcomer everything at once: seven apps, a
publishing model, sealing, tags, trees, chat, files. Unlocks give it to them a
piece at a time. A player starts with almost nothing and buys the rest with
HorseBucks from hrseBank's Market, each purchase arriving with an explanation of
what it opens. It is a tutorial with a price tag, not a security boundary: the
HorseBucks are easy to come by (the contracts pay tens of thousands for small,
teaching tasks), and the node serves every feature to anyone who asks it.

What Curtis asked for is under _The ask_; his answers to the first questions are
_Rulings_. Everything after that is Claude's proposal for him to correct.

## The ask (Curtis, 2026-10-05)

1. **New items in the Bank's Market column, above hrseBonds,** each with an
   explanation of the app or feature it unlocks.
2. **A new player starts with just their persona, hrseDrawing and hrseBank** -
   and hrseServer, if they're a node administrator. Everything else is bought.
3. **The unlocks:**

   | Unlock                      | Price        | Opens                                                                                |
   | --------------------------- | ------------ | ------------------------------------------------------------------------------------ |
   | Friends                     | H$ 1,000     | hrsePeople                                                                           |
   | Social                      | H$ 1,000     | hrseFeed, and publication everywhere                                                 |
   | ~~hrseMsg~~                 | ~~H$ 1,000~~ | ~~hrseMsg~~ - struck by Ruling 6                                                     |
   | Private notes               | H$ 2,500     | hrseWriter                                                                           |
   | Chat                        | H$ 5,000     | hrseChat                                                                             |
   | Taxonomy & tree publication | H$ 2,500     | the tree, and publishing a notebook                                                  |
   | Reactions, tags & filters   | H$ 2,500     | tags, the tag columns and filters, reactions                                         |
   | File upload                 | H$ 5,000     | hrseFiles, and every upload button                                                   |
   | Pins                        | H$ 2,500     | pinning                                                                              |
   | Public post editing         | H$ 5,000     | editing a post after it's published                                                  |
   | Video upload                | H$ 10,000    | uploading video - with a warning that it is experimental and doesn't work everywhere |

4. More will come; build these first, and see.

The second batch, from Ruling 5 - the picks are Curtis's, **the prices and
prerequisites are Claude's proposal**:

| Unlock                   | Price     | Opens                                              | Requires        |
| ------------------------ | --------- | -------------------------------------------------- | --------------- |
| Sharing                  | H$ 2,500  | rebroadcasting someone's post                      | Social          |
| Links                    | H$ 2,500  | Writer's links column                              | Private notes   |
| Chats for two            | H$ 2,500  | a private chat with one person                     | Chat, Friends   |
| Sealed posts & audiences | H$ 10,000 | trusted only, and choosing who a post is meant for | Social, Friends |

A third (Curtis, 2026-10-05): **Horse Financial**, H$ 500, opens hrseBonds "and
other financial instruments" - second to last in the Market, with **Video upload
last**. A bond already held stays in the portfolio, and sells there in debt: the
way out of debt is never for sale.

Pins need both Private notes and Social (Curtis, 2026-10-05): a note and a post
are the two things a pin pins.

**Colorways** (Curtis, 2026-10-05), each sold alone, cosmetic only and not meant
to be reachable on contract money - "an enticement for the user to keep engaging
with the game's systems": horse-relax and witchlight stay free; doors-xp, bosc,
micross, terminal and three new phosphors - terminal-white, terminal-cyan,
terminal-orange - are H$ 25,000 each, and a fourth, terminal-gold, H$ 500,000.
The Market shows them in a section of their own after the hrseBond (unlock ids
`colorway-<name>`); the profile's picker offers the free ones, the owned ones,
and the one worn - a colourway chosen before it was for sale stays on.

## Rulings (Curtis, 2026-10-05)

1. **Everyone starts locked** - existing personas included, Curtis's own. He's
   the only real user; nobody else's work disappears, and his comes back as he
   buys.
2. **A contract stays hidden until the unlock it needs is owned.** The Active
   Contracts list only ever offers something the player can do.
3. **A plan first,** this document, then the build.
4. **Safety is never gated** (on reading this draft): more personas, more
   computers, backups and adoption are complicated, but they keep a person safe,
   the way hiding NSFW posts would - so they are open from the first minute, and
   _contracts_ teach them instead (_Never gated_, below).
5. **Four more unlocks, on the same reading:** sealed posts & audiences,
   sharing, chats for two, and Writer's links. Search and format conversion stay
   open everywhere from the start.
6. **hrseMsg is never gated** (on reading this draft): it is too load-bearing -
   it is where a contract's payment is announced, and where everything else that
   happens to a person arrives. A new player starts with their persona,
   hrseDrawing, hrseBank and hrseMsg.

## What an unlock is

- **A fact on the persona's private chain:** a register, `unlocks`, keyed by the
  unlock's id, its value the moment it was bought. It syncs to every computer
  the persona is on, the same way a contract's completion does.
- **A purchase, in the ledger:** the bank pays a line `unlock` / id for the
  negative price, dated when it was bought - the way a hrseBond is a spend. "No
  overdraft" holds exactly as it does for bonds: the buy door catches the ledger
  up and refuses a price the balance can't pay.
- **Never sold back,** never lapses. Once bought, owned.
- **Per persona.** Each persona is its own player; a second persona starts
  locked.
- **A registry in `bank.rs`,** `UNLOCKS`: id, price, and what it opens (for the
  server's own use - which contracts it reveals). The words a player reads - its
  name, its explanation, the video warning - live in `js/unlocks.js`, one
  literal `t()` apiece, beside `js/contracts.js` and for the same reasons.

The bank's answer gains `unlocks`: every unlock with its price and, when owned,
when it was bought. The buy door is `POST /api/identity/{root}/bank/unlocks`
with `{ id }`.

## The gate, in the client

- **One store, `js/unlocks.js`,** fed by the shell's one poll of the ledger
  (`useLedgerPoll`, in index.js) and read with `useUnlocked(root, id)` - or
  `useOwns(id)` where no persona is in hand (a filter strip). The corner balance
  asked `/bank?lines=0` every ten seconds already; that poll moved into the
  store, and its answer gains the owned ids - a register read, cheap - so the
  gate follows a purchase within one poll, and immediately on this tab (the buy
  refreshes it). _As built:_ a module store rather than a Preact context,
  because the router keeps a matched route's first props, and a context's
  consumers inside it are what the launcher showed it needed (2026-10-05).
- **At page load, `GET /bank/unlocks` first:** the owned ids alone. The poll
  catches the ledger up before it answers, which on a large persona's first ask
  can take seconds - too long for a deep link into Writer to wait on.
- **Nothing persistent on the client decides:** not `prefs` (a person could flip
  it), not a cached list surviving logout. Until the first answer arrives, the
  shell shows the starting set only.
- **Hidden, not greyed,** for the apps and the buttons. The Market is where a
  player learns something exists. One exception, below: a locked app reached by
  its address shows a card saying which unlock opens it, with a link to the
  Market, rather than a blank page.
- **The test rig unlocks everything.** The harness probes drive Writer, Chat and
  the rest, and the integration suite is API-only (the gates are the client's).
  A node in LOCAL_TEST mode answers every unlock owned (`everything`), so
  neither needs to buy its way in. _As built:_ the switch is per node, not per
  request - `RINGTOME_TEST_LOCKS=1 just scratch 1` keeps the locks, for
  `harness/unlocks-probe.mjs`. The sale itself is the same either way, so the
  integration claims buy for real.

## What each unlock gates

The client's entry points, by unlock (inventoried 2026-10-05; file references
are to `node/js/`).

### Apps

The registry (`pure/apps.js` `APPS`) gains `unlock: '<id>'` on every app that
needs one; `appsFor` and `consoleCellsFor`, which already filter `admin`, filter
on it too - that covers the dock and the launcher. The narrow dock hardcodes
hrseChat (`index.js` `narrowSlot`, beside hrseMsg's bell), so it reads the gate
directly. The routes (`index.js` `<Router>`, `AppRoute`, `DocRoute`,
`RoomRoute`, and the always-mounted feed beside the router) show the locked card
for an unowned app.

| App        | Unlock        |
| ---------- | ------------- |
| hrsePeople | Friends       |
| hrseFeed   | Social        |
| hrseWriter | Private notes |
| hrseChat   | Chat          |
| hrseFiles  | File upload   |

### Social - publication everywhere

- Writer's publish bar (`doc/editor.js`, the `PublishBar` and the book-page
  bar).
- Drawing's publish bar (`doc/drawing.js`). **It ignores `features.publish`
  today;** gating it fixes that too.
- The Feed composer's Post (`postentry.js` `Composer`) - inside hrseFeed, so
  covered by the app, but the composer also opens in place on a post.
- Replies (`postpage.js` `ReplyBox`): a reply is publication.

Not under Social: starting a chat room publishes a room post, but it is Chat's;
sharing is its own unlock.

### Sharing

The share button on a post (`postentry.js` `ShareButton`). Shares other people
made still show in the feed; you just can't make one.

### Sealed posts & audiences

- The "trusted only" box on the publish bar (`doc/publishbar.js`, the
  `publish-bar-wish`) - Writer, Drawing and the book page share it.
- The Feed composer's audience chooser (`apps/feed.js`, the `feed-audience`
  select: trusted, mentioned, onward, a contact tag).
- A draft that carries its own seal wish (a copy of a sealed post,
  `copyinto.js`) still seals - the wish was the original author's, and dropping
  it would publish words in the open that were never meant to be. Without the
  unlock it publishes sealed with the box shown, ticked and fixed.

Reading sealed posts is never gated: a sealed post addressed to you opens.

### Links

Writer's links column (`apps/notes.js`, mounted beside the tree). Links typed
into a note still work as links, and the "Link one private note to another"
contract still counts them; the column, the backlinks view, is the unlock.

### Taxonomy & tree publication

- The tree column in Writer (`doc/tree.js` `WikiTree`, mounted by
  `features.tree`).
- The Publish column - a notebook as a book (`doc/bookcol.js`, mounted by
  `features.bookColumn`). It publishes, so it also needs Social.

### Reactions, tags & filters

- The tag field in the annotations panel (`doc/annotations.js`), wherever it's
  mounted (editor, reader, drawing, book column, upload modal).
- The tag columns: Writer's (`features.tagColumn`) and Chat's (`panes.js`
  `TagColumn`).
- Room tags when making a chat (`apps/chat.js` `NewRoom`).
- The filters: every `FacetRow` / `LabelFacets` (`facets.js`) - Feed, a person's
  posts, People, hrseFiles, the image picker.
- Labels and reactions on posts: the "+ tag" control and its emoji strip, and
  agreeing with or removing a label (`postentry.js`). A post reaction is an
  emoji tag, so the two arrive together.
- Reactions on chat lines: the emoji and sticker buttons, and agreeing with a
  pill (`apps/chat.js` `Line`).

Labels other people put on your posts still show; you just can't add your own.

### File upload

- hrseFiles (the app) and its drop zone (`doc/upload.js` `FileDropper`).
- The upload chip and drag-and-drop/paste into the editor (`doc/upload.js`
  `useUploadCapture`, wired in `doc/editor.js`).
- Chat's attach button and its drop/paste (`apps/chat.js`).
- "Upload from this computer" in the image picker (`doc/imagepick.js`) - which
  the editor, chat, drawing and the persona page all open.

**Not** the avatar and banner: the persona page's picture picker still offers
your drawings and pictures already held, just not a new upload - so "Set your
profile picture" stays possible from a drawing on day one.

### Video upload

There is no accept list at the inputs; the type is judged after the pick, in
`UploadFlow` (`doc/upload.js` `accepted()`). That is the gate: without Video
upload, a video is refused there, with words naming the unlock. Requires File
upload. Its Market card carries the warning: experimental, and not every browser
can do it.

### Pins

- The pin chip on a note (`doc/editor.js`, `doc/reader.js`, `features.pin`).
- Pinning a public post (`postentry.js` `PinButton`).

Pinned things still sort and show pinned; you just can't pin or unpin. The node
administrator's front-page pin stays the administrator's.

### Public post editing

- The pencil that opens a post for editing in place, and the edit links into
  Writer and Drawing (`postentry.js`; `apps/feed.js` `StackItem`).
- The publish bar's _update_ buttons, and the diff page's (`doc/publishbar.js`,
  `doc/diffpage.js`).

Unpublishing stays: taking something down is never behind a price.

### Chat

hrseChat itself, and the tag column inside it. _As built:_ a room reached by its
address opens without Chat - alone, with no list of rooms and no way to start
one - rather than the locked card: a chat for two someone started with you is a
room, and reading what's addressed to you is never for sale (_Never gated_).

### Chats for two

The person card's chat button (`person.js` `ChatWithButton`, which calls
`ims.js` `openIm`). A chat for two someone else started with you still opens -
being reached is not a feature you buy.

## Never gated

Open from the first minute, whatever is owned (Rulings 4 and 6):

- **hrseMsg:** the bell, the app, every notification.
- **Personas, computers and backups:** making a second persona, bringing a
  persona to another computer (adoption), the backups on hrseDevice.
- **Protection from other people:** blocking, muting, hiding lines from people
  you don't trust, and hiding NSFW posts once it exists.
- **Taking things down:** unpublishing, deleting.
- **Search, and format conversion,** wherever they appear.
- **Reading:** anything addressed to you - a sealed post, a chat for two -
  opens, whatever you own.

The first three groups are taught by contracts instead (below).

## Contracts

Each contract names the unlocks it needs (`requires` in `CONTRACTS`); the bank's
answer carries them, the column lists only the ones whose unlocks are all owned
(Ruling 2). A contract completed before its unlock was owned still pays - it was
done - it just never showed.

| Contract                             | Requires                         |
| ------------------------------------ | -------------------------------- |
| Draw a horse in hrseDrawing™         | -                                |
| Set your profile picture             | -                                |
| Customize your Colorway              | -                                |
| Buy a hrseBond                       | Horse Financial                  |
| Post your horse to the hrseFeed™     | Social                           |
| Follow a stranger                    | Friends                          |
| Get a follower                       | Friends                          |
| Create a private note in hrseWriter™ | Private notes                    |
| Upload an image to hrseFiles™        | File upload                      |
| Say hello in a hrseChat™ room        | Chat                             |
| Start a chat room                    | Chat                             |
| Tag a public post                    | Social, Reactions tags & filters |
| Tag a private note                   | Private notes, Reactions…        |
| React to someone else's post         | Social, Reactions…               |
| Link one private note to another     | Links                            |
| Organize a note into a tree section  | Private notes, Taxonomy & tree   |

The magic words need Social (they're said in a public post) but aren't a
contract. Since 2026-10-05 they pay H$ 10,000 for every post that says them: the
player who won't play our games cheats to a full unlock, out loud.

### Safety contracts

To teach what Ruling 4 keeps open; neither needs an unlock, so both show from
day one. The two contracts are Curtis's picks (2026-10-05); the rewards are
placeholders.

| Contract                               | Reward   | Counts when                                         |
| -------------------------------------- | -------- | --------------------------------------------------- |
| Make a second persona                  | H$ 2,500 | the account holds another persona - the new one too |
| Bring your persona to another computer | H$ 5,000 | the persona's key tree gains a second device key    |

No backup contract (Curtis, 2026-10-05): the backups on hrseDevice are too
loosely defined yet, and the best backup a persona has is being on more than one
computer - which the second contract already teaches. Blocking and muting are
deliberately **not** contracts: a reward for blocking someone invites blocking
someone. Contracts for the sealed and shared unlocks follow the usual rule
(hidden until owned): "Seal a post", "Share someone's post", "Start a chat for
two".

## The first hour

A new persona earns, with nothing unlocked: H$ 5,000 (draw a horse), 2,500
(profile picture, from that drawing), 2,500 (colorway) - H$ 10,000. Horse
Financial (H$ 500) and a first hrseBond (H$ 2,000) bring H$ 2,500 more, and the
bond pays 1% a day. Enough for Friends, Social and Private notes with some over,
each of which reveals contracts that pay for the next. The loop is the tutorial:
unlock, a contract teaches it, it pays for the next unlock.

## The Market column

Above hrseBonds, one card per unlock not yet owned, in the table's order: its
icon, its name, its price, its explanation, and a buy button greyed (the
hrseBond way) when the balance can't pay. Owned unlocks drop off the Market; the
persona page (or the Bank) can list what's owned. A purchase refreshes the gate
at once, and the app it opens appears in the dock.

## Building it

Steps 1-4 built 2026-10-05, and the follow-ups the same day: the safety
contracts, the second batch's three, and an "Unlocked" list under the Market
(HISTORY has the details).

1. **The data:** `UNLOCKS` and `requires` in bank.rs, the `unlocks` register,
   the `unlock` line, the buy door, `unlocks` and contract availability in the
   bank's answer, LOCAL_TEST's everything-owned. Acceptance claims: a buy
   spends, refuses an overdraft, is owned on every computer, never twice; a
   contract appears when its unlock is bought.
2. **The Market cards** and `js/unlocks.js` (names, explanations, the warning).
3. **The gate:** the `Unlocks` context and `useUnlocked`; the apps (registry,
   dock, launcher, routes, the locked card).
4. **The features**, one unlock at a time, in the order above - each gate a
   small diff, each checked in the harness with the rig's unlocks turned off.

## Open questions

- **Admins.** A node administrator gets hrseServer from the start; should they
  also get everything (they run the place), or play the tutorial like anyone?
  Proposed: they play it, with hrseServer.
- **Still unplaced, from the first list of candidates** (sealing, sharing, chats
  for two and links were taken up; safety, search and format conversion were
  ruled open):
  - _Conversations_ - replies, inside Social for now, could be their own unlock.
  - _Scheduling and backdating_ - the date field on a post.
  - _Books_ - publishing a whole notebook, heavier than the tree; inside
    Taxonomy & tree publication for now.
