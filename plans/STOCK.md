# hrseStock™

A design draft (2026-10-05). Nothing built. **Parked** (2026-10-06).

**Why it's parked.** Curtis, reading the finished draft: worried that "the
30-post minimum over 30 days requirement may present a problem in very boring
sparse networks, a little worried about the centralization of publishing a daily
exchange for what is essentially a silly fun feature, and a little concerned at
the complexity". All three hold:

- **Sparse networks list nothing.** With one real user, almost no tag reaches 30
  appearances in 30 days; the exchange would be empty for months.
- **The exchange is the economy's centre.** It is the only cure found for
  node-local arbitrage, and it makes one server part of every player's game.
- **It's a protocol change.** The signed daily list is a new chain entry type in
  ringtome-proto, under the most intricate instrument in the bank.

Horse Financial's next instrument is [`COMMODITIES.md`](COMMODITIES.md) instead:
the network as a bounded nudge on a price that's the same everywhere. Its rule -
cap what a node can see differently, and charge more than the cap to trade -
could bring tag stocks back without an exchange, once there's a network busy
enough to trade on. The design below stands as it was left.

A stock market in tags. A tag's price is how many posts carried it over the last
30 days, and a player buys and sells shares in it, betting on what the network
will talk about next. It is the first of the "instruments to come" that Horse
Financial promises (plans/UNLOCKS.md).

What Curtis asked for is under _The ask_ and _The rulings_; the rest is Claude's
design around them, for him to correct.

## The ask (Curtis, 2026-10-05)

1. **A tag is a stock.** On any day, its value in HorseBucks is a rolling 30-day
   count of the posts tagged with it, recalculated daily. Players buy and sell
   large amounts, rolling the dice on tag popularity over time.
2. **Prices come from an exchange,** not from each node: a price computed from
   what one node holds moves when its holdings move, so buying on an empty
   computer and selling on a full one is free money.
3. **Operating an exchange is an unlock,** for H$ 100,000,000. A persona
   operating as an exchange publishes, every day, the tags visible to it with
   their 30-day counts.
4. **By default, the exchange is a central account Curtis runs.** A player can
   change their exchange, in the Market, to any persona running one - and doing
   so costs **50% of all their HorseBucks**, while their contracts and purchases
   stay exactly as they are.
5. **"Market manipulation" is an option in the player's preferences,** and both
   buying an exchange and changing exchange need it switched on first.
6. **All of it is behind Horse Financial.**
7. **Two days' minimum hold:** a share can't be sold on the day it was bought,
   or the day after. This keeps day trading and arbitrage to a minimum.

## The rulings (Curtis, 2026-10-05, on reading the first draft)

1. **The base price is H$ 10, and it rises by half a percent a day.** Every
   stock's value is the base times its count, so even a flat market drifts
   softly upward.
2. **Popular tags are scaled down,** so a single share of a busy tag doesn't
   cost hundreds of thousands of HorseBucks.
3. **An exchange lists only its top 750 tags,** and only those with at least 30
   appearances in the past 30 days.
4. **A tag that drops off the exchange** can only be sold, at the base price,
   and can't be bought until it is listed again.
5. **Every count is the exchange's view.** Players can move their own tags'
   prices if the exchange follows them - that's the game.
6. **Distinct tags are counted:** each person's tag on a post is one, so a post
   that collects 50 angry emoji gives 😡 a big boost.
7. **Emoji and automatic tags are tradeable.**
8. **The 50% fee is cash only, and no exchange can be changed while holding
   stock.** Bonds are unaffected.
9. **An unreachable exchange** leaves everyone on its last list until it is
   reachable again - perhaps from a new server, as the same persona.

And on the second draft:

10. **The base grows simply:** H$ 10, plus half a percent of that a day - H$
    0.05 a day, never compounding.
11. **Day zero is the day the exchange starts running,** each exchange its own.
12. **A delisted tag can still be held** - it might come back. It sells at the
    base, and can't be bought.
13. **Buying needs a fresh list; selling doesn't.**
14. **The scaling curve is _base_ x sqrt(30 x _count_),** settled before the
    first exchange opens, so no split is ever needed.
15. **Fresh is today's list or yesterday's** (UTC).

## Why an exchange

Every node holds a different slice of the network, and the ledger's rule is that
every computer of a persona reaches the same lines from the same records
(HORSE_BASED_CURRENCIES.md, _The ledger_). A price that differs by computer
breaks that rule, or invites the arbitrage in item 2. An exchange's list is
signed and published, so every computer holding it reads the same number: a
trade pays the price on the list, and the ledger agrees everywhere.

## The exchange's list

- **Once a day,** the exchange's node counts, over the public posts it holds,
  every tag statement of the 30 days ending that UTC day: a post's own tags, its
  automatic tags, and each person's label or emoji on it, one apiece (ruling 6).
  A tag's count is how many there were.
- **It lists the top 750 tags with at least 30** (ruling 3): a list stays a few
  tens of kilobytes, whatever the network's size.
