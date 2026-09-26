//! Backups: the node packs itself into one recoverable archive while it keeps running (Curtis,
//! 2026-09-25) - `backup_<UTC time>.tar.gz` in `RINGTOME_BACKUP_DIRECTORY` - the precondition for a
//! supervisor that backs up before every upgrade (NEXT_STEPS, *Server nodes*).
//!
//! **Why no shutdown is needed.** The node is already built to survive a crash: the journal is
//! written before its database row (journal ⊇ database, `record::journal`), views and memos
//! rebuild from the chains, and a journal cut off mid-frame is trimmed back on open. So a backup
//! that looks like "the instant the power failed" is a valid backup - the one thing to avoid is a
//! file copied WHILE it is being written, a page half old and half new. Hence:
//!
//! 1. **Databases first**, each under its own statement lock with its log folded in
//!    (`Db::copy_quiesced`): one database held still for its own copy - milliseconds for a small
//!    one - never the node at once.
//! 2. **Journals and head checkpoints after**, live: they are append-only and their torn tail is
//!    trimmed by design - and copied AFTER the databases, a journal can only hold more than its
//!    database did, which is the invariant the restored node needs.
//! 3. **Everything else** - keys, the envelope key, the node's small files - live: written once.
//! 4. **The blob store last**: its content files are immutable and copied live; its metadata
//!    database is the one fragile part, copied behind the store's write gate (`FileStore::quiet`) -
//!    in-flight writes finish, new ones wait a moment, the reaper skips its round, reads carry on.
//!
//! Then the copy is packed, written as `.partial`, and renamed: an archive under its final name is
//! always a whole one. One backup runs at a time; each is a **ticket** whose log grows as it goes
//! (`GET /api/admin/backup/{ticket}`), since a large node can outlast any HTTP timeout.
//!
//! **Who may ask.** A direct loopback request (`RequestContext::is_direct_loopback` - the machine
//! itself, no proxy header) or a `node_admin` session. The loopback test has a known gap - a proxy
//! on the same host that adds no forwarding header looks like the machine itself - and it is
//! tolerable here only because nothing leaves by this door: the endpoint writes the archive to
//! disk and reports its path, never its bytes. A fooled check can start a backup; it cannot read
//! one.
//!
//! **Reading one back** (the Server app's Backups page, 2026-09-25) is a different door with a
//! stricter lock: listing, downloading and revealing archives take a `node_admin` SESSION and
//! nothing else - loopback alone never qualifies, because these doors do hand the archive over. A
//! download names an archive by its exact `backup_<UTC>.tar.gz` name, never a path. On a desktop
//! app the archives are already on the person's own disk, so the page shows them in the file
//! manager instead (shell.rs, `Reveal`).
//!
//! **What the archive holds is the node** - the databases AND the keys that decrypt them
//! (`envelope.key` included, unless the operator keeps it in `RINGTOME_ENVELOPE_KEY`, which the
//! log then says). Anyone with the archive has the node. Restoring is unpacking it into an empty
//! data directory; the node climbs its migrations and carries on.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Context, Result};
use axum::extract::{Path as UrlPath, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;

use crate::auth::{NodeAdminSession, Session};
use crate::error::AppError;
use crate::request_context::RequestContext;
use crate::AppState;

/// How many finished tickets are remembered, for a caller that polls a little late.
const KEPT_TICKETS: usize = 8;

/// One backup's progress, as its ticket reports it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Ticket {
    pub id: String,
    /// "running", "done", or "failed".
    pub status: &'static str,
    pub log: Vec<String>,
    /// The archive, once done.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
}

/// The node's backup tickets: the one running, and the last few finished.
#[derive(Clone, Default)]
pub struct Backups(Arc<Mutex<Vec<Ticket>>>);

impl Backups {
    fn running(&self) -> Option<Ticket> {
        self.0.lock().expect("backups poisoned").iter().find(|t| t.status == "running").cloned()
    }

    fn get(&self, id: &str) -> Option<Ticket> {
        self.0.lock().expect("backups poisoned").iter().find(|t| t.id == id).cloned()
    }

    fn open(&self, id: &str) -> Ticket {
        let ticket = Ticket { id: id.to_string(), status: "running", log: Vec::new(), path: None, bytes: None };
        let mut all = self.0.lock().expect("backups poisoned");
        all.push(ticket.clone());
        while all.len() > KEPT_TICKETS {
            if let Some(at) = all.iter().position(|t| t.status != "running") {
                all.remove(at);
            } else {
                break;
            }
        }
        ticket
    }

    fn say(&self, id: &str, line: impl Into<String>) {
        let line = line.into();
        tracing::info!(backup = %id, "{line}");
        if let Some(t) = self.0.lock().expect("backups poisoned").iter_mut().find(|t| t.id == id) {
            t.log.push(line);
        }
    }

