-- Who may make an account here (registration.rs, 2026-09-25): the node administrator's choice,
-- one row at most. No row means the default for the kind of node this is - open for a server,
-- closed for a device (a desktop app hosts only its owner until they open it up).
--   mode           'open', 'password' (a shared sign-up password) or 'closed'
--   password_hash  the sign-up password, Argon2 PHC; set whenever mode is 'password'
CREATE TABLE registration_policy (
    id             INTEGER PRIMARY KEY,
    mode           TEXT    NOT NULL,
    password_hash  TEXT,
    updated_ms     INTEGER NOT NULL
);
