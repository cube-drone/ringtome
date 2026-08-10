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

-- The FOLD path's index (added 2026-08-08, measured): every catch-up-on-read asks
-- "entries of this (service, entry_type), in (author, seq) order" - `imaol::entries_of_type`
-- (epoch keys, on every store open) and `entries_past_watermarks` (every private and document
-- read). The primary key leads with author_pubkey, so neither could use it: EXPLAIN showed a
-- raw `SCAN entries` - reading every row's BLOB bytes off disk - plus a sorter, on a table
-- that grows with everything the identity ever writes. Ordering the tail columns as
-- (author_pubkey, seq) serves the ORDER BY from the index too, so the sorter goes away with
-- the scan. Deliberately NOT covering: adding `bytes` would duplicate the whole log.
CREATE INDEX entries_by_service_type ON entries (service, entry_type, author_pubkey, seq);

-- Equivocation evidence: proof that a single-writer key signed two different entries at the
-- same (service, seq) - the one act the chain format makes self-incriminating ("forks are
-- self-proving" - PROJECT_PLAN, IM-AOL). Rows are written by the sync gate when a second
-- branch's entry arrives for a position we already hold (the proof now crosses the wire: a
-- peer whose frontier matches ours in height but not in head hash is sent our head entry,
-- and sends us theirs). Both signed envelopes are kept - the pair is portable, checkable
-- proof no matter what later happens to the entries table.
--
-- EVIDENCE, not a view: rebuild_views never touches it. Consumed conservatively: while a
-- persona has unresolved evidence on a public content chain, its public shelf presents
-- nothing (documents::public_docs) - neither branch is presented as uncomplicated truth.
-- Cleared when the crown takes the key over (revocation seen): the anchored-prefix machinery
-- then decides what is honored history, which is the resolution the quarantine waited for.
CREATE TABLE equivocations (
    author_pubkey TEXT    NOT NULL,  -- the double-signing key
    service       INTEGER NOT NULL,
    seq           INTEGER NOT NULL,
    held_hash     BLOB    NOT NULL,  -- the branch this replica stored first
    other_hash    BLOB    NOT NULL,  -- the branch that arrived and proved the fork
    held_bytes    BLOB    NOT NULL,  -- both signed envelopes: the portable proof
    other_bytes   BLOB    NOT NULL,
    noted_ms      INTEGER NOT NULL,
    PRIMARY KEY (author_pubkey, service, seq)
);

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

-- The published relationships, materialized: latest public-edge per subject across all the
-- persona's device chains (imaol::catch_up_published_edges - the fold writes the memo, reads
-- never fold). A row with both bands NULL is a folded RETRACTION, kept as the LWW tombstone
-- that stops a resurrected older statement from winning; readers treat it as "nothing
-- published". Consumers: publish::reconcile (desired-vs-published) and the notifications
-- fold; both used to replay the whole chain per call.
CREATE TABLE published_edges (
    subject_root   TEXT    NOT NULL,
    trust          TEXT,
    interest       TEXT,
    timestamp_ms   INTEGER NOT NULL,  -- LWW stamp of the winning statement
    seq            INTEGER NOT NULL,
    entry_hash     BLOB    NOT NULL,
    received_at_ms INTEGER NOT NULL,  -- this replica's arrival stamp (the bell orders by it)
    PRIMARY KEY (subject_root)
);

-- The inbox: notices delivered by strangers, folded from the two inbox tier chains
-- (PROJECT_PLAN, Arrival and Attention - the DELIVERED path; the derived path is node.db's
-- `notifications` and never touches this).
--
-- **Collapse is the primary key.** One row per (sender, kind) - a flapping stranger occupies
-- one row however many times they knock, and a sender who knocks on all three of your nodes
-- produces one row because every node transcribes the same envelope hash. The key deliberately
-- does NOT include `service`: the tiers are two chains but one list, so a sender promoted from
-- stranger to trusted collapses onto their existing row instead of appearing twice ("the
-- read-time merge across tiers makes the seam invisible"). `service` rides as a column so
-- retention can still count what sits in the stranger pool.
--
-- `envelope` is the sender's bytes verbatim: this table is a VIEW, and the chain entry it was
-- folded from is the truth. Dropping the table costs one refold.
CREATE TABLE inbox_notices (
    sender_root   TEXT    NOT NULL,
    kind          TEXT    NOT NULL,
    service       INTEGER NOT NULL,  -- which tier chain the winning notice landed on
    author_pubkey TEXT    NOT NULL,  -- which device chain it landed on: how retention finds
                                     -- the rows whose entries just aged off that chain's floor
    envelope      BLOB    NOT NULL,  -- the delivered envelope, verbatim, re-verifiable
    trust         TEXT,              -- the published bands the evidence carried
    interest      TEXT,
    timestamp_ms  INTEGER NOT NULL,  -- LWW stamp: the transcribing node's claimed time
    seq           INTEGER NOT NULL,
    entry_hash    BLOB    NOT NULL,
    PRIMARY KEY (sender_root, kind)
);
CREATE INDEX inbox_notices_by_time ON inbox_notices (timestamp_ms DESC);

-- How far each (author, service) chain has been folded into the views above. A watermark never
-- advances past an entry the folder could not decrypt (record::private, the stall rule), so a
-- later read - after adoption resealing delivers the missing epoch key - retries from there.
CREATE TABLE view_watermarks (
    author_pubkey TEXT    NOT NULL,
    service       INTEGER NOT NULL,
    folded_seq    INTEGER NOT NULL,
    PRIMARY KEY (author_pubkey, service)
);
