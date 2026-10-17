-- The bell for a group's labels (plans/GROUPS.md, section 7; 2026-10-17): a member mentioned in a
-- group post, or a member's group post labelled, hears it in the bell, folded from the group's
-- lanes this node already holds - every member's node holds them, so the group is the reader's
-- follow and no envelope is needed. A lane entry keeps its signed time and when it reached this
-- node, which the bell stamps its rows with; NULL on entries taken before this rung, which are old
-- news and never rung. A bell row names the group it is about.
ALTER TABLE group_lanes ADD COLUMN claimed_ms INTEGER;
ALTER TABLE group_lanes ADD COLUMN arrived_ms INTEGER;
ALTER TABLE notifications ADD COLUMN group_id BLOB;
CREATE INDEX notifications_by_group ON notifications (group_id) WHERE group_id IS NOT NULL;
