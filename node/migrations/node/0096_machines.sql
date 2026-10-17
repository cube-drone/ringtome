-- The machine table (plans/NETWORK.md, 2026-10-17): every machine this node has connected with,
-- either way, by endpoint id - durable, so a restart remembers which machines answer, and shared by
-- every kind of sync. Written by the machine book's flush (machines.rs), never on the connect path.
--
--   name, version     what the machine last announced in a Hello; NULL until it has said one
--   first_seen_ms     its first connection, either way
--   last_ok_ms        the last outbound connect that worked
--   last_fail_ms      the last that didn't, and `last_error` what it said
--   last_inbound_ms   the last time it dialed this node
--   oks, fails        decayed counts of outbound connects, in thousandths: a recent history,
--                     not a lifetime's
--   connect_ms        a running average of how long a connect took, in whole milliseconds
CREATE TABLE machines (
    endpoint_id     TEXT PRIMARY KEY,
    name            TEXT,
    version         TEXT,
    first_seen_ms   INTEGER NOT NULL,
    last_ok_ms      INTEGER,
    last_fail_ms    INTEGER,
    last_error      TEXT,
    last_inbound_ms INTEGER,
    oks             INTEGER NOT NULL DEFAULT 0,
    fails           INTEGER NOT NULL DEFAULT 0,
    connect_ms      INTEGER
);

-- Which protocols touched a machine, and when: sync, fragment, deliver, blob, adopt, gossip. Only
-- protocols - never which persona or group an exchange was for (ruling 3).
CREATE TABLE machine_lanes (
    endpoint_id TEXT NOT NULL,
    alpn        TEXT NOT NULL,
    last_ms     INTEGER NOT NULL,
    PRIMARY KEY (endpoint_id, alpn)
);

-- The name this node's operator gave it on the Network page, which wins over RINGTOME_NODE_NAME
-- and the hostname. One row, or none.
CREATE TABLE node_name (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    name       TEXT NOT NULL,
    updated_ms INTEGER NOT NULL
);
