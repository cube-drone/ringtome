-- The colourway a stranger sees (frontdoor.rs; Curtis, 2026-11-22: "the ability for the server
-- administrator to choose a colorway for the external-facing site"): one of the app's colourway
-- names (js/colorway.js), worn by everyone who isn't signed in - on every page but a person's own,
-- which wears theirs. NULL, as for the name and the taglines, is the app's own.
ALTER TABLE front_door ADD COLUMN colorway TEXT;
