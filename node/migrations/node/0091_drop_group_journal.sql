-- One feed (plans/ONE_FEED.md, slice 3, 2026-10-16): a group post's rows live in feed_journal
-- now, with its group in `group_id` (rung 89); its labels in doc_annotations (rung 90); its words
-- in the search index, read through the group's lanes. The separate journal of rungs 86 and 87
-- goes, and every group is marked for its tables to be written again, so the first group-sync
-- pass after the rung puts its posts into feed_journal.
DROP TABLE group_journal;
UPDATE group_stamps SET derived_seq = -1;
