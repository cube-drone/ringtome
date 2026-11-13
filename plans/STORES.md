# Stores: what Google Play and the App Stores ask of us

Curtis, 2026-11-01: "Let's talk briefly about the steps we'd need to make this
shippable on app stores like Mac and Google Play: at least in my memory, I have
three major components that the app lacks and might need to pass review:
bouncing kids under the age of 13+ with a birthday wall, a ToS/Privacy Policy,
and something that approximates reporting-for-moderation (tough given the p2p
nature, but we can build Something and promise community moderation)."

A design draft; nothing built. The store requirements below are as we understood
them on 2026-11-01, not read fresh from the guidelines - **read the current text
of Apple's App Review Guidelines (1.2 User-Generated Content, 2.4.5 Mac App
Store, 5.1.1 Privacy) and Google Play's policies (User Generated Content, Target
Audience and Content, Data Safety, Account Deletion, Device and Network Abuse)
before building to them**. Age assurance in particular has been moving
(app-store age-signal laws, new store APIs).

[MOBILE.md](MOBILE.md) already names store review as "the risk most likely to
make the whole direction moot". This page is the answer we mean to test against
it.

## Rulings

1. **Not a central node** (Curtis, 2026-11-01: "the fundamental architecture of
   HDT is designed so that I _shouldn't_ be a central organizing node"). Nothing
   here makes horsedrawingtycoon.com or its operator an authority the network
   depends on. What the stores need from a developer, the developer provides as
   one participant among many - a list anyone can drop, a node that answers for
   its own accounts.
2. **No promised response times** (Curtis: "I am not charging for the app, so I
   won't have the financial resources to pay people to PROVIDE timely
   responses"). A report protects the person reporting at once, on their own
   device; what reaches a human is narrow, and the terms say plainly it's
   volunteers with no promised response time.
3. **Moderation is subscribed to, and replaceable** (Curtis: "if users can
   reconfigure their blocklists - subscribing to other moderation nodes and
   cancelling their subscription to mine - it maintains the P2P core of the
   application"). The official list is the first in the menu, not the menu.
4. **The official list holds what we were made to act on** (Curtis: "The only
   people going on the default blocklist are likely to be people put there
   because of extreme arm-twisting of me by an external party"). It says so in
   its name, and every entry carries its reason, so anything added under
   pressure is visible as such.

## The checklist

| need                          | asked by                    | have                                              | to build                                   |
| ----------------------------- | --------------------------- | ------------------------------------------------- | ------------------------------------------ |
| an age screen                 | COPPA, both stores' forms   | nothing                                           | at registration, on the node (section 1)   |
| terms agreed before posting   | Google Play UGC             | built 2026-11-01: agreed at sign-up               | asking again when the terms change         |
| privacy policy, terms         | both stores                 | built 2026-11-01: `/tos`, `/privacy`, `/eula`     | legal review                               |
| no updating outside the store | Play, Mac App Store         | the update notice links to GitHub                 | a store-build flag (section 3)             |
| account deletion in the app   | both stores (Play: web too) | built 2026-11-01: "delete me" in hrseSettings     | -                                          |
| block abusive users           | both stores' UGC rules      | blocking (a contact's `blocked` fact), room mutes | reachable from any post or line            |
| report objectionable content  | both stores' UGC rules      | nothing                                           | report = hide + block + send (section 5)   |
| filter objectionable content  | Apple 1.2                   | content warnings by tag, trust-gated posts        | moderation lists (section 5)               |
| published contact information | Apple 1.2                   | nothing                                           | in the terms, per node                     |
| store paperwork               | both                        | -                                                 | Data Safety, age rating, encryption export |

## 1. The registration gate: age and terms

Neither store requires a birthday wall of an app not aimed at children; each
asks us to declare a target audience (Play's _Target audience and content_,
Apple's age-rating questionnaire). The wall is COPPA's: an operator who
knowingly collects a child's personal data owes verifiable parental consent, and
a neutral age screen is the standard way not to know.

- **On the node, at registration** - the web's sign-up at horsedrawingtycoon.com
  as much as the app's. One screen, before an account exists: a date of birth,
  and the terms to agree to.
- **Neutral**: the screen asks for a date, says nothing of the cutoff, and
  offers no "are you sure".
- **Kept as a yes, never as a date**: the account holds "13 or over: yes" and
  when the terms were agreed (and which version); the birthday itself is
  dropped.
- **A refusal is remembered on the device**, so the next year down isn't one tap
  away.
- **The age is the operator's to set**, 13 by default: the age of digital
  consent runs 13 to 16 across the EU, and a node operator answers to their own
  jurisdiction. `SERVER.md` says so.
- Personas made later inside an account need no new screen - the account is the
  person.

## 2. Terms and privacy

**Built 2026-11-01**, as first drafts awaiting legal review: the application's
`TERMS_OF_SERVICE.md` and `PRIVACY.md`, and every server's defaults
`NODE_OPERATOR_TERMS_OF_SERVICE.mq` and `NODE_OPERATOR_PRIVACY.mq`, at the
repository's root and built into the node (`node/src/frontmatter.rs`), shown at
`/tos`, `/privacy` and `/eula` (the AGPL). An account is made only with
`agreed: true`, and records the version it agreed to (a hash of everything the
pages show). An operator's additions are a note in hrseWriter, published from
the server settings' _Front Matter_; they follow the defaults, never replace
them, and every version is listed on the page, dated, as a diff. Not yet: asking
again at sign-in when the version moves, and the age screen (section 1).

Both stores want a privacy policy at a URL in the listing and a way to it inside
the app; Google's Data Safety form asks the same questions in detail. The
architecture makes ours unusual in content, not in kind:

- **Two documents, two authors.**
  - _The app's_ (the developer's): what the app itself touches - GitHub for
    release checks (through the node), web-push services for notifications,
    Bunny in front of horsedrawingtycoon.com, nothing sent to the developer.
  - _Each node's_ (the operator's): a template every node serves at a fixed
    address, the operator's name and contact filled in from the node's settings.
    Whoever runs a node is the one responsible for its accounts' data;
    horsedrawingtycoon.com's is the template, filled in by Curtis.
- **Public means public** (PROJECT_PLAN, _Public Means Public_), said plainly:
  what you publish can be copied by other nodes and cannot be called back from
  them. Deletion copy under-promises - the same posture as every takedown string
  in the app.
- **No promised response times** (ruling 2), and the contact for reports.
- The terms carry a version; agreeing records it, and a new version asks again
  at the next sign-in.

## 3. Store builds

- **The update notice.** Google Play forbids an app to update itself, or to send
  people to update it, by any road but Play's; the Mac App Store forbids the
  same. A store build carries a flag, read beside the dev-build check in
  `js/update.js`, that turns the notice off - or points it at the store's own
  listing, if that proves allowed. **Built (2026-11-02)**: `RINGTOME_STORE=play`
  or `app-store` when the node is compiled (checked by `node/build.rs`; anything
  else fails the build), `src/store.rs`, an `app-store` meta on the page. The
  notice is off, not pointed at the listing: the store updates the app itself.
  The "get the app" panel leaves out the store's own system, and its "every
  release" fallback; the version label still opens the running version's release
  notes. On a desktop a store build also has no self-updater (2026-11-12): with
  the flag set, `desktop/src/lib.rs` registers no updater plugin and `update.rs`
  never starts its loop - a Mac App Store build would otherwise have gone on
  fetching releases from GitHub. A Play build is the Android one with the flag
  set and an app bundle instead of an APK -
  `RINGTOME_STORE=play npm run tauri -- android build --aab` - not yet a job in
  `android.yml`.
- **The Mac App Store is optional.** Notarized downloads (what ships now) need
  no review. A store build must be sandboxed: network client and server
  entitlements for the node's loopback server and iroh, and the data directory
  moved into the container - a migration for every existing Mac install. Worth
  it only if the store brings people the direct download doesn't.
- **Android**: the foreground media-playback service (`PlayerService`) is
  declared and justified in the Play Console; the target API level is Play's
  current floor.
- **Paperwork**: Data Safety (Play), the age-rating questionnaires (both), and
  Apple's encryption export declaration - standard cryptography is exempt, and
  still declared.

## 4. Account deletion

Both stores require an app that makes accounts to delete them from inside the
app; Play also wants a web address where deletion can be asked for.

**Built 2026-11-01** (`node/src/leaving.rs`, `js/deleteme.js`): "delete me" at
the bottom of hrseSettings, opening "delete {persona}" and "delete your entire
account" (Curtis: "Each of these warn the user that deleting themselves from
this node cannot remove them from the entire network. Deletion in both cases
implies voluntary retirement on this node, and ... still allows the user to spin
up this same persona on this same node").

- **A persona deleted** is this computer retiring from it - the self-issued
  retirement, not a repudiation: everything it wrote stays good - handed
  straight to its other computers, then unlinked from the account (the farewell
  flow's `detach`), its push subscriptions dropped and this computer's key file
  destroyed. What the node held becomes an ordinary mirror, swept once nobody
  here wants it.
- **The account deleted** is that for every persona, then the account, its
  sessions, API keys and pending adoptions - the administrator's eviction, done
  by the person. Its sign-in name is free again.
- **It comes back by adoption**: a persona another computer still holds is
  brought here again as to any new computer, with a fresh key. One that lived
  only here has nothing to come back from - its spare key resets a password on
  an account, and the account is what's gone - and the screen says so before
  anything happens (`GET /leaving`).
- **Asked again**: the password, from a signed-in browser only (never an API
  key); the server's administrator can't delete their own account.
- **The web address** is the same page in the node's web app - every node has
  one, so no central form is needed.
- **Copies elsewhere are said honestly**: public posts other nodes already hold,
  and what followers kept, are theirs to drop.
- Still open: a waiting period before the delete is final (the password asked
  again covers a session left open; a stolen password does not).

## 5. Reporting and moderation lists

The stores' UGC rules ask for four things: filtering objectionable content,
reporting it, blocking abusive users, and published contact information - and
Apple adds "timely responses to concerns". The design already in PROJECT_PLAN
(_Moderation and Operator Liability_: _Denunciations_, _Operator Identity: Bind,
Don't Adopt_, _Hash Lists and Scanning_) is the shape; this section is what a
store build needs of it first.

### A report

_[MODERATION.md](MODERATION.md) is the design now (2026-11-02): reports go to
the moderators the reporter trusts, not the target's home operator._

One action on any post, reply, chat line, profile or picture:

1. **Hide and block, at once**, on the reporter's own device. The person
   reporting is protected before anyone reads the report - which is the part of
   "timely" we can always keep (ruling 2).
2. **Send**, to whoever is responsible: the operator of the reported account's
   home node (the abuse routing of _Operator Identity_), and the maintainer of
   any moderation list the reporter subscribes to. A report reaches Curtis only
   for accounts on horsedrawingtycoon.com and for the official list.
3. A reason class from a short list (the taxonomy _Denunciations_ leaves open),
   and optional words.

### Moderation lists

A moderation list is an identity publishing signed denunciations - target root,
post or blob hash, reason class - revocable by its author. Nothing new on the
wire: _Denunciations_ already defines the statement.

- **Subscribed, never imposed** (ruling 3). A person subscribes to any number,
  drops any, or keeps none; a node operator does the same for what the node
  serves and hosts. The two are kept apart:
  - _the reader's_ lists decide what their own app hides from them - personal,
    touching nobody's data;
  - _the operator's_ lists decide what their node serves and admits - where
    legal pressure actually lands, and where it stays.
- **Every build comes subscribed to the official list** (Curtis, 2026-11-01,
  replacing "store builds only"): a reviewer must find something working, and
  the official persona is already every new persona's starter contact. It's
  shown in settings beside the report button, with what it's for, and dropped in
  one tap. [MODERATION.md](MODERATION.md) is the design.
- **Weight by choice, not by graph**: a list counts because you subscribed,
  whether or not the trust graph reaches its author (the topic-scoped
  Credibility of _Denunciations_ stays the road for lists you didn't pick).
- **PROJECT_PLAN's warning stands**: "any feature that makes subscribing to one
  big list the path of least resistance is quietly rebuilding the authority this
  architecture claims not to have." A first run that offers more than one list,
  once there are others, is the mitigation worth building toward.

### The official list

"Horse Drawing Tycoon 2 Official", published by the official persona, holding
only what Curtis has been made to act on (ruling 4).

- **Every entry carries its reason**: a legal takedown, a court order, a hash
  match. Entries naming accounts and posts are public, reasons and all - an
  audit trail anyone can read, and leave over.
- **Picture hashes travel only along trust edges**, never in public: a public
  hash list is an evasion-testing oracle (_Hash Lists and Scanning_).
- **CSAM is never on it**: clearinghouse lists are never distributable. A node
  checks pictures against Shield (Project Arachnid) with its operator's own key,
  and publishes its blocking decisions as exact-hash denunciations - the pattern
  _Hash Lists and Scanning_ already sets.

## The order

1. The registration gate - age and terms (section 1).
2. The policy pages, as templates (section 2).
3. The store-build flag for the update notice (section 3).
4. ~~Account deletion (section 4).~~ Built 2026-11-01.
5. Report, hide and block from anywhere (section 5, _A report_).
6. Moderation lists, and the official one (section 5).

1 to 4 are needed whatever review thinks of the rest. 5 and 6 are the answer to
MOBILE.md's open risk, and the first store submission tests whether review
accepts it.

## Open

- Whether "volunteers, no promised response times, the reporter protected at
  once" satisfies Apple's "timely responses" for an app like this. Decide by
  asking - an App Review consultation, or a first submission - before building
  past step 5.
- The reason-class taxonomy (_Denunciations_ leaves it open), and whether lists
  live on an operator's identity chain or a node-key chain.
- A waiting period on account deletion (section 4).
- The Mac App Store at all (section 3).
