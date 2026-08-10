//! The ephemeral-chain head checkpoint: eighty bytes of insurance per inbox chain.
//!
//! The journal's charter is "the database is derived state" - every entry framed and fsynced
//! so a catastrophic database failure costs a replay, never data. Inbox chains opt out of
//! that (their cargo is *meant* to be forgettable, and journaling a flood's notices forever
//! was the one unbounded artifact a stranger could still grow) - but one fact about them must
//! survive a database loss anyway: **the head position of each chain this node's own leaf
//! writes**. A device that forgets where its chain ended mints a fresh genesis at seq 0, and
//! its own siblings - still holding the old entry 0 - now possess two signed entries at one
//! position: self-proving equivocation, the fork that condemns a key. A routine rebuild must
//! not excommunicate a healthy device.
//!
//! So: a flat file beside the journal, same trust class (no database anywhere in the loop -
//! the journal exists because the database engine is the component under suspicion, and a
//! recovery path that leans on the suspect is not a recovery path). JSON, human-readable with
//! zero key material, rewritten whole by write-temp-fsync-rename on every checkpoint. It holds
//! one `(seq, hash)` per (author, service) and nothing else, so its size is the number of
//! inbox chains this node writes - two per hosted persona - forever.
//!
//! ## The write-ahead order, and why its one failure mode is safe
//!
//! The checkpoint is written BEFORE the entry's database insert, mirroring the journal's
//! order, and the asymmetry is the whole design:
//!
//! - **Under-recording is fatal.** A checkpoint behind the real chain would let a rebuilt
//!   device re-sign a seq its siblings already hold - equivocation. Hence write-ahead, and
//!   hence `record` is monotone (a replayed or reordered call can never move a head down).
//! - **Over-recording is harmless, on these services specifically.** Crash between the
//!   checkpoint and the insert, and the file claims a head one past what exists anywhere; a
//!   rebuilt device continues from the phantom position, producing a chain with a gap below
//!   it - which on the inbox services is indistinguishable from pruning, and suffix admission
//!   (net::sync::service_allows_suffix) adopts it like any honestly-pruned chain. The failure
//!   the ordering permits is the one the gate already forgives.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};

/// One recorded head: where a chain ended, as of the last checkpoint.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct Head {
    seq: u64,
    /// The entry's hash at that seq, hex - the prev_hash a continuation links with.
    hash: String,
}

/// The file: `{ "v": 1, "chains": { "<author_hex>/<service>": { seq, hash } } }`.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct FileBody {
    v: u16,
    chains: BTreeMap<String, Head>,
}

/// The checkpoint, shared across every clone of a Db handle (the journal's Arc-Mutex shape;
/// the mutex is never held across an await - all the file work is synchronous and local).
#[derive(Clone)]
pub struct EphemeralHeads {
    inner: Arc<Mutex<HeadsInner>>,
}

struct HeadsInner {
    path: PathBuf,
    chains: BTreeMap<String, Head>,
}

fn key_of(author_hex: &str, service: u32) -> String {
    format!("{author_hex}/{service}")
}

