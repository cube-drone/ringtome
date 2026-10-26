//! A notebook or a book as a zip of its pages (Curtis, 2026-10-26: the export's formats "would be
//! useful to also support ... per-notebook"): gathered as its ePub is - the same pages in the same
//! order, the same pictures, the same seals - and written as files rather than a book.
//!
//! **One folder, the book's**, holding the pages as its contents nest: a section is a folder, a
//! page a file named for its title (with its id's first eight hex where two would share a name).
//! The pictures its pages show are in `pictures/`, as they were stored (AVIF, PNG) - a drawing
//! painted. A link from one page to another, and every picture, is rewritten to the file's place,
//! relative, so the folder reads offline; a link to anything outside the book is left as written.
//!
//! - **markdown**: `.md`. **markdown.yaml**: `.md` opening on YAML front matter. **marquee**:
//!   `.mq` opening on its `:::meta`. The front matter and the `:::meta` are the full export's
//!   (export.rs). A plain-text page is `.txt` in all three, a picture page its picture file.
//! - **html**: a page `.html` each - Marquee rendered with the ePub's profile, as HTML - with an
//!   `index.html` of the contents, `style.css`, and the fonts the pages wear in `fonts/`.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::Write;
use std::path::Path;

use anyhow::{Context, Result};
use marquee_html_renderer::Output;

use super::{display, picture_bytes, plain, xml, Book, BookProfile, Chapter, Entry, Kind, Words};
use crate::export::{file_name, front_matter, meta_directive, Meta};
use crate::record::documents::Format;
use crate::AppState;

/// A zip's files, by their path inside the book's folder.
pub(super) type Files = Vec<(String, Vec<u8>)>;

/// The names at the top of the folder that are the zip's own, never a page's.
const RESERVED: &[&str] = &["pictures", "fonts", "index.html", "style.css"];

/// Where a chapter is written: the sections it is in, as folders, and its file.
#[derive(Debug, Clone, Default)]
struct Place {
    dirs: Vec<String>,
    file: String,
}

impl Place {
    fn path(&self) -> String {
        let mut path = self.dirs.join("/");
        if !path.is_empty() {
            path.push('/');
        }
        path.push_str(&self.file);
        path
    }

    /// The way back up to the book's folder, from this page's.
    fn up(&self) -> String {
        "../".repeat(self.dirs.len())
    }
}

/// A chapter's file ending, made as `kind`.
fn ending(c: &Chapter, kind: Kind) -> &'static str {
    match (&c.words, kind) {
        (_, Kind::Html) => "html",
        (Words::Marquee(_), Kind::Marquee) => "mq",
        (Words::Marquee(_), _) => "md",
        (Words::Plain(_), _) => "txt",
        (Words::Drawing(_), _) => "png",
        (Words::Picture(_), _) => picture_ending(c.format),
    }
}

fn picture_ending(format: Format) -> &'static str {
    match format {
        Format::Avif => "avif",
        _ => "png",
    }
}

