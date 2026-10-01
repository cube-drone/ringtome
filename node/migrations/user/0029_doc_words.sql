-- The length tags (Curtis, 2026-10-01): each document's search row also carries how many words its
-- body holds - NULL for anything that isn't words (a picture, a drawing) - so a note's implicit
-- "micro" / "short" / "medium" / "long" tag is a column read when its list row is built, never a
-- body decrypt. The rows are a memo over the chains, rebuilt on read by fingerprint; emptying them
-- makes the next read re-index every document once, counting as it goes.
ALTER TABLE doc_search ADD COLUMN words INTEGER;
DELETE FROM doc_search;
