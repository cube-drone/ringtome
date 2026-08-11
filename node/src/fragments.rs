//! The fragment ledger: documents this node holds without holding their authors.
//!
//! The bookkeeping half of the reader's rebroadcast path (PROJECT_PLAN, *What travels with a
//! share*). `net::fragment` is the wire; this is the memory of what came over it, who to ask
//! again, and when we last checked.
//!
//! ## A claim, not a subscription
//!
//! Every row here exists because a local reader follows somebody who SHARED this document. It
//! carries no obligation to the author, creates no sync edge, and dies the moment the pointer
//! that wanted it does. That is the whole point: a reader receives a fragment, never a
//! subscription, or a dense network degrades to every persona synced to every computer.
//!
//! ## Revalidation is against the origin, and that is what makes deletion travel
//!
//! `origin_root` is who handed us the pointer. Asking THEM rather than the author means the
//! retraction cascade runs entirely over edges that already exist: the author tombstones, the
//! sharer's pin sees it, the sharer answers `Gone`, this row dies, and whoever fetched from us
//! hears the same on their next pass. Staleness is bounded per hop, which is the honest cost.

use anyhow::{Context, Result};

use crate::clock::now_ms;
use crate::db::Db;

/// One held fragment, as a journaling caller reads it. Deliberately not the whole row: the
/// origin and the body hash are the ledger's own business (revalidation, blob healing), and a
/// consumer that could see them would be tempted to act on them.
#[derive(Debug, Clone)]
pub struct Fragment {
    pub title: String,
    pub format: Option<String>,
}

/// Remember a verified fragment, or refresh what we already knew of it.
///
/// The version is allowed to move: an author editing inside the edit window re-signs the header,
/// and the origin will hand over the newer one. What may never move without a re-verification is
/// the entry itself, which is why the caller passes bytes that `verify_fragment` has already
/// approved rather than anything this function trusts on its own.
pub async fn remember(
    node_db: &Db,
    origin_root: &str,
    author_root: &str,
    verified: &ringtome_proto::fragment::VerifiedFragment,
    entry: &[u8],
    auth_path: &[Vec<u8>],
) -> Result<()> {
    let now = now_ms();
    node_db
        .execute(
            "INSERT INTO fragments
               (author_root, doc_id, origin_root, version, entry, auth_path, title, format,
                body_hash, fetched_ms, checked_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
             ON CONFLICT (author_root, doc_id) DO UPDATE SET
                 origin_root = excluded.origin_root,
                 version = excluded.version,
                 entry = excluded.entry,
                 auth_path = excluded.auth_path,
                 title = excluded.title,
                 format = excluded.format,
                 body_hash = excluded.body_hash,
                 checked_ms = excluded.checked_ms",
            (
                author_root,
                hex::encode(verified.doc_id),
                origin_root,
                hex::encode(verified.version),
                entry,
                pack_path(auth_path),
                verified.header.title.as_str(),
                crate::record::documents::Format::from_wire(verified.header.format)
                    .as_str()
                    .to_string(),
                verified.header.file_hash.to_vec(),
                now,
            ),
        )
        .await
        .context("remembering a fragment")?;
    Ok(())
}

/// Drop one fragment: the author withdrew it, or nobody wants it any more.
pub async fn forget(node_db: &Db, author_root: &str, doc_id: &str) -> Result<()> {
    node_db
        .execute(
            "DELETE FROM fragments WHERE author_root = ?1 AND doc_id = ?2",
            (author_root, doc_id),
        )
        .await
        .context("forgetting a fragment")?;
    Ok(())
}

/// One held fragment, if we have it.
pub async fn held(node_db: &Db, author_root: &str, doc_id: &str) -> Result<Option<Fragment>> {
    let row: Option<(String, Option<String>, Vec<u8>, String)> = node_db
        .fetch_optional(
            "SELECT title, format, body_hash, origin_root FROM fragments
             WHERE author_root = ?1 AND doc_id = ?2",
            (author_root, doc_id),
        )
        .await
        .context("reading a fragment")?;
    Ok(row.map(|(title, format, _body_hash, _origin_root)| Fragment { title, format }))
}

/// A fragment we can pass along, as the bytes a fragment response carries.
///
/// **Relaying is the availability story**: a node that fetched a share can answer for it, so a
/// document survives its author and its sharer both going dark, for as long as anyone who cared
/// about it is still up. The entry is handed on exactly as its author signed it, so the hop adds
/// nothing that has to be trusted.
///
/// The authorization path is stored beside the entry because it cannot be re-derived here: this
/// node does not hold the author's identity chain either. It travels with the entry, and the
/// receiving node re-verifies both.
pub async fn relayable(
    node_db: &Db,
    author_root: &str,
    doc_id: &[u8; 16],
) -> Result<Option<(Vec<u8>, Vec<Vec<u8>>)>> {
    let row: Option<(Vec<u8>, Vec<u8>)> = node_db
        .fetch_optional(
            "SELECT entry, auth_path FROM fragments WHERE author_root = ?1 AND doc_id = ?2",
            (author_root, hex::encode(doc_id)),
        )
        .await
        .context("reading a relayable fragment")?;
    let Some((entry, packed)) = row else {
        return Ok(None);
    };
    Ok(Some((entry, unpack_path(&packed))))
}

/// The authorization path, stored as one blob: a CBOR-free length-prefixed concatenation, because
/// this value is never read by anything but its own unpacker and a table column is not a protocol.
pub fn pack_path(path: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::new();
    for rung in path {
        out.extend_from_slice(&(rung.len() as u32).to_be_bytes());
        out.extend_from_slice(rung);
    }
    out
}

pub fn unpack_path(packed: &[u8]) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 4 <= packed.len() {
        let len = u32::from_be_bytes([packed[i], packed[i + 1], packed[i + 2], packed[i + 3]])
            as usize;
        i += 4;
        if i + len > packed.len() {
            break; // truncated: return what parsed, and the fragment simply fails re-verification
        }
        out.push(packed[i..i + len].to_vec());
        i += len;
    }
    out
}


