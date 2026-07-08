# Ringtome — Refactor Ledger

Codebase roundup taken 2026-07-08, right after the private-chains push wrapped the identity
draft (M1–M3.5 + Tier-5 private chains). Verdict: the house style is real and mostly holding —
these are tuning items, not rescue. Work through them one manageable fix at a time; check them
off as they land.

House priorities these were judged against: boilerplate is fine when it signposts structure;
names and interfaces document, comments add *context* (and must therefore stay true); modularity,
consistency, self-similarity; consistent intra-file ordering (creation → modification → view);
loosely-coupled systems composed in `main.rs`; words are free — no cryptic variable names;
clarity over cleverness.

## 1. Self-similarity drift — small duplications with diverging shapes ✅ (2026-07-08)

- [x] **`now_ms()` × 4, with a signedness split.** `auth.rs`, `identity.rs`, `sync.rs` returned
  `i64`; `imaol.rs` returned `u64`; inline copies in `db.rs` and `rate_limit.rs`. Fixed: one
  `clock` module, one unit, one type - `now_ms() -> i64` - across the *whole* system: the rate
  limiter's window went ms, and the proto timestamps (`Entry`, `ServingRecord`) went `i64` too
  (wire bytes unchanged - a CBOR uint - but the strict decoder now rejects values past
  `i64::MAX`, which also closed a wrapping `as i64` on hostile timestamps at the storage binds).
  Nobody needs December 4, 292,277,026,596.
- [x] **The hex→`[u8; 32]` parse copy-pasted ten times** with drifting error strings. Fixed: the
  `pubkey` module — `pubkey::decode` (Option, for corrupt-storage contexts that want their own
  error) and `pubkey::require` (uniform `AppError::BadRequest`, for request boundaries).
- [x] **Three copies of "load this node's leaf signing key from the keystore"** in
  `load_signing_key`, `load_node_leaf_key`, and inline in `publish_serving_record`. Fixed: one
  private `signing_key_named` core; the three callers are thin wrappers.
- [x] **The private-store route handlers diverged from the file's idiom**: fully-qualified paths
  where the file imports, and `private_context` returning an anonymous
  `(SqlitePool, SigningKey, EpochKeys)` tuple. Fixed: imports normalized to the file's pattern
  (import what's used heavily, qualify one-offs), tuple replaced with a named `PrivateStore`.

## 2. Stale comments ✅ (2026-07-08)

The context-comment discipline cuts both ways: a comment that argues design must stay true.

- [x] `main.rs` header still said "M0 skeleton… everything below the HTTP layer arrives in later
  milestones" — three milestones after it all arrived. Now describes the composition root.
- [x] `identity.rs` header said "the thinnest slice… the recovery key… come later," directly
  above a `create()` that mints the recovery key, an encryption keypair, and epoch 0.
- [x] `auth.rs` header pointed at a "TODO seam below" that shipped in M2.
- [x] The adoption-ceremony section banner in `identity.rs` sat above two serving-record
  functions that are neither adoption nor revocation. The serving functions moved above it under
  their own banner (also preps the item-3 split).

## 3. Modularity — `identity.rs` is four modules wearing a trenchcoat ✅ (2026-07-08)

- [x] Split into `identity/serving.rs` (records + republish pass) and `identity/adoption.rs`
  (the ceremony, now owning `pending_adoptions`), core at ~400 lines. The stricter cut on table
  ownership: **all `identities` SQL stays in core** behind blunt accessors (`record_identity`,
  `record_served`), so the flow modules orchestrate at altitude and `owners()` stays one line
  per table.
- [x] `spawn_republish_loop` left `main.rs` — and grew into a pattern: **`loops.rs`**, one tiny
  spawner (interval + failure logging + panic containment, written once). Modules export plain
  one-pass functions (`serving::republish_pass`, `discovery::republish_endpoint_pass` - the two
  jobs of the old combined loop, now in their proper domains); `main.rs` registers each by name,
  and that registration block is the complete inventory of the node's background work. Scope
  fence, on purpose: no dynamic registration, no job framework - a function called N times from
  main (N=2).
- [ ] (Someday, not yet earning its churn) `sync.rs`'s peer-bookkeeping tail could split out;
  it's also what `owners()` maps `identity_peers` to.

## 4. `MapReader` — make the canonicality check structural

- [ ] The ascending-map-key check is hand-copied into every payload decoder (`entry.rs` plus six
  in `registry.rs`). This is boilerplate that *doesn't* signpost structure: it's a security check
  a future payload type could silently forget, and a forgotten check is a non-canonicality hole.
  A small `MapReader` in `cbor.rs` owning `next_key()` makes the check impossible to skip — the
  same structural-not-disciplinary argument the COSE envelope already makes. Touches the
  conformance crate, so the published test vectors re-prove it.

## 5. Naming — the two-letter payload abbreviations ✅ (2026-07-08)

- [x] `az`, `rv`, `ke` (in `keytree.rs`, `registry.rs`, `private.rs`, `inspect.rs`) →
  `authorization`, `revocation`, `key_epoch` (decoded-payload variables named for their types).
  Kept, per the tolerated-shorthand list: `w`/`r` in `cbor.rs` and the `e`-for-entry loop
  variable.

## Explicitly fine — reviewed and left alone

- `ingest_batch`'s three phases in one function: the phase comments are load-bearing.
- The `.context(...).map_err(AppError::Internal)` chains: heavy but perfectly uniform —
  boilerplate signposting the error architecture.
- anyhow in leaf modules / `AppError` at the HTTP boundary: a consistent convention.
- The humor (`hotdog-stand`, `EVIL TWIN`, "a shared folder posing as a DHT", a repudiated signer
  "has no voice"): load-bearing morale infrastructure. Preserved.
