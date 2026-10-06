-- HorseBucks are bigints (2026-10-06): HORSE_BASED_CURRENCIES.md settled an exact bigint balance on
-- 2026-09-29, and the ledger kept each line's amount as a 64-bit INTEGER all the same - which a
-- trader compounding the commodities' arbitrage outgrows within a year. A line's `pennies` is now
-- a decimal string, read and summed in bank.rs as a bigint; SQLite has no wider integer, and an
-- INTEGER column handed a number past 64 bits keeps it as a float, rounding pennies away. The
-- table is rebuilt to change the column, its rows copied as they are.
CREATE TABLE bank_lines_bigint (
    kind     TEXT NOT NULL,
    source   TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'horsebucks',
    pennies  TEXT NOT NULL,
    at_ms    INTEGER NOT NULL,
    detail   TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (kind, source)
);
INSERT INTO bank_lines_bigint (kind, source, currency, pennies, at_ms, detail)
    SELECT kind, source, currency, CAST(pennies AS TEXT), at_ms, detail FROM bank_lines;
DROP INDEX bank_lines_by_time;
DROP TABLE bank_lines;
ALTER TABLE bank_lines_bigint RENAME TO bank_lines;
CREATE INDEX bank_lines_by_time ON bank_lines (at_ms);
