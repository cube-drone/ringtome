-- Pins in a group (plans/GROUPS.md, slice 4d, 2026-10-16): owners and members both pin any post;
-- owners' pins show above members'. The fold keeps the two layers (proto roster `owner_pins`,
-- `member_pins`); a group post's journal row says which holds it, for its page and its card.
--   pin   0 not pinned, 1 pinned by a member, 2 pinned by an owner; 0 on every public row
ALTER TABLE feed_journal ADD COLUMN pin INTEGER NOT NULL DEFAULT 0;
UPDATE group_stamps SET derived_seq = -1;
