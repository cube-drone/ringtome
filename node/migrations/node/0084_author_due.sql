-- When the persona's own machinery is next owed the staleness pull (plans/CROWD.md, ruling 6,
-- 2026-10-12). A followed persona with holders is refreshed from a holder; a holder can only
-- hold back, never forge, so once the author has gone about six hours unasked the pull goes to
-- the persona's own nodes instead. Set whenever the author's word arrives - a fetch the own
-- round won, or a push proven by member proof - to that moment plus six hours, give or take a
-- quarter, drawn fresh each time so a burst of newcomers doesn't come back to the author
-- together.
--   author_due_ms   0 (every row before this rung) means owed now
ALTER TABLE foreign_fetches ADD COLUMN author_due_ms INTEGER NOT NULL DEFAULT 0;
