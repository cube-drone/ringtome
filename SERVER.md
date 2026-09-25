# Running a Ringtome server node

**Horse Drawing Tycoon 2** is the app people install; underneath, every copy runs a **Ringtome** node.
This page is for running one on a server instead - a node other people's apps and browsers can
reach, or one you keep online for yourself (see README's *Two names*).

Each release on GitHub carries two kinds of download, and it is worth knowing which is which:

| file | what it is |
|---|---|
| `Horse Drawing Tycoon 2_…` (`.dmg`, `.exe`, `.msi`, `.AppImage`, `.deb`, `.rpm`) | the **desktop app**: a window, a tray, updates itself |
| `ringtome-server-<version>-<name>-linux-<arch>.tar.gz` | the **server node**: one binary, no window, for a Linux host |

The server node also ships as a container image: `ghcr.io/cube-drone/ringtome:<version>` (and
`:latest`), for `linux/amd64` and `linux/arm64`.

## Checking what you downloaded

Every server tarball is signed with the same key that signs the desktop app's updates, and each
release carries `server-latest.json` - the version, and for each architecture the tarball's URL,
signature and sha256 - at a fixed address that always names the newest release:
`https://github.com/cube-drone/ringtome/releases/latest/download/server-latest.json`.

To check a tarball by hand with [minisign](https://jedisct1.github.io/minisign/): the `.sig` beside
it is the signature, base64-wrapped.

```sh
base64 -d ringtome-server-…-linux-x86_64.tar.gz.sig > tarball.minisig
minisign -V -P RWS8OTS+AgxV50ecE3P4OKhhLRQrosZc08PVRsF6mcQjK3wWIM9LzRgx \
  -m ringtome-server-…-linux-x86_64.tar.gz -x tarball.minisig
```

The container image is signed keylessly with [cosign](https://docs.sigstore.dev/): the signature
says it was built by this repository's release workflow at a release tag, with no key to trust but
GitHub's.

```sh
cosign verify ghcr.io/cube-drone/ringtome:<version> \
  --certificate-identity-regexp '^https://github.com/cube-drone/ringtome/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Which to use

**The container**, if you already deploy with Docker or anything that runs OCI images. **The
binary**, if you would rather run it under systemd directly: it needs nothing but a Linux with
glibc 2.28 or newer (RHEL 8, Debian 10, Ubuntu 20.04 and everything after), on x86_64 or aarch64.

## The container

```sh
docker run -d --name ringtome \
  -p 5281:5281/tcp -p 5282:5282/udp \
  -v ringtome-data:/data \
  -e RINGTOME_PUBLIC_URL=https://node.example.com \
  ghcr.io/cube-drone/ringtome:latest
```

The image is `distroless`, runs as a non-root user (uid 65532), and sets its defaults out loud
(see the table below): production mode, the public network, HTTP on 5281, peer-to-peer on 5282/udp,
data in `/data`.

## The binary

```sh
tar xzf ringtome-server-*-linux-x86_64.tar.gz
RINGTOME_BIND_ADDRESS=0.0.0.0 RINGTOME_DATA_DIRECTORY=/var/lib/ringtome \
  RINGTOME_P2P_PORT=5282 RINGTOME_PUBLIC_URL=https://node.example.com \
  ./ringtome
```

A release binary is a production node on the public network by default. Supervise it the way you
supervise anything else (a systemd unit, `Restart=always`).

## HTTPS is required - and it is yours

The node speaks plain HTTP. Put your own HTTPS proxy in front of it (Caddy, nginx, Traefik, your
platform's load balancer). This is not optional: browsers only allow notifications, service workers
and the rest of what the app needs on a secure origin, so a node served over plain HTTP from anywhere
but `localhost` quietly loses features. Set `RINGTOME_PUBLIC_URL` to the HTTPS address people use, so
the links the node mints point there.

## The peer-to-peer port

Nodes talk to each other over QUIC, which is UDP. Publish or open `RINGTOME_P2P_PORT` (the image uses
5282) so other nodes can connect directly. Without it the node still works - it reaches peers through
iroh's relays - but every connection takes the long way round. On a plain Linux host,
`--network host` for the container is the simplest way to get direct connections.

## The data directory is the node's identity

`RINGTOME_DATA_DIRECTORY` (`/data` in the image) holds the databases **and the keys that decrypt
them and identify the node**. Lose it and the node, and everyone's accounts on it, are gone; copy it
and you have copied the node. Back it up, and keep the backup as private as you keep the server.

## Backups

The node backs itself up without stopping. Ask it from the machine itself (or as a node
administrator):

```sh
curl -X POST http://127.0.0.1:5281/api/admin/backup           # -> 202 {"id": "20260925T183012Z", ...}
curl http://127.0.0.1:5281/api/admin/backup/20260925T183012Z  # 202 + the log while it runs; 200 when done
```

The result is `backup_<UTC time>.tar.gz` in `RINGTOME_BACKUP_DIRECTORY`. Each database is copied
under its own lock (a brief pause for that one database, never the node), the journals after them,
the blob store's metadata behind a moment's write pause, and the archive is renamed into place only
once it is whole. **It contains the keys** - `envelope.key` and the key files - so it restores on its
own, and anyone holding it holds the node. To restore: stop the node, unpack the archive into an
empty data directory, start the node.

A request that arrived through a proxy (an `X-Forwarded-For` header) is refused unless it carries a
node administrator's session. A proxy on the same machine that adds no such header would look like
the machine itself - but the endpoint only ever writes the archive to disk and reports its path, so
the most such a request can do is start a backup, never read one.

## Upgrading

An upgrade is a restart onto a newer binary or image: the node brings its databases forward
(migrations run on start), and that is the whole procedure. **There is no going back** - a node
refuses to open databases a newer version has already upgraded, since nothing migrates down. So take
a copy of the data directory before each upgrade; it is your rollback.

## Settings

Everything is an environment variable. The ones an operator is likely to want:

| variable | default | meaning |
|---|---|---|
| `RINGTOME_BIND_ADDRESS` | `127.0.0.1` (image: `0.0.0.0`) | the address HTTP listens on |
| `RINGTOME_PORT` | `5281` | the HTTP port |
| `RINGTOME_P2P_PORT` | chosen by the OS (image: `5282`) | the UDP port for peer-to-peer (QUIC) |
| `RINGTOME_DATA_DIRECTORY` | `./data` (image: `/data`) | databases and keys - see above |
| `RINGTOME_BACKUP_DIRECTORY` | `<data directory>/backups` | where backups are written (left out of the backups themselves) - ideally another disk |
| `RINGTOME_PUBLIC_URL` | unset | the HTTPS address people reach this node at |
| `RINGTOME_DISCOVERY` | `mainline` | `mainline` (the public DHT and relays), `off` (no discovery), or `local:<path>` (a private test network sharing a folder) |
| `RINGTOME_ENVIRONMENT` | `prod` | `prod`, or `dev` (serves the UI from the source tree - development only) |
| `RINGTOME_TENANCY` | `multi` | `multi` for a node that hosts other people; `single` for one person's own |
| `RINGTOME_NODE_NAME` | the hostname | what this node is called on your devices list |
| `RINGTOME_ADMIN_PERSONA_ID` | unset | the address of the persona that administers the node (the first account otherwise) |
| `RINGTOME_MAX_UPLOAD_BYTES` | 128 MiB (multi) / 1 GiB (single) | the largest raw upload the node will accept |
| `RINGTOME_QUARANTINE_DIRECTORY` | the system temp dir | where uploads wait for processing; disposable |
| `RUST_LOG` | `info` for the node | log filter, in the usual `tracing` syntax |

The rest (sync and admission budgets, proof-of-work prices) have defaults sized for a small hosted
node and are documented where they are read, in `node/src/config.rs`.
