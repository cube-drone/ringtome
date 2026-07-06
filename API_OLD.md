# api_old — Autopsy and Salvage Report

`api_old/` is the prior-generation codebase: **Groovelet**, a multi-tenant community platform
(Rust + Axum + SQLite + a Preact frontend, ~9,300 lines of Rust). PROJECT_PLAN.md designates it a
"reference and pattern library" for the new `node/` crate. This document is the inventory: what it
got right, what it got wrong, and which lessons are load-bearing for Ringtome. It is organized as
**keep** (patterns to carry forward), **cut** (patterns to deliberately avoid), and **cautionary
tales** (bugs and structural traps worth remembering when building the same feature the second
time).

A theme runs through the whole assessment: api_old was a *centralized multi-tenant* system, and its
worst patterns are all workarounds for problems that Ringtome's architecture dissolves outright
(the event bus vs. the IM-AOL, denormalized sessions vs. thin sessions, the super-admin community
vs. per-node admin tags). The good patterns are mostly *infrastructure discipline* — and most of
those have already been ported into `node/`.

---

## Keep

### 1. Per-tenant SQLite databases (`community_database.rs`) — already ported

The strongest architectural idea in the old codebase: each community got its own SQLite file with
its own tables, opened on demand, with a cap on simultaneously-open handles. This is the direct
ancestor of the new per-identity `users/<root-pubkey>.db` design, and the new `db::UserDbManager`
is a strictly better implementation (moka LRU instead of random eviction — see Cut #9 — and real
migrations instead of `CREATE TABLE IF NOT EXISTS`). The isolation/disposability/sync-granularity
rationale in PROJECT_PLAN.md is this pattern, matured.

Also keep the PRAGMA discipline that came with it: `journal_mode = WAL`,
`synchronous = normal` on every pool. Already in `node/src/db.rs`.

### 2. Typed auth extractors (`session/extractors.rs`) — partially ported

Authorization levels encoded as Axum extractor *types*: `SessionExtractor`,
`UnverifiedSessionExtractor`, `AdminSessionExtractor`. A handler's signature declares its
authorization requirement, and it is impossible to forget an auth check because the check *is* the
argument. The new `auth::Session` extractor carries this forward; as the identity layer grows,
extend the family the same way (e.g. an extractor that resolves session → account → *unlocked
identity*, or `NodeAdmin`-tag-gated extractors for the admin routes, which currently check tags
inside handlers).

One refinement over the old version: api_old needed a third "unverified" tier because email/phone
verification gated everything; Ringtome has no such gate, so resist adding tiers until a real flow
demands one.

### 3. `RequestContext` extractor with correlation IDs — already ported

Per-request context (remote IP, X-Forwarded-For, user agent, fingerprint, fresh correlation ID)
assembled in one extractor, recorded onto the tracing span so every log line for a request is
greppable by `c_id`. Cheap, boring, extremely useful in production. `node/src/request_context.rs`
is a near-verbatim port; keep it wired into everything that logs or rate-limits.

### 4. Tags as the role/capability primitive — already ported

Free-form string tags on users (`admin`, `owner`, `locked`, `email_verified`) instead of enum
columns or role tables. Flexible, queryable, trivially extensible, and the new
`account_tags` table with `node_admin`/`admin` is the same idea. Two lessons from watching it age
in api_old:

- **Good:** locking a user is `add_tag("locked")`; a new privilege level costs zero migrations.
- **Watch out:** api_old drifted into tag soup — `has_password`, `has_email`, `has_phone`,
  `prospective_email` (a column!), `email_verified` — using tags to model a *state machine*
  (unverified → verified) rather than a *capability*. State that has invariants deserves columns
  and real transitions; tags are for flat, independent booleans. The new code's two admin tags are
  on the right side of this line.

### 5. The audit log (`audit.rs`)

The best module in the old codebase, worth re-implementing almost wholesale when the node needs an
audit trail:

- Every audit row carries the full request context: user, triggering admin, IP, forwarded-for,
  user-agent, fingerprint, correlation ID, plus the entire serialized event as JSON.
- Indexed on every column you'd actually hunt by during an incident (user, IP, fingerprint,
  forwarded_for, action, time).
- **Bounded by design:** a per-community cap (`audit_max_logs`, default 5000) enforced by
  probabilistic pruning — each write has a ~2% chance of triggering the prune query. No cron, no
  unbounded table, no per-write pruning cost. This trick is worth keeping verbatim.
- The `should_audit()` filter distinguishing audit-worthy events from noise (heartbeats, message
  traffic).

