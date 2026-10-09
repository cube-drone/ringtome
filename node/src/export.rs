//! Exports (plans/EXPORT.md): a persona, whole, as one `.zip` a person can keep and read without
//! us - every note in each rendering a reader might open (`.mq`, `.md`, `.yml.md`, `.txt`,
//! `.yml.txt`, `.horsedrawing`), its pictures and sounds as their stored bytes, its posts opened,
//! and its profile, contacts, chats and bank - in folders by notebook and section.
//!
//! **No keys** (ruling 3): no signing key, no spare key, and no sealing key - `trusted_key` is
//! dropped from every note's metadata. The zip is content; moving a persona is adoption's job.
//!
//! **One queue, one export at a time, node-wide**: an export reads everything a persona holds and
//! compresses it, and a server with many people runs them in turn ([`Exports`]'s permit). Per
//! persona, **one export**: starting another cancels the one queued or running and deletes the last
//! zip. The zip is written as `.partial` and renamed when whole, so `<data>/exports/<root>.zip` is
//! always a finished export - and a restart, which forgets the queue, still finds it ready.
//!
//! **The writing happens on a thread of its own** ([`writer`]): compression is CPU work, and the
//! store's reads are async. The reads send each file down a channel to a blocking thread that owns
//! the zip; a cancelled export drops its end, and the thread throws its partial file away.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use axum::extract::{Path as UrlPath, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;

use crate::auth::Session;
use crate::error::AppError;
use crate::record::documents::Format;
use crate::AppState;

/// The annotation fields that are bookkeeping, not anything a person said: a sealing key (ruling
/// 3) and the publishing machinery's own notes.
const BOOKKEEPING: &[&str] = &[
    crate::record::store::TRUSTED_KEY,
    crate::record::store::PUBLISHED_HEAD,
    crate::record::store::PUBLISH_PLAN,
];

/// How many chat lines a page of history asks for, walking a room back to its start.
const CHAT_PAGE: i64 = crate::chat::HISTORY_PAGE;

/// One persona's export, as its page asks after it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Report {
    /// "none", "queued", "running", "ready" or "failed".
    pub status: &'static str,
    /// While running: documents written so far, of how many.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<usize>,
    /// When ready: the zip's size and when it was made.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub made_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The desktop app shows the file rather than downloading it (backup.rs's rule).
    pub reveal: bool,
}

#[derive(Debug, Clone)]
enum Status {
    Queued,
    Running { done: usize, total: usize },
    Failed(String),
}

struct Job {
    generation: u64,
    status: Status,
    task: tokio::task::AbortHandle,
}

/// The node's exports: each persona's queued or running one, and the permit that runs them one at
/// a time. A finished export is its file, not an entry here.
#[derive(Clone)]
pub struct Exports {
    jobs: Arc<Mutex<HashMap<String, Job>>>,
    /// One export or import at a time, node-wide (import.rs runs under it too).
    pub(crate) permit: Arc<tokio::sync::Semaphore>,
    generations: Arc<std::sync::atomic::AtomicU64>,
}

impl Default for Exports {
    fn default() -> Self {
        Self {
            jobs: Default::default(),
            permit: Arc::new(tokio::sync::Semaphore::new(1)),
            generations: Default::default(),
        }
    }
}

impl Exports {
    fn set(&self, root: &str, generation: u64, status: Status) {
        let mut jobs = self.jobs.lock().expect("exports poisoned");
        if let Some(job) = jobs.get_mut(root).filter(|j| j.generation == generation) {
            job.status = status;
        }
    }

    /// The job is over (done or failed): a done one is its file from here on.
    fn end(&self, root: &str, generation: u64, failed: Option<String>) {
        let mut jobs = self.jobs.lock().expect("exports poisoned");
        if jobs.get(root).is_some_and(|j| j.generation == generation) {
            match failed {
                Some(e) => {
                    if let Some(job) = jobs.get_mut(root) {
                        job.status = Status::Failed(e);
                    }
                }
                None => {
                    jobs.remove(root);
                }
            }
        }
    }
}

fn exports_dir(state: &AppState) -> PathBuf {
    state.config.data_directory.join("exports")
}

/// Where a persona's finished export lives. `root` is hex, checked by the caller's store open.
fn zip_path(state: &AppState, root: &str) -> PathBuf {
    exports_dir(state).join(format!("{root}.zip"))
}

/// Start a persona's export, replacing whatever it had: the queued or running one is cancelled and
/// the last zip deleted, so there is only ever the one on its way.
pub fn start(state: &AppState, root: &str) -> Report {
    let generation =
        state.exports.generations.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let mut jobs = state.exports.jobs.lock().expect("exports poisoned");
    if let Some(old) = jobs.remove(root) {
        old.task.abort();
    }
    let _ = std::fs::remove_file(zip_path(state, root));
    let task = {
        let (state, root) = (state.clone(), root.to_string());
        tokio::spawn(async move {
            let _permit = match state.exports.permit.clone().acquire_owned().await {
                Ok(p) => p,
                Err(_) => return,
            };
            state.exports.set(&root, generation, Status::Running { done: 0, total: 0 });
            let outcome = run(&state, &root, generation).await;
            if let Err(e) = &outcome {
                tracing::warn!(root = %root, error = ?e, "an export failed");
            }
            state.exports.end(&root, generation, outcome.err().map(|e| format!("{e:#}")));
        })
    };
    jobs.insert(
        root.to_string(),
        Job { generation, status: Status::Queued, task: task.abort_handle() },
    );
    drop(jobs);
    report(state, root)
}

