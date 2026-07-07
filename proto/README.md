# ringtome-proto

The Ringtome protocol layer: canonical bytes, hashing, signing, and chain validation for the
Identity-Managed Append-Only Log (IM-AOL).

**The job, in one sentence:** this crate converts *things an identity wants to say* into
**self-verifying bytes**, and converts received bytes back into *statements you can trust* — and
does nothing else. It is the trust boundary expressed as code: every guarantee Ringtome makes
about history (tamper-evidence, authorship, ordering) must be checkable by a stranger holding
nothing but bytes and a public key, and this crate is where that checking lives.

## The mental model: three nested shells

Every entry is three layers, each wrapping the last:

```
Envelope  [ body-bytes, signature ]        ← the proof you said it
  Body    { v, type, chain, seq, … }       ← the record of saying it
    Payload  {0:"name", 1:"Curtis"}        ← the thing you said
```

- The **payload** is type-specific content: a profile field today; posts, follows, and key-tree
  statements later.
- The **body** is the bookkeeping that turns content into a *chain link*: who is speaking
  (chain = author pubkey + service), where this sits in their history (`seq`, `prev_hash`), and
  when they claim it happened (an advisory timestamp — never a security input).
- The **envelope** is what actually travels: the body *as opaque bytes*, plus an ed25519
  signature over those bytes. The bytes-not-structure distinction is the crate's central trick
  (see `SignedEntry::verify` below).

## Module tour

### `cbor` — the byte discipline

A `Writer` and `Reader` for a deliberately tiny subset of deterministic CBOR (RFC 8949 §4.2:
unsigned ints, byte strings, text, arrays, maps — no tags, floats, or simple values). The
`Writer` can only produce canonical output: shortest-form heads, definite lengths, NFC-normalized
text. The `Reader` is the strict mirror — it **rejects** anything the Writer could not have
produced: non-minimal integers, indefinite lengths, map keys out of order (even inside unknown
fields it is skipping), non-NFC text, over-deep nesting.

Why the paranoia: **an entry's identity is the hash of its bytes.** If "the same" logical entry
could be encoded two ways it would have two hashes — `prev_hash` links break, revocation anchors
miss, and an attacker gets to shop between representations. Strictness collapses that: one value,
exactly one accepted encoding. Concretely, the payload `{0:"name", 1:"Curtis"}`:

```
a2                       map, 2 pairs
  00                     key 0
  64 6e 61 6d 65         text(4) "name"
  01                     key 1
  66 43 75 72 74 69 73   text(6) "Curtis"
```

Eleven bytes, and there is no other legal spelling of them.

### `entry` — the heart

- **`SignedEntry::create(entry, key)`** — refuses if the signing key doesn't match the chain's
  author (a mis-signed entry is unrepresentable, not merely invalid). Encodes the body, signs the
  preimage `"ringtome-v0/entry" || body-bytes` (the domain tag means an entry signature can never
  be replayed as some other kind of statement), wraps `[body, sig]` — then **decodes its own
  output** before returning: a free round-trip self-check that derives the hash exactly the way
  every future recipient will.
- **`SignedEntry::decode(bytes)`** — strict structural parse of received bytes. Computes the
  entry hash (BLAKE3-256 over the *whole envelope*), records where the body sits inside the
  bytes, enforces size caps (16 KiB envelope, 8 KiB inline payload), and tolerates unknown body
  keys above 6 — how a v0 node safely carries a v1 entry's extra fields without understanding
  them. Decode does *not* check the signature: structure and authorship are separate questions.
- **`SignedEntry::verify()`** — answers the authorship question by *slicing* the stored bytes
  (domain tag + the body range decode remembered) and running `verify_strict` against the author
  key embedded in the chain id. **It never re-serializes anything.** If verification re-encoded
  the body, any disagreement between two implementations' encoders — a one-byte formatting
  difference — would make honest entries unverifiable or forged entries verifiable. By signing
  and verifying *bytes*, encoding correctness stops being a security dependency.
- **`SignedEntry::hash()`** — BLAKE3-256 over the full envelope, signature included. This is the
  entry's name in the system: what the next entry's `prev_hash` points at, and what revocation
  anchors pin.

Body layout (integer-keyed map, keys ascending; 0–6 required, higher keys skipped):

