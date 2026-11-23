-- hrseAmp's trash (plans/MIXTAPES.md, section 3; 2026-11-23): the node's memo of each persona's
-- private ledger of other people's documents they threw away (trash.rs `mirror`), so the body lane
-- and the blob reaper can ask "does everyone here who follows this author not want this file?"
-- without opening anyone's database. One row per persona per document.
CREATE TABLE trashed (
    local_root TEXT NOT NULL,
    foreign_root TEXT NOT NULL,
    doc_id BLOB NOT NULL,
    at_ms INTEGER NOT NULL,
    PRIMARY KEY (local_root, foreign_root, doc_id)
);
CREATE INDEX trashed_by_author ON trashed (foreign_root, doc_id);
