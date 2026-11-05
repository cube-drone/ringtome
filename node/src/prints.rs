//! Picture fingerprints, kept (plans/SCANNING.md, _Fingerprints: PDQ_): a public picture's PDQ
//! (media/pdq.rs) is worked out once and remembered by its blob's hash, so the moderation lists'
//! picture entries can be checked against every picture a reader meets without decoding any of
//! them twice. Asked for, never swept: a picture is fingerprinted the first time something needs
//! its print - a picture entry being written, a card on screen while its reader takes picture
//! entries, an arrival while the refusal list holds anything.
//!
//! Only what this node holds, in the clear: the bytes are never fetched for the asking, a sealed
//! or blocked blob is never read, and an encrypted one has no picture to see.
//!
//! Owns the `picture_prints` SQL (tests/conventions.rs).

use anyhow::Context;

use crate::media::pdq::Pdq;
use crate::AppState;

/// Bigger than any still the crush makes.
const MAX_PICTURE_BYTES: u64 = 16 << 20;

/// The fingerprint of a public blob this node holds: `None` when it isn't here, or isn't an AVIF
/// picture. A picture too flat to fingerprint comes back with its low quality - `usable()` says.
pub async fn of(state: &AppState, hash: &[u8; 32]) -> Option<Pdq> {
    match remembered(state, hash).await {
        Ok(Some(known)) => return known,
        Ok(None) => {}
        Err(e) => tracing::debug!(error = ?e, "could not read a picture's print"),
    }
    let blob = iroh_blobs::Hash::from_bytes(*hash);
    // A picture of ours is small; anything bigger is a song or a video, not worth reading whole.
    if state.files.size_of(blob).await? > MAX_PICTURE_BYTES {
        return None;
    }
    let bytes = state.files.get_public_arriving(blob).await.ok()??;
    let print = if bytes.get(4..8) == Some(b"ftyp") {
        crate::media::lane::background(move || crate::media::image::fingerprint(&bytes))
            .await
            .ok()
            .flatten()
    } else {
        None
    };
    if let Err(e) = remember(state, hash, print.as_ref()).await {
        tracing::debug!(error = ?e, "could not keep a picture's print");
    }
    print
}

/// `Some(answer)` when the blob was fingerprinted before (the answer itself `None` for a blob that
/// isn't a picture); `None` when it never was.
async fn remembered(state: &AppState, hash: &[u8; 32]) -> anyhow::Result<Option<Option<Pdq>>> {
    let row: Option<(Option<String>, i64)> = state
        .node_db
        .fetch_optional(
            "SELECT pdq, quality FROM picture_prints WHERE hash = ?1",
            (hash.as_slice(),),
        )
        .await
        .context("reading a picture's print")?;
    Ok(row.map(|(pdq, quality)| {
        let hash = pdq.and_then(|h| hex::decode(h).ok()).and_then(|b| <[u8; 32]>::try_from(b).ok());
        hash.map(|hash| Pdq { hash, quality: quality.clamp(0, 100) as u8 })
    }))
}

async fn remember(state: &AppState, hash: &[u8; 32], print: Option<&Pdq>) -> anyhow::Result<()> {
    state
        .node_db
        .execute(
            "INSERT OR REPLACE INTO picture_prints (hash, pdq, quality, at_ms) VALUES (?1, ?2, ?3, ?4)",
            (
                hash.as_slice(),
                print.map(|p| hex::encode(p.hash)),
                print.map_or(0, |p| i64::from(p.quality)),
                crate::clock::now_ms(),
            ),
        )
        .await
        .context("keeping a picture's print")?;
    Ok(())
}
