//! Imports (plans/EXPORT.md, Import): a zip of a persona - one this node exported, or one a person
//! put together by hand - read back into a persona, **additively** (Curtis, 2026-10-09: "if I edit
//! a document and re-import it, nothing should happen, it only adds New documents, New
//! annotations, et-al"). A document whose id the persona holds is skipped, and the import's report
//! says so - "Document <title> skipped: It already exists!" - so importing the same zip twice adds
//! nothing the second time, and nothing a person has is ever overwritten, merged or deleted.
//!
//! This half reads the zip: unpacking it safely, finding each document among its files - a note's
//! renderings (`.mq`, `.yml.md`, `.md`; `.yml.txt`, `.txt`) are one document, read from the
//! richest - and its details, from a `:::meta` directive or YAML front matter.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, Result};

use crate::record::documents::Format;

/// The most an import will unpack, all files together, and how many files: a zip's sizes are
/// claims, and a small zip can claim to be enormous (a zip bomb). The byte limit is the node's
/// upload cap times [`UNPACK_RATIO`], between these two - a server's 128 MiB cap unpacks to at most
/// 1 GiB, a desktop app's 1 GiB to 4 GiB.
pub const MIN_UNPACKED_BYTES: u64 = 1024 * 1024 * 1024;
pub const MAX_UNPACKED_BYTES: u64 = 16 * 1024 * 1024 * 1024;
pub const UNPACK_RATIO: u64 = 4;
pub const MAX_FILES: usize = 250_000;
/// The free disk an unpacking import always leaves: past this it stops, before the databases
/// beside it run out of room.
pub const MIN_FREE_BYTES: u64 = 1024 * 1024 * 1024;
/// A notebook section path deeper than this folds into its deepest allowed section: a folder 2,000
/// levels deep is no notebook anyone keeps, and every level would be a taxonomy to walk.
pub const MAX_SECTION_DEPTH: usize = 16;
/// The most a details file - the manifest, the profile, contacts, lists, a picture's details - may
/// be. Each is a page of text at most.
pub const MAX_DETAILS_BYTES: u64 = 8 * 1024 * 1024;

/// The unpacking limit for a node whose upload cap is `cap`.
pub fn unpack_limit(cap: u64) -> u64 {
    cap.saturating_mul(UNPACK_RATIO).clamp(MIN_UNPACKED_BYTES, MAX_UNPACKED_BYTES)
}

/// Unpack `zip` into `into`, every name checked to stay inside it (no `..`, no absolute paths) and
/// the whole held to `limit` - counted as written, not as the zip claims - and to the disk's own
/// room ([`MIN_FREE_BYTES`]). Returns each file's path inside the zip, `/`-separated, in the zip's
/// order.
pub fn unpack(zip: &Path, into: &Path, limit: u64) -> Result<Vec<String>> {
    let file = std::fs::File::open(zip).with_context(|| format!("opening {}", zip.display()))?;
    let mut archive =
        zip::ZipArchive::new(std::io::BufReader::new(file)).context("this isn't a zip file")?;
    if archive.len() > MAX_FILES {
        anyhow::bail!("this zip holds more than {MAX_FILES} files");
    }
    let mut names = Vec::new();
    let mut written: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).context("reading the zip")?;
        if entry.is_dir() {
            continue;
        }
        let Some(rel) = entry.enclosed_name() else { continue };
        let name = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        let target = into.join(&rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).context("making a folder to unpack into")?;
        }
        let out = std::fs::File::create(&target).context("unpacking a file")?;
        let left = limit.saturating_sub(written);
        let copied =
            std::io::copy(&mut (&mut entry).take(left + 1), &mut std::io::BufWriter::new(out))
                .context("unpacking a file")?;
        written += copied;
        if written > limit {
            anyhow::bail!(
                "this zip unpacks to more than {} MB, more than this server takes",
                limit >> 20
            );
        }
        if fs4::available_space(into).is_ok_and(|free| free < MIN_FREE_BYTES) {
            anyhow::bail!("this computer's disk is nearly full - the import stopped before it was");
        }
        names.push(name);
    }
    Ok(names)
}

use std::io::Read as _;

// ---------------------------------------------------------------------------------------------
// Finding the documents

/// What a document is, by the files that carry it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Marquee,
    Plaintext,
    Drawing,
    Media(Format),
}

/// A document's file endings, richest first: the one an import reads. A Marquee note's `.mq` keeps
/// its details and its markup; its `.yml.md` keeps the details; its `.md` is words alone.
const ENDINGS: &[(&str, Kind)] = &[
    (".mq", Kind::Marquee),
    (".yml.md", Kind::Marquee),
    (".md", Kind::Marquee),
    (".yml.txt", Kind::Plaintext),
    (".txt", Kind::Plaintext),
    (".horsedrawing", Kind::Drawing),
    (".avif", Kind::Media(Format::Avif)),
    (".png", Kind::Media(Format::Apng)),
    (".webm", Kind::Media(Format::WebmAv1)),
    (".opus", Kind::Media(Format::OggOpus)),
];

/// One document's files: everything in one folder that shares a stem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Group {
    /// The folder, `/`-separated, inside the zip.
    pub dir: String,
    /// The file name without its ending: `<title>--<id8>` for one this node exported.
    pub stem: String,
    pub kind: Kind,
    /// The file to read the document from, its richest rendering.
    pub file: String,
    /// A media file's details beside it (`<name>.<ext>.yml`), when there.
    pub sidecar: Option<String>,
}

/// Split a path into (folder, stem, ending) for a file that can be a document.
fn classify(path: &str) -> Option<(String, String, &'static str, Kind)> {
    let (dir, name) = path.rsplit_once('/').unwrap_or(("", path));
    let lower = name.to_lowercase();
    ENDINGS.iter().find_map(|(ending, kind)| {
        let stem = lower.strip_suffix(ending).map(|s| &name[..s.len()])?;
        (!stem.is_empty()).then(|| (dir.to_string(), stem.to_string(), *ending, *kind))
    })
}

/// The documents among a zip's files: grouped by folder and stem, each read from its richest
/// rendering. Files that are no document's - the profile, the ledger, the manifest - are not here.
pub fn groups(paths: &[String]) -> Vec<Group> {
    let mut found: BTreeMap<(String, String, u8), (usize, Group)> = BTreeMap::new();
    let lower: std::collections::HashSet<String> = paths.iter().map(|p| p.to_lowercase()).collect();
    for path in paths {
        let lowered = path.to_lowercase();
        // The export's own files are no documents: details beside media, chat transcripts, and
        // the README at its top (or under the one folder a person may have zipped it in).
        let outside = !lowered.split('/').any(|p| p == "public" || p == "private");
        // A drawing's picture beside it (export.rs) is the drawing, painted - no document of its own.
        if lowered.ends_with(".horsedrawing.png")
            || lowered.ends_with(".yml")
            || lowered.split('/').any(|p| p == "chat")
            || (outside && lowered.rsplit('/').next() == Some("readme.txt"))
        {
            continue;
        }
        let Some((dir, stem, ending, kind)) = classify(path) else { continue };
        let rank = ENDINGS.iter().position(|(e, _)| *e == ending).unwrap_or(usize::MAX);
        // Media and text never share a document, even with one stem: a picture called `horse`
        // beside a note called `horse` are two things.
        let family = match kind {
            Kind::Media(_) => 1,
            _ => 0,
        };
        let sidecar = matches!(kind, Kind::Media(_))
            .then(|| format!("{path}.yml"))
            .filter(|s| lower.contains(&s.to_lowercase()));
        let group =
            Group { dir: dir.clone(), stem: stem.clone(), kind, file: path.clone(), sidecar };
        let key = (dir, stem, family);
        match found.get(&key) {
            Some((have, _)) if *have <= rank => {}
            _ => {
                found.insert(key, (rank, group));
            }
        }
    }
    found.into_values().map(|(_, g)| g).collect()
}

