-- The journal's time order, as an index the feed can walk (2026-09-27, the timing check behind
-- PROJECT_PLAN's Scores and sort orders, *Shape*): the feed pages newest first with ties broken by
-- document id, and the old (reader_root, published_ms) index could not give that order, so every
-- page read the reader's whole journal and sorted it - 3 s a page at 131,072 posts, under half a
-- millisecond on this. The ties now fall newest-id first too, one direction, which this walks
-- backwards without a sort. The old index is a prefix of this one, and goes.
CREATE INDEX feed_journal_by_time ON feed_journal (reader_root, published_ms, doc_id);
DROP INDEX feed_journal_by_reader;
