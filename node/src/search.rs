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
//!
//! Sealed posts (2026-09-07, the NEXT_STEPS residual): a trusted-only body opens with the
//! post key the node holds in its key memo - the author's own at mint, a trusted reader's
//! once the key lane brought it - and indexes like any other; never fetched here. Without
//! the key the post matches on its title and nothing is STORED, so the bag is not frozen
//! title-only when the key arrives later. The bag in node.db says no more than the key
//! memo beside it already lets the node say, and the sealed rule on every listing keeps
//! a post an untrusted viewer may not see out of their results.

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

/// How many distinct words a post's index entry holds - 0 for a post not indexed (yet): the oats'
/// signal, hrseCommodities (commodities.rs, 2026-10-06). Distinct, as the index keeps them: a post
/// that says one word fifty times is one word, as the bank's own shingles would have it.
pub async fn distinct_words(node_db: &Db, author_root: &str, doc_id: &str) -> Result<i64> {
    let row: Option<(String,)> = node_db
        .fetch_optional(
            "SELECT tokens FROM post_search WHERE author_root = ?1 AND doc_id = ?2",
            (author_root, doc_id),
        )
        .await
        .context("reading a post's indexed words")?;
    Ok(row.map_or(0, |(t,)| t.split(' ').filter(|w| !w.is_empty()).count() as i64))
}

/// Every term must prefix some token.
pub fn hits(tokens: &str, terms: &[String]) -> bool {
    terms.iter().all(|t| tokens.split(' ').any(|tok| tok.starts_with(t.as_str())))
}

/// What a listing narrows by (2026-09-07): the words, the buckets, the tags, the kinds.
/// Every row works the same way (Curtis, 2026-10-01: a chip is three-state - left alone, "only",
/// "leave out"): within a row the "only" picks widen to EITHER (OR - a post is any of the kinds
/// picked, in any of the buckets, under any of the tags), the "leave out" picks drop whatever
/// carries one, and the rows narrow together. Buckets are the author's own; tags are anyone's,
/// as the cards show them; the words narrow what survives. Parsed off the raw query string,
/// since every key repeats: `kind=`, `bucket=`, `tag=` for "only", and `not_kind=`,
/// `not_bucket=`, `not_tag=` for "leave out".
#[derive(Default, Debug, Clone)]
pub struct Narrow {
    pub terms: Vec<String>,
    pub buckets: Vec<String>,
    pub tags: Vec<String>,
    /// The kind row (2026-09-08): `post`, `reply`, `rebroadcast`, `book`, `room`.
    pub kinds: Vec<String>,
    pub not_buckets: Vec<String>,
    pub not_tags: Vec<String>,
    pub not_kinds: Vec<String>,
}

/// The tag families, each its own row on the strip (Curtis, 2026-10-02): a post's SIZE (`micro`
/// through `long`), its MEDIA (`audio`, `image`, `video`), and every other tag. They are rows like
/// any others: picks widen within a family and the families narrow together - "micro" and
/// "image" is a short picture post, not either. Sizes and media are the implicit tags
/// (`documents::IMPLICIT_TAGS`), every post wears at most one size, so they read best this way.
pub const SIZE_TAGS: [&str; 4] = ["micro", "short", "medium", "long"];
pub const MEDIA_TAGS: [&str; 3] = ["audio", "image", "video"];

/// Which family a tag is: 0 for the ordinary tags, 1 a size, 2 a medium.
pub fn tag_family(tag: &str) -> usize {
    if SIZE_TAGS.contains(&tag) {
        1
    } else if MEDIA_TAGS.contains(&tag) {
        2
    } else {
        0
    }
}

/// The kinds a row can be, in the row's fixed order; a post is what is none of the others.
pub const KINDS: [&str; 5] = ["post", "reply", "rebroadcast", "book", "room"];

