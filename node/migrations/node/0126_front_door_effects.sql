-- The effects a stranger sees (frontdoor.rs; Curtis, 2026-11-22: "can the site operator set the
-- outward facing CRT and snowflake settings?"), beside the colourway of rung 0125: the CRT screen
-- and the snow, each 1 for on, 0 for off, and NULL for the app's own - the CRT on, no snow. Worn
-- by everyone who isn't signed in; a persona's own choices are their own (js/crtpref.js).
ALTER TABLE front_door ADD COLUMN crt INTEGER;
ALTER TABLE front_door ADD COLUMN snow INTEGER;
