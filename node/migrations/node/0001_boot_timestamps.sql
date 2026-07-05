-- Node-level boot history. Local-only diagnostic (never exposed over the network - see the
-- privacy note on boot timestamps). Recording a boot also exercises the write path on startup.
CREATE TABLE IF NOT EXISTS boot_timestamps (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    booted_at_ms INTEGER NOT NULL,
    app_version  TEXT NOT NULL
);
