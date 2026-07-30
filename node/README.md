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
| `RINGTOME_SYNC_DEBOUNCE_MS` | `3000` | Eager push: how long a changed identity sits quiet before its peers get an unprompted exchange (change detection ticks every ~2s, so the write-to-peer floor is ~tick + debounce + tick). |
| `RINGTOME_RESYNC_INTERVAL_SECS` | `300` | Anti-entropy cadence: every interval, each identity with peers exchanges with up to 3 random peers, dirty or not. The immediate first pass is the boot catch-up. |

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

**Migration policy:** until a database exists that can't be casually deleted (first testnode, a
friend's node, your daily driver), schema changes squash into `0001` and dev data dirs get
deleted (`rm -rf ./data`). The moment any deployment matters, migrations freeze and become
append-only forever.

## Testing

```sh
cargo test                    # unit tests (workspace)
just test-unit                # same, via the justfile
just integration              # build, boot TWO throwaway nodes + a shared local-DHT dir,
                              # run the mocha suite in node/integration/, tear down
just ui-check                 # rebuild the JS/CSS bundles (esbuild is the UI's only
                              # type-check, and ui.rs embeds its output) + the UI's
                              # pure-module tests: no browser, no node, ~1s
just ci                       # ui-check + check + clippy + unit + integration
just mainline-smoke           # the mainline field test: two nodes on the REAL public DHT +
                              # n0 relays/DNS (networked, on-demand only; also runs as the
                              # dispatch-only "Mainline smoke" GitHub action)
```

The integration suite talks to real nodes over real HTTP (and real iroh QUIC for the two-node
sync tests). Two-node tests skip themselves if `RINGTOME_TEST_HOST_B` is absent.

## Code conventions

**Data access:** cross-module reads/writes go through the owning module's public functions; raw
SQL naming a table lives only in that table's owner (enforced by `tests/conventions.rs` - the
architecture cop). The `entries` table is protocol law: rows appear only via `imaol::append`
(local authorship) or the sync gate (validated arrival).

**UI layout (`js/`):** the same shape as `src/` - flat modules, with a directory only where one
concept outgrew one file, so `x.js` + a sibling `x/` reads the way `net.rs` + `net/` does. The
nested three are `mirror.js` + `mirror/` (the Dexie mirror: the stream and handle, plus `prefs`
and `doccache`), `doc/` (the document machinery every document app composes: session, editor,
tree, slugs, annotations, upload, completions, turbolinks, livemarquee), and `apps.js` + `apps/`
(the registry beside its apps - notes, journal, wiki). Everything else stays flat: `index.js` is
the composition root, `net.js` is the only HTTP client, and `lookout.js`/`keepalive.js`/`docdate.js`
are the pure core - no imports, no browser, unit-tested from `integration/test/*.cjs` without a
node. No barrel files: a directory re-exports nothing, so you import the file you want. **An app
is one file until it needs two**, then it becomes `apps/journal.js` + `apps/journal/`.

## HTTP surface (unstable, pre-4C)

Auth (`/api/auth/*`: register, login, logout, whoami, check-username), tags (`/api/admin/*`),
identities (`/api/identity` and `/api/identity/{root}/…`: profile, keys, entries, sync, serve,
nodes, revoke, adoption), node info (`/api/node`), health (`/health`). The routes files
(`src/auth/routes.rs`, `src/identity/routes.rs`) are the reference until the API stabilizes
enough to deserve a document.
