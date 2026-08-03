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

-- Persisted materialized views (PROJECT_PLAN, The Substrate: "Views persist now"). With the
-- database itself encrypted at rest, decrypted views stop being "a second secret" and become
-- ordinary tables: facts folded incrementally from the chains, watermarked per (author, service)
-- so a read fast-forwards from the last fold instead of replaying history.
--
-- The standing invariant is unchanged: every table here is a disposable cache - a pure function
-- of the entries log, wiped by `rebuild_views` and refolded on the next read. SQL holds facts;
-- DAG judgment (heads, logical-head folding, merge rungs) stays in Rust (record::documents).

-- One row per decrypted doc-header entry: the immutable facts of one document version. The
-- entry hash IS the version's identity, so the primary key dedups refolds - INSERT OR IGNORE,
-- no LWW needed (a version is never updated, only superseded by children naming it in parents).
CREATE TABLE doc_versions (
    entry_hash    BLOB    PRIMARY KEY,  -- the version's identity: its entry's hash
    doc_id        BLOB    NOT NULL,     -- 16-byte stable document id
    parents       BLOB    NOT NULL,     -- CBOR array of 32-byte parent entry hashes (Rust decodes)
    title         TEXT    NOT NULL,
    body_hash     BLOB    NOT NULL,     -- keyed plaintext fingerprint (member-secret)
    file_hash     BLOB    NOT NULL,     -- the body's ciphertext hash in the file layer
    format        INTEGER,              -- doc_format id; NULL = plaintext (wire absence)
    width         INTEGER,              -- media metadata, all NULL for text
    height        INTEGER,
    duration_ms   INTEGER,
    thumb_hash    BLOB,
    preview_hash  BLOB,
    timestamp_ms  INTEGER NOT NULL,     -- the entry's claimed stamp (display/LWW only)
    seq           INTEGER NOT NULL,     -- position on the author's chain
    author_pubkey TEXT    NOT NULL,     -- hex leaf key that signed the version (device attribution)
    lane          TEXT    NOT NULL DEFAULT 'private' -- which world: 'private' (DOCUMENTS_PRIVATE,
                                        -- encrypted headers/bodies) or 'public' (POSTS, plaintext).
                                        -- A document lives wholly in one lane; crossing is a copy.
);
CREATE INDEX doc_versions_by_doc ON doc_versions (doc_id);

-- Memoized per-document display state: one row per document, the docs-list read. This is NOT
-- judgment-in-SQL - every value here is the output of the same Rust resolver every read runs
-- (record::documents: DAG heads, twin/echo folding, display-head choice). The table only
-- remembers that resolver's latest answer, recomputed after each fold pass for exactly the
-- documents whose doc_versions inputs changed. Disposable like every view: rebuild_views wipes
-- it and the next keyed read re-derives it from doc_versions.
CREATE TABLE doc_heads (
    doc_id        BLOB    PRIMARY KEY,  -- 16-byte stable document id
    lane          TEXT    NOT NULL DEFAULT 'private', -- mirrors doc_versions.lane (one per doc)
    entry_hash    BLOB    NOT NULL,     -- the display head's version hash (Rust's display_head)
    title         TEXT    NOT NULL,     -- display head's title
    format        INTEGER,              -- doc_format id; NULL = plaintext (wire absence)
    file_hash     BLOB    NOT NULL,     -- display head's body blob hash (file layer)
    width         INTEGER,              -- display head's media facts, all NULL for text
    height        INTEGER,
    duration_ms   INTEGER,
    thumb_hash    BLOB,
    preview_hash  BLOB,
    logical_heads INTEGER NOT NULL,     -- how many logical heads the resolver kept
    diverged      INTEGER NOT NULL,     -- logical_heads > 1, precomputed for the list read
    genesis_ms    INTEGER NOT NULL,     -- claimed stamp of the parentless/earliest version
    head_ms       INTEGER NOT NULL,     -- display head's claimed stamp (modified ordering)
    heads_fp      BLOB    NOT NULL,     -- BLAKE3 over the sorted logical-head hashes: the head
                                        -- SET as one comparable value (raced resolutions rotate
                                        -- the set without moving the count - the lookout lesson)
    head_bodies   BLOB    NOT NULL      -- the logical heads' body hashes, sorted+concatenated:
                                        -- what the search index checks blob presence against
);

-- The search index: one token-bag row per document, derived from title + resolved body +
-- annotations (PROJECT_PLAN, The Browser Is a View; NEXT_STEPS, Where search lives). A
-- materialized view like doc_heads - living here it inherits at-rest encryption BY
-- CONSTRUCTION (an index is a plaintext derivative of encrypted bodies and must never be less
-- protected than they are). `fp` is the staleness fingerprint over exactly the inputs that
-- change the tokens: the logical-head set, which of their bodies are locally present, the
-- title, and the annotation text. Refreshed lazily by the stream's read path; disposable.
CREATE TABLE doc_search (
    doc_id  BLOB PRIMARY KEY,
    fp      BLOB NOT NULL,
    tokens  TEXT NOT NULL
);

-- The private key/value store's LWW registers, persisted. `service` rides in the primary key so
-- the future doc-meta chain (service 7) reuses this table with zero schema change. Fold rule:
-- the same statement-atomic stamp-compare upsert as profile_view (imaol::apply_profile_set).
CREATE TABLE private_registers (
    service       INTEGER NOT NULL,
    collection    TEXT    NOT NULL,
    key           TEXT    NOT NULL,
    value         BLOB,
    timestamp_ms  INTEGER NOT NULL,
    seq           INTEGER NOT NULL,
    entry_hash    BLOB    NOT NULL,
    PRIMARY KEY (service, collection, key)
);

-- The private store's LWW-element-sets: one row per element ever touched, `present` carrying
-- the add/remove verdict (removed rows must persist - their stamp is what makes a stale re-add
-- lose). Same stamp-compare upsert as the registers.
CREATE TABLE private_set_elements (
    service       INTEGER NOT NULL,
    collection    TEXT    NOT NULL,
    element       TEXT    NOT NULL,
    present       INTEGER NOT NULL,
    value         BLOB,
    timestamp_ms  INTEGER NOT NULL,
    seq           INTEGER NOT NULL,
    entry_hash    BLOB    NOT NULL,
    PRIMARY KEY (service, collection, element)
);

-- How far each (author, service) chain has been folded into the views above. A watermark never
-- advances past an entry the folder could not decrypt (record::private, the stall rule), so a
-- later read - after adoption resealing delivers the missing epoch key - retries from there.
CREATE TABLE view_watermarks (
    author_pubkey TEXT    NOT NULL,
    service       INTEGER NOT NULL,
    folded_seq    INTEGER NOT NULL,
    PRIMARY KEY (author_pubkey, service)
);
