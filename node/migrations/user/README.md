# Per-user database migrations

Migrations for the per-identity databases (`data/users/<root-pubkey>.db`), which hold the
materialized view of a single identity's IM-AOL chains.

Intentionally empty for now: the user schema is driven by the chain/entry model (M1 crypto core),
so the first migration lands when there is a real consumer to shape it, rather than being guessed
ahead of time. The migration *plumbing* (a separate migration set, applied per-database on open)
exists from the start because every per-user DB must be migrated consistently.
