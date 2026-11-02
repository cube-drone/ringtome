-- The node's private refusal list (quarantine.rs, plans/SCANNING.md): each quarantined picture's
-- PDQ fingerprint, hex, so the picture is refused when it comes back re-encoded or cropped. NULL
-- for a file that isn't a picture, wasn't here to fingerprint, or is too plain to match. Never
-- published.
ALTER TABLE quarantine ADD COLUMN pdq TEXT;
