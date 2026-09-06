//! The raw-entry journal: the append-only flat file that makes every per-user database derived
//! state (PROJECT_PLAN, The Substrate - the insurance that lets a beta database engine sit
//! under the views).
//!
//! One file per identity, `<data_dir>/journals/<root_pubkey_hex>.jnl`: an 8-byte header
//! (magic plus format version), then repeating frames of `[u32 LE length][envelope bytes]`.
//! Nothing else - no checksums, no timestamps: entries are signed envelopes, and replay
//! re-runs the full validation gate, so integrity rides the signatures.
//!
//! **Plaintext, deliberately.** Entries self-protect (signatures for integrity, epoch ciphertext
//! for private payloads), and a recovery artifact must be readable with zero key material. Its
//! confidentiality posture is the disk's - an accepted, named trade (the at-rest metadata of
//! private activity).
//!
//! **The write-ahead invariant: journal ⊇ database - for durable services.** Every accepted
//! entry is framed and fsynced here *before* its row lands in the entries table (both insert
//! sites: `imaol::append` and sync's store path). The journal never deletes: rows later
//! evicted as proven forgeries stay behind as dead frames, and duplicate frames are possible -
//! replay is safe against both because it is just the sync gate re-run (duplicate-skip,
//! revocation ceilings, the lot).
//!
//! **The one exception (2026-08-09): ephemeral services.** The inbox tiers
//! (`sync::service_allows_suffix`) never write frames here, on any path - not append, not
//! sync arrival, not backfill. Their cargo is forgettable by charter, their chains prune by
//! policy, and journaling a stranger-flood's notices forever was the one unbounded artifact
//! this file could still become. What must survive a database catastrophe for them is a
//! single fact - where each locally-authored chain ENDED, so a rebuilt device continues
//! instead of re-genesising into self-equivocation - and that lives in the flat-file
//! checkpoint beside this one (`record::heads`), same trust class, no database in the loop.
//! Consequence for replay: a rebuilt database comes back without inbox chains, correctly;
//! the surviving suffix re-arrives from siblings by sync.
//!
//! **The torn-tail rule.** Append-only means corruption can only be a truncated final frame. On
//! open, the file is scanned and cut back to the last complete frame boundary; appends then
//! proceed blindly.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context, Result};

use crate::db::Db;

/// File magic: the first six bytes of every journal.
const MAGIC: &[u8; 6] = b"RTJRNL";
/// Journal format version, stored LE in the header's last two bytes.
const FORMAT_VERSION: u16 = 1;
/// Header length: magic + version.
const HEADER_LEN: usize = 8;
/// Each frame starts with a u32 LE byte length.
const FRAME_LEN_BYTES: usize = 4;

// ---------------------------------------------------------------------------------------------
// The framing core: pure functions over byte buffers.

/// The 8-byte file header.
fn header() -> [u8; HEADER_LEN] {
    let mut h = [0u8; HEADER_LEN];
    h[..MAGIC.len()].copy_from_slice(MAGIC);
    h[MAGIC.len()..].copy_from_slice(&FORMAT_VERSION.to_le_bytes());
    h
}

/// One envelope as a frame: `[u32 LE length][bytes]`.
fn encode_frame(envelope: &[u8]) -> Result<Vec<u8>> {
    let len = u32::try_from(envelope.len()).context("envelope too large for a journal frame")?;
    let mut frame = Vec::with_capacity(FRAME_LEN_BYTES + envelope.len());
    frame.extend_from_slice(&len.to_le_bytes());
    frame.extend_from_slice(envelope);
    Ok(frame)
}

/// Byte length of the valid prefix of a journal image: the header plus every complete frame.
///
/// A file shorter than the header is a torn first write - valid prefix 0, rewrite the header. A
/// complete header with the wrong magic or version is *not* torn: it is not our file, and gets
/// an error rather than a truncate-over.
fn valid_prefix_len(buf: &[u8]) -> Result<usize> {
    if buf.len() < HEADER_LEN {
        return Ok(0);
    }
    if buf[..MAGIC.len()] != *MAGIC {
        bail!("not a journal file (bad magic)");
    }
    if buf[MAGIC.len()..HEADER_LEN] != FORMAT_VERSION.to_le_bytes() {
        bail!("unsupported journal format version");
    }
    let mut end = HEADER_LEN;
    // A frame counts only when its length prefix *and* its full body are present; the first
    // torn one (mid-length or mid-body) ends the valid prefix.
    while let Some(len_bytes) = buf.get(end..end + FRAME_LEN_BYTES) {
        let len = u32::from_le_bytes(len_bytes.try_into().expect("sliced 4 bytes")) as usize;
        if buf
            .get(end + FRAME_LEN_BYTES..end + FRAME_LEN_BYTES + len)
            .is_none()
        {
            break;
        }
        end += FRAME_LEN_BYTES + len;
    }
    Ok(end)
}

