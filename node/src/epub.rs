//! ePubs (plans/EPUB.md, 2026-10-09): a notebook, or a public book, as one `.epub` a reader can carry
//! off - Curtis: "an ePub is just a bunch of HTML files zipped together, more or less, right?"
//!
//! More or less. The zip holds, in this order: `mimetype` (first, stored, never compressed - the
//! one thing every reader checks), `META-INF/container.xml` pointing at the package, the package
//! itself (`content.opf`: what is in the book and the reading order), `nav.xhtml` (the contents,
//! as the notebook's tree or the book's sections nest), a title page, one XHTML page per chapter, a
//! stylesheet, and the pictures.
//!
//! **The pages are Marquee rendered as XHTML** (`Output::Xhtml`, Marquee 0.9.3), through an ePub
//! profile of our own (`BookProfile`): a picture is a file in the book - JPEG, or PNG where it is
//! see-through, no larger than [`PICTURE_BOUND`] (an ePub reader takes neither AVIF nor video);
//! a drawing is painted (drawing_paint.rs); sound and video are the renderer's quiet placeholder;
//! a turbolink is its plain link; an emoji is its character; and a link from one page to another
//! goes to that page's chapter (`Profile::link_target`). A link the book can't follow - an app
//! address of something not in it - is its words without the link.
//!
//! **Cached** by what it is made of: a hash over the format's version, the book's shape, and the
//! version of every document read - each page and each picture (Curtis: "a hash of all of the
//! contained members' versions so that it doesn't get stale"). The same book asked for again is
//! the same file, served from `<data>/epubs/<hash>.epub`; an edit anywhere in it is a new hash, so
//! a new file. Files nobody has asked for in [`CACHE_DAYS`] go, and the folder is held to
//! [`CACHE_BYTES`], oldest first.
//!
//! **Who may have one**: a notebook, its persona's own signed-in account; a public book, anyone -
//! it is public - unless it is for trusted readers only, whose pages are sealed (refused whole), and
//! a page sealed or taken down is left out.

use std::collections::{BTreeSet, HashMap};
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use axum::extract::{Path as UrlPath, State};
use axum::response::IntoResponse;
use marquee_html_renderer::{
    EmojiResolution, MediaKind, MediaResolution, Output, Profile, TurbolinkLevel,
};

use crate::auth::Session;
use crate::error::AppError;
use crate::record::documents::Format;
use crate::AppState;

/// The format's own version: bump it when what an ePub holds changes, and every cached one is
/// made again.
const EPUB_VERSION: &str = "hdt2-epub-1/marquee-0.9.3";
/// The longest side a picture in a book may have: a reading screen's, give or take.
pub const PICTURE_BOUND: u32 = 1600;
/// How long a cached ePub nobody asks for again is kept, and how much the cache may hold.
pub const CACHE_DAYS: u64 = 30;
pub const CACHE_BYTES: u64 = 512 * 1024 * 1024;
/// How many books are made at once, node-wide: each reads every page and decodes every picture.
const BUILDING: usize = 2;

// ---------------------------------------------------------------------------------------------
// What a book is made of

/// A chapter's words, as its document holds them.
#[derive(Debug, Clone)]
enum Words {
    Marquee(String),
    Plain(String),
    /// A drawing, painted (drawing_paint.rs).
    Drawing(Vec<u8>),
    /// A picture document, a page of its own.
    Picture(Vec<u8>),
}

#[derive(Debug, Clone)]
struct Chapter {
    /// The document it is (a note, or a public page post), hex.
    id: String,
    /// Its version, hex - what the cache key is made of.
    head: String,
    title: String,
    words: Words,
}

/// The contents, as the tree or the book's sections nest: a page, or a section of them.
#[derive(Debug, Clone)]
enum Entry {
    Page(usize),
    Section { title: String, entries: Vec<Entry> },
}

/// A picture a page embeds, found before anything is made: what it is, and its version.
#[derive(Debug, Clone)]
struct Picture {
    /// The embed target as written in the page.
    target: String,
    /// Its document, hex, and that document's version.
    doc: String,
    head: String,
    format: Format,
    /// Where its bytes are: a private document's blob, or a public twin's.
    file_hash: [u8; 32],
}

/// A book, gathered: everything it is made of, read, and nothing yet made.
struct Book {
    title: String,
    author: String,
    /// A stable name for the book across its versions - the package's identifier.
    identity: String,
    chapters: Vec<Chapter>,
    contents: Vec<Entry>,
    pictures: Vec<Picture>,
    /// Whose documents these are, and how their bytes are read.
    root: String,
    public: bool,
    /// Links that name a document of the book's, by that document's id (hex) - a note's id, and,
    /// in a public book, a page post's.
    chapter_of: HashMap<String, usize>,
}

impl Book {
    /// The cache key: the format's version and everything the book is made of, in order.
    fn key(&self) -> String {
        let mut h = blake3::Hasher::new();
        let mut put = |s: &str| {
            h.update(s.as_bytes());
            h.update(b"\0");
        };
        put(EPUB_VERSION);
        put(&self.identity);
        put(&self.title);
        put(&self.author);
        for c in &self.chapters {
            put(&c.id);
            put(&c.head);
            put(&c.title);
        }
        fn shape(entries: &[Entry], put: &mut impl FnMut(&str)) {
            for e in entries {
                match e {
                    Entry::Page(i) => put(&format!("p{i}")),
                    Entry::Section { title, entries } => {
                        put("s(");
                        put(title);
                        shape(entries, put);
                        put(")");
                    }
                }
            }
        }
        shape(&self.contents, &mut put);
        for p in &self.pictures {
            put(&p.target);
            put(&p.head);
        }
        h.finalize().to_hex().to_string()
    }
}

