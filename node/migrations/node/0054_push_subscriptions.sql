-- Web Push subscriptions (webpush.rs, 2026-09-25): one row per browser that asked this node to
-- notify one persona while no tab is open. The endpoint is the browser vendor's push-service URL
-- for that browser (it names the browser, not the persona - a browser subscribed for two personas
-- has two rows); p256dh and auth are the browser's public key and secret that every payload is
-- encrypted to (RFC 8291). A push answered 404 or 410 deletes its row: the browser let go.
CREATE TABLE push_subscriptions (
    root_pubkey  TEXT    NOT NULL,
    endpoint     TEXT    NOT NULL,
    p256dh       BLOB    NOT NULL,   -- 65 bytes, uncompressed P-256 point
    auth         BLOB    NOT NULL,   -- 16 bytes
    created_ms   INTEGER NOT NULL,
    last_ok_ms   INTEGER,            -- the last push the service accepted
    PRIMARY KEY (root_pubkey, endpoint)
);
