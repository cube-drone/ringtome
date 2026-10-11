-- Content prints (plans/DEDUP.md, 2026-10-11): the keyed fingerprints a private version's header
-- carries (keys 24-26) - of its body, its thumbnail, and the bytes as uploaded - so a persona can
-- find a file it already stores before encrypting it again, and an upload it already holds. Folded
-- with the version like every other header field; private lane only (the fold drops a public
-- header's, which no writer makes). No refold: no header before this rung carries a print, so NULL
-- is every existing row's true value. Indexed partially - most versions are words, with no
-- thumbnail and no upload behind them.
ALTER TABLE doc_versions ADD COLUMN body_print BLOB;
ALTER TABLE doc_versions ADD COLUMN thumb_print BLOB;
ALTER TABLE doc_versions ADD COLUMN source_print BLOB;
CREATE INDEX doc_versions_by_body_print ON doc_versions (body_print) WHERE body_print IS NOT NULL;
CREATE INDEX doc_versions_by_thumb_print ON doc_versions (thumb_print) WHERE thumb_print IS NOT NULL;
CREATE INDEX doc_versions_by_source_print ON doc_versions (source_print) WHERE source_print IS NOT NULL;