// ---------------------------------------------------------------------------------------------
// Gathering: a notebook

/// A notebook as a book: its tree (`wiki:<bucket>`) in order - a section a section, a page a
/// chapter - then the notebook's pages the tree doesn't place. Every page the owner keeps, hidden
/// from the published book or not: this copy is theirs.
async fn notebook(
    state: &AppState,
    data: &crate::record::store::Store,
    root: &str,
    bucket: &str,
) -> Result<Book> {
    let ae = |e: AppError| anyhow::anyhow!("{e}");
    let in_bucket: BTreeSet<[u8; 16]> = data
        .buckets()
        .all()
        .await
        .map_err(ae)?
        .into_iter()
        .filter(|(_, names)| names.iter().any(|n| n == bucket))
        .map(|(id, _)| id)
        .collect();
    let tree_title = format!("wiki:{bucket}");
    let tree_id = data
        .taxonomies()
        .all()
        .await
        .map_err(ae)?
        .into_iter()
        .filter(|t| t.title == tree_title)
        .map(|t| t.taxonomy_id)
        .min();
    let mut book = Book {
        title: bucket.to_string(),
        author: author_name(state, root).await,
        identity: format!("urn:hdt2:{root}:notebook:{bucket}"),
        chapters: Vec::new(),
        contents: Vec::new(),
        pictures: Vec::new(),
        root: root.to_string(),
        public: false,
        chapter_of: HashMap::new(),
    };
    let root_bytes: [u8; 32] =
        hex::decode(root).ok().and_then(|b| b.try_into().ok()).context("a root")?;
    let mut placed: BTreeSet<[u8; 16]> = BTreeSet::new();
    if let Some(id) = tree_id {
        let tree = data.taxonomies().tree(&id).await.map_err(ae)?;
        let mut seen = BTreeSet::new();
        book.contents =
            walk_notebook(data, &tree, &root_bytes, &mut seen, &mut placed, &mut book.chapters)
                .await?;
    }
    for id in in_bucket.iter().filter(|id| !placed.contains(*id)) {
        if let Some(chapter) = private_chapter(data, id).await? {
            book.contents.push(Entry::Page(book.chapters.len()));
            book.chapters.push(chapter);
        }
    }
    for (i, c) in book.chapters.iter().enumerate() {
        book.chapter_of.insert(c.id.clone(), i);
    }
    book.pictures = private_pictures(data, root, &book.chapters).await?;
    Ok(book)
}

fn walk_notebook<'a>(
    data: &'a crate::record::store::Store,
    node: &'a crate::record::store::TaxonomyNode,
    root: &'a [u8; 32],
    seen: &'a mut BTreeSet<[u8; 16]>,
    placed: &'a mut BTreeSet<[u8; 16]>,
    chapters: &'a mut Vec<Chapter>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<Entry>>> + Send + 'a>> {
    Box::pin(async move {
        let mut entries = Vec::new();
        if !seen.insert(node.taxonomy_id) {
            return Ok(entries);
        }
        for m in node.members.as_deref().unwrap_or(&[]) {
            if let Some(section) = &m.taxonomy {
                let inner = walk_notebook(data, section, root, seen, placed, chapters).await?;
                if !inner.is_empty() {
                    entries.push(Entry::Section { title: section.title.clone(), entries: inner });
                }
            } else if &m.root == root && placed.insert(m.doc_id) {
                if let Some(chapter) = private_chapter(data, &m.doc_id).await? {
                    entries.push(Entry::Page(chapters.len()));
                    chapters.push(chapter);
                }
            }
        }
        Ok(entries)
    })
}

/// One of the persona's own documents as a chapter: a note's words, a drawing's strokes, a
/// picture's bytes - or nothing for a document that is none of these (sound, video), or whose
/// words haven't reached this computer.
async fn private_chapter(
    data: &crate::record::store::Store,
    id: &[u8; 16],
) -> Result<Option<Chapter>> {
    let ae = |e: AppError| anyhow::anyhow!("{e}");
    let Some(head) = data.documents().head(id).await.map_err(ae)? else { return Ok(None) };
    let format = Format::from_wire(head.format);
    if !matches!(
        format,
        Format::Marquee | Format::Plaintext | Format::Drawing | Format::Avif | Format::Apng
    ) {
        return Ok(None);
    }
    let Some(bytes) = data.documents().blob(head.file_hash).await.map_err(ae)? else {
        return Ok(None);
    };
    let text = || String::from_utf8_lossy(&bytes).into_owned();
    let words = match format {
        Format::Marquee => Words::Marquee(text()),
        Format::Plaintext => Words::Plain(text()),
        Format::Drawing => Words::Drawing(bytes.clone()),
        _ => Words::Picture(bytes.clone()),
    };
    Ok(Some(Chapter {
        id: hex::encode(id),
        head: hex::encode(head.head),
        title: head.title,
        words,
    }))
}

/// Every picture the notebook's pages embed that is one of the persona's own documents
/// (`/api/identity/<root>/docs/<id>/body/…`): a still picture, an animation's first frame, or a
/// drawing painted.
async fn private_pictures(
    data: &crate::record::store::Store,
    root: &str,
    chapters: &[Chapter],
) -> Result<Vec<Picture>> {
    let ae = |e: AppError| anyhow::anyhow!("{e}");
    let mut out: Vec<Picture> = Vec::new();
    for target in embeds(chapters) {
        let Some(id) = private_embed(&target, root) else { continue };
        let Some(head) = data.documents().head(&id).await.map_err(ae)? else { continue };
        let format = Format::from_wire(head.format);
        if matches!(format, Format::Avif | Format::Apng | Format::Drawing) {
            out.push(Picture {
                target,
                doc: hex::encode(id),
                head: hex::encode(head.head),
                format,
                file_hash: head.file_hash,
            });
        }
    }
    Ok(out)
}

