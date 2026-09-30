-- A persona's last heartbeat beside its name, picture and banner in the byline cache (2026-09-29,
-- Curtis: "the ability to see the time of the last Heartbeat of a user on their user card: we can
-- also sort the People page by 'recent activity'"). A UTC date (`2026-09-29`), never a time; public
-- like the rest of the row - it's the profile's own `heartbeat` field. Existing rows learn it when
-- the persona's public lane next moves, which a heartbeat itself does.
ALTER TABLE persona_profiles ADD COLUMN last_active TEXT;
