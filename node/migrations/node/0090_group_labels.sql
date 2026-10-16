-- One label memo (plans/ONE_FEED.md, slice 4, 2026-10-16): a group post's labels - tags,
-- reactions, its notebook - kept in doc_annotations beside every public post's, so scores, chips
-- and the tag cloud see them, rather than in group_journal's JSON. Written by the group's fold
-- (roster.rs) from what it counted: the group lane stays the only road a group label travels.
--   group_id    the group a row's post belongs to; empty for a public post's label. A read that
--               names no reader (every public page) leaves group rows out; one that names a reader
--               admits them only for a member of the group (annotations.rs `admitted`)
--   group_mark  the group writer's mark: a group's rows it didn't write this time are swept
ALTER TABLE doc_annotations ADD COLUMN group_id BLOB NOT NULL DEFAULT x'';
ALTER TABLE doc_annotations ADD COLUMN group_mark INTEGER NOT NULL DEFAULT 0;
CREATE INDEX doc_annotations_by_group ON doc_annotations (group_id, group_mark)
    WHERE group_id <> x'';