/// Every complete frame's envelope, in append order. Tolerates a torn tail (same rule as open);
/// refuses a foreign header.
fn decode_frames(buf: &[u8]) -> Result<Vec<Vec<u8>>> {
    let end = valid_prefix_len(buf)?;
    let mut frames = Vec::new();
    let mut at = HEADER_LEN.min(end);
    while at < end {
        let len = u32::from_le_bytes(
            buf[at..at + FRAME_LEN_BYTES]
                .try_into()
                .expect("sliced 4 bytes"),
        ) as usize;
        at += FRAME_LEN_BYTES;
        frames.push(buf[at..at + len].to_vec());
        at += len;
    }
    Ok(frames)
}

// ---------------------------------------------------------------------------------------------
// The filesystem layer: a thin handle over one journal file.

/// One identity's open journal. Cheap to clone; clones share one append handle, and appends are
/// serialized behind the mutex (never held across an await - the file work is synchronous and
/// local).
#[derive(Clone)]
pub struct Journal {
    inner: Arc<JournalInner>,
}

struct JournalInner {
    path: PathBuf,
    file: Mutex<File>,
}

impl Journal {
    /// Attach to an already-validated journal for appending: no read, no frame walk. The
    /// torn-tail rule is CRASH RECOVERY (see `open`), and within one process run every byte
    /// past the first check was written here as a whole frame - so re-walking the file on
    /// every handle-cache miss is re-checking our own work, at a cost that grows with the
    /// identity's whole history. `UserDbManager` validates once per journal per run and uses
    /// this thereafter (2026-08-08; the deep test-data scenarios are where a megabyte journal
    /// re-read per miss would have hurt most).
    ///
    /// Only sound because this node owns its data directory: a SECOND writer appending mid-run
    /// would go unchecked here - which is a scenario that corrupts far more than journals.
    pub fn reopen(path: &Path) -> Result<Journal> {
        let file = OpenOptions::new()
            .append(true)
            .open(path)
            .with_context(|| format!("reopening journal {}", path.display()))?;
        Ok(Journal {
            inner: Arc::new(JournalInner {
                path: path.to_path_buf(),
                file: Mutex::new(file),
            }),
        })
    }

