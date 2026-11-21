-- "Delete existing images / audio / video" (2026-11-21, beside each "do not sync" switch): of the
-- kinds a follower declines (skip_kinds, rung 0122), the ones whose files already here they asked
-- to have deleted - the same bits. The blob reaper stops counting those files as that persona's,
-- so its next round collects whatever nothing else on the node still holds.
ALTER TABLE subscriptions ADD COLUMN purge_kinds INTEGER NOT NULL DEFAULT 0;
