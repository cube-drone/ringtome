//! A memory of each picture a persona put on its own list (Curtis, 2026-11-05: "because we're
//! blocking based on hash, we don't have (and probably don't even WANT) the original image - but
//! then MANAGING the block list becomes functionally impossible"). When a picture entry is written,
//! the picture is fitted within 48x48 and dithered to black and white (media/image.rs, `sketch`),
//! enough for the list's keeper to remember which picture it was, not enough to go on showing it.
//!
//! The keeper's alone: kept on this server, beside the persona that wrote the entry, and shown only
//! to it - never on the public list, never sent to another node. Never kept for a quarantined
//! picture: quarantining one deletes every sketch of it (quarantine.rs, `seal`), a sealed blob is
//! never read to make one, and one is never shown while its picture is sealed.
//!
//! Owns the `picture_sketches` SQL (tests/conventions.rs).

use std::collections::HashMap;

use anyhow::Context;

use crate::AppState;

/// Sketch a picture `root` just listed, if this server holds it and it isn't sealed. Best effort:
/// an entry without a sketch is still an entry.
pub async fn keep(state: &AppState, root: &str, hash: &[u8; 32]) {
    let blob = iroh_blobs::Hash::from_bytes(*hash);
    let Ok(Some(bytes)) = state.files.get_for_sketch(blob).await else { return };
    let Ok(Some(png)) =
        crate::media::lane::background(move || crate::media::image::sketch(&bytes)).await
    else {
        return;
    };
    // Sealed while it was being drawn: not kept.
    if state.files.is_sealed(&blob) {
        return;
    }
    if let Err(e) = state
        .node_db
        .execute(
            "INSERT OR REPLACE INTO picture_sketches (root, hash, png, at_ms) VALUES (?1, ?2, ?3, ?4)",
            (root, hex::encode(hash), png, crate::clock::now_ms()),
        )
        .await
    {
        tracing::debug!(error = ?e, "could not keep a picture's sketch");
    }
}

/// `root` took a picture off its list: its sketch goes with it.
pub async fn forget(state: &AppState, root: &str, hash: &[u8; 32]) -> anyhow::Result<()> {
    state
        .node_db
        .execute(
            "DELETE FROM picture_sketches WHERE root = ?1 AND hash = ?2",
            (root, hex::encode(hash)),
        )
        .await
        .context("forgetting a picture's sketch")?;
    Ok(())
}

/// A picture was quarantined: every sketch of it, whoever's, goes.
pub async fn forget_picture(state: &AppState, hash: &[u8; 32]) -> anyhow::Result<()> {
    state
        .node_db
        .execute("DELETE FROM picture_sketches WHERE hash = ?1", (hex::encode(hash),))
        .await
        .context("forgetting a quarantined picture's sketches")?;
    Ok(())
}

/// `root`'s sketches, by picture hash (hex), as PNG bytes - none of a picture sealed now.
pub async fn of(state: &AppState, root: &str) -> anyhow::Result<HashMap<String, Vec<u8>>> {
    let rows: Vec<(String, Vec<u8>)> = state
        .node_db
        .fetch_all("SELECT hash, png FROM picture_sketches WHERE root = ?1", (root,))
        .await
        .context("reading a persona's sketches")?;
    Ok(rows
        .into_iter()
        .filter(|(hash, _)| {
            let sealed = <[u8; 32]>::try_from(hex::decode(hash).unwrap_or_default())
                .is_ok_and(|h| state.files.is_sealed(&iroh_blobs::Hash::from_bytes(h)));
            !sealed
        })
        .collect())
}
