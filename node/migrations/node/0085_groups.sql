-- Groups (plans/GROUPS.md, slice 1b, 2026-10-15). A group is its members' lanes - one chain per
-- (device, GROUP, group id) on each member's own persona - and these are the node's memos of
-- them, all owned by roster.rs. The lanes live in each member's database like any chain; the
-- memo copies their group entries here so the roster folds without opening a database per
-- member.
--   group_lanes    every entry held on a group lane - group entries, and the documents posted
--                  to the group (a post's versions and takedowns) - by lane: the fold's input
--   group_rosters  each group this node holds a valid founding for, and its name
--   group_people   who the group's door opens to: members, owners and the invited, as last folded
--   group_peers    endpoints that have served this group, and the persona each proved it speaks
--                  for ('' when it only answered)
--   group_drafts   what a hosted persona's own document became in a group: a draft's post, a
--                  picture's media document - so publishing again is an edit, and a picture
--                  posted twice is minted once
CREATE TABLE group_lanes (
    group_id BLOB NOT NULL,
    persona TEXT NOT NULL,
    device BLOB NOT NULL,
    seq INTEGER NOT NULL,
    hash BLOB NOT NULL,
    entry_type INTEGER NOT NULL,
    body BLOB NOT NULL,
    PRIMARY KEY (group_id, device, seq)
);
CREATE TABLE group_rosters (
    group_id BLOB PRIMARY KEY,
    name TEXT NOT NULL,
    founder TEXT NOT NULL,
    folded_ms INTEGER NOT NULL
);
CREATE TABLE group_people (
    group_id BLOB NOT NULL,
    root TEXT NOT NULL,
    standing TEXT NOT NULL,
    PRIMARY KEY (group_id, root)
);
CREATE INDEX group_people_by_root ON group_people (root);
CREATE TABLE group_peers (
    group_id BLOB NOT NULL,
    endpoint_id TEXT NOT NULL,
    root TEXT NOT NULL,
    heard_ms INTEGER NOT NULL,
    PRIMARY KEY (group_id, endpoint_id, root)
);
CREATE TABLE group_drafts (
    root TEXT NOT NULL,
    source BLOB NOT NULL,
    group_id BLOB NOT NULL,
    post BLOB NOT NULL,
    PRIMARY KEY (root, source, group_id)
);
