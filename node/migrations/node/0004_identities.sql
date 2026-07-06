-- Identities owned by accounts on this node.
--
-- An identity IS its root ed25519 public key (stored hex). The private key is NOT here - it lives
-- envelope-encrypted in a key file on disk (data/keys/<pubkey>.key). This table just records that
-- this account owns this identity, filling the account -> identity link the auth layer left as a
-- seam. The materialized view of the identity's chains lives in its own per-user DB
-- (data/users/<pubkey>.db).

CREATE TABLE IF NOT EXISTS identities (
    root_pubkey   TEXT PRIMARY KEY,           -- hex-encoded ed25519 public key; the identity's name
    account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS identities_account_idx ON identities (account_id);
