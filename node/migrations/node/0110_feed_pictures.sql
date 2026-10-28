-- Feed pictures through the node (plans/RSS.md, slice 7, 2026-10-28): a feed item's pictures are
-- fetched by the node, crushed to its own formats and kept as public blobs, so a reader's browser
-- never loads one from the feed's site, and no tracking pixel learns who read what. Owned by
-- feedreader.rs.
--
-- rss_pictures        one picture at one web address, whoever's items embed it: `key` the first
--                     sixteen bytes of the BLAKE3 of the address, in hex - the address the app
--                     asks for it by; status pending, ready (hash, format, width, height), dropped
--                     (a tracking pixel) or failed (error) - an item shows any but a ready one as
--                     a link to where it came from
-- rss_item_pictures   which pictures an item embeds, its first twenty: when no item embeds a
--                     picture any more, its row goes and the blob reaper takes its bytes
CREATE TABLE rss_pictures (
    key        TEXT PRIMARY KEY,
    source_url TEXT NOT NULL UNIQUE,
    status     TEXT NOT NULL,
    hash       BLOB,
    format     TEXT,
    width      INTEGER,
    height     INTEGER,
    error      TEXT,
    created_ms INTEGER NOT NULL
);
CREATE INDEX rss_pictures_pending ON rss_pictures (status, created_ms);
CREATE TABLE rss_item_pictures (
    feed_id    TEXT NOT NULL,
    item_id    TEXT NOT NULL,
    source_url TEXT NOT NULL,
    PRIMARY KEY (feed_id, item_id, source_url)
);
CREATE INDEX rss_item_pictures_by_source ON rss_item_pictures (source_url);
-- Every item kept again on its feed's next ask, so the pictures it already embeds are noted.
UPDATE rss_items SET hash = '';
UPDATE rss_feeds SET etag = NULL, modified = NULL, due_ms = 0;
