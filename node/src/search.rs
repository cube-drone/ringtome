//! The public text search (2026-09-07): the feed and a person's page narrow to the posts
//! whose words say what you typed - the WHOLE journal, the WHOLE held shelf, not the page
//! on screen (Curtis: "the server should have every feed item it has access to back to
//! the beginning of history"). This module owns `post_search`, a token bag per public post
//! this node holds the words of, keyed by the body's blob hash: the private notes' own
//! `doc_search` idiom, node-wide. A bag is stamped with the post's update time as the
//! caller's listing carries it, so "is the stored bag current?" costs a node.db read and
//! never an author-database open - the open happens only when a body is read, inside the
//! budget (the user-db cop's rule: bounded per request, never once per persona in a loop).
//!
//! Filling is lazy and bounded, in two places. A search indexes the candidates it meets
//! whose bodies are present and not yet indexed - at most `INDEX_PER_QUERY` bodies per
//! request, newest first, so a first search over a deep journal answers in bounded time
//! and the rest match on their titles until the next pass. The slow beat (`index_pass`)
//! walks the backlog behind every reader's journal so the first search is rarely the one
//! paying. Nothing here fetches: a body that has not arrived matches on its title, never on
//! words nobody has read, and the bodies sweep brings the words when it brings them.
//!
//! Matching is prefix-by-token, every term required: "sour bread" finds "sourdough bread".

use anyhow::{Context, Result};

use crate::db::Db;
use crate::AppState;

/// Bodies a single search may read into the index before falling back to titles.
pub const INDEX_PER_QUERY: usize = 400;
/// Bodies one beat of the backlog walk indexes.
const INDEX_PER_BEAT: usize = 200;
/// Results a search returns at most - one deep page, no cursor.
pub const RESULTS_CAP: usize = 100;

/// The query's terms: lowercase alphanumeric runs, as the index tokenizes.
pub fn terms(query: &str) -> Vec<String> {
    let mut out = std::collections::BTreeSet::new();
    crate::record::documents::tokenize_into(query, &mut out);
    out.into_iter().collect()
}

/// The token bag for a title and a body, space-joined and sorted.
pub fn tokens_of(title: &str, body: &str) -> String {
    let mut out = std::collections::BTreeSet::new();
    crate::record::documents::tokenize_into(title, &mut out);
    crate::record::documents::tokenize_into(body, &mut out);
    out.into_iter().collect::<Vec<_>>().join(" ")
}

/// Every term must prefix some token.
pub fn hits(tokens: &str, terms: &[String]) -> bool {
    terms
        .iter()
        .all(|t| tokens.split(' ').any(|tok| tok.starts_with(t.as_str())))
}

/// What a listing narrows by (2026-09-07): the words, the buckets, the tags - together.
/// Buckets are OR (a post lives in one bucket, so picking two widens to either) and the
/// author's own; tags are AND (each tag narrows) and anyone's, as the cards show them; the
/// words narrow what survives. Parsed off the raw query string, since `bucket=` and `tag=`
/// repeat.
#[derive(Default, Debug)]
pub struct Narrow {
    pub terms: Vec<String>,
    pub buckets: Vec<String>,
    pub tags: Vec<String>,
}

impl Narrow {
    pub fn parse(raw_query: Option<&str>, q: Option<&str>) -> Self {
        let mut n = Narrow { terms: terms(q.unwrap_or("")), ..Default::default() };
        for (k, v) in url::form_urlencoded::parse(raw_query.unwrap_or("").as_bytes()) {
            let v = v.trim();
            if v.is_empty() {
                continue;
            }
            match &*k {
                "bucket" => n.buckets.push(v.to_string()),
                "tag" => n.tags.push(v.to_string()),
                _ => {}
            }
        }
        n
    }

    pub fn is_empty(&self) -> bool {
        self.terms.is_empty() && self.buckets.is_empty() && self.tags.is_empty()
    }

    /// The label half of the judgment, given the author's own buckets and tags on a post.
    pub fn labels_admit(&self, buckets: &[String], tags: &[String]) -> bool {
        (self.buckets.is_empty() || self.buckets.iter().any(|b| buckets.contains(b)))
            && self.tags.iter().all(|t| tags.contains(t))
    }
}