/// Every embed target in the chapters' Marquee, each once, in order.
fn embeds(chapters: &[Chapter]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for c in chapters {
        if let Words::Marquee(source) = &c.words {
            if let Ok(node) = marquee_parser::parse(source) {
                crate::record::bake::each_embed(&node, &mut |t| {
                    if !out.iter().any(|have| have == t) {
                        out.push(t.to_string());
                    }
                });
            }
        }
    }
    out
}

/// The persona's own document an embed names: `/api/identity/<root>/docs/<id>/body…`.
fn private_embed(target: &str, root: &str) -> Option<[u8; 16]> {
    let at = target.find("/api/identity/")?;
    let rest = &target[at + "/api/identity/".len()..];
    let (who, rest) = rest.split_once('/')?;
    let rest = rest.strip_prefix("docs/")?;
    let id = rest.split(['/', '?', '#']).next()?;
    if who != root {
        return None;
    }
    hex::decode(id).ok()?.try_into().ok()
}

async fn author_name(state: &AppState, root: &str) -> String {
    crate::profiles::bylines(&state.node_db, &[root.to_string()])
        .await
        .ok()
        .and_then(|b| b.get(root).and_then(|b| b.name.clone()))
        .unwrap_or_else(|| root[..8].to_string())
}

// ---------------------------------------------------------------------------------------------
// Gathering: a public book

/// A public book as an ePub: its cover, its own pages, then its sections, as the book's JSON orders
/// them (books.rs `BookPayload`) - every page a public post read as a stranger reads it. A page
/// taken down, or sealed for trusted readers, is left out; a book for trusted readers is refused.
async fn public_book(
    state: &AppState,
    root: &str,
    book_id: &[u8; 16],
) -> Result<Option<Book>, AppError> {
    let Some(db) = state.user_dbs.get(root).await.map_err(AppError::Internal)? else {
        return Ok(None);
    };
    let Some(doc) = crate::record::documents::public_doc(&db, book_id).await? else {
        return Ok(None);
    };
    if Format::from_wire(doc.format) != Format::Book || doc.trusted_only {
        return Ok(None);
    }
    let Some(bytes) = public_bytes(state, &db, book_id).await? else { return Ok(None) };
    let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&bytes.1) else {
        return Ok(None);
    };
    let mut book = Book {
        title: payload["title"].as_str().unwrap_or(&doc.title).to_string(),
        author: author_name(state, root).await,
        identity: format!("urn:hdt2:{root}:book:{}", hex::encode(book_id)),
        chapters: Vec::new(),
        contents: Vec::new(),
        pictures: Vec::new(),
        root: root.to_string(),
        public: true,
        chapter_of: HashMap::new(),
    };
    let mut seen = BTreeSet::new();
    if !payload["cover"].is_null() {
        if let Some(e) =
            public_page(state, &db, &payload["cover"], &mut book.chapters, &mut seen).await?
        {
            book.contents.push(e);
        }
    }
    for page in payload["pages"].as_array().into_iter().flatten() {
        if let Some(e) = public_page(state, &db, page, &mut book.chapters, &mut seen).await? {
            book.contents.push(e);
        }
    }
    for section in payload["sections"].as_array().into_iter().flatten() {
        if let Some(e) =
            public_section(state, &db, section, &mut book.chapters, &mut seen, 0).await?
        {
            book.contents.push(e);
        }
    }
    for (i, c) in book.chapters.iter().enumerate() {
        book.chapter_of.insert(c.id.clone(), i);
    }
    // A page's links name the NOTE it was published from (bake.rs `public_links`): each note that
    // is one of the book's pages leads to that page's chapter too.
    let notes: Vec<(String, usize)> =
        book.chapter_of.iter().map(|(k, v)| (k.clone(), *v)).collect();
    for target in links(&book.chapters) {
        let Some(note) = crate::record::bake::own_doc(&target, root) else { continue };
        if let Ok(Some(post)) =
            crate::annotations::published_from(&state.node_db, root, &note).await
        {
            if let Some((_, i)) = notes.iter().find(|(id, _)| *id == post) {
                book.chapter_of.insert(note, *i);
            }
        }
    }
    let root_bytes: [u8; 32] =
        hex::decode(root).ok().and_then(|b| b.try_into().ok()).unwrap_or([0; 32]);
    for target in embeds(&book.chapters) {
        let Some((who, twin)) = crate::record::bake::twin_address(&target) else { continue };
        if who != root_bytes {
            continue;
        }
        let Some(head) = crate::record::documents::public_head(&db, &twin).await? else { continue };
        let format = Format::from_wire(head.format);
        if matches!(format, Format::Avif | Format::Apng) {
            book.pictures.push(Picture {
                target,
                doc: hex::encode(twin),
                head: hex::encode(head.head),
                format,
                file_hash: head.file_hash,
            });
        }
    }
    Ok(Some(book))
}

/// A public post's version and bytes, as the network holds them.
async fn public_bytes(
    state: &AppState,
    db: &crate::db::Db,
    id: &[u8; 16],
) -> Result<Option<([u8; 32], Vec<u8>)>, AppError> {
    let Some(head) = crate::record::documents::public_head(db, id).await? else { return Ok(None) };
    let bytes = state
        .files
        .get_public(iroh_blobs::Hash::from_bytes(head.file_hash))
        .await
        .map_err(AppError::Internal)?;
    Ok(bytes.map(|b| (head.head, b)))
}

