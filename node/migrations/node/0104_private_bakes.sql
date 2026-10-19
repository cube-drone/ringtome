-- Web pictures saved as a persona's own (2026-10-18): a post that can't carry a public copy of a
-- picture from the web - a group's - takes it as one of its author's own pictures, downloaded and
-- crushed in the background as `media_bakes` does for a public post, and saved as their private
-- document instead of a public twin (record::bake, `private_bake_pass`).
--   private_doc_id  hex, once saved: the author's own picture the post then carries
CREATE TABLE private_bakes (
    root_pubkey    TEXT    NOT NULL,
    source_url     TEXT    NOT NULL,
    status         TEXT    NOT NULL,  -- pending | fetching | ready | failed
    private_doc_id TEXT,
    error          TEXT,
    created_ms     INTEGER NOT NULL,
    fetched_ms     INTEGER,
    PRIMARY KEY (root_pubkey, source_url)
);
