-- The network's daily actives, as this node estimates them (census.rs, 2026-09-29): one row per
-- UTC day (days since 1970-01-01), its HyperLogLog sketch (1,024 one-byte registers, gossiped and
-- merged by per-register maximum; emptied once the day is a few days old) and its estimate, kept
-- for the front page's graph. Registers are maxima of root hashes: the table names nobody.
CREATE TABLE census_days (
    day        INTEGER PRIMARY KEY,
    registers  BLOB    NOT NULL,
    estimate   INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL
);
