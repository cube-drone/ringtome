-- M3.5: discovery. Addresses stop being our data - peers are endpoint ids, resolved at dial
-- time via the directory (serving/endpoint records) instead of a stored snapshot that rots.
ALTER TABLE identity_peers DROP COLUMN addrs;

-- Publication is an act: a serving record is published for an identity only once it is
-- explicitly marked served. NULL = dark (unpublished), which is every identity's birth state.
ALTER TABLE identities ADD COLUMN served_at_ms INTEGER;