/// Where a persona's export stands.
pub fn report(state: &AppState, root: &str) -> Report {
    let reveal = crate::registration::is_device(state);
    let none = Report {
        status: "none",
        done: None,
        total: None,
        bytes: None,
        made_ms: None,
        error: None,
        reveal,
    };
    if let Some(job) = state.exports.jobs.lock().expect("exports poisoned").get(root) {
        return match &job.status {
            Status::Queued => Report { status: "queued", ..none },
            Status::Running { done, total } => {
                Report { status: "running", done: Some(*done), total: Some(*total), ..none }
            }
            Status::Failed(e) => Report { status: "failed", error: Some(e.clone()), ..none },
        };
    }
    match std::fs::metadata(zip_path(state, root)) {
        Ok(meta) => Report {
            status: "ready",
            bytes: Some(meta.len()),
            made_ms: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64),
            ..none
        },
        Err(_) => none,
    }
}

// ---------------------------------------------------------------------------------------------
// Writing the zip

/// One file for the zip: its path inside it, and its bytes.
type Entry = (String, Vec<u8>);

/// The zip's own thread: every entry that comes down the channel, deflated, until the channel
/// closes. Finished - the sender's `true` - it is renamed into place; dropped, it is thrown away.
fn writer(
    partial: PathBuf,
    final_path: PathBuf,
    mut entries: tokio::sync::mpsc::Receiver<Entry>,
    finished: std::sync::mpsc::Receiver<bool>,
) -> Result<()> {
    let file = std::fs::File::create(&partial)
        .with_context(|| format!("creating {}", partial.display()))?;
    let mut zip = zip::ZipWriter::new(std::io::BufWriter::new(file));
    // Stored, not deflated, for what is already compressed: pictures, video and sound.
    let compressed =
        |name: &str| [".avif", ".png", ".webm", ".opus"].iter().any(|ext| name.ends_with(ext));
    let outcome = (|| -> Result<()> {
        while let Some((name, bytes)) = entries.blocking_recv() {
            let method = if compressed(&name) {
                zip::CompressionMethod::Stored
            } else {
                zip::CompressionMethod::Deflated
            };
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(method)
                .large_file(bytes.len() as u64 >= u32::MAX as u64);
            zip.start_file(name.as_str(), options).context("starting a file in the zip")?;
            zip.write_all(&bytes).context("writing a file into the zip")?;
        }
        Ok(())
    })();
    let whole = matches!(finished.recv(), Ok(true));
    match (outcome, whole) {
        (Ok(()), true) => {
            zip.finish().context("finishing the zip")?.flush().context("flushing the zip")?;
            std::fs::rename(&partial, &final_path)
                .with_context(|| format!("moving {} into place", final_path.display()))?;
            Ok(())
        }
        (outcome, _) => {
            drop(zip);
            let _ = std::fs::remove_file(&partial);
            outcome.and_then(|()| Err(anyhow::anyhow!("the export was cancelled")))
        }
    }
}

/// Build one persona's export. Everything is read through the agented store, the way background
/// passes read (the person who asked was checked at the door).
async fn run(state: &AppState, root: &str, generation: u64) -> Result<()> {
    std::fs::create_dir_all(exports_dir(state)).context("making the exports directory")?;
    let final_path = zip_path(state, root);
    let partial = exports_dir(state).join(format!("{root}.{generation}.partial"));
    let (send, entries) = tokio::sync::mpsc::channel::<Entry>(16);
    let (say_finished, finished) = std::sync::mpsc::channel::<bool>();
    let thread =
        tokio::task::spawn_blocking(move || writer(partial, final_path, entries, finished));

    let built = build(state, root, generation, &send).await;
    drop(send);
    let _ = say_finished.send(built.is_ok());
    let written = thread.await.context("the zip's thread")?;
    built.and(written)
}

/// The files of one export, sent to the writer as they are made: the channel holds a few files,
/// and a send waits while the writer compresses. Each is noted for the manifest as it goes.
struct Out<'a> {
    send: &'a tokio::sync::mpsc::Sender<Entry>,
    manifest: Vec<serde_json::Value>,
}

impl Out<'_> {
    /// A file that is no document's: the profile, the ledger, a chat.
    async fn put(&mut self, path: String, bytes: Vec<u8>) -> Result<()> {
        self.note(&path, &bytes, None);
        self.send(path, bytes).await
    }

    /// One of a document's renderings: the manifest says whose, and which version.
    async fn put_doc(&mut self, path: String, bytes: Vec<u8>, meta: &Meta) -> Result<()> {
        self.note(&path, &bytes, Some(meta));
        self.send(path, bytes).await
    }

    fn note(&mut self, path: &str, bytes: &[u8], meta: Option<&Meta>) {
        use sha2::Digest;
        let mut row = serde_json::json!({
            "path": path,
            "sha256": hex::encode(sha2::Sha256::digest(bytes)),
            "bytes": bytes.len(),
        });
        if let Some(meta) = meta {
            row["id"] = meta.id.clone().into();
            if let Some(head) = &meta.head {
                row["head"] = head.clone().into();
            }
        }
        self.manifest.push(row);
    }

    async fn send(&self, path: String, bytes: Vec<u8>) -> Result<()> {
        self.send.send((path, bytes)).await.map_err(|_| anyhow::anyhow!("the zip's thread stopped"))
    }
}

