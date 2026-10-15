# Custom domains - a person at their own web address

A design draft (2026-10-15). Nothing built.

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

Everything below is Claude's proposal; nothing here is a ruling yet. The
questions waiting on Curtis are under _Open questions_.

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

One domain per persona (see _Open questions_). A claimed apex also covers its
`www.`: the node answers both and redirects the one not claimed to the one that
is.

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

### 3. The serving: routing by Host

A node serves a domain when all three hold:

- the operator has turned custom domains on (`RINGTOME_CUSTOM_DOMAINS`; see
  _Open questions_ on the default);
- a persona **hosted here** (an account on this node, not a peek) claims the
  domain;
- the claim is verified.

A request whose `Host` is a served domain is routed:

| Path                                          | Answer                                         |
| --------------------------------------------- | ---------------------------------------------- |
| `/`                                           | the persona's page                             |
| `/<path>`, `/<folder>`, `/<folder>/<path>`    | the post, or the folder, as under `/@name/`    |
| `/feed.xml`, `/sitemap.xml`, `/robots.txt`    | this persona's own, in the domain's addresses  |
| `/api/...`, assets, `/ringtome/...`, the rest | passed through untouched (`webpath::RESERVED`) |
| a former path (WEB_ADDRESSES slice 4)         | a permanent redirect to the current one        |

A `Host` that matches nothing keeps today's behaviour.

The page heads (title, OpenGraph, `ringtome:post`) are the ones `/@name/<path>`
already draws, with the domain's addresses in them.

### 4. The canonical address: the domain, on every node

The canonical address becomes the shortest form that can be vouched for, in this
order:

1. **the verified domain** - `https://cube-drone.com/<path>`;
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
  so an apex domain needs Bunny DNS (which flattens the CNAME), or the apex
  redirecting to `www.`.

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
address), and what to do about an apex where the front allows only CNAMEs. The
page checks as the user goes and says which record is missing.

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

The case that started this. The order matters, because every link to the Hugo
site has to survive the switch:

1. **Import the posts** (in progress).
2. **Keep the old URLs as former paths.** The importer stores each post's Hugo
   URL (`/posts/<slug>/`, `/<year>/<month>/<slug>/`, whatever the site used) as
   a former path, so the domain router redirects it. This needs WEB_ADDRESSES
   slice 4, which isn't built, and former paths deeper than `<folder>/<path>`,
   which that slice doesn't yet anticipate. Hugo's feed (`/index.xml`) gets a
   former path to the persona's feed too, so existing subscribers follow along.
3. **Publish the TXT record and claim the domain** while Hugo is still serving.
   The ✓ and canonical addresses start working, with nothing changing for
   visitors.
4. **Add the domain to the Bunny pull zone** and have Bunny issue its
   certificate, with Forward Host Header and Vary Cache by hostname already on
   (section 6). Nothing points at it yet, so nothing changes for visitors.
5. **Point the domain at the pull zone.** `www.cube-drone.com` takes a CNAME;
   the apex needs Bunny DNS or a redirect to `www.` (section 6). The cutover is
   one DNS change, and reverting it is one more.

## Open questions

1. **One domain per persona, or several?** Proposed: one (plus its `www.`).
   Several means choosing which one is canonical.
2. **Do subdomains of the operator's domain**
   (`cube-drone.horsedrawingtycoon.com`) come free? They're cheap with a
   wildcard certificate and need no DNS from the user, but they belong to the
   node, like an @name, not to the persona: they don't travel. Proposed: later,
   if anyone asks.
3. **Custom domains on or off by default for operators?** Proposed: off. Serving
   them needs the front set up for them (section 6), and the operator takes on
   certificate issuance and whatever the domains serve.
4. **Is the apex worth supporting behind a CNAME-only front?** Proposed: the
   settings page explains the choices (move DNS to one that flattens, or
   redirect the apex to `www.`) rather than the node working around it.
5. **Does well-known proof earn the ✓?** Proposed: yes, for the badge and
   canonical addresses, but never for serving (section 2).
6. **Can a node that isn't serving the domain redirect to it?** Proposed: no;
   canonical only (section 4).

## Slices

0. **Former paths** - WEB_ADDRESSES slice 4, with former paths of any depth. A
   prerequisite for the Hugo move, and useful on its own.
1. **The claim and its proof** - the `domain` profile field, the TXT check and
   its memo, well-known for the badge, the ✓ on bylines. Useful with no node
   serving anything: it's the verified handle.
2. **Canonical everywhere** - the domain form first in `post_address` and
   `person_address`, on every node that has verified the claim.
3. **Serving** - the `Host` router, `RINGTOME_CUSTOM_DOMAINS` and
   `RINGTOME_DOMAINS_TARGET`, `GET /api/node/domains`, the @name-to-domain
   redirect, the settings page with its live DNS check, the per-domain feed and
   sitemap, and a SERVER.md section on serving custom domains (the front's two
   jobs: forward the Host header, keep the cache apart by hostname). Enough for
   cube-drone.com, with its certificate added by hand in Bunny.
4. **Certificates without an operator** - the Bunny adapter first, since it's
   the front horsedrawingtycoon.com runs; Caddy's `domain-ok` door and a certbot
   loop when an operator asks for one. Needed once other people add domains.
5. **Finding by domain** - the paste box, pinning, surfacing a change.
6. **The words in the HTML** - WEB_ADDRESSES slice 5, moved up: a blog on its
   own domain is exactly what search engines are asked to index, and today they
   see only the head.
7. _(Later)_ **WebFinger** at the domain, so `@cube-drone@cube-drone.com` works
   for ActivityPub (ACTIVITYPUB.md).
