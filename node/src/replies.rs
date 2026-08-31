//! The replies memo: "replies known here", per post (PROJECT_PLAN's Replies slice 2).
//!
//! Nobody's chain holds "all replies to P" - assembly is honest-partial by ruling. This
//! node-level table folds the reply links it can VERIFY from things it already holds: the
//! signed headers on mirrored chains (a followed or visited replier), and the signed
//! headers on the fragment shelf (a reply met as a share). Each row is a claim this node
//! checked itself; the thread the permalink renders is exactly this set, cursor-paged,
//! and slice 6's author door serves from the same well.
//!
//! Two sources, two lifecycles:
//!   * **chain-held** rows ride the fold lane (`fold::run_chain` -> [`refresh_from`]) and
//!     are stamp-swept per reply author on every fold - a deleted reply's header leaves
//!     the shelf, and its row recedes on the same edge;
//!   * **fragment-held** rows are noted at intake ([`note_reply`], from `fragments::
//!     remember`) and forgotten when the fragment dies ([`forget_reply`], from the drop
//!     path) - the fragment lifecycle IS the row's.
//!
//! Owns the `post_replies` SQL (tests/conventions.rs).

use anyhow::{Context, Result};

use crate::clock::now_ms;
use crate::db::Db;
use crate::AppState;

/// One page of the thread read - keyset, oldest first (a conversation reads downward).
pub const REPLIES_PAGE: i64 = 20;

/// One known reply, as the memo serves it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct KnownReply {
    pub author: String,
    pub doc_id: String,
    /// The reply's claimed stamp - ordering only, replay-stable, the author's own number.
    pub claimed_ms: i64,
}

/// Note one verified reply link. Idempotent; the stamp refreshes so the chain sweep's
/// rewrite keeps rows it still sees.
async fn note(
    node_db: &Db,
    parent: &(String, String),
    root: &(String, String),
    reply_author: &str,
    reply_doc: &str,
    claimed_ms: i64,
    learned_via: &str,
) -> Result<()> {
    node_db
        .execute(
            "INSERT INTO post_replies
               (parent_author, parent_doc, reply_author, reply_doc,
                root_author, root_doc, claimed_ms, noted_ms, learned_via)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT (parent_author, parent_doc, reply_author, reply_doc) DO UPDATE SET
               root_author = excluded.root_author,
               root_doc = excluded.root_doc,
               claimed_ms = excluded.claimed_ms,
               noted_ms = excluded.noted_ms,
               learned_via = excluded.learned_via",
            (
                parent.0.as_str(),
                parent.1.as_str(),
                reply_author,
                reply_doc,
                root.0.as_str(),
                root.1.as_str(),
                claimed_ms,
                now_ms(),
                learned_via,
            ),
        )
        .await
        .context("noting a reply link")?;
    Ok(())
}

/// A reply arrived as a FRAGMENT: note its link from the verified header. The fragment
/// lifecycle owns the row from here ([`forget_reply`]).
pub async fn note_reply(
    node_db: &Db,
    reply_author: &str,
    verified: &ringtome_proto::fragment::VerifiedFragment,
) -> Result<()> {
    let Some((parent_root, parent_doc)) = verified.header.reply_to else {
        return Ok(());
    };
    let parent = (hex::encode(parent_root), hex::encode(parent_doc));
    let root = match verified.header.thread_root {
        Some((r, d)) => (hex::encode(r), hex::encode(d)),
        None => parent.clone(),
    };
    note(
        node_db,
        &parent,
        &root,
        reply_author,
        &hex::encode(verified.doc_id),
        verified.timestamp_ms,
        "fragment",
    )
    .await
}

/// A fragment died (takedown, withdrawal, eviction): its reply row goes with it - unless
/// the replier's CHAIN is also held here, in which case the fold lane's sweep owns the
/// row and will keep or recede it on its own evidence.
pub async fn forget_reply(node_db: &Db, reply_author: &str, reply_doc: &str) -> Result<()> {
    let chain_held = crate::net::frontier::has_service_chain(
        node_db,
        reply_author,
        ringtome_proto::registry::service::POSTS,
    )
    .await
    .unwrap_or(false);
    if chain_held {
        return Ok(());
    }
    node_db
        .execute(
            "DELETE FROM post_replies WHERE reply_author = ?1 AND reply_doc = ?2",
            (reply_author, reply_doc),
        )
        .await
        .context("forgetting a dead fragment's reply link")?;
    Ok(())
}