/// One candidate the caller wants judged: who, which, the title (the fallback bag), and the
/// post's update stamp as the listing knows it (the currency key).
pub struct Candidate {
    pub author_root: String,
    pub doc_hex: String,
    pub title: String,
    pub updated_ms: i64,
}

/// Where a public post's words live, if this node has them: the fragment ledger first (a
/// peek, a share), then the author's chain. Never fetches.
async fn body_facts(state: &AppState, author_hex: &str, doc_id: &[u8; 16]) -> Option<([u8; 32], Option<u64>)> {
    if let Ok(Some(h)) = crate::fragments::serving_header(&state.node_db, author_hex, doc_id).await {
        return Some((h.file_hash, h.format));
    }
    let db = state.user_dbs.get(author_hex).await.ok().flatten()?;
    let entry = crate::record::documents::public_header_entry(&db, doc_id).await.ok().flatten()?;
    let ringtome_proto::Payload::Inline(payload) = &entry.entry().payload else {
        return None;
    };
    let h = ringtome_proto::registry::DocHeaderPlain::decode(payload).ok()?;
    Some((h.file_hash, h.format))
}

async fn stored(node_db: &Db, author_hex: &str, doc_hex: &str) -> Result<Option<(i64, String)>> {
    node_db
        .fetch_optional(
            "SELECT updated_ms, tokens FROM post_search WHERE author_root = ?1 AND doc_id = ?2",
            (author_hex, doc_hex),
        )
        .await
        .context("reading the post index")
}

/// The token bag for one post: the stored one when it is current, else freshly read from
/// the body when the bytes are here (and stored), else `None` - the caller falls back to
/// the title. `budget` is the caller's remaining allowance of body reads.
async fn bag_for(state: &AppState, c: &Candidate, budget: &mut usize) -> Result<Option<String>> {
    if let Some((stamp, tokens)) = stored(&state.node_db, &c.author_root, &c.doc_hex).await? {
        if stamp == c.updated_ms {
            return Ok(Some(tokens));
        }
    }
    if *budget == 0 {
        return Ok(None);
    }
    let Ok(raw) = hex::decode(&c.doc_hex) else { return Ok(None) };
    let Ok(doc_id) = <[u8; 16]>::try_from(raw.as_slice()) else { return Ok(None) };
    let Some((hash, format)) = body_facts(state, &c.author_root, &doc_id).await else {
        return Ok(None);
    };
    let blob = iroh_blobs::Hash::from_bytes(hash);
    if !state.files.has(blob).await {
        return Ok(None);
    }
    *budget -= 1;
    // Prose only: a book's body is its table, media's is bytes; both index by title.
    let prose = matches!(
        crate::record::documents::Format::from_wire(format),
        crate::record::documents::Format::Marquee | crate::record::documents::Format::Plaintext
    );
    let body = if prose {
        state
            .files
            .get_public(blob)
            .await
            .ok()
            .flatten()
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default()
    } else {
        String::new()
    };
    let tokens = tokens_of(&c.title, &body);
    state
        .node_db
        .execute(
            "INSERT INTO post_search (author_root, doc_id, updated_ms, tokens) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(author_root, doc_id) DO UPDATE SET updated_ms = excluded.updated_ms, tokens = excluded.tokens",
            (c.author_root.as_str(), c.doc_hex.as_str(), c.updated_ms, tokens.as_str()),
        )
        .await
        .context("writing the post index")?;
    Ok(Some(tokens))
}

