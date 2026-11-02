-- A persona's moderation list (plans/MODERATION.md, 2026-11-02), folded from its
-- MODERATION_PUBLIC chain: the newest statement per target wins, a retraction stays as a
-- tombstone (`present` 0) so an older statement arriving late can't revive it. No backfill: the
-- chain is new, so there is nothing to fold yet.
CREATE TABLE moderation_entries (
    target_kind    INTEGER NOT NULL,
    target         TEXT    NOT NULL,
    level          INTEGER NOT NULL,
    reason         TEXT    NOT NULL,
    present        INTEGER NOT NULL,
    timestamp_ms   INTEGER NOT NULL,
    seq            INTEGER NOT NULL,
    entry_hash     BLOB    NOT NULL,
    received_at_ms INTEGER NOT NULL,
    PRIMARY KEY (target_kind, target)
);