/// The fold-lane hook: rewrite one REPLIER's slice of the memo from their public shelf as
/// held right now. Stamp-swept like every whole-slice memo rewrite (subscriptions, the
/// demand memo): a reply whose header left the shelf - deleted, repudiated - recedes on
/// the same fold that noticed.
pub async fn refresh_from(state: &AppState, author_root: &str, force: bool) {
    if let Err(e) = refresh_inner(state, author_root, force).await {
        tracing::debug!(author = %author_root, error = ?e, "replies memo refresh failed");
    }
}

async fn refresh_inner(state: &AppState, author_root: &str, force: bool) -> Result<()> {
    let Ok(Some(db)) = state.user_dbs.get(author_root).await else {
        return Ok(()); // nothing held of them: the fragment path owns any rows
    };
    // The fingerprint gate (2026-08-28): a POSTS move that touched no reply - the common
    // one, a plain post - must not rewrite and re-stamp every reply row. (count, newest
    // head) changes on every reply add, edit, or deletion, and a boot-reset mark makes the
    // first fold after a restart rewrite once. `force` is the test beat's "unconditionally".
    if !replies_moved(state, &db, author_root, "replies-memo").await? && !force {
        return Ok(());
    }
    let replies = crate::record::documents::public_replies(&db)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    drop(db);
    let now = now_ms();
    for (doc_id, parent, root, claimed_ms) in &replies {
        note(
            &state.node_db,
            parent,
            root,
            author_root,
            &hex::encode(doc_id),
            *claimed_ms,
            "chain",
        )
        .await?;
    }
    // The stamp sweep: chain-sourced rows this rewrite did not touch lost the header that
    // justified them - a deleted reply recedes on the fold that noticed. Runs whenever the
    // CHAIN is genuinely held (we just read its shelf), fragment-sourced rows included:
    // if the chain is here, the shelf is the truth about this author's replies.
    state
        .node_db
        .execute(
            "DELETE FROM post_replies WHERE reply_author = ?1 AND noted_ms < ?2",
            (author_root, now),
        )
        .await
        .context("sweeping receded reply links")?;
    Ok(())
}

/// Which of these posts are replies, and to what: the feed page's quote-card read
/// (PROJECT_PLAN's Replies slice 3). Page-scoped by construction - one IN query over the page's doc
/// ids (`post_replies_by_reply`), pairs re-checked in Rust like `fanout`'s share read, so
/// the query shape stays portable. A post with no row here is not a reply, honestly:
/// the memo holds every reply this node journals a feed row FROM (both arrive by the same
/// chain or fragment), so absence means absence.
pub async fn links_for(
    node_db: &Db,
    posts: &[(String, String)],
) -> Result<std::collections::HashMap<(String, String), ReplyLinks>> {
    let docs: Vec<String> = posts
        .iter()
        .map(|(_, d)| d)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter(|d| !d.is_empty() && d.chars().all(|c| c.is_ascii_hexdigit()))
        .map(|d| format!("'{d}'"))
        .collect();
    if docs.is_empty() {
        return Ok(Default::default());
    }
    let rows: Vec<(String, String, String, String, String, String)> = node_db
        .fetch_all(
            &format!(
                "SELECT reply_author, reply_doc, parent_author, parent_doc, root_author, root_doc
                 FROM post_replies WHERE reply_doc IN ({})",
                docs.join(",")
            ),
            (),
        )
        .await
        .context("reading which posts are replies")?;
    Ok(rows
        .into_iter()
        .filter(|(a, d, ..)| posts.contains(&(a.clone(), d.clone())))
        .map(|(a, d, pa, pd, ra, rd)| {
            (
                (a, d),
                ReplyLinks {
                    parent: (pa, pd),
                    root: (ra, rd),
                },
            )
        })
        .collect())
}

