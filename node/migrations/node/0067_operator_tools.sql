-- The operator's sign-up tools (2026-10-02), set in the Server app beside the registration mode.
--   registration_limits  one row: the most accounts this node may hold, the disk-use percentage past
--                        which it takes no more, and the group name (only while sign-ups take a
--                        password) - each NULL for "no limit" / "no group" (registration.rs)
--   group_members        who joined while a group was set: the account at sign-up, its first
--                        persona once made - whom each later joiner is paired with (groups.rs)
--   auto_follow          the people every persona made here begins knowing, beside the built-in
--                        starters: an address, its via hints, and the dials to begin on (starters.rs)
CREATE TABLE registration_limits (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    max_accounts  INTEGER,
    disk_max_pct  INTEGER,
    group_name    TEXT,
    updated_ms    INTEGER NOT NULL
);
CREATE TABLE group_members (
    account_id   TEXT    PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    group_name   TEXT    NOT NULL,
    root_pubkey  TEXT,
    joined_ms    INTEGER NOT NULL
);
CREATE INDEX group_members_by_group ON group_members (group_name);
CREATE TABLE auto_follow (
    root_pubkey   TEXT    PRIMARY KEY,
    via           TEXT    NOT NULL DEFAULT '',
    trust         TEXT    NOT NULL,
    interest      TEXT    NOT NULL,
    rebroadcasts  TEXT    NOT NULL,
    added_ms      INTEGER NOT NULL
);
