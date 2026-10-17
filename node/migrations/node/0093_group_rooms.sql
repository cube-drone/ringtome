-- Group rooms (plans/GROUP_ROOMS.md, 2026-10-16): a room posted to a group is a room post on its
-- author's lane for the group, found by the chat lane here - its header, the hash of its first
-- version (what the room's live topic is derived from), and when this node first saw it closed.
-- Written by the group's derivation beside its other tables and swept as they are, so every group
-- is marked for its tables to be written again.
CREATE TABLE group_rooms (
    room_author TEXT NOT NULL,
    room_doc TEXT NOT NULL,
    group_id BLOB NOT NULL,
    first_hash BLOB NOT NULL,
    header BLOB NOT NULL,
    closed_ms INTEGER,
    noted INTEGER NOT NULL,
    PRIMARY KEY (room_author, room_doc)
);
CREATE INDEX group_rooms_by_doc ON group_rooms (room_doc);
CREATE INDEX group_rooms_by_group ON group_rooms (group_id);
UPDATE group_stamps SET derived_seq = -1;