/// The kind row's counts over a set of kinds, in the fixed order, the absent left out.
pub fn kind_counts<'a>(kinds: impl Iterator<Item = &'a str>) -> Vec<(String, i64)> {
    let mut n = [0i64; 5];
    for k in kinds {
        if let Some(i) = KINDS.iter().position(|x| *x == k) {
            n[i] += 1;
        }
    }
    KINDS.iter().zip(n).filter(|(_, c)| *c > 0).map(|(k, c)| (k.to_string(), c)).collect()
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
                "kind" if KINDS.contains(&v) => n.kinds.push(v.to_string()),
                "not_bucket" => n.not_buckets.push(v.to_string()),
                "not_tag" => n.not_tags.push(v.to_string()),
                "not_kind" if KINDS.contains(&v) => n.not_kinds.push(v.to_string()),
                _ => {}
            }
        }
        n
    }

    pub fn is_empty(&self) -> bool {
        self.terms.is_empty() && !self.picks_any()
    }

    /// Whether any chip is picked, either way.
    pub fn picks_any(&self) -> bool {
        self.picks_labels() || !self.kinds.is_empty() || !self.not_kinds.is_empty()
    }

    /// Whether the judgment needs the posts' labels: a bucket or tag picked, either way.
    pub fn picks_labels(&self) -> bool {
        !(self.buckets.is_empty()
            && self.tags.is_empty()
            && self.not_buckets.is_empty()
            && self.not_tags.is_empty())
    }

    /// The kind half of the judgment.
    pub fn kinds_admit(&self, kind: &str) -> bool {
        (self.kinds.is_empty() || self.kinds.iter().any(|k| k == kind))
            && !self.not_kinds.iter().any(|k| k == kind)
    }

    /// Words and labels judge posts only; a share has neither, so it answers the kind
    /// row alone - and a label left out is one a share doesn't carry, so it stays.
    pub fn only_kinds(&self) -> bool {
        self.terms.is_empty() && self.buckets.is_empty() && self.tags.is_empty()
    }

    /// The label half of the judgment, given the author's own buckets and tags on a post.
    pub fn labels_admit(&self, buckets: &[String], tags: &[String]) -> bool {
        (self.buckets.is_empty() || self.buckets.iter().any(|b| buckets.contains(b)))
            && (0..3).all(|family| {
                let mut picked = self.tags.iter().filter(|t| tag_family(t) == family).peekable();
                picked.peek().is_none() || picked.any(|t| tags.contains(t))
            })
            && !self.not_buckets.iter().any(|b| buckets.contains(b))
            && !self.not_tags.iter().any(|t| tags.contains(t))
    }
}

/// One candidate the caller wants judged: who, which, the title (the fallback bag), and the
/// post's update stamp as the listing knows it (the currency key).
pub struct Candidate {
    pub author_root: String,
    pub doc_hex: String,
    pub title: String,
    pub updated_ms: i64,
    /// One of `KINDS`.
    pub kind: &'static str,
}

/// Where a public post's words live, if this node has them: the fragment ledger first (a
/// peek, a share), then the author's chain. Never fetches.
struct BodyFacts {
    file_hash: [u8; 32],
    format: Option<u64>,
    trusted_only: bool,
    /// A sealed post's title, sealed under the post key (PROJECT_PLAN's Replies under the
    /// author's seal, ruling 5): indexed with the words, for the readers who have both.
    sealed_title: Option<Vec<u8>>,
}

async fn body_facts(state: &AppState, author_hex: &str, doc_id: &[u8; 16]) -> Option<BodyFacts> {
    if let Ok(Some(h)) = crate::fragments::serving_header(&state.node_db, author_hex, doc_id).await
    {
        return Some(BodyFacts {
            file_hash: h.file_hash,
            format: h.format,
            trusted_only: h.trusted_only,
            sealed_title: h.sealed_title,
        });
    }
    let db = state.user_dbs.get(author_hex).await.ok().flatten()?;
    let entry = crate::record::documents::public_header_entry(&db, doc_id).await.ok().flatten()?;
    let ringtome_proto::Payload::Inline(payload) = &entry.entry().payload else {
        return None;
    };
    let h = ringtome_proto::registry::DocHeaderPlain::decode(payload).ok()?;
    Some(BodyFacts {
        file_hash: h.file_hash,
        format: h.format,
        trusted_only: h.trusted_only,
        sealed_title: h.sealed_title,
    })
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
    let kept = stored(&state.node_db, &c.author_root, &c.doc_hex).await?;
    if let Some((stamp, tokens)) = &kept {
        if *stamp == c.updated_ms {
            return Ok(Some(tokens.clone()));
        }
    }
    // Never indexed: the title's words go in at once, stamped 0 so the body's still wanted - a
    // search finds the post by its title until its words are read (2026-09-28: the index is what a
    // search asks now, so a post not in it is a post no search finds).
    if kept.is_none() {
        keep_bag(&state.node_db, c, 0, &tokens_of(&c.title, "")).await?;
    }
    if *budget == 0 {
        return Ok(None);
    }
    let Ok(raw) = hex::decode(&c.doc_hex) else { return Ok(None) };
    let Ok(doc_id) = <[u8; 16]>::try_from(raw.as_slice()) else { return Ok(None) };
    let Some(BodyFacts { file_hash: hash, format, trusted_only, sealed_title }) =
        body_facts(state, &c.author_root, &doc_id).await
    else {
        return Ok(None);
    };
    let blob = iroh_blobs::Hash::from_bytes(hash);
    if !state.files.has(blob).await {
        return Ok(None);
    }
    // A sealed body needs the post key the node holds; without it, the title stands and
    // nothing is stored (the key may arrive later, and the stamp would not move).
    let key = if trusted_only {
        match crate::postkeys::lookup(&state.node_db, &c.author_root, &c.doc_hex).await? {
            Some(k) => Some(k),
            None => return Ok(None),
        }
    } else {
        None
    };
    *budget -= 1;
    // Prose only: a book's body is its table, media's is bytes; both index by title.
    let prose = matches!(
        crate::record::documents::Format::from_wire(format),
        crate::record::documents::Format::Marquee | crate::record::documents::Format::Plaintext
    );
    let body = if prose {
        let raw = state.files.get_public(blob).await.ok().flatten().unwrap_or_default();
        let plain = match key {
            Some(k) => crate::record::private::open_post_body(&raw, &k).unwrap_or_default(),
            None => raw,
        };
        String::from_utf8_lossy(&plain).into_owned()
    } else {
        String::new()
    };
    // A sealed post's title is sealed too: index it beside the words, for the node that
    // holds the key (ruling 5).
    let title = match (&key, &sealed_title) {
        (Some(k), Some(sealed)) => crate::record::private::open_post_body(sealed, k)
            .and_then(|t| String::from_utf8(t).ok())
            .unwrap_or_else(|| c.title.clone()),
        _ => c.title.clone(),
    };
    let tokens = tokens_of(&title, &body);
    keep_bag(&state.node_db, c, c.updated_ms, &tokens).await?;
    Ok(Some(tokens))
}

