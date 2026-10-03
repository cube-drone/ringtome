//! The app's own pictures (Curtis, 2026-09-29): every PNG under the repository's `default_media/`,
//! compiled in by `build.rs`, in every persona's files - tagged by the folders it sits in
//! (`sticker/bodies/body_1.png` is `body_1`, tagged `sticker` and `bodies`). Nobody owns them and
//! nobody can delete them; the build decides what exists. Add a file and rebuild: everyone has it.
//! Remove it and rebuild: it's gone.
//!
//! **A built-in is not a document.** It lives in no chain, so a persona's list, picker and sticker
//! shelf are shown it at the stream boundary, and the private body and thumb doors answer for it
//! out of the binary. Its id is derived from its path, so the same file has the same id on every
//! node and across rebuilds.
//!
//! **Using one files a copy** (`adopt`). Publication and a chat's say bake a PRIVATE picture into
//! its public twin - sealed, onward-marked and covered like any other - and a built-in has no
//! private bytes to bake from. So the first time a persona puts one in something that bakes, the
//! node queues the PNG through the ordinary upload ingest under the built-in's own id: from then
//! on it IS one of their documents, every existing door works on it, and the list keeps showing
//! the built-in row in its place. If the build later drops the file, the copy stays theirs, and
//! surfaces in their files as an ordinary picture.

use std::collections::HashMap;
use std::sync::LazyLock;

mod table {
    include!(concat!(env!("OUT_DIR"), "/default_media.rs"));
}

/// One built-in picture.
pub struct BuiltIn {
    pub id: [u8; 16],
    /// The file's name without `.png` - what the list and the picker call it.
    pub title: String,
    /// The folders it sits in, outermost first, lowercased.
    pub tags: Vec<String>,
    pub bytes: &'static [u8],
    /// A hash of the bytes: the list row's head, so a changed file busts the page's cache.
    pub head: [u8; 32],
    pub width: u32,
    pub height: u32,
    /// An animated PNG (it carries an `acTL` chunk before its first frame).
    pub animation: bool,
}

/// The id a built-in's path names: the same path is the same picture on every node.
pub fn id_of(path: &str) -> [u8; 16] {
    let mut h = blake3::Hasher::new();
    h.update(b"ringtome default media v1\0");
    h.update(path.as_bytes());
    let mut id = [0u8; 16];
    id.copy_from_slice(&h.finalize().as_bytes()[..16]);
    id
}

fn read(path: &str, bytes: &'static [u8]) -> BuiltIn {
    let (dirs, file) = path.rsplit_once('/').unwrap_or(("", path));
    let title =
        file.strip_suffix(".png").or_else(|| file.strip_suffix(".PNG")).unwrap_or(file).to_string();
    let tags = dirs.split('/').filter(|d| !d.is_empty()).map(str::to_lowercase).collect();
    let (width, height, animation) = png_facts(bytes).unwrap_or((0, 0, false));
    BuiltIn {
        id: id_of(path),
        title,
        tags,
        bytes,
        head: *blake3::hash(bytes).as_bytes(),
        width,
        height,
        animation,
    }
}

/// Width, height and whether it animates, off the PNG's chunks - no decode.
fn png_facts(bytes: &[u8]) -> Option<(u32, u32, bool)> {
    if bytes.get(..8)? != b"\x89PNG\r\n\x1a\n" || bytes.get(12..16)? != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(bytes.get(16..20)?.try_into().ok()?);
    let height = u32::from_be_bytes(bytes.get(20..24)?.try_into().ok()?);
    // Walk the chunks until the first frame's data: an APNG says so in `acTL` before any `IDAT`.
    let mut at = 8;
    while let Some(len) = bytes.get(at..at + 4) {
        let len = u32::from_be_bytes(len.try_into().ok()?) as usize;
        match bytes.get(at + 4..at + 8)? {
            b"acTL" => return Some((width, height, true)),
            b"IDAT" | b"IEND" => break,
            _ => {}
        }
        at += 12 + len;
    }
    Some((width, height, false))
}

static ALL: LazyLock<Vec<BuiltIn>> =
    LazyLock::new(|| table::FILES.iter().map(|(path, bytes)| read(path, bytes)).collect());
static BY_ID: LazyLock<HashMap<[u8; 16], usize>> =
    LazyLock::new(|| ALL.iter().enumerate().map(|(i, b)| (b.id, i)).collect());

