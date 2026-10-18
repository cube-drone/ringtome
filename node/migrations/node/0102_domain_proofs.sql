-- Custom domains (plans/CUSTOM_DOMAINS.md, slice 1, 2026-10-16): what this node last found when it
-- checked a persona's claimed domain against DNS. A memo, never a wire fact - the answer depends
-- on when it was asked - owned by domains.rs. One row per persona whose profile claims a domain.
--   state             'verified' (the domain names this root back), 'unverified' (it doesn't, and
--                     never has since the claim), 'lapsed' (it did, and has stopped)
--   proof             how a verified claim was proved: 'txt', or 'well-known' (the badge only)
--   checked_ms        when it was last asked; 0 for a claim not yet asked about
--   verified_ms       when it last proved true
--   failing_since_ms  when lookups started failing outright (DNS down, not "no record"): a
--                     verified claim keeps its verdict through a grace period from here
CREATE TABLE domain_proofs (
    root TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    state TEXT NOT NULL,
    proof TEXT,
    checked_ms INTEGER NOT NULL,
    verified_ms INTEGER,
    failing_since_ms INTEGER
);
CREATE INDEX domain_proofs_by_checked ON domain_proofs (checked_ms);
