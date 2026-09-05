//! A notebook published as a book (BOOKS.md slice 2): the rollout.
//!
//! The Publish column writes a PLAN into the persona's private kv (`book_rollout`, keyed by
//! the bucket's name) naming the minting device; this sweep, on the author's node, carries
//! it out: every page of the bucket that is not hidden publishes through the same door a
//! hand publish uses, carrying `part_of` (the book's id) and the book's wishes, and records
//! the private version it published (`published_version`) so the column's ledger can say
//! "changed" by comparison; then the book document itself mints (or re-mints, a new version
//! of the same id) with the published tree as its payload. The book is what reaches feeds;
//! the fold keeps pages off them. Resumable: a page whose `published_version` already
//! matches its head is skipped, so a pass interrupted by a still-baking picture picks up
//! where it left off on the next beat.

use crate::record::store;
use crate::AppState;
use anyhow::{anyhow, Result};
use std::collections::{BTreeMap, BTreeSet};

pub const ROLLOUT_KV: &str = "book_rollout";
pub const BOOKS_KV: &str = "books";
pub const HIDDEN_KV: &str = "book_hidden";
pub const PUBLISHED_VERSION: &str = "published_version";

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
struct Plan {
    #[serde(default)]
    by: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    settled: bool,
    #[serde(default)]
    trusted_only: bool,
    #[serde(default)]
    total: usize,
    #[serde(default)]
    done: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    book: Option<String>,
    /// The update post this rollout minted (BOOKS.md ruling 5) - none on the first rollout,
    /// where the book itself is the announcement, and none when nothing changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    update: Option<String>,
    #[serde(default)]
    changed: usize,
    #[serde(default)]
    removed: usize,
}

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
struct BookFacts {
    #[serde(default)]
    mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    published_as_book: Option<String>,
    /// The sealing key of a trusted-only book, hex - minted at the first rollout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    key: Option<String>,
    /// True once the book document has actually been minted - the id is chosen before the
    /// pages roll out (they carry it), so "view the book" must wait for this, not the id
    /// (field-found 2026-09-04: a link to a book that did not exist yet).
    #[serde(default)]
    published: bool,
}

/// The periodic pass: every agented persona, every plan that is pending or mid-flight.
pub async fn pass(state: AppState) -> Result<()> {
    let n = rollout_due(&state, None).await?;
    if n > 0 {
        tracing::info!(rollouts = n, "book rollouts advanced");
    }
    Ok(())
}

/// Advance every pending plan this device owns, for one persona or all. Returns how many
/// plans were touched.
pub async fn rollout_due(state: &AppState, only_root: Option<&str>) -> Result<usize> {
    let roots: Vec<String> = match only_root {
        Some(r) => vec![r.to_string()],
        None => crate::identity::hosted_roots(&state.node_db).await?,
    };
    let mut touched = 0usize;
    for root in roots {
        if !crate::identity::is_agented(&state.node_db, &root).await.unwrap_or(false) {
            continue;
        }
        let data = match store::open_agented(state, &root).await {
            Ok(d) => d,
            Err(e) => {
                tracing::debug!(root = %root, error = ?e, "rollout pass: could not open");
                continue;
            }
        };
        let (plans, _) = match data.private_registers(ROLLOUT_KV).all().await {
            Ok(v) => v,
            Err(e) => {
                tracing::debug!(root = %root, error = ?e, "rollout pass: could not read plans");
                continue;
            }
        };
        let my_leaf = data.leaf_hex();
        for reg in plans {
            let Ok(mut plan) = serde_json::from_str::<Plan>(&reg.value) else { continue };
            if plan.by != my_leaf || !matches!(plan.status.as_str(), "pending" | "running" | "baking") {
                continue;
            }
            touched += 1;
            let bucket = reg.key.clone();
            match rollout(state, &data, &root, &bucket, &mut plan).await {
                Ok(()) => {}
                Err(e) => {
                    tracing::warn!(root = %root, bucket = %bucket, error = ?e, "book rollout failed");
                    plan.status = "failed".into();
                    plan.error = Some(format!("{e:#}"));
                }
            }
            if let Err(e) = data
                .private_registers(ROLLOUT_KV)
                .set(&bucket, &serde_json::to_string(&plan).unwrap_or_default())
                .await
            {
                tracing::warn!(error = ?e, "rollout plan write failed");
            }
        }
    }
    Ok(touched)
}