/// Judge `candidates` (newest first) against `narrow`: the indices of those that match, at
/// most `RESULTS_CAP`. Labels first (one memo read for the whole set), then the words -
/// indexing bodies on the way within `INDEX_PER_QUERY`, spent only on label survivors.
pub async fn matching(state: &AppState, candidates: &[Candidate], narrow: &Narrow) -> Result<Vec<usize>> {
    let labelled = if narrow.buckets.is_empty() && narrow.tags.is_empty() {
        None
    } else {
        let pairs: Vec<(String, String)> = candidates.iter().map(|c| (c.author_root.clone(), c.doc_hex.clone())).collect();
        Some(crate::annotations::for_posts(&state.node_db, &pairs).await?)
    };
    let mut budget = INDEX_PER_QUERY;
    let mut out = Vec::new();
    for (i, c) in candidates.iter().enumerate() {
        if let Some(known) = &labelled {
            let (mut buckets, mut tags) = (Vec::new(), Vec::new());
            for a in known.get(&(c.author_root.clone(), c.doc_hex.clone())).map(|v| v.as_slice()).unwrap_or(&[]) {
                match a.key.as_str() {
                    "bucket" if a.annotator == c.author_root => buckets.push(a.value.clone()),
                    "tag" => tags.push(a.value.clone()),
                    _ => {}
                }
            }
            if !narrow.labels_admit(&buckets, &tags) {
                continue;
            }
        }
        let bag = if narrow.terms.is_empty() {
            String::new()
        } else {
            match bag_for(state, c, &mut budget).await? {
                Some(b) => b,
                None => tokens_of(&c.title, ""),
            }
        };
        if hits(&bag, &narrow.terms) {
            out.push(i);
            if out.len() >= RESULTS_CAP {
                break;
            }
        }
    }
    Ok(out)
}

/// The slow beat: index the backlog behind every reader's journal, a bounded slice per pass.
pub async fn index_pass(state: AppState) -> Result<()> {
    let readers = crate::identity::hosted_roots(&state.node_db)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let mut budget = INDEX_PER_BEAT;
    for reader in readers {
        if budget == 0 {
            break;
        }
        let rows = crate::fanout::feed_all(&state.node_db, &reader, 5000).await?;
        for r in rows {
            if budget == 0 {
                break;
            }
            let c = Candidate { author_root: r.author_root, doc_hex: r.doc_id, title: r.title, updated_ms: r.updated_ms };
            let _ = bag_for(&state, &c, &mut budget).await?;
        }
    }
    Ok(())
}

/// Forget a post's bag (its author's eviction, a takedown).
pub async fn forget_author(node_db: &Db, author_hex: &str) -> Result<()> {
    node_db
        .execute("DELETE FROM post_search WHERE author_root = ?1", (author_hex,))
        .await
        .context("forgetting an author's post index")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Prefix-by-token, every term required, case-blind, punctuation ignored.
    #[test]
    fn terms_prefix_tokens_and_all_must_hit() {
        let bag = tokens_of("Bread Day", "The sourdough rose overnight; it was good.");
        assert!(hits(&bag, &terms("sour")), "a prefix hits");
        assert!(hits(&bag, &terms("BREAD rose")), "case-blind, every term");
        assert!(!hits(&bag, &terms("bread cake")), "one missing term is a miss");
        assert!(hits(&bag, &terms("")), "no terms: everything matches");
        assert_eq!(terms("  sour-dough, ROSE "), vec!["dough", "rose", "sour"]);
        assert!(terms("x").is_empty(), "a one-letter term is not a term - the box shows everything until a word");
    }

    /// Buckets widen (OR), tags narrow (AND), and the raw query string carries both.
    #[test]
    fn narrowing_parses_repeats_and_judges_labels() {
        let n = Narrow::parse(Some("bucket=feed&bucket=recipes&tag=bread&tag=slow&q=ignored%20here"), Some("Sour"));
        assert_eq!(n.buckets, vec!["feed", "recipes"]);
        assert_eq!(n.tags, vec!["bread", "slow"]);
        assert_eq!(n.terms, vec!["sour"]);
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert!(n.labels_admit(&s(&["recipes"]), &s(&["bread", "slow", "extra"])), "either bucket, every tag");
        assert!(!n.labels_admit(&s(&["recipes"]), &s(&["bread"])), "a missing tag refuses");
        assert!(!n.labels_admit(&s(&["photos"]), &s(&["bread", "slow"])), "neither bucket refuses");
        assert!(Narrow::parse(None, None).is_empty());
        assert!(Narrow::default().labels_admit(&[], &[]), "nothing picked admits everything");
    }
}
