-- Simple string tags on accounts. First use: `node_admin`, marking the account(s) responsible for
-- managing this node. Kept deliberately generic (arbitrary string tags) so new capability/role
-- markers can be added without schema changes.

CREATE TABLE IF NOT EXISTS account_tags (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    tag        TEXT NOT NULL,
    PRIMARY KEY (account_id, tag)   -- also the (account_id, tag) lookup index; prevents dup tags
);

-- Supports "which accounts have tag X" (e.g. list node_admins).
CREATE INDEX IF NOT EXISTS account_tags_tag_idx ON account_tags (tag);