/// A reply's two links as the memo holds them: the parent it answers, and the thread's
/// root (equal to the parent at depth one). The feed dresses both (Curtis, 2026-08-28:
/// deeper in a chain, the root should be visible too).
#[derive(Debug, Clone)]
pub struct ReplyLinks {
    pub parent: (String, String),
    pub root: (String, String),
}

/// How many replies this node THINKS each of these posts has - the honest-partial count
/// for the foot line ("3 replies"), page-scoped like `links_for`. Two indexed GROUP BYs,
/// merged by max: rows whose thread ROOT is the post count its whole known tree (a
/// top-level post - `post_replies_by_root`), rows whose PARENT is the post count direct
/// children (all a mid-thread reply can claim without walking, since its descendants'
/// root is the thread's top, not it - undercounting nested grandchildren is the honest
/// cheap answer, and the thread page shows the real shape). Max is exact for both cases:
/// a root's direct children are a subset of its tree, and nobody's root is a mid-thread
/// reply.
pub async fn known_counts(
    node_db: &Db,
    posts: &[(String, String)],
) -> Result<std::collections::HashMap<(String, String), i64>> {
    let docs: Vec<String> = posts
        .iter()
        .map(|(_, d)| d)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter(|d| !d.is_empty() && d.chars().all(|c| c.is_ascii_hexdigit()))
        .map(|d| format!("'{d}'"))
        .collect();
    if docs.is_empty() {
        return Ok(Default::default());
    }
    let mut out: std::collections::HashMap<(String, String), i64> = Default::default();
    for (a_col, d_col) in [("root_author", "root_doc"), ("parent_author", "parent_doc")] {
        let rows: Vec<(String, String, i64)> = node_db
            .fetch_all(
                &format!(
                    "SELECT {a_col}, {d_col}, COUNT(*) FROM post_replies
                     WHERE {d_col} IN ({}) GROUP BY {a_col}, {d_col}",
                    docs.join(",")
                ),
                (),
            )
            .await
            .context("counting known replies")?;
        for (a, d, n) in rows {
            if posts.contains(&(a.clone(), d.clone())) {
                let e = out.entry((a, d)).or_insert(0);
                *e = (*e).max(n);
            }
        }
    }
    Ok(out)
}

/// Did this author's reply set change since `consumer` last looked? Used by the memo
/// rewrite and the comment-notice fold - both derive from exactly that set - each under
/// its OWN mark (the first cut shared one, and whichever leg asked first consumed the
/// change for the other; five acceptance claims caught it). Records the new fingerprint
/// either way (a look is a look). The key is composed from the consumer, so the marks
/// table stays one map.
pub async fn replies_moved(
    state: &AppState,
    db: &Db,
    author_root: &str,
    consumer: &'static str,
) -> Result<bool> {
    let (n, ms) = crate::record::documents::public_replies_fingerprint(db)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let key = format!("{consumer}:{author_root}");
    let seen_n = state.sweep_marks.last("replies-n", &key);
    let seen_ms = state.sweep_marks.last("replies-ms", &key);
    state.sweep_marks.record("replies-n", &key, n);
    state.sweep_marks.record("replies-ms", &key, ms);
    Ok(seen_n != Some(n) || seen_ms != Some(ms))
}