    fn finish(&self, id: &str, outcome: Result<(PathBuf, u64)>) {
        let mut all = self.0.lock().expect("backups poisoned");
        let Some(t) = all.iter_mut().find(|t| t.id == id) else { return };
        match outcome {
            Ok((path, bytes)) => {
                t.status = "done";
                t.log.push(format!("done: {} ({bytes} bytes)", path.display()));
                t.path = Some(path.display().to_string());
                t.bytes = Some(bytes);
            }
            Err(e) => {
                t.status = "failed";
                t.log.push(format!("failed: {e:#}"));
                tracing::error!(backup = %id, error = %e, "backup failed");
            }
        }
    }
}

/// Start a backup, or hand back the one already running.
pub fn start(state: &AppState) -> Ticket {
    if let Some(running) = state.backups.running() {
        return running;
    }
    let id = utc_stamp(crate::clock::now_ms());
    let ticket = state.backups.open(&id);
    let task_state = state.clone();
    tokio::spawn(async move {
        let outcome = run(&task_state, &id).await;
        task_state.backups.finish(&id, outcome);
    });
    ticket
}

/// The backup itself, in the order the module doc argues for.
async fn run(state: &AppState, id: &str) -> Result<(PathBuf, u64)> {
    let say = |line: String| state.backups.say(id, line);
    let data = state.config.data_directory.clone();
    let out_dir = state.config.backup_directory.clone();
    tokio::fs::create_dir_all(&out_dir)
        .await
        .with_context(|| format!("creating the backup directory {}", out_dir.display()))?;
    let staging = out_dir.join(format!(".staging-{id}"));
    if staging.exists() {
        tokio::fs::remove_dir_all(&staging).await.ok();
    }
    tokio::fs::create_dir_all(&staging).await.context("creating the staging directory")?;
    say(format!("backing up {} into {}", data.display(), out_dir.display()));

    let result = async {
        // 1. Databases, each under its own lock.
        let node_db_files = vec![data.join("node.db"), data.join("node.db-wal")];
        let bytes = state.node_db.copy_quiesced(&pairs(&data, &staging, &node_db_files)?).await?;
        say(format!("node.db: {bytes} bytes"));
        let roots = state.user_dbs.held_roots().context("listing personas")?;
        let mut user_bytes = 0u64;
        for root in &roots {
            let db = state.user_dbs.held(root).await.with_context(|| format!("opening {root}"))?;
            user_bytes += db.copy_quiesced(&pairs(&data, &staging, &state.user_dbs.files_of(root))?).await?;
        }
        say(format!("{} persona databases: {user_bytes} bytes", roots.len()));

        // 2. Journals and head checkpoints, after the databases (journal ⊇ database).
        let journals = data.join("journals");
        let n = copy_tree(&journals, &staging.join("journals"), &[]).await?;
        say(format!("journals: {n} files"));

        // 3. Everything else but what has its own step, and the backups themselves.
        let blobs = data.join("blobs");
        let skip = [out_dir.clone(), staging.clone(), journals.clone(), blobs.clone(), data.join("users")];
        let n = copy_tree(&data, &staging, &skip).await?;
        say(format!("keys and the node's other files: {n} files"));
        if std::env::var("RINGTOME_ENVELOPE_KEY").is_ok() {
            say("note: the envelope key comes from RINGTOME_ENVELOPE_KEY, not a file - restoring this archive needs that variable too".to_string());
        }

        // 4. The blob store: content live, its metadata behind the write gate.
        if blobs.exists() {
            let meta = blobs.join("blobs.db");
            let n = copy_tree(&blobs, &staging.join("blobs"), std::slice::from_ref(&meta)).await?;
            let quiet = state.files.quiet().await;
            if meta.exists() {
                tokio::fs::copy(&meta, staging.join("blobs").join("blobs.db"))
                    .await
                    .context("copying the blob store's metadata")?;
            }
            drop(quiet);
            say(format!("blob store: {n} content files, and its metadata"));
        }

        // Pack, as .partial, then rename: an archive under its final name is always whole.
        let final_path = out_dir.join(format!("backup_{id}.tar.gz"));
        let partial = out_dir.join(format!("backup_{id}.tar.gz.partial"));
        let (stage, part) = (staging.clone(), partial.clone());
        tokio::task::spawn_blocking(move || pack(&stage, &part))
            .await
            .map_err(|e| anyhow!("packing died: {e}"))??;
        tokio::fs::rename(&partial, &final_path).await.context("naming the finished archive")?;
        let bytes = tokio::fs::metadata(&final_path).await?.len();
        Ok((final_path, bytes))
    }
    .await;
    tokio::fs::remove_dir_all(&staging).await.ok();
    result
}

