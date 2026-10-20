# Custom domains - a person at their own web address

A design draft (2026-10-15), with rulings (2026-10-16). Slices 1 to 3 built. Any
persona may claim and prove a domain, for the ✓ on its profile (2026-10-20); for
now, only a node administrator's personas are served at theirs (2026-10-18).

## The ask (Curtis, 2026-10-15)

"Currently cube-drone.com is served by a hugo blog. I'm working on migrating all
of the content over to horsedrawingtycoon's powerful internal publishing system,
but the next step after that is: let's say I have
horsedrawingtycoon.com/@cube-drone, but I'd like to serve THAT at
cube-drone.com - is that best served by a CNAME link, a nginx rerouting rule, or
what? What kind of tools should horsedrawingtycoon.com/ringtome provide to allow
users to use their node identity as a real public-facing identity?"

And, once the first answer was given: "once a CUSTOM_DOMAIN exists, it very much
CAN live with the persona, right? 'This person can always be found at this real
actual web location'?"

The proposal below is Claude's; the rulings that settle parts of it come first.

## Rulings (Curtis, 2026-10-16)

1. **One domain per persona**, exactly the name claimed. `cube-drone.com` and
   `www.cube-drone.com` are two domains, and the node gives `www.` no meaning of
   its own (Curtis: "worrying about it too much is wasting our time"). Pointing
   a name at the front - a bare domain behind a front that takes only a CNAME
   included - is the person's DNS provider's to solve, not the node's.
2. **No free subdomains of the operator's domain**
   (`cube-drone.horsedrawingtycoon.com`), now and perhaps ever: they need a
   wildcard certificate or the operator's own HTTPS for every name, "a big ol'
   'not yet'/'nah'", and `domain/@person` is a well-known pattern already.
3. **Custom domains are on by default.** An operator can turn them off
   (`RINGTOME_CUSTOM_DOMAINS=off`). Being on costs a node nothing until a domain
   points at it: a domain no DNS record sends here never arrives, and one that
   does but has no certificate fails at the browser, before the node.
4. **Well-known proof earns the ✓**, but never serving (section 2) - nor, on its
   own, the canonical address (ruling 7, which amends this one).
5. **A node that isn't serving the domain doesn't redirect to it**; it only
   names it as the canonical address (section 4). Accepted from Claude's
   proposal "for now".
