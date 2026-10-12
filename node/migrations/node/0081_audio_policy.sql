-- Whether this node publishes and carries tagged audio (rights.rs, plans/AUDIO.md section 8, ruling
-- 17): the node administrator's choice, one row at most. No row means yes; with `tagged` 0, a post
-- carrying a song whose artist or album is set is refused at publish, for everyone on this node.
--   tagged      1 or 0
CREATE TABLE audio_policy (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    tagged      INTEGER NOT NULL,
    updated_ms  INTEGER NOT NULL
);
