-- Picture entries on moderation lists (plans/SCANNING.md, _Community picture entries_,
-- 2026-11-02): a picture entry carries its PDQ fingerprint beside its hash, hex. Refolded, because
-- a build from before this rung skipped picture entries it couldn't read and moved its watermark
-- past them.
ALTER TABLE moderation_entries ADD COLUMN pdq TEXT;