/// Every chapter's place: the contents walked, each section a folder, each page named for its
/// title - and, where a name in that folder is taken already, its id's first eight hex after it.
fn places(book: &Book, kind: Kind) -> Vec<Place> {
    fn walk(
        book: &Book,
        kind: Kind,
        entries: &[Entry],
        dirs: &mut Vec<String>,
        taken: &mut HashSet<String>,
        out: &mut [Option<Place>],
    ) {
        for e in entries {
            match e {
                Entry::Page(i) => {
                    let Some(c) = book.chapters.get(*i) else { continue };
                    if out[*i].is_some() {
                        continue;
                    }
                    let place = |file: String| Place { dirs: dirs.clone(), file };
                    let end = ending(c, kind);
                    let base = file_name(&display(&c.title));
                    let mut chosen = place(format!("{base}.{end}"));
                    if !taken.insert(chosen.path().to_lowercase()) {
                        chosen = place(format!("{base}--{}.{end}", &c.id[..8.min(c.id.len())]));
                        taken.insert(chosen.path().to_lowercase());
                    }
                    out[*i] = Some(chosen);
                }
                Entry::Section { title, entries } => {
                    dirs.push(file_name(&display(title)));
                    walk(book, kind, entries, dirs, taken, out);
                    dirs.pop();
                }
            }
        }
    }
    let mut out: Vec<Option<Place>> = vec![None; book.chapters.len()];
    let mut taken: HashSet<String> = RESERVED.iter().map(|r| r.to_string()).collect();
    walk(book, kind, &book.contents, &mut Vec::new(), &mut taken, &mut out);
    // A chapter the contents never reach (none should be) still has a place: the top.
    let contents = Entry::Section {
        title: String::new(),
        entries: (0..book.chapters.len()).filter(|i| out[*i].is_none()).map(Entry::Page).collect(),
    };
    if let Entry::Section { entries, .. } = &contents {
        walk(book, kind, entries, &mut Vec::new(), &mut taken, &mut out);
    }
    out.into_iter().map(Option::unwrap_or_default).collect()
}

/// A path inside the folder as a link writes it: each byte a URL may not carry bare, escaped -
/// a space in a title would end a Markdown link's target.
fn href(path: &str) -> String {
    let mut out = String::new();
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b'/') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Marquee source with its links and pictures sent elsewhere: every target the parser reads as a
/// link or an embed that `to` has a place for, rewritten where it is written (`](target)`).
fn retarget(source: &str, to: &dyn Fn(&str) -> Option<String>) -> String {
    let Ok(doc) = marquee_parser::parse(source) else { return source.to_string() };
    let mut targets: Vec<String> = Vec::new();
    crate::record::bake::each_embed(&doc, &mut |t| {
        if !targets.iter().any(|have| have == t) {
            targets.push(t.to_string());
        }
    });
    for link in crate::record::bake::doc_links(source, "") {
        if !targets.contains(&link.to) {
            targets.push(link.to);
        }
    }
    let mut out = source.to_string();
    for target in targets {
        if let Some(new) = to(&target) {
            out = out.replace(&format!("]({target})"), &format!("]({new})"));
        }
    }
    out
}

/// What a page's front matter or `:::meta` says of it: the full export's fields, and the notebook
/// it came from (a public book's pages name none).
fn meta(book: &Book, c: &Chapter) -> Meta {
    Meta {
        id: c.id.clone(),
        head: Some(c.head.clone()),
        title: c.title.clone(),
        format: c.format,
        created_ms: c.created_ms,
        updated_ms: c.updated_ms,
        tags: c.tags.clone(),
        buckets: if book.public { Vec::new() } else { vec![book.title.clone()] },
        fields: Default::default(),
    }
}

/// One HTML page: its title, the way back to the contents, and the stylesheet the folder shares.
fn html_page(title: &str, up: &str, body: &str) -> String {
    format!(
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <title>{t}</title>\n<link rel=\"stylesheet\" href=\"{up}style.css\">\n</head>\n\
         <body>\n<div class=\"mq-envelope\">\n{body}\n</div>\n</body>\n</html>\n",
        t = xml(title)
    )
}

/// A page's own heading, under the way back to the contents.
fn html_chapter(title: &str, up: &str, inner: &str) -> String {
    let body = format!(
        "<p class=\"book-up\"><a href=\"{up}index.html\">{}</a></p>\n<h1>{}</h1>\n{inner}",
        xml("↑ contents"),
        xml(title)
    );
    html_page(title, up, &body)
}

