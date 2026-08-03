
## Can't-tell is not goodbye (2026-08-02)

Field report from the schema migration: logging into an adopted computer showed "this
computer has left the persona" with nobody repudiated or retired. Root cause, in two
halves. The farewell fired on the ABSENCE of good news: a rebuilt-empty user db yields an
empty key tree, Crown honestly answers Unknown for a leaf it has never heard of, and the
persona screen's branch treated everything-not-active as departed. And the migration's own
promise - "per-user data replays from its journal" - was never wired: rebuild_from_journal
existed with zero production callers. Both fixed. The farewell now requires AFFIRMATIVE
removal (isDeparted in pure/removal.js: retired/repudiated/invalid, vectored; "unknown"
opens the persona and lets sync heal - both the boot-time list and the live revoked-signer
path gate on it). And the user-db open path gained the journal invariant's other direction:
an empty entries table under a non-empty journal replays every frame through the ordinary
validated ingest (the gate re-checks every signature, so a tampered journal injects
nothing). Field-proven in four shapes: single-node wipe heals from the journal (profile,
note, and active standing all through the rebuild); adopted-node wipe heals from its PEER
before you can blink (identity_peers survives in node.db and the resync loop dials on
boot - the false-farewell window was always exactly "no peer reachable", which is why
migrating both dev nodes together hit it); peer-down total wipe now reads "unknown", opens
to the console, and waits; and one instrument scar - a probe that deleted files under a
still-running node's open handles got them flushed back at shutdown, which is not a bug but
a reminder that rm is not a message to a process.