/// Where a document's folder puts it: which side, which notebook, which sections. An exported
/// zip's own layout - `private/buckets/<notebook>/<section>/…`, `private/unfiled`,
/// `public/buckets/<notebook>`, `public/unfiled` - and anything else is a private note in no
/// notebook.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Place {
    pub public: bool,
    pub bucket: Option<String>,
    pub sections: Vec<String>,
}

pub fn place(dir: &str) -> Place {
    let parts: Vec<&str> = dir.split('/').filter(|p| !p.is_empty()).collect();
    // A zip a person re-made may wrap the export in a folder of its own: read from the first
    // `public` or `private`.
    let from = parts.iter().position(|p| *p == "public" || *p == "private").unwrap_or(0);
    let parts = &parts[from..];
    let public = parts.first() == Some(&"public");
    match parts {
        [_, "buckets", bucket, sections @ ..] => Place {
            public,
            bucket: Some(bucket.to_string()),
            sections: sections.iter().take(MAX_SECTION_DEPTH).map(|s| s.to_string()).collect(),
        },
        _ => Place { public, bucket: None, sections: Vec::new() },
    }
}

/// The id prefix an exported file name ends with (`<title>--<id8>`), if it has one.
pub fn stem_id_prefix(stem: &str) -> Option<&str> {
    let (_, tail) = stem.rsplit_once("--")?;
    (tail.len() == 8 && tail.bytes().all(|b| b.is_ascii_hexdigit())).then_some(tail)
}

// ---------------------------------------------------------------------------------------------
// Reading a document's details

/// A document's details as its file states them, every value a string or a list of strings.
pub type Details = BTreeMap<String, Detail>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Detail {
    One(String),
    Many(Vec<String>),
}

impl Detail {
    pub fn one(&self) -> String {
        match self {
            Detail::One(v) => v.clone(),
            Detail::Many(vs) => vs.join(", "),
        }
    }

    /// As a list: a list is itself, and a comma-joined string - the `:::meta` way of writing one
    /// (export.rs `meta_directive`) - splits.
    pub fn many(&self) -> Vec<String> {
        match self {
            Detail::Many(vs) => vs.clone(),
            Detail::One(v) => {
                v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
            }
        }
    }
}

/// A Marquee note's details and its words: the `:::meta` directives that lead it (SPEC: multiple
/// are allowed, their keys union, first writer wins), and the source after them.
pub fn read_mq(source: &str) -> (Details, String) {
    let mut details = Details::new();
    let mut rest = source;
    loop {
        let trimmed = rest.trim_start_matches(['\n', '\r']);
        let Some(after) = trimmed.strip_prefix(":::meta") else { break };
        if !after.starts_with([' ', '\t', '\n', ':']) {
            break;
        }
        // The directive's own extent: its line when it closes itself (`:::meta …:::`), or up to
        // the `:::` line that closes it.
        let first_end = trimmed.find('\n').unwrap_or(trimmed.len());
        let first = trimmed[..first_end].trim_end();
        let end = if first.len() > ":::meta".len() && first.ends_with(":::") {
            first_end
        } else {
            match trimmed[first_end..].find("\n:::") {
                Some(at) => {
                    let close = first_end + at + "\n:::".len();
                    trimmed[close..].find('\n').map_or(trimmed.len(), |n| close + n)
                }
                None => break,
            }
        };
        let block = &trimmed[..end];
        if let Ok(marquee_parser::Node::Document { children, .. }) = marquee_parser::parse(block) {
            for child in children {
                if let marquee_parser::Node::Directive { name, attrs, .. } = child {
                    if name == "meta" {
                        for (k, v) in attrs {
                            details.entry(k).or_insert(Detail::One(v));
                        }
                    }
                }
            }
        }
        rest = &trimmed[end..];
    }
    (details, rest.trim_start_matches(['\n', '\r']).to_string())
}

/// YAML front matter's details and the words after it. Read leniently - the export writes every
/// value as a JSON string and every list as a JSON array, and a hand-written header's plain
/// `key: value` and `[a, b]` read too; anything fancier in YAML is taken as its text.
pub fn read_front_matter(text: &str) -> (Details, String) {
    let Some(after) = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n")) else {
        return (Details::new(), text.to_string());
    };
    let Some(end) = after.find("\n---").filter(|&at| {
        let tail = &after[at + 4..];
        tail.is_empty() || tail.starts_with('\n') || tail.starts_with("\r\n")
    }) else {
        return (Details::new(), text.to_string());
    };
    let mut details = Details::new();
    for line in after[..end].lines() {
        let line = line.trim_end();
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let Some((key, value)) = split_key(line) else { continue };
        details.entry(key).or_insert(value);
    }
    let body = &after[end + 4..];
    let body = body.strip_prefix("\r\n").or_else(|| body.strip_prefix('\n')).unwrap_or(body);
    (details, body.to_string())
}

fn split_key(line: &str) -> Option<(String, Detail)> {
    let line = line.trim();
    let (key, rest) = if line.starts_with('"') {
        let mut de = serde_json::Deserializer::from_str(line).into_iter::<String>();
        let key = de.next()?.ok()?;
        let rest = line[de.byte_offset()..].trim_start().strip_prefix(':')?;
        (key, rest)
    } else {
        let (k, r) = line.split_once(':')?;
        (k.trim().to_string(), r)
    };
    let rest = rest.trim();
    if key.is_empty() {
        return None;
    }
    let value = if let Ok(list) = serde_json::from_str::<Vec<String>>(rest) {
        Detail::Many(list)
    } else if let Ok(one) = serde_json::from_str::<String>(rest) {
        Detail::One(one)
    } else if let Some(inner) = rest.strip_prefix('[').and_then(|r| r.strip_suffix(']')) {
        Detail::Many(
            inner
                .split(',')
                .map(|s| s.trim().trim_matches(['"', '\'']).to_string())
                .filter(|s| !s.is_empty())
                .collect(),
        )
    } else {
        Detail::One(rest.trim_matches('\'').to_string())
    };
    Some((key, value))
}

/// A document's words and details, read from its file by its kind.
pub fn read_document(kind: Kind, file: &str, bytes: &[u8]) -> (Details, Vec<u8>) {
    let text = || String::from_utf8_lossy(bytes).into_owned();
    match kind {
        Kind::Marquee if file.to_lowercase().ends_with(".mq") => {
            let (details, body) = read_mq(&text());
            (details, body.into_bytes())
        }
        Kind::Marquee => {
            let (details, body) = read_front_matter(&text());
            // Markdown back into Marquee (the bridge's other half): lossy, as the way out was.
            (details, marquee_markdown::to_marquee(&body).into_bytes())
        }
        Kind::Plaintext | Kind::Drawing => {
            let (details, body) = read_front_matter(&text());
            let body = if kind == Kind::Drawing { body.trim_end().to_string() } else { body };
            (details, body.into_bytes())
        }
        Kind::Media(_) => (Details::new(), bytes.to_vec()),
    }
}

