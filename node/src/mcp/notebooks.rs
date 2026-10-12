//! Notebooks (Curtis, 2026-10-11, after an agent couldn't finish a large upload with the tools
//! alone: "a way to place a document in a bucket", "ways to arrange a bucket taxonomy"). A
//! notebook is a bucket (pure/apps.js); a Writer notebook's tree is a taxonomy titled
//! `wiki:<notebook>`, its sections taxonomies placed inside it, its pages documents placed in
//! those (js/doc/tree.js). These tools do what the notebook switcher, the notebook row and the
//! tree's drags do, through the same doors, in the same order: into a notebook before out of the
//! old one, onto a section before off the old, so a failure halfway leaves a document in two
//! places, never in none.
//!
//! The gates are the app's (UNLOCKS.md): a Writer notebook is Private notes', a sketchbook
//! nobody's; the tree - sections, and where in it a document sits - is Taxonomy & tree
//! publication's. The feed's, the files' and chat's notebooks belong to their apps, which file
//! into them themselves, so nothing is filed there by hand.

use std::collections::BTreeSet;

use axum::http::{request::Parts, Method};
use rmcp::handler::server::tool::Extension;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::{schemars, tool, tool_router, ErrorData};
use serde::Deserialize;
use serde_json::{json, Value};

use super::read::kind_of;
use super::{answer, escape, finish, stop, Answer, Tools};

/// Writer's own notebook, the one every persona has (pure/apps.js `DEFAULT_STYLE`).
pub(super) const WRITER_HOME: &str = "default";
/// The drawing app's own sketchbook.
const SKETCHBOOK_HOME: &str = "drawing";

/// What a notebook is, by the app that opens it (pure/apps.js `appTypeOf`).
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Writing,
    Drawing,
    Feed,
    Files,
    Chat,
}

impl Kind {
    fn word(self) -> &'static str {
        match self {
            Kind::Writing => "writing",
            Kind::Drawing => "drawing",
            Kind::Feed => "feed",
            Kind::Files => "files",
            Kind::Chat => "chat",
        }
    }

    /// The kind of the notebook `name`, registered to `app` (empty when unregistered): its name
    /// is its app's when it's one of theirs, else what it was registered as, else Writer's.
    fn of(name: &str, app: &str) -> Self {
        match (name, app) {
            ("chat", _) => Kind::Chat,
            ("files", _) => Kind::Files,
            ("feed", _) | (_, "feed") => Kind::Feed,
            ("drawing", _) | (_, "drawing") => Kind::Drawing,
            _ => Kind::Writing,
        }
    }
}

/// One of a persona's notebooks.
pub(super) struct Notebook {
    pub(super) name: String,
    pub(super) kind: Kind,
    documents: u64,
}

/// One place in a tree: a section, or a document in one.
struct Spot {
    id: String,
    /// The section holding it; None for the tree's own root.
    parent: Option<String>,
    section: bool,
    title: String,
}