/// `index.html`: the title, the author, and the contents nested as the folders nest.
fn index(book: &Book, places: &[Place]) -> String {
    fn list(book: &Book, places: &[Place], entries: &[Entry]) -> String {
        let mut out = String::from("<ol>\n");
        for e in entries {
            match e {
                Entry::Page(i) => out.push_str(&format!(
                    "<li><a href=\"{}\">{}</a></li>\n",
                    xml(&href(&places[*i].path())),
                    xml(&display(&book.chapters[*i].title))
                )),
                Entry::Section { title, entries } => out.push_str(&format!(
                    "<li><span>{}</span>\n{}</li>\n",
                    xml(&display(title)),
                    list(book, places, entries)
                )),
            }
        }
        out.push_str("</ol>");
        out
    }
    let body = format!(
        "<h1>{}</h1>\n<p class=\"book-author\">{}</p>\n<nav>\n{}\n</nav>",
        xml(&book.title),
        xml(&book.author),
        list(book, places, &book.contents)
    );
    html_page(&book.title, "", &body)
}

/// `style.css`: Marquee's own, the readable column a page sits in, and the faces the pages wear.
fn stylesheet(fonts: &[String]) -> String {
    format!(
        ":root {{ color-scheme: light dark; }}\nbody {{ margin: 0; }}\n{}\n{}\n{}\n\
         img {{ max-width: 100%; height: auto; }}\nfigure {{ margin: 1em 0; text-align: center; }}\n\
         .book-up {{ font-size: 0.9em; }}\n.book-author {{ font-style: italic; }}\n{}\n",
        marquee_markup::MARQUEE_CSS,
        marquee_markup::ENVELOPE_CSS,
        marquee_markup::readability_css(None),
        marquee_markup::external_font_faces(fonts, "fonts/"),
    )
}

