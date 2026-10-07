-- The feeds' sealed posts, newest arrival first (the 2026-10-07 plan audit): the key prefetch
-- asks for the newest trusted-only rows in every reader's journal on each pass
-- (fanout.rs `sealed_rows`), and with nothing indexing them that was a scan of the whole
-- journal and a sort of what it found. A partial index of the trusted-only rows alone, in
-- arrival order, lets the pass read its first rows and stop - and costs a public post's
-- fan-out nothing.
CREATE INDEX feed_journal_sealed ON feed_journal (arrived_ms DESC) WHERE trusted_only = 1;
