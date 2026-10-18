-- Custom domains (plans/CUSTOM_DOMAINS.md, ruling 7, 2026-10-16): whether the claimed domain is
-- served by a Ringtome node - its `/.well-known/ringtome` said `"served": true` for this root.
-- A verified claim is the ✓; verified and served is the canonical address.
--   served_ms  when the domain last said it's served; NULL while it doesn't (Hugo still answering)
ALTER TABLE domain_proofs ADD COLUMN served_ms INTEGER;
