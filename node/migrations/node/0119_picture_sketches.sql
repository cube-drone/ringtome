-- A memory of each picture a persona put on its own list (Curtis, 2026-11-05): a list entry names
-- a picture by its hash alone, so the person keeping the list can't tell one entry from another.
-- The sketch is the picture fitted within 48x48 and dithered to black and white - enough to
-- remember what it was, not enough to go on showing it. It is the list keeper's alone: never on
-- the public list, never sent anywhere, and never kept for a quarantined picture (quarantining
-- one deletes every sketch of it). `png` is the sketch, encoded.
CREATE TABLE picture_sketches (
    root   TEXT    NOT NULL,
    hash   TEXT    NOT NULL,
    png    BLOB    NOT NULL,
    at_ms  INTEGER NOT NULL,
    PRIMARY KEY (root, hash)
);
CREATE INDEX picture_sketches_hash ON picture_sketches (hash);