/// A date as written in the details (RFC 3339), in ms.
pub fn parse_date(s: &str) -> Option<i64> {
    let t = time::OffsetDateTime::parse(s.trim(), &time::format_description::well_known::Rfc3339)
        .ok()?;
    i64::try_from(t.unix_timestamp_nanos() / 1_000_000).ok()
}

// ---------------------------------------------------------------------------------------------
// The job

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex};

use axum::extract::{Path as UrlPath, State};
use axum::Json;

use crate::auth::Session;
use crate::error::AppError;
use crate::AppState;

/// The details a file states that are no annotation of the document: its identity and its
/// history, which the import reads for itself - and bookkeeping no import should restore.
const NOT_ANNOTATIONS: &[&str] = &[
    "id",
    "head",
    "title",
    "format",
    "created",
    "updated",
    "tags",
    "buckets",
    "date",
    "trusted_only",
    "reply_to",
    crate::record::store::PUBLISHED_AS,
    crate::record::store::PUBLISHED_FROM,
    crate::record::store::PUBLISHED_HEAD,
    crate::record::store::TRUSTED_KEY,
    crate::record::store::PUBLISH_PLAN,
];

/// How long a republished post may wait on its pictures, which are still being made.
const BAKE_TRIES: usize = 60;

/// One persona's import, as its page follows it: where it stands, and every line it has said.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ImportReport {
    /// Whether this node takes imports at all ([`allowed`]).
    pub allowed: bool,
    /// "none", "queued", "running", "done" or "failed".
    pub status: &'static str,
    pub log: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Each persona's last import, while the node is up. Imports wait on the exports' permit: one heavy
/// job at a time, node-wide (export.rs).
#[derive(Clone, Default)]
pub struct Imports(Arc<Mutex<HashMap<String, ImportReport>>>);

impl Imports {
    fn set_status(&self, root: &str, status: &'static str, error: Option<String>) {
        if let Some(r) = self.0.lock().expect("imports poisoned").get_mut(root) {
            r.status = status;
            r.error = error;
        }
    }

    fn say(&self, root: &str, line: String) {
        tracing::info!(root = %root, "import: {line}");
        if let Some(r) = self.0.lock().expect("imports poisoned").get_mut(root) {
            r.log.push(line);
        }
    }

    pub fn report(&self, root: &str) -> ImportReport {
        self.0.lock().expect("imports poisoned").get(root).cloned().unwrap_or(ImportReport {
            allowed: true,
            status: "none",
            log: Vec::new(),
            error: None,
        })
    }
}

fn imports_dir(state: &AppState) -> std::path::PathBuf {
    state.config.data_directory.join("imports")
}

/// POST `/api/identity/{root}/import` - the zip, as the request's body, streamed to disk (an export
/// is as large as a persona; nothing holds it in memory), then imported in the background. One at
/// a time per persona: a second while the first runs is refused.
pub async fn start_handler(
    session: Session,
    State(state): State<AppState>,
    UrlPath(root): UrlPath<String>,
    body: axum::body::Body,
) -> Result<Json<ImportReport>, AppError> {
    crate::record::store::open(&state, &session.account.id, &root).await?;
    if !allowed(&state).await? {
        return Err(AppError::Forbidden(crate::msg!(
            "import.not-here",
            "this server doesn't take imports - its administrator can allow them"
        )));
    }
    {
        let mut all = state.imports.0.lock().expect("imports poisoned");
        if all.get(&root).is_some_and(|r| r.status == "queued" || r.status == "running") {
            return Err(AppError::BadRequest(crate::msg!(
                "import.one-at-a-time",
                "an import is already under way - wait for it to finish"
            )));
        }
        if all.values().filter(|r| r.status == "queued" || r.status == "running").count()
            >= MAX_WAITING
        {
            return Err(AppError::BadRequest(crate::msg!(
                "import.server-busy",
                "this server is busy with other imports - try again in a little while"
            )));
        }
        all.insert(
            root.clone(),
            ImportReport { allowed: true, status: "queued", log: Vec::new(), error: None },
        );
    }
    let zip = imports_dir(&state).join(format!("{root}.zip"));
    if let Err(e) = receive(&state, body, &zip).await {
        state.imports.set_status(&root, "failed", Some(e.to_string()));
        let _ = tokio::fs::remove_file(&zip).await;
        return Err(e);
    }
    let account = session.account.id.to_string();
    let (state2, root2) = (state.clone(), root.clone());
    tokio::spawn(async move {
        let _permit = match state2.exports.permit.clone().acquire_owned().await {
            Ok(p) => p,
            Err(_) => return,
        };
        state2.imports.set_status(&root2, "running", None);
        let outcome = run(&state2, &root2, &account, &zip).await;
        let _ = tokio::fs::remove_file(&zip).await;
        let _ = tokio::fs::remove_dir_all(imports_dir(&state2).join(&root2)).await;
        match outcome {
            Ok(()) => state2.imports.set_status(&root2, "done", None),
            Err(e) => {
                tracing::warn!(root = %root2, error = ?e, "an import failed");
                state2.imports.set_status(&root2, "failed", Some(format!("{e:#}")));
            }
        }
    });
    Ok(Json(state.imports.report(&root)))
}

/// The request's body onto disk, held to the node's upload cap.
async fn receive(state: &AppState, body: axum::body::Body, to: &Path) -> Result<(), AppError> {
    use n0_future::StreamExt;
    use tokio::io::AsyncReadExt;
    tokio::fs::create_dir_all(imports_dir(state))
        .await
        .context("making the imports directory")
        .map_err(AppError::Internal)?;
    let cap = state.config.max_upload_bytes as u64;
    let stream = body.into_data_stream().map(|r| r.map_err(std::io::Error::other));
    let mut reader = tokio_util::io::StreamReader::new(stream).take(cap + 1);
    let mut file =
        tokio::fs::File::create(to).await.context("saving the zip").map_err(AppError::Internal)?;
    let got = tokio::io::copy(&mut reader, &mut file).await.map_err(|e| {
        AppError::BadRequest(crate::msg!("import.upload-broke", "the upload broke off: {e}", e = e))
    })?;
    if got > cap {
        return Err(AppError::BadRequest(crate::msg!(
            "import.too-large",
            "that zip is larger than this server takes ({mb} MB)",
            mb = cap / (1024 * 1024)
        )));
    }
    if got == 0 {
        return Err(AppError::BadRequest(crate::msg!("import.empty", "that file is empty")));
    }
    Ok(())
}

/// GET `/api/identity/{root}/import` - where the last import stands, and what it said, and whether
/// this node takes imports at all.
pub async fn report_handler(
    session: Session,
    State(state): State<AppState>,
    UrlPath(root): UrlPath<String>,
) -> Result<Json<ImportReport>, AppError> {
    crate::record::store::open(&state, &session.account.id, &root).await?;
    let mut report = state.imports.report(&root);
    report.allowed = allowed(&state).await?;
    Ok(Json(report))
}

/// How many imports a node holds queued or running at once, every persona together: each waits
/// with its whole upload on disk.
const MAX_WAITING: usize = 4;