/// Make the zip's files: every picture read as it was stored, every page written as `kind` with
/// its links and pictures pointing into the folder.
pub(super) async fn make(
    state: &AppState,
    data: Option<&crate::record::store::Store>,
    book: &Book,
    kind: Kind,
    progress: &(dyn Fn(usize) + Sync),
) -> Result<Files> {
    let mut steps = 0usize;
    let mut step = || {
        steps += 1;
        progress(steps);
    };
    let places = places(book, kind);
    let mut files: Files = Vec::new();
    // The pictures first, so every page knows where its pictures are.
    let mut picture_at: HashMap<String, String> = HashMap::new();
    let mut made: HashMap<String, String> = HashMap::new();
    for p in &book.pictures {
        step();
        if let Some(path) = made.get(&p.doc) {
            picture_at.insert(p.target.clone(), path.clone());
            continue;
        }
        let Some(bytes) = picture_bytes(state, data, book, p.file_hash, p.key).await? else {
            continue;
        };
        let (bytes, end) = if p.format == Format::Drawing {
            let Some(data) = data else { continue };
            let width = crate::drawing_paint::twice_its_width(&crate::drawing::read(&bytes));
            match crate::drawing_paint::png(data, &bytes, Some(width)).await {
                Some(png) => (png, "png"),
                None => continue,
            }
        } else {
            (bytes, picture_ending(p.format))
        };
        let path = format!("pictures/{}.{end}", p.doc);
        files.push((path.clone(), bytes));
        made.insert(p.doc.clone(), path.clone());
        picture_at.insert(p.target.clone(), path);
    }
    let mut fonts: BTreeSet<String> = BTreeSet::new();
    for (i, c) in book.chapters.iter().enumerate() {
        step();
        let place = &places[i];
        let up = place.up();
        let title = display(&c.title);
        // From this page: another page's file, or a picture's.
        let to_page = |target: &str| {
            book.chapter_for(target).map(|j| format!("{up}{}", href(&places[j].path())))
        };
        let to_picture = |target: &str| picture_at.get(target).map(|p| format!("{up}{}", href(p)));
        let bytes = match (&c.words, kind) {
            (Words::Marquee(source), Kind::Html) => {
                let pictures: HashMap<String, String> = picture_at
                    .iter()
                    .map(|(target, p)| (target.clone(), format!("{up}{}", href(p))))
                    .collect();
                let profile = BookProfile { pictures: &pictures, chapters: &to_page };
                let inner =
                    marquee_html_renderer::render_marquee_with(source, &profile, Output::Html)
                        .unwrap_or_else(|_| plain(source));
                fonts.extend(marquee_html_renderer::used_font_tokens(&inner));
                html_chapter(&title, &up, &inner).into_bytes()
            }
            (Words::Marquee(source), _) => {
                let source = retarget(source, &|t: &str| to_picture(t).or_else(|| to_page(t)));
                match kind {
                    Kind::Marquee => {
                        format!("{}\n\n{source}", meta_directive(&meta(book, c))).into_bytes()
                    }
                    _ => {
                        let markdown = marquee_markdown::to_markdown(&source)
                            .unwrap_or_else(|_| source.clone());
                        if kind == Kind::MarkdownYaml {
                            format!("{}{markdown}", front_matter(&meta(book, c))).into_bytes()
                        } else {
                            markdown.into_bytes()
                        }
                    }
                }
            }
            (Words::Plain(text), Kind::Html) => {
                html_chapter(&title, &up, &plain(text)).into_bytes()
            }
            (Words::Plain(text), Kind::MarkdownYaml) => {
                format!("{}{text}", front_matter(&meta(book, c))).into_bytes()
            }
            (Words::Plain(text), _) => text.clone().into_bytes(),
            (Words::Drawing(_) | Words::Picture(_), _) => {
                let picture = match &c.words {
                    Words::Drawing(body) => {
                        let Some(data) = data else { continue };
                        let width =
                            crate::drawing_paint::twice_its_width(&crate::drawing::read(body));
                        match crate::drawing_paint::png(data, body, Some(width)).await {
                            Some(png) => png,
                            None => continue,
                        }
                    }
                    Words::Picture(bytes) => bytes.clone(),
                    _ => continue,
                };
                if kind != Kind::Html {
                    picture
                } else {
                    // The picture beside the others, and a page that shows it.
                    let end = if matches!(c.words, Words::Drawing(_)) {
                        "png"
                    } else {
                        picture_ending(c.format)
                    };
                    let path = format!("pictures/{}.{end}", c.id);
                    files.push((path.clone(), picture));
                    let inner = format!(
                        "<figure><img src=\"{}\" alt=\"{}\"></figure>",
                        xml(&format!("{up}{}", href(&path))),
                        xml(&title)
                    );
                    html_chapter(&title, &up, &inner).into_bytes()
                }
            }
        };
        files.push((place.path(), bytes));
    }
    if kind == Kind::Html {
        let fonts: Vec<String> = fonts.into_iter().collect();
        for token in &fonts {
            if let Some(bytes) = marquee_markup::font_bytes(token) {
                files.push((format!("fonts/{token}.woff2"), bytes.to_vec()));
            }
        }
        files.push(("style.css".to_string(), stylesheet(&fonts).into_bytes()));
        files.push(("index.html".to_string(), index(book, &places).into_bytes()));
    }
    // Everything inside the book's own folder, so the zip opens to one.
    let folder = file_name(&display(&book.title));
    Ok(files.into_iter().map(|(path, bytes)| (format!("{folder}/{path}"), bytes)).collect())
}

