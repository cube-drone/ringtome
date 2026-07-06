-- Node accounts and their sessions.
--
-- An account is a login on THIS node (username + Argon2 password hash). Right now an account
-- authenticates as nothing but itself; the account -> identity link (which identities this account
-- may act as) arrives with the identity layer.
--
-- Sessions are opaque server-side tokens: a random token is the cookie value, this table is the
-- source of truth, and deleting a row is instant, authoritative logout. (Not JWTs - a single-node
-- process with local SQLite gains nothing from stateless tokens and would need this table for
-- revocation anyway.)

CREATE TABLE IF NOT EXISTS accounts (
    id             TEXT PRIMARY KEY,          -- uuid
    username       TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,             -- Argon2 PHC string
    created_at_ms  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token          TEXT PRIMARY KEY,          -- opaque high-entropy random string
    account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at_ms  INTEGER NOT NULL,
    expires_at_ms  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions (account_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at_ms);