/// Does this node take imports (Curtis, 2026-10-09)? The administrator's choice when made; else
/// a desktop app does - it is its owner's own computer - and a server doesn't: "the direction we
/// want is for users to export their personas from servers to personal devices and not the
/// other way around".
pub async fn allowed(state: &AppState) -> Result<bool, AppError> {
    let row: Option<(i64,)> = state
        .node_db
        .fetch_optional("SELECT allowed FROM import_policy WHERE id = 1", ())
        .await
        .context("reading the import policy")
        .map_err(AppError::Internal)?;
    Ok(match row {
        Some((allowed,)) => allowed != 0,
        None => crate::registration::is_device(state),
    })
}

#[derive(serde::Deserialize)]
pub struct SetPolicy {
    pub allowed: bool,
}

/// GET `/api/admin/import-policy` - the Server app's Backups page: whether users may import.
pub async fn policy_handler(
    State(state): State<AppState>,
    _admin: crate::auth::NodeAdminSession,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(serde_json::json!({ "allowed": allowed(&state).await? })))
}

/// PUT `/api/admin/import-policy` - allow imports here, or stop allowing them.
pub async fn set_policy_handler(
    State(state): State<AppState>,
    _admin: crate::auth::NodeAdminSession,
    Json(req): Json<SetPolicy>,
) -> Result<Json<serde_json::Value>, AppError> {
    state
        .node_db
        .execute(
            "INSERT INTO import_policy (id, allowed, updated_ms) VALUES (1, ?1, ?2)
             ON CONFLICT (id) DO UPDATE SET allowed = excluded.allowed, updated_ms = excluded.updated_ms",
            (i64::from(req.allowed), crate::clock::now_ms()),
        )
        .await
        .context("writing the import policy")
        .map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!({ "allowed": req.allowed })))
}

/// The import itself. Everything is read from the unpacked zip and written through the agented
/// store, the way background passes write.
async fn run(state: &AppState, root: &str, account: &str, zip: &Path) -> Result<()> {
    let say = |line: String| state.imports.say(root, line);
    let dir = imports_dir(state).join(root);
    let _ = tokio::fs::remove_dir_all(&dir).await;
    let (zip_owned, dir_owned) = (zip.to_path_buf(), dir.clone());
    let limit = unpack_limit(state.config.max_upload_bytes as u64);
    let paths = tokio::task::spawn_blocking(move || unpack(&zip_owned, &dir_owned, limit))
        .await
        .context("the unpacking thread")??;
    let data = crate::record::store::open_agented(state, root)
        .await
        .map_err(|e| anyhow::anyhow!("opening the persona: {e}"))?;
    let mut ctx = Ctx::new(state, root, account, &dir, &paths, data).await?;

    let found = groups(&paths);
    let (posts, notes): (Vec<&Group>, Vec<&Group>) =
        found.iter().partition(|g| place(&g.dir).public);
    say(format!("Found {} documents and {} posts.", notes.len(), posts.len()));
    for group in notes {
        if let Err(e) = ctx.note(group).await {
            say(format!("Document {} couldn't be imported: {e:#}", ctx.title_of(group)));
        }
    }
    for group in posts {
        if let Err(e) = ctx.post(group).await {
            say(format!("Post {} couldn't be republished: {e:#}", ctx.title_of(group)));
        }
    }
    if let Err(e) = ctx.profile().await {
        say(format!("The profile couldn't be imported: {e:#}"));
    }
    if let Err(e) = ctx.contacts().await {
        say(format!("Contacts couldn't be imported: {e:#}"));
    }
    if let Err(e) = ctx.lists().await {
        say(format!("Lists couldn't be imported: {e:#}"));
    }
    say(format!(
        "Finished: {} added, {} skipped because they already exist.",
        ctx.added, ctx.skipped
    ));
    Ok(())
}

/// What an import knows as it goes.
struct Ctx<'a> {
    state: &'a AppState,
    root: &'a str,
    root_bytes: [u8; 32],
    account: &'a str,
    dir: &'a Path,
    data: crate::record::store::Store,
    /// Every zip path's manifest row's document id, by path relative to the export's top.
    manifest_ids: HashMap<String, String>,
    /// Where the export's top sits in this zip: "" for an export as made, or a folder a person
    /// zipped it inside.
    prefix: String,
    /// Ids this persona holds, and the ones this import has added.
    held: BTreeSet<[u8; 16]>,
    /// The ones this import made: the only notes it will publish (a note the persona had before -
    /// one it chose to unpublish since, say - stays as it is).
    created: BTreeSet<[u8; 16]>,
    /// Each exported document's path without its ending - `<dir>/<stem>`, relative to the top -
    /// to its id, for the lists file.
    by_stem: HashMap<String, [u8; 16]>,
    /// Taxonomy titles, by id, kept current as sections are made.
    titles: HashMap<[u8; 16], String>,
    added: usize,
    skipped: usize,
}

