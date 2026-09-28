-- The feed's journal readers, rebuilt for a million-row journal (PROJECT_PLAN's Scores and sort
-- orders, Shape, 2026-09-27): every reader of the journal filters in SQL on an index, where it used
-- to take the newest 5000 rows and filter in memory.
--
-- A tag that is one emoji - a reaction - is flagged as the memo notes it (annotations.rs, the one
-- regex, `is_emoji_tag`), since SQL cannot tell: a post's own author reacting to it is dropped from
-- every count (annotations.rs `bounded`). Rows noted before this rung stay 0 - there are no users
-- yet, and a dev node's old rows only miscount their author's own reactions.
ALTER TABLE doc_annotations ADD COLUMN emoji INTEGER NOT NULL DEFAULT 0;

-- A kind of post out of a reader's journal - rooms, for the chats column and "chat with them" -
-- without walking the rest of it.
CREATE INDEX feed_journal_by_format ON feed_journal (reader_root, format, published_ms);
