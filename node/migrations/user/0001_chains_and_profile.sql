-- The local copy of this identity's signed IM-AOL chains, plus the materialized views built from
-- them. (MIGRATION POLICY: squash-into-0001 until a deployment matters, then append-only forever
-- - see migrations/node/0001_schema.sql.) The `entries` table is the source of truth: the author's exact envelope bytes, one row
-- per entry, keyed by (author, service, seq). Every `*_view` table is a disposable, query-shaped
-- cache - rebuildable at any time by replaying and re-validating the log. In M3, `entries` is
-- also exactly what replicates between nodes.

CREATE TABLE entries (
    author_pubkey TEXT    NOT NULL,  -- hex ed25519 public key of the chain's key
    service       INTEGER NOT NULL,  -- service id from the proto type registry
    seq           INTEGER NOT NULL,  -- dense per-chain sequence number
    entry_hash    BLOB    NOT NULL,  -- BLAKE3-256 of `bytes`
    prev_hash     BLOB    NOT NULL,  -- predecessor's entry_hash (zero for seq 0)
    entry_type    INTEGER NOT NULL,  -- entry-type id from the proto type registry
    timestamp_ms  INTEGER NOT NULL,  -- author's claimed wall-clock; ADVISORY, display/LWW only
    received_at_ms INTEGER NOT NULL, -- when THIS replica first stored the entry: a local fact,
                                     --   never signed or synced; the display-layer upper bound
                                     --   on authorship (PROJECT_PLAN, Displayed vs. Claimed Time)
    bytes         BLOB    NOT NULL,  -- the author's exact envelope bytes, never re-encoded
    PRIMARY KEY (author_pubkey, service, seq)
);

-- Entry hashes are globally unique (they hash the whole envelope, which includes the chain id
-- and seq); the unique index doubles as the lookup path for prev_hash / anchor resolution.
CREATE UNIQUE INDEX entries_by_hash ON entries (entry_hash);

-- Materialized view of the identity's public profile: one row per field, last-writer-wins by
-- (timestamp_ms, seq, entry_hash) - see imaol::apply_profile_set for the merge rule.
CREATE TABLE profile_view (
    field         TEXT    PRIMARY KEY,
    value         TEXT    NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    seq           INTEGER NOT NULL,
    entry_hash    BLOB    NOT NULL
);