For Ringtome, note the layering: this is *node-local operational* audit (logins, grants, lock-outs
on this node) — a different animal from the IM-AOL, which is the *user's* signed history. Both will
exist; don't conflate them.

### 6. Fixed-window rate limiting over a bounded cache (`rate_limiting.rs`) — already ported

Key = `identifier : window-size : bucket-index`, value = atomic counter, all inside a moka cache so
old buckets evaporate on their own — a rate limiter with no cleanup job and bounded memory. The
`ctx_limit_per_minute(key, &request_context, limit)` convenience shape (namespace + caller identity
+ limit at the call site) is the right ergonomics. `node/src/rate_limit.rs` carries this forward.

### 7. Version-stamped static assets (`/static/{version}/app.js` + `semver.rs`)

Assets served under a URL containing the app version, so they can be cached forever; the server
refuses to serve a version *greater* than the running one, so a cache can never be poisoned with a
"future" version that would then mask a real deploy. Plus the dev/prod split: `include_str!` baked
bundles in prod, reload-from-disk in dev. Small, clever, and directly reusable when the node grows
its web UI. `semver_to_comparable_integer` (bit-packing major/minor/patch into a u128) comes along
with it, tests included.

### 8. Invite codes and invite chains (`user.rs`)

The mechanics are ordinary (UUID codes, once/unlimited use types), but the `invite_chain` table —
persistently recording *who invited whom* — is a proto-trust-graph and philosophically the most
Ringtome-shaped thing in the old codebase. Admission-by-invitation is exactly the "trust gates who
gets an account on a node" policy in PROJECT_PLAN.md's rehosting section, and the chain is the seed
of a vouch edge. When node registration policy gets built, start here.

### 9. The live-update model (`live.rs`)

The *protocol* is worth keeping even though the implementation will be replaced by iroh-gossip:
clients are notified only that a **system is dirty** ("messages changed — refetch"), never handed
the data itself. Consequences that made it robust:

- Multiple changes to one system collapse into one notification (it's a `HashSet`).
- Connections are ephemeral and in-memory; a server restart just means clients reconnect. No
  persistence, no replay, no delivery guarantees to get wrong — the source of truth is always the
  fetchable state, not the notification.
- WebSocket with polling fallback against the same connection state.

This maps one-to-one onto the plan's use of iroh-gossip ("signaling that a sync is needed" — gossip
is ephemeral, sync is the truth). Same design instinct, keep it.

### 10. Internal vs. external representations (`user/view.rs`)

`User` (internal, has `password_hash`) is a different type from `ApiUser` (what the API returns),
with an explicit `From` conversion and an `anonymize()` step (email → SHA-256 hash) for
lower-privilege viewers. Serializing internal structs directly to JSON is how password hashes leak;
a typed boundary makes that a compile-time question. Keep the pattern; the identity layer (public
profile vs. private chain data vs. node-local account data) will need it even more.

The broader service/view split (service = storage + invariants, view = cross-service orchestration
+ API shaping) is a reasonable seam too, though the new codebase's `module.rs` + `module/routes.rs`
split covers the same need with less machinery so far.

### 11. TTL for unverified resources (`community.rs`)

Unverified communities with no interaction for 7 days were automatically deleted. Generalized:
**anything created cheaply by strangers should expire unless it earns persistence.** Directly
applicable to node registration policy (unverified accounts, stale sessions, abandoned identities
on multi-tenant nodes) and cheap anti-abuse for anything invite-adjacent.

### 12. Integration tests over the real HTTP surface — already ported

Mocha + fetch (with cookie jars, WebSocket clients) driven against a real running server, plus
dev-only `/test/*` routes to make tests writable. The new `node/integration/` suite with the
local-test-mode SQL passthrough is this pattern, hardened (the passthrough 404s outside
`RINGTOME_LOCAL_TEST`). Keep investing here; it's the test style that actually catches wiring bugs.

### 13. The commented-config style — already ported

`app_config.rs`: env-var-driven flat config struct where every field has an inline comment stating
its purpose and default, `PublicConfig` as an explicit safe-to-serve subset. `node/src/config.rs`
carries it forward including the `public()` projection. (One nit the old version got wrong: it
leaked `data_directory` into `PublicConfig` — server filesystem paths are not public information.
Worth double-checking the new projection stays clean as fields accrue.)

---

## Cut

### 1. The event bus (`event.rs` + the dispatch loops)

The heart of the old architecture, and the single biggest thing to leave behind. Every action sent
an `EventEnvelope` down one `mpsc::channel(1000)`; one background task received them and manually
called `on_event` on a hand-maintained list of services; `community_database.rs` then manually
fanned out to *its* hand-maintained list of sub-services. Why it doesn't survive contact:

