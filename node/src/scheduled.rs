//! The scheduled-publish sweep (PUBLISH.md slice 2). A draft whose preferred date lay in the
//! future was not minted; its plan sits on its private meta, naming the device that will
//! mint it. This pass walks the personas this node agents and mints what is due - through
//! the same bake door and the same after-mint duties as a hand publish, so a scheduled post
//! is indistinguishable from one posted at the moment.

use crate::record::store;
use crate::AppState;
use anyhow::Result;

#[derive(serde::Deserialize)]
struct Plan {
    at: i64,
    by: String,
    #[serde(default)]
    settled: bool,
    #[serde(default)]
    trusted_only: bool,
}

/// The periodic pass: every agented persona, everything due now.
pub async fn pass(state: AppState) -> Result<()> {
    let n = publish_due(&state, None, crate::clock::now_ms()).await?;
    if n > 0 {
        tracing::info!(minted = n, "scheduled publishes came due");
    }
    Ok(())
}

/// Mint every plan whose moment has passed (`now_ms`), for one persona or all. Returns how
/// many minted. A plan naming another device is that device's to mint - two devices never
/// race; a plan for a draft that turns out to be published already is simply spent.
pub async fn publish_due(state: &AppState, only_root: Option<&str>, now_ms: i64) -> Result<usize> {
    let roots: Vec<String> = match only_root {
        Some(r) => vec![r.to_string()],
        None => crate::identity::hosted_roots(&state.node_db).await?,
    };
    let mut minted = 0usize;
    for root in roots {
        if !crate::identity::is_agented(&state.node_db, &root).await.unwrap_or(false) {
            continue;
        }
        let data = match store::open_agented(state, &root).await {
            Ok(d) => d,
            Err(e) => {
                tracing::debug!(root = %root, error = ?e, "scheduled pass: could not open");
                continue;
            }
        };
        let view = match data.documents().all().await {
            Ok(v) => v,
            Err(e) => {
                tracing::debug!(root = %root, error = ?e, "scheduled pass: could not list");
                continue;
            }
        };
        let my_leaf = data.leaf_hex();
        for doc_id in view.docs.keys().copied().collect::<Vec<_>>() {
            let Ok(Some(raw)) = data.annotations().field(&doc_id, store::PUBLISH_PLAN).await else {
                continue;
            };
            if raw.trim().is_empty() {
                continue;
            }
            let Ok(plan) = serde_json::from_str::<Plan>(&raw) else {
                tracing::warn!(root = %root, doc = %hex::encode(doc_id), "unreadable publish plan");
                continue;
            };
            if plan.at > now_ms || plan.by != my_leaf {
                continue;
            }
            // Already public (a hand publish beat the sweep, or a sibling device minted
            // before the plan reached us)? Then the plan is spent, nothing to mint.
            if let Ok(Some(existing)) = data.annotations().field(&doc_id, store::PUBLISHED_AS).await {
                if !existing.trim().is_empty() {
                    let _ = data.annotations().set_field(&doc_id, store::PUBLISH_PLAN, "").await;
                    continue;
                }
            }
            let flags = crate::record::documents::PublishFlags {
                settled: plan.settled,
                trusted_only: plan.trusted_only,
                dated_ms: Some(plan.at),
                part_of: None,
            };
            match crate::record::bake::publish(state, &data, &root, &doc_id, None, flags).await {
                Ok(crate::record::bake::Outcome::Posted(post_id)) => {
                    if let Err(e) = crate::identity::after_posted(
                        state, &data, &root, &doc_id, post_id, None, flags,
                    )
                    .await
                    {
                        tracing::warn!(root = %root, error = ?e, "scheduled mint's after-duties failed; the post stands");
                    }
                    minted += 1;
                    tracing::info!(root = %root, post = %hex::encode(post_id), at = plan.at, "scheduled publish minted");
                }
                Ok(crate::record::bake::Outcome::Baking(_)) => {
                    tracing::debug!(root = %root, doc = %hex::encode(doc_id), "scheduled publish still baking");
                }
                Err(e) => {
                    tracing::warn!(root = %root, doc = %hex::encode(doc_id), error = ?e, "scheduled publish refused");
                }
            }
        }
    }
    Ok(minted)
}
