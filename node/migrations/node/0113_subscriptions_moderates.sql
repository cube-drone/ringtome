-- Trusting someone to moderate is a routing fact (plans/MODERATION.md, 2026-11-02): the reader
-- needs their list kept current, as a follow needs their posts, so the subscription memo carries
-- it and a moderator is held and synced like any persona someone here dials. No backfill: the
-- memo rewrites each persona's rows from their ledger on its next refresh, and a moderates-only
-- relationship gains its row then.
ALTER TABLE subscriptions ADD COLUMN moderates INTEGER NOT NULL DEFAULT 0;