async fn build(
    state: &AppState,
    root: &str,
    generation: u64,
    send: &tokio::sync::mpsc::Sender<Entry>,
) -> Result<()> {
    let data = crate::record::store::open_agented(state, root)
        .await
        .map_err(|e| anyhow::anyhow!("opening the persona: {e}"))?;
    let ae = |e: AppError| anyhow::anyhow!("{e}");
    let mut out = Out { send, manifest: Vec::new() };
    let mut missing: Vec<String> = Vec::new();

    let (heads, _) = data.documents().summaries().await.map_err(ae)?;
    let buckets = data.buckets().all().await.map_err(ae)?;
    let annotations: HashMap<String, (BTreeMap<String, String>, Vec<String>)> = data
        .annotations()
        .all()
        .await
        .map_err(ae)?
        .into_iter()
        .map(|a| (a.doc_id, (a.fields, a.tags)))
        .collect();
    let (sections, others) = notebook_sections(&data, root).await?;
    let claimed = data.annotations().notes_claiming().await.map_err(ae)?;
    let posts = public_posts(&data).await?;
    let total = heads.len() + posts.len();
    state.exports.set(root, generation, Status::Running { done: 0, total });

    // The private side: every note, in each of its notebooks, at its place in the notebook's tree.
    let mut paths_of: HashMap<[u8; 16], String> = HashMap::new();
    for (done, head) in heads.iter().enumerate() {
        let format = Format::from_wire(head.format);
        let id = hex::encode(head.doc_id);
        let (fields, tags) = annotations.get(&id).cloned().unwrap_or_default();
        let in_buckets = buckets.get(&head.doc_id).cloned().unwrap_or_default();
        let meta = Meta {
            id: id.clone(),
            head: Some(hex::encode(head.head)),
            title: head.title.clone(),
            format,
            created_ms: head.genesis_ms,
            updated_ms: head.head_ms,
            tags,
            buckets: in_buckets.clone(),
            fields,
        };
        let Some(body) = data.documents().blob(head.file_hash).await.map_err(ae)? else {
            missing.push(format!("{} ({id})", display_title(&head.title)));
            continue;
        };
        let stem = stem(&head.title, &head.doc_id);
        let dirs: Vec<String> = if in_buckets.is_empty() {
            vec!["private/unfiled".to_string()]
        } else {
            in_buckets
                .iter()
                .map(|b| {
                    let mut dir = format!("private/buckets/{}", file_name(b));
                    for section in sections.get(&(b.clone(), head.doc_id)).into_iter().flatten() {
                        dir.push('/');
                        dir.push_str(&file_name(section));
                    }
                    dir
                })
                .collect()
        };
        // A drawing's picture beside its strokes (2026-10-09, drawing_paint.rs): painted once, at
        // twice its size - the browser's own download's backing - so it opens anywhere.
        let picture = if format == Format::Drawing {
            let width = crate::drawing::size_of(&crate::drawing::read(&body)).0.max(1) as u32 * 2;
            crate::drawing_paint::png(&data, &body, Some(width)).await
        } else {
            None
        };
        for dir in &dirs {
            let at = format!("{dir}/{stem}");
            paths_of.entry(head.doc_id).or_insert_with(|| at.clone());
            for (path, bytes) in render(&at, &meta, &body) {
                out.put_doc(path, bytes, &meta).await?;
            }
            if let Some(png) = &picture {
                out.put_doc(format!("{at}.horsedrawing.png"), png.clone(), &meta).await?;
            }
        }
        state.exports.set(root, generation, Status::Running { done: done + 1, total });
    }

    // The public side: what the persona published, opened, under the notebook of its note.
    for (i, post) in posts.iter().enumerate() {
        let id = hex::encode(post.doc_id);
        let note = claimed.get(&post.doc_id);
        let note_head = note.and_then(|n| heads.iter().find(|h| &h.doc_id == n));
        let title = note_head.map(|h| h.title.clone()).unwrap_or_else(|| post.title.clone());
        let Some((post_head, body)) = post_body(state, root, &data, post).await? else {
            missing.push(format!("{} (post {id})", display_title(&title)));
            continue;
        };
        let note_buckets = note.and_then(|n| buckets.get(n)).cloned().unwrap_or_default();
        let mut fields = BTreeMap::new();
        if post.trusted_only {
            fields.insert("trusted_only".to_string(), "true".to_string());
        }
        if let Some(n) = note {
            fields.insert("published_from".to_string(), hex::encode(n));
        }
        if let Some((author, doc)) = &post.reply_to {
            fields.insert("reply_to".to_string(), format!("{author}/{doc}"));
        }
        let meta = Meta {
            id: id.clone(),
            head: Some(hex::encode(post_head)),
            title: title.clone(),
            format: Format::from_wire(post.format),
            created_ms: post.genesis_ms,
            updated_ms: post.head_ms,
            tags: Vec::new(),
            buckets: note_buckets.clone(),
            fields,
        };
        let stem = stem(&title, &post.doc_id);
        let dirs: Vec<String> = if note_buckets.is_empty() {
            vec!["public/unfiled".to_string()]
        } else {
            note_buckets.iter().map(|b| format!("public/buckets/{}", file_name(b))).collect()
        };
        for dir in &dirs {
            for (path, bytes) in render(&format!("{dir}/{stem}"), &meta, &body) {
                out.put_doc(path, bytes, &meta).await?;
            }
        }
        state.exports.set(root, generation, Status::Running { done: heads.len() + i + 1, total });
    }

    profile(state, &data, &mut out).await?;
    taxonomies_file(&others, &paths_of, &mut out).await?;
    contacts_file(state, &data, &mut out).await?;
    bank_file(&data, &mut out).await?;
    chat_files(state, &data, root, &mut out).await?;
    readme(state, root, &missing, &mut out).await?;
    manifest(root, out).await
}

