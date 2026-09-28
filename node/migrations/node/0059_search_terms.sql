-- Search as an inverted index (2026-09-28, PROJECT_PLAN's Scores and sort orders, *Shape*): a row
-- per (term, post), so a query's word is a prefix range scan of an index - where every search used
-- to read one token string per post of the newest 5000 journal rows and match them in Rust.
-- Kept by search.rs beside post_search, which stays the currency record (a post's update stamp).
CREATE TABLE post_terms (
    term         TEXT NOT NULL,
    author_root  TEXT NOT NULL,
    doc_id       TEXT NOT NULL,
    PRIMARY KEY (term, author_root, doc_id)
);
-- A post's terms, found to replace them when it is indexed again.
CREATE INDEX post_terms_by_post ON post_terms (author_root, doc_id);

-- Every post indexed afresh, so each gets its terms: the backlog walk and the head of every feed
-- redo them (search.rs `index_pass`). There are no users yet; a dev node's search thins for a
-- while and returns.
DELETE FROM post_search;

-- A pick's posts: every post carrying one tag, or filed in one bucket, off an index.
CREATE INDEX doc_annotations_by_value ON doc_annotations (key, value, target_author, target_doc);
