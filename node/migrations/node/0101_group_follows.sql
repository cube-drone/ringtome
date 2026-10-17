-- Public groups, slice 4 (plans/PUBLIC_GROUPS.md, ruling 7, 2026-10-17): following a public group
-- itself, rather than any of its members, brings every member's public post as the group's. Kept
-- on the follower's node, quiet: a follow of a group is nobody else's business.
CREATE TABLE group_follows (
    local_root  TEXT NOT NULL,
    group_id    BLOB NOT NULL,
    followed_ms INTEGER NOT NULL,
    PRIMARY KEY (local_root, group_id)
);
CREATE INDEX group_follows_by_group ON group_follows (group_id);
