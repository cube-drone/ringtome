# A node's page, and how a node introduces itself

A page for any node, at `/ringtome/node/<endpoint id>`, so a person can look at
a server before they report it, and a moderator before they block it. Under it,
a new exchange in which a node introduces itself. Curtis, 2026-11-05, after a
report about a node showed only "asks you to list 5d0699eaa625…": "what do you
think of a node introduction exchange? 'Here's who I host, here's some basic
information about me and the software I'm running'?"

Curtis approved the plan as drafted (2026-11-05, "that looks good, let's get
cookin'"), and all four slices were built the same day. _Open_, below, still
waits on rulings.

## Why

Reports and lists can name a node, but nothing in the app shows one. A node id
is shown as twelve hex characters in the report queue (`reportqueue.js`
`NodeName`) and on the Blocklist tab (`moderationpage.js` `Target`). The only
other place a node has a name is the Network page (NETWORK.md). Putting a node
on a list is only offered from the report queue. A reporter has no way to report
a node, or to look at one first.

What a node knows about another today (2026-11-05):

- **The machine table** (`machines.rs`, NETWORK.md): the name, version and about
  facts (client, kind of device, how many accounts and personas) that the other
  node's sync Hello last announced, and how reliably it answers. These are only
  known for a node that has synced with this one.
- **Who it serves**, as far as this node has seen: `identity_peers`
  (`net/sync.rs` `roots_served_by`). This includes nodes that only keep a copy
  of someone.
- **No web address.** Nothing in the protocol carries one. A node's public
  people list and front page (`nodeface.rs`, `/api/node/personas`) are served
  over HTTP only, so another node can't reach them.

A sync is always about one persona, so it can't serve as a general "who are
you". This plan adds that question as its own exchange.

## The introduction

One question and one answer on the fragment ALPN, beside `WantCensus`: a
stateless ask, answered from what the node already knows. iroh authenticates the
endpoint, so the answer is that node's own word. Nobody can introduce a node on
its behalf. An older node answers an unknown tag with an error, and the asker
records "doesn't introduce itself", the same fallback `WantRoom` uses.

The answer (_proposed_):

- **Name and version**: what the Hello already carries.
- **The about facts**: `sync::About`, reused, covering the client, the kind of
  device, and how many accounts and personas it carries.
- **Its web address**, when it has one (`webpath::public_url`).
- **A short description and a link to its rules**, written by its operator, both
  optional. These are new settings in hrseServer.
- **Who it hosts publicly**: the hosted personas listed on its front page
  (`nodeshelf::listed_roots`), the same people its public people page shows, and
  nobody else. That rules out quiet follows, copies it keeps for the crowd, and
  personas whose owners turned listing off. The list comes in pages, a frame's
  worth at a time, so a server with three thousand accounts needs no single huge
  answer.

Left out on purpose:

- **Whether it takes reports.** MODERATION.md's rule is that nothing advertises
  who takes reports.
- **Anyone a device hosts, by default.** A laptop or phone that lists its person
  ties that person to the machine's network address. A device node introduces
  itself (name, version, kind) and lists nobody unless its owner turns that on.

## The address, checked

A node could say its address is horsedrawingtycoon.com. So the asker fetches
`<address>/api/node` and keeps the address only if the endpoint id there is the
one that answered. A checked address lets the page link to the node's front page
and its people page. An unchecked one is shown as "says it's at", or not shown.

## The door

- Rate-limited like the other fragment doors. A node blocked by this node's
  administrators gets no answer (`moderation::refuses_node`). The connection is
  refused before it gets this far anyway.
- Answered from caches: the about facts are already cached (`machines.rs`
  `about_us`). The listed roots are one query, paged.
- Each answer is recorded in the machine table: the facts, the checked address,
  when it was asked. A new `machine_intros` table holds the listed roots and a
  timestamp, as a migration rung.

## The page

`/ringtome/node/<endpoint id>`, for anyone signed in:

- **Who it is**: name, the speakable words of its key (`machines.rs`
  `words_of`), the full id, version, client, kind of device, accounts and
  personas, its checked address with a link to its front page, and its
  description and rules link.
- **When we last heard from it**: first and last seen, reliability, and when it
  last introduced itself, with a button to **ask it again**. The button says
  plainly when the node can't be reached ("no address known for it"), and when
  this node has blocked it.
- **Who it hosts**: the people it introduced, as person rows to click through
  and judge. A person this node has also seen it serve is marked as confirmed.
  The rest say "it says it hosts". Below that, anyone else this node has seen it
  serve.
- **Your ties to it**: the Network page's links (own, serves, holds, group).
- **Lists**: whether you or your moderators have it listed. A moderator gets
  Block and Warn on their public list. Everyone gets **report this server to my
  moderators**, the node report `reports.rs` already accepts.
- **Links in**: every place that shows a node id links here. That covers the
  report queue, its flood rows, the Blocklist tab, and the Network page.

## Honest about what it is

- **"Who I host" is the node's own word.** It could claim someone famous. That's
  harmless while a node block only refuses connections, which is all it does
  today (`moderation.rs` `recompute_inner`, for administrators only). It stops
  being harmless if a node block ever hides the people a node hosts: a liar
  could then get innocent people hidden. Any such rule should act on the
  confirmed people only.
- **The checked address is the only part we can verify.** Everything else is
  self-description, labelled as the node's.

## Open

- **What a node block means to people who take a list.** Today it means nothing
  to them. Only administrators' blocks act, and those only refuse connections.
  Options: leave it at that; warn on cards from people a blocked node is
  confirmed to host; hide posts that only reached you through it. To be ruled
  separately. The page doesn't depend on it.
- **Should a server's operator be able to turn listing off for the whole
  server?** One switch in hrseServer, beside the description.
- **How often the page asks on its own.** Proposed: never. It shows the last
  introduction, and asks again only when someone presses the button.

## Slices

1. **The exchange**: the message pair in `proto`, the door, the asker, the
   checked address, `machine_intros`, and an acceptance claim covering two
   nodes, a device that lists nobody, a forged address refused, and an older
   node's "unknown".
2. **The page**: route, view and the ask-again button, with node ids linked from
   everywhere they're shown.
3. **Reporting a node** from the page, and Block and Warn for moderators.
4. The operator's description, rules link and listing switch in hrseServer.
