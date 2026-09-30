-- The Writer's Links column (2026-10-01): each document's search row also carries the links its
-- body makes - a JSON array of {to, text, doc?}, `doc` set when the target is one of the persona's
-- own documents - so the browser reads a note's outgoing links off its own row and its incoming
-- links by inverting everyone else's. The rows are a memo over the chains, rebuilt on read by
-- fingerprint; emptying them makes the next read re-index every document once, links and all.
ALTER TABLE doc_search ADD COLUMN links TEXT NOT NULL DEFAULT '[]';
DELETE FROM doc_search;