/// Every built-in, in path order.
pub fn all() -> &'static [BuiltIn] {
    &ALL
}

/// One hash over every built-in's id and bytes: what this build carries. The live stream's
/// resume cursor folds it in, so a page coming back to a rebuilt node that added, moved or
/// dropped a file gets a fresh list, not the one it kept (2026-09-29: a moved picture was
/// still offered under its old id).
pub fn fingerprint() -> [u8; 32] {
    static PRINT: LazyLock<[u8; 32]> = LazyLock::new(|| {
        let mut h = blake3::Hasher::new();
        for b in all() {
            h.update(&b.id);
            h.update(&b.head);
        }
        *h.finalize().as_bytes()
    });
    *PRINT
}

/// The built-in with this id, if the build carries one.
pub fn get(id: &[u8; 16]) -> Option<&'static BuiltIn> {
    BY_ID.get(id).map(|&i| &ALL[i])
}

/// Make sure `root` holds its own copy of built-in `id`, queueing one if not. `Ok(true)` when the
/// copy's bytes are here and it can be baked now; `Ok(false)` while it is on its way (a worker pass
/// or two - the caller says "ingesting", or waits).
pub async fn adopt(
    state: &crate::AppState,
    data: &crate::record::store::Store,
    root_hex: &str,
    id: &[u8; 16],
) -> Result<bool, crate::error::AppError> {
    use crate::error::AppError;
    let Some(b) = get(id) else {
        return Err(AppError::NotFound(crate::msg!(
            "builtin.not-in-this-build",
            "that picture no longer comes with the app"
        )));
    };
    let docs = data.documents();
    if docs.held(&[*id]).await?.contains(id) {
        return docs.media_bytes_present(id).await;
    }
    let account =
        crate::identity::account_of(&state.node_db, root_hex).await?.ok_or_else(|| {
            AppError::NotFound(crate::msg!(
                "builtin.no-such-persona-here",
                "that persona isn't kept on this computer"
            ))
        })?;
    match crate::ingest::latest_job_for_doc(&state.node_db, &account, &hex::encode(id)).await? {
        Some((status, _)) if status == "pending" || status == "processing" => return Ok(false),
        Some((status, error)) if status == "failed" => {
            let reason = error.unwrap_or_default();
            return Err(AppError::Unprocessable(crate::msg!(
                "builtin.copy-failed",
                "that picture couldn't be copied: {reason}",
                reason = reason
            )));
        }
        _ => {}
    }
    state
        .ingest
        .enqueue(
            &state.node_db,
            crate::ingest::Upload {
                account: &account,
                root: root_hex,
                doc_id: *id,
                parents: &[],
                title: &b.title,
                bytes: b.bytes,
                audio: None,
            },
        )
        .await?;
    Ok(false)
}

#[cfg(test)]
mod tests {
    /// The folders are the tags, the file's name is the title, and the id is the path's alone
    /// (2026-09-29): the same file is the same picture on every node and across rebuilds.
    #[test]
    fn a_path_names_its_tags_title_and_id() {
        static PNG: &[u8] = &[
            0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n', 0, 0, 0, 13, b'I', b'H', b'D', b'R',
            0, 0, 0, 48, 0, 0, 0, 32, 8, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, b'I', b'E', b'N',
            b'D', 0, 0, 0, 0,
        ];
        let b = super::read("sticker/Bodies/body_1.png", PNG);
        assert_eq!(b.title, "body_1");
        assert_eq!(b.tags, vec!["sticker", "bodies"]);
        assert_eq!((b.width, b.height, b.animation), (48, 32, false));
        assert_eq!(b.id, super::id_of("sticker/Bodies/body_1.png"));
        assert_ne!(b.id, super::id_of("sticker/body_1.png"), "a move is a different picture");
        assert!(super::read("loose.png", PNG).tags.is_empty(), "a file at the top has no tags");
    }

    /// The build carries the folder, and every file in it reads as a picture.
    #[test]
    fn the_build_carries_default_media() {
        assert!(!super::all().is_empty(), "default_media/ compiled in nothing");
        for b in super::all() {
            assert!(b.width > 0 && b.height > 0, "{} doesn't read as a PNG", b.title);
            assert!(
                std::ptr::eq(super::get(&b.id).unwrap(), b),
                "{} collides with another path",
                b.title
            );
        }
    }
}