async fn public_page(
    state: &AppState,
    db: &crate::db::Db,
    page: &serde_json::Value,
    chapters: &mut Vec<Chapter>,
    seen: &mut BTreeSet<String>,
) -> Result<Option<Entry>, AppError> {
    let Some(post) = page["post"].as_str() else { return Ok(None) };
    if !seen.insert(post.to_string()) {
        return Ok(None);
    }
    let Some(id) = hex::decode(post).ok().and_then(|b| <[u8; 16]>::try_from(b).ok()) else {
        return Ok(None);
    };
    let Some(doc) = crate::record::documents::public_doc(db, &id).await? else { return Ok(None) };
    if doc.trusted_only {
        return Ok(None);
    }
    let Some((head, bytes)) = public_bytes(state, db, &id).await? else { return Ok(None) };
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let words = match Format::from_wire(doc.format) {
        Format::Plaintext => Words::Plain(text),
        Format::Marquee | Format::Room => Words::Marquee(text),
        _ => return Ok(None),
    };
    let title = page["title"].as_str().map(str::to_string).unwrap_or(doc.title);
    chapters.push(Chapter { id: post.to_string(), head: hex::encode(head), title, words });
    Ok(Some(Entry::Page(chapters.len() - 1)))
}

fn public_section<'a>(
    state: &'a AppState,
    db: &'a crate::db::Db,
    section: &'a serde_json::Value,
    chapters: &'a mut Vec<Chapter>,
    seen: &'a mut BTreeSet<String>,
    depth: usize,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<Entry>, AppError>> + Send + 'a>>
{
    Box::pin(async move {
        if depth > 16 {
            return Ok(None);
        }
        let mut entries = Vec::new();
        for page in section["pages"].as_array().into_iter().flatten() {
            if let Some(e) = public_page(state, db, page, chapters, seen).await? {
                entries.push(e);
            }
        }
        for inner in section["sections"].as_array().into_iter().flatten() {
            if let Some(e) = public_section(state, db, inner, chapters, seen, depth + 1).await? {
                entries.push(e);
            }
        }
        if entries.is_empty() {
            return Ok(None);
        }
        let title = section["title"].as_str().unwrap_or("").to_string();
        Ok(Some(Entry::Section { title, entries }))
    })
}

