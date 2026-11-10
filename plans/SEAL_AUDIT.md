# Seal audit: what a third party can learn about a sealed chat or post

An audit on 2026-11-10, after a chat between two personas on one server said
"this room is sealed" to one of them. The question was whether a chat's key, its
words, or who is in it can reach someone it wasn't sealed to. This is the list
of what was found, what is fixed, and what is still open. Line numbers are as of
that day.

Each item says how far it was checked: **live** (run on a scratch node or in the
rig), or **read** (followed through the code, not exercised).

## Fixed

- **The key door answered by the trust list on any node holding a key** (live).
  A reader's node has no audience on record, and gave a chat for two's key to a
  third person the author trusted. Only a node that may judge the audience does
  now (`idface::judges`); any other holder gives the key to the author's own
  computers and to the persona it was granted to. `key_siblings.cjs`.
- **`?as=` was taken on its word** (live). An anonymous `?as=<author>` on
  `/api/id/{root}/posts` was the author: sealed posts listed, a chat's other
  half named, the audience tag told, and the shelf's search matching sealed
  words by prefix. A signed-in session with no `as` saw a hosted author's sealed
  rows unhidden. The viewer is now a persona the session owns, or nobody
  (`idface::said_viewer`). `shelf_viewer.cjs`.
- **A chat for two with no audience on record fell back to the trust list**
  (live). The memo's key, audience and members are three writes. A chat for two
  now admits nobody but its author until its member is on record.
  `shelf_viewer.cjs`.

## Open: around the key

1. **A revoked computer keeps its standing on other people's nodes** (read).
   `endpoint_serves_any` reads `identity_peers`. Rows for a persona a node does
   not host are only re-derived when some other dial for that persona misses
   (`net/fragment.rs`, `derive_peers_for`); the periodic sweep covers hosted
   personas only (`net/sync.rs` `derive_peers`). An author's node may hand new
   keys and lines to a computer the reader revoked. Rows with no leaf are never
   removed by revocation at all.
2. **The author can widen a chat for two after the fact** (read). The "exactly
   one other person" check runs only when the publish request says `im`
   (`identity/routes.rs` ~4984). The header carries `im` forward, so a
   re-publish without it and with a wider audience keeps the flag and admits
   more people. The other direction too: a shared room re-published as an IM
   keeps its old key holders.

## Open: words reaching the wrong place

3. **The desktop app shows every alert on the machine** (read).
   `desktop/src/alerts.rs` has no persona filter; Web Push and the page stream
   do. On a computer with more than one account, one account's chat words can be
   another's OS notification. The decrypted picture is written to a temp file
   with a predictable name.
4. **Backups include plaintext export zips** (read). An export holds chat
   transcripts and opened sealed posts in `<data>/exports/` until the next
   export; `backup.rs` copies the data directory with it.
5. **Sealed words are served `no-cache`, not `private`** (read).
   `idface::cache_policy`. A shared cache may store them and must revalidate;
   not tested against the CDN.
6. **Sealed post words are plaintext in the node-wide search index** (read;
   documented in `search.rs`). The `?as=` fix closes the way in that was found;
   the index is still one bug from an oracle.

## Open: who is in a chat

7. **A picture sent in a chat for two names the room on the sender's public
   chain** (read). The media twin's header carries `seal_of` in the clear
   (`record/documents.rs` ~876), with dimensions.
8. **`body_hash` on a sealed public header confirms a guess** (read). It is
   keyed by the public doc id (`proto/src/registry.rs` ~723). A chat for two's
   opening body is a fixed card naming the partner; whether the bake leaves it
   byte-predictable is untested. Changing this is a wire change.
9. **The room lane tells any dialer whether this node is in a named sealed
   room** (read). `rooms_here` decides the Hello before the instance is refused
   (`net/sync.rs` ~2596).
10. **The live channel is keyed by the room's doc id alone** (read).
    `chat::Live` and `chat::join`. A room with a colliding id on another chain
    would share the presence stream. Presence only. `room_leave_handler` tears
    the channel down without a gate.
11. **The live socket asks its gate once** (read). `serve_room_live`.
12. **A reaction's take-back is written unsealed in a sealed room** (read).
    `chat.rs` ~1188.
13. **The draft's audience tag is published as a sealed label** (read).
    `store::AUDIENCE` is missing from the exclusions at `identity/routes.rs`
    ~6515, so every key holder can read the author's private tag name.
14. **A sealed room's speakers and times, by trust, on a node that can't judge**
    (read). `seal_admits` falls back to published trust for a sealed room that
    isn't a chat for two; words stay shut.
15. **A chat line's notice may be offered to a third party's node first** (read,
    needs a test). `net/deliver.rs` candidates lead with `last_via`. The notice
    holds the pair and ciphertext.
16. **A sealed post's header answers by id to anyone** (live). `id_post` has no
    seal gate. The header is on the author's public chain anyway; it says a
    sealed post or room exists, not what or with whom.

## Found sound

No log prints a key or decrypted words. Keys are random and never in a header or
URL. No HTTP response carries a key. Every room handler checks ownership and
admission first. Room pictures are stored sealed, and fingerprints and sketches
read stored bytes only. Reports carry no sealed content. RSS, the sitemap, link
previews and the node's shelf leave sealed posts out. An API key reaches its own
account only. The peer ledger takes signed proofs and the adoption ceremony
only.

A node's operator can read every key the node holds. That is the design.