/// The fragment path: get this document from the origin if we do not have it, and hand back what
/// a feed row needs.
///
/// **Fetch-on-journal rather than fetch-on-read.** A feed row carries a title, so the row cannot
/// exist until the document does - and doing it here means one fetch per shared document rather
/// than one per reader who scrolls past it. `None` means the share stays unjournaled for now,
/// which is the honest outcome when no origin will answer: the pointer is still on the chain and
/// the next fold tries again.
pub async fn journalable(
    state: &crate::AppState,
    origin_root: &str,
    author_root: &str,
    doc_id: &[u8; 16],
) -> Option<crate::fanout::JournalRow> {
    let doc_hex = hex::encode(doc_id);
    if let Ok(Some(f)) = held(&state.node_db, author_root, &doc_hex).await {
        return Some(row_of(&f, &doc_hex));
    }

    let author = crate::pubkey::decode(author_root)?;
    match crate::net::fragment::fetch(state, origin_root, &author, doc_id).await {
        crate::net::fragment::Fetched::Have(verified, entry, auth_path) => {
            if let Err(e) = remember(
                &state.node_db,
                origin_root,
                author_root,
                &verified,
                &entry,
                &auth_path,
            )
            .await
            {
                tracing::warn!(author = %author_root, error = ?e, "could not store a fragment");
                return None;
            }
            // The words themselves ride the ordinary blob lane behind the header, exactly as a
            // followed author's bodies do: note the shortfall and let `net::bodies` heal it.
            // A row whose body has not landed renders as "still arriving", which is a state the
            // feed already knows how to show.
            if let Err(e) =
                crate::net::bodies::want(&state.node_db, author_root, &verified.header.file_hash)
                    .await
            {
                tracing::debug!(author = %author_root, error = ?e, "could not note a fragment body");
            }
            let f = held(&state.node_db, author_root, &doc_hex).await.ok()??;
            Some(row_of(&f, &doc_hex))
        }
        crate::net::fragment::Fetched::Gone => {
            // The author withdrew it while it was being fetched. Drop whatever we held and do
            // not journal - "speech deletes", arriving down the share tree.
            tracing::debug!(
                author = %author_root, doc = %doc_hex,
                "a shared document was withdrawn by its author"
            );
            let _ = forget(&state.node_db, author_root, &doc_hex).await;
            None
        }
        crate::net::fragment::Fetched::Unknown => {
            // Logged, because silence here cost a debugging cycle: every origin answering
            // "I don't carry that" looks exactly like the fold never running.
            tracing::debug!(
                author = %author_root, origin = %origin_root, doc = %doc_hex,
                "no origin could serve this shared document"
            );
            None
        }
    }
}

fn row_of(f: &Fragment, doc_hex: &str) -> crate::fanout::JournalRow {
    // A fragment has no genesis/head stamps of its own - those are folded facts about a chain we
    // do not hold. The fetch moment is the honest stand-in: it is when this document became
    // available HERE, which is exactly what `arrived_ms` means for every other row.
    let now = crate::clock::now_ms();
    crate::fanout::JournalRow {
        doc_id_hex: doc_hex.to_string(),
        title: f.title.clone(),
        format: f.format.clone().unwrap_or_else(|| "plaintext".to_string()),
        published_ms: now,
        updated_ms: now,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_round_trips_through_its_column() {
        for path in [
            Vec::new(),
            vec![vec![1u8, 2, 3]],
            vec![vec![1u8; 40], vec![2u8; 7], vec![3u8; 100]],
        ] {
            assert_eq!(unpack_path(&pack_path(&path)), path);
        }
    }

    /// Truncation must degrade to a shorter path, never to a panic: the bytes come off disk, and
    /// a half-written row is a corruption to survive rather than to crash on. A short path fails
    /// `walk_auth_path` on the next use, which is the correct outcome.
    #[test]
    fn a_truncated_path_yields_what_parsed() {
        let packed = pack_path(&[vec![1u8; 10], vec![2u8; 10]]);
        assert_eq!(unpack_path(&packed[..packed.len() - 4]).len(), 1);
        assert!(unpack_path(&[0, 0, 0]).is_empty());
    }
}
