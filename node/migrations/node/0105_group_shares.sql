-- Rebroadcasts into a group (plans/GROUPS.md, section 7, 2026-10-18): the public posts a group's
-- members have shared into it, as the group's derivation counts them - each the latest word of a
-- member's REBROADCAST entries on their lane about one post - and swept by group as its other
-- tables are. The group's feed reads them beside its own posts, and the shares themselves reach
-- its hosted members' feeds by the public share road, with the sharer as the via.
CREATE TABLE group_shares (
    group_id  BLOB    NOT NULL,
    sharer    TEXT    NOT NULL,
    author    TEXT    NOT NULL,
    doc       TEXT    NOT NULL,
    shared_ms INTEGER NOT NULL,
    noted     INTEGER NOT NULL,
    PRIMARY KEY (group_id, sharer, author, doc)
);
CREATE INDEX group_shares_by_post ON group_shares (author, doc);
