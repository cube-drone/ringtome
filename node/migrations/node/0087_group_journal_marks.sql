-- A group post in the feed wears the same card as any other (Curtis, 2026-10-16: the group page
-- lists the feed's own posts, narrowed to the group), so its journal row carries what that card
-- says and does. Every row before this rung takes the defaults until its group next refolds, which
-- the sync pass does to every group it keeps.
--   hidden      an owner hid it from the group; only owners and its author still have the row
--   owns        the reader is one of the group's owners, so the card offers hide and show
--   settled     the author turned comments off
--   dated_ms    its claimed date, when one was claimed (PUBLISH.md); published_ms is that or
--               minted_ms
--   minted_ms   when it was first written down (its first version's genesis)
ALTER TABLE group_journal ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE group_journal ADD COLUMN owns INTEGER NOT NULL DEFAULT 0;
ALTER TABLE group_journal ADD COLUMN settled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE group_journal ADD COLUMN dated_ms INTEGER;
ALTER TABLE group_journal ADD COLUMN minted_ms INTEGER NOT NULL DEFAULT 0;
