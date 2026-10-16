-- Group posts in the feed (plans/GROUPS.md, slice 4b, 2026-10-15): each hosted member's view of
-- each group's posts, written whenever the group refolds, owned by roster.rs. Its own table, never
-- rows in feed_journal: other surfaces read that one, and a public surface can't list a group post
-- that was never in its tables (slice 2's rule). The feed merges the two at read.
--   reader_root  a member hosted here; the rows are what they may see (not hidden from them)
--   version      the shown version's hash, so an unchanged post keeps its tokens unread
--   tokens       its words for the search (search.rs `tokens_of`)
--   labels       its labels as they stand, JSON [{annotator, key, value}]
CREATE TABLE group_journal (
    reader_root TEXT NOT NULL,
    group_id BLOB NOT NULL,
    group_name TEXT NOT NULL,
    author_root TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    title TEXT NOT NULL,
    format TEXT NOT NULL,
    published_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL,
    version BLOB NOT NULL,
    tokens TEXT NOT NULL,
    labels TEXT NOT NULL,
    PRIMARY KEY (reader_root, group_id, doc_id)
);
CREATE INDEX group_journal_by_time ON group_journal (reader_root, published_ms, doc_id);