impl<'a> Ctx<'a> {
    async fn new(
        state: &'a AppState,
        root: &'a str,
        account: &'a str,
        dir: &'a Path,
        paths: &[String],
        data: crate::record::store::Store,
    ) -> Result<Ctx<'a>> {
        let ae = |e: AppError| anyhow::anyhow!("{e}");
        let manifest_path = paths
            .iter()
            .filter(|p| p.rsplit('/').next() == Some("manifest.json"))
            .min_by_key(|p| p.len())
            .cloned();
        let prefix = manifest_path
            .as_deref()
            .and_then(|p| p.strip_suffix("manifest.json"))
            .unwrap_or("")
            .to_string();
        let mut manifest_ids = HashMap::new();
        if let Some(mp) = &manifest_path {
            if let Ok(Some(bytes)) = read_capped(&dir.join(mp), MAX_DETAILS_BYTES).await {
                if let Ok(m) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                    for f in m["files"].as_array().into_iter().flatten() {
                        if let (Some(p), Some(id)) = (f["path"].as_str(), f["id"].as_str()) {
                            manifest_ids.insert(p.to_string(), id.to_string());
                        }
                    }
                }
            }
        }
        let (heads, _) = data.documents().summaries().await.map_err(ae)?;
        let mut held: BTreeSet<[u8; 16]> = heads.iter().map(|h| h.doc_id).collect();
        held.extend(data.documents().deleted().await.map_err(ae)?);
        let titles = data
            .taxonomies()
            .all()
            .await
            .map_err(ae)?
            .into_iter()
            .map(|t| (t.taxonomy_id, t.title))
            .collect();
        let root_bytes: [u8; 32] =
            hex::decode(root).ok().and_then(|b| b.try_into().ok()).context("a persona's root")?;
        Ok(Ctx {
            state,
            root,
            root_bytes,
            account,
            dir,
            data,
            manifest_ids,
            prefix,
            held,
            created: BTreeSet::new(),
            by_stem: HashMap::new(),
            titles,
            added: 0,
            skipped: 0,
        })
    }

    fn say(&self, line: String) {
        self.state.imports.say(self.root, line);
    }

    /// One of the export's own details files, as text - absent, or larger than any such file
    /// should be, is nothing (and the latter is said).
    async fn details_file(&self, path: &str) -> Result<Option<String>> {
        match read_capped(&self.dir.join(path), MAX_DETAILS_BYTES).await? {
            Some(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
            None if self.dir.join(path).is_file() => {
                self.say(format!("{path} skipped: it's larger than a details file can be."));
                Ok(None)
            }
            None => Ok(None),
        }
    }

    fn relative<'p>(&self, path: &'p str) -> &'p str {
        path.strip_prefix(self.prefix.as_str()).unwrap_or(path)
    }

    /// A document's title before its file is read: its file name, less the id.
    fn title_of(&self, group: &Group) -> String {
        match group.stem.rsplit_once("--") {
            Some((title, tail)) if stem_id_prefix(&group.stem) == Some(tail) => title.to_string(),
            _ => group.stem.clone(),
        }
    }

    /// Does this persona already hold `id` - including one it holds under a public post's id?
    async fn holds(&self, id: &[u8; 16]) -> Result<bool> {
        if self.held.contains(id) {
            return Ok(true);
        }
        Ok(!self
            .data
            .documents()
            .held(&[*id])
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?
            .is_empty())
    }

    /// Which document a file is: its stated id, its manifest row's, or - for a bare `.md` that
    /// kept only its file name - the one held document whose id begins as its name ends.
    async fn id_for(&self, group: &Group, details: &Details) -> Option<[u8; 16]> {
        let parse = |s: &str| hex::decode(s.trim()).ok().and_then(|b| <[u8; 16]>::try_from(b).ok());
        if let Some(id) = details.get("id").and_then(|d| parse(&d.one())) {
            return Some(id);
        }
        if let Some(id) = self.manifest_ids.get(self.relative(&group.file)).and_then(|s| parse(s)) {
            return Some(id);
        }
        let prefix = stem_id_prefix(&group.stem)?;
        let mut matches = self.held.iter().filter(|id| hex::encode(id).starts_with(prefix));
        let first = *matches.next()?;
        matches.next().is_none().then_some(first)
    }

    /// The id a file with no id of its own is given: from its place in the zip and its bytes, so
    /// the same file imported twice is the same document - held the second time, and skipped -
    /// while a file changed since is a new one.
    fn derived_id(&self, group: &Group, bytes: &[u8]) -> [u8; 16] {
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"hdt2-import:");
        hasher.update(self.relative(&group.file).as_bytes());
        hasher.update(b"\0");
        hasher.update(bytes);
        let mut id = [0u8; 16];
        id.copy_from_slice(&hasher.finalize().as_bytes()[..16]);
        id
    }

    /// The most one file of this kind may be: a picture, video or sound the upload cap, anything
    /// else a document's cap - the limits the app's own doors hold every upload to.
    fn cap_for(&self, kind: Kind) -> u64 {
        match kind {
            Kind::Media(_) => self.state.config.max_upload_bytes as u64,
            _ => self.state.config.max_document_bytes as u64,
        }
    }

    /// A document's details, its words, and the file's own bytes - `None`, said in the report,
    /// when the file is larger than a document of its kind may be.
    async fn read(&self, group: &Group) -> Result<Option<(Details, Vec<u8>, Vec<u8>)>> {
        let cap = self.cap_for(group.kind);
        let Some(bytes) = read_capped(&self.dir.join(&group.file), cap).await? else {
            self.say(format!(
                "Document {} skipped: it's larger than this server takes ({} MB).",
                self.title_of(group),
                cap >> 20
            ));
            return Ok(None);
        };
        let (mut details, body) = read_document(group.kind, &group.file, &bytes);
        if let Some(sidecar) = &group.sidecar {
            if let Ok(Some(side)) = read_capped(&self.dir.join(sidecar), MAX_DETAILS_BYTES).await {
                let (side, _) = read_front_matter(&String::from_utf8_lossy(&side));
                for (k, v) in side {
                    details.entry(k).or_insert(v);
                }
            }
        }
        Ok(Some((details, body, bytes)))
    }

    /// One private document: created when the persona lacks it, skipped when it has it - and,
    /// either way, given what it lacks of the tags, notebooks and fields the file states.
    async fn note(&mut self, group: &Group) -> Result<()> {
        let ae = |e: AppError| anyhow::anyhow!("{e}");
        let Some((details, body, raw)) = self.read(group).await? else { return Ok(()) };
        let title = details.get("title").map(|d| d.one()).unwrap_or_else(|| self.title_of(group));
        let id = match self.id_for(group, &details).await {
            Some(id) => id,
            None => self.derived_id(group, &raw),
        };
        let stem_key = format!("{}/{}", self.relative(&group.dir), group.stem);
        if self.holds(&id).await? {
            self.say(format!("Document {title} skipped: It already exists!"));
            self.skipped += 1;
            self.by_stem.insert(stem_key, id);
            self.extras(&id, group, &details, false).await?;
            return Ok(());
        }
        match group.kind {
            Kind::Media(_) => {
                self.state
                    .ingest
                    .enqueue(
                        &self.state.node_db,
                        crate::ingest::Upload {
                            account: self.account,
                            root: self.root,
                            doc_id: id,
                            parents: &[],
                            title: &title,
                            bytes: &body,
                            audio: None,
                        },
                    )
                    .await
                    .map_err(ae)?;
                self.say(format!("Document {title} added (its picture is being prepared)."));
            }
            kind => {
                let format = match kind {
                    Kind::Marquee => Format::Marquee,
                    Kind::Drawing => Format::Drawing,
                    _ => Format::Plaintext,
                };
                // A drawing is strokes the app must be able to draw, on every computer it syncs
                // to: one that isn't drawing JSON is refused, and one that is is kept in the
                // canonical form the browser itself writes (drawing.rs).
                let body = if kind == Kind::Drawing {
                    if !serde_json::from_slice::<serde_json::Value>(&body)
                        .is_ok_and(|v| v.is_object())
                    {
                        self.say(format!(
                            "Document {title} skipped: it isn't a drawing this app can read."
                        ));
                        return Ok(());
                    }
                    crate::drawing::canonical(&crate::drawing::read(&body)).into_bytes()
                } else {
                    body
                };
                self.data
                    .documents()
                    .save(crate::record::documents::Save {
                        doc_id: id,
                        parents: Vec::new(),
                        title: title.clone(),
                        body,
                        format,
                        media: None,
                        refs: Vec::new(),
                    })
                    .await
                    .map_err(ae)?;
                self.say(format!("Document {title} added."));
            }
        }
        self.added += 1;
        self.held.insert(id);
        self.created.insert(id);
        self.by_stem.insert(stem_key, id);
        self.extras(&id, group, &details, true).await
    }

    /// What a document lacks of what its file states: tags, notebooks and their sections, and
    /// annotation fields - added, never changed. A new document's date is the one it was first
    /// written (`display_date`): signed dates can't be backdated, but the one a person reads by can.
    async fn extras(
        &mut self,
        id: &[u8; 16],
        group: &Group,
        details: &Details,
        new: bool,
    ) -> Result<()> {
        let ae = |e: AppError| anyhow::anyhow!("{e}");
        let have_tags: BTreeSet<String> =
            self.data.annotations().tags(id).await.map_err(ae)?.into_iter().collect();
        for tag in details.get("tags").map(|d| d.many()).unwrap_or_default() {
            if !have_tags.contains(&tag) {
                self.data.annotations().tag(id, &tag).await.map_err(ae)?;
            }
        }
        let have_fields = self.data.annotations().fields(id).await.map_err(ae)?;
        for (key, value) in details {
            if NOT_ANNOTATIONS.contains(&key.as_str()) || have_fields.contains_key(key) {
                continue;
            }
            let value = value.one();
            if !value.trim().is_empty() {
                self.data.annotations().set_field(id, key, &value).await.map_err(ae)?;
            }
        }
        let display = crate::record::store::DISPLAY_DATE;
        if new && !have_fields.contains_key(display) && !details.contains_key(display) {
            let date = details
                .get("date")
                .map(|d| d.one())
                .or_else(|| details.get("created").map(|d| d.one().chars().take(10).collect()));
            if let Some(date) = date.filter(|d| !d.trim().is_empty()) {
                self.data.annotations().set_field(id, display, date.trim()).await.map_err(ae)?;
            }
        }
        // Notebooks: as the details name them (the folder's name may have been made safe for a
        // file system), else the folder's; sections from the folders under the notebook's.
        let where_ = place(&group.dir);
        let mut buckets = details.get("buckets").map(|d| d.many()).unwrap_or_default();
        if buckets.is_empty() {
            buckets.extend(where_.bucket.clone());
        }
        if buckets.is_empty() {
            return Ok(());
        }
        let have: BTreeSet<String> =
            self.data.buckets().of(id).await.map_err(ae)?.into_iter().collect();
        let roster: BTreeSet<String> =
            self.data.buckets().roster().await.map_err(ae)?.into_iter().map(|b| b.name).collect();
        for bucket in &buckets {
            if !roster.contains(bucket) {
                self.data.buckets().define(bucket, "default").await.map_err(ae)?;
            }
            if !have.contains(bucket) {
                self.data.buckets().place(id, bucket).await.map_err(ae)?;
            }
        }
        // The sections belong to the folder's own notebook.
        if let Some(bucket) = where_.bucket.as_deref() {
            let bucket = buckets
                .iter()
                .find(|b| crate::export::file_name(b) == bucket)
                .cloned()
                .unwrap_or_else(|| bucket.to_string());
            let section = self.section(&bucket, &where_.sections).await?;
            let members = self.data.taxonomies().members(&section).await.map_err(ae)?;
            if !members.iter().any(|m| m.doc_id == *id && m.root == self.root_bytes) {
                self.data
                    .taxonomies()
                    .place(&section, &self.root_bytes, id, None)
                    .await
                    .map_err(ae)?;
            }
        }
        Ok(())
    }

    /// The taxonomy a notebook's sections lead to: the notebook's tree (`wiki:<bucket>`), and each
    /// section under the last, made where missing.
    async fn section(&mut self, bucket: &str, sections: &[String]) -> Result<[u8; 16]> {
        let ae = |e: AppError| anyhow::anyhow!("{e}");
        let tree_title = format!("wiki:{bucket}");
        let mut at = match self.titles.iter().find(|(_, t)| **t == tree_title) {
            Some((id, _)) => *id,
            None => {
                let id = self.data.taxonomies().create(&tree_title).await.map_err(ae)?;
                self.titles.insert(id, tree_title);
                id
            }
        };
        for name in sections {
            let members = self.data.taxonomies().members(&at).await.map_err(ae)?;
            let found = members.iter().find(|m| {
                m.root == self.root_bytes
                    && self
                        .titles
                        .get(&m.doc_id)
                        .is_some_and(|t| t == name || crate::export::file_name(t) == *name)
            });
            at = match found {
                Some(m) => m.doc_id,
                None => {
                    let id = self.data.taxonomies().create(name).await.map_err(ae)?;
                    self.titles.insert(id, name.clone());
                    self.data
                        .taxonomies()
                        .place(&at, &self.root_bytes, &id, None)
                        .await
                        .map_err(ae)?;
                    id
                }
            };
        }
        Ok(at)
    }

    /// One post: skipped when the persona has it (or has published the note it came from);
    /// otherwise said again, as a post of this persona's own (Curtis, 2026-10-09: "Public posts
    /// should be re-published") - from the note it came from when that's here, or from a note made
    /// of its words.
    async fn post(&mut self, group: &Group) -> Result<()> {
        let ae = |e: AppError| anyhow::anyhow!("{e}");
        let Some((details, body, raw)) = self.read(group).await? else { return Ok(()) };
        let title = details.get("title").map(|d| d.one()).unwrap_or_else(|| self.title_of(group));
        let post_id = match self.id_for(group, &details).await {
            Some(id) => id,
            None => self.derived_id(group, &raw),
        };
        if self.holds(&post_id).await? {
            self.say(format!("Post {title} skipped: It already exists!"));
            self.skipped += 1;
            return Ok(());
        }
        if details.contains_key("reply_to") {
            self.say(format!("Post {title} not republished: it was a reply in somebody's thread."));
            return Ok(());
        }
        if details.get("format").map(|d| d.one()).as_deref() == Some("room") {
            self.say(format!(
                "Post {title} not republished: a chat room starts fresh, never again."
            ));
            return Ok(());
        }
        let parse = |s: &str| hex::decode(s.trim()).ok().and_then(|b| <[u8; 16]>::try_from(b).ok());
        let from = details.get("published_from").and_then(|d| parse(&d.one()));
        let note = match from {
            // Said again only from a note this import made: one the persona already had is as
            // the persona left it - unpublished on purpose, perhaps - and so is its post.
            Some(note) if self.created.contains(&note) => note,
            Some(note) if self.held.contains(&note) => {
                self.say(format!("Post {title} skipped: It already exists!"));
                self.skipped += 1;
                return Ok(());
            }
            // No note to say it from: one made of its words, under the post's own id, so the
            // same zip imported again finds it held.
            _ => {
                let id = post_id;
                let format =
                    if group.kind == Kind::Plaintext { Format::Plaintext } else { Format::Marquee };
                self.data
                    .documents()
                    .save(crate::record::documents::Save {
                        doc_id: id,
                        parents: Vec::new(),
                        title: title.clone(),
                        body,
                        format,
                        media: None,
                        refs: Vec::new(),
                    })
                    .await
                    .map_err(ae)?;
                self.held.insert(id);
                self.created.insert(id);
                self.extras(&id, group, &details, true).await?;
                id
            }
        };
        let flags = crate::record::documents::PublishFlags {
            settled: false,
            trusted_only: details.get("trusted_only").is_some_and(|d| d.one() == "true"),
            seal_of: None,
            onward: false,
            dated_ms: details.get("created").and_then(|d| parse_date(&d.one())),
            part_of: None,
            room: false,
            im: false,
        };
        let held = crate::fold::hold(self.root);
        let mut posted = None;
        for _ in 0..BAKE_TRIES {
            match crate::record::bake::publish(
                self.state, &self.data, self.root, &note, None, flags,
            )
            .await
            .map_err(ae)?
            {
                crate::record::bake::Outcome::Posted(post) => {
                    posted = Some(post);
                    break;
                }
                // Its pictures are still being made (this import's own, likely): ask again.
                crate::record::bake::Outcome::Baking(_) => {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
            }
        }
        let Some(post) = posted else {
            drop(held);
            self.say(format!(
                "Post {title} not republished yet: its pictures are still being made. Publish its note when they're ready."
            ));
            return Ok(());
        };
        if let Err(e) = crate::identity::after_posted(
            self.state, &self.data, self.root, &note, post, None, flags,
        )
        .await
        {
            tracing::warn!(root = %self.root, error = ?e, "an imported post's after-duties failed; the post stands");
        }
        drop(held);
        crate::fold::fold_now(self.state, self.root).await;
        self.say(format!("Post {title} republished."));
        self.added += 1;
        Ok(())
    }

    /// The profile's name, words and colours where the persona has none, and its pictures likewise.
    async fn profile(&mut self) -> Result<()> {
        let ae = |e: AppError| anyhow::anyhow!("{e}");
        let path = format!("{}public/profile.yml", self.prefix);
        let Some(text) = self.details_file(&path).await? else { return Ok(()) };
        let (details, _) = read_front_matter(&format!("---\n{text}---\n"));
        let have: HashMap<String, String> = self
            .data
            .profile()
            .all()
            .await
            .map_err(ae)?
            .into_iter()
            .map(|f| (f.field, f.value))
            .collect();
        let mut said = Vec::new();
        for (field, value) in &details {
            if !crate::record::store::PROFILE_FIELDS.contains(&field.as_str())
                || have.get(field).is_some_and(|v| !v.trim().is_empty())
            {
                continue;
            }
            let value = value.one();
            if field == "avatar" || field == "banner" {
                let picture = self.dir.join(format!("{}public/{value}", self.prefix));
                let cap = self.state.config.max_upload_bytes as u64;
                let Ok(Some(bytes)) = read_capped(&picture, cap).await else { continue };
                let ingested = crate::media::lane::crush(move || {
                    crate::media::crush_with_progress(&bytes, &|_| {})
                })
                .await
                .context("the picture's thread")?
                .map_err(|e| anyhow::anyhow!("{e}"))?;
                let doc = crate::record::documents::save_public_media(
                    self.data.db(),
                    self.data.signer(),
                    &self.state.files,
                    field,
                    ingested,
                    None,
                    None,
                    false,
                )
                .await
                .map_err(ae)?;
                self.data.profile().set(field, &hex::encode(doc)).await.map_err(ae)?;
            } else {
                self.data.profile().set(field, &value).await.map_err(ae)?;
            }
            said.push(field.clone());
        }
        if !said.is_empty() {
            self.say(format!("Profile: {} added.", said.join(", ")));
        }
        Ok(())
    }

    /// The people the persona knew (Curtis, 2026-10-09: "Contacts should be re-applied"): each fact
    /// about each person the persona doesn't state already - follows and trust among them, so the
    /// persona follows again - then one pass to publish what that means.
    async fn contacts(&mut self) -> Result<()> {
        let ae = |e: AppError| anyhow::anyhow!("{e}");
        let path = format!("{}private/contacts.yml", self.prefix);
        let Some(text) = self.details_file(&path).await? else { return Ok(()) };
        let have: HashMap<String, BTreeMap<String, String>> =
            self.data.contacts().await.map_err(ae)?.into_iter().collect();
        let (mut people, mut facts) = (0, 0);
        for entry in list_of_maps(&text) {
            let Some(who) = entry.get("root").map(|d| d.one()) else { continue };
            if who == self.root || hex::decode(&who).map(|b| b.len()) != Ok(32) {
                continue;
            }
            let known = have.get(&who);
            let mut added = 0;
            for (key, value) in &entry {
                if key == "root" || key == "name" {
                    continue;
                }
                if known.and_then(|k| k.get(key)).is_some_and(|v| !v.trim().is_empty()) {
                    continue;
                }
                self.data
                    .private_registers(&format!("contact:{who}"))
                    .set(key, &value.one())
                    .await
                    .map_err(ae)?;
                added += 1;
            }
            if added > 0 {
                people += 1;
                facts += added;
            }
        }
        if facts > 0 {
            crate::fold::fold_now(self.state, self.root).await;
            if let Err(e) =
                crate::net::subscriptions::sweep(self.state.clone(), Some(self.root.to_string()))
                    .await
            {
                tracing::warn!(root = %self.root, error = ?e, "the subscription pass after an import failed");
            }
            self.say(format!("Contacts: {facts} things about {people} people added."));
        }
        Ok(())
    }

    /// The lists that are no notebook's (`private/taxonomies.yml`): each made where no list of its
    /// title exists, and given the members it lacks.
    async fn lists(&mut self) -> Result<()> {
        let ae = |e: AppError| anyhow::anyhow!("{e}");
        let path = format!("{}private/taxonomies.yml", self.prefix);
        let Some(text) = self.details_file(&path).await? else { return Ok(()) };
        for (title, members) in lists_file(&text) {
            let id = match self.titles.iter().find(|(_, t)| **t == title) {
                Some((id, _)) => *id,
                None => {
                    let id = self.data.taxonomies().create(&title).await.map_err(ae)?;
                    self.titles.insert(id, title.clone());
                    id
                }
            };
            let have = self.data.taxonomies().members(&id).await.map_err(ae)?;
            for member in members {
                let target = if let Some(doc) = self.by_stem.get(&member) {
                    Some((self.root_bytes, *doc))
                } else {
                    member.split_once('/').and_then(|(r, d)| {
                        let r: [u8; 32] = hex::decode(r).ok()?.try_into().ok()?;
                        let d: [u8; 16] = hex::decode(d).ok()?.try_into().ok()?;
                        Some((r, d))
                    })
                };
                let Some((r, d)) = target else { continue };
                if !have.iter().any(|m| m.root == r && m.doc_id == d) {
                    self.data.taxonomies().place(&id, &r, &d, None).await.map_err(ae)?;
                }
            }
        }
        Ok(())
    }
}

