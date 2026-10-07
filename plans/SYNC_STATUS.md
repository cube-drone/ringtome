# Sync status

A design draft (2026-10-07). Steps 1-6 built the same day (HISTORY); step 7
waits on a log.

Moving a large persona to a new computer works, eventually, and tells the person
nothing while it does. This plan makes a sync visible: a sign in the corner
while one is running, a page that says how far along it is and what's in the
way, and a summary of what each computer holds that a person can compare between
devices on their own.

## The ask (Curtis, 2026-10-07)

What happened, on 0.2.10: pasting his main persona's key (hundreds of megabytes)
into horsedrawingtycoon.com gave "a long wait with no loading spinner followed
by a 504 timeout", and after reloading "there's no way on either side of the
transaction to have any idea how much of the sync is complete. It feels like a
lot of my private notes simply haven't arrived, although they may just be
waiting on an eventual sync." Meanwhile hrseMsg, hrseBank and hrseChat were slow
to open. From the new computer's log:

```
WARN ringtome_node::net::p2p: sync connection ended with error: served exchange exceeded the wall clock (600s)
DEBUG ringtome_node::files: blob not readable locally: encode error hash=…
WARN ringtome_node::files: dialing blob provider: No addressing information available
```

Then the ask:

1. A **sync-now button**: "find all online peers and attempt to sync with them
   right now".
2. "If the application is _currently running a sync_ - in our UI, in the
   bottom-right corner of our app/task bar, visible in both regular and mobile
   UIs, can we have a **'cloud-arrow-down' logo** appear and softly vibrate -
   clicking takes us to our **'your computers' page**, where we display
   synchronization status".
3. "maybe we have a **'my computer' tab** there, also, which lets you know a
   summary of counts of what the current user is holding, and where (this is
   something users could eyeball between devices to debug sync a bit on their
   own)."

## Rulings (Curtis, 2026-10-07)

1. **The serving end shows a cloud too, the arrow pointing up.**
2. **The node's own network work shows as a cloud with a sun** - "if the server
   is busy doing a large network sync for other users (anybody following Cube
   Drone is going to sync a lot of public posts on their first run, also: the
   server might spend time syncing other people's feeds and other people's
   private notes) ... let the player know that the server is currently engaged
   in network syncing but without the exact details". _Your computers_ may show
   "broader network sync information for people interested in what the node's up
   to".
3. **The corner is always a cloud**, and always opens the sync page: "to keep
   this from constantly blipping in and out (ugly), let's have this spot always
   occupied by a cloud ... with the sync change here debounced by a few seconds
   so it only bothers to show you a state change if we're doing something
   chunky."

4. **Instalments are for the persona's own computers.** On whether the failure
   backoff is "intended for syncing against potentially malicious third-party
   servers ... we should consider keeping that behavior if we're _not_ syncing
   against a locally-loaded persona": yes - continuing at once is only for an
   exchange between computers of the same persona; everything else keeps the
   bounds it has (3b).
5. **The network face can be chatty**: "'syncing for 3 people' is totally
   acceptable." How many, yes; who, never.

## What went wrong, read from the code

Four problems, only one of which a button addresses:

- **Adoption syncs inside the request.** `identity::adoption::complete` dials
  the granter and runs `sync_with_peer` - then the member-proven private pull -
  before `POST /api/identity/adopt/complete` answers. For a large persona that
  outlasts any proxy's timeout: the browser gets the 504, the node keeps going,
  and nothing on screen says so. `POST /api/identity/{root}/sync` has the same
  shape.