    /// Open (creating if absent) the journal at `path`, applying the torn-tail rule: a file
    /// ending mid-frame is truncated back to the last complete frame boundary, once, here -
    /// after which appends proceed blindly. Costs a full read and frame walk, so callers that
    /// reopen the same journal repeatedly want `reopen` after the first time.
    pub fn open(path: &Path) -> Result<Journal> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating journal directory {}", parent.display()))?;
        }
        let existing = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e).with_context(|| format!("reading journal {}", path.display())),
        };
        let valid = valid_prefix_len(&existing)
            .with_context(|| format!("scanning journal {}", path.display()))?;
        if valid == 0 {
            // Missing, empty, or torn inside the header: (re)start the file.
            std::fs::write(path, header())
                .with_context(|| format!("writing journal header {}", path.display()))?;
        } else if valid < existing.len() {
            OpenOptions::new()
                .write(true)
                .open(path)
                .and_then(|f| f.set_len(valid as u64))
                .with_context(|| format!("truncating torn journal tail {}", path.display()))?;
            tracing::warn!(
                journal = %path.display(),
                torn_bytes = existing.len() - valid,
                "journal ended mid-frame; truncated to last complete frame"
            );
        }
        let file = OpenOptions::new()
            .append(true)
            .open(path)
            .with_context(|| format!("opening journal {}", path.display()))?;
        file.sync_data()
            .with_context(|| format!("syncing journal {}", path.display()))?;
        Ok(Journal {
            inner: Arc::new(JournalInner {
                path: path.to_path_buf(),
                file: Mutex::new(file),
            }),
        })
    }

    /// Whether the journal holds no frames (header only). The backfill trigger.
    pub fn is_empty(&self) -> Result<bool> {
        let file = self.inner.file.lock().expect("journal mutex poisoned");
        let len = file
            .metadata()
            .with_context(|| format!("statting journal {}", self.inner.path.display()))?
            .len();
        Ok(len <= HEADER_LEN as u64)
    }

    /// Append one envelope as a frame and fsync it. Call *before* the corresponding database
    /// insert - the write-ahead half of journal ⊇ database.
    pub fn append(&self, envelope: &[u8]) -> Result<()> {
        let frame = encode_frame(envelope)?;
        let mut file = self.inner.file.lock().expect("journal mutex poisoned");
        file.write_all(&frame)
            .and_then(|()| file.sync_data())
            .with_context(|| format!("appending to journal {}", self.inner.path.display()))
    }

    /// Append many envelopes with a single fsync at the end - the backfill path.
    pub fn append_all(&self, envelopes: &[Vec<u8>]) -> Result<()> {
        let mut file = self.inner.file.lock().expect("journal mutex poisoned");
        for envelope in envelopes {
            let frame = encode_frame(envelope)?;
            file.write_all(&frame)
                .with_context(|| format!("appending to journal {}", self.inner.path.display()))?;
        }
        file.sync_data()
            .with_context(|| format!("syncing journal {}", self.inner.path.display()))
    }
}

// ---------------------------------------------------------------------------------------------
// Reading and replay.

/// Every envelope in the journal at `path`, in append order (torn tail tolerated).
pub fn read_journal(path: &Path) -> Result<Vec<Vec<u8>>> {
    let bytes =
        std::fs::read(path).with_context(|| format!("reading journal {}", path.display()))?;
    decode_frames(&bytes).with_context(|| format!("decoding journal {}", path.display()))
}