/// The thread read: one page of a post's DIRECT replies, oldest first, keyset by
/// (claimed_ms, reply_doc). The UI recurses per level, depth-capped - a thousand-reply
/// tree is a read whose cost grows with history, so it pages or it does not ship.
pub async fn replies_of(
    node_db: &Db,
    parent_author: &str,
    parent_doc: &str,
    after: Option<(i64, String)>,
) -> Result<(Vec<KnownReply>, bool)> {
    let rows: Vec<(String, String, i64)> = match after {
        None => {
            node_db
                .fetch_all(
                    "SELECT reply_author, reply_doc, claimed_ms FROM post_replies
                     WHERE parent_author = ?1 AND parent_doc = ?2
                     ORDER BY claimed_ms, reply_doc LIMIT ?3",
                    (parent_author, parent_doc, REPLIES_PAGE + 1),
                )
                .await
        }
        Some((ms, doc)) => {
            node_db
                .fetch_all(
                    "SELECT reply_author, reply_doc, claimed_ms FROM post_replies
                     WHERE parent_author = ?1 AND parent_doc = ?2
                       AND (claimed_ms > ?3 OR (claimed_ms = ?3 AND reply_doc > ?4))
                     ORDER BY claimed_ms, reply_doc LIMIT ?5",
                    (parent_author, parent_doc, ms, doc.as_str(), REPLIES_PAGE + 1),
                )
                .await
        }
    }
    .context("reading the replies memo")?;
    let more = rows.len() as i64 > REPLIES_PAGE;
    let mut out: Vec<KnownReply> = rows
        .into_iter()
        .map(|(author, doc_id, claimed_ms)| KnownReply {
            author,
            doc_id,
            claimed_ms,
        })
        .collect();
    out.truncate(REPLIES_PAGE as usize);
    Ok((out, more))
}

// ---------------------------------------------------------------------------------------------
// The author's thread door (PROJECT_PLAN's Replies slice 6). The author is structurally the
// best-informed node about their own post's thread - every reply anywhere announces itself
// to them, by sync or by envelope - so their node serves a reply INDEX to anyone who asks:
// the repliers' own signed evidence, claims never words, curated by the author's own bit.

/// Proofs per `Replies` page - the deaths page's size, for the deaths page's reason.
const DOOR_PAGE: i64 = 8;

/// How long a visit-driven ask stays answered before the next visit may dial again.
const ASK_COOLDOWN_MS: i64 = 30_000;

pub const MODE_TRUSTED: &str = "trusted";
pub const MODE_ALL: &str = "all";
pub const MODE_NONE: &str = "none";
pub const VERDICT_APPROVED: &str = "approved";
pub const VERDICT_SUPPRESSED: &str = "suppressed";

/// Keep one envelope's evidence servable: the reply's signed header and the delegation path
/// that arrived with it. Written at the COMMENT gate (`inbox::accept`), read by the door.
pub async fn keep_evidence(
    node_db: &Db,
    reply_author: &str,
    reply_doc: &str,
    entry: &[u8],
    auth_path: &[Vec<u8>],
) -> Result<()> {
    node_db
        .execute(
            "INSERT INTO reply_evidence (reply_author, reply_doc, entry, auth_path)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (reply_author, reply_doc) DO UPDATE SET
                 entry = excluded.entry, auth_path = excluded.auth_path",
            (
                reply_author,
                reply_doc,
                entry.to_vec(),
                crate::fragments::pack_path(auth_path),
            ),
        )
        .await
        .context("keeping a reply's evidence")?;
    Ok(())
}

/// One COMMENT envelope's evidence, kept and noted in a single act: decode the header for
/// the reply's identity and links, keep the exact bytes for the door, note the claim into
/// the memo so the author's own thread view shows the stranger's reply (pending the nod).
pub async fn keep_claim(
    node_db: &Db,
    reply_author: &str,
    evidence: &[u8],
    auth_path: &[Vec<u8>],
) -> Result<()> {
    let signed = ringtome_proto::SignedEntry::decode(evidence)
        .map_err(|e| anyhow::anyhow!("decoding kept evidence: {e}"))?;
    let ringtome_proto::Payload::Inline(payload) = &signed.entry().payload else {
        anyhow::bail!("evidence header not inline");
    };
    let header = ringtome_proto::registry::DocHeaderPlain::decode(payload)
        .map_err(|e| anyhow::anyhow!("decoding evidence header: {e}"))?;
    let Some((pa, pd)) = header.reply_to else {
        anyhow::bail!("evidence is not a reply"); // verify_claim already refused this
    };
    let parent = (hex::encode(pa), hex::encode(pd));
    let root = match header.thread_root {
        Some((ra, rd)) => (hex::encode(ra), hex::encode(rd)),
        None => parent.clone(),
    };
    let doc_hex = hex::encode(header.doc_id);
    keep_evidence(node_db, reply_author, &doc_hex, evidence, auth_path).await?;
    note(
        node_db,
        &parent,
        &root,
        reply_author,
        &doc_hex,
        signed.entry().timestamp_ms,
        "envelope",
    )
    .await
}