- **An exchange is capped at 600 seconds** (`exchange_wall_clock`,
  PROJECT_PLAN's Peeks, ruling 14): the serving side closes the connection. Sync
  is a frontier comparison, so what arrived stays and the next exchange
  continues - but the cut is reported as a failed exchange, so the eager loop
  (`net::resync`) backs off for 30 seconds (`FAILED_PUSH_RETRY_MS`) before the
  next one, and logs a warning. A large persona moves in instalments of ten
  minutes with half a minute of nothing between them, each logged as a failure,
  and nothing shows that it is happening.
- **Bodies wait on an address.** Entries (the note's title and its versions)
  ride the exchange; the bytes under them are fetched afterwards from a computer
  that holds them. "No addressing information available" means the node knows
  the other computer's identity and can't find a way to reach it - so headers
  arrive and bodies don't, which reads as "my notes didn't arrive".
- **A long sync is every cache's worst case.** Each arriving entry moves the
  persona's write counts, so the bank's corner catch-up, the kept stores and the
  kept body tags (HISTORY, 2026-10-07) all miss on the next request. 0.2.10 also
  predates the fold-read fix: on this persona, every Writer, Bank or Messages
  read walked every entry it held.

## The pieces

### 1. Adoption answers at once

`adopt/complete` checks the grant, records the leaf and the peer, and answers -
then the first sync runs in the background (the same task the eager loop runs),
and the new computer's page opens straight into _Your computers_, where piece 4
shows it working. `POST …/sync` becomes the same: it starts a sync and answers
`202` with nothing to wait for. A failure the person needs to see ("the other
computer can't be reached") is shown by piece 4, not by a request that hangs.

### 2. The node keeps a sync ledger, in memory

Two levels, both describing this process's work - reset with the node, synced
nowhere.

**Per persona**, what's happening now and what happened last, per other
computer:

- **running**: exchanges in flight - with whom, which way (pulling, or serving
  one of its other computers), since when, entries moved so far;
- **bodies**: how many are waiting to be fetched (`missing_bodies`), how many
  arrived this session, and the last reason one couldn't be ("no address for
  that computer", "not on it yet");
- **per peer**: last reached, last exchange's outcome and what it moved, the
  last error in words, and what that computer said it held (its frontier from
  the last exchange) beside what this one holds.

**For the node**, the work it does on everybody's behalf (ruling 2): exchanges
in flight and their direction, follow refreshes and journal fills pulling other
people's posts, bodies being fetched - as counts and totals, never whose. A
persona's own work is in its own ledger; everything else this node is doing is
"the network".

The client hears it over the stream it already holds (the mirror's WebSocket): a
small `sync` frame when the corner's state changes, and the page asks the whole
ledger by route.

### 3. The corner cloud

**Always there** (ruling 3), bottom-right of the task bar - in the wide bar
beside the clock and the corner balance, and on phones the narrow bar's last
slot - and always a link to _Your computers_' sync page. It wears one of four
faces (Phosphor):

| Face             | When                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| `CloudArrowDown` | this persona is pulling something chunky from another of its computers |
| `CloudArrowUp`   | this persona is serving something chunky to another of its computers   |
| `CloudSun`       | the node is busy with network syncing for others (ruling 2)            |
| `Cloud`          | nothing chunky                                                         |

In that order of precedence, when more than one is true. The arrows "softly
vibrate" - a small, slow wobble - and every face stands still under
`prefers-reduced-motion`. The sun doesn't wobble: it's the weather, not the
persona's own business. The hover says what it can in words ("Bringing your
notes from Laptop - 1,240 of about 9,800 entries"; "This server is busy syncing
the network for 3 people").

**Chunky, and debounced** (ruling 3): a face changes only when the new state has
held for a few seconds and is chunky - an exchange running more than a few
seconds or moving more than a handful of entries, bodies being fetched in
number, network work past a similar bar - and it lingers a few seconds past the
end, so it never blinks. The background loops' short exchanges never move it.
The starting numbers (Curtis, 2026-10-07: "Those numbers [look] fine for now"),
to be adjusted by watching a real large sync:

| Threshold                            | Starting value                                      |
| ------------------------------------ | --------------------------------------------------- |
| an exchange is chunky after          | 5 seconds, or 50 entries moved                      |
| bodies are chunky when               | 10 or more are waiting and being fetched            |
| the network face shows when          | the node's exchanges for others have run 10 seconds |
| a new face must hold, before showing | 3 seconds                                           |
| a face lingers after the work ends   | 5 seconds                                           |

### 3b. Instalments, not failures - for the persona's own computers

What the code already has: the eager loop (`net::resync`) only ever dials the
persona's own computers (`identity_peers`), and its 30-second backoff
(`FAILED_PUSH_RETRY_MS`) is for computers that are off - "offline peers must not
be re-dialed every tick". The defence against untrusted peers is elsewhere:
`net::admission`'s ceilings, budgets and the wall clock, and `Behind`, which
marks a follow or a peek cut short by its budget as "a mark, not a fault" and
continues it for a bounded number of passes.

What changes (ruling 4):

- **The persona's own computer, cut by the wall clock having moved entries**: an
  instalment. The persona is marked behind, the ledger says "continuing", the
  log says so at info, and the next exchange with that computer starts at once -
  no failure backoff.
- **The persona's own computer, reached nobody, or moved nothing before the
  clock ran out**: a failure, with the backoff as now.
- **Anybody else's chains** (follows, peeks, speculative pulls, the network
  work): unchanged - the budgets, the bounded `Behind` ladder, the backoffs.
- **The wall clock** stays for every exchange: it bounds a detached task's life.
  Only what follows it differs.

### 4. _Your computers_: a sync section per computer

The page already lists the persona's computers (computers.js). Each other
computer gains:

- reached: "just now", "2 hours ago", or "never" with why ("no address for it -
  is it on, and online?");
- held there and here: entries each side has that the other doesn't, from the
  last exchange's frontiers ("Laptop has 8,560 entries this computer doesn't");
- bodies still to come from it;
- what's happening now, while it is.

And one **Sync now** button for the persona: it starts an exchange with every
computer that can be reached, in the background (piece 1's shape), and the
section fills in as it works. It is a retry for when the person knows the other
computer is up, not the only way a sync happens - the loops still run on their
own.

Below the computers, for the curious (ruling 2): **this server and the
network** - what the node is doing for everyone right now (exchanges in flight,
which way, posts being fetched for followers, bodies on their way), in counts -
"syncing for 3 people" (ruling 5) - never whose. An administrator's hrseServer
may show more; this page never names another person's persona.

### 5. A _This computer_ tab

What this computer holds for the persona, in counts a person can read off two
devices and compare:

- documents, by kind (notes, drawings, files, books), with how many have their
  bodies here and how many are still waiting;
- posts published, replies, shares;
- chats: rooms and messages;
- people: followed, trusted, known followers;
- the bank: unlocks owned, ledger lines;
- the persona's chains: how many, entries in all, and the disk they take.

And a **sync code**: a short code made from every chain's head (each chain and
how far it reaches, sorted, hashed, six characters). Two computers holding the
same chains show the same code, so "do these match?" is answered by looking.
Counts differ for innocent reasons - a body still on its way, a view not yet
caught up - so the code is what says whether the chains themselves agree, and
the counts say where to look when they don't.

### 6. The unreachable body provider - found, and two fixes (step 7)

Read from both computers' logs (2026-10-07): the code was pasted into
horsedrawingtycoon.com, so the server was the GIVER and Curtis's desktop the new
computer. The server reached the desktop - the adoption code carries the
desktop's addresses, and it dialled 23 times in an hour - so entries flowed, in
exchanges the server started. But bodies are fetched by the computer that needs
them, dialling the one that has them by its id alone, which in `mainline` mode
leans wholly on iroh's discovery - and the server's records weren't reliably
there (its DHT publishing logs "Publish query timed out with no responses" and
"All relays responded with unexpected responses"; a republish pass takes 16-20
s). So: "No addressing information available", and no bodies.

- **Where a computer was last reached is remembered** (`net::p2p::remember`,
  `remembered`): every connection's paths - its addresses and relay - either
  way, kept a day in memory, and a dial with nothing but an id adds them. Two
  computers that have talked stay reachable when discovery can't find either.
- **One exchange per persona, computer, scope and direction at a time**
  (`Ledger::begin_pull`, `Ledger::try_begin`): 23 exchanges of the same persona
  hit the wall clock in one hour on the server - the loops and the dials all
  working the same chains. A second pull waits for the running one to end, then
  runs: the running one read the other end's heads before whatever asked for the
  second was written. A third finds the second waiting and returns at once,
  nothing moved and no failure - the waiting one carries its writes too. A
  second serve says busy. Two things are deliberately not refused: a pull the
  other way (eager push has both computers dial each other the moment either
  writes) and a pull of another scope (a room's or a peek's pull is no stand-in
  for the whole persona's). The first build refused both, and dropped the second
  pull instead of queueing it; 13 acceptance claims went red, every one a write
  that never arrived.
- **The invite's wait is 30 seconds**, under a proxy's timeout: the server's
  `POST …/nodes` waited 60 for the handed-over adoption to finish, and on 0.2.10
  the new computer synced everything before answering.

## Building it

1. Adoption and `…/sync` answer at once and sync in the background. A claim: the
   door answers before the exchange is done, and the exchange finishes.
2. Instalments (3b): a cut exchange that moved entries continues at once. A
   claim with a short wall clock on the rig: a persona larger than one
   instalment arrives whole, with no failure backoff between instalments.
3. The sync ledger, both levels, its `sync` stream frame, and a route that
   answers it whole (`GET /api/identity/{root}/sync/status`), for the page and
   for MCP.
4. The corner cloud, its four faces and the debounce (pure, tested: a state held
   for less than its time never shows), both bars, reduced motion respected.
5. _Your computers_' sync section, the network section and the Sync now button.
6. _This computer_, and the sync code (pure, tested: the same chains give the
   same code, whatever order they're read in).
7. The body provider (piece 6): the address memory, one exchange per pair, the
   invite's 30-second wait.

## Open questions

- **The thresholds** for "chunky" have starting values (piece 3); whether they
  hold is for a real large sync to say.
