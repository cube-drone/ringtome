# Migrations

Two ladders, one per database kind: `node/` for `node.db`, `user/` for every per-identity
`users/<root>.db`. Each database climbs its ladder when it opens (`src/migrations.rs` is the
machinery and its reasoning). A fresh database climbs every rung; an existing one climbs only the
rungs above the number stamped in it (`PRAGMA user_version`).

The first rung of each ladder is the **baseline**: the schema exactly as 0.1.0–0.1.2 shipped it,
numbered at the generation it carried then (node 53, user 26). Every change from there on is a new
rung.

## Writing a rung

1. **Add a file**, numbered one past the top: `user/0027_room_pins.sql`. Never edit an existing
   rung to change the schema. Before a rung ships you can still edit it, but your own dev node will
   then refuse its database ("has changed since this database applied it") until you rebuild.
2. **List it** on the ladder in `src/migrations.rs` (`NODE` or `USER`). A test fails if a file and
   the list disagree, or if the numbers skip.
3. **Write it for a database with data in it.** It runs in one transaction on real rows:
   `ALTER TABLE … ADD COLUMN` with a default, `CREATE TABLE`, `CREATE INDEX`, an `UPDATE` that
   backfills. A test that climbs from the rung before, with rows in it, is the proof. The toy
   ladder tests in `src/migrations.rs` show the shape.
4. **If it changes how a view folds from the chains** (user ladder only), put the services that feed
   that view in the rung's `refold`. The climb then drops the view and its watermark, and the view
   rebuilds itself from the entries on its next read, so you don't write a backfill at all. Adding
   a view column taken from an entry header is `ADD COLUMN` plus a refold. Chain entries themselves
   never migrate: they're signed bytes, and the wire format only grows (PROJECT_PLAN, Canonical
   Encoding).

## Releasing

`just release-*` pins every rung that isn't pinned yet in `released.txt` (path and sha256), and
refuses to release if an already-pinned rung has changed. From then on the rung is **frozen**:
`tests/conventions.rs` fails if its file changes by even a comment, because a machine that
climbed the old text records the old hash and would refuse the new one.

## What a rung can't do yet

Node rungs are SQL only. A node change that has to re-derive a memo from personas' chains (the
feed journal, the room lane) needs a code rung that opens user databases. The first change that
needs one should add it to `src/migrations.rs`, shaped around that change.