/// One published page or section, as the book's payload names it.
#[derive(serde::Serialize)]
struct PagePayload {
    post: String,
    title: String,
}

#[derive(serde::Serialize)]
struct SectionPayload {
    title: String,
    pages: Vec<PagePayload>,
    sections: Vec<SectionPayload>,
}

#[derive(serde::Serialize)]
struct BookPayload {
    title: String,
    sections: Vec<SectionPayload>,
    pages: Vec<PagePayload>,
}

async fn rollout(
    state: &AppState,
    data: &store::Store,
    root: &str,
    bucket: &str,
    plan: &mut Plan,
) -> Result<()> {
    // The facts: which pages, which hidden, which book.
    let view = data.documents().all().await?;
    let buckets = data.buckets().all().await?;
    // Pages are the notebook's TEXT documents. An uploaded picture filed in the notebook is
    // not a page - it rides as a twin of whichever page embeds it (field-found 2026-09-04:
    // a picture in the bucket sent the rollout through the text door, which refused it as
    // "words haven't arrived", and the rollout stuck).
    let mut in_bucket: Vec<[u8; 16]> = buckets
        .into_iter()
        .filter(|(_, names)| names.iter().any(|n| n == bucket))
        .map(|(id, _)| id)
        .filter(|id| {
            view.docs
                .get(id)
                .and_then(|d| d.display_head())
                .is_some_and(|h| crate::record::documents::Format::from_wire(h.header.format).is_mergeable_text())
        })
        .collect();
    in_bucket.sort();
    let (hidden_rows, _) = data.private_registers(HIDDEN_KV).all().await?;
    let hidden: BTreeSet<String> = hidden_rows
        .into_iter()
        .filter(|r| r.value.trim() == "yes")
        .map(|r| r.key)
        .collect();
    // The tree, for the payload's shape and for hidden-by-section.
    let root_title = format!("wiki:{bucket}");
    let roster = data.taxonomies().all().await?;
    let root_tax = roster
        .iter()
        .filter(|t| t.title == root_title)
        .map(|t| t.taxonomy_id)
        .min();
    let tree = match root_tax {
        Some(id) => Some(data.taxonomies().tree(&id).await?),
        None => None,
    };
    let titles: BTreeMap<[u8; 16], String> = view
        .docs
        .iter()
        .filter_map(|(id, d)| d.display_head().map(|h| (*id, h.header.title.clone())))
        .collect();
    let (ordered, hidden_docs) = walk_tree(tree.as_ref(), &hidden, &in_bucket);
    let pages: Vec<[u8; 16]> = in_bucket
        .iter()
        .copied()
        .filter(|id| !hidden_docs.contains(id) && !hidden.contains(&format!("doc:{}", hex::encode(id))))
        .collect();
    plan.total = pages.len();
    plan.status = "running".into();

    // The book's id: chosen before the pages, so each carries `part_of`.
    let (facts_json, _) = data.private_registers(BOOKS_KV).all().await?;
    let mut facts: BookFacts = facts_json
        .iter()
        .find(|r| r.key == bucket)
        .and_then(|r| serde_json::from_str(&r.value).ok())
        .unwrap_or_default();
    if facts.mode != "book" {
        return Err(anyhow!("this notebook is not switched to publish as a book"));
    }
    let book_id: [u8; 16] = match facts.published_as_book.as_deref().and_then(|h| hex::decode(h).ok()).and_then(|b| b.try_into().ok()) {
        Some(id) => id,
        None => {
            let id = crate::record::documents::new_doc_id();
            facts.published_as_book = Some(hex::encode(id));
            data.private_registers(BOOKS_KV)
                .set(bucket, &serde_json::to_string(&facts).unwrap_or_default())
                .await?;
            id
        }
    };
    plan.book = Some(hex::encode(book_id));
    let book_key: Option<[u8; 32]> = if plan.trusted_only {
        match facts.key.as_deref().and_then(|h| hex::decode(h).ok()).and_then(|b| <[u8; 32]>::try_from(b.as_slice()).ok()) {
            Some(k) => Some(k),
            None => {
                let mut k = [0u8; 32];
                {
                    use rand::RngCore;
                    rand::rngs::OsRng.fill_bytes(&mut k);
                }
                facts.key = Some(hex::encode(k));
                data.private_registers(BOOKS_KV)
                    .set(bucket, &serde_json::to_string(&facts).unwrap_or_default())
                    .await?;
                Some(k)
            }
        }
    } else {
        None
    };

    // What the book said last time (slice 3): the pages it named, so removed and newly hidden
    // ones can be retracted and the update can name them; none before the first rollout.
    let previous = previous_payload(state, data, &book_id, book_key).await?;
    let previous_pages: BTreeMap<String, String> = previous
        .as_ref()
        .map(|p| {
            let mut out = BTreeMap::new();
            collect_pages(p, &mut out);
            out
        })
        .unwrap_or_default();

    // The pages, through the door - skipping any whose published version is already the head.
    let mut done = 0usize;
    let mut baking = false;
    let mut changed: Vec<(String, String)> = Vec::new(); // (post hex, title) minted this pass
    let mut published: BTreeMap<[u8; 16], String> = BTreeMap::new();
    for doc_id in &pages {
        let head_hex = view
            .docs
            .get(doc_id)
            .and_then(|d| d.display_head())
            .map(|h| hex::encode(h.hash))
            .unwrap_or_default();
        let already = data.annotations().field(doc_id, PUBLISHED_VERSION).await?.unwrap_or_default();
        let post_hex = data.annotations().field(doc_id, store::PUBLISHED_AS).await?.unwrap_or_default();
        if already == head_hex && !post_hex.is_empty() {
            done += 1;
            published.insert(*doc_id, post_hex);
            continue;
        }
        let flags = crate::record::documents::PublishFlags {
            settled: plan.settled,
            trusted_only: plan.trusted_only,
            dated_ms: None,
            part_of: Some(book_id),
        };
        match crate::record::bake::publish(state, data, root, doc_id, None, flags).await? {
            crate::record::bake::Outcome::Posted(post_id) => {
                if let Err(e) = crate::identity::after_posted(state, data, root, doc_id, post_id, None, flags).await {
                    tracing::warn!(root = %root, error = ?e, "a page's after-mint duties failed; the page stands");
                }
                data.annotations().set_field(doc_id, PUBLISHED_VERSION, &head_hex).await?;
                published.insert(*doc_id, hex::encode(post_id));
                changed.push((hex::encode(post_id), titles.get(doc_id).cloned().unwrap_or_default()));
                done += 1;
                plan.done = done;
            }
            crate::record::bake::Outcome::Baking(items) => {
                if let Some(failed) = items.iter().find(|i| i.status == "failed") {
                    return Err(anyhow!(
                        "a page's media could not be prepared: {}",
                        failed.error.clone().unwrap_or_else(|| failed.source.clone())
                    ));
                }
                baking = true;
                break; // come back on the next beat; nothing half-lands, the book mints last
            }
        }
    }
    plan.done = done;
    if baking {
        plan.status = "baking".into();
        return Ok(());
    }

    // Pages the book named before and does not now - removed from the notebook, or hidden
    // since (ruling 3) - are retracted: the permalink goes, the note is a draft again, every
    // reader's journal reconciles on the fold.
    let now_published: BTreeSet<&String> = published.values().collect();
    let mut removed: Vec<String> = Vec::new();
    for (post_hex, title) in &previous_pages {
        if now_published.contains(post_hex) {
            continue;
        }
        let Some(post_id) = hex::decode(post_hex).ok().and_then(|b| <[u8; 16]>::try_from(b.as_slice()).ok()) else {
            continue;
        };
        if crate::record::documents::public_head(data.db(), &post_id).await?.is_none() {
            continue; // already gone
        }
        data.documents().retract_public(&post_id).await?;
        if let Some(note) = data.annotations().note_claiming(&post_id).await? {
            data.annotations().clear_field(&note, store::PUBLISHED_AS).await?;
            data.annotations().clear_field(&note, PUBLISHED_VERSION).await?;
        }
        removed.push(title.clone());
    }

    // The book: the tree with its pages' public ids, minted onto the book's id.
    let payload = BookPayload {
        title: bucket.to_string(),
        sections: ordered.sections.iter().map(|s| section_payload(s, &published, &titles)).collect(),
        pages: ordered
            .pages
            .iter()
            .chain(pages.iter().filter(|p| !ordered.filed.contains(*p)))
            .filter_map(|p| published.get(p).map(|post| PagePayload { post: post.clone(), title: titles.get(p).cloned().unwrap_or_default() }))
            .collect(),
    };
    let body = serde_json::to_string(&payload)?;
    let parents = crate::record::documents::public_head(data.db(), &book_id)
        .await?
        .map(|h| vec![h.head])
        .unwrap_or_default();
    let minted = crate::record::documents::save_public_text(
        data.db(),
        data.signer(),
        data.files(),
        crate::record::documents::PublicText {
            onto: Some((book_id, parents)),
            title: bucket,
            body: &body,
            format: crate::record::documents::Format::Book,
            refs: Vec::new(),
            reply: None,
            settled: plan.settled,
            trusted_only: plan.trusted_only,
            post_key: book_key,
            dated_ms: None,
            part_of: None,
        },
    )
    .await?;
    if let Some(key) = book_key {
        if let Err(e) = crate::postkeys::remember(&state.node_db, root, &hex::encode(minted), &key).await {
            tracing::warn!(error = ?e, "book key memo write failed");
        }
    }
    if !facts.published {
        facts.published = true;
        data.private_registers(BOOKS_KV)
            .set(bucket, &serde_json::to_string(&facts).unwrap_or_default())
            .await?;
    }

    // The update (ruling 5): one post per rollout after the first, threaded under the book
    // like a reply, naming the pages that changed and the ones that went. The first rollout
    // needs none - the book itself is the announcement - and a rollout that changed nothing
    // but the tree's order re-mints the book quietly.
    plan.changed = changed.len();
    plan.removed = removed.len();
    if previous.is_some() && (!changed.is_empty() || !removed.is_empty()) {
        let mut body = String::new();
        if !changed.is_empty() {
            body.push_str(&format!("{bucket} updated:\n\n"));
            for (post, title) in &changed {
                let shown = if title.is_empty() { "untitled page".to_string() } else { title.clone() };
                body.push_str(&format!("- [{shown}](/id/{root}/post/{post})\n"));
            }
        }
        if !removed.is_empty() {
            if !body.is_empty() {
                body.push('\n');
            }
            body.push_str("removed:\n\n");
            for title in &removed {
                let shown = if title.is_empty() { "untitled page".to_string() } else { title.clone() };
                body.push_str(&format!("- {shown}\n"));
            }
        }
        let root_key = crate::pubkey::decode(root).ok_or_else(|| anyhow!("bad root"))?;
        let target: crate::record::documents::ThreadTarget = (root_key, book_id);
        let update = crate::record::documents::save_public_text(
            data.db(),
            data.signer(),
            data.files(),
            crate::record::documents::PublicText {
                onto: None,
                title: &format!("{bucket} updated"),
                body: &body,
                format: crate::record::documents::Format::Marquee,
                refs: Vec::new(),
                reply: Some((target, target)),
                settled: plan.settled,
                trusted_only: plan.trusted_only,
                post_key: book_key,
                dated_ms: None,
                part_of: None,
            },
        )
        .await?;
        if let Some(key) = book_key {
            if let Err(e) = crate::postkeys::remember(&state.node_db, root, &hex::encode(update), &key).await {
                tracing::warn!(error = ?e, "update key memo write failed");
            }
        }
        plan.update = Some(hex::encode(update));
    }
    // The public lane moved: reconcile every reader's journal against the shelf now, so the
    // author's own feed read after the 200 already shows the truth (the takedown's idiom).
    let generation = crate::fold::nudge(state, root);
    crate::fold::drain(root, generation).await;
    plan.status = "done".into();
    tracing::info!(root = %root, bucket = %bucket, book = %hex::encode(minted), pages = done, "book rolled out");
    Ok(())
}