/// `manifest.json`, last: every file in the zip with its SHA-256 and size, and - for a document's
/// renderings - its id and the version exported. What an import reads to know a file, and what
/// `shasum -a 256` checks a file against.
async fn manifest(root: &str, out: Out<'_>) -> Result<()> {
    let body = serde_json::json!({
        "format": "hdt2-export",
        "version": 1,
        "persona": root,
        "made": iso(crate::clock::now_ms()),
        "files": out.manifest,
    });
    let bytes = serde_json::to_vec_pretty(&body).context("writing the manifest")?;
    out.send("manifest.json".to_string(), bytes).await
}

// ---------------------------------------------------------------------------------------------
// Where things go

/// Each (notebook, note) with the section path inside the notebook's tree (`wiki:<bucket>`), and
/// every other list - the taxonomies that are not a notebook's own - for `taxonomies.yml`.
async fn notebook_sections(
    data: &crate::record::store::Store,
    root: &str,
) -> Result<(HashMap<(String, [u8; 16]), Vec<String>>, Vec<crate::record::store::TaxonomyNode>)> {
    let ae = |e: AppError| anyhow::anyhow!("{e}");
    let mut sections = HashMap::new();
    let mut in_a_notebook: BTreeSet<[u8; 16]> = BTreeSet::new();
    let mut others = Vec::new();
    let all = data.taxonomies().all().await.map_err(ae)?;
    for tax in &all {
        let Some(bucket) = tax.title.strip_prefix("wiki:") else { continue };
        let tree = data.taxonomies().tree(&tax.taxonomy_id).await.map_err(ae)?;
        in_a_notebook.insert(tax.taxonomy_id);
        walk(&tree, bucket, &mut Vec::new(), root, &mut sections, &mut in_a_notebook);
    }
    for tax in &all {
        if !in_a_notebook.contains(&tax.taxonomy_id) {
            others.push(data.taxonomies().tree(&tax.taxonomy_id).await.map_err(ae)?);
        }
    }
    Ok((sections, others))
}

fn walk(
    node: &crate::record::store::TaxonomyNode,
    bucket: &str,
    path: &mut Vec<String>,
    root: &str,
    sections: &mut HashMap<(String, [u8; 16]), Vec<String>>,
    seen: &mut BTreeSet<[u8; 16]>,
) {
    for member in node.members.iter().flatten() {
        match &member.taxonomy {
            Some(section) => {
                seen.insert(section.taxonomy_id);
                path.push(display_title(&section.title));
                walk(section, bucket, path, root, sections, seen);
                path.pop();
            }
            None if hex::encode(member.root) == root => {
                sections.entry((bucket.to_string(), member.doc_id)).or_insert_with(|| path.clone());
            }
            None => {}
        }
    }
}

/// A note's file name without its extension: its title made safe, then the first eight hex of its
/// id - two notes called "untitled" never collide, and a file leads back to its document.
fn stem(title: &str, doc_id: &[u8; 16]) -> String {
    format!("{}--{}", file_name(&display_title(title)), &hex::encode(doc_id)[..8])
}

fn display_title(title: &str) -> String {
    let t = title.trim();
    if t.is_empty() {
        "untitled".to_string()
    } else {
        t.to_string()
    }
}

/// A name safe as one path segment on every system a zip opens on: no separators, no characters
/// Windows refuses, no leading dot, and not too long.
pub(crate) fn file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').trim();
    let cut: String = cleaned.chars().take(80).collect();
    let cut = cut.trim_end_matches(['.', ' ']).to_string();
    if cut.is_empty() {
        "untitled".to_string()
    } else {
        cut
    }
}

// ---------------------------------------------------------------------------------------------
// The renderings

/// What a note's renderings say about it, besides its words.
struct Meta {
    id: String,
    /// The version exported, hex: the document's display head (plans/EXPORT.md - cheap now, and
    /// what an import that ever wants more than "additive" would anchor on).
    head: Option<String>,
    title: String,
    format: Format,
    created_ms: i64,
    updated_ms: i64,
    tags: Vec<String>,
    buckets: Vec<String>,
    /// Its annotation fields, bookkeeping still in: [`Meta::pairs`] drops it.
    fields: BTreeMap<String, String>,
}

impl Meta {
    /// The metadata as ordered key/value pairs - the same in `:::meta` and in front matter.
    fn pairs(&self) -> Vec<(String, MetaValue)> {
        let mut out = vec![
            ("id".to_string(), MetaValue::One(self.id.clone())),
            ("title".to_string(), MetaValue::One(display_title(&self.title))),
            ("format".to_string(), MetaValue::One(self.format.as_str().to_string())),
            ("created".to_string(), MetaValue::One(iso(self.created_ms))),
            ("updated".to_string(), MetaValue::One(iso(self.updated_ms))),
        ];
        if let Some(head) = &self.head {
            out.insert(1, ("head".to_string(), MetaValue::One(head.clone())));
        }
        if !self.tags.is_empty() {
            out.push(("tags".to_string(), MetaValue::Many(self.tags.clone())));
        }
        if !self.buckets.is_empty() {
            out.push(("buckets".to_string(), MetaValue::Many(self.buckets.clone())));
        }
        for (k, v) in &self.fields {
            if !BOOKKEEPING.contains(&k.as_str()) && !out.iter().any(|(have, _)| have == k) {
                out.push((k.clone(), MetaValue::One(v.clone())));
            }
        }
        out
    }
}

enum MetaValue {
    One(String),
    Many(Vec<String>),
}