/// Every link target in the chapters' Marquee, each once.
fn links(chapters: &[Chapter]) -> Vec<String> {
    let mut out = Vec::new();
    for c in chapters {
        if let Words::Marquee(source) = &c.words {
            for l in crate::record::bake::doc_links(source, "") {
                if !out.contains(&l.to) {
                    out.push(l.to);
                }
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Making the book

/// The page a chapter is written to.
fn chapter_file(i: usize) -> String {
    format!("chapter-{:03}.xhtml", i + 1)
}

/// The ePub's renderer profile: what each hook becomes in a book (the module's header).
struct BookProfile<'a> {
    /// Embed target -> its file in the book.
    pictures: &'a HashMap<String, String>,
    /// Link target -> the chapter it leads to.
    chapters: &'a (dyn Fn(&str) -> Option<String> + Sync),
}

impl Profile for BookProfile<'_> {
    fn link_allowed(&self, target: &str) -> bool {
        if (self.chapters)(target).is_some() {
            return true;
        }
        // The web and mail open where a reader opens them; an app address of something outside
        // the book leads nowhere offline, so it is its words alone.
        let lower = target.to_ascii_lowercase();
        lower.starts_with("http://")
            || lower.starts_with("https://")
            || lower.starts_with("mailto:")
    }

    fn link_target(&self, target: &str) -> Option<String> {
        (self.chapters)(target)
    }

    fn media(&self, target: &str) -> Option<MediaResolution> {
        self.pictures.get(target).map(|url| MediaResolution {
            kind: MediaKind::Image,
            url: url.clone(),
            looping: false,
        })
    }

    fn emoji(&self, slug: &str) -> Option<EmojiResolution> {
        marquee_markup::standard_emoji(slug).map(|e| EmojiResolution::Text(e.to_string()))
    }

    fn turbolink(&self, _target: &str, _level: TurbolinkLevel) -> Option<String> {
        None
    }

    fn turbolink_level(&self, _target: &str) -> TurbolinkLevel {
        TurbolinkLevel::Bare
    }
}

/// Text for XML: the five characters XML gives meaning to, and nothing else touched.
fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// One XHTML page of the book.
fn page(title: &str, body: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE html>\n\
         <html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\" lang=\"en\" xml:lang=\"en\">\n\
         <head>\n<meta charset=\"UTF-8\"/>\n<title>{t}</title>\n<link rel=\"stylesheet\" type=\"text/css\" href=\"style.css\"/>\n</head>\n\
         <body>\n{body}\n</body>\n</html>\n",
        t = xml(title)
    )
}

fn display(title: &str) -> String {
    let t = title.trim();
    if t.is_empty() {
        "untitled".to_string()
    } else {
        t.to_string()
    }
}

/// Plain words as XHTML: a paragraph per blank-line-separated block, its lines kept.
fn plain(text: &str) -> String {
    text.split("\n\n")
        .filter(|p| !p.trim().is_empty())
        .map(|p| format!("<p>{}</p>", p.lines().map(xml).collect::<Vec<_>>().join("<br/>")))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The stylesheet: Marquee's own, and what a book wants of pictures.
fn stylesheet() -> String {
    format!(
        "{}\nimg {{ max-width: 100%; height: auto; }}\nfigure {{ margin: 1em 0; text-align: center; }}\n\
         .book-title {{ text-align: center; margin-top: 30%; }}\n.book-author {{ text-align: center; font-style: italic; }}\n",
        marquee_markup::MARQUEE_CSS
    )
}

/// Make the book's files: every picture fetched and converted, every chapter rendered.
async fn make(
    state: &AppState,
    data: Option<&crate::record::store::Store>,
    book: &Book,
) -> Result<Vec<(String, Vec<u8>, &'static str)>> {
    // The pictures first, so every page knows its pictures' files.
    let mut files: Vec<(String, Vec<u8>, &'static str)> = Vec::new();
    let mut picture_files: HashMap<String, String> = HashMap::new();
    let mut made: HashMap<String, String> = HashMap::new();
    for p in &book.pictures {
        if let Some(name) = made.get(&p.doc) {
            picture_files.insert(p.target.clone(), name.clone());
            continue;
        }
        let Some((bytes, ext)) = picture(state, data, book, p.format, p.file_hash).await? else {
            continue;
        };
        let name = format!("images/{}.{ext}", p.doc);
        files.push((name.clone(), bytes, media_type(ext)));
        made.insert(p.doc.clone(), name.clone());
        picture_files.insert(p.target.clone(), name);
    }
    let chapter_of = |target: &str| -> Option<String> {
        let note = if book.public {
            crate::record::bake::own_doc(target, &book.root).or_else(|| post_link(target))
        } else {
            crate::record::bake::own_doc(target, &book.root)
        }?;
        book.chapter_of.get(&note).map(|i| chapter_file(*i))
    };
    let profile = BookProfile { pictures: &picture_files, chapters: &chapter_of };
    // The title page.
    files.push((
        "title.xhtml".to_string(),
        page(
            &book.title,
            &format!(
                "<h1 class=\"book-title\">{}</h1>\n<p class=\"book-author\">{}</p>",
                xml(&book.title),
                xml(&book.author)
            ),
        )
        .into_bytes(),
        "application/xhtml+xml",
    ));
    for (i, c) in book.chapters.iter().enumerate() {
        let title = display(&c.title);
        let inner = match &c.words {
            Words::Marquee(source) => {
                marquee_html_renderer::render_marquee_with(source, &profile, Output::Xhtml)
                    .unwrap_or_else(|_| plain(source))
            }
            Words::Plain(text) => plain(text),
            Words::Drawing(_) | Words::Picture(_) => {
                let (bytes, ext) = match &c.words {
                    Words::Drawing(body) => {
                        let Some(data) = data else { continue };
                        let width = (crate::drawing::size_of(&crate::drawing::read(body)).0.max(1)
                            as u32
                            * 2)
                        .min(PICTURE_BOUND);
                        match crate::drawing_paint::png(data, body, Some(width)).await {
                            Some(png) => (png, "png"),
                            None => continue,
                        }
                    }
                    Words::Picture(bytes) => {
                        let bytes = bytes.clone();
                        match tokio::task::spawn_blocking(move || {
                            crate::media::image::book_picture(&bytes, PICTURE_BOUND)
                        })
                        .await
                        {
                            Ok(Ok(p)) => p,
                            _ => continue,
                        }
                    }
                    _ => unreachable!(),
                };
                let name = format!("images/{}.{ext}", c.id);
                files.push((name.clone(), bytes, media_type(ext)));
                format!("<figure><img src=\"{}\" alt=\"{}\"/></figure>", xml(&name), xml(&title))
            }
        };
        files.push((
            chapter_file(i),
            page(
                &title,
                &format!(
                    "<section epub:type=\"chapter\">\n<h1>{}</h1>\n{inner}\n</section>",
                    xml(&title)
                ),
            )
            .into_bytes(),
            "application/xhtml+xml",
        ));
    }
    files.push(("style.css".to_string(), stylesheet().into_bytes(), "text/css"));
    Ok(files)
}

/// A public page's own link to another page of a book: `…/post/<book>/page/<page>` or `…/post/<id>`.
fn post_link(target: &str) -> Option<String> {
    let path = target.split(['?', '#']).next()?;
    let parts: Vec<&str> = path.split('/').collect();
    let at = parts.iter().position(|p| *p == "post")?;
    let id = match parts.get(at + 2) {
        Some(&"page") => parts.get(at + 3)?,
        _ => parts.get(at + 1)?,
    };
    (id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())).then(|| id.to_ascii_lowercase())
}

/// A picture's bytes, read and converted for a book.
async fn picture(
    state: &AppState,
    data: Option<&crate::record::store::Store>,
    book: &Book,
    format: Format,
    file_hash: [u8; 32],
) -> Result<Option<(Vec<u8>, &'static str)>> {
    let bytes = match (book.public, data) {
        (false, Some(data)) => {
            data.documents().blob(file_hash).await.map_err(|e| anyhow::anyhow!("{e}"))?
        }
        _ => state.files.get_public(iroh_blobs::Hash::from_bytes(file_hash)).await?,
    };
    let Some(bytes) = bytes else { return Ok(None) };
    if format == Format::Drawing {
        let Some(data) = data else { return Ok(None) };
        let width = (crate::drawing::size_of(&crate::drawing::read(&bytes)).0.max(1) as u32 * 2)
            .min(PICTURE_BOUND);
        return Ok(crate::drawing_paint::png(data, &bytes, Some(width)).await.map(|p| (p, "png")));
    }
    Ok(tokio::task::spawn_blocking(move || {
        crate::media::image::book_picture(&bytes, PICTURE_BOUND)
    })
    .await
    .context("the picture's thread")?
    .ok())
}

fn media_type(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        _ => "application/octet-stream",
    }
}

/// The contents page (`nav.xhtml`): the tree, nested as it nests.
fn nav(book: &Book) -> String {
    fn list(book: &Book, entries: &[Entry]) -> String {
        let mut out = String::from("<ol>\n");
        for e in entries {
            match e {
                Entry::Page(i) => out.push_str(&format!(
                    "<li><a href=\"{}\">{}</a></li>\n",
                    chapter_file(*i),
                    xml(&display(&book.chapters[*i].title))
                )),
                Entry::Section { title, entries } => out.push_str(&format!(
                    "<li><span>{}</span>\n{}</li>\n",
                    xml(&display(title)),
                    list(book, entries)
                )),
            }
        }
        out.push_str("</ol>");
        out
    }
    let body = if book.contents.is_empty() {
        "<nav epub:type=\"toc\" id=\"toc\"><h1>Contents</h1><ol><li><a href=\"title.xhtml\">Title</a></li></ol></nav>".to_string()
    } else {
        format!(
            "<nav epub:type=\"toc\" id=\"toc\">\n<h1>Contents</h1>\n{}\n</nav>",
            list(book, &book.contents)
        )
    };
    page("Contents", &body)
}

/// The package (`content.opf`): what the book is, what is in it, and the order it is read in.
fn package(book: &Book, files: &[(String, Vec<u8>, &'static str)]) -> String {
    let modified = time::OffsetDateTime::now_utc()
        .replace_nanosecond(0)
        .ok()
        .and_then(|t| t.format(&time::format_description::well_known::Rfc3339).ok())
        .unwrap_or_default();
    let item_id = |name: &str| name.replace(['/', '.'], "-");
    let mut manifest = String::from("<item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>\n");
    for (name, _, media) in files {
        manifest.push_str(&format!(
            "<item id=\"{}\" href=\"{}\" media-type=\"{media}\"/>\n",
            item_id(name),
            xml(name)
        ));
    }
    let mut spine = String::from("<itemref idref=\"title-xhtml\"/>\n");
    for i in 0..book.chapters.len() {
        let name = chapter_file(i);
        if files.iter().any(|(n, _, _)| *n == name) {
            spine.push_str(&format!("<itemref idref=\"{}\"/>\n", item_id(&name)));
        }
    }
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <package xmlns=\"http://www.idpf.org/2007/opf\" version=\"3.0\" unique-identifier=\"book-id\" xml:lang=\"en\">\n\
         <metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\n\
         <dc:identifier id=\"book-id\">{id}</dc:identifier>\n<dc:title>{title}</dc:title>\n<dc:creator>{author}</dc:creator>\n\
         <dc:language>en</dc:language>\n<meta property=\"dcterms:modified\">{modified}</meta>\n</metadata>\n\
         <manifest>\n{manifest}</manifest>\n<spine>\n{spine}</spine>\n</package>\n",
        id = xml(&book.identity),
        title = xml(&book.title),
        author = xml(&book.author),
    )
}

const CONTAINER: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<container version=\"1.0\" xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\">\n\
<rootfiles>\n<rootfile full-path=\"OEBPS/content.opf\" media-type=\"application/oebps-package+xml\"/>\n</rootfiles>\n\
</container>\n";

/// The zip: `mimetype` first and stored, then the rest under `OEBPS/`.
fn zip_book(book: &Book, files: &[(String, Vec<u8>, &'static str)], to: &Path) -> Result<()> {
    let file = std::fs::File::create(to).with_context(|| format!("creating {}", to.display()))?;
    let mut zip = zip::ZipWriter::new(std::io::BufWriter::new(file));
    let stored =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let deflated = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("mimetype", stored)?;
    zip.write_all(b"application/epub+zip")?;
    zip.start_file("META-INF/container.xml", deflated)?;
    zip.write_all(CONTAINER.as_bytes())?;
    zip.start_file("OEBPS/content.opf", deflated)?;
    zip.write_all(package(book, files).as_bytes())?;
    zip.start_file("OEBPS/nav.xhtml", deflated)?;
    zip.write_all(nav(book).as_bytes())?;
    for (name, bytes, media) in files {
        let options = if media.starts_with("image/") { stored } else { deflated };
        zip.start_file(format!("OEBPS/{name}"), options)?;
        zip.write_all(bytes)?;
    }
    zip.finish()?.flush()?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// The cache, and the doors

fn cache_dir(state: &AppState) -> PathBuf {
    state.config.data_directory.join("epubs")
}

fn building() -> &'static tokio::sync::Semaphore {
    static PERMITS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    PERMITS.get_or_init(|| tokio::sync::Semaphore::new(BUILDING))
}

/// The book's file: from the cache when this exact book was made before, else made now.
async fn file_for(
    state: &AppState,
    data: Option<&crate::record::store::Store>,
    book: &Book,
) -> Result<PathBuf> {
    let dir = cache_dir(state);
    tokio::fs::create_dir_all(&dir).await.context("making the ePub cache")?;
    let path = dir.join(format!("{}.epub", book.key()));
    if path.is_file() {
        // Asked for again: kept longer.
        if let Ok(f) = std::fs::File::options().append(true).open(&path) {
            let _ = f.set_modified(std::time::SystemTime::now());
        }
        return Ok(path);
    }
    let _permit = building().acquire().await.context("the ePub permit")?;
    if path.is_file() {
        return Ok(path);
    }
    let files = make(state, data, book).await?;
    let partial = dir.join(format!("{}.{}.partial", book.key(), rand::random::<u64>()));
    let (book_shape, to) = (BookShape::of(book), partial.clone());
    tokio::task::spawn_blocking(move || zip_book(&book_shape.0, &files, &to))
        .await
        .context("the ePub's thread")??;
    tokio::fs::rename(&partial, &path).await.context("moving the ePub into place")?;
    prune(&dir);
    Ok(path)
}

/// What the zip's own files need of a book, owned, for its thread.
struct BookShape(Book);

impl BookShape {
    fn of(b: &Book) -> Self {
        BookShape(Book {
            title: b.title.clone(),
            author: b.author.clone(),
            identity: b.identity.clone(),
            chapters: b
                .chapters
                .iter()
                .map(|c| Chapter { words: Words::Plain(String::new()), ..c.clone() })
                .collect(),
            contents: b.contents.clone(),
            pictures: Vec::new(),
            root: b.root.clone(),
            public: b.public,
            chapter_of: HashMap::new(),
        })
    }
}

/// Keep the cache to what was asked for lately, and to its size: the oldest go first.
fn prune(dir: &Path) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    let now = std::time::SystemTime::now();
    let mut kept: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        let modified = meta.modified().unwrap_or(now);
        let age = now.duration_since(modified).unwrap_or_default();
        let stale = age.as_secs() > CACHE_DAYS * 86_400;
        let abandoned = path.extension().is_some_and(|e| e == "partial") && age.as_secs() > 3600;
        if stale || abandoned {
            let _ = std::fs::remove_file(&path);
        } else if path.extension().is_some_and(|e| e == "epub") {
            kept.push((modified, meta.len(), path));
        }
    }
    kept.sort_by_key(|(m, _, _)| std::cmp::Reverse(*m));
    let mut total = 0u64;
    for (_, len, path) in kept {
        total += len;
        if total > CACHE_BYTES {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// The file's name as it downloads: the book's title, cut to letters, digits and hyphens.
fn download_name(title: &str) -> String {
    let mut slug = String::new();
    for c in title.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug: String = slug.chars().take(60).collect();
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() {
        "book.epub".to_string()
    } else {
        format!("{slug}.epub")
    }
}

async fn serve(path: PathBuf, title: &str) -> Result<impl IntoResponse, AppError> {
    let file = tokio::fs::File::open(&path)
        .await
        .context("opening the ePub")
        .map_err(AppError::Internal)?;
    let bytes = file.metadata().await.map(|m| m.len()).unwrap_or(0);
    let body = axum::body::Body::from_stream(tokio_util::io::ReaderStream::new(file));
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, "application/epub+zip".to_string()),
            (axum::http::header::CONTENT_LENGTH, bytes.to_string()),
            (
                axum::http::header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{}\"", download_name(title)),
            ),
        ],
        body,
    ))
}

