-- The node database (node.db): everything node-level in one place.
--
-- MIGRATION POLICY: until a database exists that cannot be casually deleted (the first testnode,
-- a friend's node, your own daily-driver), schema changes are squashed into THIS file and dev
-- data dirs are deleted. The moment any deployment matters, this file freezes and migrations
-- become append-only forever. (Squashed 2026-07-07 from six pre-deployment migrations.)

-- ---------------------------------------------------------------------------------------------
-- Boot history. Local-only diagnostic (never exposed over the network); recording a boot also
-- exercises the write path on startup.
CREATE TABLE boot_timestamps (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    booted_at_ms INTEGER NOT NULL,
    app_version  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------------------------
-- Node accounts and their sessions.
--
-- An account is a login on THIS node (username + Argon2 password hash). Sessions are opaque
-- server-side tokens: the random token is the cookie value, this table is the source of truth,
-- and deleting a row is instant, authoritative logout. (Not JWTs - a single-node process with
-- local SQLite gains nothing from stateless tokens and would need this table for revocation
-- anyway.)
CREATE TABLE accounts (
    id             TEXT PRIMARY KEY,          -- uuid
    username       TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,             -- Argon2 PHC string
    created_at_ms  INTEGER NOT NULL
);

CREATE TABLE sessions (
    token          TEXT PRIMARY KEY,          -- opaque high-entropy random string
    account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at_ms  INTEGER NOT NULL,
    expires_at_ms  INTEGER NOT NULL
);
CREATE INDEX sessions_account_idx ON sessions (account_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at_ms);

-- Simple string tags on accounts (`node_admin`, `admin`, ...). Deliberately generic so new
-- capability markers need no schema change - but capabilities only: state machines get columns.
CREATE TABLE account_tags (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    tag        TEXT NOT NULL,
    PRIMARY KEY (account_id, tag)
);
CREATE INDEX account_tags_tag_idx ON account_tags (tag);

-- ---------------------------------------------------------------------------------------------
-- Identities agented by accounts on this node.
--
-- An identity IS its root ed25519 public key (stored hex). Private keys are NOT here - they live
-- envelope-encrypted in key files (data/keys/). The identity's chains live in its own per-user
-- DB (data/users/<root>.db).
CREATE TABLE identities (
    root_pubkey   TEXT PRIMARY KEY,  -- hex ed25519 public key; the identity's global name
    account_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at_ms INTEGER NOT NULL,
    -- Which key THIS node signs with for the identity: the root itself on the creating node, a
    -- granted leaf on nodes added via adoption. Names the key file in data/keys/.
    leaf_pubkey   TEXT,
    -- Publication is an act: a serving record is published only once this is set. NULL = dark
    -- (unpublished), every identity's birth state.
    served_at_ms  INTEGER
);
CREATE INDEX identities_account_idx ON identities (account_id);

-- ---------------------------------------------------------------------------------------------
-- Known peers per identity: other nodes agenting (or later, fronting) it. Endpoint ids only -
-- addresses are the discovery layer's problem, resolved at dial time (hints are keys, never
-- addresses).
CREATE TABLE identity_peers (
    root_pubkey    TEXT    NOT NULL,
    endpoint_id    TEXT    NOT NULL,  -- iroh endpoint id; transport identity, never an identity key
    -- The identity leaf behind this endpoint, when known (2026-08-07): ceremony rows learn it
    -- from the adoption codes, member-proven dialers from their proof, derived rows from the
    -- serving record. NULL means "ceremony-era row, leaf never learned". The leaf is what lets
    -- revocation reach routing: the derive sweep deletes rows whose leaf the crown no longer
    -- credits - before it, NOTHING removed a repudiated device's row and the eager loop kept
    -- dialing the attacker's machine forever.
    leaf_pubkey    TEXT,
    -- When the derive sweep last confirmed this row against a live serving record (0/NULL for
    -- rows known only by ceremony or proof). Freshness feeds hint minting ("most recently
    -- active leaves").
    last_resolved_ms INTEGER,
    added_at_ms    INTEGER NOT NULL,
    last_synced_ms INTEGER,
    -- What this node last CLAIMED about the persona's public frontier, and what we did about
    -- it. A claim, never a fact (PROJECT_PLAN: "a frontier another node reports is a hint,
    -- never a fact - fetch and validate, never believe"), which is why the verdict is stored
    -- separately from the claim: without it, a node advertising a fingerprint it cannot back
    -- up gets chased on every sweep forever, which is free for it and expensive for us.
    seen_fp        BLOB,
    seen_at_ms     INTEGER,
    chased_fp      BLOB,               -- the claim we last acted on; re-chase only when it moves
    chased_at_ms   INTEGER,
    verdict        TEXT,               -- 'behind' | 'ahead' | 'unresolvable'; NULL = never chased
    PRIMARY KEY (root_pubkey, endpoint_id)
);

-- ---------------------------------------------------------------------------------------------
-- The edges each hosted persona has drawn to someone else, as the NODE needs them.
--
-- Derived, never authored: the truth is the contact ledger on each persona's own private chain
-- (`contact:<root>` LWW registers), and this is a memo of it - the same idiom as doc_heads,
-- disposable and rebuildable from the fold. It exists because routing is a node-level question
-- asked across every persona at once, and per-user databases are separate encrypted files.
--
-- Two different things live here, for two different reasons:
--
--   * `eagerness` and `rebroadcast` are ROUTING (PROJECT_PLAN, Data Layer: "the node routes;
--     the user ranks"). The interest dial is already a sync-cadence dial by design - "don't
--     show / low / medium / high / top priority" is just as naturally how eagerly this identity
--     syncs - so no new knob was invented for it.
--
--   * `trust` is UTILITY STANDING, and it is here ONLY where its author set `trust_public`.
--     A private assessment must not have publicly measurable effects: giving a stranger better
--     treatment because someone here quietly trusts them makes a private fact observable by
--     measurement. A consented edge is one its author agreed may be known, so acting on it
--     visibly discloses nothing they did not offer. The raw 0-100 is stored rather than a
--     bucket: nothing consumes it yet, and a number can be bucketed later where a bucket can
--     never be un-bucketed.
--
-- A row exists when ANY of the three is set, and dies when the last one clears.
CREATE TABLE subscriptions (
    local_root   TEXT    NOT NULL,   -- the persona on this node doing the trusting/following
    foreign_root TEXT    NOT NULL,   -- whom
    eagerness    INTEGER,            -- interest 0-100: how eagerly to sync them. NULL = unset
    rebroadcast  INTEGER,            -- interest in their rebroadcasts, same scale
    trust        INTEGER,            -- 0-100, ONLY when trust_public consent is set
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (local_root, foreign_root)
);
CREATE INDEX subscriptions_by_foreign ON subscriptions (foreign_root);

-- The assembled edge GRAPH: what synced personas say publicly about each other (2026-08-16).
--
-- SECOND-ORDER where `subscriptions` above is first-order, and the difference is the whole
-- design: subscriptions holds OUR OWN personas' dials (opinion, consent-gated on the trust
-- column); this holds THIRD PARTIES' published statements about third parties - each row a
-- fact its author already published on their follows-public chain, assembled here so graph
-- questions ("who do my friends vouch for?") are one JOIN instead of one encrypted-file open
-- per friend. Consented by construction: an unpublished edge never exists anywhere this fold
-- can see. Fed per FOLLOWS_PUBLIC frontier move from the mover's own `published_edges` view
-- (replace-set per author; disposable like every memo here). A row with both bands
-- NULL never exists here - the user-level view keeps LWW retraction tombstones; this memo
-- keeps only standing edges, because graph reads ask "what IS vouched", never "what was".
--
-- Sybil note, same as subscriptions': a COUNT over one author's rows is a promiscuity signal
-- (vouches are meaningful in proportion to scarcity); a COUNT of an edge's *inbound* rows is
-- the per-person sum the trust doctrine forbids. Joint flow, never sums.
CREATE TABLE edge_graph (
    author_root  TEXT    NOT NULL,  -- who published the statement
    subject_root TEXT    NOT NULL,  -- whom it names
    trust        TEXT,              -- band word, as published; NULL = no trust band
    interest     TEXT,              -- band word, as published; NULL = no interest band
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (author_root, subject_root)
);
-- The other direction: "who vouches FOR this persona" - the joint-flow read and the
-- first-contact standing check both ask by subject.
CREATE INDEX edge_graph_by_subject ON edge_graph (subject_root);

-- ---------------------------------------------------------------------------------------------
-- Who has ASKED us about a persona: the demand record the Three Funnels has been asserting and
-- nothing wrote (PROJECT_PLAN, The Three Funnels).
--
-- The fan-out question is "a public post for P just landed - which nodes should I tell?", and
-- the answer is already crossing the wire unrecorded: a node that dials us and names P in its
-- Hello has told us it wants P. Asking is telling. No consent machinery is involved because
-- they initiated the contact, and no follow disclosure is needed for it to work today.
--
-- SEPARATE from identity_peers on purpose, though the key looks the same. That table means
-- "nodes that ARE this identity" - authority-bearing, member-proven, entitled to private
-- chains, and `roots_with_peers` drives the eager push loop assuming exactly that. A reader is
-- none of those things, and the day someone writes a loop over `peers_for` without re-reading
-- its comment, the conflation is what leaks.
--
-- One row per pair, updated in place - a log of every request grows without bound and answers
-- "who wants this?" strictly worse than one row saying "recently". Endpoint-level and never
-- joined to which human asked: we learn that a NODE wants P, and the receiving node routes
-- internally, which is "the node routes; the user ranks" falling out of the mechanism rather
-- than being enforced on top of it.
--
-- Retention (deferred 2026-08-05, paid 2026-08-08): this assembles a readership graph for
-- personas we host, which is the same already-possible/already-assembled line trust had to
-- respect - so rows quieter than the freshness window are pruned on the derive beat
-- (`demand::prune_quiet_askers`), and the table records CURRENT demand, never a permanent
-- readership log. Safe because the wake pass re-asks on every staleness beat.
CREATE TABLE identity_demand (
    root_pubkey   TEXT    NOT NULL,  -- the persona they asked about
    endpoint_id   TEXT    NOT NULL,  -- the node that asked; transport identity, never a person
    last_asked_ms INTEGER NOT NULL,
    PRIMARY KEY (root_pubkey, endpoint_id)
);
CREATE INDEX identity_demand_by_root ON identity_demand (root_pubkey);

-- ---------------------------------------------------------------------------------------------
-- The byline cache: the most recent PUBLIC self-claims of every persona this node holds -
-- their name and avatar, the two facts any list of humans needs per row.
--
-- The memo idiom again (doc_heads, persona_frontiers, subscriptions): the truth is the
-- persona's own PROFILE_PUBLIC registers in their per-user database, and this is the copy that
-- keeps a LIST from opening one encrypted file per face on it. The contacts join used to do
-- exactly that - every stream snapshot re-opened every contact's database to re-learn a name
-- that almost never changes; a feed would have done the same per byline.
--
-- Public facts only, structurally: name and avatar live on the public profile lane, already
-- served to anonymous strangers by the /id face - nothing here is a disclosure. Refreshed on
-- the frontier map's edge, which fires precisely when PROFILE_PUBLIC moves.
CREATE TABLE persona_profiles (
    root_pubkey   TEXT PRIMARY KEY,
    name          TEXT,               -- their self-configured display name, NULL if unset
    avatar        TEXT,               -- their avatar's public doc_id (hex), NULL if unset
    updated_at_ms INTEGER NOT NULL    -- when the CLAIM last changed, not when we last looked
);

-- ---------------------------------------------------------------------------------------------
-- The arrival journal: what has LANDED for each reader on this node, from the personas they
-- follow (PROJECT_PLAN, Data Layer: "Journal, then index").
--
-- A row means "this public post, by a persona this reader follows, is here on this node" -
-- written the moment the author's public lane moves, however it moved (their own publish, a
-- push from their node, a pull, anti-entropy). No ordering and no ranking live here: how the
-- feed should READ is decided when the reader opens it, in their own database where the
-- interest dials are - "the node routes; the user ranks".
--
-- DELIVERED, not SEEN. This table is node-local pipeline bookkeeping - disposable, rebuildable
-- from subscriptions x the held public lanes. What the human has actually looked at is a user
-- fact that must travel with them across their devices; it belongs on their private chain and
-- deliberately does not exist yet ("Two cursors, not one").
CREATE TABLE feed_journal (
    reader_root  TEXT    NOT NULL,  -- the persona on this node whose feed this lands in
    author_root  TEXT    NOT NULL,  -- who said it
    doc_id       TEXT    NOT NULL,  -- the PUBLIC document (hex) - the minted post, never a note
    title        TEXT    NOT NULL,
    format       TEXT,
    published_ms INTEGER NOT NULL,  -- when it was first said (genesis - the display date)
    updated_ms   INTEGER NOT NULL,  -- when it last changed (a re-publication moves only this)
    arrived_ms   INTEGER NOT NULL,  -- when it reached THIS node (set once, never rewritten)
    via_root     TEXT,               -- who SHARED it into this feed, if it arrived by rebroadcast;
                                     --   NULL means the reader follows author_root directly.
                                     --   A direct arrival always clears this (it is the stronger
                                     --   claim: you follow them, you are not being shown a share)
    settled      INTEGER NOT NULL DEFAULT 0, -- the author's no-shares-no-replies wish, off
                                     --   the journaled header (VISIBILITY.md) - so the card
                                     --   can hide the share button without a second read
    suggested_via TEXT,              -- via_root's SPECULATIVE sibling (DISCOVERY slice 2,
                                     --   2026-08-24): the introducer whose vouch journaled this
                                     --   row when the reader neither follows the author nor any
                                     --   sharer. NULL means the row is real. Any real arrival
                                     --   (follow or share) clears it in place - same primary
                                     --   key, marking shed, never a duplicate - and speculative
                                     --   writes never touch an existing row of any kind.
    PRIMARY KEY (reader_root, author_root, doc_id)
);
CREATE INDEX feed_journal_by_reader ON feed_journal (reader_root, published_ms);
-- The other direction: `fanout::retract_vanished` reconciles BY AUTHOR on every public move,
-- and both the PK and the reader index lead with reader_root - without this, that reconcile
-- is a full-table scan of every reader's rows. doc_id rides along so the DISTINCT doc_id
-- listing never touches the table itself.
CREATE INDEX feed_journal_by_author ON feed_journal (author_root, doc_id);

-- The journal's two durable clocks (2026-08-16): how far forward delivery has reached per
-- author, and how deep each reader's history dig has gone. Both exist because feed_journal
-- coverage must have NO HOLES after the follow point - the amnesia finding: the forward
-- high-water mark lived in memory, so a node dark (or merely rebooted) through more than one
-- page of posts journaled the newest page and silently skipped the rest, forever.
--
-- `journal_marks` is the forward mark, per AUTHOR because delivery is per author (one page
-- read serves every reader at once). `fanout::journal_for` pages the shelf down to this mark
-- - the exact-gap catch-up - so coverage stays contiguous from the top no matter how long
-- the node slept. Monotone on newest_ms, like chain_heads: lagging under-reports, and
-- under-reporting merely re-upserts (idempotent); leading would skip.
CREATE TABLE journal_marks (
    author_root TEXT    PRIMARY KEY,
    newest_ms   INTEGER NOT NULL   -- newest updated_ms already journaled for this author
);

-- `journal_fill` is the backward dig, per (reader, author) because history is per
-- relationship: a reader who follows someone today is owed their page down to the horizon
-- (one year - the follow point is the guarantee, genesis is not), a page per beat, never a
-- burst. The cursor is `public_docs`' keyset; NULL means the dig hasn't started (from the
-- top). Disposable like every memo: deleting a row costs one re-dig of idempotent upserts.
CREATE TABLE journal_fill (
    reader_root TEXT    NOT NULL,
    author_root TEXT    NOT NULL,
    cursor_ms   INTEGER,           -- resume below this genesis_ms...
    cursor_doc  TEXT,              -- ...and this doc_id (hex) at the tie
    done_ms     INTEGER,           -- reached the horizon or the shelf's end; NULL = digging
    PRIMARY KEY (reader_root, author_root)
);

-- Everyone who passed one document into one reader's feed: the crowd behind a feed row's byline.
--
-- `feed_journal` keeps ONE row per (reader, author, doc) - a post six people share is one entry in
-- a feed, not six - and its `via_root` names the INTRODUCER. This is the rest of them, so a row can
-- say "Sam and four others passed this along" and name the four when asked.
--
-- WHY A MEMO AND NOT A QUERY. The authoritative answer lives on each sharer's own chain, inside
-- their user database, so a page mentioning twelve sharers would open twelve encrypted files to
-- render one screen - precisely the fan-in thrash "one question, one database" exists to forbid.
-- `rebroadcast_pins` cannot answer it either, and that is by design rather than by omission:
-- pinning is an OBLIGATION a node takes on for its own personas (rebroadcast.rs, "fronting on a
-- foreign persona's say-so would be push"), so a reader's node holds no pin for a foreign sharer.
-- Journaling is delivery and runs for foreign sharers; pinning is hosting and does not.
--
-- Disposable like every memo here, and rebuildable from the sharers' chains.
--
-- Read JOINED against `subscriptions`, which is what keeps unfollowing a sharer correct with no
-- cleanup at all: the row stays, and simply stops counting. Deleted only where a share genuinely
-- ceases to exist - a withdrawal, an excised fragment, a persona leaving the node.
CREATE TABLE feed_shares (
    reader_root TEXT    NOT NULL,  -- whose feed
    author_root TEXT    NOT NULL,  -- whose document
    doc_id      TEXT    NOT NULL,  -- hex; the PUBLIC document
    via_root    TEXT    NOT NULL,  -- who passed it along. NEVER null, unlike feed_journal's
    shared_ms   INTEGER NOT NULL,  -- when this node first learned THIS sharer had shared it;
                                   --   ascending, so the earliest is the introducer
    PRIMARY KEY (reader_root, author_root, doc_id, via_root)
);
-- The PK's leading three columns serve the per-row read. This is the other direction: the
-- withdrawal and excise paths delete by the DOCUMENT, across every reader at once.
CREATE INDEX feed_shares_by_doc ON feed_shares (author_root, doc_id);

-- Documents this node holds WITHOUT holding their author: the fragment ledger (PROJECT_PLAN,
-- What travels with a share).
--
-- A reader following a sharer gets pointers - "B shared A's document D" - and needs D's words
-- without subscribing to A, because a chain pin must never propagate with viewing. So the node
-- fetches the one document, from the ORIGIN that handed it the pointer, and remembers three
-- things about it: what it is, who to ask again, and when it last checked.
--
-- `origin_root` is the revalidation edge and the reason retraction cascades: the author
-- tombstones, the sharer's pin sees it, the sharer answers Gone, this row dies, and anyone who
-- fetched from US hears the same on their next pass. Every edge in that tree already exists.
--
-- Disposable like every memo, with one wrinkle: it holds the author's exact signed entry, which
-- is the only copy of that document on this node (its author's chain is not here). Losing the
-- table loses nothing that cannot be re-fetched from the origin, and gains nothing by being
-- kept if the pointer that wanted it is gone.
CREATE TABLE fragments (
    author_root   TEXT    NOT NULL,  -- whose document it is
    doc_id        TEXT    NOT NULL,  -- hex
    origin_root   TEXT    NOT NULL,  -- who handed us the pointer; who we revalidate against
    version       TEXT    NOT NULL,  -- hex entry hash: the version's identity
    entry         BLOB    NOT NULL,  -- the author's exact signed bytes, provenance intact
    auth_path     BLOB    NOT NULL,  -- the delegation proof, travelling WITH the entry so this
                                     --   node can relay a fragment it can no longer re-derive
                                     --   (it does not hold the author's identity chain either)
    title         TEXT    NOT NULL,  -- denormalized for journaling, like feed_journal's own
    format        TEXT,
    body_hash     BLOB    NOT NULL,  -- the blob the words live in (fetched separately)
    genesis_ms    INTEGER,           -- the author's claimed first-publication stamp, off the
                                     --   signed header (2026-08-15): the edit window's anchor.
                                     --   NULL is FROZEN-FROM-BIRTH - media documents never
                                     --   edit and carry no genesis - so absence costs nothing
                                     --   and old rows freeze harmlessly
    fetched_ms    INTEGER NOT NULL,
    checked_ms    INTEGER NOT NULL,  -- last successful revalidation against the origin
    PRIMARY KEY (author_root, doc_id)
);
-- The revalidation sweep asks "what is due", oldest check first.
CREATE INDEX fragments_by_checked ON fragments (checked_ms);

-- WHO SERVED this author's fragments: the endpoint that actually answered an ask, stamped at
-- intake (2026-08-23). The heal rung the cascade diagnosis found missing: `origins_of` and
-- the sharers union both derive from what this node's own ledger NAMES, and a reader one
-- follow deep names exactly one sharer - when that sharer goes dark, every ledger-derived
-- candidate is dark with it, while the node that physically handed over the header (alive,
-- holding or knowing who holds the bytes) was remembered nowhere. Endpoint ids, not roots:
-- dialed directly, no resolution ladder. The `speculative_fetches.last_via` idiom, per
-- author. Read freshest-first, capped at read time - a census is not the point.
CREATE TABLE fragment_deliverers (
    author_root  TEXT    NOT NULL,
    endpoint_id  TEXT    NOT NULL,
    served_at_ms INTEGER NOT NULL,
    PRIMARY KEY (author_root, endpoint_id)
);

-- Why a MEDIA fragment exists: the posts that embed it (2026-08-14, the implicit-rebroadcast
-- slice - a share covers the post as seen, one pointer, one budget, one renderable whole).
-- A row is minted when a post fragment's signed `refs` name the media, reconciled when an
-- edit's refs change, and dropped when the covering post's fragment dies - a media fragment
-- with no covers left goes with it, which is the deletion cascade running on local refcount.
-- Deliberately NOT fragment_wants: the wants drain journals arrivals to the sharer's readers,
-- and an image is not a post - this table doubles as media's own retry ledger instead
-- (`heal_covers`: a cover whose media is not held is a fetch owed).
CREATE TABLE fragment_covers (
    author_root TEXT NOT NULL,
    media_doc   TEXT NOT NULL,  -- hex, the embedded document
    post_doc    TEXT NOT NULL,  -- hex, the covering post
    PRIMARY KEY (author_root, media_doc, post_doc)
);

-- Fragments this node WANTS and could not get: the recovery ledger for shares that arrived
-- before their content was reachable (the missing_bodies idiom - events for latency, sweeps
-- for recovery). A pointer folds, the fetch comes back Unknown, and without this row nothing
-- would ever retry: the share fold only re-runs when the SHARER's chain moves, so a race as
-- small as "C folded the pointer before B finished syncing the post" silently ate the share
-- forever. One row per unmet want; satisfied rows are deleted, hopeless ones age out.
CREATE TABLE fragment_wants (
    author_root    TEXT    NOT NULL,
    doc_id         TEXT    NOT NULL,
    origin_root    TEXT    NOT NULL,  -- the sharer whose readers want it; who we ask
    first_noted_ms INTEGER NOT NULL,
    last_tried_ms  INTEGER NOT NULL DEFAULT 0,
    tries          INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (author_root, doc_id)
);

-- Documents this node has LEARNED are gone: the delete memo (PROJECT_PLAN, Retraction, edits,
-- and what a node must remember forever).
--
-- The cascade's missing hop. A node that hears `Gone` drops the fragment - correctly - and in
-- doing so destroys its own ability to say what happened, so the next node down the share tree
-- asks it and gets `Unknown`, which means "keep". Deletion then propagates exactly two hops and
-- stops. A tombstone here outlives the content it describes, so a node can forget the words and
-- still answer for them, forever.
--
-- **Content-free, and that is what makes forever affordable**: an author root, a doc id, and
-- when we heard. Forty-eight bytes per document ever deleted anywhere we cared about - the one
-- fact that must stay answerable for all time, at the only size that makes "for all time" a
-- sentence anyone can afford to mean. The delete-summary filters that eventually ship between
-- nodes are a compression OF THIS TABLE, not a replacement for it.
-- Every death this node can prove: its tombstones, and also its retraction LOG - the two are
-- one table, because a tombstone that carries its proof is exactly one gossipable death.
-- `id` is the cursor peers resume from (WantDeaths{since}): AUTOINCREMENT for strictly-
-- increasing-forever, which is what makes "what died since N?" answerable with no timestamp
-- races and an empty page in the steady state. Rows are never deleted; growth scales with
-- regret (takedowns heard), never with the corpus.
CREATE TABLE fragment_tombstones (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    author_root TEXT    NOT NULL,
    doc_id      TEXT    NOT NULL,
    heard_ms    INTEGER NOT NULL,  -- when this node learned; local clock, never synced
    entry       BLOB    NOT NULL,  -- the author's signed post-retract: the PROOF, verified on
                                   --   receipt and served onward verbatim - a tombstone that
                                   --   could not show its evidence would be hearsay with a
                                   --   forever lifespan (2026-08-13)
    auth_path   BLOB    NOT NULL,  -- the delegation rungs tying its signer to the author's
                                   --   root, packed like fragments.auth_path and for the same
                                   --   reason: this node cannot re-derive what it never held
    UNIQUE (author_root, doc_id)   -- finality: one death per document, first proof wins
);

-- Where this node's next "what died since N?" resumes, per peer it asks. The cursor is the
-- PEER'S log id - opaque here, monotonic there - so nothing on this side ever compares clocks.
-- `asked_ms` orders the reap's politeness rotation, oldest-asked first.
CREATE TABLE death_cursors (
    origin_root TEXT    PRIMARY KEY,
    cursor      INTEGER NOT NULL,
    asked_ms    INTEGER NOT NULL
);

-- Why this node fronts a foreign identity it was never asked to follow: one of its personas
-- rebroadcast a document of theirs (PROJECT_PLAN, Rebroadcast: Pointer Plus Pinned Replica).
--
-- This IS the demand signal *Pull, Not Push* requires - "a node fronts an identity because
-- someone accountable on that node asked for it, never because the identity requested it" - and
-- a share is that ask, made by an accountable local persona. Bounded operator liability holds
-- unchanged: the node carries what its own users chose to carry.
--
-- A memo like every other: folded from the sharer's own rebroadcast chain (rebroadcast::
-- refresh_from), disposable, rebuildable. Its consumer is the sync worklist - a pinned author
-- keeps being refreshed even after every contact dial pointing at them goes back to nothing,
-- which is what makes "the author can still retract" true for a share that outlived a follow.
CREATE TABLE rebroadcast_pins (
    holder_root  TEXT    NOT NULL,  -- the local persona whose share obliges this node
    author_root  TEXT    NOT NULL,  -- the identity being fronted
    doc_id       TEXT    NOT NULL,  -- hex; the specific document shared
    version_seen TEXT,              -- hex of the endorsed version, for the drift badge
    updated_ms   INTEGER NOT NULL,
    PRIMARY KEY (holder_root, author_root, doc_id)
);
-- The sync worklist asks "which authors must we keep refreshing", author-first.
CREATE INDEX rebroadcast_pins_by_author ON rebroadcast_pins (author_root);

-- ---------------------------------------------------------------------------------------------
-- The notifications memo: derived events worth telling a local persona about, folded from
-- chains this node already syncs (PROJECT_PLAN, Arrival and Attention: the follow-edge rule's
-- derived side - never the envelope/inbox path, which is delivered and lives on chains).
--
-- One row per (reader, author, kind) - collapse by (sender, kind) is doctrine, so an author
-- re-publishing their edge updates a row rather than stacking rows. `public-edge` rows carry
-- the published bands verbatim; a retraction DELETES the row (stale flattery is not a
-- notification). DELIVERED, not SEEN, same as feed_journal: disposable, rebuildable from the
-- held chains x subscriptions; the seen watermark is the reader's own private-chain fact.
CREATE TABLE notifications (
    reader_root TEXT    NOT NULL,  -- the persona on this node being notified
    author_root TEXT    NOT NULL,  -- who did the thing
    kind        TEXT    NOT NULL,  -- 'public-edge' | 'rebroadcast' (future kinds get their own)
    -- WHICH thing, for kinds where that is a distinct fact - the shared document, hex. Empty
    -- string (never NULL: SQLite permits duplicate NULLs in a primary key, which would silently
    -- un-collapse the kinds that DO want collapsing) for kinds that are about a relationship
    -- rather than an object.
    --
    -- This is the seam between two different notions of "same event". A re-published edge is
    -- the SAME fact restated, so it must collapse; two of your posts being shared are two
    -- facts, and collapsing them would silently drop one. So the key carries the object when
    -- there is one.
    doc_id      TEXT    NOT NULL DEFAULT '',
    trust       TEXT,              -- the published trust band, as published
    interest    TEXT,              -- the published interest band, as published
    detail      TEXT,              -- the row's own words, for kinds that carry some - 'tagged':
                                   -- every current label that annotator has on that post, joined
    updated_ms  INTEGER NOT NULL,  -- when the winning statement reached THIS node
    PRIMARY KEY (reader_root, author_root, kind, doc_id)
);
CREATE INDEX notifications_by_reader ON notifications (reader_root, updated_ms);

-- ---------------------------------------------------------------------------------------------
-- The outbox: envelopes this node owes to strangers (PROJECT_PLAN, Arrival and Attention -
-- the DELIVERED path, sender side).
--
-- A row means "a persona here published an edge naming somebody who may not be syncing us, and
-- nobody has taken the news yet". One row per (sender, recipient, kind) - a re-published edge
-- replaces what was waiting, because only the newest statement is worth delivering. Retirement
-- is on ANY answer: accepted or refused both end the matter, and only silence earns another
-- rung on the backoff ladder.
CREATE TABLE outbound_notices (
    sender_root    TEXT    NOT NULL,  -- the local persona whose statement this announces
    recipient_root TEXT    NOT NULL,  -- the subject, who may be anywhere or nowhere
    kind           TEXT    NOT NULL,
    envelope       BLOB    NOT NULL,  -- the signed envelope, ready to hand over as-is
    first_noted_ms INTEGER NOT NULL,  -- when it was queued (news has a shelf life)
    last_tried_ms  INTEGER NOT NULL,  -- 0 = never tried, which is always due
    tries          INTEGER NOT NULL,
    PRIMARY KEY (sender_root, recipient_root, kind)
);

-- ---------------------------------------------------------------------------------------------
-- The media bake registry: external media a publication pulled INTO the network, one row per
-- (persona, source URL). Publication's copy-don't-flip crossing extends to what a post embeds:
-- a public post may not depend on a private blob (unreadable to strangers) or a foreign server
-- (gone tomorrow), so at publish time embedded external images/audio are downloaded, crushed
-- through the same pipeline as uploads, and minted as public media documents.
--
-- The row is BOTH pipeline state and provenance. Status walks pending -> fetching -> ready (or
-- failed, terminally, with a human tombstone); after that the row stays forever as the record
-- of where the bytes came from and when - and as the dedupe that lets the same URL, embedded
-- in a later post, reuse its baked twin instead of fetching again. (Provenance ON the public
-- header is owed at the next deliberate wire break; DocHeaderPlain is fixed-arity CBOR and a
-- new field today would invalidate every existing header, journals included.)
CREATE TABLE media_bakes (
    root_pubkey   TEXT    NOT NULL,  -- the persona whose publication pulled it in
    source_url    TEXT    NOT NULL,
    status        TEXT    NOT NULL,  -- pending | fetching | ready | failed
    public_doc_id TEXT,              -- hex, once ready
    error         TEXT,              -- the tombstone, once failed
    created_ms    INTEGER NOT NULL,
    fetched_ms    INTEGER,           -- when the bytes actually arrived (the provenance stamp)
    PRIMARY KEY (root_pubkey, source_url)
);

-- ---------------------------------------------------------------------------------------------
-- The gravedigger's ledger: referenced blobs this node has noticed it lacks. Headers ride
-- entry sync and bodies ride iroh-blobs behind them, so "I hold a head whose body isn't here"
-- is an ordinary transient - and, when the event-driven heals all miss (the pusher's poke
-- failed, nothing dials us again until the author's next post), a permanent one. This memo is
-- the recovery half: the body walk (`documents::fetch_missing_bodies`) already computes each
-- persona's missing set on every exchange, and instead of discarding the shortfall it records
-- it here; a periodic sweep re-tries the noted rows against the nodes most likely to hold the
-- bytes (the via that answered our fetch, the nodes that asked us, the device peers).
--
-- The memo idiom, disposable by design: the truth is doc_versions versus the blob store, and
-- this table is a note of their disagreement. Every walk REPLACES its persona's rows with the
-- freshly computed set, so satisfied rows clear on arrival (whatever path the bytes took) and
-- rows for documents that vanished (retraction, repudiation) clear on the next look. `tries`
-- and `last_tried_ms` belong to the SWEEP alone - walks never touch them - and drive backoff
-- so a permanently lost blob stops costing dials.
CREATE TABLE missing_bodies (
    root_pubkey    TEXT    NOT NULL,
    blob_hash      BLOB    NOT NULL,
    first_noted_ms INTEGER NOT NULL,
    last_tried_ms  INTEGER NOT NULL DEFAULT 0,  -- 0 = the sweep has never tried it
    tries          INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (root_pubkey, blob_hash)
);

-- ---------------------------------------------------------------------------------------------
-- The chain-heads memo: the tip of every chain this node stores, for every persona - fed at
-- WRITE time by the three places entries change (local append, sync ingest, gate eviction),
-- so that "did anything move?" is answerable from node.db without opening a single per-user
-- file. The frontier map derives from this; the backstop sweep's only remaining job is
-- reconciling it against `entries` after a crash between the two un-atomic writes.
--
-- PRIVATE CHAINS INCLUDED, deliberately (settled 2026-08-05). The earlier public-only rule for
-- node-level tables guarded against on-disk assembly - but node.db and every user database are
-- sealed by the SAME keystore, so an attacker who can read this table already holds the key to
-- every file it summarizes; dispersal was buying milliseconds. The rule that keeps its force is
-- the WIRE: private chain heads go only to member-proven peers, enforced at the exchange by
-- `is_private_service` - egress is the boundary, not table layout. (Foreign personas appear
-- public-only here automatically: the exchange never gives us their private chains to store.)
CREATE TABLE chain_heads (
    root_pubkey   TEXT    NOT NULL,  -- whose database the chain lives in
    author_pubkey TEXT    NOT NULL,  -- the device key that signs the chain
    service       INTEGER NOT NULL,
    floor_seq     INTEGER NOT NULL,  -- lowest stored seq (pruning/eviction moves it)
    head_seq      INTEGER NOT NULL,
    head_hash     BLOB    NOT NULL,  -- the tip entry's hash: which chain, not just how far
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (root_pubkey, author_pubkey, service)
);

-- ---------------------------------------------------------------------------------------------
-- What this node last ACTED ON of each persona's PUBLIC lane, one digest per (persona,
-- service) - DERIVED from chain_heads since 2026-08-05, which now owns the founding rationale
-- (answering "who changed?" without opening per-user files). What survives here, and why a
-- digest layer over the memo is still a table:
--
--   * The EDGE baseline: chain_heads is updated in place at write time and always shows NOW;
--     fan-out needs "changed since I last looked", and the compare against this row is that
--     edge. A state table cannot be its own acknowledgment cursor.
--   * The WIRE-comparable form: peer claims arrive and are judged as fingerprints
--     (identity_peers.seen_fp/chased_fp); the digest is the unit that crosses nodes.
--   * The per-service rollup: "did they post" vs "did they add a computer", folded once.
--
-- Why per SERVICE and not per persona: a single fingerprint over every public chain is maximally
-- sensitive, so adding a computer (an authorize entry on IDENTITY_PUBLIC) would wake every
-- follower to discover the person said nothing. Keyed this way, "did they post" (POSTS) is a
-- different question from "did they rename themselves" (PROFILE_PUBLIC). The persona-level
-- fingerprint is derived by hashing these rows in service order, so nothing is lost.
--
-- PUBLIC ONLY, structurally: the count and cadence of private activity is itself private
-- (PROJECT_PLAN, Chains), and this table is the input to things that get told to other people.
-- The filter is `net::sync::is_private_service` - one definition of private, the same one the
-- sync gate enforces.
CREATE TABLE persona_frontiers (
    root_pubkey TEXT    NOT NULL,
    service     INTEGER NOT NULL,
    held_fp     BLOB    NOT NULL,   -- blake3 over (author ‖ service ‖ head_hash), author-sorted
    held_at_ms  INTEGER NOT NULL,   -- when we last computed it, not when they wrote
    chains      INTEGER NOT NULL,   -- how many of their computers have written this service
    PRIMARY KEY (root_pubkey, service)
);

-- Adoption handshakes awaiting their grant code: the leaf keypair is minted (and sealed in the
-- keystore) at `begin`; this row links it to the requesting account until `complete` promotes
-- it into `identities` (or it is abandoned).
CREATE TABLE pending_adoptions (
    leaf_pubkey   TEXT    PRIMARY KEY,
    account_id    TEXT    NOT NULL,
    created_at_ms INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------------------------
-- Media ingest queue. Uploaded images/audio/video don't enter a user's record or the blob store
-- until they've been transcoded to a canonical AV1-family codec; while they wait, the raw upload
-- sits in the quarantine directory and one row here tracks it. Node-LOCAL operational state: it
-- describes THIS node's processing backlog, is never synced, and never becomes part of anyone's
-- record. Shared across all users because the workers are shared (a handful of them, not one per
-- user). FIFO by `seq`; per-account fairness is a deliberate non-goal until a node has enough
-- users for one uploader's dump to starve another. A version-less doc_id IS the pending state -
-- the document gets its first version only when transcode succeeds; a permanent failure leaves
-- the doc_id with no version, visible only here (the progress view), never as a ghost document.
CREATE TABLE ingest_job (
    seq             INTEGER PRIMARY KEY AUTOINCREMENT,  -- FIFO order; monotonic, no clock needed
    job_id          TEXT    NOT NULL UNIQUE,            -- external handle (hex), returned in the 202
    account         TEXT    NOT NULL,                   -- owning account (for the progress view)
    root            TEXT    NOT NULL,                   -- identity root pubkey hex (to open the store)
    doc_id          TEXT    NOT NULL,                   -- minted at enqueue, returned in the 202 (hex)
    parents         TEXT    NOT NULL DEFAULT '',        -- CSV of parent version hashes (empty = create)
    title           TEXT    NOT NULL,
    quarantine_path TEXT    NOT NULL,                   -- absolute path to the raw upload on disk
    status          TEXT    NOT NULL DEFAULT 'pending', -- pending | processing | done | failed
    error           TEXT,                               -- set when status = failed (the tombstone)
    bytes_in        INTEGER NOT NULL,                   -- raw upload size
    created_ms      INTEGER NOT NULL                    -- local display clock only, never synced
);
CREATE INDEX ingest_job_status_idx  ON ingest_job (status, seq);
CREATE INDEX ingest_job_account_idx ON ingest_job (account, seq);

-- Foreign-identity fetch memory: roots reached across the network on a member's request
-- (idface.rs fetch-and-serve). ON DISK deliberately (amended 2026-08-02 from an in-memory
-- map): once an identity's own nodes go permanently dark, it survives exactly in the nodes
-- that fetched it and their memory of having done so - a reboot forgetting the registry
-- would orphan chains this node still holds. Durable KNOWLEDGE, still member-scoped
-- SERVING: this table never feeds the identities table or the anonymous shelf, and it
-- deliberately stays out of identity_peers (the background sync worklist) - a fetch is
-- remembered, never promoted to fronting.
CREATE TABLE foreign_fetches (
    root_pubkey   TEXT    PRIMARY KEY,
    fetched_at_ms INTEGER NOT NULL,  -- last successful fetch; freshness TTL reads this
    last_via      TEXT               -- the endpoint key that answered; first refresh candidate
);

-- ---------------------------------------------------------------------------------------------
-- The speculative pass at posts depth (DISCOVERY.md slice 1, 2026-08-21): demand and quiet
-- acquisition for strangers a reader's trust admits but nobody here follows.
--
-- `speculative_demand` is the node-level rollup over each hosted reader's `implicit_edges`
-- (their own db): top-K targets per reader by composed level - promiscuity-discounted, MAX
-- across introducers and NEVER sums (the Sybil doctrine: a thousand fake vouches are worth one
-- best path) - capped by the acquisition budget, the bound on how many strangers' chains this
-- node holds on a reader's behalf however bushy the vouching gets. Each row carries the BEST
-- introducer: the dial target for acquisition and the byline for display. A memo like every
-- other - written by the implicit fold's own pass, stamp-swept per reader - so decay is free:
-- a withdrawn vouch recedes here on the beat it recedes from `implicit_edges`.
CREATE TABLE speculative_demand (
    reader_root     TEXT    NOT NULL,  -- whose implicit edges admitted the target
    target_root     TEXT    NOT NULL,  -- the stranger whose chains this node will quietly hold
    lane            TEXT    NOT NULL,  -- which lane won the rollup ('trust' | 'taste')
    introducer_root TEXT    NOT NULL,  -- the best path's introducer: acquisition dials THEIR node
    level           TEXT    NOT NULL,  -- band word, after the promiscuity discount
    depth           TEXT    NOT NULL,  -- 'posts' (under the acquisition budget) | 'headers'
                                       -- (the tier-2 tail: identity + profile only - the
                                       -- headers depth, DISCOVERY slice 5, depth-2 scoped)
    updated_at_ms   INTEGER NOT NULL,
    PRIMARY KEY (reader_root, target_root)
);
-- The acquisition pass asks "who wants this target" across every reader at once.
CREATE INDEX speculative_demand_by_target ON speculative_demand (target_root);

-- The replies memo: "replies known here", per post (COMMENTS.md slice 2 - assembly is
-- honest-partial by ruling). One row per VERIFIED reply link this node holds evidence
-- for: chain-held rows ride the fold lane and stamp-sweep with their author's shelf;
-- fragment-held rows live and die with their fragment. The permalink's thread read pages
-- this, and slice 6's author door serves from the same well.
CREATE TABLE post_replies (
    parent_author TEXT    NOT NULL,  -- hex root of the post replied to (the IMMEDIATE parent)
    parent_doc    TEXT    NOT NULL,  -- hex doc id
    reply_author  TEXT    NOT NULL,
    reply_doc     TEXT    NOT NULL,
    root_author   TEXT    NOT NULL,  -- the thread root, as the reply's header claims it
    root_doc      TEXT    NOT NULL,
    claimed_ms    INTEGER NOT NULL,  -- the reply's claimed stamp: ordering, replay-stable
    noted_ms      INTEGER NOT NULL,  -- the memo's own stamp: the whole-slice sweep's clock
    -- Which ROAD taught this node the row (the dossier, 2026-08-31): 'chain' (folded from
    -- a chain synced here), 'fragment' (rode a post fragment), 'envelope' (a COMMENT
    -- notice's kept evidence), 'door' (learned from the author's thread door). Carriage
    -- was the one unsigned act; this is its memory.
    learned_via   TEXT    NOT NULL DEFAULT 'chain',
    PRIMARY KEY (parent_author, parent_doc, reply_author, reply_doc)
);
-- Slice 6's door asks by thread root ("everything in Q's conversation") in one read.
CREATE INDEX post_replies_by_root ON post_replies (root_author, root_doc);
-- The reply-side lookups: the feed dresses a page's rows by (reply_doc IN ...) and the
-- fragment drop path deletes one (reply_author, reply_doc) pair; both walk this.
CREATE INDEX post_replies_by_reply ON post_replies (reply_doc, reply_author);
-- The fold sweep: DELETE per replier below a stamp, every fold - a scan that would
-- otherwise grow with every reply this node knows about anyone.
CREATE INDEX post_replies_by_replier ON post_replies (reply_author, noted_ms);

-- Annotation proofs (ANNOTATIONS.md slice 3): the annotator's exact signed statement and
-- its packed delegation path, kept so a label that arrived by fragment can ride the NEXT
-- fragment onward - virality is a relay of proofs, never of hearsay. One proof per live
-- statement; a retraction learned by proof deletes it (and its memo row).
CREATE TABLE annotation_proofs (
    annotator     TEXT NOT NULL,
    target_author TEXT NOT NULL,
    target_doc    TEXT NOT NULL,
    key           TEXT NOT NULL,
    value         TEXT NOT NULL,
    entry         BLOB NOT NULL,
    auth_path     BLOB NOT NULL,
    PRIMARY KEY (annotator, target_author, target_doc, key, value)
);
CREATE INDEX annotation_proofs_by_target ON annotation_proofs (target_author, target_doc);

-- The annotations memo (ANNOTATIONS.md slice 2): every public annotation this node can
-- verify, from the chains it holds - the author's own labels and anyone else's - one row
-- per (target, annotator, key, value). Folded on the fold lane per annotator, incremental
-- by stamp; a retraction on the chain deletes the row. Reads are page-scoped by the posts
-- on screen; the reader's display register decides whose labels render, at read.
CREATE TABLE doc_annotations (
    target_author TEXT    NOT NULL,
    target_doc    TEXT    NOT NULL,
    annotator     TEXT    NOT NULL,
    key           TEXT    NOT NULL,
    value         TEXT    NOT NULL,
    noted_ms      INTEGER NOT NULL,
    -- Which road taught this node the label (the dossier, 2026-08-31): 'chain' for the
    -- annotator's own synced chain, 'relay:<endpoint>' naming the peer whose fragment
    -- carried the proof in - the vector a harassed author reverse-engineers.
    learned_via   TEXT    NOT NULL DEFAULT 'chain',
    PRIMARY KEY (target_author, target_doc, annotator, key, value)
);
CREATE INDEX doc_annotations_by_annotator ON doc_annotations (annotator);

-- The author's thread door, three tables (COMMENTS.md slice 6).
--
-- A stranger's reply reaches its parent's author as a COMMENT notice whose evidence is the
-- reply's own signed header; the door serves that exact proof onward - the author serves
-- claims, never words - so the bytes are kept, one proof per reply, packed like a
-- fragment's path (fragments::pack_path).
CREATE TABLE reply_evidence (
    reply_author TEXT NOT NULL,
    reply_doc    TEXT NOT NULL,
    entry        BLOB NOT NULL,
    auth_path    BLOB NOT NULL,
    PRIMARY KEY (reply_author, reply_doc)
);

-- The curation memo: the persona's own private registers (approve/suppress per reply, and
-- the default mode), folded node-side on the ledger leg exactly as subscriptions are -
-- because the door answers peers, and a peer has no session to unseal with. Curation is
-- the same bit as display; suppression mutes the author's amplification, never the reply's
-- existence on its own author's chain. The mode row is the sentinel ('','') per root:
-- 'trusted' (default - followed repliers serve, strangers wait for the nod), 'all'
-- (auto-share; the choice becomes suppressing), 'none' (the "no comments" switch).
CREATE TABLE comment_curation (
    root         TEXT NOT NULL,
    reply_author TEXT NOT NULL,
    reply_doc    TEXT NOT NULL,
    verdict      TEXT NOT NULL,
    PRIMARY KEY (root, reply_author, reply_doc)
);

-- The reading side's budget: one cursor per thread this node has asked an author's door
-- about (the death-cursor discipline: the cursor is THEIR log's, opaque here), plus the
-- last ask's stamp so a visit-driven ask cannot become a hammer.
CREATE TABLE reply_cursors (
    parent_author TEXT NOT NULL,
    parent_doc    TEXT NOT NULL,
    cursor        INTEGER NOT NULL DEFAULT 0,
    asked_ms      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (parent_author, parent_doc)
);

-- The quiet twin of `foreign_fetches`: when the acquisition pass last reached each speculative
-- target, and through whom. A SEPARATE table because the two registries have opposite
-- consequences: a `foreign_fetches` row opens the sync door (`serve`'s wanted gate) and seats
-- the persona in the member directory - a member chose to meet them - while a speculative
-- mirror serves nobody and announces nothing (DISCOVERY.md invariants: no fronting, no push
-- participation, promotion only by a human dial). Only the node's own member surfaces read it.
CREATE TABLE speculative_fetches (
    target_root   TEXT    PRIMARY KEY,
    fetched_at_ms INTEGER NOT NULL,  -- last successful pull; the pass's staleness clock
    last_via      TEXT,              -- the endpoint that answered: the next pull's first rung
    depth         TEXT    NOT NULL DEFAULT 'posts' -- what the mirror HOLDS: a posts-depth
                                       -- pull supersedes headers and is never downgraded
);
