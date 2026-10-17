-- Replies in a group (plans/GROUPS.md, section 7; 2026-10-17): a reply to a group post is a group
-- post whose header names its parent, on the replier's lane for the group. The node's one replies
-- memo holds its link, marked with its group, so a group's thread, counts and "in reply to" cards
-- are the public ones' - and every public read of the memo asks for rows with no group, so no
-- public door ever serves one. Written by the group's derivation and swept by group, never by the
-- public fold's per-author sweep.
ALTER TABLE post_replies ADD COLUMN group_id BLOB;
CREATE INDEX post_replies_by_group ON post_replies (group_id) WHERE group_id IS NOT NULL;