/// Keep one post's word bag, stamped (0 for a title alone), and its terms - the inverted index a
/// search reads (node rung 0059): the post's old terms go and its new ones come, together.
async fn keep_bag(db: &Db, c: &Candidate, stamp: i64, tokens: &str) -> Result<()> {
    db.execute(
        "INSERT INTO post_search (author_root, doc_id, updated_ms, tokens) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(author_root, doc_id) DO UPDATE SET updated_ms = excluded.updated_ms, tokens = excluded.tokens",
        (c.author_root.as_str(), c.doc_hex.as_str(), stamp, tokens),
    )
    .await
    .context("writing the post index")?;
    db.execute(
        "DELETE FROM post_terms WHERE author_root = ?1 AND doc_id = ?2",
        (c.author_root.as_str(), c.doc_hex.as_str()),
    )
    .await
    .context("clearing a post's terms")?;
    let terms: Vec<&str> = tokens.split(' ').filter(|t| !t.is_empty()).collect();
    for chunk in terms.chunks(200) {
        let rows = chunk.iter().map(|_| "(?, ?, ?)").collect::<Vec<_>>().join(", ");
        let params: Vec<turso::Value> = chunk
            .iter()
            .flat_map(|t| {
                [
                    turso::Value::Text(t.to_string()),
                    turso::Value::Text(c.author_root.clone()),
                    turso::Value::Text(c.doc_hex.clone()),
                ]
            })
            .collect();
        db.execute(
            &format!("INSERT OR IGNORE INTO post_terms (term, author_root, doc_id) VALUES {rows}"),
            turso::params_from_iter(params),
        )
        .await
        .context("writing a post's terms")?;
    }
    Ok(())
}

/// The posts whose words hold every one of `terms` (each a prefix of some word - `hits`' rule),
/// off the inverted index - when the rarest term names at most `cap` posts; `None` when every
/// term is commoner than that, and walking the feed newest first is the cheaper road. Node-wide:
/// the caller meets it with the reader's journal.
pub async fn posts_with_terms(
    db: &Db,
    terms: &[String],
    cap: usize,
) -> Result<Option<std::collections::HashSet<(String, String)>>> {
    if terms.is_empty() {
        return Ok(None);
    }
    // The rarest term first: each counted up to cap + 1, off the index's range.
    let mut rarest: Option<(usize, Vec<(String, String)>)> = None;
    for t in terms {
        let hi = format!("{t}\u{10FFFF}");
        let posts: Vec<(String, String)> = db
            .fetch_all(
                "SELECT DISTINCT author_root, doc_id FROM post_terms WHERE term >= ?1 AND term < ?2 LIMIT ?3",
                (t.as_str(), hi.as_str(), cap as i64 + 1),
            )
            .await
            .context("reading a term's posts")?;
        if posts.len() <= cap && rarest.as_ref().is_none_or(|(n, _)| posts.len() < *n) {
            rarest = Some((posts.len(), posts));
        }
    }
    let Some((_, posts)) = rarest else { return Ok(None) };
    // Every other term, asked of each of those posts' own terms.
    let mut out = std::collections::HashSet::new();
    'post: for (a, d) in posts {
        for t in terms {
            let hi = format!("{t}\u{10FFFF}");
            let hit: Option<(i64,)> = db
                .fetch_optional(
                    "SELECT 1 FROM post_terms WHERE author_root = ?1 AND doc_id = ?2 AND term >= ?3 AND term < ?4 LIMIT 1",
                    (a.as_str(), d.as_str(), t.as_str(), hi.as_str()),
                )
                .await
                .context("asking a post for a term")?;
            if hit.is_none() {
                continue 'post;
            }
        }
        out.insert((a, d));
    }
    Ok(Some(out))
}

/// Judge `candidates` (newest first) against `narrow`: the indices of those that match, at
/// most `RESULTS_CAP`. Labels first (one memo read for the whole set), then the words -
/// indexing bodies on the way within `INDEX_PER_QUERY`, spent only on label survivors.
pub async fn matching(
    state: &AppState,
    candidates: &[Candidate],
    narrow: &Narrow,
    viewer: Option<&str>,
) -> Result<Vec<usize>> {
    admitted(state, candidates, narrow, viewer, RESULTS_CAP, None).await
}

