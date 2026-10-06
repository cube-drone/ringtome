-- hrseCommodities' weather (commodities.rs, plans/COMMODITIES.md, 2026-10-06): one row per UTC day
-- (days since 1970-01-01) per signal, counted once off the node's public feed - posts, drawings,
-- words, glad and sour reactions, chat messages - plus `follows`, a snapshot of how many follows
-- name the feed's personas, whose growth is the horseshoes' signal. The nudge reads a month of
-- these and nothing else, so a price never walks the big tables.
CREATE TABLE commodity_days (
    day        INTEGER NOT NULL,
    signal     TEXT    NOT NULL,
    value      INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL,
    PRIMARY KEY (day, signal)
);