/// A file's bytes when it is at most `cap` - checked before reading, so a 10 GiB file in a zip is
/// never read into memory - and `None` when it's larger or not there.
async fn read_capped(path: &Path, cap: u64) -> Result<Option<Vec<u8>>> {
    let Ok(meta) = tokio::fs::metadata(path).await else { return Ok(None) };
    if !meta.is_file() || meta.len() > cap {
        return Ok(None);
    }
    Ok(Some(tokio::fs::read(path).await.context("reading a file")?))
}

/// A YAML list of maps as the export writes one (`contacts.yml`): `- key: value` opens an entry and
/// `  key: value` continues it.
fn list_of_maps(text: &str) -> Vec<Details> {
    let mut out: Vec<Details> = Vec::new();
    for line in text.lines() {
        let (fresh, rest) = match line.strip_prefix("- ") {
            Some(rest) => (true, rest),
            None if line.starts_with("  ") => (false, line.trim_start()),
            None => continue,
        };
        if fresh || out.is_empty() {
            out.push(Details::new());
        }
        if let (Some((k, v)), Some(entry)) = (split_key(rest), out.last_mut()) {
            entry.entry(k).or_insert(v);
        }
    }
    out
}

/// `taxonomies.yml` as the export writes it: each list's title and its members' paths.
fn lists_file(text: &str) -> Vec<(String, Vec<String>)> {
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("- ") {
            if let Some((k, v)) = split_key(rest) {
                if k == "title" {
                    out.push((v.one(), Vec::new()));
                }
            }
        } else if let Some(rest) = line.trim_start().strip_prefix("- ") {
            let member = serde_json::from_str::<String>(rest).unwrap_or_else(|_| rest.to_string());
            if member.starts_with("list: ") {
                continue;
            }
            if let Some((_, members)) = out.last_mut() {
                members.push(member);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_notes_renderings_are_one_document_read_from_the_richest() {
        let paths: Vec<String> = [
            "private/buckets/stable/barn/A horse--7b640f24.md",
            "private/buckets/stable/barn/A horse--7b640f24.mq",
            "private/buckets/stable/barn/A horse--7b640f24.yml.md",
            "private/unfiled/shopping--01f7c198.txt",
            "private/unfiled/shopping--01f7c198.yml.txt",
            "private/unfiled/pic--aaaaaaaa.avif",
            "private/unfiled/pic--aaaaaaaa.avif.yml",
            "private/unfiled/doodle--bbbbbbbb.horsedrawing",
            "private/unfiled/doodle--bbbbbbbb.horsedrawing.png",
            "private/contacts.yml",
            "private/chat/# barn--cccccccc.txt",
            "README.txt",
            "manifest.json",
            "notes/written elsewhere.md",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let found = groups(&paths);
        let files: Vec<&str> = found.iter().map(|g| g.file.as_str()).collect();
        assert!(files.contains(&"private/buckets/stable/barn/A horse--7b640f24.mq"));
        assert!(files.contains(&"private/unfiled/shopping--01f7c198.yml.txt"));
        assert!(files.contains(&"private/unfiled/doodle--bbbbbbbb.horsedrawing"));
        assert!(files.contains(&"notes/written elsewhere.md"));
        let pic = found.iter().find(|g| g.stem == "pic--aaaaaaaa").unwrap();
        assert_eq!(pic.kind, Kind::Media(Format::Avif));
        assert_eq!(pic.sidecar.as_deref(), Some("private/unfiled/pic--aaaaaaaa.avif.yml"));
        assert!(!files.iter().any(|f| f.contains("/chat/")), "a chat is never a document");
        assert!(!files.contains(&"README.txt"), "the zip's own README is no note: {files:?}");
        assert_eq!(found.len(), 5, "{files:?}");
    }

    #[test]
    fn folders_say_side_notebook_and_sections() {
        assert_eq!(
            place("private/buckets/stable/barn/loft"),
            Place {
                public: false,
                bucket: Some("stable".into()),
                sections: vec!["barn".into(), "loft".into()]
            }
        );
        assert_eq!(place("public/unfiled"), Place { public: true, bucket: None, sections: vec![] });
        assert_eq!(place("notes"), Place { public: false, bucket: None, sections: vec![] });
        assert_eq!(
            place("my backup/private/buckets/stable").bucket.as_deref(),
            Some("stable"),
            "an export zipped inside a folder of its own"
        );
        assert_eq!(stem_id_prefix("A horse--7b640f24"), Some("7b640f24"));
        assert_eq!(stem_id_prefix("A horse"), None);
        assert_eq!(stem_id_prefix("a--b--zzzzzzzz"), None);
    }

    #[test]
    fn an_exported_mq_reads_back_its_details_and_words() {
        let mq = ":::meta buckets=stable id=7b64 tags=\"brown, tall\" title=\"A \\\"quoted\\\" horse\"\n:::\n\nThe horse is **brown**.";
        let (details, body) = read_mq(mq);
        assert_eq!(details["title"].one(), "A \"quoted\" horse");
        assert_eq!(details["tags"].many(), ["brown", "tall"]);
        assert_eq!(body, "The horse is **brown**.");
        let (details, body) = read_mq(":::meta id=1:::\n:::meta id=2 title=x:::\nwords");
        assert_eq!((details["id"].one(), details["title"].one()), ("1".into(), "x".into()));
        assert_eq!(body, "words");
        let (details, body) = read_mq("no details here");
        assert!(details.is_empty());
        assert_eq!(body, "no details here");
    }

    #[test]
    fn front_matter_reads_ours_and_a_hand_written_one() {
        let ours = "---\n\"id\": \"7b64\"\n\"tags\": [\"brown\", \"with, comma\"]\n---\nwords\n";
        let (details, body) = read_front_matter(ours);
        assert_eq!(details["id"].one(), "7b64");
        assert_eq!(details["tags"].many(), ["brown", "with, comma"]);
        assert_eq!(body, "words\n");
        let theirs = "---\ntitle: My trip\ntags: [a, 'b']\ndate: 2015-07-31\n---\n# Day one\n";
        let (details, body) = read_front_matter(theirs);
        assert_eq!(details["title"].one(), "My trip");
        assert_eq!(details["tags"].many(), ["a", "b"]);
        assert_eq!(body, "# Day one\n");
        let (details, body) = read_front_matter("---\nnot closed\n");
        assert!(details.is_empty());
        assert_eq!(body, "---\nnot closed\n");
    }

    #[test]
    fn the_exports_own_yaml_reads_back() {
        let contacts = "- root: \"aa\"\n  name: \"Bea\"\n  \"interest\": \"high\"\n- root: \"bb\"\n  \"trust\": \"max\"\n";
        let people = list_of_maps(contacts);
        assert_eq!(people.len(), 2);
        assert_eq!(people[0]["interest"].one(), "high");
        assert_eq!(people[1]["root"].one(), "bb");
        let lists = "- title: \"Reading\"\n  members:\n    - \"private/unfiled/a--01234567\"\n    - \"list: Other\"\n    - \"aa/bb\"\n";
        assert_eq!(
            lists_file(lists),
            [(
                "Reading".to_string(),
                vec!["private/unfiled/a--01234567".to_string(), "aa/bb".to_string()]
            )]
        );
    }

    #[test]
    fn a_zip_that_climbs_out_or_balloons_is_refused() {
        let dir = std::env::temp_dir().join(format!("ringtome-import-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("evil.zip");
        {
            let mut z = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
            let o = zip::write::SimpleFileOptions::default();
            z.start_file("../escaped.txt", o).unwrap();
            std::io::Write::write_all(&mut z, b"out").unwrap();
            z.start_file("fine/inside.txt", o).unwrap();
            std::io::Write::write_all(&mut z, b"in").unwrap();
            z.finish().unwrap();
        }
        let into = dir.join("out");
        let names = unpack(&zip_path, &into, MIN_UNPACKED_BYTES).unwrap();
        assert_eq!(names, ["fine/inside.txt"]);
        assert!(!dir.join("escaped.txt").exists());
        assert!(unpack(&dir.join("missing.zip"), &into, MIN_UNPACKED_BYTES).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A bomb: 16 MiB of zeros deflates to a few KiB, and claims nothing of its size until it is
    /// unpacked - the limit counts what is written, so it stops at the limit, not at the claim.
    #[test]
    fn a_zip_bomb_stops_at_the_limit() {
        let dir = std::env::temp_dir().join(format!("ringtome-bomb-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("bomb.zip");
        {
            let mut z = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
            let o = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            z.start_file("private/unfiled/zeros.txt", o).unwrap();
            let chunk = vec![0u8; 1024 * 1024];
            for _ in 0..16 {
                std::io::Write::write_all(&mut z, &chunk).unwrap();
            }
            z.finish().unwrap();
        }
        assert!(std::fs::metadata(&zip_path).unwrap().len() < 1024 * 1024, "small on the wire");
        let err = unpack(&zip_path, &dir.join("out"), 4 * 1024 * 1024).unwrap_err();
        assert!(format!("{err}").contains("more than 4 MB"), "{err}");
        let written = std::fs::metadata(dir.join("out/private/unfiled/zeros.txt")).unwrap().len();
        assert!(written <= 4 * 1024 * 1024 + 1, "it stopped at the limit: {written}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_unpacking_limit_follows_the_upload_cap() {
        assert_eq!(unpack_limit(128 << 20), MIN_UNPACKED_BYTES, "a server's 128 MiB: 1 GiB");
        assert_eq!(unpack_limit(1 << 30), 4 << 30, "a desktop's 1 GiB: 4 GiB");
        assert_eq!(unpack_limit(u64::MAX), MAX_UNPACKED_BYTES);
    }

    #[test]
    fn sections_stop_sixteen_deep() {
        let deep = format!("private/buckets/stable/{}", vec!["s"; 2000].join("/"));
        assert_eq!(place(&deep).sections.len(), MAX_SECTION_DEPTH);
    }
}