- **Published as signed public entries on the exchange persona's chain,** dated,
  so they travel the way posts do, and any node can verify them. A list may be
  long - thousands of tags - so it goes out in parts, each a bounded entry.
- **The list carries counts, not prices.** The price is arithmetic every
  computer does the same way (below), so it never has to be trusted to the list.
- **History comes free:** a day's count needs only post dates and tags, so an
  exchange can publish its back-catalogue the day it opens, and a chart has a
  past from the start.

**What counts:** everything public the exchange holds, emoji and automatic tags
included (ruling 7) - _image_ and _micro_ trade as index funds of the network.
Proposed: not anything from people the exchange's operator has blocked.

## The price

- **The base:** H$ 10 on the exchange's first day, plus H$ 0.05 a day, simple
  (rulings 1, 10, 11): day _n_ of an exchange is 10 + _n_/20. A year on, H$
  28.25; three years, H$ 64.75. An exchange's own lists name its first day.
- **A listed tag's share costs the base times its count, scaled down past the
  listing threshold** (ruling 2). _base_ x sqrt(30 x _count_) (ruling 14) - the
  plain product at 30, the threshold, and gentler after: a tag at 3,000 is H$
  3,000 on the first day, not H$ 30,000.
- **A tag not listed is worth the base,** and only sells; a lot of it is held as
  long as its owner likes, and is worth its listed price again the day the tag
  comes back (rulings 4, 12).
- **No splits.** The scaling is one smooth curve that only ever rises with the
  count, applied the same way every day: a tag growing popular never makes its
  shares cheaper, so nobody holding H$ 300,000 of a tag is robbed by its
  success - its price follows its count, nothing else. A split is needed only if
  the curve itself is ever changed: then the exchange would announce it in its
  list ("_x_ split 10 for 1 on day _D_") and every lot of _x_ would multiply its
  shares and divide its price, worth the same the day after.
- **In horsepennies, exactly.** The arithmetic is fixed-point, so every computer
  reaches the same penny.

## Trading

- **A purchase is a lot** on the player's private chain, like a hrseBond: the
  exchange, the tag, the shares, the list date and the price per share. Its
  ledger line is the price times the shares, out. **No overdraft**, as for
  bonds: the buy door catches the ledger up and refuses what the balance can't
  pay.
- **A sale writes its date and price into the lot,** and its ledger line pays
  them in. Every computer reads the same lot, so every computer agrees, however
  their own posts differ.
- **The latest list held.** A trade uses the newest list of the exchange this
  computer holds, and the lot records which (ruling 9): an exchange that's
  unreachable leaves its last list standing until it's back.
- **Buying needs a fresh list** (rulings 13, 15) - one dated today or yesterday
  (UTC), allowing a day for the list to arrive. A stale list still sells: a
  player is never trapped in a position because their exchange went quiet.
- **The two-day hold** counts UTC days: a lot bought on day D sells on day D+2
  at the earliest.
- **Partial sales** split the lot - the sold part with its sale, the rest held.

## Exchanges

- **The default exchange** is a persona Curtis runs. Every node needs its daily
  lists, so the app knows its address the way it knows the starter follows, and
  every node fetches its chain as it would a followed persona's.
- **Running one** is the H$ 100,000,000 unlock `exchange`, behind Horse
  Financial and the market manipulation option. Once bought, that persona's own
  node counts and publishes every day, as a background pass - which means that
  node must be up daily to keep its exchange alive.
- **Changing exchange** takes 50% of the cash balance, as one ledger line
  (`kind` `exchange_fee`), and is refused while any stock is held (ruling 8) -
  so a lot always sells on the exchange it was bought on. Bonds are untouched.
  The choice is a private register, so every computer of the persona trades on
  the same exchange.
- **An exchange belongs to its persona, not its server:** its lists are on the
  persona's chain, so it can move servers and keep its market (ruling 9).

## The market manipulation option

Prefs today are this-browser-only (`mirror/prefs.js`): flippable, and not
synced. An option that guards a 50% fee, and a H$ 100,000,000 purchase, should
be the persona's on every computer - so **proposed:** a private register,
`settings/market-manipulation`, switched on and off in the persona's settings,
with words that say plainly what it opens.

## Where it shows

A **hrseStock** column in hrseBank, beside the Market: the exchange you trade
on, a search over its tags, each tag's price and a 30-day chart, a buy box, and
your lots with what they cost, what they're worth today, and a sell button once
the hold is over. A ledger row folds a day's trades like any other.

## Building it (proposed order)

1. **The list:** counting tags over a node's public posts, the daily pass, the
   signed entries, and reading them back - on the default exchange first.
2. **Lots and trades:** the register, the buy and sell doors, the hold, the
   ledger lines; acceptance claims for price, overdraft, the hold, and two
   computers agreeing.
3. **The column:** the ticker, the chart, the lots.
4. **Exchanges:** the market manipulation option, the `exchange` unlock,
   publishing from a player's node, changing exchange and its fee.

## Open questions

None, as of 2026-10-05.
