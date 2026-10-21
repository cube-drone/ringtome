-- An administrator may switch off an account's sign-in (Curtis, 2026-10-20; accounts.rs): the
-- moment they did, or NULL while the account signs in as ever. Its personas stay hosted; only the
-- doors in - a password, a session, an API key, a spare-key reset - stop opening (auth.rs).
ALTER TABLE accounts ADD COLUMN sign_in_off_ms INTEGER;