/// Labels already read for a set of posts, as a reader may see them: `(author, doc) -> labels`.
pub type Labels =
    std::collections::HashMap<(String, String), Vec<crate::annotations::KnownAnnotation>>;

/// `matching`'s judgment, stopping at `cap` matches (a listing's page) - or not at all, for the
/// facet counts, which must not depend on where a page happened to end.
async fn admitted(
    state: &AppState,
    candidates: &[Candidate],
    narrow: &Narrow,
    viewer: Option<&str>,
    cap: usize,
    known: Option<&Labels>,
) -> Result<Vec<usize>> {
    let fetched;
    let labelled: Option<&Labels> = if !narrow.picks_labels() {
        None
    } else if known.is_some() {
        known
    } else {
        let pairs: Vec<(String, String)> =
            candidates.iter().map(|c| (c.author_root.clone(), c.doc_hex.clone())).collect();
        fetched = crate::annotations::for_posts(state, &pairs, viewer).await?;
        Some(&fetched)
    };
    let mut budget = INDEX_PER_QUERY;
    let mut out = Vec::new();
    for (i, c) in candidates.iter().enumerate() {
        if !narrow.kinds_admit(c.kind) {
            continue;
        }
        if let Some(known) = &labelled {
            let (mut buckets, mut tags) = (Vec::new(), Vec::new());
            for a in known
                .get(&(c.author_root.clone(), c.doc_hex.clone()))
                .map(|v| v.as_slice())
                .unwrap_or(&[])
            {
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
            if out.len() >= cap {
                break;
            }
        }
    }
    Ok(out)
}

/// Which candidates each facet row counts over, in a narrowed listing (Curtis, 2026-09-27: picking
/// a label thins the lists to what is still there). A row counts the candidates every other row's
/// picks admit, less what its OWN "leave out" picks drop - but never thinned by its own "only"
/// picks, which widen (2026-10-01, OR within every row): each sibling counts what picking it too
/// would add, and leaving out #nsfw takes its posts out of #art's count. Unnarrowed, every row
/// counts everything.
///
/// A chip left out would count nothing that way, and a chip with no posts isn't listed - so it
/// would vanish with no way to click it back. `*_out` is the row's set before its own exclusions,
/// read only when it has some, and the left-out chips are counted there: how much they leave out.
pub struct FacetSets {
    pub kinds: Vec<usize>,
    pub buckets: Vec<usize>,
    /// Per tag family (`tag_family`): each judged with only its OWN family's picks set aside, so a
    /// size chip's count honours a picked medium (2026-10-02).
    pub tags: [Vec<usize>; 3],
    pub kinds_out: Option<Vec<usize>>,
    pub buckets_out: Option<Vec<usize>>,
    pub tags_out: [Option<Vec<usize>>; 3],
}

pub async fn facet_sets(
    state: &AppState,
    candidates: &[Candidate],
    narrow: &Narrow,
    viewer: Option<&str>,
    known: Option<&Labels>,
) -> Result<FacetSets> {
    let all: Vec<usize> = (0..candidates.len()).collect();
    let judge = |n: Narrow| async move {
        if n.is_empty() {
            Ok::<_, anyhow::Error>((0..candidates.len()).collect())
        } else {
            admitted(state, candidates, &n, viewer, usize::MAX, known).await
        }
    };
    if narrow.is_empty() {
        return Ok(FacetSets {
            kinds: all.clone(),
            buckets: all.clone(),
            tags: [all.clone(), all.clone(), all],
            kinds_out: None,
            buckets_out: None,
            tags_out: [None, None, None],
        });
    }
    let kinds_out = match narrow.not_kinds.is_empty() {
        true => None,
        false => Some(
            judge(Narrow { kinds: Vec::new(), not_kinds: Vec::new(), ..narrow.clone() }).await?,
        ),
    };
    let buckets_out = match narrow.not_buckets.is_empty() {
        true => None,
        false => Some(
            judge(Narrow { buckets: Vec::new(), not_buckets: Vec::new(), ..narrow.clone() })
                .await?,
        ),
    };
    // Each tag family set aside alone; families with nothing picked share the whole narrow's set.
    let without = |family: usize, out_too: bool| Narrow {
        tags: narrow.tags.iter().filter(|t| tag_family(t) != family).cloned().collect(),
        not_tags: if out_too {
            narrow.not_tags.iter().filter(|t| tag_family(t) != family).cloned().collect()
        } else {
            narrow.not_tags.clone()
        },
        ..narrow.clone()
    };
    let mut whole: Option<Vec<usize>> = None;
    let mut tags: [Vec<usize>; 3] = Default::default();
    let mut tags_out: [Option<Vec<usize>>; 3] = Default::default();
    for family in 0..3 {
        let picked = narrow.tags.iter().any(|t| tag_family(t) == family);
        tags[family] = if picked {
            judge(without(family, false)).await?
        } else {
            if whole.is_none() {
                whole = Some(judge(narrow.clone()).await?);
            }
            whole.clone().unwrap_or_default()
        };
        if narrow.not_tags.iter().any(|t| tag_family(t) == family) {
            tags_out[family] = Some(judge(without(family, true)).await?);
        }
    }
    Ok(FacetSets {
        kinds: judge(Narrow { kinds: Vec::new(), ..narrow.clone() }).await?,
        buckets: judge(Narrow { buckets: Vec::new(), ..narrow.clone() }).await?,
        tags,
        kinds_out,
        buckets_out,
        tags_out,
    })
}

/// Each left-out chip's count, from the row before its own exclusions (`FacetSets`): how many it
/// leaves out, in its place by count, so the chip stays on the strip to be clicked back.
fn restore_left_out(row: &mut Vec<(String, i64)>, before: &[(String, i64)], left_out: &[String]) {
    for value in left_out {
        let Some((_, n)) = before.iter().find(|(v, _)| v == value) else { continue };
        row.retain(|(v, _)| v != value);
        row.push((value.clone(), *n));
    }
    row.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
}

/// A listing's facets as the labels doors answer them - `{ kinds, buckets, tags }`, each a list of
/// `{ value, count }` - counted per `facet_sets` over `candidates` narrowed by `narrow`.
/// `shares` is a persona page's passed-along posts, which are no candidates (they carry no words
/// or labels): they count in the kind row only while nothing but kinds is picked, as the page
/// itself shows them only then.
pub async fn facets_json(
    state: &AppState,
    candidates: &[Candidate],
    narrow: &Narrow,
    viewer: Option<&str>,
    shares: usize,
) -> Result<serde_json::Value> {
    facets_json_with(state, candidates, narrow, viewer, shares, None).await
}

/// `facets_json`, the candidates' labels already read (`known` - the feed's journal window,
/// joined in one read) and counted here rather than asked for again by IN list.
pub async fn facets_json_with(
    state: &AppState,
    candidates: &[Candidate],
    narrow: &Narrow,
    viewer: Option<&str>,
    shares: usize,
    known: Option<&Labels>,
) -> Result<serde_json::Value> {
    let sets = facet_sets(state, candidates, narrow, viewer, known).await?;
    let pairs = |set: &[usize]| -> Vec<(String, String)> {
        set.iter()
            .map(|&i| (candidates[i].author_root.clone(), candidates[i].doc_hex.clone()))
            .collect()
    };
    let shares_here =
        if (Narrow { kinds: Vec::new(), not_kinds: Vec::new(), ..narrow.clone() }).only_kinds() {
            shares
        } else {
            0
        };
    let kinds_of = |set: &[usize]| {
        kind_counts(
            set.iter()
                .map(|&i| candidates[i].kind)
                .chain(std::iter::repeat_n("rebroadcast", shares_here)),
        )
    };
    let mut kinds = kinds_of(&sets.kinds);
    if let Some(out) = &sets.kinds_out {
        restore_left_out(&mut kinds, &kinds_of(out), &narrow.not_kinds);
        // The kind row keeps its fixed order, not a count order.
        kinds.sort_by_key(|(k, _)| KINDS.iter().position(|x| x == k));
    }
    let labels_of = async |set: &[usize]| -> Result<(Counts, Counts)> {
        Ok(match known {
            Some(k) => count_labels(&pairs(set), k),
            None => crate::annotations::label_counts(state, &pairs(set), viewer).await?,
        })
    };
    let (mut buckets, _) = labels_of(&sets.buckets).await?;
    if let Some(out) = &sets.buckets_out {
        restore_left_out(&mut buckets, &labels_of(out).await?.0, &narrow.not_buckets);
    }
    // Each family's chips counted over its own set, then one row again, most frequent first.
    let mut tags: Counts = Vec::new();
    for family in 0..3 {
        let (_, mut counted) = labels_of(&sets.tags[family]).await?;
        counted.retain(|(t, _)| tag_family(t) == family);
        if let Some(out) = &sets.tags_out[family] {
            let left: Vec<String> =
                narrow.not_tags.iter().filter(|t| tag_family(t) == family).cloned().collect();
            let mut before = labels_of(out).await?.1;
            before.retain(|(t, _)| tag_family(t) == family);
            restore_left_out(&mut counted, &before, &left);
        }
        tags.extend(counted);
    }
    tags.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let facet = |v: Vec<(String, i64)>| -> Vec<serde_json::Value> {
        v.into_iter()
            .map(|(value, count)| serde_json::json!({ "value": value, "count": count }))
            .collect()
    };
    Ok(serde_json::json!({ "kinds": facet(kinds), "buckets": facet(buckets), "tags": facet(tags) }))
}

/// One facet row's counts: `(value, how many posts)`, most frequent first.
type Counts = Vec<(String, i64)>;

/// `annotations::label_counts`'s rule over labels already read: how often each bucket and each
/// tag appears across `posts`, counted per post however many people said it - buckets the
/// author's own and never the automatic "feed", tags anyone's - most frequent first, then by name.
fn count_labels(posts: &[(String, String)], known: &Labels) -> (Counts, Counts) {
    let mut buckets: std::collections::BTreeMap<String, i64> = Default::default();
    let mut tags: std::collections::BTreeMap<String, i64> = Default::default();
    for (author, doc) in posts {
        let mut seen: std::collections::HashSet<(&str, &str)> = Default::default();
        for a in known.get(&(author.clone(), doc.clone())).map(Vec::as_slice).unwrap_or_default() {
            if a.key == "bucket" && (a.annotator != *author || a.value == "feed") {
                continue;
            }
            if !seen.insert((a.key.as_str(), a.value.as_str())) {
                continue; // said by two people: one post, one count
            }
            let into = match a.key.as_str() {
                "bucket" => &mut buckets,
                "tag" => &mut tags,
                _ => continue,
            };
            *into.entry(a.value.clone()).or_insert(0) += 1;
        }
    }
    let sorted = |m: std::collections::BTreeMap<String, i64>| {
        let mut v: Vec<(String, i64)> = m.into_iter().collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        v
    };
    (sorted(buckets), sorted(tags))
}

// ---------------------------------------------------------------------------------------------
// The feed's tag cloud, cached (2026-09-28, PROJECT_PLAN's Scores and sort orders, *Shape*):
// counted over a year of the reader's feed in one read, kept an hour (Curtis) - unless something
// moved first. "Something moved" is a coarse generation bumped by every journal and label write,
// plus the reader's own store's mtime (a dial moved on any device): a missed signal only means a
// cloud up to an hour stale, never a count that is wrong for good.

static MOVED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A journal row or a label moved, anywhere on this node: every cached cloud is suspect.
pub fn journal_or_labels_moved() {
    MOVED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

/// How long a cloud is kept when nothing moves.
const CLOUD_TTL: std::time::Duration = std::time::Duration::from_secs(60 * 60);
/// How many clouds are kept at most - past it, the cache starts over.
const CLOUDS_KEPT: usize = 512;

struct Cloud {
    stamp: (u64, Option<i64>),
    at: std::time::Instant,
    value: serde_json::Value,
}

fn clouds() -> &'static std::sync::Mutex<std::collections::HashMap<String, Cloud>> {
    static CLOUDS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Cloud>>> =
        std::sync::OnceLock::new();
    CLOUDS.get_or_init(Default::default)
}

/// The stamp a cloud for `reader` is kept under: the node's generation, and the reader's store's mtime.
pub fn cloud_stamp(state: &AppState, reader: &str) -> (u64, Option<i64>) {
    (MOVED.load(std::sync::atomic::Ordering::Relaxed), state.user_dbs.db_mtime_ms(reader))
}

/// A kept cloud for this request, if nothing has moved since and it is under an hour old.
pub fn cached_cloud(key: &str, stamp: (u64, Option<i64>)) -> Option<serde_json::Value> {
    let clouds = clouds().lock().expect("cloud cache poisoned");
    clouds
        .get(key)
        .filter(|c| c.stamp == stamp && c.at.elapsed() < CLOUD_TTL)
        .map(|c| c.value.clone())
}

pub fn keep_cloud(key: String, stamp: (u64, Option<i64>), value: serde_json::Value) {
    let mut clouds = clouds().lock().expect("cloud cache poisoned");
    if clouds.len() >= CLOUDS_KEPT {
        clouds.clear();
    }
    clouds.insert(key, Cloud { stamp, at: std::time::Instant::now(), value });
}

/// The slow beat: index the backlog behind every reader's journal, a bounded slice per pass.
pub async fn index_pass(state: AppState) -> Result<()> {
    let readers =
        crate::identity::hosted_roots(&state.node_db).await.map_err(|e| anyhow::anyhow!("{e}"))?;
    let mut budget = INDEX_PER_BEAT;
    for reader in readers {
        if budget == 0 {
            break;
        }
        let feed = crate::fanout::JournalFilter::feed(&reader);
        // The head first, every beat: what just arrived is what gets searched for.
        for r in crate::fanout::journal_page(&state.node_db, &feed, None, HEAD_ROWS).await? {
            if budget == 0 {
                break;
            }
            let _ = bag_for(&state, &candidate(r), &mut budget).await?;
        }
        // Then the backlog, from where the last beat stopped, to the end of the journal
        // (2026-09-27: this walked the newest 5000 rows and never further).
        let from = walked().lock().expect("walk cursor poisoned").get(&reader).cloned();
        let page = crate::fanout::journal_page(&state.node_db, &feed, from, WALK_ROWS).await?;
        let reached_end = (page.len() as i64) < WALK_ROWS;
        let mut last = None;
        let mut finished = true;
        for r in page {
            if budget == 0 {
                finished = false;
                break;
            }
            last = Some((r.published_ms, r.doc_id.clone()));
            let _ = bag_for(&state, &candidate(r), &mut budget).await?;
        }
        let mut cursors = walked().lock().expect("walk cursor poisoned");
        match last {
            // The whole journal walked: the next beat starts over from the newest.
            _ if reached_end && finished => {
                cursors.remove(&reader);
            }
            Some(at) => {
                cursors.insert(reader, at);
            }
            None => {}
        }
    }
    Ok(())
}

/// Before a search reads the index: the newest of the reader's feed indexed now, so a post that
/// just arrived - or was just written - is found by its words at once, not at the next beat. The
/// query's own allowance of body reads, spent newest first; an indexed post costs one lookup.
pub async fn index_head(state: &AppState, reader: &str) -> Result<()> {
    let feed = crate::fanout::JournalFilter::feed(reader);
    let mut budget = INDEX_PER_QUERY;
    for r in crate::fanout::journal_page(&state.node_db, &feed, None, HEAD_ROWS).await? {
        let _ = bag_for(state, &candidate(r), &mut budget).await?;
    }
    Ok(())
}

/// The newest rows every beat looks at, and the backlog rows one beat walks per reader - bounds
/// on rows looked at, beside the budget on bodies read, since even an indexed row costs a read.
const HEAD_ROWS: i64 = 100;
const WALK_ROWS: i64 = 1000;

/// Where each reader's backlog walk stopped - process memory: a restart walks again from the
/// newest, which costs only the stamps already stored.
fn walked() -> &'static std::sync::Mutex<std::collections::HashMap<String, (i64, String)>> {
    static WALKED: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, (i64, String)>>,
    > = std::sync::OnceLock::new();
    WALKED.get_or_init(Default::default)
}

