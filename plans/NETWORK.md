# The machine table, the Network page, and group gossip

Curtis's ask (2026-10-17), two pieces that need each other:

1. **A durable table by machine, shared by every kind of sync**: which machines
   this node has talked to, under their human-readable names, and how reliably
   each answers. And a place where every user of the node sees that table: the
   **Network** page of hrseServer™ / hrseDevice™ (first planned as an app of its
   own, hrseP²P™; Curtis, the same day: "this functionality actually belongs as
   a 'Network' tab in hrseServer/hrseDevice").
2. **Group sync by gossip**, "in the same way that crowd sync uses gossip":
   preferring reliable partners, but keeping a slot for checking on unreliable
   ones "so that they don't get left out".

## Rulings (Curtis, 2026-10-17)

1. **Every node announces its name.** The Hello carries it, whatever it is: the
   operator's `RINGTOME_NODE_NAME`, or the hostname. "It's honestly a lot more
   convenient for me to see 'curtis's mac mini is offline'." So `config.rs`'s
   promise that the name never reaches a public surface is retired.
2. **The operator renames the machine** on the Network page. The name set there
   wins over the environment and the hostname, and it is what the Hello
   announces from then on.
3. **Everyone sees the machines; each person also sees their own links.** Every
   signed-in user of the node sees every machine row. A person additionally sees
   which of those machines serve _their own_ personas: their own computers, the
   people they follow, the crowds holding those people, their groups. Nobody
   sees which machines serve another user's follows or groups.
4. **Gossip prefers reliable partners, with a slot for the unreliable.**
5. **hrseServer™ opens to everyone, page by page.** Every signed-in person sees
   the app's tile. A regular user sees only its Network page; administrators
   also see Registration, Backups and Server customization. The admin barrier
   moves from the app to each page, and every admin route still refuses everyone
   else.
6. **Every Hello says what the machine is** (Curtis, the same day): its client
   (`hdt` always; only someone building another client would change it), its
   version, its kind of device (android, mac, windows, linux, server), and how
   many accounts and personas it carries. They are debug facts for the machine
   table, and nothing in an exchange branches on them.

## Why the machinery is visible

A peer-to-peer network's transport is visible by design. Any node that dials a
machine learns its endpoint id, whether it answers and how fast. The Network
page shows what this node has learned that way, plus the names machines announce
(ruling 1). The row is about the machine, never about who on this node it
served. Which persona or group an exchange was for is the one private part,
because on a server shared by many users it would show one user's follows and
groups to the others. So rows carry only their own person's links (ruling 3).

## The machine table

### What a row knows

`machines` (node rung 96), one row per endpoint id:

- **`name`**, **`version`**: what the machine last announced in a Hello. NULL
  until it has said a Hello to this node, or heard one from it.
- **`first_seen_ms`**: the first connection either way.
- **`last_ok_ms`** / **`last_fail_ms`**: the last outbound connect that worked,
  and the last that didn't.
- **`last_inbound_ms`**: the last time it dialed this node. A machine that dials
  in but can't be dialed (behind a NAT, a phone) is still reachable this way.
- **`oks`** / **`fails`**: decayed counts of outbound connects. Each outcome
  first multiplies both by a decay, so the counts are a recent history rather
  than a lifetime one: a machine flaky last month and steady this week reads as
  steady.
- **`connect_ms`**: a running average of how long a connect took.
- **`last_error`**: the last failure, in words.

And `machine_lanes (endpoint_id, alpn, last_ms)`: which protocols touched it,
and when: sync, fragment, deliver, blob, adopt, gossip. Only protocols, never
personas.

**Reliability** is `(oks + 1) / (oks + fails + 2)`, a smoothed success rate. A
machine never dialed reads one half: unknown, neither trusted nor written off.

### How it is written

Every connect already goes through `p2p::dial`, and every inbound connection
through the accept loop. The dark book (plans/CACHE.md, Stage 3) is an in-memory
table those two update. The machine book is the same: an in-memory map updated
on both paths, with no database write on the connect path. A periodic flush
writes the rows that changed to `node.db`, every 30 seconds and at shutdown.
Boot loads the table into the book. A machine whose last failure is newer than
its last success comes back dark for the shortest window, so a restart no longer
forgets which machines don't answer.

Names and versions come from the Hello: the sync lane reads it on both sides,
and both sides tell the book.

### What a machine says of itself

The Hello's about slot (arity 12, ruling 6) is
`[client, device, users, personas]`. The client is `machines::CLIENT`, `hdt`.
The device is the operating system's word when a desktop or phone app started
the node (its window token, or a single-tenant node, is the sign), and `server`
otherwise. The counts are the node's accounts and hosted personas, counted at
most once a minute. The table keeps them per machine (rung 97). An older Hello
leaves what the machine said before.

The counts tell every machine that dials a server how many accounts and personas
it carries.

### The name

- **`node_name`** (rung 96, one row): the name the operator chose, or none.
- The node's name is that, else `RINGTOME_NODE_NAME`, else the hostname
  (`config.node_name`, unchanged).
- The Hello gains a trailing slot, `name`. An older Hello decodes it as empty,
  as `version` and `crowd` arrived. It is capped at the device-name cap.
- Renaming takes effect at once: the next Hello says the new name. The device
  names already written into personas' key trees at adoption keep what they
  said. Those are a person's own labels for their computers, and they rename
  them on their own page.

## The Network page

A page of hrseServer™ / hrseDevice™ (`js/apps/device.js`), the only one a
regular user sees there (ruling 5).

- **This machine** at the top: its name, its endpoint id in speakable form, its
  version. An administrator renames it here.
- **The table**: one row per machine, the most recently heard first.
  - Its name, or its speakable words when it has never said one.
  - Up or down: answering, dark (and until when), or never dialed.
  - Last answered, last failed, last dialed in.
  - Reliability as a bar, and the connect time.
  - Its version, and the protocols that touched it.
- **Your links**, a column for the current persona: "your computer", "serves
  {name}" for someone you follow, "holds {name}" from the crowd, "in {group}"
  for one of your groups. A row with no links of yours shows none.
- A filter: all machines, or only the ones linked to you.

The routes:

- `GET /api/identity/{root}/machines`: every row, each with the persona's links
  (`identity_peers`, `subscriptions`, `crowd_holders`, `group_peers` and
  `group_people`), for any session that holds the persona.
- `PUT /api/admin/machine-name`: the rename, for administrators only.

## Group gossip

### Today

`roster::sync_pass` runs every minute for each (group, hosted member). It
exchanges `me` twice with every node the group is known at, then exchanges every
member with every one of those nodes. With members on their own computers that
is about n² exchanges per node per minute, and n³ across the group (the
2026-10-17 audit).

### The shape

The crowd's pattern (plans/CROWD.md, rulings 5 and 6): a few partners per pass,
the best ones by default, and a deliberate slot for the one that would otherwise
go unasked.

1. **Candidates are current members' machines.** These are the endpoints of the
   roster's current members: `identity_peers` for each member, and the
   `group_peers` rows naming a current member. A removed member's node is never
   a candidate. This node never is.
2. **Each pass picks three partners.**
   - **Two by reliability**: the highest reliability among the candidates that
     aren't dark, ties to the most recently answered.
   - **One check-in slot**: among the rest, the one tried least recently. That
     is how a machine that went dark, a laptop that was shut or a new member
     with no history gets asked. A check-in that answers lifts the machine's
     reliability, and with it its chance of being picked again.
   - With three or fewer candidates, all of them.
3. **With each partner, one exchange per member.** An exchange is two-way, so it
   carries this node's news to the partner and the partner's to it. Since every
   member's node holds every lane, any partner is as good a source as the
   author. News reaches the whole group in about log₃(n) passes.
4. **A machine met for the first time is exchanged twice for `me`**, as now:
   only the second exchange can show it the member proof (`sync_group`'s comment
   says why).
5. **A write pushes.** An entry written on this node (a post, a label, a
   setting) schedules a pass for that group within a few seconds, debounced as
   `catch_up_soon` is. So news leaves at once, and the minute beat only catches
   what a push missed.
6. **A person's own "sync" stays thorough.** The sync button, joining a group
   and opening an invite still exchange with every candidate, as now. Those are
   rare, a person is waiting on them, and they settle a newcomer at once.

The cost per node per pass is about 3n exchanges, on connections already open to
three machines, instead of about n². An idle group still costs 3n per minute,
because an exchange carries one persona's lanes.

### The group digest (built 2026-10-17)

A partner answers "here is the head of every lane of this group" in one
question, so a pass exchanges only for the lanes that differ. Curtis: "very
similar to our existing frontier awareness". It is that idea one level up, and
mostly reuse of `net/frontier.rs`:

- **The heads are the `chain_heads` memo's**, which every writer and the sync
  ingest already keep, read for the group's instance
  (`frontier::instance_heads`).
- **The question** is `WantGroupHeads { group, members, fingerprint }` on the
  fragment lane. The asker's fingerprint is blake3 over the heads it holds,
  sorted by chain, each `author ‖ service ‖ head ‖ the hash's first 8 bytes`
  (`fragment::group_heads_fingerprint`).
- **The answer** is `GroupHeads`: `same` when the fingerprints agree, else the
  heads, a run of frames ended by an empty one.
- **The door is the group's.** A dialer serving one of its people
  (`dialer_may_hold`) is told about both kinds of lane when it asks. Anyone else
  is told about a public group's public lanes alone, and nothing of a private
  group.
- **A head is a claim**, as a frontier claim is: it says where to look. The
  exchange that follows validates.
- **Both passes use it.** Members' gossip (`gossip_group`) and the public pass
  of a node outside the group (`public_sync`) ask each partner first, and
  exchange only for the personas whose lanes differ (`roster::differing`), plus
  anyone the partner names that this node doesn't hold.
- **Two cases still exchange in full:** a machine met for the first time, which
  must learn the member proof, and a machine too old to answer.

An idle pass is now one small question per partner. A new post costs exchanges
for its author's lanes alone. `groupgossip.cjs` checks both (via
`/test/group-pass`, which runs one pass and counts its exchanges).

