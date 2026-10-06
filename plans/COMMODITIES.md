# hrseCommodities™

A design draft (2026-10-06), **built the same day** (HISTORY has the details).
_As built:_ the walk begins a month before day zero, so the first day's chart
has a past (the drift still counts from day zero); "words" are distinct words
per post, as the search index keeps them; reactions are dated by when the node
noted them.

Hay, oats, carrots, apples, horseshoes, bridles and saddles, bought and sold in
hrseBank's Market. Each price is a random walk that comes out the same on every
computer, drifting softly upward, and nudged a little by what the network is
doing: a week of heavy drawing lifts hay, a week of negative reactions lifts
apples. It is Horse Financial's second instrument, after the hrseBond
(plans/UNLOCKS.md), and it stands where the tag stock market was parked
([`STOCK.md`](STOCK.md)).

What Curtis asked for is under _The ask_; the rest is Claude's design, for him
to correct, and the open questions at the end are his.

## The ask (Curtis, 2026-10-05)

1. **Network information as financial inputs,** "even obliquely" - the part of
   hrseStock worth keeping.
2. **Without its three problems:** no listing that sparse networks can't fill,
   no central exchange, and nothing near the complexity of the tag market.
3. **Write it up as a commodities plan** - Claude's middle ground: a price the
   same everywhere, with the network as a bounded nudge.

## The rulings (Curtis, 2026-10-06, on reading the first draft)

1. **Seven commodities, each its own signal:** carrots track positive reactions
   and apples negative ones (in place of one "mood"); bridles track every chat
   message; saddles track the raw number of posts. Hay (drawings), oats (words)
   and horseshoes (new follows) stay.
2. **No markup.** A little arbitrage is fun, and the two-day hold already slows
   it down.
3. **A soft upward drift,** so that commodities are a little more profitable
   than bonds in the long run - "maybe 1.5%".

And as the build began (2026-10-06):

4. **The drift is 0.4% a day, compounding** - about x4.3 a year, a doubling
   every 174 days; patient holders out-earn a chain of bonds.
5. **Prices are bigints** like every HorseBuck, so the drift never overflows
   (HORSE_BASED_CURRENCIES.md, _Stinkingly broken numbers_, as built).
6. **The signals come from the node's public feed** - its front page, every
   public post and share by the personas it hosts (`node_shelf`) - which the
   node certainly keeps, and keeps indexed by time.
7. **Proposed defaults stand** until Curtis says otherwise: the starting prices
   and volatilities below, the ±5% cap, and day zero 2026-10-06.

## Arbitrage, bounded

A price computed from what one node holds differs by node, so a player with two
computers can buy where it's low and sell where it's high (STOCK.md, _Why an
exchange_). Here only the nudge can differ, and it's capped at ±5%: the most a
player can find between their own computers is 1.05 / 0.95, about 10.5%. With no
markup (ruling 2) that edge is real - but it has to survive two days of the walk
first (the hold), so it's a bet with good odds, not free money. The cap is what
keeps it small; doubling it would double the game.

## The walk

- **One walk per commodity,** from the day the commodities open (day zero). Each
  day's step comes from a hash of the commodity's id and the date, so every
  computer derives the same step without asking anyone.
- **Around a rising line:** the walk wanders above and below a target that
  climbs every day (ruling 3), and is pulled back toward it a little every day -
  it swings, but never runs off to zero or to infinity, and over months it
  rises.
- **The drift:** the target compounds 0.4% a day (ruling 4).
- **A starting price and a daily volatility per commodity,** so they feel
  different: hay steady and cheap, horseshoes and saddles dear and wild.

The walk is computed by the node (Rust), and the client shows what the node
answers, so the browser never has to reproduce it. Floating-point differences
between platforms can't split the ledger either: a trade records the price it
paid.

## The nudge

Each commodity reads one signal off the node's public feed (ruling 6), as this
week against the past month:

| Commodity  | Reads, over the feed                                                   |
| ---------- | ---------------------------------------------------------------------- |
| hay        | its drawings                                                           |
| oats       | its words: distinct words per post, from the search index's tokens     |
| carrots    | positive emoji labels on its posts (`score::tone`)                     |
| apples     | negative emoji labels on its posts                                     |
| horseshoes | follows of its personas: a daily snapshot of the count, and its growth |
| bridles    | chat messages in its rooms                                             |
| saddles    | its posts, of any kind                                                 |

- **The signal is a ratio,** this week's daily rate over the month's, minus one,
  clamped to ±1 and scaled to the cap: a week twice as busy as the month is +5%,
  a dead week -5%.
- **Too little data is no nudge.** Below a floor (10 events in the month) the
  nudge is zero, and the walk carries the market alone - an empty network is a
  calm market, not a broken one. A desktop node, hosting one person, mostly
  trades the plain walk; a busy server has weather.
- **Counted once a day, kept in a small table** (`commodity_days`: a day, a
  signal, a count), and only ever read a month at a time. Posts, drawings,
  words, reactions and chat carry their own dates, so the first day fills the
  past month in; follows, a snapshot, build up from the day they start.
- **Shown as the weather:** "apples ↑ 4% - the network is in a mood", so the
  player can see the network moving their prices, and play it.

## Trading

As hrseBonds, and as STOCK.md designed for shares:

- **A purchase is a lot** in the persona's `horse_instruments` register, beside
  its bonds: the commodity, the units, the date, and the price paid per unit.
  Its ledger line is the cost, out. **No overdraft.**
- **A sale** writes its date and price into the lot, and its line pays it in.
  One price both ways - no markup (ruling 2). Partial sales split the lot.
- **The two-day hold:** bought on day D, sold on D+2 at the earliest.
- **Every computer reads the same lot,** so the ledger agrees everywhere,
  whatever each computer's nudge was.
- **Behind Horse Financial,** like the bonds.

## Where it shows

Under the hrseBond in the Market: each commodity's price today, its weather, a
30-day chart (the walk is cheap to compute backwards, so the chart has a past
from day one), and a buy box. The portfolio lists lots beside bonds, with what
they cost, what they'd sell for today, and a sell button once the hold is over.

## Building it

1. **The walk:** a pure function of (commodity, day), unit-tested for being the
   same on every call, mean-reverting, and never below a floor.
2. **The nudge:** the seven daily counts, the ratio, the cap and the data floor.
3. **Lots and trades:** buy and sell doors, the hold, the ledger lines, and
   acceptance claims - no overdraft, the hold, and two computers with different
   nudges agreeing on one ledger.
4. **The Market section** and the portfolio's lots.

## Open questions

- **Starting prices and volatility.** Proposed, and built with: hay H$ 50 at 3%
  a day, oats H$ 80 at 4%, carrots and apples H$ 120 at 6%, bridles H$ 150 at
  5%, horseshoes H$ 400 at 8%, saddles H$ 600 at 7%.
- **The cap.** ±5% keeps the arbitrage between a player's own computers to about
  10.5%, two days at risk; a bigger cap makes the network matter more and the
  arbitrage bigger.
