# UNAUTHED - the node's public face

Curtis's brief (2026-09-14): what a node shows to someone who is not signed in. Today the
app refuses to run without a session and shows the welcome screen, so `/id/` has a
server-rendered page because nothing else could show a stranger anything. The direction:
present the public content with the same Preact surfaces signed-in readers get - the feed,
the people page, a person's shelf with search, tags and the kind row - because those are
built, and building them again in raw HTML would be a second rendering path for the same
words. A node is a publication: it shows the personas it hosts and everything public they
have said, as one feed; and a hosted persona may claim a short address on this node.

## Rulings (Curtis, 2026-09-14)

1. **Data versus rendering, not HTML versus Preact.** The cards, the facet rows, the search
   and label hooks, the person row and the persona shelf adapter all take their data from
   the API and already accept no current persona; a stranger's `/id/` page with search,
   tags and kinds is nearly free, since the shelf doors already answer strangers. What does
   not reuse is the feed app and the people app, which read the signed-in persona's own
   mirror - a stranger has none. So the arc is two server doors and a shell, not a rewrite.
2. **The sealed rule is already the stranger's rule.** A viewer of nobody gets no sealed
   posts, no sealed labels and no keys (PROJECT_PLAN's Replies under the author's seal;
   Contact tags). The anonymous doors pass no viewer and change nothing about the seal.
3. **Listed on this node, default on.** A node's front page turns hosting into publication:
   every hosted persona's public posts are public already, but appearing on the node's
   front page is a different thing from being findable by address, and someone may host a
   persona on a friend's node without wanting to be its front page. Each hosted persona has
   a switch, "listed on this node's front page", on by default; the node feed and the people
   page honour it. It is a fact about this node, not the persona - it does not travel - so
   it lives in a node table set through an authenticated door, readable by the anonymous
   doors without a session.
4. **The node feed.** Everything public by every listed hosted persona, newest first, with
   the labels row, the kind row and the header's search over the whole held shelf (the same
   narrowing the feed and the person page use, viewer none), keyset paging like the feed.
   Rebroadcasts by hosted personas ride as shares, as they do in a reader's feed. It is the
   node's front page. The dial does not apply: there is no reader to have interest.
5. **The people page.** Every listed hosted persona, with the byline the node holds, the
   speakable address and the node slug (below) when one is claimed. No relationships, no
   sorts by trust: a stranger has none.
6. **Node slugs: a short address per node, first come first served.** A hosted persona may
   claim a slug - `@cube-drone` - and `node.tld/@cube-drone` is that persona's page on this
   node. Ideally a slug would follow the persona around, but two personas on two nodes can
   each claim the same slug and there is no tiebreaker in a system with no centre, so a
   slug is a node fact: claimed on this node, meaning nothing on any other. The slug page
   says so beside the speakable address, which is the persona's real name everywhere. A
   fourth address floor, then: `/home/` for apps, `/in/` for buckets, `/id/` for personas by
   their real address, `/@` for personas by this node's short name.
7. **Claiming, changing, holding.** A slug is lowercase letters, digits and hyphens, three
   to thirty-two characters, no leading or trailing hyphen. Claimed through an authenticated
   door by a hosted persona; refused when another persona holds it as its current OR its
   last slug. A persona may change its slug at any time to any unclaimed one, and then holds
   two: the current, and the last it claimed, which redirects to the current so links keep
   working and which nobody else may take. Changing again drops the older of the two. A
   persona may retake its own last slug (the two swap). A persona removed from the node
   releases both. An unlisted persona keeps its slug: listing is about the front page, and
   claiming a slug is its own choice.
8. **The shell.** Without a session the app serves the node's front page at `/`, the people
   page, every `/id/` page and every `/@slug` page, with a sign-in affordance where the
   persona menu sits; the session-only hooks stay guarded as the persona shelf adapter
   already guards them. The server-rendered `/id/` page retires to a thin head - the title
   and the OpenGraph meta, which crawlers and link unfurlers read - with the app taking the
   body, so there is one rendering path again. Full pre-rendering of the app to HTML stays
   possible later if crawlers ever need the words; nothing today asks for it.

## Slices

1. **The doors (built 2026-09-15).** The node shelf memo (`node_shelf`, folded on the fold
   lane when a hosted persona's posts or shares move, node schema 46), the node feed with
   labels, kinds, search and paging out of it, the listed-personas door, and the listing
   switch (`node_listing`, an authenticated door, honoured by both). A suite: a stranger
   with no session sees two listed personas' open posts newest first with their labels,
   never a sealed post or an unlisted persona's; narrows by tag, kind and words; the switch
   is the persona's own and takes effect at once.
2. **The shell (built 2026-09-15).** Without a session the app serves the front page at
   `/`, the people page at `/people`, every `/id/` page and every post page, under a
   header with the node's search box, a "people" button and "sign in", which lives at
   `/home` where every app URL lands a stranger. The feed's stream took its doors as
   props (`feedUrl`, `labelsUrl`, no dial, its own facet picks), so the reader's feed and
   the node's front page are one body over two doors; the people page reuses the person
   row over the personas door. The server's `/id/` page is the app with a head - the
   title and the OpenGraph meta - for hosted, peeked and unknown personas alike (the
   malformed-address pages stay raw, having no persona); the raw card and its identicon
   retired. The node pages live beside the shell, not among the registry's apps.
3. **Slugs (built 2026-09-16).** `node_slugs` (node schema 47) and a module that owns the
   rules - the grammar, first come first served, the current and the last, the swap, the
   drop of the oldest, release on leaving; the claim door on the persona (`""` gives the
   current one up) and the anonymous resolve door; `/@slug` serving the persona page with
   its meta head, the last slug redirecting to the current, an unknown one the app under a
   404; the short name on the people page, beside the real address on the persona page,
   and in the profile answer; "your name on this node" on the profile settings page. A
   suite for every rule, and unit tests for the grammar and the ledger.

## Residuals

- Rate limits on the anonymous doors: a node's front page is the first thing a scraper
  finds. The feed door's paging bounds the damage; a per-address budget is the next step.
- A node-observed feed ("everything public that anybody here is looking at") is a
  different thing from the node feed and stays on NEXT_STEPS.
- Search over the node feed indexes only open posts for a stranger; the index already
  holds sealed bodies for the readers who hold keys, and the narrowing filters by viewer.
