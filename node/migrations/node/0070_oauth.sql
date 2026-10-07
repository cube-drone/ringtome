-- OAuth for AI assistants (oauth.rs, plans/MCP.md Slice 5, 2026-10-06): the node is its own
-- authorization server, and the token it issues is an ordinary API key (auth/keys.rs).

-- Clients that registered themselves (RFC 7591, Dynamic Client Registration): an id this node
-- minted, the name the client gave, and the redirect URIs a code may be sent to. A client known by
-- a Client ID Metadata Document needs no row - its id is the URL that describes it.
CREATE TABLE oauth_clients (
    client_id     TEXT    PRIMARY KEY,
    name          TEXT    NOT NULL,
    redirect_uris TEXT    NOT NULL,   -- a JSON array of strings
    created_ms    INTEGER NOT NULL
);

-- Authorization codes between the consent and the token request: kept only by their hash, single
-- use, minutes long. What the consent was for rides with it, so the token request is checked
-- against exactly that - the client, where the code went, and the PKCE challenge.
CREATE TABLE oauth_codes (
    code_hash      TEXT    PRIMARY KEY,
    client_id      TEXT    NOT NULL,
    client_name    TEXT    NOT NULL,
    redirect_uri   TEXT    NOT NULL,
    code_challenge TEXT    NOT NULL,
    account_id     TEXT    NOT NULL,
    expires_ms     INTEGER NOT NULL
);
