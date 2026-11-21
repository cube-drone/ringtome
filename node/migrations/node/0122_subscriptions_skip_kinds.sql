-- "Do not sync images / audio / video from this user" (2026-11-20, the relationship panel's
-- storage section): which kinds of a followed persona's files the follower declines, as bits
-- (storage::Kind::skip_bit - pictures 1, video 2, audio 4). A routing fact like interest, read
-- from the follower's own contact ledger. No backfill: nobody has declined anything yet, and the
-- memo rewrites each persona's rows from their ledger on its next refresh.
ALTER TABLE subscriptions ADD COLUMN skip_kinds INTEGER NOT NULL DEFAULT 0;