/// The tree walked for the payload: sections in order with their pages, top-level pages,
/// the set of every filed page, and the pages hidden by a hidden ancestor section.
struct Ordered {
    sections: Vec<Section>,
    pages: Vec<[u8; 16]>,
    filed: BTreeSet<[u8; 16]>,
}
struct Section {
    title: String,
    pages: Vec<[u8; 16]>,
    sections: Vec<Section>,
}

fn walk_tree(tree: Option<&store::TaxonomyNode>, hidden: &BTreeSet<String>, in_bucket: &[[u8; 16]]) -> (Ordered, BTreeSet<[u8; 16]>) {
    let mut hidden_docs = BTreeSet::new();
    let mut filed = BTreeSet::new();
    let members: BTreeSet<[u8; 16]> = in_bucket.iter().copied().collect();
    fn walk(
        node: &store::TaxonomyNode,
        under_hidden: bool,
        hidden: &BTreeSet<String>,
        members: &BTreeSet<[u8; 16]>,
        hidden_docs: &mut BTreeSet<[u8; 16]>,
        filed: &mut BTreeSet<[u8; 16]>,
        seen: &mut BTreeSet<[u8; 16]>,
    ) -> (Vec<Section>, Vec<[u8; 16]>) {
        let mut sections = Vec::new();
        let mut pages = Vec::new();
        if !seen.insert(node.taxonomy_id) {
            return (sections, pages);
        }
        let here = under_hidden || hidden.contains(&format!("sec:{}", hex::encode(node.taxonomy_id)));
        for m in node.members.as_deref().unwrap_or(&[]) {
            if let Some(sub) = &m.taxonomy {
                if sub.members.is_none() {
                    continue; // a stub: expanded elsewhere
                }
                // The CHILD's own mark decides whether it is listed (field-found 2026-09-04:
                // a hidden section stayed in the table of contents, emptied); and a section
                // with nothing to read beneath it - pictures only, or nothing - is left out.
                let child_hidden = here || hidden.contains(&format!("sec:{}", hex::encode(sub.taxonomy_id)));
                let (ss, ps) = walk(sub, child_hidden, hidden, members, hidden_docs, filed, seen);
                if !child_hidden && !(ps.is_empty() && ss.is_empty()) {
                    sections.push(Section { title: sub.title.clone(), pages: ps, sections: ss });
                }
            } else if members.contains(&m.doc_id) {
                filed.insert(m.doc_id);
                if here {
                    hidden_docs.insert(m.doc_id);
                } else {
                    pages.push(m.doc_id);
                }
            }
        }
        (sections, pages)
    }
    let (sections, pages) = match tree {
        Some(t) => walk(t, false, hidden, &members, &mut hidden_docs, &mut filed, &mut BTreeSet::new()),
        None => (Vec::new(), Vec::new()),
    };
    (Ordered { sections, pages, filed }, hidden_docs)
}

