-- Node introductions (plans/NODE_PAGE.md, 2026-11-05). What another node said when this one
-- asked it "who are you?" - its own word, kept as last heard, with the address checked against
-- it - and the people it listed publicly. One row per node asked; the newest answer replaces the
-- last. `error` is why the last ask got no answer, NULL when it did.
CREATE TABLE machine_intros (
    endpoint_id      TEXT    PRIMARY KEY,
    asked_ms         INTEGER NOT NULL,
    answered_ms      INTEGER,
    error            TEXT,
    name             TEXT,
    version          TEXT,
    client           TEXT,
    device           TEXT,
    users            INTEGER,
    personas         INTEGER,
    address          TEXT,
    address_checked  INTEGER NOT NULL DEFAULT 0,
    description      TEXT,
    rules            TEXT
);
CREATE TABLE machine_intro_listed (
    endpoint_id TEXT NOT NULL,
    root        TEXT NOT NULL,
    PRIMARY KEY (endpoint_id, root)
);
-- What this node says of itself, set by its operator: a description, a link to its rules, and
-- whether a device node lists its people (a server lists them unless they turned listing off;
-- a device lists nobody unless its owner says so). One row, id 1, absent until first set.
CREATE TABLE node_introduction (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    description  TEXT    NOT NULL DEFAULT '',
    rules        TEXT    NOT NULL DEFAULT '',
    device_lists INTEGER NOT NULL DEFAULT 0,
    updated_ms   INTEGER NOT NULL
);
