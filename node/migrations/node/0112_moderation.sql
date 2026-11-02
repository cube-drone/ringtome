-- What every moderator this node holds says (plans/MODERATION.md, 2026-11-02): each persona's
-- present moderation entries, copied from their user database's `moderation_entries` whenever
-- their MODERATION_PUBLIC chain moves (moderation.rs), so a reader's "what I take" is one query
-- over the moderators they ticked instead of a database open per moderator.
CREATE TABLE moderation_said (
    author      TEXT    NOT NULL,
    target_kind INTEGER NOT NULL,
    target      TEXT    NOT NULL,
    level       INTEGER NOT NULL,
    reason      TEXT    NOT NULL,
    said_ms     INTEGER NOT NULL,
    PRIMARY KEY (author, target_kind, target)
);
CREATE INDEX moderation_said_target ON moderation_said (target_kind, target);
