-- The node database (node.db): everything node-level in one place.
--
-- MIGRATION POLICY: until a database exists that cannot be casually deleted (the first testnode,
-- a friend's node, your own daily-driver), schema changes are squashed into THIS file and dev
-- data dirs are deleted. The moment any deployment matters, this file freezes and migrations
-- become append-only forever. (Squashed 2026-07-07 from six pre-deployment migrations.)

-- ---------------------------------------------------------------------------------------------
-- Boot history. Local-only diagnostic (never exposed over the network); recording a boot also
-- exercises the write path on startup.
CREATE TABLE boot_timestamps (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    booted_at_ms INTEGER NOT NULL,
    app_version  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------------------------
-- Node accounts and their sessions.
--
-- An account is a login on THIS node (username + Argon2 password hash). Sessions are opaque
-- server-side tokens: the random token is the cookie value, this table is the source of truth,
-- and deleting a row is instant, authoritative logout. (Not JWTs - a single-node process with
-- local SQLite gains nothing from stateless tokens and would need this table for revocation
-- anyway.)
CREATE TABLE accounts (
    id             TEXT PRIMARY KEY,          -- uuid
    username       TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,             -- Argon2 PHC string
    created_at_ms  INTEGER NOT NULL
);

CREATE TABLE sessions (
    token          TEXT PRIMARY KEY,          -- opaque high-entropy random string
    account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at_ms  INTEGER NOT NULL,
    expires_at_ms  INTEGER NOT NULL
);
CREATE INDEX sessions_account_idx ON sessions (account_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at_ms);

-- Simple string tags on accounts (`node_admin`, `admin`, ...). Deliberately generic so new
-- capability markers need no schema change - but capabilities only: state machines get columns.
CREATE TABLE account_tags (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    tag        TEXT NOT NULL,
    PRIMARY KEY (account_id, tag)
);
CREATE INDEX account_tags_tag_idx ON account_tags (tag);

-- ---------------------------------------------------------------------------------------------
-- Identities agented by accounts on this node.
--
-- An identity IS its root ed25519 public key (stored hex). Private keys are NOT here - they live
-- envelope-encrypted in key files (data/keys/). The identity's chains live in its own per-user
-- DB (data/users/<root>.db).
CREATE TABLE identities (
    root_pubkey   TEXT PRIMARY KEY,  -- hex ed25519 public key; the identity's global name
    account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at_ms INTEGER NOT NULL,
    -- Which key THIS node signs with for the identity: the root itself on the creating node, a
    -- granted leaf on nodes added via adoption. Names the key file in data/keys/.
    leaf_pubkey   TEXT,
    -- Publication is an act: a serving record is published only once this is set. NULL = dark
    -- (unpublished), every identity's birth state.
    served_at_ms  INTEGER
);
CREATE INDEX identities_account_idx ON identities (account_id);

-- ---------------------------------------------------------------------------------------------
-- Known peers per identity: other nodes agenting (or later, fronting) it. Endpoint ids only -
-- addresses are the discovery layer's problem, resolved at dial time (hints are keys, never
-- addresses).
CREATE TABLE identity_peers (
    root_pubkey    TEXT    NOT NULL,
    endpoint_id    TEXT    NOT NULL,  -- iroh endpoint id; transport identity, never an identity key
    added_at_ms    INTEGER NOT NULL,
    last_synced_ms INTEGER,
    PRIMARY KEY (root_pubkey, endpoint_id)
);

-- Adoption handshakes awaiting their grant code: the leaf keypair is minted (and sealed in the
-- keystore) at `begin`; this row links it to the requesting account until `complete` promotes
-- it into `identities` (or it is abandoned).
CREATE TABLE pending_adoptions (
    leaf_pubkey   TEXT    PRIMARY KEY,
    account_id    TEXT    NOT NULL,
    created_at_ms INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------------------------
-- Media ingest queue. Uploaded images/audio/video don't enter a user's record or the blob store
-- until they've been transcoded to a canonical AV1-family codec; while they wait, the raw upload
-- sits in the quarantine directory and one row here tracks it. Node-LOCAL operational state: it
-- describes THIS node's processing backlog, is never synced, and never becomes part of anyone's
-- record. Shared across all users because the workers are shared (a handful of them, not one per
-- user). FIFO by `seq`; per-account fairness is a deliberate non-goal until a node has enough
-- users for one uploader's dump to starve another. A version-less doc_id IS the pending state -
-- the document gets its first version only when transcode succeeds; a permanent failure leaves
-- the doc_id with no version, visible only here (the progress view), never as a ghost document.
CREATE TABLE ingest_job (
    seq             INTEGER PRIMARY KEY AUTOINCREMENT,  -- FIFO order; monotonic, no clock needed
    job_id          TEXT    NOT NULL UNIQUE,            -- external handle (hex), returned in the 202
    account         TEXT    NOT NULL,                   -- owning account (for the progress view)
    root            TEXT    NOT NULL,                   -- identity root pubkey hex (to open the store)
    doc_id          TEXT    NOT NULL,                   -- minted at enqueue, returned in the 202 (hex)
    parents         TEXT    NOT NULL DEFAULT '',        -- CSV of parent version hashes (empty = create)
    title           TEXT    NOT NULL,
    quarantine_path TEXT    NOT NULL,                   -- absolute path to the raw upload on disk
    status          TEXT    NOT NULL DEFAULT 'pending', -- pending | processing | done | failed
    error           TEXT,                               -- set when status = failed (the tombstone)
    bytes_in        INTEGER NOT NULL,                   -- raw upload size
    created_ms      INTEGER NOT NULL                    -- local display clock only, never synced
);
CREATE INDEX ingest_job_status_idx  ON ingest_job (status, seq);
CREATE INDEX ingest_job_account_idx ON ingest_job (account, seq);
