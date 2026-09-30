# Horse-Based Currencies

*Design draft, 2026-09-29. Nothing here is built. Where a line says **Settled**, Curtis decided it;
everything else is a proposal for him to cut.*

HorseBucks are the tycoon half of Horse Drawing Tycoon 2: a number that goes up while you use the
app, that you spend on ridiculous things, and that compounds, collapses and occasionally explodes
into squidjillions. The hard wall is that distributed currencies are well explored and full of
danger. There is no global order and no referee, so a persona's two computers can spend the same
HorseBucks at once, and no scheme stops that. This design doesn't try to. It removes the
consequences instead.

**The order of building** (Curtis, 2026-09-29): heartbeats first (with the last one on a persona's
card, and the People page sortable by recent activity), then the network DAU counter (with a graph
of DAU over time as seen from this node), then HorseBucks, whose interest runs on heartbeat days.

## The rulings

1. **HorseBucks never move between people.** *Settled.* There are no transfers, no gifts, no
   markets and no prices set by other players. Every balance is one persona's own business, so
   nobody else's number depends on it, and nothing needs consensus.
2. **A balance is a view, never a fact.** It is a fold over the persona's own ledger entries,
   recomputed like every other memo in the node. Nothing stores a balance as truth, so nothing ever
   has to be corrected.
3. **Nothing is rejected and nothing is rolled back.** A purchase is an entry, not a request. If
   two computers each buy something the balance could only afford once, the chains merge, both
   purchases stand, and the fold comes out lower, possibly negative. You keep the house *and* the
   jet-ski; you are in debt. A double-spend is a consequence, not a conflict.
4. **Balances may go negative, at credit-card rates.** Debt is the honest outcome of rule 3, and it
   compounds: *settled* (Curtis, 2026-09-29) at **2% per day, compounding** (per heartbeat day, as all
   time is here). Debt doubles in about 35 days and grows about 1,380-fold in a year.
5. **Everything is farmable, and that's fine.** *Settled* (Curtis: "all of this stuff is easy to
   farm"). The economy is a toy with no outside value. Nothing in the design pretends to resist
   farming; it only stays deterministic.

## Time: HorseTicks

Interest needs time, and this system has no clock anyone agrees on. What it does have is order: a
persona's chain is ordered, and a merged fork has a deterministic order (causal order, ties broken
by entry hash). Every node computes the same sequence.

So interest is measured in **HorseTicks**, not seconds. A tick is something that happened on the
persona's own ledger: a post, a drawing, a reaction received, a daily heartbeat (below). A HorseBond
pays per tick while you hold it; debt compounds per tick. Timeless in the only way that holds here.

The balance depends on order, because compounding is order-dependent. But the order is shared, so
every node that folds the same entries gets the same number. When a fork you didn't know about
lands, the balance is recounted, perhaps lower. Because it is a view, that is just a recount:
nothing already held is taken away.

## The ledger

- **An entry is `{currency, legs}`.** An exchange (spend 10 Wood, gain 1 Mystery Token) is one entry
  with two legs, so it can never be half-applied.
- **Where entries live:** purchases, exchanges and instruments go on a *private* lane, synced to the
  persona's own computers only. Nobody else needs your ledger (see the wealth gate). Earnings are
  mostly derived from things already on the record, so they need no entries of their own.
- **Earning** is its own section below. Reactions received live on the reactors' chains, so a fold
  can only count the ones its node holds, and two of your computers may briefly disagree by a
  reaction or two. Accepted: it's a toy, and they converge as the reactions sync.
- **Instruments are entries too.** Buying a HorseBond is an entry; its interest is the fold's
  arithmetic per tick; cashing it is another entry. A bond bought while overdrawn still pays, and
  the debt it caused still charges. Both are the fold's business, and nothing is undone.

## Earning

*Settled rates* (Curtis, 2026-09-29). Small, passive amounts for private acts; large bonuses for
publishing.

**Private acts**

| Act | H$ |
| --- | --- |
| every 20 words typed | 5 |
| every image uploaded | 10 |
| every 10 strokes in a drawing | 5 |
| every friend followed | 500 |
| every time a friend follows you | 500 |

**Chat and reactions**

| Act | H$ |
| --- | --- |
| every chat message | 5 |
| every emoji or sticker reaction you give, to a chat line or a post | 1 |
| every emoji or sticker reaction you receive | 5 |
| custom (non-emoji) tags, given or received | 0 |

**Heartbeats:** every heartbeat, 10 H$.