- **Hand-maintained dispatch, twice.** Adding a listener means editing dispatch lists in `main.rs`
  and/or `community_database.rs`. The comment in `community_database.rs` admits it: async traits
  couldn't be trait objects, so "it's simpler to just maintain the list here." The decoupling an
  event bus promises never materialized — coupling just moved into lists.
- **Four parallel hand-written match tables** in `event.rs` (`event_type`, `event_description`,
  `event_system`, `should_audit`) over a 40-variant enum. Every new event = five edits. This is
  metadata that wants to live in one place.
- **Correctness by eventual side effect.** Security-relevant invariants — "a deleted user's
  sessions die," "an un-admined user loses admin" — were enforced by *asynchronous listeners* on a
  bounded fire-and-forget channel. A full channel, a dropped event, or a crash between action and
  dispatch silently breaks the invariant. Session revocation should be a synchronous part of the
  action, not a hoped-for echo.
- **In Ringtome the IM-AOL is the event log.** Signed chain entries are the durable record of what
  happened; a second, in-memory, unsigned event stream duplicating it is a bug factory. The two
  legitimate residues of the bus are (a) UI dirty-notifications — that's iroh-gossip / the live
  model in Keep #9 — and (b) the audit trail, which can be written synchronously where actions
  happen.

If a cross-module hook is ever truly needed, call the other module's function. It was always one
`await` away.

### 2. `ServiceRegistry` + `set_registry` two-phase initialization

Every service held `Arc<RwLock<Option<Arc<dyn ServiceRegistry>>>>`, populated after construction
by `set_registry(Arc::new(state.clone()))` calls in main — a workaround for services needing
services before `AppState` existed. It infected everything: runtime `.ok_or("registry not set")`
errors, a `registry!` macro to make access bearable, `Arc::new(self.clone())` allocated on every
accessor call. The new code already avoids the disease (plain `AppState`, services take what they
need as arguments). Keep it that way; if two modules need each other, that's a design smell to
resolve, not plumbing to build.

### 3. Stringly-typed errors (`app_error.rs`)

Errors were `anyhow!("400 User is locked.")`, and `IntoResponse` **sniffed the message text** —
`contains("404") || contains("not found")` — to pick a status code. Any error whose text
incidentally contains "not found" (an OS "file not found" bubbling up from disk I/O, say) becomes a
user-visible 404 with internal detail in the body; there is no way to grep for "all the ways this
endpoint 403s." The new `AppError` enum (`BadRequest`/`Unauthorized`/`NotFound`/`Internal`) is the
correct replacement — statuses chosen by type, internal errors logged but not leaked. Fully cut,
nothing to salvage.

### 4. Sessions as denormalized snapshots (`session.rs`)

The old session row copied user name, slug, tags, community name, tags, and a derived `is_admin`
at login. That made every session a *cache with no invalidation story*: change a user's tags and
their live sessions still carry the old ones, which is why event listeners had to delete all
sessions on un-admin (see Cut #1 for what enforcing security through the event bus is worth).
The new model — session = opaque token → account_id, everything else resolved fresh per request —
is right. The only piece worth stealing is the moka read-through cache in front of session lookup
*if* it ever shows up in profiles, with the discipline that grants/revocations invalidate.

### 5. Dev-mode plaintext passwords (`user.rs :: hash_password`)

In dev, passwords were stored and compared in plaintext. The *motivation* was legitimate and the
doc should not pretend otherwise: Argon2 at real parameters costs tens of milliseconds per hash by
design, and an integration suite that registers/logs in on nearly every test spends ~95% of its
runtime re-proving that a KDF is slow. Fast test loops are a feature worth engineering for.

The problem is the *mechanism*: a plaintext branch forks the code path inside a security function.
Dev never exercises PHC-string generation, salt handling, hash parsing, or verify — so bugs there
ship untested — and the failure mode of a config mistake reaching prod is stored plaintext
passwords.

The replacement that keeps the entire speedup: **tune Argon2 parameters down in test mode instead
of bypassing it.** Minimum params (8 KiB memory, t=1, p=1) hash in tens of microseconds (~1000x
faster; the residual gap to plaintext is noise) while running the byte-identical code path. PHC
strings are self-describing, so weak and strong hashes coexist and verify with no mode-tracking;
and misconfiguration degrades (weak-but-salted hashes, recoverable via rehash-on-login) rather
than detonates. This is the standard move — Django ships an MD5 hasher for test settings for the
same reason. Wire it to `RINGTOME_LOCAL_TEST` (the flag that already disables the rate limiter),
not to dev mode broadly. The same trick will apply to the plan's opt-in Argon2-derived envelope
key on lockable devices.

### 6. The "admin community" super-admin backdoor

A `session_admin` cookie was accepted by **every** community, and super-admins logging into a
community got a copy-user with `owner` powers auto-created (`create_superadmin_user`, complete with
pre-verified everything and `password_hash = "n/a"`). A global skeleton key, invisible to the
community's own member list until used, with hardcoded cookie-name magic in the session extractor.
Ringtome's architecture forbids the equivalent (no cross-node authority, node_admin is per-node,
identity authority comes only from the key tree) — and that's a feature. Nothing to salvage;
remember it as the kind of shortcut multi-tenancy invites.

