-- The rooms in feeds (the 2026-10-07 plan audit): the room pulse asks for every room row in
-- every reader's journal once a minute (fanout.rs `rooms_in_feeds`), and with no index naming
-- the format that was a scan of the whole journal - the node's largest table - to find the few
-- rows that are rooms. A PARTIAL index holds only those rows, so a post's fan-out, which writes
-- the journal hardest, pays nothing for it.
CREATE INDEX feed_journal_rooms ON feed_journal (author_root, doc_id) WHERE format = 'room';
