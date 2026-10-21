-- The sign-up group (Curtis, 2026-10-20): a real group (plans/GROUPS.md) that every persona made on
-- this node joins, chosen by an administrator through one of their own personas that owns it -
-- whose key signs each newcomer's invite. One row or none. It replaces the old "group server"
-- (a group name on the sign-up limits, pairing every joiner with every member by contact dials),
-- whose name column goes; `group_members` stays, for whom those pairings already made (bank.rs).
CREATE TABLE signup_group (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    group_id BLOB    NOT NULL,
    owner    TEXT    NOT NULL,
    set_ms   INTEGER NOT NULL
);
ALTER TABLE registration_limits DROP COLUMN group_name;