### 7. Boot-time side effects to external services (`main.rs`)

On every boot: send a test SMS and a test email ("Hello, world!") to the operator, `.unwrap()`ing
the results — so AWS being down could crash the server at startup, and every restart cost real
SES/SNS calls. Combined with the AWS dependency itself, this is triply dead: PROJECT_PLAN.md
removes SES/SNS as mandatory dependencies, and the plan's "trivially restartable node" requirement
makes chatty, fallible boot sequences unacceptable. The new `record_boot` (a row in node.db) is the
right-sized replacement for the same "did it restart?" question. (`api_old`'s `boot.txt` was fine
too — the SMS was the sin.)

### 8. Slug-from-URL-position in extractors (`extractors.rs :: extract_slug`)

The session extractor re-derived the community from `path_segments[2]` — a hidden coupling that
breaks silently the day a route doesn't follow `/api/community/{slug}/...`. The new single-tenant
node mostly dissolves the problem, but the lesson stands: extractors should get path parameters
from the router (Axum exposes matched params to `FromRequestParts`), never by re-parsing the URI by
index.

### 9. N+1 queries and random cache eviction

Two efficiency patterns to leave behind:

- `get_users()` fetched all IDs, then ran `get_user` per row — and each `get_user` runs a second
  query for tags. Listing N users = 2N+1 queries. `get_user_by_email` resolved id → full re-fetch.
  Write the join.
- The community-DB cache evicted a **random** entry when over capacity — and if the randomly-chosen
  victim was the one in use, it just... didn't evict (a "clean" that can silently do nothing). The
  new moka-based `UserDbManager` (real LRU/TinyLFU, atomic get-or-insert) replaces this wholesale.
  One thing moka does need watching that the old hand-rolled map didn't: eviction doesn't `close()`
  the pool, it drops it — fine for SQLite as long as nothing holds a clone, worth a listener if
  handle exhaustion ever shows up.

### 10. `CREATE TABLE IF NOT EXISTS` + error-sniffing as schema management

Every service ran its own list of DDL strings at construction, and "migrations" were `ALTER TABLE`
statements whose "duplicate column" errors were caught by **string-matching the error message**
(`audit.rs`). No versioning, no ordering, no rollback, migrations interleaved into a
table-creation loop. The new crate's `sqlx::migrate!` with real versioned migration files
(`migrations/node`, `migrations/user`) is the correct replacement — especially given the plan makes
per-user DBs *disposable materialized views* that must be rebuildable at any schema version.

### 11. Dual/inconsistent timestamp storage

Every table stored `created_at` (RFC-3339 TEXT) **and** `created_at_int` — with the integer being
seconds in `session`, milliseconds in events, and microseconds in `user`/`audit`/`community`. Same
concept, three precisions, two representations, and code comparing them has to know which is which
(`community.rs` even filters one query on the *string* column). The new code's single
`created_at_ms INTEGER` convention is right. Human-readable timestamps are a rendering concern —
`ringtome inspect` territory, not schema territory.

### 12. ActivityPub / webfinger stubs

`webfinger` + actor endpoints, Mastodon-interop shaped, never finished (`activitypub.rs` is
literally empty). Ringtome's federation model (key trees + IM-AOL sync + pkarr, deliberately *not*
ActivityPub) supersedes it. Reference-only if an AP *bridge* is ever wanted; nothing to port now.

---

## Cautionary tales (bugs worth remembering)

These are the "the second system will contain the same features — don't re-contain the same bugs"
list:

1. **The 6-binds-into-5-placeholders bug.** `create_verification_code` binds six values
   (including a stray hardcoded `"email"`) into a five-placeholder INSERT — the code type lands in
   the wrong column and the whole statement fails at runtime. It shipped because hand-written SQL
   strings have no compile-time checking and the path lacked tests. Mitigations for the new crate:
   integration tests over every write path (already the house style), and considering
   `sqlx::query!` compile-checked macros where query shapes are static.
