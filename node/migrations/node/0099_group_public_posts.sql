-- Public groups, slice 2 (plans/PUBLIC_GROUPS.md, 2026-10-17): the public posts a public group
-- counts as its own - each a member's own public post that their public lane claims - written by
-- the group's derivation on every node holding the group's public lanes, and swept by group as
-- its other tables are. The cards' "(Cheese Group)", the group's public page and the carry read
-- it. And the kind, beside the group's name, for lists that don't fold.
CREATE TABLE group_public_posts (
    group_id   BLOB NOT NULL,
    author     TEXT NOT NULL,
    doc        TEXT NOT NULL,
    claim      BLOB NOT NULL,
    claimed_ms INTEGER NOT NULL,
    noted      INTEGER NOT NULL,
    PRIMARY KEY (group_id, author, doc)
);
CREATE INDEX group_public_posts_by_post ON group_public_posts (author, doc);
ALTER TABLE group_rosters ADD COLUMN public INTEGER NOT NULL DEFAULT 0;