/// A note's files, at `at` (its folder and stem): every rendering its format has (ruling 1).
fn render(at: &str, meta: &Meta, body: &[u8]) -> Vec<Entry> {
    let text = || String::from_utf8_lossy(body).into_owned();
    match meta.format {
        Format::Marquee | Format::Room => {
            let source = text();
            let markdown =
                marquee_markdown::to_markdown(&source).unwrap_or_else(|_| source.clone());
            vec![
                (format!("{at}.mq"), format!("{}\n\n{source}", meta_directive(meta)).into_bytes()),
                (format!("{at}.md"), markdown.clone().into_bytes()),
                (format!("{at}.yml.md"), format!("{}{markdown}", front_matter(meta)).into_bytes()),
            ]
        }
        Format::Plaintext => vec![
            (format!("{at}.txt"), body.to_vec()),
            (format!("{at}.yml.txt"), format!("{}{}", front_matter(meta), text()).into_bytes()),
        ],
        Format::Drawing => {
            vec![(
                format!("{at}.horsedrawing"),
                format!("{}{}\n", front_matter(meta), text()).into_bytes(),
            )]
        }
        Format::Avif | Format::Apng | Format::WebmAv1 | Format::OggOpus => {
            let ext = match meta.format {
                Format::Avif => "avif",
                Format::Apng => "png",
                Format::WebmAv1 => "webm",
                _ => "opus",
            };
            // The picture as it is, and what is known about it beside it.
            vec![
                (format!("{at}.{ext}"), body.to_vec()),
                (format!("{at}.{ext}.yml"), front_matter(meta).into_bytes()),
            ]
        }
        // A book is a published notebook, whose pages are posts of their own.
        Format::Book => Vec::new(),
    }
}

/// The `:::meta` directive (Marquee SPEC, Document metadata), written by the parser crate's own
/// serializer so every value is quoted as the parser reads it. A list is joined with commas, as
/// the spec's own `tags="…"` example does; a newline would end the directive's line, so it goes.
fn meta_directive(meta: &Meta) -> String {
    let attrs: marquee_parser::Attrs = meta
        .pairs()
        .into_iter()
        .map(|(k, v)| {
            let v = match v {
                MetaValue::One(v) => v,
                MetaValue::Many(vs) => vs.join(", "),
            };
            let v: String = v.replace(['\n', '\r'], " ").chars().take(2000).collect();
            (k, v)
        })
        .collect();
    marquee_parser::serialize(&marquee_parser::Node::Directive {
        name: "meta".to_string(),
        attrs,
        children: Vec::new(),
    })
}

/// YAML front matter. Every scalar is a JSON string - which YAML reads as a double-quoted
/// scalar - so no value can break the file, and no YAML library is needed to write it.
fn front_matter(meta: &Meta) -> String {
    let mut out = String::from("---\n");
    for (k, v) in meta.pairs() {
        out.push_str(&yaml_line(&k, &v));
    }
    out.push_str("---\n");
    out
}

fn yaml_line(key: &str, value: &MetaValue) -> String {
    let q = |s: &str| serde_json::Value::String(s.to_string()).to_string();
    match value {
        MetaValue::One(v) => format!("{}: {}\n", q(key), q(v)),
        MetaValue::Many(vs) => {
            format!("{}: [{}]\n", q(key), vs.iter().map(|v| q(v)).collect::<Vec<_>>().join(", "))
        }
    }
}

fn iso(ms: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .ok()
        .and_then(|t| t.format(&time::format_description::well_known::Rfc3339).ok())
        .unwrap_or_else(|| ms.to_string())
}

// ---------------------------------------------------------------------------------------------
// Posts

/// Every post the persona published, text formats only - the media it published are its notes'
/// pictures, already written from the private side.
async fn public_posts(
    data: &crate::record::store::Store,
) -> Result<Vec<crate::record::documents::PublicDoc>> {
    let mut all = Vec::new();
    let mut after = None;
    loop {
        let page = crate::record::documents::public_docs(data.db(), after, 200)
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        let Some(last) = page.last() else { break };
        after = Some((last.genesis_ms, last.doc_id));
        let full = page.len() == 200;
        all.extend(page);
        if !full {
            break;
        }
    }
    Ok(all)
}

/// A post's display head and its words, opened: a trusted-only post is sealed on the network, and
/// the author holds its key (postkeys.rs). `None` when the bytes or the key are not on this
/// computer.
async fn post_body(
    state: &AppState,
    root: &str,
    data: &crate::record::store::Store,
    post: &crate::record::documents::PublicDoc,
) -> Result<Option<([u8; 32], Vec<u8>)>> {
    let Some(head) = crate::record::documents::public_head(data.db(), &post.doc_id)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?
    else {
        return Ok(None);
    };
    let Some(bytes) = state.files.get_public(iroh_blobs::Hash::from_bytes(head.file_hash)).await?
    else {
        return Ok(None);
    };
    if !post.trusted_only {
        return Ok(Some((head.head, bytes)));
    }
    let key = crate::postkeys::lookup(&state.node_db, root, &hex::encode(post.doc_id)).await?;
    Ok(key.and_then(|k| crate::record::private::open_post_body(&bytes, &k)).map(|b| (head.head, b)))
}

// ---------------------------------------------------------------------------------------------
// The rest of the persona

async fn profile(
    state: &AppState,
    data: &crate::record::store::Store,
    out: &mut Out<'_>,
) -> Result<()> {
    let fields = data.profile().all().await.map_err(|e| anyhow::anyhow!("{e}"))?;
    let mut yaml = String::new();
    for f in &fields {
        if f.field == "avatar" || f.field == "banner" {
            if let Some((ext, bytes)) = public_picture(state, data, &f.value).await? {
                let name = format!("{}.{ext}", f.field);
                yaml.push_str(&yaml_line(&f.field, &MetaValue::One(name.clone())));
                out.put(format!("public/{name}"), bytes).await?;
            }
            continue;
        }
        yaml.push_str(&yaml_line(&f.field, &MetaValue::One(f.value.clone())));
    }
    out.put("public/profile.yml".to_string(), yaml.into_bytes()).await
}