**Publication bonus** — paid once, at a work's first publication:
- You earn the private-act amounts for that work *again*.
- Plus a bonus that grows with the work's size, but only above a threshold: a one-word or ten-word
  post earns nothing. *Settled:* at least 100 words to count, then roughly linear in size, but
  paying less than the line near the bottom so low-effort posts stay near zero. A long post with
  images, or a drawing with a lot of strokes, can pay hundreds or thousands of H$.

*Proposed formula* (for Curtis to tune): a work's **size** is `words + 50 × images + strokes ÷ 2`,
each counted as **what's new in it** (below), so a work padded by repetition is small.
Below 100 it pays nothing. From 100 to 300 it ramps quadratically, `(size − 100)² ÷ 200`: 50 H$ at
200, 200 H$ at 300, where it meets the line at the line's own slope. From there it is linear,
`2 × size − 400`: a 1,000-word post pays 1,600, and a 2,000-word post with four pictures (size 2,200)
pays 4,000.

**Measuring what's new, not what's there.** Curtis, 2026-09-29: can a post that's the same image
50 times, or the same words pasted over and over, score low, cheaply? Proposed:
- **Words are distinct three-word shingles.** Normalize the text (lowercase, punctuation stripped,
  whitespace collapsed), take every overlapping run of three words, and count the distinct runs.
  Prose barely repeats a shingle, so the count is close to the word count. A pasted paragraph adds
  nothing after its first copy. It's one pass and a set of hashes, and the same text gives the same
  count on every machine and every release.
- **Images are distinct file hashes.** Pictures are content-addressed, so fifty embeds of one
  picture are one picture.
- **Strokes are distinct shapes,** each hashed after rounding its points a little, so a stamp
  pressed 500 times is one stroke.
- The same measure drives "every 20 words typed": new shingles added across a document's versions.
- **Why not compression ratio:** it's the textbook measure of real information, but a compressor's
  output can change between library versions, and two computers on different releases would
  disagree about old bonuses. Shingles depend on nothing.
- **What it won't catch:** word salad, generated filler, fifty *different* pictures of one horse.
  Farmable, and fine: the point is only that copy-paste isn't the cheapest farm.

**Where each figure comes from.** Almost every amount is derived from what's already on the record,
so none needs an entry of its own:
- **Words typed:** words *added* across a document's versions (the version DAG's diffs), so retyping
  the same paragraph doesn't count twice. That's a proposal; "words in the latest version" is
  simpler but pays nothing for rewriting.
- **Images:** ingest completions. **Strokes:** a drawing's stroke entries. **Messages:** the persona's
  own room chains. **Reactions given and received:** their room and annotation lanes.
- **Heartbeats:** the daily heartbeat entries.
- **Follows:** the published follow edges.

**Farming that would break the numbers, not just inflate them.** *Settled* (Curtis, 2026-09-29: all
three guards agreed):
- **Follow and unfollow loops:** 500 H$ a round trip, forever. Proposed: a follow pays once per pair
  of personas, ever, both ways. **Settled.**
- **Takedown and republish:** a new first publication each time. Proposed: the bonus is per *note*
  (the private document a post is published from), so a note published twice pays once.
  **Settled.**
- **Many computers:** a heartbeat is per persona, per computer, per day. Proposed: the 10 H$ and the
  tick are per persona per day, whatever the number of computers. **Settled.**

## hrseBank™

