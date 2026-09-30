-- HorseBucks' ledger (bank.rs, HORSE_BASED_CURRENCIES.md, 2026-09-29): one line per thing that
-- earned, keyed by what it was (`kind` names the source, `source` the record: a document version, a
-- chat line, a heartbeat's date, a subject's root) so the same record never pays twice and two of a
-- persona's computers holding the same records hold the same lines. Paid lines are kept, never
-- recomputed: some sources are pruned later (old chat, withdrawn edges), and what was earned stays
-- earned. `pennies` are horsepennies, a hundredth of a HorseBuck; `detail` is the line's own
-- explanation (JSON), so hrseBank can show where each amount came from.
CREATE TABLE bank_lines (
    kind     TEXT    NOT NULL,
    source   TEXT    NOT NULL,
    currency TEXT    NOT NULL DEFAULT 'horsebucks',
    pennies  INTEGER NOT NULL,
    at_ms    INTEGER NOT NULL,
    detail   TEXT    NOT NULL DEFAULT '{}',
    PRIMARY KEY (kind, source)
);
CREATE INDEX bank_lines_by_time ON bank_lines (at_ms);
