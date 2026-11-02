-- Picture entries on moderation lists (plans/SCANNING.md, _Community picture entries_,
-- 2026-11-02). The memo of what moderators say carries a picture entry's PDQ fingerprint, hex;
-- no row before this rung is a picture, so NULL is every existing row's true value.
ALTER TABLE moderation_said ADD COLUMN pdq TEXT;
-- Every public picture's fingerprint, worked out once and kept by blob hash (prints.rs): `pdq`
-- NULL for a blob that isn't a picture, or that didn't decode.
CREATE TABLE picture_prints (
    hash    BLOB    PRIMARY KEY,
    pdq     TEXT,
    quality INTEGER NOT NULL,
    at_ms   INTEGER NOT NULL
);