async fn evidence_for(
    node_db: &Db,
    reply_author: &str,
    reply_doc: &str,
) -> Result<Option<(Vec<u8>, Vec<Vec<u8>>)>> {
    let row: Option<(Vec<u8>, Vec<u8>)> = node_db
        .fetch_optional(
            "SELECT entry, auth_path FROM reply_evidence
             WHERE reply_author = ?1 AND reply_doc = ?2",
            (reply_author, reply_doc),
        )
        .await
        .context("reading kept reply evidence")?;
    Ok(row.map(|(entry, packed)| (entry, crate::fragments::unpack_path(&packed))))
}

/// Re-fold one hosted persona's curation registers into the node memo - the subscriptions
/// idiom: the truth lives on the persona's own encrypted ledger (collection `comments`:
/// key `default` for the mode, `{replier}:{reply_doc}` for a verdict) and syncs with them;
/// the memo exists because the door answers peers, and a peer has no session to unseal
/// with. Rides the fold lane's ledger leg.
pub async fn curation_refresh_root(state: &AppState, root_hex: &str) {
    if let Err(e) = curation_refresh_inner(state, root_hex).await {
        tracing::debug!(root = %root_hex, error = ?e, "curation memo refresh failed");
    }
}

async fn curation_refresh_inner(state: &AppState, root_hex: &str) -> Result<()> {
    use anyhow::anyhow;
    let Some(leaf) =
        crate::identity::load_node_leaf_key(&state.node_db, &state.keystore, root_hex)
            .await
            .map_err(|e| anyhow!("{e}"))?
    else {
        return Ok(()); // not agented here: nothing to unseal, nothing to serve
    };
    let leaf_pub = leaf.verifying_key().to_bytes();
    let enc = crate::record::private::load_enc_keypair(&state.keystore, &hex::encode(leaf_pub))
        .map_err(|e| anyhow!("{e}"))?;
    let db = state.user_dbs.held(root_hex).await?;
    let keys = crate::record::private::unseal_epoch_keys(&db, &leaf_pub, &enc)
        .await
        .map_err(|e| anyhow!("{e}"))?;
    let (rows, _) = crate::record::private::collection_registers(
        &db,
        &keys,
        ringtome_proto::registry::service::GENERAL_PRIVATE,
        "comments",
    )
    .await
    .map_err(|e| anyhow!("{e}"))?;
    drop(db);
    state
        .node_db
        .execute("DELETE FROM comment_curation WHERE root = ?1", (root_hex,))
        .await
        .context("clearing the curation memo")?;
    for row in rows {
        if row.value.is_empty() {
            continue; // a cleared register is the absence of an opinion
        }
        let (replier, doc) = if row.key == "default" {
            (String::new(), String::new())
        } else {
            match row.key.split_once(':') {
                Some((a, d)) => (a.to_string(), d.to_string()),
                None => continue,
            }
        };
        state
            .node_db
            .execute(
                "INSERT INTO comment_curation (root, reply_author, reply_doc, verdict)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (root, reply_author, reply_doc) DO UPDATE SET
                     verdict = excluded.verdict",
                (root_hex, replier.as_str(), doc.as_str(), row.value.as_str()),
            )
            .await
            .context("writing the curation memo")?;
    }
    Ok(())
}

async fn curation_row(node_db: &Db, root: &str, replier: &str, doc: &str) -> Option<String> {
    node_db
        .fetch_optional(
            "SELECT verdict FROM comment_curation
             WHERE root = ?1 AND reply_author = ?2 AND reply_doc = ?3",
            (root, replier, doc),
        )
        .await
        .ok()
        .flatten()
        .map(|(v,): (String,)| v)
}

/// One reply's explicit verdict, if the author has given one.
pub async fn curation_verdict(
    node_db: &Db,
    root: &str,
    replier: &str,
    reply_doc: &str,
) -> Option<String> {
    curation_row(node_db, root, replier, reply_doc).await
}

