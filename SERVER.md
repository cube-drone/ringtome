# Running a Ringtome server node

**Horse Drawing Tycoon 2** is the app people install; underneath, every copy
runs a **Ringtome** node. This page is for running one on a server instead - a
node other people's apps and browsers can reach, or one you keep online for
yourself (see README's _Two names_).

Each release on GitHub carries two kinds of download, and it is worth knowing
which is which:

| file                                                                             | what it is                                                                                                                                       |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Horse Drawing Tycoon 2_…` (`.dmg`, `.exe`, `.msi`, `.AppImage`, `.deb`, `.rpm`) | the **desktop app**: a window, a tray, updates itself                                                                                            |
| `ringtome-server-<version>-<name>-linux-<arch>.tar.gz`                           | the **server node** for a Linux host, no window: `ringtome` (the node) and `ringtome-supervisor` (which keeps it running, updated and backed up) |

The server node also ships as a container image:
`ghcr.io/cube-drone/ringtome:<version>` (and `:latest`), for `linux/amd64` and
`linux/arm64`.

## Checking what you downloaded

Every server tarball is signed with the same key that signs the desktop app's
updates, and each release carries `server-latest.json` - the version, and for
each architecture the tarball's URL, signature and sha256 - at a fixed address
that always names the newest release:
`https://github.com/cube-drone/ringtome/releases/latest/download/server-latest.json`.

To check a tarball by hand with
[minisign](https://jedisct1.github.io/minisign/): the `.sig` beside it is the
signature, base64-wrapped.

```sh
base64 -d ringtome-server-…-linux-x86_64.tar.gz.sig > tarball.minisig
minisign -V -P RWS8OTS+AgxV50ecE3P4OKhhLRQrosZc08PVRsF6mcQjK3wWIM9LzRgx \
  -m ringtome-server-…-linux-x86_64.tar.gz -x tarball.minisig
```

The container image is signed keylessly with
[cosign](https://docs.sigstore.dev/): the signature says it was built by this
repository's release workflow at a release tag, with no key to trust but
GitHub's.

```sh
cosign verify ghcr.io/cube-drone/ringtome:<version> \
  --certificate-identity-regexp '^https://github.com/cube-drone/ringtome/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Which to use

**The container**, if you already deploy with Docker or anything that runs OCI
images - updating it is your container tooling's job. **The supervisor**, if you
want a node that keeps itself up to date and backed up on a plain Linux host.
**The binary alone**, if you would rather do all of that yourself. The tarball
needs nothing but a Linux with glibc 2.28 or newer (RHEL 8, Debian 10, Ubuntu
20.04 and everything after), on x86_64 or aarch64.

## The container

```sh
docker run -d --name ringtome \
  -p 5281:5281/tcp -p 5282:5282/udp \
  -v ringtome-data:/data \
  -e RINGTOME_PUBLIC_URL=https://node.example.com \
  ghcr.io/cube-drone/ringtome:latest
```

The image is `distroless`, runs as a non-root user (uid 65532), and sets its
defaults out loud (see the table below): production mode, the public network,
HTTP on 5281, peer-to-peer on 5282/udp, data in `/data`.

## The binary

```sh
tar xzf ringtome-server-*-linux-x86_64.tar.gz
RINGTOME_BIND_ADDRESS=0.0.0.0 RINGTOME_DATA_DIRECTORY=/var/lib/ringtome \
  RINGTOME_P2P_PORT=5282 RINGTOME_PUBLIC_URL=https://node.example.com \
  ./ringtome
```

A release binary is a production node on the public network by default.
Supervise it the way you supervise anything else (a systemd unit,
`Restart=always`) - or let the supervisor do it.

## The supervisor

`ringtome-supervisor` is a small program that runs the node as its child and
does the three things a node on a server needs and systemd cannot know how to
do:

- **keeps it running**: restarts the node when it exits, waiting a little longer
  after each quick crash (up to a minute);
- **keeps it current**: checks `server-latest.json` hourly, and installs a newer
  release only after checking its sha256 **and** its signature against the
  release key built into the supervisor;
- **keeps it safe to update**: backs the node up before each update, starts the
  new version, and waits for it to answer `/health` and stay healthy for a
  minute. If it doesn't, the supervisor **rolls back** - the previous binary
  _and_ the backup, since nothing migrates down - and never tries that version
  again. A newer release is tried, since it may be the fix.

The backup before an update is taken live through the node's own backup
endpoint, so the node only stops for the swap; if the node won't answer, it is
stopped and its data directory archived directly. No backup, no update - unless
you turn backups off (below). A restore moves the data directory's contents
aside into `.rollback-<time>` first, and removes that once the restored node is
healthy.

The supervisor does not update itself. It is meant to change rarely; replace it
by hand from a newer tarball when a release says to.

```ini
# /etc/systemd/system/ringtome.service
[Unit]
Description=Ringtome server node
After=network-online.target
Wants=network-online.target

[Service]
User=ringtome
WorkingDirectory=/var/lib/ringtome
ExecStart=/opt/ringtome/ringtome-supervisor
Environment=RINGTOME_BIND_ADDRESS=0.0.0.0
Environment=RINGTOME_P2P_PORT=5282
Environment=RINGTOME_PUBLIC_URL=https://node.example.com
Restart=always
# Long enough for the node's own grace period (RINGTOME_STOP_GRACE_SECONDS).
TimeoutStopSec=45

[Install]
WantedBy=multi-user.target
```

With that unit, the node's data is `/var/lib/ringtome/data`, installed versions
and the state file are in `/var/lib/ringtome/ringtome-supervisor/`, and backups
go to `/var/lib/ringtome/ringtome-supervisor/backups/`. On first start the
supervisor adopts the `ringtome` it was unpacked beside, so the node you checked
is the one that runs; after that it downloads its own. Everything the node reads
from the environment is passed through, so configure the node here exactly as
you would without the supervisor. `state.json` says what is running, what ran
before, and what was skipped; `node.pid` holds the node's process id.

## HTTPS is required - and it is yours

The node speaks plain HTTP. Put your own HTTPS proxy in front of it (Caddy,
nginx, Traefik, your platform's load balancer). This is not optional: browsers
only allow notifications, service workers and the rest of what the app needs on
a secure origin, so a node served over plain HTTP from anywhere but `localhost`
quietly loses features. Set `RINGTOME_PUBLIC_URL` to the HTTPS address people
use, so the links the node mints point there - and so AI assistants can connect:
claude.ai, ChatGPT and the rest sign in through the node's OAuth, which names
this address as itself, and they refuse a plain-HTTP one.

Whatever you put in front, it owes the node four things:

- **The visitor's address in `X-Forwarded-For`.** Behind a proxy on the same
  machine, every request reaches the node from loopback, and the node treats a
  loopback request with no `X-Forwarded-For` as its operator, with no rate
  limits. A proxy that drops the header lifts the limits for everyone.
- **WebSockets.** Live rooms and the app's live updates are WebSocket
  connections, and they stay open for as long as the page does.
- **No upload limit of its own**, or one above `RINGTOME_MAX_UPLOAD_BYTES`. The
  node enforces its own.
- **The `Host` header the visitor asked for.**

If the proxy runs on the same machine, publish the node's HTTP port to loopback
only (`-p 127.0.0.1:5281:5281/tcp` for the container, or the default
`RINGTOME_BIND_ADDRESS` for the binary), so nobody reaches it around the proxy
over plain HTTP.

### On a server of your own: Caddy

The shortest way there. Caddy gets a Let's Encrypt certificate for every name in
its configuration, renews it and redirects plain HTTP, and it does all four of
the above by default. Point the name's DNS at the server, open ports 80 and 443,
install Caddy from your distribution, and make `/etc/caddy/Caddyfile`:

```
node.example.com {
	reverse_proxy 127.0.0.1:5281
}
```

Then `systemctl reload caddy`. The first visit may take a few seconds while the
certificate is issued.

### On a server of your own: nginx and certbot

nginx needs WebSockets, the upload limit and the forwarded address spelled out:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name node.example.com;

    client_max_body_size 0;   # the node enforces its own limit
    proxy_read_timeout 1h;    # live rooms and live updates stay open

    location / {
        proxy_pass http://127.0.0.1:5281;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}
```

Then `certbot --nginx -d node.example.com`, which adds the certificate, the port
443 listener and the redirect to this block. certbot's timer renews it.

### Behind a CDN

A CDN (BunnyCDN, Cloudflare and the like) can hold the certificate instead, and
reach the node over plain HTTP. Then:

- turn on its WebSocket support, if it's a switch;
- have it **respect the node's `Cache-Control`**, and nothing more. Every answer
  says who may keep it: what is the same for everyone (a stranger's view of a
  shelf, the front page, published pages, media, the app's own files) says
  `public` with an `s-maxage`; what was answered for a signed-in reader says
  `private`; an answer that sets a cookie says `no-store`; `/health` says
  `no-store`, and anything else says `no-cache`. Don't vary on cookies, and
  don't override the node's lifetimes;
- **put the whole query string in the cache key** (BunnyCDN: Vary Cache → URL
  Query String, with no list of parameters). Filters and "load more" pages are
  query parameters: a CDN that ignores them answers every page with the first;
- set `RINGTOME_PUBLIC_URL` to the CDN's address, not the origin's;
- keep the origin from being reached except through the CDN where you can (a
  firewall allowing only the CDN's addresses), since anyone reaching it directly
  does so over plain HTTP.

### People's own domains

For now, only a persona belonging to one of your node's administrators
(`node_admin`) can claim a domain of its own (`cube-drone.com`) in its profile
settings and prove it with a DNS TXT record; once it's proved, the node serves
the domain as that persona's website: their page at `/`, their posts at their
paths, their feed at `/feed.xml`. It's a reading site: no one signs in on it,
and it sets no cookie. Custom domains are on unless you set
`RINGTOME_CUSTOM_DOMAINS=off`, and cost nothing until a domain points at you.

The node knows which domains it serves; getting each one to it, with a
certificate, is the front's job:

- **forward the `Host` header** the reader asked for. A front that sends every
  request on under the origin's name (BunnyCDN: Forward Host Header, off by
  default) leaves the node unable to tell `cube-drone.com` from your own
  address;
- **send the domain to the node at your origin too**. A web server in front of
  the node picks a site by that same `Host` header, so add the domain to the
  node's `server_name` (nginx) or site address (Caddy). Retire whatever that
  server answered for it before, such as an old blog's site block or an
  HTTP-to-HTTPS redirect, which loops behind a CDN that pulls over plain HTTP;
- **keep the cache apart by hostname** (BunnyCDN: Vary Cache → Requested
  Hostname), or `cube-drone.com/` can be answered from your own front page's
  cached copy;
- **add the domain and its certificate**. Behind BunnyCDN, add the hostname to
  the pull zone and press its free certificate; Caddy and certbot need the
  domain named as well. `GET /api/node/domains` lists the domains the node
  serves now.

Set `RINGTOME_DOMAINS_TARGET` to the hostname people should point their domain
at - behind BunnyCDN, the pull zone's `*.b-cdn.net` name - and the settings page
shows them the CNAME record to make. A bare domain (`cube-drone.com`, not
`www.cube-drone.com`) needs a DNS provider that flattens CNAMEs; Bunny DNS does.

The node asks DNS afresh on every check, but your server's own resolver may
remember a "no such record" from before the TXT record was added, for as long as
the zone's negative TTL (a day, on Bunny DNS). If "check now" keeps finding no
record that `dig TXT _ringtome.<domain> @1.1.1.1` shows, run the same `dig`
without `@1.1.1.1` on the server; if that comes back empty, clear the resolver's
cache (`resolvectl flush-caches` under systemd-resolved).

A domain becomes the persona's address everywhere - the address search engines
are given and "copy link" hands out, on every node - once the node's
`/.well-known/ringtome` answers there, which each node checks about daily.

## The peer-to-peer port

Nodes talk to each other over QUIC, which is UDP. Publish or open
`RINGTOME_P2P_PORT` (the image uses 5282) so other nodes can connect directly.
Without it the node still works - it reaches peers through iroh's relays - but
every connection takes the long way round. On a plain Linux host,
`--network host` for the container is the simplest way to get direct
connections.

## The data directory is the node's identity

`RINGTOME_DATA_DIRECTORY` (`/data` in the image) holds the databases **and the
keys that decrypt them and identify the node**. Lose it and the node, and
everyone's accounts on it, are gone; copy it and you have copied the node. Back
it up, and keep the backup as private as you keep the server.

## The Server app

An account holding `node_admin` - the first account made on a server - sees a
**Server** app among its apps. It has two pages:

- **Registration**: who may make an account here. `open` (anyone who reaches the
  node, rate-limited per address - a fresh server's default), `password`
  (sign-up asks for a password you choose and share by hand), or `closed`. Below
  it, on the same page:
  - **Limits** - the most accounts this node holds, and a disk-use percentage
    (of the disk under the data directory) past which it takes no more sign-ups.
    Each is empty for no limit; the page shows where the node stands against
    both.
  - **Group** - a name, for a group server: while sign-ups take a password,
    whoever signs up with it joins the group. Their first persona, every other
    member, and every node administrator begin knowing each other - low trust
    and low interest, both ways, published like any dial - tagged with the
    group's name in each other's People list. Accounts that were here before are
    not added, and nothing is written to anyone except when somebody joins:
    renaming or clearing the group changes no one's settings.
  - **Starter Friends** - people every persona made here starts out knowing,
    with the dials you choose (low trust, medium interest, low shares unless you
    say otherwise), beside the app's own starters. Paste a page's link or an
    address. Taking somebody off the list changes nobody who already began with
    them.
- **Backups**: make a backup and watch it go, and download the ones already made
  (below). Restoring is not in the app yet.

## Backups

The node backs itself up without stopping. Ask it from the Server app, from the
machine itself, or as a node administrator:

```sh
curl -X POST http://127.0.0.1:5281/api/admin/backup           # -> 202 {"id": "20260925T183012Z", ...}
curl http://127.0.0.1:5281/api/admin/backup/20260925T183012Z  # 202 + the log while it runs; 200 when done
```

The result is `backup_<UTC time>.tar.gz` in `RINGTOME_BACKUP_DIRECTORY`. Each
database is copied under its own lock (a brief pause for that one database,
never the node), the journals after them, the blob store's metadata behind a
moment's write pause, and the archive is renamed into place only once it is
whole. **It contains the keys** - `envelope.key` and the key files - so it
restores on its own, and anyone holding it holds the node. To restore: stop the
node, unpack the archive into an empty data directory, start the node.

A request that arrived through a proxy (an `X-Forwarded-For` header) is refused
unless it carries a node administrator's session. A proxy on the same machine
that adds no such header would look like the machine itself - but the endpoint
only ever writes the archive to disk and reports its path, so the most such a
request can do is start a backup, never read one. Reading one back - the list,
and the download in the Server app (`GET /api/admin/backups`,
`GET /api/admin/backups/<name>`) - takes a node administrator's session, never
the machine alone.

## Upgrading

Under the supervisor, upgrading is automatic (above). Otherwise, an upgrade is a
restart onto a newer binary or image: the node brings its databases forward
(migrations run on start), and that is the whole procedure. **There is no going
back** - a node refuses to open databases a newer version has already upgraded,
since nothing migrates down. So take a backup before each upgrade; it is your
rollback.

## How much computer

One CPU runs a small group that posts words and pictures. Encoding is the heavy
work: every upload is re-encoded on the server, and a video takes every thread
it is given for as long as it takes. So the node gives encoding one thread fewer
than the machine has, and encodes one upload at a time; on two or more CPUs that
leaves a CPU free for everything else, and people can keep using the site while
somebody's video encodes. On one CPU there is nothing spare: the site slows
while a video encodes. If people will upload video, use two CPUs or more.
`RINGTOME_MEDIA_THREADS` changes how many threads encode.

Memory: the node keeps what it reads often in RAM - each persona's notebook
index, public pages and pictures - within a budget it sizes to the machine. On a
server that is a quarter of the memory, leaving at least a gigabyte for
everything else (the databases' own caches, encoding, the operating system's
file cache); inside a container or a systemd unit with `MemoryMax=`, that limit
counts as the machine. The node says its budget once at start
(`cache budget 4.0 GB (server, 16.0 GB memory)`), and drops its caches when the
machine runs short (under a tenth of memory free). `RINGTOME_CACHE_MEMORY`
changes it.

## Settings

Everything is an environment variable. The ones an operator is likely to want:

| variable                        | default                          | meaning                                                                                                                                                                                                                                                                  |
| ------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RINGTOME_BIND_ADDRESS`         | `127.0.0.1` (image: `0.0.0.0`)   | the address HTTP listens on                                                                                                                                                                                                                                              |
| `RINGTOME_PORT`                 | `5281`                           | the HTTP port                                                                                                                                                                                                                                                            |
| `RINGTOME_P2P_PORT`             | chosen by the OS (image: `5282`) | the UDP port for peer-to-peer (QUIC)                                                                                                                                                                                                                                     |
| `RINGTOME_DATA_DIRECTORY`       | `./data` (image: `/data`)        | databases and keys - see above                                                                                                                                                                                                                                           |
| `RINGTOME_BACKUP_DIRECTORY`     | `<data directory>/backups`       | where backups are written (left out of the backups themselves) - ideally another disk                                                                                                                                                                                    |
| `RINGTOME_PUBLIC_URL`           | unset                            | the HTTPS address people reach this node at                                                                                                                                                                                                                              |
| `RINGTOME_DISCOVERY`            | `mainline`                       | `mainline` (the public DHT and relays), `off` (no discovery), or `local:<path>` (a private test network sharing a folder)                                                                                                                                                |
| `RINGTOME_ENVIRONMENT`          | `prod`                           | `prod`, or `dev` (serves the UI from the source tree - development only)                                                                                                                                                                                                 |
| `RINGTOME_TENANCY`              | `multi`                          | `multi` for a node that hosts other people; `single` for one person's own                                                                                                                                                                                                |
| `RINGTOME_NODE_NAME`            | the hostname                     | what this node is called on your devices list                                                                                                                                                                                                                            |
| `RINGTOME_ADMIN_PERSONA_ID`     | unset                            | the address of the persona that administers the node (the first account otherwise)                                                                                                                                                                                       |
| `RINGTOME_MAX_UPLOAD_BYTES`     | 128 MiB (multi) / 1 GiB (single) | the largest raw upload the node will accept                                                                                                                                                                                                                              |
| `RINGTOME_QUARANTINE_DIRECTORY` | the system temp dir              | where uploads wait for processing; disposable                                                                                                                                                                                                                            |
| `RINGTOME_MEDIA_THREADS`        | the CPUs, less one (at least 1)  | how many threads encode pictures, sound and video - see _How much computer_                                                                                                                                                                                              |
| `RINGTOME_CACHE_MEMORY`         | a quarter of memory              | how much the node's caches may hold: a size (`2GB`, `512MB`), a share (`40%`), or `0` for none - see _How much computer_                                                                                                                                                 |
| `RINGTOME_SERVE_CROWD`          | `true`                           | `false` stops this node answering other nodes about the personas its people follow (its own devices and those personas' own nodes aside), offering itself as a place to fetch them, and naming those places when it turns a connection away as busy - for a metered link |
| `RINGTOME_CUSTOM_DOMAINS`       | `on`                             | `off` stops this node serving the domains its personas claim - see _People's own domains_                                                                                                                                                                                |
| `RINGTOME_DOMAINS_TARGET`       | the public URL's host            | the hostname people point their own domain at (a CDN pull zone's name), shown to them as a CNAME record                                                                                                                                                                  |
| `RUST_LOG`                      | node and requests at `debug`     | log filter, `tracing` syntax; `ringtome_node=info` is quieter                                                                                                                                                                                                            |

The rest (sync and admission budgets, proof-of-work prices) have defaults sized
for a small hosted node and are documented where they are read, in
`node/src/config.rs`.

The supervisor reads these as well (and `RINGTOME_DATA_DIRECTORY`,
`RINGTOME_BIND_ADDRESS` and `RINGTOME_PORT` above, to find the node):

| variable                                 | default                                | meaning                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RINGTOME_SUPERVISOR_DIRECTORY`          | `./ringtome-supervisor`                | installed node versions, `state.json`, `node.pid`                                                                                                                                                                                                                                   |
| `RINGTOME_BACKUP_DIRECTORY`              | `<supervisor directory>/backups`       | as above; under the supervisor it must be **outside** the data directory, since a restore replaces the data directory's contents                                                                                                                                                    |
| `RINGTOME_BACKUP_STRATEGY`               | `on-update`                            | `on-update` (before each update), `hourly`, `nightly` (04:00 UTC) - the last two also back up before updates - or `none`, which updates without a backup: a failed update then rolls back the binary but not the data, and the older binary will refuse data the newer one migrated |
| `RINGTOME_BACKUP_RETENTION`              | `7`                                    | how many `backup_*.tar.gz` to keep, newest first - including ones you made by hand                                                                                                                                                                                                  |
| `RINGTOME_AUTO_UPDATE`                   | `true`                                 | `false` runs the installed node and never looks for another                                                                                                                                                                                                                         |
| `RINGTOME_UPDATE_CHECK_SECONDS`          | `3600`                                 | how often to look for a release                                                                                                                                                                                                                                                     |
| `RINGTOME_UPDATE_HEALTH_TIMEOUT_SECONDS` | `600`                                  | how long a new version has to answer `/health` (migrations run first)                                                                                                                                                                                                               |
| `RINGTOME_UPDATE_PROBATION_SECONDS`      | `60`                                   | how long it must then stay up and healthy                                                                                                                                                                                                                                           |
| `RINGTOME_STOP_GRACE_SECONDS`            | `30`                                   | how long the node gets to exit after SIGTERM                                                                                                                                                                                                                                        |
| `RINGTOME_UPDATE_MANIFEST_URL`           | this repository's `server-latest.json` | where releases are described - for a fork's own releases                                                                                                                                                                                                                            |
| `RINGTOME_UPDATE_PUBLIC_KEY`             | this repository's release key          | the minisign public key releases must be signed with - for a fork's own releases                                                                                                                                                                                                    |
| `RINGTOME_SUPERVISOR_LOG`                | `info`                                 | the supervisor's own log filter                                                                                                                                                                                                                                                     |
