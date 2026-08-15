//! The blob reaper's mark phase: every hash this node's ledgers still point at.
//!
//! Deletion of DOCUMENTS travels on its own (tombstones, cursors, the cover cascade), and every
//! one of those paths ends at a dropped row - never at dropped BYTES, because the file layer had
//! no delete at all. This module is the missing half for intermediary filesystems: iroh-blobs
//! runs mark-and-sweep on its own interval (`files::FileStore::gc_config`), and this is the
//! mark - the union of every reference class a node has:
//!
//!   * every held identity's `doc_versions` (both lanes: public bodies and thumbs, AND the
//!     encrypted private bodies that share the same store);
//!   * the fragment shelf, body plus thumb plus preview, decoded from the stored signed entry;
//!   * the wants ledger (`missing_bodies`) - a blob mid-heal is referenced by intent.
//!
//! **Any failure anywhere makes the whole run abort** (the `ProtectOutcome::Abort` contract): a
//! reaper that cannot see every reference must not reap. A missed class here deletes live user
//! data, which is why the walk is exhaustive-by-enumeration rather than clever - the put sites
//! in the tree are `put_encrypted`, `put_public` and the network heals, and every one of them
//! lands its hash in one of the three classes above.
//!
//! What this deliberately does NOT do: reap on the author's own account. A chain-held document's
//! blobs live exactly as long as its `doc_versions` rows - which the chain keeps forever - so an
//! author's retracted post keeps its bytes on the author's node until the author-side reaper
//! (the orphaned-twin story, NEXT_STEPS) retires the rows themselves. Intermediaries are the
//! nodes this frees: a fragment dies, its rows go, and the next round collects the bytes.

use std::collections::HashSet;

use anyhow::{Context, Result};
use iroh_blobs::Hash;

use crate::AppState;

/// Arm the file store's GC with this node's mark source. Called once at boot, after the
/// ledgers exist; until then (and on any later enumeration error) the GC aborts every run.
pub fn arm(state: &AppState) {
    let st = state.clone();
    state.files.arm_gc(std::sync::Arc::new(move || {
        let st = st.clone();
        Box::pin(async move { live_set(&st).await })
    }));
}

/// The union of every reference this node holds. `Err` anywhere is the whole answer - see the
/// module doc.
async fn live_set(state: &AppState) -> Result<HashSet<Hash>> {
    let mut live: HashSet<Hash> = HashSet::new();

    // The fragment shelf: body from the column, thumb and preview from the signed entry - a
    // decode failure is corruption, and a corrupt row aborts the run rather than silently
    // reaping the blobs it can no longer name.
    for hash in crate::fragments::blob_refs(&state.node_db).await? {
        live.insert(Hash::from_bytes(hash));
    }

    // Mid-heal wants: referenced by intent, protected until reconciled away.
    for hash in crate::net::bodies::wanted_hashes(&state.node_db).await? {
        live.insert(Hash::from_bytes(hash));
    }

    // Every held identity's documents, both lanes. One open per persona per reaper round
    // (half-hourly), which is the one legitimate whole-corpus walk in the tree: mark-and-sweep
    // is DEFINED as seeing everything, and a memo table repeating three columns of
    // doc_versions across every user db would be a second source of truth guarding against
    // the first.
    for root in state.user_dbs.held_roots().context("listing held identities")? {
        let db = state
            .user_dbs
            .held(&root)
            .await
            .with_context(|| format!("opening {root} for the reaper"))?;
        // Keys where this node holds them (`fetch_missing_bodies`' exact pattern), so the
        // fold inside `blob_refs` can materialize the private lane too - the mark must see
        // every row the chain implies, not whatever the last read happened to fold.
        let keys = match crate::identity::load_node_leaf_key(&state.node_db, &state.keystore, &root)
            .await
            .with_context(|| format!("loading {root}'s leaf for the reaper"))?
        {
            Some(leaf) => {
                let leaf_pub = leaf.verifying_key().to_bytes();
                let enc = crate::record::private::load_enc_keypair(
                    &state.keystore,
                    &hex::encode(leaf_pub),
                )
                .with_context(|| format!("loading {root}'s enc keypair for the reaper"))?;
                Some(
                    crate::record::private::unseal_epoch_keys(&db, &leaf_pub, &enc)
                        .await
                        .with_context(|| format!("unsealing {root}'s epochs for the reaper"))?,
                )
            }
            None => None,
        };
        for hash in crate::record::documents::blob_refs(&db, keys.as_ref()).await? {
            live.insert(Hash::from_bytes(hash));
        }
    }

    Ok(live)
}
