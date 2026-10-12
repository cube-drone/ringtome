-- Whether search engines are welcome on this node (crawl.rs, plans/CRAWLING.md ruling 2): the
-- node administrator's choice, one row at most. No row means yes - a public site is indexed unless
-- its operator says no; each persona can say no for themselves too (their profile's `search`).
--   indexed     1 or 0
CREATE TABLE search_policy (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    indexed     INTEGER NOT NULL,
    updated_ms  INTEGER NOT NULL
);
