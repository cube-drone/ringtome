-- Public groups, slice 3 (plans/PUBLIC_GROUPS.md, 2026-10-17): what this node's derivation carried
-- of a public group's public posts, and through whom - a member whose rebroadcast-followers live
-- here gets the group's other members' public posts journaled with them as the via. Kept so a
-- carry that ends (an owner hid the post, or removed its author) withdraws exactly the rows it
-- made, and swept by group as the group's other tables are.
CREATE TABLE group_carries (
    group_id BLOB NOT NULL,
    via      TEXT NOT NULL,
    author   TEXT NOT NULL,
    doc      TEXT NOT NULL,
    noted    INTEGER NOT NULL,
    PRIMARY KEY (group_id, via, author, doc)
);