2. **Column-index row unpacking.** `row.try_get(3)`, `try_get(7)` — reorder the SELECT and
   everything shifts silently (or worse, types still line up). Prefer `try_get("name")` by column
   name (the new code mostly uses tuples on small explicit SELECTs, which is fine at that size).
3. **Empty string as NULL.** Old inserts wrote `unwrap_or_default()` empty strings for missing
   email/phone, then every reader had to launder `Some("")` back into `None` (see the four-field
   cleanup dance in `get_user`). Nullable data should be NULL in the schema. Relatedly: UNIQUE
   indexes on `email`/`phone` were absent — uniqueness was enforced by check-then-insert races.
   The new `accounts.username UNIQUE` constraint is the right pattern; keep constraints in the
   schema, not in application-level checks.
4. **Fingerprints and dev-mode conditionals in security paths.** The request "fingerprint" was
   `ip:forwarded_for:user_agent` as *plaintext*, stored in every audit row (PII-dense), and rate
   limiting was entirely disabled in dev (`is_dev() → Ok(())`) — so, like plaintext passwords,
   the enforcement path never ran during development. The new rate limiter's explicit
   `enabled: bool` wired to local-*test* mode (not dev mode broadly) is the better shape.
5. **Handlers doing service work.** `user/routes.rs` (812 lines) mixes HTTP parsing, rate-limit
   calls, service orchestration, cookie assembly, and event emission per handler. The new crate's
   discipline (thin `routes.rs`, logic in the module root) is worth defending as endpoints
   multiply.

---

## Frontend notes (`api_old/js/`)

"Vanilla JS" undersells it: the old frontend is **Preact + htm** (no JSX build step) bundled by
**esbuild**, with dexie (IndexedDB), marked, dayjs, and lucide icons. Worth keeping:

- **The toolchain.** esbuild one-liners in package.json (build/watch/csswatch), tree-shaken single
  bundle, sourcemapped dev watch. Near-zero build complexity, pairs perfectly with the
  version-stamped asset serving (Keep #7).
- **htm + Preact** as the "vanilla-adjacent" sweet spot: componentized UI, no transpiler, ~4KB
  runtime. A sane default for the node's UI unless the answer to the plan's open "frontend
  approach" question goes another way.
- **`nomenclature.md`.** A tiny doc defining the team's UI words (Page / Layout / Section / Form /
  Widget / Bip). Costs nothing, prevents drift; do this again.
- Dev-only test dependencies (`fetch-cookie`, `ws`, mocha) already carried into
  `node/integration/`.

---

## Summary table

| api_old pattern | Verdict | Status in `node/` |
|---|---|---|
| Per-tenant SQLite DBs | **Keep** | Ported (`UserDbManager`, moka + sqlx migrations) |
| Typed auth extractors | **Keep** | Ported (`auth::Session`); extend for admin/identity tiers |
| RequestContext + correlation IDs | **Keep** | Ported |
| Tags for roles | **Keep** (capabilities, not state machines) | Ported (`account_tags`) |
| Audit log w/ probabilistic pruning | **Keep** | Not yet built |
| Bucketed rate limiting over moka | **Keep** | Ported |
| Version-stamped assets + semver int | **Keep** | Not yet built (no UI yet) |
| Invite codes + invite chains | **Keep** (proto-vouch) | Not yet built |
| Dirty-flag live notifications | **Keep** (concept → iroh-gossip) | Not yet built |
| Internal/external DTO split | **Keep** | Partially (small surface so far) |
| TTL for unverified resources | **Keep** | Not yet built |
| Integration tests + dev-only test routes | **Keep** | Ported |
| Event bus | **Cut** | Correctly absent |
| ServiceRegistry / set_registry | **Cut** | Correctly absent |
| String-sniffed error statuses | **Cut** | Replaced (typed `AppError`) |
| Denormalized session snapshots | **Cut** | Replaced (token → account) |
| Dev-mode plaintext passwords | **Cut** (keep the goal: weak Argon2 params in test mode) | Done: minimal params under `RINGTOME_LOCAL_TEST` (suite: 29s → 0.3s) |
| Admin-community backdoor | **Cut** | N/A by architecture |
| Boot-time SMS/email | **Cut** | Replaced (`record_boot`) |
| URL-index slug extraction | **Cut** | N/A (single-tenant routes) |
| N+1 queries, random eviction | **Cut** | Replaced |
| DDL-at-construction "migrations" | **Cut** | Replaced (`sqlx::migrate!`) |
| Dual timestamp columns | **Cut** | Replaced (`*_ms` integers) |
| ActivityPub stubs | **Cut** (reference only) | Correctly absent |
