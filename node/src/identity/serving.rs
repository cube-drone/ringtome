//! Serving records: "our leaf serves this root, reachable at our endpoint" (PROJECT_PLAN,
//! Hosting and the Colocation Problem).
//!
//! UNIVERSAL since 2026-08-07 (the discoverability doctrine: participation implies
//! locatability, no dark personas): every hosted identity's record publishes, and the
//! republish pass walks all of them - "publication is an act" is retired for serving records.
//! The synced identity chain enumerates the leaves and each leaf's record resolves
//! authenticated, so the tree is the index of the whole live mesh (`net::sync::derive_peers`
//! is the consumer). `served_at_ms` remains as the HTTP-face flag it also was, but no longer
//! gates discovery. A record is a pointer + liveness signal, never a trust source -
//! chain-to-root verification happens at sync time (`proto::directory`).

use anyhow::anyhow;
use ringtome_proto::directory::{ServingRecord, SignedServingRecord, RECORD_VERSION};
use uuid::Uuid;

use crate::clock::now_ms;
use crate::error::AppError;
use crate::pubkey;
use crate::AppState;

/// Mark an identity as served - the publication act - and publish its record immediately.
pub async fn mark_served(
    state: &AppState,
    account_id: &Uuid,
    root_hex: &str,
) -> Result<(), AppError> {
    super::require_owned(&state.node_db, account_id, root_hex).await?;
    super::record_served(&state.node_db, root_hex).await?;
    publish_record(state, root_hex).await
}

/// Publish (or refresh) this node's serving record for an identity. Called at mark time and by
/// the republish loop. In mainline mode the pkarr packet is additionally signed by the leaf key
/// itself.
pub async fn publish_record(state: &AppState, root_hex: &str) -> Result<(), AppError> {
    let leaf_key = super::load_node_leaf_key(&state.node_db, &state.keystore, root_hex)
        .await?
        .ok_or_else(|| AppError::NotFound(crate::msg!("identity.serving.identity-not-found", "identity not found")))?;

    let record = ServingRecord {
        v: RECORD_VERSION,
        root: pubkey::require(root_hex, "root pubkey")?,
        node_key: leaf_key.verifying_key().to_bytes(),
        endpoint_id: *state.endpoint.id().as_bytes(),
        timestamp_ms: now_ms(),
    };
    let signed = SignedServingRecord::create(&record, &leaf_key)
        .map_err(|e| AppError::Internal(anyhow!("signing serving record: {e}")))?;

    match &state.directory {
        crate::net::discovery::Directory::Mainline(m) => m
            .publish_serving_with_key(&signed, &leaf_key.to_bytes())
            .await
            .map_err(AppError::Internal)?,
        other => other
            .publish_serving(&signed)
            .await
            .map_err(AppError::Internal)?,
    }
    Ok(())
}

/// One pass of the serving-record republish loop: refresh the record of EVERY hosted
/// identity (universal publication - the discoverability doctrine). Per-identity failures
/// are logged and skipped - one identity's bad state must not starve the rest of the
/// worklist, and Directory::Off makes every publish a warn, not a wedge.
pub async fn republish_pass(state: AppState) -> anyhow::Result<()> {
    for root in crate::identity::hosted_roots(&state.node_db).await? {
        if let Err(e) = publish_record(&state, &root).await {
            tracing::warn!(root = %root, "serving record republish failed: {e:#}");
        }
    }
    Ok(())
}

/// Publish immediately and tolerate failure - the shape adoption and identity creation want:
/// the republish loop will retry on its beat, and a dark directory must not fail a ceremony.
pub async fn publish_best_effort(state: &AppState, root_hex: &str) {
    if let Err(e) = publish_record(state, root_hex).await {
        tracing::debug!(root = %root_hex, "immediate serving publish skipped: {e:#}");
    }
}
