-- Whether this node takes imports (import.rs, 2026-10-09): the node administrator's choice, one row
-- at most. No row means the default for the kind of node this is - closed for a server, open for a
-- device. Curtis: "by and large the direction we want is for users to export their personas from
-- servers to personal devices and not the other way around" - an import is a whole persona's
-- worth of upload and work, which a server should take on only by its operator's choice.
--   allowed     1 or 0
CREATE TABLE import_policy (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    allowed     INTEGER NOT NULL,
    updated_ms  INTEGER NOT NULL
);
