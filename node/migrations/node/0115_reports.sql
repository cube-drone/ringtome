-- Reports (reports.rs, plans/MODERATION.md _Reports_): kept on the node where the moderator takes
-- them, never on a chain.
--
-- report_policy: the operator's "Allow Users to Accept Reports", one row at most; no row is off.
--   users_may      1 or 0
--   stranger_pool  how many reports from strangers each persona keeps, oldest dropped first
--   keep_days      how long a report is kept
CREATE TABLE report_policy (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    users_may      INTEGER NOT NULL,
    stranger_pool  INTEGER NOT NULL,
    keep_days      INTEGER NOT NULL,
    updated_ms     INTEGER NOT NULL
);

-- report_takers: a persona's "Accept Reports", here - per node, because the queue is.
--   reach      1: from the people they trust; 2: and the people those people trust
--   strangers  1: from anyone, into the bounded pool
CREATE TABLE report_takers (
    root        TEXT PRIMARY KEY,
    takes       INTEGER NOT NULL,
    reach       INTEGER NOT NULL,
    strangers   INTEGER NOT NULL,
    updated_ms  INTEGER NOT NULL
);

-- reports: one per delivered envelope (id = its hash, hex).
--   standing      'trusted', 'reach' (trusted by someone they trust) or 'stranger'
--   from_node     the endpoint id of the node that knocked
--   item_*        the reported version, from the author's own signed header (verified at the door)
--   item_hashes   JSON array of the blobs that header names, hex
--   upload_token  where the item's pictures may arrive, over HTTPS, until upload_until_ms
--   status        'open', 'dismissed', 'listed' or 'proposed' (an assistant's proposal, awaiting a person)
CREATE TABLE reports (
    id                  TEXT PRIMARY KEY,
    moderator           TEXT NOT NULL,
    reporter            TEXT NOT NULL,
    reporter_name       TEXT,
    standing            TEXT NOT NULL,
    from_node           TEXT NOT NULL,
    target_kind         TEXT NOT NULL,
    target              TEXT NOT NULL,
    reason              TEXT NOT NULL,
    child_abuse         INTEGER NOT NULL,
    item_author         TEXT,
    item_doc            TEXT,
    item_version        TEXT,
    item_title          TEXT,
    item_format         INTEGER,
    item_trusted_only   INTEGER,
    item_signed_ms      INTEGER,
    item_hashes         TEXT NOT NULL DEFAULT '[]',
    upload_token        TEXT,
    upload_until_ms     INTEGER,
    received_ms         INTEGER NOT NULL,
    status              TEXT NOT NULL DEFAULT 'open',
    decided_ms          INTEGER,
    proposal            TEXT
);
CREATE INDEX reports_queue ON reports (moderator, status, received_ms);
CREATE UNIQUE INDEX reports_upload ON reports (upload_token);

-- report_pictures: what arrived over HTTPS for a report - stored in the blob store by hash, kept
-- by the reaper while the report is.
CREATE TABLE report_pictures (
    report_id   TEXT NOT NULL,
    hash        TEXT NOT NULL,
    arrived_ms  INTEGER NOT NULL,
    PRIMARY KEY (report_id, hash)
);
