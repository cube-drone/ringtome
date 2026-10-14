-- Whether a follow is published (plans/CROWD.md, ruling 1, 2026-10-11): `edges_public` is not
-- "no" on the contact. The sync and fragment doors answer a stranger about a persona this node
-- only follows when somebody here follows them where all can see - or when the node serves
-- enough personas that "somebody here" could be anyone (crowd.rs).
--   public   1 for a published relationship, 0 for a quiet one. Existing rows start at 0 until
--            the first subscription sweep after boot restamps them: a door closed to strangers
--            for one beat is the safe way to be wrong.
ALTER TABLE subscriptions ADD COLUMN public INTEGER NOT NULL DEFAULT 0;
