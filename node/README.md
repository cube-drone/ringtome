# ringtome-node

The connector node: an always-on(ish) Rust server that joins the p2p network, agents identities
on behalf of its users, stores their signed chains, and serves the web client (eventually). One
binary; hosted-multi-tenant vs. personal-desktop is configuration, not a fork.

## Running

```sh
cargo run --bin ringtome                 # dev defaults: 127.0.0.1:5281, ./data, discovery off
RINGTOME_PORT=8080 cargo run --bin ringtome
./target/debug/ringtome inspect <hex-or-file>   # decode + verify any signed entry, then exit
```

## Environment variables

| variable | default | meaning |
|---|---|---|
| `RINGTOME_PORT` | `5281` | HTTP listen port. |
| `RINGTOME_BIND_ADDRESS` | `127.0.0.1` | HTTP bind address. Hosted nodes set `0.0.0.0`; desktop mode stays loopback. |
| `RINGTOME_DATA_DIRECTORY` | `./data` | Where everything lives (see layout below). |
| `RINGTOME_ENVIRONMENT` | `dev` | `dev` or `prod`. Currently affects log formatting (ANSI in dev). |
| `RINGTOME_TENANCY` | `multi` | `multi` (hosted: many accounts behind logins) or `single` (personal desktop: the OS user is the tenant). |
| `RINGTOME_DISCOVERY` | *(off)* | `off`, `local:<path>` (shared-folder DHT simulation, for tests/LAN), or `mainline` (real DHT + iroh relays via the `N0` preset). Also selects the iroh preset. |
| `RINGTOME_ENVELOPE_KEY` | *(generated)* | 64 hex chars (32 bytes). Envelope key for private keys at rest. If unset, generated on first boot and persisted to `data/envelope.key` (0600). Set it explicitly for anything you'd restore from backup. |
| `RINGTOME_LOCAL_TEST` | *(off)* | **DANGEROUS.** `1`/`true` arms local-integration-test mode: raw SQL passthrough over HTTP, rate limiting off, no first-account admin bootstrap, minimal-parameter (weak, fast) Argon2, `/rebuild` exposed. Never on a reachable node. |

## Data directory layout

```
data/
├── node.db            # node-level state: accounts, sessions, identities, peers
├── envelope.key       # the at-rest encryption key (unless RINGTOME_ENVELOPE_KEY is set)
├── keys/              # envelope-encrypted private keys, one file per key
│   ├── <pubkey>.key   #   identity root/leaf keys
│   └── node_iroh.key  #   the node's iroh transport key
└── users/
    └── <root>.db      # per-identity DB: the entries log (source of truth) + materialized views
```

Everything in `users/*.db` outside the `entries` table is a disposable projection, rebuildable by
replaying the log. `node.db` and the key files are the only things that aren't.

## Testing

```sh
cargo test                    # unit tests (workspace)
just test-unit                # same, via the justfile
just integration              # build, boot TWO throwaway nodes + a shared local-DHT dir,
                              # run the mocha suite in node/integration/, tear down
just ci                       # check + clippy + unit + integration
```

The integration suite talks to real nodes over real HTTP (and real iroh QUIC for the two-node
sync tests). Two-node tests skip themselves if `RINGTOME_TEST_HOST_B` is absent.

## HTTP surface (unstable, pre-4C)

Auth (`/api/auth/*`: register, login, logout, whoami, check-username), tags (`/api/admin/*`),
identities (`/api/identity` and `/api/identity/{root}/…`: profile, keys, entries, sync, serve,
nodes, revoke, adoption), node info (`/api/node`), health (`/health`). The routes files
(`src/auth/routes.rs`, `src/identity/routes.rs`) are the reference until the API stabilizes
enough to deserve a document.