fn candidate(r: crate::fanout::FeedRow) -> Candidate {
    // The kind is the judge's business, not the index's.
    Candidate {
        author_root: r.author_root,
        doc_hex: r.doc_id,
        title: r.title,
        updated_ms: r.updated_ms,
        kind: "post",
    }
}

/// Forget a post's bag (its author's eviction, a takedown).
pub async fn forget_author(node_db: &Db, author_hex: &str) -> Result<()> {
    node_db
        .execute("DELETE FROM post_search WHERE author_root = ?1", (author_hex,))
        .await
        .context("forgetting an author's post index")?;
    node_db
        .execute("DELETE FROM post_terms WHERE author_root = ?1", (author_hex,))
        .await
        .context("forgetting an author's terms")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(doc: &str, title: &str) -> Candidate {
        Candidate {
            author_root: "aa".repeat(32),
            doc_hex: doc.to_string(),
            title: title.to_string(),
            updated_ms: 1,
            kind: "post",
        }
    }

    /// The inverted index (node rung 0059): every term a prefix of some word, all of them required;
    /// the rarest term names the set; a set past the cap is `None`, the walk's road; and a post
    /// indexed again loses its old words.
    #[tokio::test]
    async fn terms_find_posts_by_prefix_and_all_of_them() {
        let db = crate::db::test_node_db().await;
        let (loaf, bagel, ride) = ("11".repeat(16), "22".repeat(16), "33".repeat(16));
        keep_bag(&db, &cand(&loaf, "Loaf"), 1, &tokens_of("Loaf", "a sourdough bread loaf"))
            .await
            .unwrap();
        keep_bag(&db, &cand(&bagel, "Bagels"), 1, &tokens_of("Bagels", "boiled bread"))
            .await
            .unwrap();
        keep_bag(&db, &cand(&ride, "Ride"), 1, &tokens_of("Ride", "a canal ride")).await.unwrap();
        let docs = |found: Option<std::collections::HashSet<(String, String)>>| {
            let mut v: Vec<String> = found.expect("a set").into_iter().map(|(_, d)| d).collect();
            v.sort();
            v
        };
        let find = |t: &[&str], cap| {
            let db = db.clone();
            let terms: Vec<String> = t.iter().map(|s| s.to_string()).collect();
            async move { posts_with_terms(&db, &terms, cap).await.unwrap() }
        };
        assert_eq!(docs(find(&["sour"], 10).await), vec![loaf.clone()], "a prefix");
        assert_eq!(docs(find(&["bread"], 10).await), [loaf.clone(), bagel.clone()]);
        assert_eq!(docs(find(&["bread", "boil"], 10).await), vec![bagel.clone()], "every term");
        assert!(docs(find(&["bread", "canal"], 10).await).is_empty(), "no post has both");
        assert!(
            find(&["bread"], 1).await.is_none(),
            "two posts past a cap of one: walk the feed instead"
        );
        assert_eq!(
            docs(find(&["bread", "sour"], 1).await),
            vec![loaf.clone()],
            "the rarer term names the set"
        );
        keep_bag(&db, &cand(&loaf, "Loaf"), 2, &tokens_of("Loaf", "rye now")).await.unwrap();
        assert!(docs(find(&["sour"], 10).await).is_empty(), "indexed again, the old words go");
        assert_eq!(docs(find(&["rye"], 10).await), vec![loaf.clone()]);
    }

    /// The term read is a range scan of the index, never the table.
    #[tokio::test]
    async fn a_term_is_a_range_of_the_index() {
        let db = crate::db::test_node_db().await;
        let plan: Vec<(i64, i64, i64, String)> = db
            .fetch_all(
                "EXPLAIN QUERY PLAN SELECT DISTINCT author_root, doc_id FROM post_terms WHERE term >= ?1 AND term < ?2 LIMIT ?3",
                (),
            )
            .await
            .unwrap();
        let p = plan.into_iter().map(|r| r.3).collect::<Vec<_>>().join(" | ");
        assert!(p.contains("post_terms_1 (term>=? AND term<?)"), "a range of the index: {p}");
    }

    /// The size and media rows (2026-10-02): either within a family, both across them.
    #[test]
    fn tag_families_widen_within_and_narrow_across() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let n = Narrow::parse(Some("tag=micro&tag=short&tag=image"), None);
        assert!(n.labels_admit(&[], &s(&["micro", "image"])), "a size picked and a medium picked");
        assert!(n.labels_admit(&[], &s(&["short", "image", "bread"])), "either size");
        assert!(!n.labels_admit(&[], &s(&["micro"])), "a size alone is not the picked medium");
        assert!(!n.labels_admit(&[], &s(&["image", "long"])), "the medium, at a size not picked");
        let mixed = Narrow::parse(Some("tag=bread&tag=video"), None);
        assert!(
            mixed.labels_admit(&[], &s(&["bread", "video"]))
                && !mixed.labels_admit(&[], &s(&["bread"])),
            "an ordinary tag and a medium narrow together too"
        );
    }

    /// The two families are exactly the implicit tags - a new size or medium cannot land in the
    /// ordinary row by accident.
    #[test]
    fn the_families_are_the_implicit_tags() {
        let mut families: Vec<&str> = SIZE_TAGS.iter().chain(MEDIA_TAGS.iter()).copied().collect();
        let mut implicit = crate::record::documents::IMPLICIT_TAGS.to_vec();
        families.sort();
        implicit.sort();
        assert_eq!(families, implicit);
        assert_eq!(tag_family("bread"), 0);
    }

    /// Prefix-by-token, every term required, case-blind, punctuation ignored.
    #[test]
    fn terms_prefix_tokens_and_all_must_hit() {
        let bag = tokens_of("Bread Day", "The sourdough rose overnight; it was good.");
        assert!(hits(&bag, &terms("sour")), "a prefix hits");
        assert!(hits(&bag, &terms("BREAD rose")), "case-blind, every term");
        assert!(!hits(&bag, &terms("bread cake")), "one missing term is a miss");
        assert!(hits(&bag, &terms("")), "no terms: everything matches");
        assert_eq!(terms("  sour-dough, ROSE "), vec!["dough", "rose", "sour"]);
        assert!(
            terms("x").is_empty(),
            "a one-letter term is not a term - the box shows everything until a word"
        );
    }

    /// Every row's "only" picks widen (OR), its "leave out" picks drop, and the raw query string
    /// carries both (2026-10-01).
    #[test]
    fn narrowing_parses_repeats_and_judges_labels() {
        let n = Narrow::parse(Some("bucket=feed&bucket=recipes&tag=bread&tag=slow&kind=book&kind=nonsense&q=ignored%20here"), Some("Sour"));
        assert_eq!(n.buckets, vec!["feed", "recipes"]);
        assert_eq!(n.kinds, vec!["book"], "a kind the row does not know is dropped");
        assert!(n.kinds_admit("book") && !n.kinds_admit("post"));
        assert!(Narrow::default().kinds_admit("reply"), "nothing picked admits every kind");
        assert_eq!(
            kind_counts(["post", "book", "post", "odd"].into_iter()),
            vec![("post".to_string(), 2), ("book".to_string(), 1)]
        );
        assert_eq!(n.tags, vec!["bread", "slow"]);
        assert_eq!(n.terms, vec!["sour"]);
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert!(
            n.labels_admit(&s(&["recipes"]), &s(&["bread", "extra"])),
            "either bucket, either tag"
        );
        assert!(!n.labels_admit(&s(&["recipes"]), &s(&["cake"])), "none of the tags refuses");
        assert!(!n.labels_admit(&s(&["photos"]), &s(&["bread", "slow"])), "neither bucket refuses");
        assert!(Narrow::parse(None, None).is_empty());
        assert!(Narrow::default().labels_admit(&[], &[]), "nothing picked admits everything");

        let out = Narrow::parse(
            Some("not_tag=nsfw&not_bucket=drafts&not_kind=reply&not_kind=nonsense"),
            None,
        );
        assert!(
            !out.is_empty() && out.only_kinds(),
            "leaving out is a pick, and needs no labels of a share"
        );
        assert_eq!(out.not_kinds, vec!["reply"]);
        assert!(
            out.kinds_admit("post") && !out.kinds_admit("reply"),
            "a kind left out, the rest stay"
        );
        assert!(
            out.labels_admit(&s(&["feed"]), &s(&["bread"])),
            "nothing left out on it: it stays"
        );
        assert!(
            !out.labels_admit(&s(&["feed"]), &s(&["bread", "nsfw"])),
            "one tag left out drops it"
        );
        assert!(!out.labels_admit(&s(&["drafts"]), &[]), "a bucket left out drops it");
        let both = Narrow::parse(Some("tag=bread&not_tag=slow"), None);
        assert!(
            both.labels_admit(&[], &s(&["bread"]))
                && !both.labels_admit(&[], &s(&["bread", "slow"])),
            "only, less what's left out"
        );
    }
}
