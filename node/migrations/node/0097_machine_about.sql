-- What a machine says about itself in its Hello's about slot (plans/NETWORK.md, 2026-10-17): the
-- client it runs (`hdt`, unless someone built another), the kind of device (android, mac, windows,
-- linux, server), and how many accounts and personas it carries. NULL until it has said so.
ALTER TABLE machines ADD COLUMN client TEXT;
ALTER TABLE machines ADD COLUMN device TEXT;
ALTER TABLE machines ADD COLUMN users INTEGER;
ALTER TABLE machines ADD COLUMN personas INTEGER;
