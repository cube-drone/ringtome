-- The crowd's word, kept beside the ask (plans/CROWD.md, ruling 2, 2026-10-11): a node that asks
-- about a persona says in its Hello whether it serves that persona to strangers too, and the
-- persona's own node refers other askers to the ones that do.
--   holds   1 when the asker said it holds the persona for the crowd at its last ask, else 0.
--           Each ask restates it, so a node that stops holding stops being referred.
ALTER TABLE identity_demand ADD COLUMN holds INTEGER NOT NULL DEFAULT 0;

-- The holders this node was referred to (plans/CROWD.md, ruling 2): other nodes that serve a
-- persona to strangers, as the persona's own node named them in its Hello. Somewhere else to
-- ask when the persona's own nodes are busy or dark (ruling 4) - never an authority, since
-- whatever a holder answers is validated against the root like any other answer. Only the
-- persona's own nodes, proven by member proof, are believed when they refer: a stranger's list
-- could fill this with doors that go nowhere.
--   root_pubkey   the persona held
--   endpoint_id   the holder, hex
--   referred_ms   when the persona's own node last named it; rows past a week are dropped, as
--                 the referring node's own demand rows are (net/demand.rs)
CREATE TABLE crowd_holders (
    root_pubkey  TEXT    NOT NULL,
    endpoint_id  TEXT    NOT NULL,
    referred_ms  INTEGER NOT NULL,
    PRIMARY KEY (root_pubkey, endpoint_id)
);
