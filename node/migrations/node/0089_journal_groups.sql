-- One feed (plans/ONE_FEED.md, slice 2, 2026-10-16): group posts are to journal in feed_journal
-- beside every other post, rather than in a table of their own (group_journal, rung 86), so every
-- view the feed has sees them. A group post is its own document - its id is never a public
-- post's - so the key stays as it is, and these are ordinary columns, empty on every public row.
--   group_id   the group a group post was posted to; empty for a public post. The public road's
--              maintenance (fanout.rs) touches only rows where it is empty
--   hidden     an owner hid it from the group; only owners and its author have the row
--   owns       the reader owns the group, so the card offers the hide
--   noted      the group writer's mark: rows of a group it didn't write this time are swept
ALTER TABLE feed_journal ADD COLUMN group_id BLOB NOT NULL DEFAULT x'';
ALTER TABLE feed_journal ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feed_journal ADD COLUMN owns INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feed_journal ADD COLUMN noted INTEGER NOT NULL DEFAULT 0;
-- A group's own posts, newest first, for one reader: the group's page and a group pick.
CREATE INDEX feed_journal_by_group ON feed_journal (reader_root, group_id, published_ms, doc_id);