fn section_payload(s: &Section, published: &BTreeMap<[u8; 16], String>, titles: &BTreeMap<[u8; 16], String>) -> SectionPayload {
    SectionPayload {
        title: s.title.clone(),
        pages: s
            .pages
            .iter()
            .filter_map(|p| published.get(p).map(|post| PagePayload { post: post.clone(), title: titles.get(p).cloned().unwrap_or_default() }))
            .collect(),
        sections: s.sections.iter().map(|x| section_payload(x, published, titles)).collect(),
    }
}

/// The book's last published payload, if the book exists: read back through the file layer
/// (opened with the book's key when sealed) and parsed loosely - a payload this node cannot
/// read is treated as none, which only costs the removal pass its memory.
async fn previous_payload(
    state: &AppState,
    data: &store::Store,
    book_id: &[u8; 16],
    book_key: Option<[u8; 32]>,
) -> Result<Option<serde_json::Value>> {
    let Some(head) = crate::record::documents::public_head(data.db(), book_id).await? else {
        return Ok(None);
    };
    let Some(bytes) = state.files.get_public(iroh_blobs::Hash::from_bytes(head.file_hash)).await? else {
        return Ok(None);
    };
    let plain = match book_key {
        Some(key) => match crate::record::private::open_post_body(&bytes, &key) {
            Some(p) => p,
            None => return Ok(None),
        },
        None => bytes,
    };
    Ok(serde_json::from_slice::<serde_json::Value>(&plain).ok())
}

