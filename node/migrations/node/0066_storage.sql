-- Storage accounting (storage.rs, 2026-10-02): how much each persona held here costs to move and
-- would free to evict, kept as running memos so no read ever walks a persona's history.
--   blob_sizes       a blob's size, by its hash - a hash names its bytes, so a size is measured
--                    once, ever (from the blob store's metadata, never the bytes)
--   persona_blobs    which blobs each persona's documents name, every version; a persona's rows
--                    are rewritten by difference when its tally runs. Indexed by hash, for "does
--                    anyone else name this?" - what evicting the persona would free
--   persona_storage  each persona's last tally: its files' total, its database files' total, and
--                    the mtime of those files when it was taken - a tally is retaken only after
--                    they move
CREATE TABLE blob_sizes (
    hash   BLOB    PRIMARY KEY,
    bytes  INTEGER NOT NULL
);
CREATE TABLE persona_blobs (
    root_pubkey  TEXT NOT NULL,
    hash         BLOB NOT NULL,
    PRIMARY KEY (root_pubkey, hash)
);
CREATE INDEX persona_blobs_by_hash ON persona_blobs (hash);
CREATE TABLE persona_storage (
    root_pubkey     TEXT    PRIMARY KEY,
    files_bytes     INTEGER NOT NULL,
    db_bytes        INTEGER NOT NULL,
    files_mtime_ms  INTEGER NOT NULL,
    tallied_ms      INTEGER NOT NULL
);