/// A profile picture's bytes, by its public doc id.
async fn public_picture(
    state: &AppState,
    data: &crate::record::store::Store,
    doc_hex: &str,
) -> Result<Option<(&'static str, Vec<u8>)>> {
    let Some(doc) = hex::decode(doc_hex).ok().and_then(|b| <[u8; 16]>::try_from(b).ok()) else {
        return Ok(None);
    };
    let Some(head) = crate::record::documents::public_head(data.db(), &doc)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?
    else {
        return Ok(None);
    };
    let ext = match Format::from_wire(head.format) {
        Format::Apng => "png",
        Format::WebmAv1 => "webm",
        _ => "avif",
    };
    Ok(state
        .files
        .get_public(iroh_blobs::Hash::from_bytes(head.file_hash))
        .await?
        .map(|b| (ext, b)))
}

/// The lists that are not a notebook's own tree, each with its members - the exported path of a
/// note of this persona's, or the reference of someone else's.
async fn taxonomies_file(
    others: &[crate::record::store::TaxonomyNode],
    paths_of: &HashMap<[u8; 16], String>,
    out: &mut Out<'_>,
) -> Result<()> {
    if others.is_empty() {
        return Ok(());
    }
    let q = |s: &str| serde_json::Value::String(s.to_string()).to_string();
    let mut yaml = String::new();
    for tax in others {
        yaml.push_str(&format!("- title: {}\n  members:\n", q(&display_title(&tax.title))));
        for m in tax.members.iter().flatten() {
            let said = match (&m.taxonomy, paths_of.get(&m.doc_id)) {
                (Some(t), _) => format!("list: {}", display_title(&t.title)),
                (None, Some(path)) => path.clone(),
                (None, None) => format!("{}/{}", hex::encode(m.root), hex::encode(m.doc_id)),
            };
            yaml.push_str(&format!("    - {}\n", q(&said)));
        }
    }
    out.put("private/taxonomies.yml".to_string(), yaml.into_bytes()).await
}

/// Who the persona knows: each contact by name where this computer knows it, and every fact the
/// persona keeps about them (trust, interest, tags, notes).
async fn contacts_file(
    state: &AppState,
    data: &crate::record::store::Store,
    out: &mut Out<'_>,
) -> Result<()> {
    let contacts = data.contacts().await.map_err(|e| anyhow::anyhow!("{e}"))?;
    let roots: Vec<String> = contacts.iter().map(|(r, _)| r.clone()).collect();
    let names = crate::profiles::bylines(&state.node_db, &roots).await?;
    let q = |s: &str| serde_json::Value::String(s.to_string()).to_string();
    let mut yaml = String::new();
    for (root, facts) in &contacts {
        yaml.push_str(&format!("- root: {}\n", q(root)));
        if let Some(name) = names.get(root).and_then(|b| b.name.as_deref()) {
            yaml.push_str(&format!("  name: {}\n", q(name)));
        }
        for (k, v) in facts {
            yaml.push_str(&format!("  {}: {}\n", q(k), q(v)));
        }
    }
    out.put("private/contacts.yml".to_string(), yaml.into_bytes()).await
}

/// Every line of the persona's ledger (bank.rs), oldest first, amounts in HorseBucks.
async fn bank_file(data: &crate::record::store::Store, out: &mut Out<'_>) -> Result<()> {
    let rows = crate::bank::all_lines(data).await.context("reading the ledger")?;
    let q = |s: &str| serde_json::Value::String(s.to_string()).to_string();
    let mut yaml = String::new();
    for (kind, source, pennies, at_ms, detail) in rows {
        yaml.push_str(&format!(
            "- at: {}\n  kind: {}\n  source: {}\n  horsebucks: {}\n  detail: {}\n",
            q(&iso(at_ms)),
            q(&kind),
            q(&source),
            q(&crate::bank::horsebucks(&pennies)),
            q(&detail),
        ));
    }
    out.put("private/bank.yml".to_string(), yaml.into_bytes()).await
}

/// Each room the persona is in, as this computer holds it: a line per message, oldest first.
async fn chat_files(
    state: &AppState,
    data: &crate::record::store::Store,
    root: &str,
    out: &mut Out<'_>,
) -> Result<()> {
    let rooms = crate::identity::routes::chat_rooms_with_seen(state, data, root)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    for (author, doc_hex, _) in rooms {
        let Some(doc) = hex::decode(&doc_hex).ok().and_then(|b| <[u8; 16]>::try_from(b).ok())
        else {
            continue;
        };
        let mut lines = Vec::new();
        let mut before = None;
        loop {
            let (page, _, more, _) =
                crate::chat::history(state, root, &author, &doc, before, CHAT_PAGE, None)
                    .await
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
            let Some(oldest) = page.iter().map(|m| m.said_ms).min() else { break };
            before = Some(oldest);
            lines.extend(page);
            if !more {
                break;
            }
        }
        if lines.is_empty() {
            continue;
        }
        lines.sort_by_key(|m| m.said_ms);
        let mut text = String::new();
        for m in &lines {
            let who = m.speaker_name.clone().unwrap_or_else(|| m.speaker[..8].to_string());
            let said = match (&m.notice, &m.words) {
                (Some(notice), _) => format!("({notice})"),
                (None, Some(words)) => words.clone(),
                (None, None) => "(sealed words this computer cannot open)".to_string(),
            };
            text.push_str(&format!("[{}] {who}: {said}\n", iso(m.said_ms)));
        }
        let name = crate::attention::room_name(state, &author, &doc_hex).await;
        let path = format!("private/chat/{}--{}.txt", file_name(&name), &doc_hex[..8]);
        out.put(path, text.into_bytes()).await?;
    }
    Ok(())
}