impl EphemeralHeads {
    /// Open (or start empty) the checkpoint at `path`. A missing file is a persona that never
    /// transcribed a notice; an unreadable one is treated the same, LOUDLY - the recovery
    /// consequence of a lost checkpoint is a re-genesis whose only witnesses are siblings,
    /// which is the accepted floor for full-catastrophe, but it should never pass silently.
    pub fn open(path: &Path) -> Result<EphemeralHeads> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        let chains = match std::fs::read(path) {
            Ok(bytes) => match serde_json::from_slice::<FileBody>(&bytes) {
                Ok(body) => body.chains,
                Err(e) => {
                    tracing::error!(
                        path = %path.display(),
                        error = ?e,
                        "ephemeral-heads checkpoint is unreadable; a rebuild of this persona \
                         will re-genesis its inbox chains"
                    );
                    BTreeMap::new()
                }
            },
            Err(_) => BTreeMap::new(), // absent: nothing ever checkpointed
        };
        Ok(EphemeralHeads {
            inner: Arc::new(Mutex::new(HeadsInner {
                path: path.to_path_buf(),
                chains,
            })),
        })
    }

    /// Record a head, monotone: a call that would move a chain's head DOWN is ignored, so a
    /// duplicate, reordered, or replayed checkpoint can never re-arm the under-recording
    /// failure. Fsynced and renamed into place before returning - this is the write-ahead
    /// half, and the caller inserts the entry only after it succeeds.
    pub fn record(&self, author_hex: &str, service: u32, seq: u64, hash: &[u8; 32]) -> Result<()> {
        let mut inner = self.inner.lock().unwrap();
        let key = key_of(author_hex, service);
        if inner.chains.get(&key).is_some_and(|held| held.seq >= seq) {
            return Ok(());
        }
        inner.chains.insert(
            key,
            Head {
                seq,
                hash: hex::encode(hash),
            },
        );
        let body = serde_json::to_vec_pretty(&FileBody {
            v: 1,
            chains: inner.chains.clone(),
        })
        .context("encoding the heads checkpoint")?;
        let tmp = inner.path.with_extension("heads.tmp");
        {
            let mut file = std::fs::File::create(&tmp)
                .with_context(|| format!("creating {}", tmp.display()))?;
            file.write_all(&body).context("writing the heads checkpoint")?;
            file.sync_all().context("fsyncing the heads checkpoint")?;
        }
        std::fs::rename(&tmp, &inner.path)
            .with_context(|| format!("installing {}", inner.path.display()))?;
        Ok(())
    }

    /// The recorded head for one chain, if any - what `imaol::append` continues from when the
    /// database has forgotten a chain the checkpoint remembers.
    pub fn head_of(&self, author_hex: &str, service: u32) -> Option<(u64, [u8; 32])> {
        let inner = self.inner.lock().unwrap();
        let held = inner.chains.get(&key_of(author_hex, service))?;
        let mut hash = [0u8; 32];
        hex::decode_to_slice(&held.hash, &mut hash).ok()?;
        Some((held.seq, hash))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ringtome-heads-test-{name}-{}", std::process::id()))
    }

    #[test]
    fn round_trips_and_survives_reopen() {
        let path = temp_path("roundtrip");
        let _ = std::fs::remove_file(&path);
        let heads = EphemeralHeads::open(&path).unwrap();
        assert_eq!(heads.head_of("aa", 9), None, "absent file, no heads");

        heads.record("aa", 9, 5, &[7u8; 32]).unwrap();
        assert_eq!(heads.head_of("aa", 9), Some((5, [7u8; 32])));

        // A fresh open reads what the rename installed - the catastrophe path.
        let reopened = EphemeralHeads::open(&path).unwrap();
        assert_eq!(reopened.head_of("aa", 9), Some((5, [7u8; 32])));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn heads_are_monotone() {
        let path = temp_path("monotone");
        let _ = std::fs::remove_file(&path);
        let heads = EphemeralHeads::open(&path).unwrap();
        heads.record("aa", 9, 5, &[7u8; 32]).unwrap();
        heads.record("aa", 9, 3, &[9u8; 32]).unwrap(); // a stale replay
        assert_eq!(
            heads.head_of("aa", 9),
            Some((5, [7u8; 32])),
            "a checkpoint can advance a head, never retreat it"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn chains_are_independent() {
        let path = temp_path("independent");
        let _ = std::fs::remove_file(&path);
        let heads = EphemeralHeads::open(&path).unwrap();
        heads.record("aa", 8, 2, &[1u8; 32]).unwrap();
        heads.record("aa", 9, 7, &[2u8; 32]).unwrap();
        heads.record("bb", 9, 1, &[3u8; 32]).unwrap();
        assert_eq!(heads.head_of("aa", 8), Some((2, [1u8; 32])));
        assert_eq!(heads.head_of("aa", 9), Some((7, [2u8; 32])));
        assert_eq!(heads.head_of("bb", 9), Some((1, [3u8; 32])));
        let _ = std::fs::remove_file(&path);
    }
}