/// Write the zip: pictures and fonts as they are (compressing them again gains nothing), the
/// words deflated.
pub(super) fn write(files: &Files, to: &Path) -> Result<()> {
    let file = std::fs::File::create(to).with_context(|| format!("creating {}", to.display()))?;
    let mut zip = zip::ZipWriter::new(std::io::BufWriter::new(file));
    let stored =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let deflated = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (path, bytes) in files {
        let packed = [".avif", ".png", ".woff2"].iter().any(|e| path.ends_with(e));
        zip.start_file(path.as_str(), if packed { stored } else { deflated })?;
        zip.write_all(bytes)?;
    }
    zip.finish()?.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chapter(id: &str, title: &str, words: Words) -> Chapter {
        Chapter {
            id: id.repeat(16),
            head: "00".repeat(32),
            title: title.into(),
            words,
            key: None,
            format: Format::Marquee,
            created_ms: 0,
            updated_ms: 0,
            tags: vec!["horses".into()],
        }
    }

    fn book(chapters: Vec<Chapter>, contents: Vec<Entry>) -> Book {
        let chapter_of = chapters.iter().enumerate().map(|(i, c)| (c.id.clone(), i)).collect();
        Book {
            title: "The Stable".into(),
            author: "Ada".into(),
            identity: "urn:hdt2:test".into(),
            chapters,
            contents,
            pictures: Vec::new(),
            root: "aa".repeat(32),
            public: false,
            chapter_of,
            sealed: false,
        }
    }

    #[test]
    fn pages_are_named_for_their_titles_in_their_sections_folders() {
        let b = book(
            vec![
                chapter("01", "JEFF KAPLAN", Words::Marquee("hi".into())),
                chapter("02", "jeff kaplan", Words::Marquee("namesake".into())),
                chapter("03", "a/b: c?", Words::Plain("plain".into())),
                chapter("04", "", Words::Marquee("".into())),
                chapter("05", "index", Words::Marquee("".into())),
            ],
            vec![
                Entry::Page(0),
                Entry::Page(1),
                Entry::Section {
                    title: "People: Old".into(),
                    entries: vec![Entry::Page(2), Entry::Page(3)],
                },
                Entry::Page(4),
            ],
        );
        let md: Vec<String> = places(&b, Kind::Markdown).iter().map(Place::path).collect();
        assert_eq!(
            md,
            [
                "JEFF KAPLAN.md",
                "jeff kaplan--02020202.md",
                "People- Old/a-b- c-.txt",
                "People- Old/untitled.md",
                "index.md",
            ]
        );
        let html: Vec<String> = places(&b, Kind::Html).iter().map(Place::path).collect();
        assert_eq!(html[4], "index--05050505.html", "the contents page keeps its name");
        assert_eq!(places(&b, Kind::Marquee)[0].file, "JEFF KAPLAN.mq");
        assert_eq!(places(&b, Kind::Html)[2].up(), "../");
    }

    #[test]
    fn links_and_pictures_point_into_the_folder_and_nowhere_else_changes() {
        let source = "See [Jeff](/home/notes/0101) and [out](https://e.x/a). ![p](/pic/1)\n\n`](/home/notes/0101)`";
        let to = |t: &str| match t {
            "/home/notes/0101" => Some(format!("../{}", href("JEFF KAPLAN.md"))),
            "/pic/1" => Some("pictures/p.avif".to_string()),
            _ => None,
        };
        let out = retarget(source, &to);
        assert!(
            out.starts_with("See [Jeff](../JEFF%20KAPLAN.md) and [out](https://e.x/a)."),
            "{out}"
        );
        assert!(out.contains("![p](pictures/p.avif)"), "{out}");
    }

    #[test]
    fn a_path_escapes_what_a_link_cant_carry() {
        assert_eq!(href("People- Old/a b.md"), "People-%20Old/a%20b.md");
        assert_eq!(href("馬.md"), "%E9%A6%AC.md");
    }

    #[test]
    fn the_contents_page_links_every_page_where_it_is() {
        let b = book(
            vec![
                chapter("01", "One & Two", Words::Marquee("x".into())),
                chapter("02", "Deep", Words::Marquee("y".into())),
            ],
            vec![
                Entry::Page(0),
                Entry::Section { title: "Inner".into(), entries: vec![Entry::Page(1)] },
            ],
        );
        let page = index(&b, &places(&b, Kind::Html));
        assert!(page.contains("<a href=\"One%20%26%20Two.html\">One &amp; Two</a>"), "{page}");
        assert!(page.contains("<span>Inner</span>"), "{page}");
        assert!(page.contains("<a href=\"Inner/Deep.html\">Deep</a>"), "{page}");
    }
}