async fn readme(state: &AppState, root: &str, missing: &[String], out: &mut Out<'_>) -> Result<()> {
    let name = crate::profiles::bylines(&state.node_db, &[root.to_string()])
        .await?
        .get(root)
        .and_then(|b| b.name.clone())
        .unwrap_or_else(|| root[..8].to_string());
    let mut text = format!(
        "Horse Drawing Tycoon 2 - an export of {name}, made {}.\n\n\
         public/   what you published: your posts (opened, even the trusted-only ones), and your profile.\n\
         private/  everything else: your notes, drawings and pictures by notebook and section,\n\
         \x20         your contacts, your chats as this computer holds them, and your bank ledger.\n\n\
         Every Marquee note is here three ways: .mq (Marquee, its details in a :::meta line at the top),\n\
         .md (Markdown, words only) and .yml.md (Markdown under a YAML header of its details).\n\
         Plain notes are .txt and .yml.txt; drawings are .horsedrawing (a YAML header, then the strokes),\n\
         \x20with a .horsedrawing.png of the picture beside each.\n\
         Pictures, video and sound are as they were stored, each with a .yml of its details beside it.\n\n\
         manifest.json lists every file with its SHA-256, and each note's id and the version exported.\n\n\
         No keys are in this file: it is your words and pictures, not the means to be you.\n",
        iso(crate::clock::now_ms()),
    );
    if !missing.is_empty() {
        text.push_str(
            "\nNot on this computer yet, so not in this export (try again once it has synced):\n",
        );
        for m in missing {
            text.push_str(&format!("  - {m}\n"));
        }
    }
    out.put("README.txt".to_string(), text.into_bytes()).await
}

// ---------------------------------------------------------------------------------------------
// The doors

/// The persona's own signed-in account, or nobody.
async fn owner(state: &AppState, session: &Session, root: &str) -> Result<(), AppError> {
    crate::record::store::open(state, &session.account.id, root).await.map(|_| ())
}

/// POST `/api/identity/{root}/export` - start an export, replacing any before it.
pub async fn start_handler(
    session: Session,
    State(state): State<AppState>,
    UrlPath(root): UrlPath<String>,
) -> Result<Json<Report>, AppError> {
    owner(&state, &session, &root).await?;
    Ok(Json(start(&state, &root)))
}

/// GET `/api/identity/{root}/export` - where the export stands.
pub async fn report_handler(
    session: Session,
    State(state): State<AppState>,
    UrlPath(root): UrlPath<String>,
) -> Result<Json<Report>, AppError> {
    owner(&state, &session, &root).await?;
    Ok(Json(report(&state, &root)))
}

/// GET `/api/identity/{root}/export/download` - the finished zip, streamed.
pub async fn download_handler(
    session: Session,
    State(state): State<AppState>,
    UrlPath(root): UrlPath<String>,
) -> Result<impl IntoResponse, AppError> {
    owner(&state, &session, &root).await?;
    let path = zip_path(&state, &root);
    let file = tokio::fs::File::open(&path).await.map_err(|_| {
        AppError::NotFound(crate::msg!("export.no-export-yet", "no export is ready yet"))
    })?;
    let bytes = file.metadata().await.map(|m| m.len()).unwrap_or(0);
    let persona = crate::profiles::bylines(&state.node_db, std::slice::from_ref(&root))
        .await
        .map_err(AppError::Internal)?
        .get(&root)
        .and_then(|b| b.name.clone());
    let name = download_name(persona.as_deref(), &root);
    let body = axum::body::Body::from_stream(tokio_util::io::ReaderStream::new(file));
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, "application/zip".to_string()),
            (axum::http::header::CONTENT_LENGTH, bytes.to_string()),
            (axum::http::header::CONTENT_DISPOSITION, format!("attachment; filename=\"{name}\"")),
        ],
        body,
    ))
}

/// The zip's name as it downloads (Curtis, 2026-10-09): `hdt2-<persona's name>-<first 8 hex>.zip`,
/// the name lowercased and cut to letters, digits and single hyphens - plain ASCII, so the
/// header needs no quoting - and just `hdt2-<hex>.zip` when nothing of the name survives.
fn download_name(persona: Option<&str>, root: &str) -> String {
    let mut slug = String::new();
    for c in persona.unwrap_or("").chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug: String = slug.chars().take(40).collect();
    let slug = slug.trim_end_matches('-');
    let hash = &root[..8.min(root.len())];
    if slug.is_empty() {
        format!("hdt2-{hash}.zip")
    } else {
        format!("hdt2-{slug}-{hash}.zip")
    }
}