6. **The Hugo site's links aren't kept.** Redirecting every old address would
   need machinery horsedrawingtycoon.com would have to maintain forever (Curtis:
   "maintaining links perfectly would require intricate functionality I'm not
   willing to maintain"). An old link lands on the person's page under a 404,
   saying nothing lives at that address - what `/@name/<anything>` already
   does - so the reader keeps the identity and loses only the post. One
   exception, because it costs one route: `/index.xml`, Hugo's feed address,
   answers with the persona's feed on the domain, so existing subscribers follow
   along without doing anything.
7. **The canonical address waits for the domain to be served** (Curtis,
   2026-10-16, amending 4). A verified claim says the domain is the persona's,
   not that anything at it serves their posts: while Hugo answers
   cube-drone.com, `https://cube-drone.com/<path>` is a Hugo 404, and naming it
   canonical would hand every reader and search engine a dead link. So the
   domain becomes the canonical address only once the claim is verified **and**
   a Ringtome node answers at it. The serving node says so in its own
   `/.well-known/ringtome` (`"served": true`), which every node fetches in its
   check anyway (section 2). Serving (slice 3) is built before the canonical
   address (slice 2).

## The frame: the claim is the persona's, the serving is the node's

A custom domain is three statements by three parties, and the design is keeping
them apart:

| Who says it     | What it says                                     | Where it lives                    |
| --------------- | ------------------------------------------------ | --------------------------------- |
| **The persona** | "I am cube-drone.com"                            | its profile, signed; it travels   |
| **DNS**         | "cube-drone.com is this root" and "served there" | a TXT record; an A/CNAME record   |
| **A node**      | "I serve cube-drone.com for this persona"        | derived: the first two must agree |

The claim goes wherever the persona goes, through every sync and every peek.
Which node answers for the domain today is a fact DNS settles, and DNS belongs
to the domain's owner. Moving to another node is changing one DNS record: the
claim, the paths and every link already out on the web stay where they are.

This is the PROJECT_PLAN tier settled under _Naming: Human-Readable Names Are
Pointers, Never Authority_ ("DNS-anchored domains ... the binding must be
bidirectional"), built at last, with a web address attached.

## Why not a CNAME, and why not an nginx rule

- **A CNAME alone** only gets the browser to the right machine. The request
  still arrives with `Host: cube-drone.com`, and the node, not knowing that
  means `@cube-drone`, serves its front page. An apex domain (`cube-drone.com`,
  no `www`) also can't carry a CNAME without the DNS provider flattening it, and
  whoever terminates HTTPS needs a certificate for the name.
- **An nginx rewrite** (`server_name cube-drone.com`, proxy to
  `/@cube-drone$request_uri`) works only for an operator, and badly. The app is
  a single page: its `/api/...`, assets, `/ringtome/...` and service worker
  would all take the prefix, so nginx needs an exception list that drifts from
  the node's own. The node still names `horsedrawingtycoon.com/@cube-drone/...`
  in `<link rel="canonical">`, `og:url`, the sitemap and RSS, so search engines
  credit that address, not the domain. And no user who isn't the operator can
  ever do it.

Both fail for the same reason: the node has to know the domain is a person's.

## What's already here

- **Paths** (WEB_ADDRESSES, slices 1-3 built 2026-10-11): every open post has a
  path that lives on the post as a public label, answers on every node at
  `/ringtome/user/<seg>/<path>`, and at `/@name/<path>` where the persona has an
  @name. A domain is a third, shorter front on the same paths. The reserved
  words that can't be a path (`webpath::RESERVED`) are already the list of
  segments a domain's router must leave alone.
- **One public address per node**: `webpath::public_url`, `public_slug`,
  `person_address`, `post_address`, and `nodeface::public_base` all assume the
  node has one name. They're the one place canonical addresses come from, which
  is where the domain form slots in.
- **Profile fields** (`name`, `bio`, `avatar`, `banner`, read through
  `idface::profile_value`): signed, last-writer-wins, and carried by peeks
  (`PEEK_SCOPE` includes the profile). A new field travels with no new wire.
- **The way back** (WEB_ADDRESSES slice 3): `GET /api/node/at/<name>[/<path>]`
  answers a web address with its persona and post, and the reader's node asks it
  through `GET /api/web-address?url=`.
- **HTTPS is the operator's** (SERVER.md): the node speaks plain HTTP behind
  their proxy or CDN, and SERVER.md carries recipes for Caddy, nginx and a CDN
  in front (2026-10-15).
- **A DNS resolver**: `hickory-resolver` is already in the tree (through iroh),
  so TXT lookups add no new crate to the build.

## The proposal

### 1. The claim: a `domain` profile field

The persona's profile gains a `domain` field holding a bare hostname: lowercase,
punycode for international names, no scheme, no path, no port. `cube-drone.com`
or `art.lassam.net`. It's signed and last-writer-wins like the other fields, and
a peek carries it.

One domain per persona, exactly the name claimed (ruling 1).

The claim on its own proves nothing; anyone can type any domain into a profile.
It counts only once DNS agrees (section 2), and until then nothing displays it.

### 2. The proof: a TXT record, checked by whoever displays the claim

The domain's owner publishes:

```
_ringtome.cube-drone.com.  TXT  "ringtome-root=AwTyvw9SPjfiJ4xvMfwDKZeHQH6N1mw3LQtoYtJNPfqU"
```

The value is the root in base58, the key half of the speakable form. The worded
form (`sway-broke-AwTy...`) also parses, and its checksum is checked as
everywhere else. One record names one root, so a domain can't vouch for two
personas.

**Every node that would show the claim checks it itself**, not just the node
serving the domain. A claim plus a matching TXT record is **verified**. A claim
without one is **unverified** and shown nowhere. A claim that was verified and
has stopped matching is **lapsed**. The verdict and when it was reached are a
node memo (a small table keyed by root), never a wire fact, because the answer
depends on when you asked. The node checks again when the profile changes, and
otherwise about daily. A failed lookup (DNS down) keeps the last verdict for a
grace period instead of flipping to lapsed on one bad answer.

**`/.well-known/ringtome`** (JSON naming the root) counts as proof **for the
badge only**, for a domain hosted somewhere else: a Hugo site that keeps running
and just wants to say who it is. It can't get a node to serve the domain,
because a node can't fetch a well-known file from a domain that points at itself
before it has agreed to serve it. TXT is the proof for serving.

**Served** is a second fact, beside the verdict (ruling 7). A node serving the
domain answers `/.well-known/ringtome` there itself, with the persona's root and
`"served": true`; every check fetches the file, whatever proved the claim, and
notes whether the domain said so. A file that's missing or doesn't say served
means another site is answering - Hugo, still - and the domain isn't canonical
yet. A fetch that fails keeps what was noted.

### 3. The serving: routing by Host

A node serves a domain when all three hold:

- the operator hasn't turned custom domains off (`RINGTOME_CUSTOM_DOMAINS`, on
  by default: ruling 3);
- a persona **hosted here** (an account on this node, not a peek) claims the
  domain;
- the claim is verified.

A request whose `Host` is a served domain is routed:

| Path                                       | Answer                                        |
| ------------------------------------------ | --------------------------------------------- |
| `/`                                        | the persona's page                            |
| `/<path>`, `/<folder>`, `/<folder>/<path>` | the post, or the folder, as under `/@name/`   |
| `/feed.xml`, `/sitemap.xml`, `/robots.txt` | this persona's own, in the domain's addresses |
| `/api/...`, the app's files, pictures      | passed through untouched                      |
| `/ringtome/...`, someone else's `/@name`   | the node's public URL (their own: home)       |
| `/index.xml`                               | this persona's feed (ruling 6)                |
| `/.well-known/ringtome`                    | the root, and `"served": true` (ruling 7)     |
| an address that names nothing              | the persona's page under a 404 (ruling 6)     |
| a former path (WEB_ADDRESSES slice 4)      | a permanent redirect to the current one       |

A `Host` that matches nothing keeps today's behaviour.

The page heads (title, OpenGraph, `ringtome:post`) are the ones `/@name/<path>`
already draws, with the domain's addresses in them.

### 4. The canonical address: the domain, on every node

The canonical address becomes the shortest form that can be vouched for, in this
order:

1. **the verified and served domain** (ruling 7) -
   `https://cube-drone.com/<path>`;
2. the @name form, where the persona has one on this node;
3. the identity form, `/ringtome/user/<seg>/<path>`.

What changes is the scope. The @name form is only good on its own node; **the
domain form is good on every node that has verified the claim**. A node that
only peeks at cube-drone still names `https://cube-drone.com/<path>` in its
`<link rel="canonical">` and `og:url`, and "copy link" hands it out. The web
learns one home for the work, wherever a reader happened to find it. This is the
"can always be found at this real web location" part.

Redirects stay narrow, following WEB_ADDRESSES ruling 5:

- **On the serving node**, `/@cube-drone/<path>` redirects to
  `https://cube-drone.com/<path>` while the claim is verified. The @name is this
  node's fact, so this node may forward it.
- **Everywhere**, the `post/<hex>` and identity-path forms don't redirect; the
  canonical link does that job. Neither does any node that isn't serving the
  domain: it can't know that the domain is up at this moment.

**In signed words**, a link to `cube-drone.com/<path>` stays as written, like an
@name link: the render-time resolution of WEB_ADDRESSES slice 3 turns it into an
in-app link when it's shown. The difference is that a domain link resolves on
any node, by looking up the TXT record, not just through the website that served
it.

### 5. A reading site, not a second front door

A custom domain serves what a stranger can read and nothing that needs a
session:

- No login, settings, composing, OAuth or MCP on the domain. The OAuth issuer
  stays `RINGTOME_PUBLIC_URL`; a domain must never become a second issuer.
- Buttons that need a session (follow, reply, buy) go to the node's public URL,
  or to the reader's own app through the existing "open in your app" path.
- No cookies are set on the domain, and the app doesn't register its service
  worker there.

That keeps the domain from becoming a second login origin with its own cookie
jar, its own phishing surface and its own share of every security review.

### 6. Certificates: the front's job, from the node's list

The node has never handled HTTPS and doesn't start here. Whatever sits in front
of it terminates HTTPS and gets the certificates: a CDN, Caddy, nginx with
certbot (SERVER.md, _HTTPS is required - and it is yours_). The one thing the
front can't know is which domains the node has agreed to serve, because only the
node checks the claims. So the node publishes that, in a form any front can
read, and nothing in the node is specific to one front:

- **`GET /api/node/domains`** lists the domains the node serves, each with the
  persona's root and when its claim was last verified.

Keeping the front in step with that list is an **adapter**: a small tool beside
the node, in the repo's own languages (`node/tools/`), run on a timer by the
operator. It adds a domain when its claim is verified and removes it when the
claim lapses. Its credentials stay in the tool, never in the node's config.
Adapters are built when an operator needs one:

- **BunnyCDN** - the one horsedrawingtycoon.com needs (Curtis, 2026-10-15: Bunny
  provides every certificate and the backends behind it speak plain HTTP). Bunny
  issues a free Let's Encrypt certificate for any hostname added to a pull zone,
  and both steps are in its API (add the hostname to the pull zone;
  `GET /pullzone/loadFreeCertificate?hostname=`). The pull zone needs two
  settings, once, whatever the adapter does:
  - **Forward Host Header** on, or every request reaches the node under the
    origin's name and it can't tell `cube-drone.com` from
    `horsedrawingtycoon.com`;
  - **Vary Cache → Requested Hostname** on, or the cache keys on the path alone
    and `cube-drone.com/` can be answered from horsedrawingtycoon.com's cached
    front page. Bunny warns that some vary options stop single-URL purges;
    whether this one does is unchecked.

  Bunny wants a CNAME to the pull zone and refuses A records to its addresses,
  so a bare domain needs a DNS provider that flattens the CNAME (Bunny DNS
  does) - the person's to arrange (ruling 1).

- **Caddy, on a bare server** - if an operator asks. Caddy's `on_demand_tls`
  asks a URL before issuing a certificate for a name it hasn't seen; a door
  answering 200 for a served domain and 404 otherwise
  (`GET /api/node/domain-ok?domain=`) makes it fully automatic, with no adapter
  process at all.
- **nginx with certbot** - a loop that runs `certbot` for each new domain on the
  list and reloads nginx. Or, for an operator with one or two domains, by hand.

**Curtis's own first domain needs none of this**: adding `cube-drone.com` to the
pull zone in Bunny's dashboard, once, is the whole certificate story until other
people start adding domains.

The settings page shows the user the exact records to make: the TXT record, and
the record that points the domain at the front - a CNAME to
`RINGTOME_DOMAINS_TARGET`, a hostname the operator declares (behind Bunny, the
pull zone's `*.b-cdn.net` name; on a bare server, a name like
`domains.example.com` the operator can move without every user editing an IP
address), and, for a bare domain behind a CNAME-only front, that their DNS
provider must flatten the CNAME. The page checks as the user goes and says which
record is missing.

### 7. Finding a person by their domain

- **Bylines** show `cube-drone.com ✓` for a verified claim, beside or instead of
  the node-local @name.
- **The People paste box** accepts a bare domain. The node looks up the TXT
  record, which gives the root. It then asks `https://<domain>/api/node/at/`
  (WEB_ADDRESSES slice 3's door) for the serving node's key, which becomes the
  `?via=` hint for the first sync. A domain served elsewhere still gives the
  root, and the persona is found the ordinary way.
- **First resolution is pinned.** A client that has known cube-drone under
  `cube-drone.com` surfaces a change of domain, or a domain that now names a
  different root, as an event to show the user, never a silent switch (_Naming_:
  monotonic memory, applied to names).

### 8. When a domain lapses

Domains expire and strangers buy them. Requiring both sides to agree is what
makes that safe: the new owner's TXT record won't name the old root, so the
claim lapses. When it does:

- the ✓ disappears everywhere the next check runs;
- canonical addresses fall back to the @name or identity form;
- the serving node stops answering the domain and stops redirecting to it;
- links already out on the web point at whatever the new owner serves. That
  can't be prevented and isn't Ringtome's to fix, but nothing signed can be
  forged, and a client that pinned the old root notices.

So the honest promise is: _this person can be found at this web address for as
long as they hold the domain and it agrees with them._

### 9. Privacy

A domain claim is a public link from the persona to a domain, and through the
domain to its registrant (often behind WHOIS privacy) and to the machine that
serves it. Two personas with domains served from the same one-person box are
linked by their address, the case _Hosting and the Colocation Problem_
describes. The settings page says this plainly before the field is saved. A
persona meant to stay unlinked shouldn't claim a domain.

### 10. Moving cube-drone.com off Hugo

The case that started this. The old site's links aren't kept (ruling 6), so the
order only has to keep the site up through the switch:

1. **Import the posts** (in progress).
2. **Publish the TXT record and claim the domain** while Hugo is still serving.
   The ✓ starts showing, with nothing changing for visitors; the canonical
   addresses stay as they are, because the domain doesn't say it's served yet
   (ruling 7).
3. **Add the domain to the Bunny pull zone** and have Bunny issue its
   certificate, with Forward Host Header and Vary Cache by hostname already on
   (section 6). Nothing points at it yet, so nothing changes for visitors.
4. **Point the domain at the pull zone**: a CNAME, which for the bare
   `cube-drone.com` means a DNS provider that flattens it (Bunny DNS does;
   section 6). The cutover is one DNS change, and reverting it is one more. Each
   node's next check finds `"served": true`, and the canonical addresses move to
   the domain within a day.

## Slices

1. **The claim and its proof** - _built 2026-10-16._ The `domain` profile field
   takes a bare hostname (`domains::normalise`; the store refuses anything
   else). `profiles::refresh`, the byline cache's edge, notes each claim in the
   `domain_proofs` memo (node rung 102) and checks it at once; the
   `domain-proofs` loop asks again daily, hourly while lookups fail, with a
   three-day grace for a verified claim whose way of proof stops answering. TXT
   through `hickory-resolver`, well-known through the unfurler's guarded fetch.
   The profile answer and contact rows carry `domain` only when verified, and
   `usePerson` shows it as `cube-drone.com ✓` under the names. The owner's doors
   are `GET`/`PUT /api/identity/<root>/domain` and `POST .../check`, and the
   profile settings page shows the record to add. The rig pretends DNS per node
   through `/test/dns-txt` (`test/domains.cjs`). Not yet: a feed row's author
   who is neither a contact nor fetched shows no ✓, because the row's byline
   doesn't carry it.
2. **Canonical everywhere** - _built 2026-10-16, after slice 3_ (ruling 7).
   `webpath::person_url` and `post_url` give the domain form first, on every
   node whose memo has the claim verified and served (`domains::canonical`): the
   post and person heads (`<link rel="canonical">`, `og:url`, the structured
   data), the feeds, the reading copies. A persona whose domain is canonical
   leaves the node's sitemaps for the domain's own, and is indexed by the
   domain's terms, not the node's public URL. `GET /api/node/slug-of/<root>`
   also answers `domain`, so a post card's "link" and QR code and the person
   card's QR code hand out `https://<domain>/<path>`. In-app links stay this
   node's own addresses: following a post in the feed must not leave the app.
3. **Serving** - _built 2026-10-16_ (domainsite.rs). A service around the whole
   router rewrites a served domain's paths to the persona's address before
   anything routes them, and answers `/.well-known/ringtome` (`"served": true`),
   `/robots.txt` and `/sitemap.xml` itself; `/feed.xml` and `/index.xml` are
   their feed; an address that names nothing is their page under a 404. Only GET
   and HEAD, no `Set-Cookie`, and the node's own pages - someone else's,
   `/ringtome/...`, `/@name` - go to the node's public URL; their own address in
   the node's form comes home. Served means TXT-proved, hosted here, and
   `RINGTOME_CUSTOM_DOMAINS` not `off`. Every check now fetches the well-known
   file and notes `served_ms` (node rung 103); a 404 or an oversized page there
   is "another site answers", not "no answer". On the serving node `/@name/...`
   redirects (temporary: a domain can lapse) to the domain once served.
   `GET /api/node/domains` lists what's served. The page says
   `<meta name="ringtome-site">`, and the app becomes a reading site of theirs
   (`js/domainsite.js`). The settings page names the CNAME to
   `RINGTOME_DOMAINS_TARGET` and whether the domain answers yet. SERVER.md has
   _People's own domains_. The rig sends the Host header itself, and pretends
   well-known files through `/test/well-known` (`test/domains.cjs`). Not yet:
   - the settings page doesn't look the CNAME up itself; "check now" learns only
     whether the domain answers;
   - a folder named `api`, `static` or `fonts` is hidden on the domain by the
     node's own doors of those names;
   - an `/@name/<path>` link inside the domain's pages reloads the page, through
     the node's redirect home, instead of routing in place;
   - not yet looked at in a browser.
4. **Certificates without an operator** - the Bunny adapter first, since it's
   the front horsedrawingtycoon.com runs; Caddy's `domain-ok` door and a certbot
   loop when an operator asks for one. Needed once other people add domains.
5. **Finding by domain** - the paste box, pinning, surfacing a change.
6. **The words in the HTML** - WEB_ADDRESSES slice 5, moved up: a blog on its
   own domain is exactly what search engines are asked to index, and today they
   see only the head.
7. _(Later)_ **WebFinger** at the domain, so `@cube-drone@cube-drone.com` works
   for ActivityPub (ACTIVITYPUB.md).
