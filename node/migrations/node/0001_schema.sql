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
    -- What this node last CLAIMED about the persona's public frontier, and what we did about
    -- it. A claim, never a fact (PROJECT_PLAN: "a frontier another node reports is a hint,
    -- never a fact - fetch and validate, never believe"), which is why the verdict is stored
    -- separately from the claim: without it, a node advertising a fingerprint it cannot back
    -- up gets chased on every sweep forever, which is free for it and expensive for us.
    seen_fp        BLOB,
    seen_at_ms     INTEGER,
    chased_fp      BLOB,               -- the claim we last acted on; re-chase only when it moves
    chased_at_ms   INTEGER,
    verdict        TEXT,               -- 'behind' | 'ahead' | 'unresolvable'; NULL = never chased
    PRIMARY KEY (root_pubkey, endpoint_id)
);

-- ---------------------------------------------------------------------------------------------
-- The edges each hosted persona has drawn to someone else, as the NODE needs them.
--
-- Derived, never authored: the truth is the contact ledger on each persona's own private chain
-- (`contact:<root>` LWW registers), and this is a memo of it - the same idiom as doc_heads,
-- disposable and rebuildable from the fold. It exists because routing is a node-level question
-- asked across every persona at once, and per-user databases are separate encrypted files.
--
-- Two different things live here, for two different reasons:
--
--   * `eagerness` and `rebroadcast` are ROUTING (PROJECT_PLAN, Data Layer: "the node routes;
--     the user ranks"). The interest dial is already a sync-cadence dial by design - "don't
--     show / low / medium / high / top priority" is just as naturally how eagerly this identity
--     syncs - so no new knob was invented for it.
--
--   * `trust` is UTILITY STANDING, and it is here ONLY where its author set `trust_public`.
--     A private assessment must not have publicly measurable effects: giving a stranger better
--     treatment because someone here quietly trusts them makes a private fact observable by
--     measurement. A consented edge is one its author agreed may be known, so acting on it
--     visibly discloses nothing they did not offer. The raw 0-100 is stored rather than a
--     bucket: nothing consumes it yet, and a number can be bucketed later where a bucket can
--     never be un-bucketed.
--
-- A row exists when ANY of the three is set, and dies when the last one clears.
CREATE TABLE subscriptions (
    local_root   TEXT    NOT NULL,   -- the persona on this node doing the trusting/following
    foreign_root TEXT    NOT NULL,   -- whom
    eagerness    INTEGER,            -- interest 0-100: how eagerly to sync them. NULL = unset
    rebroadcast  INTEGER,            -- interest in their rebroadcasts, same scale
    trust        INTEGER,            -- 0-100, ONLY when trust_public consent is set
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (local_root, foreign_root)
);
CREATE INDEX subscriptions_by_foreign ON subscriptions (foreign_root);

-- ---------------------------------------------------------------------------------------------
-- Who has ASKED us about a persona: the demand record the Three Funnels has been asserting and
-- nothing wrote (PROJECT_PLAN, The Three Funnels).
--
-- The fan-out question is "a public post for P just landed - which nodes should I tell?", and
-- the answer is already crossing the wire unrecorded: a node that dials us and names P in its
-- Hello has told us it wants P. Asking is telling. No consent machinery is involved because
-- they initiated the contact, and no follow disclosure is needed for it to work today.
--
-- SEPARATE from identity_peers on purpose, though the key looks the same. That table means
-- "nodes that ARE this identity" - authority-bearing, member-proven, entitled to private
-- chains, and `roots_with_peers` drives the eager push loop assuming exactly that. A reader is
-- none of those things, and the day someone writes a loop over `peers_for` without re-reading
-- its comment, the conflation is what leaks.
--
-- One row per pair, updated in place - a log of every request grows without bound and answers
-- "who wants this?" strictly worse than one row saying "recently". Endpoint-level and never
-- joined to which human asked: we learn that a NODE wants P, and the receiving node routes
-- internally, which is "the node routes; the user ranks" falling out of the mechanism rather
-- than being enforced on top of it.
--
-- Retention deliberately deferred (2026-08-05): this assembles a readership graph for personas
-- we host, which is the same already-possible/already-assembled line trust had to respect. The
-- mitigation is pruning to a window so it records CURRENT demand rather than a permanent
-- readership log - owed before any node hosts strangers, not before then.
CREATE TABLE identity_demand (
    root_pubkey   TEXT    NOT NULL,  -- the persona they asked about
    endpoint_id   TEXT    NOT NULL,  -- the node that asked; transport identity, never a person
    last_asked_ms INTEGER NOT NULL,
    PRIMARY KEY (root_pubkey, endpoint_id)
);
CREATE INDEX identity_demand_by_root ON identity_demand (root_pubkey);

-- ---------------------------------------------------------------------------------------------
-- What THIS node holds of each persona's PUBLIC lane, one row per (persona, public service).
--
-- Why it exists: per-user databases are separate files, so "which personas changed?" otherwise
-- means opening every one of them. This answers it in one scan, and is the hook fan-out hangs
-- from - a subscriber wakes when the service it subscribed to moves.
--
-- Why per SERVICE and not per persona: a single fingerprint over every public chain is maximally
-- sensitive, so adding a computer (an authorize entry on IDENTITY_PUBLIC) would wake every
-- follower to discover the person said nothing. Keyed this way, "did they post" (POSTS) is a
-- different question from "did they rename themselves" (PROFILE_PUBLIC). The persona-level
-- fingerprint is derived by hashing these rows in service order, so nothing is lost.
--
-- PUBLIC ONLY, structurally: the count and cadence of private activity is itself private
-- (PROJECT_PLAN, Chains), and this table is the input to things that get told to other people.
-- The filter is `net::sync::is_private_service` - one definition of private, the same one the
-- sync gate enforces.
CREATE TABLE persona_frontiers (
    root_pubkey TEXT    NOT NULL,
    service     INTEGER NOT NULL,
    held_fp     BLOB    NOT NULL,   -- blake3 over (author ‖ service ‖ head_hash), author-sorted
    held_at_ms  INTEGER NOT NULL,   -- when we last computed it, not when they wrote
    chains      INTEGER NOT NULL,   -- how many of their computers have written this service
    PRIMARY KEY (root_pubkey, service)
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

-- Foreign-identity fetch memory: roots reached across the network on a member's request
-- (idface.rs fetch-and-serve). ON DISK deliberately (amended 2026-08-02 from an in-memory
-- map): once an identity's own nodes go permanently dark, it survives exactly in the nodes
-- that fetched it and their memory of having done so - a reboot forgetting the registry
-- would orphan chains this node still holds. Durable KNOWLEDGE, still member-scoped
-- SERVING: this table never feeds the identities table or the anonymous shelf, and it
-- deliberately stays out of identity_peers (the background sync worklist) - a fetch is
-- remembered, never promoted to fronting.
CREATE TABLE foreign_fetches (
    root_pubkey   TEXT    PRIMARY KEY,
    fetched_at_ms INTEGER NOT NULL,  -- last successful fetch; freshness TTL reads this
    last_via      TEXT               -- the endpoint key that answered; first refresh candidate
);
