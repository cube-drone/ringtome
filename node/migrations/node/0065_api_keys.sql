-- API keys (auth/keys.rs, 2026-09-30): what an outside program signs in with as an account - a long
-- random secret it sends as `Authorization: Bearer rtk_...`. The secret itself is never stored:
-- only its blake3 hash, so this table leaking leaks no working key. A key is the account's, dies
-- with it, and is revoked by deleting its row.
--   name          what the person called it ("my backup script")
--   key_hash      blake3 of the whole key, hex - what a request's key is looked up by
--   last_used_ms  when it last signed something in (written at most once a minute)
CREATE TABLE api_keys (
    id            TEXT    PRIMARY KEY,
    account_id    TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name          TEXT    NOT NULL,
    key_hash      TEXT    NOT NULL UNIQUE,
    created_ms    INTEGER NOT NULL,
    last_used_ms  INTEGER
);
CREATE INDEX api_keys_account_idx ON api_keys (account_id);