/// `(data file, staged copy)` for files under the data directory.
fn pairs(data: &Path, staging: &Path, files: &[PathBuf]) -> Result<Vec<(PathBuf, PathBuf)>> {
    files
        .iter()
        .map(|f| {
            let rel = f.strip_prefix(data).with_context(|| format!("{} is outside the data directory", f.display()))?;
            Ok((f.clone(), staging.join(rel)))
        })
        .collect()
}

/// Copy a directory tree, leaving out `skip` (and whatever lies under it). Returns files copied.
/// A file that vanishes mid-walk (a temp file finishing) is not an error.
async fn copy_tree(from: &Path, to: &Path, skip: &[PathBuf]) -> Result<u64> {
    let (from, to, skip) = (from.to_path_buf(), to.to_path_buf(), skip.to_vec());
    tokio::task::spawn_blocking(move || -> Result<u64> {
        let mut copied = 0u64;
        let mut stack = vec![from.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                if skip.iter().any(|s| path.starts_with(s)) {
                    continue;
                }
                // The main databases have their own locked step.
                if dir == from && is_database_file(&path) {
                    continue;
                }
                let rel = path.strip_prefix(&from).expect("walked from the root");
                let target = to.join(rel);
                let Ok(kind) = entry.file_type() else { continue };
                if kind.is_dir() {
                    std::fs::create_dir_all(&target)?;
                    stack.push(path);
                } else if kind.is_file() {
                    if let Some(parent) = target.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    match std::fs::copy(&path, &target) {
                        Ok(_) => copied += 1,
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        Err(e) => return Err(e).with_context(|| format!("copying {}", path.display())),
                    }
                }
            }
        }
        Ok(copied)
    })
    .await
    .map_err(|e| anyhow!("copying died: {e}"))?
}

/// `node.db` and its log, at the top of the data directory - copied under their own lock.
fn is_database_file(path: &Path) -> bool {
    matches!(path.file_name().and_then(|n| n.to_str()), Some("node.db") | Some("node.db-wal"))
}

/// Pack the staged tree as a gzipped tarball.
fn pack(staging: &Path, out: &Path) -> Result<()> {
    let file = std::fs::File::create(out).with_context(|| format!("creating {}", out.display()))?;
    let gz = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut tar = tar::Builder::new(gz);
    tar.append_dir_all(".", staging).context("packing the backup")?;
    let gz = tar.into_inner().context("finishing the archive")?;
    gz.finish().context("finishing the compression")?.sync_all().context("flushing the archive")?;
    Ok(())
}

/// `20260925T183012Z` - a UTC stamp that sorts as it reads, from epoch milliseconds (civil-from-days,
/// Howard Hinnant's algorithm; no date crate for one name).
fn utc_stamp(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    format!("{year:04}{month:02}{day:02}T{:02}{:02}{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

// ---------------------------------------------------------------------------------------------
// The door.

/// The machine itself, or a node administrator - see the module doc for the loopback caveat.
async fn allowed(state: &AppState, ctx: &RequestContext, session: Option<&Session>) -> Result<(), AppError> {
    if ctx.is_direct_loopback() {
        return Ok(());
    }
    if let Some(s) = session {
        if crate::auth::has_tag(&state.node_db, &s.account.id, crate::auth::TAG_NODE_ADMIN).await? {
            return Ok(());
        }
    }
    Err(AppError::Forbidden(crate::msg!(
        "backup.only-the-machine-or-an-admin",
        "backups are for this machine itself or a node administrator"
    )))
}

/// POST `/api/admin/backup` - start a backup (or return the one running): its ticket, 202.
pub async fn start_handler(
    State(state): State<AppState>,
    ctx: RequestContext,
    session: Option<Session>,
) -> Result<impl IntoResponse, AppError> {
    allowed(&state, &ctx, session.as_ref()).await?;
    Ok((StatusCode::ACCEPTED, Json(start(&state))))
}

/// GET `/api/admin/backup/{ticket}` - 202 with the log while it runs, 200 when the archive is
/// whole, 500 (with the log) if it failed.
pub async fn ticket_handler(
    State(state): State<AppState>,
    ctx: RequestContext,
    session: Option<Session>,
    UrlPath(id): UrlPath<String>,
) -> Result<impl IntoResponse, AppError> {
    allowed(&state, &ctx, session.as_ref()).await?;
    let Some(ticket) = state.backups.get(&id) else {
        return Err(AppError::NotFound(crate::msg!("backup.no-such-backup", "no such backup")));
    };
    let status = match ticket.status {
        "done" => StatusCode::OK,
        "failed" => StatusCode::INTERNAL_SERVER_ERROR,
        _ => StatusCode::ACCEPTED,
    };
    Ok((status, Json(ticket)))
}

// ---------------------------------------------------------------------------------------------
// Reading them back: the Backups page.

/// Is `name` exactly an archive this module writes - `backup_YYYYMMDDTHHMMSSZ.tar.gz`? The only
/// shape the download and reveal doors accept, so no request can name anything else on the disk.
pub fn is_archive_name(name: &str) -> bool {
    let Some(stamp) = name.strip_prefix("backup_").and_then(|n| n.strip_suffix(".tar.gz")) else {
        return false;
    };
    let b = stamp.as_bytes();
    b.len() == 16
        && b[..8].iter().all(u8::is_ascii_digit)
        && b[8] == b'T'
        && b[9..15].iter().all(u8::is_ascii_digit)
        && b[15] == b'Z'
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Archive {
    pub name: String,
    pub bytes: u64,
}

/// The finished archives in the backup directory, newest first (the names sort as they read).
pub fn archives(state: &AppState) -> Result<Vec<Archive>> {
    let dir = &state.config.backup_directory;
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e).with_context(|| format!("reading {}", dir.display())),
    };
    let mut found: Vec<Archive> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            let meta = e.metadata().ok()?;
            (is_archive_name(&name) && meta.is_file()).then_some(Archive { name, bytes: meta.len() })
        })
        .collect();
    found.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(found)
}

