-- Feed items are posts (plans/RSS.md, _Feed items are posts_, 2026-10-27): an item wears the
-- automatic tags a post does, its feed wears a logo where a post wears its author's face, and a
-- reader's own tags on an item stay private until it is rebroadcast. Owned by feedreader.rs.
--
-- rss_items.tags      the item's automatic tags, space-separated: image, audio or video, then
--                     micro, short, medium or long (documents.rs `media_tag`, `length_tag`)
-- rss_feeds.logo      the feed's logo, as fetched, when it is a picture this node will serve
--                     (png, jpeg, gif, webp or ico - never svg); logo_type its media type;
--                     logo_ms when it was last looked for (0: never)
-- rss_tags            one reader's private tags on one item - the `rss_tags` registers on their
--                     private chain, noted here as `rss_follows` notes `rss_feeds`, so the feed's
--                     filters read them without opening anybody's database
ALTER TABLE rss_items ADD COLUMN tags TEXT NOT NULL DEFAULT '';
ALTER TABLE rss_feeds ADD COLUMN logo BLOB;
ALTER TABLE rss_feeds ADD COLUMN logo_type TEXT;
ALTER TABLE rss_feeds ADD COLUMN logo_ms INTEGER NOT NULL DEFAULT 0;
CREATE TABLE rss_tags (
    root    TEXT NOT NULL,
    feed_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    tag     TEXT NOT NULL,
    PRIMARY KEY (root, feed_id, item_id, tag)
);
CREATE INDEX rss_tags_by_tag ON rss_tags (root, tag);
-- Every item kept before this had no tags: forget the validators and the hashes, so the next
-- refresh asks each feed whole, keeps each item again with its tags, and journals it.
UPDATE rss_items SET hash = '';
UPDATE rss_feeds SET etag = NULL, modified = NULL, due_ms = 0;
