-- M3: multi-node identity plumbing.

-- Which key this node signs with for each identity it agents. The creating node's key is the
-- root itself (existing rows fall back to root_pubkey when NULL); a node added later signs with
-- the leaf key it was granted in the add-a-node ceremony.
ALTER TABLE identities ADD COLUMN leaf_pubkey TEXT;

-- Known peers per identity: the other nodes agenting (or later, fronting) it. Addresses are a
-- JSON array of socket-address strings - direct reachability for presets::Minimal; when pkarr
-- lands, records refresh these.
CREATE TABLE identity_peers (
    root_pubkey    TEXT    NOT NULL,
    endpoint_id    TEXT    NOT NULL,  -- iroh endpoint id (z32); transport identity, never an identity key
    addrs          TEXT    NOT NULL,  -- JSON array of "ip:port" strings
    added_at_ms    INTEGER NOT NULL,
    last_synced_ms INTEGER,
    PRIMARY KEY (root_pubkey, endpoint_id)
);

-- Adoption handshakes awaiting their grant code: the leaf keypair is minted (and sealed in the
-- keystore) at `begin`; the row links it to the requesting account until `complete` promotes it
-- into `identities` (or it is abandoned).
CREATE TABLE pending_adoptions (
    leaf_pubkey   TEXT    PRIMARY KEY,
    account_id    TEXT    NOT NULL,
    created_at_ms INTEGER NOT NULL
);
