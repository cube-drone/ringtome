-- Storage by kind (storage.rs, 2026-11-20): a persona's files split by what they are - pictures,
-- video, audio, writing - and by lane, for the Storage page. Each is NULL until the persona is
-- next tallied; whatever the four kinds leave of files_bytes is of a kind the node does not name,
-- and whatever public_bytes leaves of it is private.
ALTER TABLE persona_storage ADD COLUMN pictures_bytes INTEGER;
ALTER TABLE persona_storage ADD COLUMN video_bytes INTEGER;
ALTER TABLE persona_storage ADD COLUMN audio_bytes INTEGER;
ALTER TABLE persona_storage ADD COLUMN writing_bytes INTEGER;
ALTER TABLE persona_storage ADD COLUMN public_bytes INTEGER;
-- Every tally was taken before the split: mark them all as moved, and the storage beat retakes
-- them a few at a time.
UPDATE persona_storage SET files_mtime_ms = 0;
