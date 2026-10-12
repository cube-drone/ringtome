-- An hour's key (auth/keys.rs, 2026-10-11): one key makes another, for an agent's work that its
-- tools don't reach. The made key is the maker's child: it stops working an hour after it's made,
-- or the moment its parent is revoked, and it can't make keys of its own.
--   parent_id   the key that made it; NULL for a key made from a browser or by an assistant's
--               connection
--   expires_ms  when it stops working; NULL for a key that lasts until it's revoked
--   by_agent    1 when an agent's tool made it (mcp.rs): what it writes says "ai-agent", as the
--               tool's own writes do (made_with.rs)
ALTER TABLE api_keys ADD COLUMN parent_id TEXT;
ALTER TABLE api_keys ADD COLUMN expires_ms INTEGER;
ALTER TABLE api_keys ADD COLUMN by_agent INTEGER NOT NULL DEFAULT 0;
CREATE INDEX api_keys_parent_idx ON api_keys (parent_id);