A new app whose only job is the persona's horse capital:
- **Balance,** per currency, in the broken-number notation.
- **The ledger:** every line that moved a balance, with where it came from ("wrote 340 words in
  *Horses I Have Known*", "Bea reacted 🐴", "HorseBond #3 paid 21 H$"). The fold keeps an
  explanation beside every amount, so the bank can show its working.
- **Instruments held,** with what each has paid and when it matures.

The bank is also where buying happens. Every purchase is a ledger entry (above), and an overdrawn
purchase simply shows the debt.

**The balance in the corner** (Curtis, 2026-09-29): the persona's HorseBucks sit in the quickbar's
bottom-right corner, rightmost, to the right of the clock, and clicking them opens hrseBank. The
number counts up in real time while the persona does things that earn:
- **The node's fold is the truth.** The page's live stream already carries changes as they happen,
  so the balance rides it, and the number rolls up the moment an earning lands (a message said, a
  reaction received, a note saved).
- **Typing counts ahead.** Words typed aren't a node event until the note saves, so the page counts
  them between saves, using the same shingle measure in the page, and the next save confirms or
  corrects the figure.

## HorseBonds

*Settled* (Curtis, 2026-09-29): the first instrument.
- **Price:** at least 2,000 H$.
- **Return:** 1% of the purchase price per heartbeat day, paid into the bank as it's earned.
- **Maturity:** after 100 days the bond returns its whole purchase price.

Because there's no clock, a bond's **days are heartbeat days**: days the persona used the app. A bond
held by someone who never opens the app never matures. That fits the timeless ledger, and is also
the joke.

**Simple interest, on purpose.** *Settled* (Curtis, 2026-09-29): the bond pays its 1% out into the
bank each day rather than into its own value, so it never grows and each payment is 1% of the same
price: 20 H$ a day on a 2,000 H$ bond, 2,000 H$ over its 100 days, then the 2,000 back. Compounding
is the player's job: sweep the payouts into the next HorseBond.

## Later: markets without other players (sketch)

Curtis floated a stock market on content tags ("put 2,000 H$ into *nsfw*") and commodities (hay
futures). Neither is designed yet. The constraint is that a price must come out the same on every
node without anyone agreeing on it. Two ways that stay non-transferable and deterministic:
- **Tag stocks:** a tag's price derived from how often the tag appears in public posts. But every
  node sees a different slice of the network, so a portfolio would be worth different amounts on
  different computers. Honest, but odd.
- **Commodities:** a price walk seeded by the day number (the way release names are derived), the
  same everywhere, and optionally nudged by public signals.

## Stinkingly broken numbers

*Settled* (Curtis, 2026-09-29). Someone will reach 11 megatrillion^38, so a balance is a **bigint**,
exact, and the broken-number notation is how it's *shown*, never how it's kept.

- **Why exact is affordable.** Interest runs on ticks, and ticks are capped at one per persona per
  day (the anti-farming guard), so compounding is bounded: debt doubling every day for a hundred
  years is 2^36,500, a 4.5 KB integer. Megatrillion^38 is about 10^684, roughly 2,300 bits. Folding
  tens of thousands of ticks of numbers that size takes milliseconds. (The first draft was a
  mantissa and an exponent, as incremental games do it. At 18 significant digits a squidjillionaire's
  2,000 H$ bond cost nothing and paid nothing: everything below the precision floor vanished in
  rounding. Exact integers have no floor.)
- **The unit is the horsepenny,** a hundredth of a HorseBuck (proposed). Then 1% of 150 H$ is
  exactly 150 horsepennies, and fractional rates stay exact.
- **One rounding rule, written down.** Compounding debt multiplies by a rational rate each tick
  (×105/100) and rounds once, toward zero (proposed). Still integers, and the same on every machine.
- **No floating point anywhere.** Integer arithmetic is identical in every implementation. The fold
  runs in Rust; the API sends a balance as a decimal string; the page holds it as a JavaScript
  `BigInt` for display.
- **The display:** the first few digits and the magnitude, named. Real short-scale names first, then
  invented **jillions** past them, one per step of a thousand, from the pinned word list the
  speakable addresses and release names use (`pure/words.js`, 1,296 words). The list is
  alphabetical, so the jillions step through it by a stride coprime with its length: the *n*-th
  jillion is `WORDS[(799 × n) mod 1296] + "jillion"`, a permutation, so every magnitude gets its
  own word for 1,296 steps (about 10^3,900 past the start) and two-word names after that. The first
  twenty: acid, pout, desk, sulk, kept, boss, salsa, feed, usher, near, coat, slug, grip, alien,
  puma, doll, totem, lash, bud, scoop (-jillion). The same number wears the same name on every
  machine; 293 salsajillion is a label on an exact number.
  - *Settled* (Curtis, 2026-09-29): the jillions start **after centillion**, so every real name is
    kept and acidjillion is 10^306.
- **What could still explode it:** only ticks arriving faster than daily, which the guard forbids. A
  bug there shows up as numbers growing without bound, which a test can watch for.

## Many currencies

*Settled:* HorseBucks are the first of several (Mystery Tokens, Wood, Energy, Swedish Kroner). They
obey the same ledger rules but are not HorseBucks and can't be spent as HorseBucks.

- **The app defines them.** A registry in code, like `default_media`: currencies ship with the app.
- **Each has its own rules:** whether it may go negative, interest per tick, regeneration (Energy
  refills per tick up to a cap), decay.
- **Nothing converts implicitly.** Only an exchange entry moves value between currencies, both legs
  at once.
- **Rules can change, and history is recounted.** Balances are views, so a release that changes a
  currency's rules re-folds everyone's past: the Horse Federal Reserve changed policy. Two of your
  computers on different releases may disagree until they match.

## Wealth-gated posts

*Settled.* A post may carry a gate: *you must have H$-300,000 in the bank to see this*.

- **The gate travels with the plaintext.** The post's header says `{currency, comparator,
  threshold}`, and the words arrive like any public post's. The reader's own node computes the
  reader's own balance and shows or hides the post, the way a content warning is honoured.
- **No proof of wealth, on purpose.** A persona's balance is self-attested, and a ledger could be
  forged as easily as a number, so shipping balance chains to prove it would cost a lot for nothing.
  Lying about your wealth means lying to yourself, so the gate trusts you.
- **"At most" as well as "at least"**: posts only the deeply indebted may read.
- **Real privacy is a different tool.** An author who wants a post truly unreadable seals it
  trusted-only as well; the wealth gate is a toy on top.

## Heartbeats

*Settled:* a persona posts a **public heartbeat once per day** in which they used the app from a
given computer. Not every 15 minutes, and not a private ledger shipped to others: that would hand
readers the whole activity history and cost a lot of sync space for mostly nothing.

- **What it is:** one small public entry per (persona, computer, day). The day is the persona's own
  claimed UTC date; the computer is the signing key, so no device name travels.
- **What it gives:** a HorseTick per day of use, and a coarse "last seen" (a date, never a time) for
  anyone who can see the persona.
- **What it costs:** at most a few hundred entries a year per persona, per computer. Readers learn
  which days a persona used the app, and nothing finer.
- **The card shows a date, never a time.** *Settled* (Curtis, 2026-09-29): "active today", "active
  yesterday", "active 4 days ago". A heartbeat is sent at the day's *first* activity, so its time
  would say when someone started their day, not when they were last seen.
- **Always on.** *Settled* (Curtis, 2026-09-29): no setting turns heartbeats off, so every persona
  sorts and earns alike.

## Estimating daily active users

Curtis, 2026-09-29: "I'm kind of interested in what it would take, given the decentralized nature of
the system, to take a best-guess at total network DAU". Then, rejecting a design where every node
reports to Horse Drawing Tycoon Prime ("kind of against decentralized policy"): every node estimates
the network's DAU from the nodes it has talked to lately, and shows it on its own front page under
the sign-in: *Now with [0 0 0 0 0 0 3] active users!*, in mechanical odometer digits.

*Proposed:* a **HyperLogLog** sketch per day, gossiped.
- **Each node feeds its own actives in:** the hash of every hosted persona's root that did anything
  on this node today (sign-in, a read, a write). The node knows that from its own sessions, so this
  needs no heartbeats. When heartbeats land, any heartbeat a node holds goes in too.
- **Sketches merge by taking each register's maximum.** That's commutative, idempotent and
  order-free, and a persona active on two computers hashes to the same place and counts once. A
  1 KB sketch (1,024 registers) estimates within about 3%.
- **Nodes swap their merged sketch** when they talk, at most once per peer per day, over a new
  fragment pair (`WantCensus` / `Census { day, registers }`, with the `WantRoomReach` fallback for
  older nodes). A node keeps the union of its own and everything it's handed, and hands that on, so
  after a few hops each node's estimate covers the connected network, not just its neighbours.
- **It reveals roughly nothing:** registers are maxima of hash bit-patterns. Nobody can list who was
  active, or reliably test for one persona.
- **What a node shows:** its own estimate, so front pages can differ slightly, most of all early in
  the UTC day. Proposed: show the larger of today-so-far and yesterday's, so the counter never
  drops to 3 at midnight.
- **Over time:** clicking the counter shows a graph of DAU by day, as this node has seen it: each
  day's final estimate kept as one row (Curtis, 2026-09-29).
- **It counts personas, not people.** Someone who uses three personas in a day counts three times.
  No computer can honestly tell those are one person, and the design keeps it that way.

## Open questions

- Whether earning rates change with the tycoon's progress.
- The size measure: distinct shingles, file hashes and stroke shapes, and the rounding for strokes.
- **HorseBankruptcy** (Curtis, 2026-09-29, "at some point"): clearing the whole table and starting
  from scratch. As a ledger entry it's simple (the fold starts over after it); the questions are
  what it costs, and whether anything survives it.
- Instruments beyond HorseBonds (tag stocks, hay futures), and whether debt ever triggers anything (repossession of
  the jet-ski is a *display* rule, since nothing is ever undone).
- Where the ledger's entry types live on the wire (a new private service, and a public heartbeat
  entry type). The wire only grows, so both are additions.
