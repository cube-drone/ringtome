# ringtome-supervisor

A small program that keeps a Ringtome server node **running**, **up to date**, and **backed up**, and
undoes an update that breaks it.

## What it is for

A server node (`ringtome`) changes with every release. Something has to restart it when it crashes,
install new releases, and take backups. And if an update goes wrong, something has to put the old
version back.

That last part is the hard one. A new release may migrate the node's databases forward, and nothing
migrates them back: an older binary refuses data a newer one has touched. So rolling back means
restoring the **binary and the data** together. Neither systemd nor Docker knows that.
`ringtome-supervisor` does.

It runs the node as a child process and:

- **restarts it** when it exits, waiting longer after each quick crash (1 second, doubling, up to a
  minute);
- **checks for releases** hourly, and installs one only if its sha256 **and** its signature against
  the release key built into the supervisor both check out;
- **backs up before every update**: live through the node's own backup endpoint, or by archiving
  the data directory with the node stopped if the node won't answer. No backup, no update;
- **holds the new version to a bar**: it must answer `/health` and then stay up and healthy for a
  minute;
- **rolls back** when it doesn't: the previous binary and the backup come back, and the failed
  version is never tried again. A newer release still is, since it may be the fix;
- **finishes interrupted updates**: an update is recorded before the new version starts, so a
  supervisor killed mid-update checks that version again on its next start.

It does **not** replace systemd. Run it under systemd (or anything like it) with `Restart=always`.
The supervisor looks after the node, and systemd looks after the supervisor.

It is for **plain Linux hosts**. If you deploy containers, use the image
(`ghcr.io/cube-drone/ringtome`) and let your container tooling handle updates. The image runs the
node directly, without the supervisor.

## Deploying a server with it

You need a Linux host with glibc 2.28 or newer (RHEL 8, Debian 10, Ubuntu 20.04 or later), x86_64
or aarch64. You also need an HTTPS proxy of your own in front of the node (Caddy, nginx, ...), since
browsers need a secure origin for much of what the app does. See the repository's
[SERVER.md](../SERVER.md) for the node itself.

**1. Download the newest release and check it.** The supervisor comes in the same tarball as the
node. `server-latest.json` always describes the newest release:

```sh
arch=x86_64   # or aarch64
url=$(curl -sL https://github.com/cube-drone/ringtome/releases/latest/download/server-latest.json \
  | jq -r ".platforms[\"linux-$arch\"].url")
curl -LO "$url" -LO "$url.sig"
tarball=$(basename "$url")

# The .sig is a minisign signature, base64-wrapped. This key is the one the supervisor trusts.
base64 -d "$tarball.sig" > tarball.minisig
minisign -V -P RWS8OTS+AgxV50ecE3P4OKhhLRQrosZc08PVRsF6mcQjK3wWIM9LzRgx -m "$tarball" -x tarball.minisig
```

**2. Install it.** The tarball holds `ringtome`, `ringtome-supervisor`, `SERVER.md` and
`LICENSE.md`. Keep the two binaries together: on its first start, the supervisor adopts the
`ringtome` beside it, so the node you just checked is the one that runs.

```sh
sudo useradd --system --home /var/lib/ringtome --create-home ringtome
sudo mkdir -p /opt/ringtome
sudo tar -xzf "$tarball" -C /opt/ringtome --strip-components=1
```

**3. Configure it.** Settings are environment variables (next section). An environment file keeps
them out of the unit:

```sh
# /etc/ringtome.env
RINGTOME_BIND_ADDRESS=0.0.0.0
RINGTOME_P2P_PORT=5282
RINGTOME_PUBLIC_URL=https://node.example.com
```

**4. Run it under systemd.**

```ini
# /etc/systemd/system/ringtome.service
[Unit]
Description=Ringtome server node
After=network-online.target
Wants=network-online.target

[Service]
User=ringtome
WorkingDirectory=/var/lib/ringtome
EnvironmentFile=/etc/ringtome.env
ExecStart=/opt/ringtome/ringtome-supervisor
Restart=always
# Longer than the node's own stop grace period (RINGTOME_STOP_GRACE_SECONDS, 30s).
TimeoutStopSec=45

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now ringtome
journalctl -u ringtome -f          # the supervisor's log and the node's, together
```

Open the HTTP port to your proxy, and the peer-to-peer port (`RINGTOME_P2P_PORT`, UDP) to the
world.

**Where things end up**, with the unit above:

| path | what |
|---|---|
| `/var/lib/ringtome/data/` | the node's data: databases **and the keys that identify the node**. Guard it like the server |
| `/var/lib/ringtome/ringtome-supervisor/versions/<version>/ringtome` | installed node versions: the current one and the one before it |
| `/var/lib/ringtome/ringtome-supervisor/state.json` | what is running (`current`), what ran before (`previous`), what failed and is skipped (`skipped`), and any update in flight (`pending`) |
| `/var/lib/ringtome/ringtome-supervisor/node.pid` | the running node's process id |
| `/var/lib/ringtome/ringtome-supervisor/backups/` | `backup_<UTC time>.tar.gz` archives. **They contain the node's keys**; anyone holding one holds the node |

To restore a backup by hand: stop the service, empty the data directory, unpack the archive into
it, and start the service.

## Configuration

Everything is an environment variable. The supervisor passes its whole environment to the node, so
configure the node exactly as you would without the supervisor (SERVER.md's *Settings* table). The
supervisor also reads three of the node's settings, to find it: `RINGTOME_DATA_DIRECTORY` (default
`./data`), `RINGTOME_BIND_ADDRESS` and `RINGTOME_PORT`.

Its own settings:

| variable | default | meaning |
|---|---|---|
| `RINGTOME_SUPERVISOR_DIRECTORY` | `./ringtome-supervisor` | installed node versions, `state.json`, `node.pid` |
| `RINGTOME_BACKUP_DIRECTORY` | `<supervisor directory>/backups` | where backups go, the node's and the supervisor's. Must be **outside** the data directory, because a restore replaces the data directory's contents; the supervisor refuses to start otherwise. Ideally on another disk |
| `RINGTOME_BACKUP_STRATEGY` | `on-update` | `on-update` backs up before each update. `hourly` and `nightly` (04:00 UTC) do that too, plus scheduled backups that never stop the node. `none` updates **without** a backup: a failed update then gets its old binary back but not its old data, and the old binary will refuse data the new one migrated |
| `RINGTOME_BACKUP_RETENTION` | `7` | how many `backup_*.tar.gz` to keep, newest first. This counts **every** archive in the backup directory, including ones you made by hand |
| `RINGTOME_AUTO_UPDATE` | `true` | `false` runs the installed node and never looks for another |
| `RINGTOME_UPDATE_CHECK_SECONDS` | `3600` | how often to check for a release |
| `RINGTOME_UPDATE_HEALTH_TIMEOUT_SECONDS` | `600` | how long a new version has to answer `/health`. Migrations run before it can, so this is generous |
| `RINGTOME_UPDATE_PROBATION_SECONDS` | `60` | how long it must then stay up and healthy before the update counts |
| `RINGTOME_STOP_GRACE_SECONDS` | `30` | how long the node gets to exit after SIGTERM before it is killed |
| `RINGTOME_UPDATE_MANIFEST_URL` | this repository's `server-latest.json` | where releases are described. For a fork that publishes its own |
| `RINGTOME_UPDATE_PUBLIC_KEY` | this repository's release key | the minisign public key releases must be signed with. For a fork that signs its own |
| `RINGTOME_SUPERVISOR_LOG` | `info` | the supervisor's log filter, in `tracing` syntax. The node's own is `RUST_LOG` |

This table is also in [SERVER.md](../SERVER.md), which ships in the tarball. Change both together.

## Keeping the supervisor itself up to date

**Where releases appear.** There are no separate supervisor releases. Every Ringtome release on
[GitHub](https://github.com/cube-drone/ringtome/releases) carries it inside the server tarballs
(`ringtome-server-<version>-<name>-linux-<arch>.tar.gz`), signed with the same key as the node.
Its version number moves in step with every release, even when its code has not changed.

**It does not update itself, on purpose.** It is the fixed point the rest of the system hangs from.
A supervisor that replaced itself would need something above it to roll *it* back, and that thing
would need one too. The chain stops at systemd, which your distribution keeps up to date.

**When to update it.** Rarely: when a release's notes say the supervisor changed, or when you want
a fix in it. To see whether it has changed between two releases:

```sh
git log --oneline v0.1.10-cape-jab..v0.1.11-<name> -- supervisor/
```

**How.** Download and check the newer tarball as in step 1, then swap the one file and restart:

```sh
sudo tar -xzf "$tarball" -C /opt/ringtome --strip-components=1 \
  "${tarball%.tar.gz}/ringtome-supervisor"
sudo systemctl restart ringtome
```

The restart stops the node for a few seconds. The node carries on at whatever version it was
running: the supervisor adopts the `ringtome` beside it only when nothing is installed yet, so
replacing the supervisor never moves the node backwards.

## Working on it

The supervisor follows the monorepo's conventions. Read these before changing it:

- [`STYLE.md`](../STYLE.md): naming, comments, module shape, and testing against the real thing;
- [`CLAUDE.md`](../CLAUDE.md) and [`AGENTS.md`](../AGENTS.md): working notes, and the rule that
  gates are green before anything moves forward;
- [`README.md`](../README.md): the map of the whole workspace.

A few rules belong to this crate alone:

- **It never depends on `ringtome-node`.** It outlives many node versions and must stay small. What
  the two share is a wire contract: `/health`, `POST /api/admin/backup` and its ticket, and
  `server-latest.json`, which `.github/workflows/release.yml` writes. Change one side of that
  contract and you change the other.
- **Its release key is the desktop updater's key.** `RELEASE_PUBLIC_KEY` in `src/config.rs` must match
  `desktop/tauri.conf.json`, and a unit test fails if they drift. See [`SIGNING.md`](../SIGNING.md).
- **Backup names are shared.** `src/stamp.rs` copies the node's `utc_stamp` so that retention can sort
  both kinds of archive together.

The modules, in the order an update touches them:

| file | what |
|---|---|
| `src/main.rs` | the composition root: read the settings, start logging, hand over |
| `src/config.rs` | the environment variables above |
| `src/supervise.rs` | the loop: restarts, update checks, scheduled backups, the update and rollback sequence |
| `src/manifest.rs` | `server-latest.json`, version comparison, and sha256 plus signature checks. No input or output |
| `src/install.rs` | downloading, installing versions, adopting the binary beside it, `state.json` |
| `src/backup.rs` | live and stopped backups, restore, retention |
| `src/node.rs` | the child process: start, health, stop |
| `src/stamp.rs` | UTC time stamps for file names |

**Testing:**

```sh
cargo test -p ringtome-supervisor                                # unit tests
cd node && RINGTOME_TEST_GREP=supervisor just integration        # the acceptance test
cd node && just ci                                               # the whole gate, before anything lands
```

The acceptance test, `node/integration/test/supervisor.cjs`, stands in for GitHub. It serves
releases signed the way the release job signs them, with the real node inside the good ones and a
deliberately broken one that damages the data and dies. It proves the first install, refusal of a
forged release, the full rollback, the next good update, and a clean stop.
