-- The front door's own words, and the posts pinned above its feed (frontdoor.rs, 2026-09-30).
-- front_door: one row at most, the node administrator's choices. No row, or a NULL column, means
-- the app's own default (the page's words, so they read in the stranger's language).
--   name      what the front page's header calls this place
--   taglines  a JSON array of strings, the marquee's lines in order
CREATE TABLE front_door (
    id          INTEGER PRIMARY KEY,
    name        TEXT,
    taglines    TEXT,
    updated_ms  INTEGER NOT NULL
);
-- Super-pins: public posts a node administrator pinned to the top of the front page, above
-- "lately on this node". A server's alone - a desktop app has no front page for strangers.
CREATE TABLE super_pins (
    author_root  TEXT    NOT NULL,
    doc_id       TEXT    NOT NULL,
    pinned_ms    INTEGER NOT NULL,
    PRIMARY KEY (author_root, doc_id)
);
