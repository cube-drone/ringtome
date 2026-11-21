-- When "existing images will be deleted soon" may say "deleted" (2026-11-21): of the kinds a
-- follower asked to have deleted (purge_kinds, rung 0123), the ones a round of the blob reaper has
-- run for since - the same bits. The reaper writes it; a purge taken back clears its bit, so
-- asking again waits for a round again.
ALTER TABLE subscriptions ADD COLUMN swept_kinds INTEGER NOT NULL DEFAULT 0;