/// GET `/api/identity/{root}/buckets/{bucket}/epub` - a notebook as an ePub, for its own persona.
pub async fn notebook_handler(
    session: Session,
    State(state): State<AppState>,
    UrlPath((root, bucket)): UrlPath<(String, String)>,
) -> Result<impl IntoResponse, AppError> {
    let data = crate::record::store::open(&state, &session.account.id, &root).await?;
    let book = notebook(&state, &data, &root, &bucket).await.map_err(AppError::Internal)?;
    if book.chapters.is_empty() {
        return Err(AppError::NotFound(crate::msg!(
            "epub.nothing-to-read",
            "that notebook has nothing to read yet"
        )));
    }
    let path = file_for(&state, Some(&data), &book).await.map_err(AppError::Internal)?;
    serve(path, &book.title).await
}

/// GET `/ringtome/user/{seg}/post/{book}/epub` - a public book as an ePub, for anyone.
pub async fn book_handler(
    State(state): State<AppState>,
    UrlPath((seg, book)): UrlPath<(String, String)>,
) -> Result<impl IntoResponse, AppError> {
    let not_here = || AppError::NotFound(crate::msg!("epub.no-such-book", "no such book here"));
    let Some(crate::speakable::Parsed::Ok(root)) = crate::speakable::parse(&seg) else {
        return Err(not_here());
    };
    let root = hex::encode(root);
    let Some(book_id) = hex::decode(&book).ok().and_then(|b| <[u8; 16]>::try_from(b).ok()) else {
        return Err(not_here());
    };
    if !crate::idface::hosted_here(&state, &root).await? {
        return Err(not_here());
    }
    let Some(book) = public_book(&state, &root, &book_id).await? else { return Err(not_here()) };
    if book.chapters.is_empty() {
        return Err(not_here());
    }
    let path = file_for(&state, None, &book).await.map_err(AppError::Internal)?;
    serve(path, &book.title).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book(chapters: Vec<Chapter>, contents: Vec<Entry>) -> Book {
        let mut chapter_of = HashMap::new();
        for (i, c) in chapters.iter().enumerate() {
            chapter_of.insert(c.id.clone(), i);
        }
        Book {
            title: "The Stable & <Co>".into(),
            author: "Ada".into(),
            identity: "urn:hdt2:test".into(),
            chapters,
            contents,
            pictures: Vec::new(),
            root: "aa".repeat(32),
            public: false,
            chapter_of,
        }
    }

    fn chapter(id: &str, title: &str, words: Words) -> Chapter {
        Chapter { id: id.repeat(16), head: "00".repeat(32), title: title.into(), words }
    }

    #[test]
    fn the_key_changes_with_any_version_and_only_then() {
        let a = book(vec![chapter("01", "one", Words::Plain("x".into()))], vec![Entry::Page(0)]);
        let same = book(vec![chapter("01", "one", Words::Plain("x".into()))], vec![Entry::Page(0)]);
        assert_eq!(a.key(), same.key());
        let mut edited =
            book(vec![chapter("01", "one", Words::Plain("x".into()))], vec![Entry::Page(0)]);
        edited.chapters[0].head = "11".repeat(32);
        assert_ne!(a.key(), edited.key(), "a page's new version is a new book");
        let moved = book(
            vec![chapter("01", "one", Words::Plain("x".into()))],
            vec![Entry::Section { title: "s".into(), entries: vec![Entry::Page(0)] }],
        );
        assert_ne!(a.key(), moved.key(), "and so is a page moved into a section");
    }

    #[test]
    fn a_page_is_well_formed_xhtml_with_its_links_and_pictures_resolved() {
        let mut b = book(
            vec![
                chapter("01", "one", Words::Marquee(String::new())),
                chapter("02", "two", Words::Plain(String::new())),
            ],
            vec![Entry::Page(0), Entry::Page(1)],
        );
        let root = b.root.clone();
        let two = "02".repeat(16);
        let source = format!(
            "A line  \nbroken, :horse: and [the next page](/ringtome/user/{root}/doc/{two}) and [elsewhere](/ringtome/user/{root}/doc/{})\n\n![a pony](/api/identity/{root}/docs/{}/body/pony.avif)\n\n---\n",
            "09".repeat(16),
            "07".repeat(16)
        );
        b.chapters[0].words = Words::Marquee(source.clone());
        let mut pictures = HashMap::new();
        pictures.insert(
            format!("/api/identity/{root}/docs/{}/body/pony.avif", "07".repeat(16)),
            "images/pony.jpg".to_string(),
        );
        let chapter_of = |t: &str| {
            crate::record::bake::own_doc(t, &b.root)
                .and_then(|n| b.chapter_of.get(&n).map(|i| chapter_file(*i)))
        };
        let profile = BookProfile { pictures: &pictures, chapters: &chapter_of };
        let html =
            marquee_html_renderer::render_marquee_with(&source, &profile, Output::Xhtml).unwrap();
        assert!(
            html.contains("href=\"chapter-002.xhtml\""),
            "a page's link goes to its chapter: {html}"
        );
        assert!(
            !html.contains("0909090909"),
            "a link the book can't follow is its words alone: {html}"
        );
        assert!(html.contains("src=\"images/pony.jpg\""), "the picture is the book's own: {html}");
        assert!(
            html.contains("<hr/>") && html.contains("loading=\"lazy\"/>"),
            "XHTML's closed void elements: {html}"
        );
        assert!(html.contains('🐴'), "the emoji is its character: {html}");
        let page = page("one", &html);
        assert!(page.starts_with("<?xml"));
        assert!(page.contains("xmlns=\"http://www.w3.org/1999/xhtml\""));
    }

    #[test]
    fn the_contents_nest_and_the_package_reads_in_order() {
        let b = book(
            vec![
                chapter("01", "one", Words::Plain("a\n\nb".into())),
                chapter("02", "", Words::Plain("c".into())),
            ],
            vec![
                Entry::Page(0),
                Entry::Section { title: "Part <II>".into(), entries: vec![Entry::Page(1)] },
            ],
        );
        let nav = nav(&b);
        assert!(nav.contains("<li><span>Part &lt;II&gt;</span>\n<ol>\n<li><a href=\"chapter-002.xhtml\">untitled</a></li>"), "{nav}");
        let files = vec![
            ("title.xhtml".to_string(), Vec::new(), "application/xhtml+xml"),
            (chapter_file(0), Vec::new(), "application/xhtml+xml"),
            (chapter_file(1), Vec::new(), "application/xhtml+xml"),
        ];
        let opf = package(&b, &files);
        let spine: Vec<&str> = opf.lines().filter(|l| l.starts_with("<itemref")).collect();
        assert_eq!(
            spine,
            [
                "<itemref idref=\"title-xhtml\"/>",
                "<itemref idref=\"chapter-001-xhtml\"/>",
                "<itemref idref=\"chapter-002-xhtml\"/>"
            ]
        );
        assert!(opf.contains("<dc:title>The Stable &amp; &lt;Co&gt;</dc:title>"));
        assert_eq!(plain("a\nb\n\nc & d"), "<p>a<br/>b</p>\n<p>c &amp; d</p>");
    }

    #[test]
    fn the_zip_begins_with_its_mimetype_stored() {
        let b = book(vec![chapter("01", "one", Words::Plain("x".into()))], vec![Entry::Page(0)]);
        let dir = std::env::temp_dir().join(format!("ringtome-epub-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let to = dir.join("b.epub");
        let files =
            vec![(chapter_file(0), page("one", "<p>x</p>").into_bytes(), "application/xhtml+xml")];
        zip_book(&b, &files, &to).unwrap();
        let bytes = std::fs::read(&to).unwrap();
        // A local file header, then the name and the content, uncompressed: what readers sniff.
        assert_eq!(&bytes[0..4], b"PK\x03\x04");
        assert_eq!(u16::from_le_bytes([bytes[8], bytes[9]]), 0, "stored, not deflated");
        assert_eq!(&bytes[30..38], b"mimetype");
        assert_eq!(&bytes[38..58], b"application/epub+zip");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn links_inside_a_book_find_their_pages() {
        let page = "ab".repeat(16);
        assert_eq!(
            post_link(&format!("/ringtome/user/x/post/{}/page/{page}", "cd".repeat(16))),
            Some(page.clone())
        );
        assert_eq!(
            post_link(&format!("https://h.example/ringtome/user/x/post/{page}?via=1")),
            Some(page)
        );
        assert_eq!(post_link("/ringtome/user/x/doc/zz"), None);
        assert_eq!(
            private_embed(
                &format!("/api/identity/{}/docs/{}/body/p.avif", "aa".repeat(32), "07".repeat(16)),
                &"aa".repeat(32)
            ),
            Some([7u8; 16])
        );
        assert_eq!(
            private_embed(
                &format!("/api/identity/{}/docs/{}/body/p.avif", "bb".repeat(32), "07".repeat(16)),
                &"aa".repeat(32)
            ),
            None
        );
        assert_eq!(download_name("My Stable: Book Two!"), "my-stable-book-two.epub");
        assert_eq!(download_name("馬"), "book.epub");
    }
}