## Slices

All three built 2026-10-17.

1. **The table and the names.** Rung 96 (`machines`, `machine_lanes`,
   `node_name`). The counts are kept in thousandths and the connect time in
   whole milliseconds, because the database layer binds only integers. The
   machine book in `machines.rs` is written by `p2p::dial` and the accept loop,
   flushed every 30 seconds, and loaded at boot, before the first connection.
   The Hello's name slot is arity 11. Unit tests cover the decay, the
   reliability, a name sticking, and the table surviving a restart; a proto test
   covers the name slot.
2. **The Network page.** `GET /api/identity/{root}/machines` and
   `PUT /api/admin/machine-name`. hrseServer™ is opened to everyone page by page
   (`appsFor` no longer hides it). Acceptance: `integration/test/machines.cjs`.
   Two nodes know each other by name; the called side knows the caller called
   in; a person's group link comes with the row and another account on the same
   node sees it bare; the rename is refused to non-administrators and reaches
   the other side on the next sync. The failure half (decay, dark at boot,
   surviving a restart) is the unit tests': the rig neither restarts nodes nor
   marks them dark.
3. **Group gossip.** `roster::gossip_group` in `sync_pass`, with `pick_partners`
   (unit-tested) and `gossip_candidates`. A removed member's node is told apart
   by the group's peer ledger: a machine where only people the roster no longer
   counts were proven is left out, since every member's node serves every
   member's lanes. The push after a write is debounced per group, and it is off
   on the test rig unless `RINGTOME_TEST_GROUP_PUSH_MS` is set, as the beat is.
   `/test/group-partners` says what a pass would pick, since the shared rig's
   machine table can't. Acceptance: `integration/test/groupgossip.cjs`. A post
   reaches four nodes by beats alone, and a removed member's node stops being a
   candidate while the others still hear.