/// POST `/api/identity/{root}/export/reveal` - the desktop app shows the zip in the file manager:
/// it is already on the person's own disk, and a webview downloads nothing.
pub async fn reveal_handler(
    session: Session,
    State(state): State<AppState>,
    UrlPath(root): UrlPath<String>,
) -> Result<StatusCode, AppError> {
    owner(&state, &session, &root).await?;
    let path = zip_path(&state, &root);
    if !path.is_file() {
        return Err(AppError::NotFound(crate::msg!(
            "export.no-export-yet-2",
            "no export is ready yet"
        )));
    }
    if !crate::registration::is_device(&state)
        || !state.shell.ask(crate::shell::ShellRequest::Reveal { path })
    {
        return Err(AppError::NotFound(crate::msg!(
            "export.only-the-desktop-app-shows-files",
            "only the desktop app can show a file on this computer"
        )));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(format: Format) -> Meta {
        let mut fields = BTreeMap::new();
        fields.insert("display_date".to_string(), "2015-07-31".to_string());
        fields.insert(crate::record::store::TRUSTED_KEY.to_string(), "secret".to_string());
        Meta {
            id: "0123456789abcdef0123456789abcdef".to_string(),
            head: Some("ab".repeat(32)),
            title: "A \"quoted\" horse".to_string(),
            format,
            created_ms: 0,
            updated_ms: 1_000,
            tags: vec!["horses".to_string(), "with, commas".to_string()],
            buckets: vec!["Stable".to_string()],
            fields,
        }
    }

    /// A Marquee note is three files, and its `.mq` carries its details as a `:::meta` the parser
    /// reads back - title quotes and all - with no sealing key among them (ruling 3).
    #[test]
    fn a_marquee_note_is_mq_md_and_yml_md() {
        let files = render("private/x/note", &meta(Format::Marquee), b"Hello **horse**");
        let names: Vec<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["private/x/note.mq", "private/x/note.md", "private/x/note.yml.md"]);
        let mq = String::from_utf8(files[0].1.clone()).unwrap();
        let parsed = marquee_parser::parse(&mq).unwrap();
        let marquee_parser::Node::Document { children, .. } = parsed else { panic!("a document") };
        let Some(marquee_parser::Node::Directive { name, attrs, .. }) = children.first() else {
            panic!("the meta directive leads: {mq}")
        };
        assert_eq!(name, "meta");
        assert_eq!(attrs.get("title").map(String::as_str), Some("A \"quoted\" horse"));
        assert_eq!(attrs.get("created").map(String::as_str), Some("1970-01-01T00:00:00Z"));
        assert_eq!(attrs.get("display_date").map(String::as_str), Some("2015-07-31"));
        assert_eq!(attrs.get("head").map(String::as_str), Some("ab".repeat(32).as_str()));
        assert!(!mq.contains("secret"), "no sealing key in the export");
        let md = String::from_utf8(files[1].1.clone()).unwrap();
        assert!(md.contains("**horse**") && !md.contains("title"), "words only: {md}");
        let yml = String::from_utf8(files[2].1.clone()).unwrap();
        assert!(yml.starts_with("---\n\"id\": \"0123"), "{yml}");
        assert!(yml.contains(&format!("\"head\": \"{}\"", "ab".repeat(32))), "{yml}");
        assert!(yml.contains("\"tags\": [\"horses\", \"with, commas\"]"), "{yml}");
        assert!(!yml.contains("secret"));
    }

    #[test]
    fn plaintext_drawing_and_media_have_their_own_shapes() {
        let txt = render("p/n", &meta(Format::Plaintext), b"just words");
        assert_eq!(txt[0], ("p/n.txt".to_string(), b"just words".to_vec()));
        assert!(String::from_utf8_lossy(&txt[1].1).ends_with("---\njust words"));
        let drawing = render("p/d", &meta(Format::Drawing), b"{\"v\":1}");
        assert_eq!(drawing.len(), 1);
        assert_eq!(drawing[0].0, "p/d.horsedrawing");
        assert!(String::from_utf8_lossy(&drawing[0].1).ends_with("---\n{\"v\":1}\n"));
        let picture = render("p/i", &meta(Format::Apng), b"\x89PNG");
        assert_eq!(picture[0], ("p/i.png".to_string(), b"\x89PNG".to_vec()));
        assert_eq!(picture[1].0, "p/i.png.yml");
        assert!(render("p/b", &meta(Format::Book), b"{}").is_empty());
    }

    #[test]
    fn names_are_safe_and_never_collide() {
        assert_eq!(file_name("a/b\\c:d*e?f\"g<h>i|j"), "a-b-c-d-e-f-g-h-i-j");
        assert_eq!(file_name("  ..hidden  "), "hidden");
        assert_eq!(file_name("   "), "untitled");
        assert_eq!(file_name(&"x".repeat(200)).len(), 80);
        let (a, b) = ([1u8; 16], [2u8; 16]);
        assert_ne!(stem("", &a), stem("", &b));
        assert_eq!(stem("", &a), "untitled--01010101");
    }

    #[test]
    fn the_download_wears_the_persona_s_name() {
        let root = "0123456789abcdef";
        assert_eq!(
            download_name(Some("Petey Petey Pete"), root),
            "hdt2-petey-petey-pete-01234567.zip"
        );
        assert_eq!(
            download_name(Some("  Ünïcorn!! (the 2nd) "), root),
            "hdt2-n-corn-the-2nd-01234567.zip"
        );
        assert_eq!(download_name(Some("馬"), root), "hdt2-01234567.zip");
        assert_eq!(download_name(None, root), "hdt2-01234567.zip");
        assert!(
            download_name(Some(&"a".repeat(100)), root).len() <= "hdt2--01234567.zip".len() + 40
        );
    }

    #[test]
    fn a_newline_never_breaks_the_meta_line() {
        let mut m = meta(Format::Marquee);
        m.title = "two\nlines".to_string();
        let line = meta_directive(&m);
        let parsed = marquee_parser::parse(&line).unwrap();
        let marquee_parser::Node::Document { children, .. } = parsed else { panic!() };
        assert!(matches!(children.first(), Some(marquee_parser::Node::Directive { .. })), "{line}");
    }
}
