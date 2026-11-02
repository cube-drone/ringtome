-- Front matter (frontmatter.rs, 2026-11-01): a server operator's additions to the terms of service
-- and the privacy policy, every version they publish kept - the pages list each, dated, as a diff of
-- the one before - and which version of the terms each account agreed to when it was made.
CREATE TABLE front_matter (
    kind   TEXT    NOT NULL,   -- 'tos' | 'privacy'
    at_ms  INTEGER NOT NULL,
    body   TEXT    NOT NULL,   -- Marquee, as the operator's note held it
    PRIMARY KEY (kind, at_ms)
);
CREATE TABLE terms_agreed (
    account_id  TEXT    NOT NULL,
    version     TEXT    NOT NULL,   -- frontmatter.rs `version`: everything the pages showed, hashed
    at_ms       INTEGER NOT NULL,
    PRIMARY KEY (account_id, version)
);