| key | field       | encoding                                                |
|-----|-------------|---------------------------------------------------------|
| 0   | `v`         | uint (= 0); selects layout + hash + signature algorithms|
| 1   | `type`      | uint, type-registry id                                  |
| 2   | `chain`     | `[bstr(32) author-pubkey, uint service-id]`             |
| 3   | `seq`       | uint, dense per chain, no gaps                          |
| 4   | `prev_hash` | bstr(32); BLAKE3 of prior envelope, zero for seq 0      |
| 5   | `timestamp` | uint, claimed ms since epoch; ADVISORY                  |
| 6   | `payload`   | `[0, bstr inline-cbor]` or `[1, bstr(32) blob-hash]`    |

### `chain` — the ordering law

One function, `validate_next(prev, next)`, four checks: signature valid, same chain,
`seq == prev.seq + 1`, `prev_hash == hash(prev's exact bytes)` (genesis: seq 0, zero prev_hash).
It validates one link at a time so callers can stream — the node replays its stored log through
it, and the M3 sync protocol will run *arriving* entries through the identical function.

What the four checks buy is history welded shut: altering any past entry changes its hash, which
breaks the next entry's signed `prev_hash`, forever. The only way to rewrite is to sign a
*second* entry at the same (chain, seq) — which anyone holding both can prove mechanically.
That self-proving-fork property is what the key tree's equivocation detection (M2) builds on.

### `registry` — the vocabulary

Small integer namespaces, append-only, never repurposed: **service ids** (which chain —
`profile`, `posts`, `identity-public`, ...) and **entry-type ids** (what kind of statement —
`profile-set`, `authorize`, ...). Plus the payload codecs for the types this crate understands —
currently `ProfileSet`, the template for every future content type.

### `error` — typed rejections

`NonCanonical`, `BadSignature`, `ChainViolation`, and friends, with `PartialEq` so tests can
assert *which* rejection fired. For a strict parser, the specific failure mode is part of the
contract.

## The lifecycle, end to end

When a user renames themself to "Hat Fan", the node: reads their chain head from storage (seq 0
and its hash) → `ProfileSet::encode` → builds `Entry { seq: 1, prev_hash: hash(e0), … }` →
`SignedEntry::create` → stores `signed.bytes()` verbatim → folds the value into a materialized
view. Later — on a view rebuild today, on a *different node* once sync exists — someone holding
those bytes runs `decode` → `validate_next` → trusts. **The receiving side runs the exact same
functions the authoring side did.** That symmetry is why this crate stays pure.

## Cheat sheet

| Function | Role |
|---|---|
| `cbor::Writer` / `Reader` | one-encoding-per-value bytes; reader rejects all others |
| `SignedEntry::create` | statement → signed canonical envelope (self-checked) |
| `SignedEntry::decode` | bytes → parsed entry; strict structure, no trust yet |
| `SignedEntry::verify` | authorship, by slicing bytes — never re-encoding |
| `SignedEntry::hash` | the entry's identity; what chains and anchors point at |
| `validate_next` | the append-only law: sig, chain, dense seq, hash link |
| `ProfileSet::encode/decode` | first payload codec; template for every future type |

## Design rules (please keep them)

1. **No I/O, no clocks, no node state.** Every function is values in, `Result` out. The
   dependency list (blake3, ed25519-dalek, thiserror, unicode-normalization) is the enforcement
   mechanism — nothing async, nothing storage-shaped, nothing HTTP-shaped may appear here. If
   entry validation ever depends on node state, independent implementations become impossible.
2. **Bytes are authoritative.** Hash, store, and forward the author's exact bytes; re-encoding
   is permitted only for ephemeral local display (`ringtome inspect`).
3. **The test vectors are the spec.** `spec/test-vectors/entry-v0.json` states byte-exact
   expected output for known inputs. The `vectors` test verifies against it on every run;
   `RINGTOME_BLESS=1 cargo test -p ringtome-proto --test vectors` regenerates it, which is a
   protocol-breaking act and should feel like one.

## Trying it

```sh
cargo test -p ringtome-proto        # the whole crate, a few seconds, no tokio/sqlx build

# Decode + verify any envelope by hand: grab an envelope_hex from the vectors file and
ringtome inspect <hex>              # (the tool is nothing but decode + verify + pretty-print)
```