/// Every page a payload names, post hex -> title, sections walked.
fn collect_pages(node: &serde_json::Value, out: &mut BTreeMap<String, String>) {
    if let Some(pages) = node.get("pages").and_then(|p| p.as_array()) {
        for p in pages {
            if let Some(post) = p.get("post").and_then(|x| x.as_str()) {
                out.insert(post.to_string(), p.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string());
            }
        }
    }
    if let Some(sections) = node.get("sections").and_then(|s| s.as_array()) {
        for s in sections {
            collect_pages(s, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf(id: u8) -> store::TreeMember {
        store::TreeMember { root: [0u8; 32], doc_id: [id; 16], taxonomy: None }
    }
    fn section(id: u8, title: &str, members: Vec<store::TreeMember>) -> store::TreeMember {
        store::TreeMember {
            root: [0u8; 32],
            doc_id: [id; 16],
            taxonomy: Some(store::TaxonomyNode { taxonomy_id: [id; 16], title: title.into(), members: Some(members) }),
        }
    }

    #[test]
    fn a_hidden_section_is_left_out_whole_and_an_empty_one_is_not_listed() {
        let tree = store::TaxonomyNode {
            taxonomy_id: [1u8; 16],
            title: "wiki:g".into(),
            members: Some(vec![
                leaf(10),
                section(2, "chapter one", vec![leaf(11)]),
                section(3, "hidden section", vec![leaf(12), section(4, "deeper", vec![leaf(13)])]),
                section(5, "images", vec![leaf(99)]), // 99 is not a page (a picture)
                section(6, "empty", vec![]),
            ]),
        };
        let hidden: BTreeSet<String> = [format!("sec:{}", hex::encode([3u8; 16]))].into_iter().collect();
        let members: Vec<[u8; 16]> = [10u8, 11, 12, 13].iter().map(|b| [*b; 16]).collect();
        let (ordered, hidden_docs) = walk_tree(Some(&tree), &hidden, &members);
        assert_eq!(ordered.sections.iter().map(|s| s.title.as_str()).collect::<Vec<_>>(), vec!["chapter one"]);
        assert_eq!(ordered.pages, vec![[10u8; 16]]);
        assert_eq!(hidden_docs, [[12u8; 16], [13u8; 16]].into_iter().collect::<BTreeSet<_>>());
        assert!(ordered.filed.contains(&[11u8; 16]) && ordered.filed.contains(&[12u8; 16]));
    }
}
