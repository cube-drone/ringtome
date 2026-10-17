-- Public groups (plans/PUBLIC_GROUPS.md, slice 1, 2026-10-17): a public group gives each member
-- device a public lane, `(device, GROUP_PUBLIC, group)`, beside its members-only one. The memo
-- keeps both, keyed by the fold's name for each lane (`roster::lane_device`: a public lane is
-- `public_lane(device)`), and says which service each row came from.
ALTER TABLE group_lanes ADD COLUMN service INTEGER NOT NULL DEFAULT 14;