/// The author's curation mode: 'trusted' unless their ledger says otherwise.
pub async fn curation_mode(node_db: &Db, root: &str) -> String {
    curation_row(node_db, root, "", "")
        .await
        .unwrap_or_else(|| MODE_TRUSTED.to_string())
}

/// The bit itself: does this author's node SPEAK about this reply - to the door, and on
/// every public read of their post's thread. An explicit verdict outranks the mode; the
/// trusted default serves followed repliers and holds strangers for the nod; 'all' flips
/// the choice into suppressing; 'none' is the "no comments" switch. Suppression mutes the
/// author's amplification, never the reply's existence on its own author's chain.
pub async fn servable(state: &AppState, root: &str, replier: &str, reply_doc: &str) -> bool {
    // The author's own reply is AUTHORING, not commenting (Curtis, 2026-08-28: a self-reply
    // was held for the nod because nobody follows themselves). It is never curated - not
    // held, not suppressible, and not silenced by the no-comments switch, which is about
    // other people's words on your post.
    if replier == root {
        return true;
    }
    let verdict = curation_row(&state.node_db, root, replier, reply_doc).await;
    if verdict.as_deref() == Some(VERDICT_SUPPRESSED) {
        return false;
    }
    // The switch is absolute (caught by its own acceptance, 2026-08-27): "no comments"
    // silences the whole thread, PAST approvals included - anything less and the switch
    // would be "no comments except the ones there already were", which nobody means by it.
    match curation_mode(&state.node_db, root).await.as_str() {
        MODE_NONE => false,
        MODE_ALL => true,
        _ => {
            verdict.as_deref() == Some(VERDICT_APPROVED)
                || crate::net::subscriptions::follows(&state.node_db, root, replier)
                    .await
                    .unwrap_or(false)
        }
    }
}

/// The dossier's reply ledger (2026-08-31): every row the memo holds for one post - direct
/// children and the known tree - with the road each arrived by. `(author, doc, direct,
/// claimed_ms, noted_ms, learned_via)`, oldest-noted first.
pub async fn ledger_for(
    node_db: &Db,
    root: &str,
    doc: &str,
) -> Result<Vec<(String, String, bool, i64, i64, String)>> {
    type Row = (String, String, String, String, i64, i64, String);
    let rows: Vec<Row> = node_db
        .fetch_all(
            "SELECT reply_author, reply_doc, parent_author, parent_doc,
                    claimed_ms, noted_ms, learned_via
             FROM post_replies
             WHERE (parent_author = ?1 AND parent_doc = ?2)
                OR (root_author = ?1 AND root_doc = ?2)
             ORDER BY noted_ms",
            (root, doc),
        )
        .await
        .context("reading the reply ledger")?;
    Ok(rows
        .into_iter()
        .map(|(author, rdoc, pa, pd, claimed_ms, noted_ms, learned_via)| {
            let direct = pa == root && pd == doc;
            (author, rdoc, direct, claimed_ms, noted_ms, learned_via)
        })
        .collect())
}

/// One page of the door's index for one post: rowid-cursored over the replies memo (an
/// upsert keeps its rowid, so a re-noted reply is not re-served; a new one appears; a
/// receded one vanishes), each row resolved to the replier's own signed proof from
/// whichever shelf holds it - kept envelope evidence, the fragment shelf, or the replier's
/// mirrored chain. Rows the curation bit withholds still advance the cursor - the page
/// walks the index, the bit decides what speaks.
pub async fn door_page(
    state: &AppState,
    parent_author: &str,
    parent_doc: &str,
    since: u64,
) -> (Vec<ringtome_proto::fragment::ReplyProof>, u64) {
    let hosted = crate::identity::hosted_roots(&state.node_db)
        .await
        .unwrap_or_default();
    if !hosted.iter().any(|r| r == parent_author) {
        return (Vec::new(), since); // not this node's author, not this node's door
    }
    let rows: Vec<(i64, String, String)> = match state
        .node_db
        .fetch_all(
            "SELECT rowid, reply_author, reply_doc FROM post_replies
             WHERE parent_author = ?1 AND parent_doc = ?2 AND rowid > ?3
             ORDER BY rowid LIMIT ?4",
            (parent_author, parent_doc, since as i64, DOOR_PAGE),
        )
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::debug!(error = ?e, "door index read failed");
            return (Vec::new(), since);
        }
    };
    let mut cursor = since;
    let mut proofs = Vec::new();
    for (rowid, replier_hex, doc_hex) in rows {
        cursor = rowid as u64;
        if !servable(state, parent_author, &replier_hex, &doc_hex).await {
            continue;
        }
        let Some(replier) = crate::pubkey::decode(&replier_hex) else {
            continue;
        };
        if let Some((entry, auth_path)) = resolve_proof(state, &replier_hex, &doc_hex).await {
            proofs.push(ringtome_proto::fragment::ReplyProof {
                replier,
                entry,
                auth_path,
            });
        }
    }
    (proofs, cursor)
}

