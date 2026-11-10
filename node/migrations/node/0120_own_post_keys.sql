-- Whose word a key memo is (2026-11-10). A node's memo of a sealing key comes two ways: written
-- from the author's own draft, on a node hosting the author - with the audience it was sealed to,
-- so this node may judge who else reads it - or handed over by the key lane, which carries the key
-- and nothing about its audience. The two looked alike, and a node hosting the author judged by a
-- memo it never had: a chat for two opened on the persona's other computer was sealed to its other
-- half here. `own` = 1 is the first kind. Every memo on a node hosting its author was written from
-- the draft until now (such a node never asked the lane), which is the backfill.
ALTER TABLE post_keys ADD COLUMN own INTEGER NOT NULL DEFAULT 0;
UPDATE post_keys SET own = 1 WHERE author_root IN (SELECT root_pubkey FROM identities);
