-- The feed reader (plans/RSS.md, slice 1, 2026-10-27): the node's cache of the feeds its people
-- follow, fetched once however many follow one. A memo, never a wire fact - what a feed said
-- depends on when it was asked, and each node asks for itself - owned by feedreader.rs. Who
-- follows what is a fact of each persona's private chain (the `rss_feeds` registers);
-- `rss_follows` is this node's note of it, so the refresh never opens a persona's database.
--
-- rss_feeds: one row per feed URL anyone here follows.
--   feed_id           hex of the normalised URL's hash (feedreader.rs `feed_id`)
--   title, site       the feed's own name and the website it says it belongs to
--   etag, modified    the validators of its last answer, sent back as If-None-Match and
--                     If-Modified-Since so an unchanged feed answers 304
--   checked_ms        when it was last asked; fetched_ms, when it last answered with a feed
--   due_ms            when the refresh asks again
--   failures          failed asks in a row, which push due_ms back; failing_since_ms, when the run
--                     of them began; error, what the last one said
CREATE TABLE rss_feeds (
    feed_id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    site TEXT NOT NULL DEFAULT '',
    etag TEXT,
    modified TEXT,
    checked_ms INTEGER NOT NULL DEFAULT 0,
    fetched_ms INTEGER NOT NULL DEFAULT 0,
    due_ms INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    failing_since_ms INTEGER,
    error TEXT
);
CREATE INDEX rss_feeds_by_due ON rss_feeds (due_ms);

-- rss_follows: which persona hosted here follows which feed.
CREATE TABLE rss_follows (
    feed_id TEXT NOT NULL,
    root TEXT NOT NULL,
    since_ms INTEGER NOT NULL,
    PRIMARY KEY (feed_id, root)
);
CREATE INDEX rss_follows_by_root ON rss_follows (root);

-- rss_items: a feed's items, the newest few hundred, converted.
--   item_id           hex of the hash of the item's own id (its guid, else its link, else its
--                     title and date), stable across nodes
--   summary           plain text, short, for the list
--   body              the item's words as Marquee (marquee_html_import), never HTML
--   hash              of everything shown, so a changed item is noticed and replaced
--   dated_ms          the item's own date, or when it was first fetched if its date is nonsense
CREATE TABLE rss_items (
    feed_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    link TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    hash TEXT NOT NULL,
    dated_ms INTEGER NOT NULL,
    fetched_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL,
    PRIMARY KEY (feed_id, item_id)
);
CREATE INDEX rss_items_by_feed_date ON rss_items (feed_id, dated_ms);
CREATE INDEX rss_items_by_date ON rss_items (dated_ms);