/// The proof for one reply, from whichever shelf holds it. Cheapest first: the kept
/// envelope evidence and the fragment shelf are node.db reads; the mirror is a database
/// open and pays last.
async fn resolve_proof(
    state: &AppState,
    replier_hex: &str,
    doc_hex: &str,
) -> Option<(Vec<u8>, Vec<Vec<u8>>)> {
    if let Ok(Some(found)) = evidence_for(&state.node_db, replier_hex, doc_hex).await {
        return Some(found);
    }
    if let Ok(Some(found)) = crate::fragments::held_proof(&state.node_db, replier_hex, doc_hex).await
    {
        return Some(found);
    }
    let doc_bytes = hex::decode(doc_hex).ok()?;
    let doc_id = <[u8; 16]>::try_from(doc_bytes.as_slice()).ok()?;
    let db = state.user_dbs.get(replier_hex).await.ok().flatten()?;
    let entry = crate::record::documents::public_header_entry(&db, &doc_id)
        .await
        .ok()
        .flatten()?;
    let path = crate::record::documents::auth_path_for(&db, replier_hex, &entry)
        .await
        .ok()?;
    Some((entry.bytes().to_vec(), path))
}

/// The reading side's budget: whether a visit may dial the author's door now, and from
/// which cursor. `force` is the refresh affordance - a human asking again on purpose.
pub async fn should_ask(
    node_db: &Db,
    parent_author: &str,
    parent_doc: &str,
    force: bool,
) -> Option<u64> {
    let row: Option<(i64, i64)> = node_db
        .fetch_optional(
            "SELECT cursor, asked_ms FROM reply_cursors
             WHERE parent_author = ?1 AND parent_doc = ?2",
            (parent_author, parent_doc),
        )
        .await
        .ok()
        .flatten();
    let (cursor, asked_ms) = row.unwrap_or((0, 0));
    if force {
        // The deliberate re-ask starts over. The cursor idiom's one mismatch with a
        // MUTABLE bit (caught by the nod's own acceptance, 2026-08-27): a withheld row
        // advances the cursor, so a resume can never see it approved later - the human's
        // refresh re-reads the whole index, and the note() upsert makes the repeats free.
        return Some(0);
    }
    if now_ms() - asked_ms < ASK_COOLDOWN_MS {
        return None;
    }
    Some(cursor as u64)
}

/// Record an ask's outcome: the door's new cursor, and the stamp the cooldown reads.
pub async fn record_ask(
    node_db: &Db,
    parent_author: &str,
    parent_doc: &str,
    cursor: u64,
) -> Result<()> {
    node_db
        .execute(
            "INSERT INTO reply_cursors (parent_author, parent_doc, cursor, asked_ms)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (parent_author, parent_doc) DO UPDATE SET
                 cursor = excluded.cursor, asked_ms = excluded.asked_ms",
            (parent_author, parent_doc, cursor as i64, now_ms()),
        )
        .await
        .context("recording a door ask")?;
    Ok(())
}