/// Every place in a tree read (identity/routes.rs `TaxonomyResponse`), its root first. A section
/// seen twice (a stub: in two sections, or a loop two computers made) is walked once.
fn spots(tree: &Value) -> Vec<Spot> {
    fn walk(node: &Value, out: &mut Vec<Spot>, seen: &mut BTreeSet<String>) {
        let id = node.get("taxonomy_id").and_then(Value::as_str).unwrap_or_default().to_string();
        if !seen.insert(id.clone()) {
            return;
        }
        for member in node.get("members").and_then(Value::as_array).into_iter().flatten() {
            match member.get("taxonomy").filter(|t| t.is_object()) {
                Some(section) => {
                    out.push(Spot {
                        id: section
                            .get("taxonomy_id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        parent: Some(id.clone()),
                        section: true,
                        title: section
                            .get("title")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    });
                    walk(section, out, seen);
                }
                None => out.push(Spot {
                    id: member
                        .get("doc_id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    parent: Some(id.clone()),
                    section: false,
                    title: member
                        .pointer("/doc/title")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                }),
            }
        }
    }
    let mut out = vec![Spot {
        id: tree.get("taxonomy_id").and_then(Value::as_str).unwrap_or_default().to_string(),
        parent: None,
        section: true,
        title: String::new(),
    }];
    walk(tree, &mut out, &mut BTreeSet::new());
    out
}

/// The sections `id` sits in.
fn parents_of(spots: &[Spot], id: &str) -> Vec<String> {
    let parents: BTreeSet<String> =
        spots.iter().filter(|s| s.id == id).filter_map(|s| s.parent.clone()).collect();
    parents.into_iter().collect()
}

/// A section and every section inside it.
fn sections_under(spots: &[Spot], section: &str) -> BTreeSet<String> {
    let mut under = BTreeSet::from([section.to_string()]);
    loop {
        let more: Vec<String> = spots
            .iter()
            .filter(|s| s.section && !under.contains(&s.id))
            .filter(|s| s.parent.as_ref().is_some_and(|p| under.contains(p)))
            .map(|s| s.id.clone())
            .collect();
        if more.is_empty() {
            return under;
        }
        under.extend(more);
    }
}

/// The section `named` names - its id, or its title in any case when no other section shares it
/// - or "top" for the tree's top level. Anything else stops, listing the sections there are.
fn section_in(spots: &[Spot], named: &str) -> Result<String, CallToolResult> {
    let named = named.trim();
    let root = &spots[0].id;
    if named.eq_ignore_ascii_case("top") {
        return Ok(root.clone());
    }
    let sections: Vec<&Spot> = spots.iter().filter(|s| s.section && s.parent.is_some()).collect();
    if let Some(s) = sections.iter().find(|s| s.id.eq_ignore_ascii_case(named)) {
        return Ok(s.id.clone());
    }
    let titled: BTreeSet<&str> = sections
        .iter()
        .filter(|s| s.title.eq_ignore_ascii_case(named))
        .map(|s| s.id.as_str())
        .collect();
    match titled.len() {
        1 => Ok(titled.into_iter().next().unwrap_or_default().to_string()),
        0 => Err(stop(format!(
            "this notebook has no section \"{named}\". Its sections: {}. \"top\" is the top level.",
            listing(&sections)
        ))),
        _ => Err(stop(format!(
            "more than one section is called \"{named}\": say which by its id. Its sections: {}.",
            listing(&sections)
        ))),
    }
}

fn listing(sections: &[&Spot]) -> String {
    if sections.is_empty() {
        return "none yet".into();
    }
    let named: BTreeSet<String> =
        sections.iter().map(|s| format!("\"{}\" ({})", s.title, s.id)).collect();
    named.into_iter().collect::<Vec<_>>().join(", ")
}

/// Where a place is, in words: "the top" or the section's title.
fn spot_name(spots: &[Spot], id: &str) -> String {
    if spots.first().is_some_and(|root| root.id == id) {
        return "the top".into();
    }
    spots
        .iter()
        .find(|s| s.section && s.id == id)
        .map_or_else(|| id.to_string(), |s| format!("\"{}\"", s.title))
}

/// A tree read as an agent reads it: sections with what's inside them, documents with their
/// titles and kinds, in the tree's order.
fn render(node: &Value, seen: &mut BTreeSet<String>) -> Vec<Value> {
    let id = node.get("taxonomy_id").and_then(Value::as_str).unwrap_or_default().to_string();
    seen.insert(id);
    let mut out = Vec::new();
    for member in node.get("members").and_then(Value::as_array).into_iter().flatten() {
        if let Some(section) = member.get("taxonomy").filter(|t| t.is_object()) {
            let sid = section.get("taxonomy_id").and_then(Value::as_str).unwrap_or_default();
            let contents =
                if seen.contains(sid) || section.get("members").is_none_or(Value::is_null) {
                    json!("shown above")
                } else {
                    json!(render(section, seen))
                };
            out.push(json!({
                "section": sid,
                "title": section.get("title"),
                "contents": contents,
            }));
            continue;
        }
        let doc = member.get("doc").filter(|d| d.is_object());
        out.push(json!({
            "document": member.get("doc_id"),
            "title": doc.and_then(|d| d.get("title")),
            "kind": doc
                .and_then(|d| d.get("format"))
                .and_then(Value::as_str)
                .map(|f| kind_of(f).0),
        }));
    }
    out
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct NotebooksArgs {
    /// Which persona: its name, its @slug or its root. Leave it out when the account has only one.
    persona: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct NotebookArgs {
    /// Which persona: its name, its @slug or its root. Leave it out when the account has only one.
    persona: Option<String>,
    /// The notebook, by its name (list_notebooks).
    notebook: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct MakeNotebookArgs {
    /// Which persona: its name, its @slug or its root. Leave it out when the account has only one.
    persona: Option<String>,
    /// The new notebook's name.
    name: String,
    /// "writing" (a Writer notebook, the default) or "drawing" (a sketchbook).
    kind: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct FileArgs {
    /// Which persona: its name, its @slug or its root. Leave it out when the account has only one.
    persona: Option<String>,
    /// The document, by its id from list_documents.
    document: String,
    /// The notebook to put it in (or, with `remove`, take it out of).
    notebook: String,
    /// Where in the notebook's tree: a section, by its id or title from read_notebook, or "top".
    /// Leave it out to put it at the top of the tree, or leave it where it already is. Needs the
    /// "Taxonomy & tree publication" unlock.
    section: Option<String>,
    /// Its place among what's in that section, 0 first. Leave it out to put it last.
    position: Option<usize>,
    /// A notebook to take it out of as it goes in, which makes this a move. A document can be in
    /// several notebooks at once; without `from` it stays in the ones it's in.
    from: Option<String>,
    /// Take it out of `notebook` instead, and out of that notebook's tree. The document itself
    /// stays, in its other notebooks (or in Files, if it's in none).
    remove: Option<bool>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct MakeSectionArgs {
    /// Which persona: its name, its @slug or its root. Leave it out when the account has only one.
    persona: Option<String>,
    /// The Writer notebook whose tree it goes in.
    notebook: String,
    /// The section's title.
    title: String,
    /// The section to put it inside, by its id or title, or "top" (the default).
    inside: Option<String>,
    /// Its place among what's there, 0 first. Leave it out to put it last.
    position: Option<usize>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct ArrangeSectionArgs {
    /// Which persona: its name, its @slug or its root. Leave it out when the account has only one.
    persona: Option<String>,
    /// The Writer notebook whose tree it's in.
    notebook: String,
    /// The section, by its id or title from read_notebook.
    section: String,
    /// A new title for it.
    title: Option<String>,
    /// Move it inside another section (by id or title), or to "top".
    inside: Option<String>,
    /// Its place among what's in the section it's in (or moves to), 0 first.
    position: Option<usize>,
    /// Delete the section, and every section inside it. The documents in them aren't deleted:
    /// they stay in the notebook, out of the tree, until they're filed again.
    delete: Option<bool>,
}

impl Tools {
    /// The persona's notebooks, by name: each one's documents are counted, and the ones every
    /// persona has - Writer's, the sketchbook, the feed's and the files' - are there before
    /// anything is in them.
    async fn notebooks(&self, parts: &Parts, root: &str) -> Result<Vec<Notebook>, CallToolResult> {
        let roster =
            self.call(parts, Method::GET, &format!("/api/identity/{root}/buckets"), None).await?;
        let mut notebooks: Vec<Notebook> = roster
            .get("buckets")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|b| {
                let name = b.get("name").and_then(Value::as_str)?.to_string();
                let app = b.get("app").and_then(Value::as_str).unwrap_or_default();
                Some(Notebook {
                    kind: Kind::of(&name, app),
                    documents: b.get("members").and_then(Value::as_u64).unwrap_or(0),
                    name,
                })
            })
            .collect();
        for home in [WRITER_HOME, SKETCHBOOK_HOME, "feed", "files"] {
            if !notebooks.iter().any(|n| n.name == home) {
                notebooks.push(Notebook {
                    name: home.into(),
                    kind: Kind::of(home, ""),
                    documents: 0,
                });
            }
        }
        Ok(notebooks)
    }

    /// The notebook `named` names, exactly or else in any case - or a stop listing the ones there
    /// are.
    pub(super) async fn notebook(
        &self,
        parts: &Parts,
        root: &str,
        named: &str,
    ) -> Result<Notebook, CallToolResult> {
        let named = named.trim();
        let mut notebooks = self.notebooks(parts, root).await?;
        let at = notebooks.iter().position(|n| n.name == named).or_else(|| {
            let loose: Vec<usize> = (0..notebooks.len())
                .filter(|&i| notebooks[i].name.eq_ignore_ascii_case(named))
                .collect();
            (loose.len() == 1).then(|| loose[0])
        });
        match at {
            Some(i) => Ok(notebooks.swap_remove(i)),
            None => {
                let names: Vec<String> = notebooks
                    .iter()
                    .filter(|n| fileable(n).is_ok())
                    .map(|n| format!("\"{}\" ({})", n.name, n.kind.word()))
                    .collect();
                Err(stop(format!(
                    "this persona has no notebook \"{named}\". Its notebooks: {}. make_notebook \
                     makes one.",
                    names.join(", ")
                )))
            }
        }
    }

    /// A notebook's own unlock: a Writer notebook is Private notes'.
    async fn open_notebook(
        &self,
        parts: &Parts,
        root: &str,
        notebook: &Notebook,
    ) -> Result<(), CallToolResult> {
        if notebook.kind == Kind::Writing {
            self.require(parts, root, "private-notes").await?;
        }
        Ok(())
    }

    /// A notebook's tree, when it has one: the lowest-id taxonomy titled for it (js/doc/tree.js
    /// `existingTreeRoot`, which settles two computers minting it at once the same way).
    async fn tree_root(
        &self,
        parts: &Parts,
        root: &str,
        notebook: &str,
    ) -> Result<Option<String>, CallToolResult> {
        let title = format!("wiki:{notebook}");
        let all = self
            .call(parts, Method::GET, &format!("/api/identity/{root}/taxonomies"), None)
            .await?;
        Ok(all
            .get("taxonomies")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|t| t.get("title").and_then(Value::as_str) == Some(title.as_str()))
            .filter_map(|t| t.get("taxonomy_id").and_then(Value::as_str))
            .min()
            .map(str::to_string))
    }

    /// The notebook's tree, made if it has none yet (`ensureTreeRoot`).
    async fn ensure_tree(
        &self,
        parts: &Parts,
        root: &str,
        notebook: &str,
    ) -> Result<String, CallToolResult> {
        if let Some(found) = self.tree_root(parts, root, notebook).await? {
            return Ok(found);
        }
        let made = self
            .call(
                parts,
                Method::POST,
                &format!("/api/identity/{root}/taxonomies"),
                Some(json!({ "title": format!("wiki:{notebook}") })),
            )
            .await?;
        made.get("taxonomy_id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| stop("the notebook's tree wasn't made"))
    }

    async fn tree(&self, parts: &Parts, root: &str, tree: &str) -> Result<Value, CallToolResult> {
        Ok(self
            .call(parts, Method::GET, &format!("/api/identity/{root}/taxonomies/{tree}"), None)
            .await?)
    }

    /// Put `member` - a document or a section - in `into`, at `position`, and out of every other
    /// section of the tree that held it: placed first, then taken off the old, as a drag is.
    async fn place(
        &self,
        parts: &Parts,
        root: &str,
        spots: &[Spot],
        member: &str,
        into: &str,
        position: Option<usize>,
    ) -> Result<(), CallToolResult> {
        let body = match position {
            Some(index) => json!({ "index": index }),
            None => json!({}),
        };
        self.call(
            parts,
            Method::PUT,
            &format!("/api/identity/{root}/taxonomies/{into}/members/{member}"),
            Some(body),
        )
        .await?;
        for old in parents_of(spots, member).into_iter().filter(|p| p != into) {
            self.call(
                parts,
                Method::DELETE,
                &format!("/api/identity/{root}/taxonomies/{old}/members/{member}"),
                None,
            )
            .await?;
        }
        Ok(())
    }

    /// File a document into a notebook's tree: in `section` at `position` when either is given
    /// (the tree made if need be), else at the top as the app files a copy - when the notebook
    /// has a tree and the document isn't in it already. Answers where it sits, if anywhere.
    pub(super) async fn file_in_tree(
        &self,
        parts: &Parts,
        root: &str,
        notebook: &Notebook,
        document: &str,
        section: Option<&str>,
        position: Option<usize>,
    ) -> Result<Option<String>, CallToolResult> {
        if section.is_none() && position.is_none() {
            let Some(tree) = self.tree_root(parts, root, &notebook.name).await? else {
                return Ok(None);
            };
            let spots = spots(&self.tree(parts, root, &tree).await?);
            if let Some(held) = parents_of(&spots, document).first() {
                return Ok(Some(spot_name(&spots, held)));
            }
            self.place(parts, root, &spots, document, &tree, None).await?;
            return Ok(Some("the top".into()));
        }
        if notebook.kind != Kind::Writing {
            return Err(stop("only a Writer notebook has a tree of sections"));
        }
        self.require(parts, root, "taxonomy").await?;
        let tree = self.ensure_tree(parts, root, &notebook.name).await?;
        let spots = spots(&self.tree(parts, root, &tree).await?);
        let into = match section {
            Some(named) => section_in(&spots, named)?,
            // Only a place given: where it already is, or the top.
            None => parents_of(&spots, document).into_iter().next().unwrap_or(tree),
        };
        self.place(parts, root, &spots, document, &into, position).await?;
        Ok(Some(spot_name(&spots, &into)))
    }

    /// Take a document out of every section of a notebook's tree (`unfileFromTree`).
    async fn unfile(
        &self,
        parts: &Parts,
        root: &str,
        notebook: &str,
        document: &str,
    ) -> Result<(), CallToolResult> {
        let Some(tree) = self.tree_root(parts, root, notebook).await? else { return Ok(()) };
        let spots = spots(&self.tree(parts, root, &tree).await?);
        for parent in parents_of(&spots, document) {
            self.call(
                parts,
                Method::DELETE,
                &format!("/api/identity/{root}/taxonomies/{parent}/members/{document}"),
                None,
            )
            .await?;
        }
        Ok(())
    }

    async fn list_notebooks_answer(&self, parts: &Parts, args: NotebooksArgs) -> Answer {
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        let owned = self.unlocks(parts, &persona.root).await?;
        let mut notebooks = self.notebooks(parts, &persona.root).await?;
        notebooks.retain(|n| n.kind != Kind::Chat);
        notebooks.sort_by(|a, b| (a.kind.word(), &a.name).cmp(&(b.kind.word(), &b.name)));
        let shown: Vec<Value> = notebooks
            .iter()
            .filter(|n| n.kind != Kind::Writing || owned.require("private-notes").is_ok())
            .map(|n| {
                let mut row =
                    json!({ "name": n.name, "kind": n.kind.word(), "documents": n.documents });
                if n.name == WRITER_HOME {
                    row["note"] = json!("Writer's own notebook");
                } else if fileable(n).is_err() {
                    row["note"] =
                        json!("its app files into it: documents aren't filed here by hand");
                }
                row
            })
            .collect();
        answer(json!({ "notebooks": shown }))
    }

    async fn read_notebook_answer(&self, parts: &Parts, args: NotebookArgs) -> Answer {
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        let root = persona.root.as_str();
        let notebook = self.notebook(parts, root, &args.notebook).await?;
        self.open_notebook(parts, root, &notebook).await?;
        let listed = self
            .call(
                parts,
                Method::GET,
                &format!("/api/identity/{root}/docs/bucketed/{}", escape(&notebook.name)),
                None,
            )
            .await?;
        let docs = listed.get("docs").and_then(Value::as_array).cloned().unwrap_or_default();
        let row = |d: &Value| {
            json!({
                "document": d.get("doc_id"),
                "title": d.get("title"),
                "kind": kind_of(d.get("format").and_then(Value::as_str).unwrap_or_default()).0,
            })
        };
        let mut answered = json!({
            "notebook": notebook.name,
            "kind": notebook.kind.word(),
            "documents": docs.len(),
        });
        let tree = match notebook.kind {
            Kind::Writing if self.require(parts, root, "taxonomy").await.is_ok() => {
                self.tree_root(parts, root, &notebook.name).await?
            }
            Kind::Writing => {
                answered["tree"] = json!(
                    "arranging a notebook in sections needs the Taxonomy & \
                    tree publication unlock"
                );
                None
            }
            _ => None,
        };
        let Some(tree) = tree else {
            if notebook.kind == Kind::Writing && answered.get("tree").is_none() {
                answered["tree"] = json!("no sections yet: make_section starts one");
            }
            answered["contents"] = json!(docs.iter().map(row).collect::<Vec<_>>());
            return answer(answered);
        };
        let read = self.tree(parts, root, &tree).await?;
        let filed: BTreeSet<String> =
            spots(&read).into_iter().filter(|s| !s.section).map(|s| s.id).collect();
        answered["tree"] = json!(render(&read, &mut BTreeSet::new()));
        answered["unfiled"] = json!(docs
            .iter()
            .filter(|d| d
                .get("doc_id")
                .and_then(Value::as_str)
                .is_some_and(|id| !filed.contains(id)))
            .map(row)
            .collect::<Vec<_>>());
        answer(answered)
    }

    async fn make_notebook_answer(&self, parts: &Parts, args: MakeNotebookArgs) -> Answer {
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        let root = persona.root.as_str();
        let name = args.name.trim();
        if name.is_empty() {
            return Err(stop("a notebook needs a name"));
        }
        let (kind, app) = match args.kind.as_deref().map(str::trim).unwrap_or("writing") {
            "writing" | "" => (Kind::Writing, WRITER_HOME),
            "drawing" => (Kind::Drawing, SKETCHBOOK_HOME),
            other => {
                return Err(stop(format!(
                    "\"{other}\" isn't a kind of notebook: writing or drawing"
                )))
            }
        };
        if matches!(name, "chat" | "files" | "feed" | WRITER_HOME | SKETCHBOOK_HOME) {
            return Err(stop(format!(
                "\"{name}\" is kept for one of the apps - choose another name"
            )));
        }
        if kind == Kind::Writing {
            self.require(parts, root, "private-notes").await?;
        }
        if let Some(there) = self
            .notebooks(parts, root)
            .await?
            .into_iter()
            .find(|n| n.name.eq_ignore_ascii_case(name))
        {
            return Err(stop(format!("there's a notebook \"{}\" already", there.name)));
        }
        self.call(
            parts,
            Method::POST,
            &format!("/api/identity/{root}/buckets"),
            Some(json!({ "name": name, "app": app })),
        )
        .await?;
        answer(json!({ "notebook": name, "kind": kind.word(), "made": true }))
    }

    async fn file_answer(&self, parts: &Parts, args: FileArgs) -> Answer {
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        let root = persona.root.as_str();
        let document = args.document.trim();
        let doc = self
            .call(
                parts,
                Method::GET,
                &format!("/api/identity/{root}/docs/{}", escape(document)),
                None,
            )
            .await?;
        let (kind, _) = kind_of(doc.get("format").and_then(Value::as_str).unwrap_or_default());
        if matches!(kind, "room" | "book" | "other") {
            return Err(stop(format!("a {kind} isn't filed in a notebook")));
        }
        let notebook = self.notebook(parts, root, &args.notebook).await?;
        fileable(&notebook)?;
        self.open_notebook(parts, root, &notebook).await?;
        if args.remove == Some(true) {
            if args.section.is_some() || args.position.is_some() || args.from.is_some() {
                return Err(stop(
                    "`remove` takes the document out of `notebook`, and nothing else",
                ));
            }
            self.call(
                parts,
                Method::DELETE,
                &format!("/api/identity/{root}/docs/{document}/buckets/{}", escape(&notebook.name)),
                None,
            )
            .await?;
            self.unfile(parts, root, &notebook.name, document).await?;
            return answer(
                json!({ "document": document, "notebook": notebook.name, "removed": true }),
            );
        }
        // A sketchbook holds drawings, and a drawing lives in sketchbooks (the app's own move).
        if (kind == "drawing") != (notebook.kind == Kind::Drawing) {
            return Err(stop(if kind == "drawing" {
                "a drawing goes in a drawing notebook (a sketchbook)"
            } else {
                "a drawing notebook (a sketchbook) holds drawings only"
            }));
        }
        let from = match args.from.as_deref() {
            Some(named) => {
                let from = self.notebook(parts, root, named).await?;
                fileable(&from)?;
                if from.name == notebook.name {
                    return Err(stop("`from` is the notebook it's going into"));
                }
                Some(from)
            }
            None => None,
        };
        self.call(
            parts,
            Method::PUT,
            &format!("/api/identity/{root}/docs/{document}/buckets/{}", escape(&notebook.name)),
            None,
        )
        .await?;
        let mut answered = json!({ "document": document, "notebook": notebook.name });
        if let Some(from) = from {
            self.call(
                parts,
                Method::DELETE,
                &format!("/api/identity/{root}/docs/{document}/buckets/{}", escape(&from.name)),
                None,
            )
            .await?;
            self.unfile(parts, root, &from.name, document).await?;
            answered["moved_from"] = json!(from.name);
        }
        if let Some(at) = self
            .file_in_tree(parts, root, &notebook, document, args.section.as_deref(), args.position)
            .await?
        {
            answered["in_the_tree_at"] = json!(at);
        }
        answer(answered)
    }

    /// The Writer notebook a tree tool works in, its tree's places, and the tree's id - made if
    /// need be.
    async fn tree_of(
        &self,
        parts: &Parts,
        root: &str,
        named: &str,
    ) -> Result<(String, Vec<Spot>), CallToolResult> {
        let notebook = self.notebook(parts, root, named).await?;
        if notebook.kind != Kind::Writing {
            return Err(stop("only a Writer notebook has a tree of sections"));
        }
        self.require(parts, root, "private-notes").await?;
        self.require(parts, root, "taxonomy").await?;
        let tree = self.ensure_tree(parts, root, &notebook.name).await?;
        let spots = spots(&self.tree(parts, root, &tree).await?);
        Ok((notebook.name, spots))
    }

    async fn make_section_answer(&self, parts: &Parts, args: MakeSectionArgs) -> Answer {
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        let root = persona.root.as_str();
        let title = args.title.trim();
        if title.is_empty() {
            return Err(stop("a section needs a title"));
        }
        let (notebook, spots) = self.tree_of(parts, root, &args.notebook).await?;
        let into = section_in(&spots, args.inside.as_deref().unwrap_or("top"))?;
        let made = self
            .call(
                parts,
                Method::POST,
                &format!("/api/identity/{root}/taxonomies"),
                Some(json!({ "title": title })),
            )
            .await?;
        let Some(section) = made.get("taxonomy_id").and_then(Value::as_str) else {
            return Err(stop("the section wasn't made"));
        };
        self.place(parts, root, &spots, section, &into, args.position).await?;
        answer(json!({
            "section": section,
            "title": title,
            "notebook": notebook,
            "inside": spot_name(&spots, &into),
        }))
    }

    async fn arrange_section_answer(&self, parts: &Parts, args: ArrangeSectionArgs) -> Answer {
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        let root = persona.root.as_str();
        let (notebook, spots) = self.tree_of(parts, root, &args.notebook).await?;
        let section = section_in(&spots, &args.section)?;
        if section == spots[0].id {
            return Err(stop("that's the top of the tree, not a section"));
        }
        let mut answered = json!({ "section": section, "notebook": notebook });
        if args.delete == Some(true) {
            if args.title.is_some() || args.inside.is_some() || args.position.is_some() {
                return Err(stop("`delete` deletes the section, and does nothing else"));
            }
            // Unhooked first, then it and every section inside it, as the tree's own delete does.
            for parent in parents_of(&spots, &section) {
                self.call(
                    parts,
                    Method::DELETE,
                    &format!("/api/identity/{root}/taxonomies/{parent}/members/{section}"),
                    None,
                )
                .await?;
            }
            let gone = sections_under(&spots, &section);
            for id in &gone {
                self.call(
                    parts,
                    Method::DELETE,
                    &format!("/api/identity/{root}/taxonomies/{id}"),
                    None,
                )
                .await?;
            }
            answered["deleted"] = json!(gone.len());
            answered["documents"] = json!(
                "still in the notebook, out of the tree: read_notebook \
                lists them as unfiled, and file_document puts them back"
            );
            return answer(answered);
        }
        if args.title.is_none() && args.inside.is_none() && args.position.is_none() {
            return Err(stop(
                "give a new title, somewhere to move it (`inside`, `position`), or `delete`",
            ));
        }
        if let Some(title) = args.title.as_deref().map(str::trim) {
            if title.is_empty() {
                return Err(stop("a section's title can't be empty"));
            }
            self.call(
                parts,
                Method::PUT,
                &format!("/api/identity/{root}/docs/{section}/annotations/fields/title"),
                Some(json!({ "value": title })),
            )
            .await?;
            answered["title"] = json!(title);
        }
        if args.inside.is_some() || args.position.is_some() {
            let into = match args.inside.as_deref() {
                Some(named) => section_in(&spots, named)?,
                None => parents_of(&spots, &section)
                    .into_iter()
                    .next()
                    .unwrap_or_else(|| spots[0].id.clone()),
            };
            if sections_under(&spots, &section).contains(&into) {
                return Err(stop("a section can't go inside itself, or inside a section it holds"));
            }
            self.place(parts, root, &spots, &section, &into, args.position).await?;
            answered["inside"] = json!(spot_name(&spots, &into));
        }
        answer(answered)
    }
}

/// Is a document filed here by hand? Not in the feed's, the files' or chat's: their apps file
/// into them.
pub(super) fn fileable(notebook: &Notebook) -> Result<(), CallToolResult> {
    match notebook.kind {
        Kind::Writing | Kind::Drawing => Ok(()),
        _ => Err(stop(format!(
            "\"{}\" is the {} app's: it files its own documents there, and nothing else goes in",
            notebook.name,
            notebook.kind.word()
        ))),
    }
}

#[tool_router(router = notebook_tools, vis = "pub(super)")]
impl Tools {
    #[tool(
        description = "The persona's notebooks: each one's name, kind and how many documents it \
            holds. A \"writing\" notebook is Writer's and holds notes (and files put in them); a \
            \"drawing\" one is a sketchbook and holds drawings. \"default\" is Writer's own \
            notebook. A document can be in several notebooks at once.",
        annotations(title = "List notebooks", read_only_hint = true)
    )]
    async fn list_notebooks(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<NotebooksArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.list_notebooks_answer(&parts, args).await)
    }

    #[tool(
        description = "What's in a notebook. A Writer notebook can be arranged as a tree: \
            sections (each with its id, title and what's inside), and documents in them, in \
            order - and `unfiled`, what's in the notebook but not yet in the tree. Without a \
            tree, its documents.",
        annotations(title = "Read a notebook", read_only_hint = true)
    )]
    async fn read_notebook(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<NotebookArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.read_notebook_answer(&parts, args).await)
    }

    #[tool(
        description = "Make a new notebook: a Writer one (needs Private notes), or a sketchbook \
            for drawings.",
        annotations(
            title = "Make a notebook",
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false
        )
    )]
    async fn make_notebook(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<MakeNotebookArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.make_notebook_answer(&parts, args).await)
    }

    #[tool(
        description = "Put a document in a notebook - and, in a Writer notebook, somewhere in its \
            tree: a section, and a place among what's there. With `from`, it moves out of another \
            notebook as it goes in; with `remove`, it comes out of the notebook instead. Also \
            moves a document within a notebook's tree. Sections need the Taxonomy & tree \
            publication unlock.",
        annotations(
            title = "File a document",
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true
        )
    )]
    async fn file_document(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<FileArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.file_answer(&parts, args).await)
    }

    #[tool(
        description = "Make a section in a Writer notebook's tree - at the top, or inside another \
            section. file_document puts documents in it. Needs the Taxonomy & tree publication \
            unlock.",
        annotations(
            title = "Make a section",
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false
        )
    )]
    async fn make_section(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<MakeSectionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.make_section_answer(&parts, args).await)
    }

    #[tool(
        description = "Rename a section of a Writer notebook's tree, move it (inside another \
            section, or to the top, and to a place among what's there), or delete it. Deleting \
            keeps its documents: they stay in the notebook, unfiled. Needs the Taxonomy & tree \
            publication unlock.",
        annotations(
            title = "Arrange a section",
            read_only_hint = false,
            destructive_hint = true,
            idempotent_hint = false
        )
    )]
    async fn arrange_section(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<ArrangeSectionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.arrange_section_answer(&parts, args).await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> Value {
        json!({
            "taxonomy_id": "r",
            "title": "wiki:recipes",
            "members": [
                { "doc_id": "a", "doc": { "title": "Bread", "format": "marquee" }, "taxonomy": null },
                { "doc_id": "s", "doc": null, "taxonomy": {
                    "taxonomy_id": "s",
                    "title": "Soups",
                    "members": [
                        { "doc_id": "b", "doc": { "title": "Leek", "format": "marquee" }, "taxonomy": null },
                        { "doc_id": "t", "doc": null, "taxonomy": {
                            "taxonomy_id": "t", "title": "Cold", "members": [
                                { "doc_id": "a", "doc": { "title": "Bread", "format": "marquee" }, "taxonomy": null }
                            ]
                        } }
                    ]
                } },
                { "doc_id": "u", "doc": null, "taxonomy": { "taxonomy_id": "u", "title": "soups", "members": [] } }
            ]
        })
    }

    #[test]
    fn a_tree_reads_as_places_in_sections() {
        let spots = spots(&tree());
        assert_eq!(spots[0].id, "r", "the root first");
        assert_eq!(parents_of(&spots, "a"), vec!["r".to_string(), "t".to_string()], "in two");
        assert_eq!(parents_of(&spots, "t"), vec!["s".to_string()]);
        let under: Vec<String> = sections_under(&spots, "s").into_iter().collect();
        assert_eq!(under, vec!["s".to_string(), "t".to_string()]);
        assert_eq!(spot_name(&spots, "r"), "the top");
        assert_eq!(spot_name(&spots, "t"), "\"Cold\"");
    }

    #[test]
    fn a_section_is_named_by_its_id_its_title_or_top() {
        let spots = spots(&tree());
        assert_eq!(section_in(&spots, "top").ok(), Some("r".into()));
        assert_eq!(section_in(&spots, "t").ok(), Some("t".into()));
        assert_eq!(section_in(&spots, "COLD").ok(), Some("t".into()), "a title, in any case");
        assert!(section_in(&spots, "Soups").is_err(), "two are called that");
        assert!(section_in(&spots, "Salads").is_err());
    }

    #[test]
    fn a_notebook_is_the_kind_its_app_makes_it() {
        assert!(Kind::of("default", "") == Kind::Writing);
        assert!(Kind::of("drawing", "") == Kind::Drawing);
        assert!(Kind::of("horses", "drawing") == Kind::Drawing);
        assert!(Kind::of("recipes", "default") == Kind::Writing);
        assert!(Kind::of("recipes", "") == Kind::Writing, "unregistered is Writer's");
        assert!(Kind::of("files", "") == Kind::Files);
        assert!(Kind::of("feed", "") == Kind::Feed);
    }

    #[test]
    fn a_tree_renders_with_its_sections_and_what_they_hold() {
        let rendered = render(&tree(), &mut BTreeSet::new());
        assert_eq!(rendered[0]["title"], "Bread");
        assert_eq!(rendered[0]["kind"], "note");
        assert_eq!(rendered[1]["title"], "Soups");
        assert_eq!(rendered[1]["contents"][1]["contents"][0]["title"], "Bread");
    }
}
