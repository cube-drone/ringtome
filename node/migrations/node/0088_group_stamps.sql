-- A group's fold, cached by a stamp (plans/ONE_FEED.md, slice 1, 2026-10-16). The fold is a pure
-- function of the group's lanes, so it is kept while they stand still, as the key tree is kept by
-- its chain's entry count; and what it derives - the people the door opens to, the feed's
-- journal - is written again only when the lanes have moved since, never cleared first.
--   lanes_seq    bumped whenever an entry for the group lands in group_lanes (an insert that
--                inserts nothing leaves it); the fold's stamp
--   derived_seq  the lanes_seq the derived tables were last written from; -1 asks for a rewrite
--                whatever the lanes say (a rung that changes what is derived marks every group)
-- Every group held starts underived, so the first group-sync pass after the rung writes each.
CREATE TABLE group_stamps (
    group_id BLOB PRIMARY KEY,
    lanes_seq INTEGER NOT NULL DEFAULT 0,
    derived_seq INTEGER NOT NULL DEFAULT -1
);
INSERT INTO group_stamps (group_id, lanes_seq) SELECT DISTINCT group_id, 1 FROM group_lanes;
-- Rows a derivation stamps as it writes them; afterwards it sweeps that group's older ones. A
-- derivation upserts in place, so a reader never meets an emptied table.
ALTER TABLE group_people ADD COLUMN noted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE group_journal ADD COLUMN noted INTEGER NOT NULL DEFAULT 0;