/// Learn one verified page: note each claim into the memo (the thread shows the reply, by
/// name at least, on the next read) and go fetch the words through the ordinary machinery -
/// the replier's own public post, wanted from the replier themself. Claims teach WHICH
/// documents exist; `Want` fetches them; intake notes the fragment like any other.
pub async fn learn(
    state: &AppState,
    parent_author: &str,
    parent_doc: &str,
    verified: Vec<(ringtome_proto::fragment::ReplyProof, [u8; 16], i64)>,
) {
    let parent = (parent_author.to_string(), parent_doc.to_string());
    for (proof, reply_doc, claimed_ms) in verified {
        let replier_hex = hex::encode(proof.replier);
        let doc_hex = hex::encode(reply_doc);
        // The root link is not in hand here (the proof pins the parent); parent-as-root is
        // the honest default and the fragment intake corrects it from the full header.
        if let Err(e) = note(
            &state.node_db,
            &parent,
            &parent,
            &replier_hex,
            &doc_hex,
            claimed_ms,
            "door",
        )
        .await
        {
            tracing::debug!(error = ?e, "could not note a door-learned reply");
            continue;
        }
        let state = state.clone();
        tokio::spawn(async move {
            crate::fragments::fetch_post(&state, &replier_hex, &proof.replier, &reply_doc).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The memo's lifecycle in miniature: noted, re-noted (idempotent), paged in claimed
    /// order, and receded by the stamp sweep when a rewrite no longer sees it.
    #[tokio::test]
    async fn noted_paged_and_receded() {
        let db = crate::db::test_node_db().await;
        let parent = ("aa".repeat(32), "11".repeat(16));
        let root = parent.clone();
        note(&db, &parent, &root, &"bb".repeat(32), &"22".repeat(16), 5, "chain").await.unwrap();
        note(&db, &parent, &root, &"cc".repeat(32), &"33".repeat(16), 3, "chain").await.unwrap();
        note(&db, &parent, &root, &"bb".repeat(32), &"22".repeat(16), 5, "chain").await.unwrap();

        let (page, more) = replies_of(&db, &parent.0, &parent.1, None).await.unwrap();
        assert!(!more);
        assert_eq!(page.len(), 2, "idempotent noting: one row per reply");
        assert_eq!(page[0].claimed_ms, 3, "oldest first - a conversation reads downward");

        // The sweep, in production's exact order: cutoff FIRST, then the rewrite's notes
        // (stamped at-or-after it), then the delete of what the rewrite did not touch.
        // The tick of separation kills the same-millisecond hazard the first version of
        // this test had and the serialized fold lane never does.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let cutoff = now_ms();
        note(&db, &parent, &root, &"cc".repeat(32), &"33".repeat(16), 3, "chain").await.unwrap();
        db.execute(
            "DELETE FROM post_replies WHERE reply_author = ?1 AND noted_ms < ?2",
            ("bb".repeat(32), cutoff),
        )
        .await
        .unwrap();
        let (page, _) = replies_of(&db, &parent.0, &parent.1, None).await.unwrap();
        assert_eq!(page.len(), 1, "the header left the shelf; the row went with it");
        assert_eq!(page[0].author, "cc".repeat(32));
    }

    /// The foot-line count: a root sees its whole known tree, a mid-thread reply its
    /// direct children, and the max-merge never double-counts.
    #[tokio::test]
    async fn known_counts_root_tree_and_direct_children() {
        let db = crate::db::test_node_db().await;
        let root = ("aa".repeat(32), "11".repeat(16));
        let mid = ("bb".repeat(32), "22".repeat(16));
        // bb answers aa's post; cc answers bb's reply (root copied from the thread top).
        note(&db, &root, &root, &"bb".repeat(32), &"22".repeat(16), 1, "chain").await.unwrap();
        note(&db, &mid, &root, &"cc".repeat(32), &"33".repeat(16), 2, "chain").await.unwrap();
        let posts = vec![root.clone(), mid.clone(), ("dd".repeat(32), "44".repeat(16))];
        let counts = known_counts(&db, &posts).await.unwrap();
        assert_eq!(counts.get(&root), Some(&2), "the root counts its whole known tree");
        assert_eq!(counts.get(&mid), Some(&1), "a mid-thread reply counts its direct children");
        assert_eq!(counts.get(&posts[2]), None, "no replies, no entry - the foot stays quiet");
    }
}
