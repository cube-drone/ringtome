-- The ledger's memory (2026-10-13): where its last pass stopped, so a pass reads what's new since
-- and not the persona's whole history. `bank_marks` holds a mark by name - `versions`, the last
-- `doc_versions` row a pass read (its rowid, and that row's hash, so a rebuilt table is noticed);
-- `rules`, the rules the lines were paid under; `pending_ms`, when the waiting documents were last
-- tried. `bank_pending` is the documents a pass couldn't pay yet (a body still arriving, a parent
-- it can't read), tried again until they pay. No backfill: a persona with no marks walks
-- everything once, as every pass did before.
CREATE TABLE bank_marks (
    name TEXT    PRIMARY KEY,
    mark INTEGER NOT NULL,
    hash BLOB
);
CREATE TABLE bank_pending (
    doc_id BLOB PRIMARY KEY
);
