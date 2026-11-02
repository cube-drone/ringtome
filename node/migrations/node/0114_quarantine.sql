-- What this node's operator quarantined (quarantine.rs, plans/SCANNING.md): one row per blob,
-- sealed - kept, never read, fetched, stored again or served - until released. A released row
-- stays, with when and by whom, as the record of what the node held and did.
--   hash           the blob's content hash, hex
--   author, doc_id the picture it was quarantined as, hex, when it was named that way
--   why            the operator's own note
--   by_account     who quarantined it
--   released_ms    when it was released, NULL while sealed
CREATE TABLE quarantine (
    hash            TEXT PRIMARY KEY,
    author          TEXT,
    doc_id          TEXT,
    why             TEXT NOT NULL DEFAULT '',
    by_account      TEXT NOT NULL,
    quarantined_ms  INTEGER NOT NULL,
    released_ms     INTEGER,
    released_by     TEXT
);
