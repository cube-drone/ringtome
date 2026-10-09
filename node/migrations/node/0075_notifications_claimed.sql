-- The bell's claimed stamp (2026-10-09): the winning statement's SIGNED time, beside the arrival
-- stamp `updated_ms` already keeps. Arrival is this computer's alone, and the seen watermark is
-- the persona's, synced: a computer that joins a persona late receives a year of old shares at
-- once, every one "newer" than the watermark set elsewhere, and its bell lights with old news.
-- The claim is the same on every computer, so it is what names a piece of news to the persona's
-- other computers (the `notifications_first_seen` register, routes.rs `persona_stamp`). NULL on
-- rows folded before this rung: they keep the arrival-only reading until their author's next
-- move refolds them.
ALTER TABLE notifications ADD COLUMN claimed_ms INTEGER;
