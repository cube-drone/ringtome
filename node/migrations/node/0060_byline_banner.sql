-- A persona's banner beside its name and picture in the byline cache (2026-09-28, Curtis: the
-- People app's rows wear their banners). Public like the other two - the /id face already serves
-- it to strangers. Existing rows learn theirs when the persona's public lane next moves, which is
-- when profiles.rs refreshes a byline; until then a row shows the persona's tiled pattern.
ALTER TABLE persona_profiles ADD COLUMN banner TEXT;