/// Rebuild a database's entries (and views) from a journal alone: read every frame and push the
/// batch through the same validation gate sync uses - strict decode, signatures, chain
/// contiguity, key-tree membership, revocation ceilings. There is deliberately no second insert
/// path: the journal is just what sync would send, written down, so replay *is* sync from a peer
/// that happens to be a file. Idempotent (the gate duplicate-skips), and dead frames - forged
/// prefixes a later revocation disproved, or the loser of an append race - are rejected or
/// skipped the same way live sync would.
///
/// The target database should not carry a journal handle on the same file (a fresh rebuild
/// target normally has none); if it does, re-accepted entries are re-framed - harmless
/// duplicates on the next replay, but pointless growth.
///
/// Returns `(accepted, rejected)`.
#[allow(dead_code)] // consumer: the admin rebuild surface (plan-in-hand); exercised by tests today
pub async fn rebuild_from_journal(db: &Db, root: [u8; 32], path: &Path) -> Result<(u64, u64)> {
    let raw = read_journal(path)?;
    let outcome = crate::net::sync::ingest_batch(db, root, raw, true, None, None).await?;
    Ok((outcome.received, outcome.rejected))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::imaol;
    use ringtome_proto::registry::{entry_type, service};
    use ringtome_proto::{Payload, SigningKey};
    use std::time::{SystemTime, UNIX_EPOCH};

    // -----------------------------------------------------------------------------------------
    // The framing core: bytes in, frames out. No filesystem.

    #[test]
    fn frames_round_trip() {
        let envelopes = vec![vec![], vec![1, 2, 3], vec![0xff; 300]];
        let mut buf = header().to_vec();
        for e in &envelopes {
            buf.extend(encode_frame(e).unwrap());
        }
        assert_eq!(valid_prefix_len(&buf).unwrap(), buf.len());
        assert_eq!(decode_frames(&buf).unwrap(), envelopes);
    }

    #[test]
    fn torn_tails_cut_back_to_the_last_complete_frame() {
        let mut buf = header().to_vec();
        buf.extend(encode_frame(&[1, 2, 3]).unwrap());
        let whole = buf.len();

        // Every proper prefix of a following frame - torn mid-length, torn mid-body, a length
        // promising more than exists - truncates back to the same boundary.
        let next = encode_frame(&[9; 100]).unwrap();
        for cut in 0..next.len() {
            let mut torn = buf.clone();
            torn.extend(&next[..cut]);
            assert_eq!(valid_prefix_len(&torn).unwrap(), whole, "cut at {cut}");
            assert_eq!(decode_frames(&torn).unwrap(), vec![vec![1, 2, 3]]);
        }
    }

    #[test]
    fn short_or_empty_file_is_an_empty_journal() {
        assert_eq!(valid_prefix_len(&[]).unwrap(), 0);
        assert_eq!(valid_prefix_len(&header()[..5]).unwrap(), 0);
        assert!(decode_frames(&[]).unwrap().is_empty());
        assert!(decode_frames(&header()).unwrap().is_empty());
    }

    #[test]
    fn foreign_header_is_refused_not_truncated() {
        assert!(valid_prefix_len(b"NOTJRNL!").is_err());
        let mut wrong_version = header();
        wrong_version[6] = 9;
        assert!(valid_prefix_len(&wrong_version).is_err());
    }

    // -----------------------------------------------------------------------------------------
    // The filesystem layer: two blunt tests against real files.

    fn temp_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "ringtome-journal-test-{}-{}",
            std::process::id(),
            nanos
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn torn_tail_truncated_on_reopen_and_appends_resume() {
        let dir = temp_dir();
        let path = dir.join("cafef00d.jnl");
        {
            let journal = Journal::open(&path).unwrap();
            journal.append(b"first").unwrap();
            journal.append(b"second").unwrap();
        }
        // A crash mid-append: a length prefix promising more bytes than were written.
        let whole = std::fs::metadata(&path).unwrap().len();
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(&[50, 0, 0, 0, 1, 2, 3]).unwrap();
        drop(file);

        let journal = Journal::open(&path).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            whole,
            "reopen truncated the torn tail"
        );
        journal.append(b"third").unwrap();
        assert_eq!(
            read_journal(&path).unwrap(),
            [b"first".to_vec(), b"second".to_vec(), b"third".to_vec()],
            "appends after the cut round-trip"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn rebuild_a_fresh_database_from_the_journal_alone() {
        let dir = temp_dir();
        let path = dir.join("cafef00d.jnl");
        let journal = Journal::open(&path).unwrap();
        let db = crate::db::test_user_db_with_journal(journal).await;

        // Write through the normal store path; the journal rides along write-ahead.
        let key = SigningKey::from_bytes(&[7u8; 32]);
        imaol::set_profile_field(&db, &key, "name", "Hats Ahoy")
            .await
            .unwrap();
        imaol::set_profile_field(&db, &key, "bio", "purveyor of hats")
            .await
            .unwrap();
        imaol::append(
            &db,
            &key,
            service::POSTS,
            entry_type::POST,
            Payload::Inline(vec![0xa0, 1]),
        )
        .await
        .unwrap();

        // A brand-new database, fed nothing but the journal file.
        let root = key.verifying_key().to_bytes();
        let fresh = crate::db::test_user_db().await;
        let (accepted, rejected) = rebuild_from_journal(&fresh, root, &path).await.unwrap();
        assert_eq!((accepted, rejected), (3, 0));

        // The entries tables match: same count, same per-chain heads.
        let (before, _) = imaol::list_entries(&db, imaol::ENTRIES_PAGE_MAX, None).await.unwrap();
        let (after, _) = imaol::list_entries(&fresh, imaol::ENTRIES_PAGE_MAX, None).await.unwrap();
        assert_eq!(before.len(), after.len());
        let author_hex = hex::encode(root);
        let mut heads_before = imaol::chain_heads_for_author(&db, &author_hex)
            .await
            .unwrap();
        let mut heads_after = imaol::chain_heads_for_author(&fresh, &author_hex)
            .await
            .unwrap();
        heads_before.sort();
        heads_after.sort();
        assert_eq!(heads_before, heads_after);

        // And the gate folded the views on the way in, same as live sync.
        let profile = imaol::get_profile(&fresh).await.unwrap();
        assert_eq!(profile.len(), 2);
        assert_eq!(profile[1].value, "Hats Ahoy");

        std::fs::remove_dir_all(&dir).ok();
    }
}