fn archive_path(state: &AppState, name: &str) -> Result<PathBuf, AppError> {
    let path = state.config.backup_directory.join(name);
    if !is_archive_name(name) || !path.is_file() {
        return Err(AppError::NotFound(crate::msg!("backup.no-such-backup", "no such backup")));
    }
    Ok(path)
}

/// GET `/api/admin/backups` - the finished archives, newest first.
pub async fn list_handler(State(state): State<AppState>, _admin: NodeAdminSession) -> Result<Json<Vec<Archive>>, AppError> {
    Ok(Json(archives(&state).map_err(AppError::Internal)?))
}

/// GET `/api/admin/backups/{name}` - one archive's bytes, as a download.
pub async fn download_handler(
    State(state): State<AppState>,
    _admin: NodeAdminSession,
    UrlPath(name): UrlPath<String>,
) -> Result<impl IntoResponse, AppError> {
    let path = archive_path(&state, &name)?;
    let file = tokio::fs::File::open(&path)
        .await
        .with_context(|| format!("opening {}", path.display()))
        .map_err(AppError::Internal)?;
    let bytes = file.metadata().await.map(|m| m.len()).unwrap_or(0);
    let body = axum::body::Body::from_stream(tokio_util::io::ReaderStream::new(file));
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, "application/gzip".to_string()),
            (axum::http::header::CONTENT_LENGTH, bytes.to_string()),
            // The name is one `is_archive_name` accepted: nothing in it needs quoting.
            (axum::http::header::CONTENT_DISPOSITION, format!("attachment; filename=\"{name}\"")),
        ],
        body,
    ))
}

/// POST `/api/admin/backups/{name}/reveal` - a desktop app shows the archive in the file manager.
pub async fn reveal_handler(
    State(state): State<AppState>,
    _admin: NodeAdminSession,
    UrlPath(name): UrlPath<String>,
) -> Result<StatusCode, AppError> {
    let path = archive_path(&state, &name)?;
    if !crate::registration::is_device(&state) || !state.shell.ask(crate::shell::ShellRequest::Reveal { path }) {
        return Err(AppError::NotFound(crate::msg!(
            "backup.only-the-desktop-app-shows-files",
            "only the desktop app can show a file on this computer"
        )));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_archive_name_names_an_archive() {
        assert!(is_archive_name("backup_20260925T183012Z.tar.gz"));
        for not in [
            "backup_20260925T183012Z.tar.gz.partial",
            "../backup_20260925T183012Z.tar.gz",
            "backup_2026092XT183012Z.tar.gz",
            "backup_20260925T183012.tar.gz",
            "backup_.tar.gz",
            "envelope.key",
            "",
        ] {
            assert!(!is_archive_name(not), "{not:?}");
        }
    }

    #[test]
    fn a_stamp_reads_as_utc_and_sorts() {
        assert_eq!(utc_stamp(0), "19700101T000000Z");
        // A real one: a rig log line stamped 2026-09-23T15:47:58.230Z carried @1790178478228.
        assert_eq!(utc_stamp(1_790_178_478_228), "20260923T154758Z");
        assert_eq!(utc_stamp(951_782_400_000), "20000229T000000Z", "a leap day");
        assert!(utc_stamp(1_790_178_478_228) < utc_stamp(1_790_178_479_228));
    }

    #[test]
    fn only_the_top_level_databases_are_skipped_by_the_walk() {
        assert!(is_database_file(Path::new("/d/node.db")));
        assert!(is_database_file(Path::new("/d/node.db-wal")));
        assert!(!is_database_file(Path::new("/d/envelope.key")));
    }

}
