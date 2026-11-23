-- The trash, for a group's documents (plans/MIXTAPES.md, section 3; 2026-11-23): a row for a
-- mixtape or a song posted in a group names the group. Such a file goes when every member of the
-- group hosted here threw it away (trash.rs `group_trashed`) - a different question from a public
-- document's, which asks everyone here who follows its author. NULL for a public document.
ALTER TABLE trashed ADD COLUMN group_id BLOB;
