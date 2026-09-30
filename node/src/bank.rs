//! HorseBucks' ledger (HORSE_BASED_CURRENCIES.md, slice 1, 2026-09-29): what a persona has earned,
//! one line per thing that earned it, folded by each of the persona's computers from the records
//! it holds.
//!
//! **Keyed by what earned it.** A line is `(kind, source)` - `words` for a document version,
//! `chat` for a line said, `heartbeat` for a day - so the same record never pays twice, however
//! often the fold runs, and two computers holding the same records hold the same lines. Lines are
//! kept, never recomputed: old chat is pruned and withdrawn edges vanish from the node's memos,
//! but what was earned stays earned. A record this computer can't read yet (a body still arriving,
//! a key from an era it doesn't hold) simply isn't paid until a later pass can.
//!
//! **Horsepennies.** A hundredth of a HorseBuck, so every rate is an exact integer: 5 H$ per 20
//! words is 25 pennies a word. A line fits an `i64`; the balance is summed exactly in `i128`
//! (the bigint the design settled on, until interest makes one necessary).
//!
//! **What's new, not what's there.** Words are distinct three-word shingles, strokes are distinct
//! shapes, and a document version pays only for what it added over its parents - so pasting a
//! paragraph fifty times, or pressing one stamp five hundred times, pays once.

use std::collections::{BTreeMap, HashMap, HashSet};

use anyhow::Result;
use serde_json::json;

use crate::record::documents::{Format, Version};
use crate::record::store::Store;
use crate::AppState;

/// A HorseBuck, in horsepennies.
pub const HORSEBUCK: i64 = 100;

// The rates (Curtis, 2026-09-29), in horsepennies.
const PER_WORD: i64 = 25; // every 20 words: 5 H$
const PER_IMAGE: i64 = 10 * HORSEBUCK;
const PER_STROKE: i64 = 50; // every 10 strokes: 5 H$
const PER_FOLLOW: i64 = 500 * HORSEBUCK; // each way
const PER_CHAT_LINE: i64 = 5 * HORSEBUCK;
const PER_REACTION_GIVEN: i64 = HORSEBUCK;
const PER_REACTION_RECEIVED: i64 = 5 * HORSEBUCK;
const PER_HEARTBEAT: i64 = 10 * HORSEBUCK;

// ---------------------------------------------------------------------------------------------
// Measuring what's new

fn hash64(bytes: &[u8]) -> u64 {
    u64::from_be_bytes(blake3::hash(bytes).as_bytes()[..8].try_into().expect("eight bytes"))
}

/// A text's distinct three-word shingles: lowercased, everything but letters and digits a space,
/// every overlapping run of three words. A text of one or two words is one shingle.
pub fn shingles(text: &str) -> HashSet<u64> {
    let normal: String = text.chars().map(|c| if c.is_alphanumeric() { c.to_lowercase().next().unwrap_or(c) } else { ' ' }).collect();
    let words: Vec<&str> = normal.split_whitespace().collect();
    if words.len() < 3 {
        return if words.is_empty() { HashSet::new() } else { HashSet::from([hash64(words.join(" ").as_bytes())]) };
    }
    words.windows(3).map(|w| hash64(w.join(" ").as_bytes())).collect()
}

/// A drawing's distinct stroke shapes: each stroke's own record less what makes it unique rather
/// than different - its id, its time, its layer and where it starts (the rest of its points are
/// already steps from the one before). A shape drawn twice, or a stamp pressed twice, is one shape.
/// Grabs, copies, crops and transforms aren't marks, and don't count.
pub fn stroke_shapes(body: &[u8]) -> HashSet<u64> {
    let drawing = crate::drawing::read(body);
    let mut out = HashSet::new();
    for stroke in &drawing.strokes {
        if matches!(stroke.tool, "move" | "copy" | "crop" | "transform") {
            continue;
        }
        let Ok(mut v) = serde_json::to_value(stroke) else { continue };
        if let Some(o) = v.as_object_mut() {
            o.remove("id");
            o.remove("t");
            o.remove("layer");
            if let Some(serde_json::Value::Array(points)) = o.get_mut("points") {
                points.drain(..points.len().min(2));
            }
        }
        out.insert(hash64(v.to_string().as_bytes()));
    }
    out
}

/// What a published work is made of, by what its note is: `(words, strokes)`. Words for a text note
/// (or a post with no note to read), strokes for a drawing - whose body is stroke data, never words -
/// and neither for any other kind.
pub fn publication_measure(note_format: Option<Format>, body: &[u8]) -> (i64, i64) {
    match note_format {
        Some(Format::Drawing) => (0, stroke_shapes(body).len() as i64),
        None | Some(Format::Marquee) | Some(Format::Plaintext) => (shingles(&String::from_utf8_lossy(body)).len() as i64, 0),
        Some(_) => (0, 0),
    }
}

/// A published work's bonus, in whole HorseBucks, by its size (words + 50 x images + strokes / 2):
/// nothing below 100, a quadratic ramp to 200 at 300, then linear (HORSE_BASED_CURRENCIES.md).
pub fn publication_bonus(size: i64) -> i64 {
    if size < 100 {
        0
    } else if size < 300 {
        (size - 100) * (size - 100) / 200
    } else {
        2 * size - 400
    }
}

// ---------------------------------------------------------------------------------------------
// The ledger

struct Line {
    kind: &'static str,
    source: String,
    pennies: i64,
    at_ms: i64,
    detail: serde_json::Value,
}

async fn banked(data: &Store) -> Result<HashSet<(String, String)>> {
    let rows: Vec<(String, String)> = data.db().fetch_all("SELECT kind, source FROM bank_lines", ()).await?;
    Ok(rows.into_iter().collect())
}

async fn bank(data: &Store, lines: Vec<Line>) -> Result<()> {
    for l in lines {
        data.db()
            .execute(
                "INSERT OR IGNORE INTO bank_lines (kind, source, pennies, at_ms, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
                (l.kind, l.source, l.pennies, l.at_ms, l.detail.to_string()),
            )
            .await?;
    }
    Ok(())
}

/// The publication rule's version. A publication line minted under an older rule is dropped and
/// counted again: posts aren't pruned, so it can always be recounted, and a rule fixed is a
/// history recounted (HORSE_BASED_CURRENCIES.md, "Rules can change"). 2: a drawing is measured in
/// strokes, not read as words (2026-09-29).
const PUBLICATION_RULES: i64 = 2;

async fn recount_stale_publications(data: &Store) -> Result<()> {
    let rows: Vec<(String, String)> = data.db().fetch_all("SELECT source, detail FROM bank_lines WHERE kind = 'publication'", ()).await?;
    for (source, detail) in rows {
        let rules = serde_json::from_str::<serde_json::Value>(&detail).ok().and_then(|d| d["rules"].as_i64()).unwrap_or(1);
        if rules < PUBLICATION_RULES {
            data.db().execute("DELETE FROM bank_lines WHERE kind = 'publication' AND source = ?1", (source,)).await?;
        }
    }
    Ok(())
}

/// Bring the ledger up to date with what this computer holds.
pub async fn catch_up(state: &AppState, data: &Store, root_hex: &str) -> Result<()> {
    recount_stale_publications(data).await?;
    let have = banked(data).await?;
    let is_new = |kind: &str, source: &str| !have.contains(&(kind.to_string(), source.to_string()));
    let mut lines: Vec<Line> = Vec::new();
    let docs = data.documents();
    let view = docs.all().await.map_err(|e| anyhow::anyhow!("reading documents: {e}"))?;
    let mut bodies: HashMap<[u8; 32], Option<Vec<u8>>> = HashMap::new();
    let mut body_of = async |v: &Version| -> Option<Vec<u8>> {
        if let Some(b) = bodies.get(&v.hash) {
            return b.clone();
        }
        let b = docs.body(v).await.ok().flatten();
        bodies.insert(v.hash, b.clone());
        b
    };

    // Private work: words, pictures and strokes, per version, for what each added.
    for (doc_id, doc) in &view.docs {
        if doc.lane != "private" {
            continue;
        }
        for (hash, v) in &doc.versions {
            let format = Format::from_wire(v.header.format);
            let title = v.header.title.clone();
            match format {
                Format::Avif | Format::Apng | Format::WebmAv1 | Format::OggOpus => {
                    let source = hex::encode(doc_id);
                    if v.header.parents.is_empty() && is_new("image", &source) {
                        lines.push(Line { kind: "image", source, pennies: PER_IMAGE, at_ms: v.timestamp_ms, detail: json!({ "title": title }) });
                    }
                }
                Format::Marquee | Format::Plaintext | Format::Drawing => {
                    let (kind, rate) = if format == Format::Drawing { ("strokes", PER_STROKE) } else { ("words", PER_WORD) };
                    let source = hex::encode(hash);
                    if !is_new(kind, &source) {
                        continue;
                    }
                    let Some(body) = body_of(v).await else { continue };
                    let measure = |b: &[u8]| if format == Format::Drawing { stroke_shapes(b) } else { shingles(&String::from_utf8_lossy(b)) };
                    let mut before: HashSet<u64> = HashSet::new();
                    let mut readable = true;
                    for p in &v.header.parents {
                        match doc.versions.get(p) {
                            Some(pv) => match body_of(pv).await {
                                Some(pb) => before.extend(measure(&pb)),
                                None => readable = false,
                            },
                            None => readable = false,
                        }
                    }
                    if !readable {
                        continue; // a parent this computer can't read yet: a later pass
                    }
                    let added = measure(&body).difference(&before).count() as i64;
                    lines.push(Line { kind, source, pennies: added * rate, at_ms: v.timestamp_ms, detail: json!({ "title": title, "count": added }) });
                }
                _ => {}
            }
        }
    }

    // Publications: once per note, the private amounts again plus the size bonus.
    for (post_id, doc) in &view.docs {
        if doc.lane != "public" {
            continue;
        }
        let Some(v) = doc.versions.values().min_by_key(|v| v.timestamp_ms) else { continue };
        if !matches!(Format::from_wire(v.header.format), Format::Marquee | Format::Plaintext) {
            continue;
        }
        let note = data.annotations().note_claiming(post_id).await.ok().flatten();
        let source = hex::encode(note.unwrap_or(*post_id));
        if !is_new("publication", &source) {
            continue;
        }
        // The work as made: the note's, which a sealed post's ciphertext can't give - measured by
        // what the note IS. A drawing's body is stroke data, so it's measured in strokes, never
        // read as words (2026-09-29: a published drawing's JSON counted as thousands of words and
        // paid 12,292 H$); a note of any other kind than words or strokes brings neither.
        let note_head = note.and_then(|n| view.docs.get(&n)).and_then(|n| n.display_head());
        let note_format = note_head.map(|nv| Format::from_wire(nv.header.format));
        let body = match note_head {
            Some(nv) => body_of(nv).await,
            None if !v.header.trusted_only => state.files.get_public(iroh_blobs::Hash::from_bytes(v.header.file_hash)).await.ok().flatten(),
            None => None,
        };
        let Some(body) = body else { continue };
        let (words, strokes) = publication_measure(note_format, &body);
        let images = v.header.refs.iter().collect::<HashSet<_>>().len() as i64;
        let size = words + 50 * images + strokes / 2;
        let bonus = publication_bonus(size) * HORSEBUCK;
        let again = words * PER_WORD + images * PER_IMAGE + strokes * PER_STROKE;
        lines.push(Line {
            kind: "publication",
            source,
            pennies: again + bonus,
            at_ms: v.timestamp_ms,
            detail: json!({ "title": v.header.title, "post": hex::encode(post_id), "words": words, "strokes": strokes, "images": images, "bonus": bonus, "rules": PUBLICATION_RULES }),
        });
    }

    // Heartbeats: one a day, however many computers sent one.
    if let Ok(entries) = crate::record::imaol::entries_of_type(data.db(), ringtome_proto::registry::service::PROFILE_PUBLIC, ringtome_proto::registry::entry_type::PROFILE_SET).await {
        for e in entries {
            let ringtome_proto::Payload::Inline(p) = &e.entry().payload else { continue };
            let Ok(ps) = ringtome_proto::ProfileSet::decode(p) else { continue };
            if ps.field != crate::heartbeat::FIELD {
                continue;
            }
            let Some(day) = crate::heartbeat::day_of_date(&ps.value) else { continue };
            if is_new("heartbeat", &ps.value) && !lines.iter().any(|l| l.kind == "heartbeat" && l.source == ps.value) {
                lines.push(Line { kind: "heartbeat", source: ps.value, pennies: PER_HEARTBEAT, at_ms: i64::from(day) * 86_400_000, detail: json!({}) });
            }
        }
    }

    // Chat: lines said, reactions given, reactions received.
    for (hash, at) in crate::chat::lines_by(&state.node_db, root_hex).await.unwrap_or_default() {
        if is_new("chat", &hash) {
            lines.push(Line { kind: "chat", source: hash, pennies: PER_CHAT_LINE, at_ms: at, detail: json!({}) });
        }
    }
    for (hash, at) in crate::chat::reactions_by(&state.node_db, root_hex).await.unwrap_or_default() {
        if is_new("reaction", &hash) {
            lines.push(Line { kind: "reaction", source: hash, pennies: PER_REACTION_GIVEN, at_ms: at, detail: json!({}) });
        }
    }
    for (hash, at, who) in crate::chat::reactions_to(&state.node_db, root_hex).await.unwrap_or_default() {
        if is_new("reacted", &hash) {
            lines.push(Line { kind: "reacted", source: hash, pennies: PER_REACTION_RECEIVED, at_ms: at, detail: json!({ "by": who }) });
        }
    }

    // Post reactions: emoji said about posts, and about the persona's own.
    for a in crate::record::imaol::public_annotations(data.db()).await.unwrap_or_default() {
        if !a.present || a.key != "tag" || !crate::annotations::is_emoji_tag(&a.value) || a.target_author == root_hex {
            continue;
        }
        let source = format!("{}:{}:{}", a.target_author, hex::encode(a.target_doc), a.value);
        if is_new("post_reaction", &source) {
            lines.push(Line { kind: "post_reaction", source, pennies: PER_REACTION_GIVEN, at_ms: a.received_at_ms, detail: json!({ "emoji": a.value }) });
        }
    }
    for (who, doc, emoji, at) in crate::annotations::emoji_received(&state.node_db, root_hex).await.unwrap_or_default() {
        let source = format!("{who}:{doc}:{emoji}");
        if is_new("post_reacted", &source) {
            lines.push(Line { kind: "post_reacted", source, pennies: PER_REACTION_RECEIVED, at_ms: at, detail: json!({ "by": who, "emoji": emoji }) });
        }
    }

    // Published edges, either way: once per pair, ever.
    for (subject, row) in data.public_edges().published().await.unwrap_or_default() {
        if subject != root_hex && !row.edge.is_empty() && is_new("follow", &subject) {
            lines.push(Line { kind: "follow", source: subject.clone(), pennies: PER_FOLLOW, at_ms: row.received_at_ms, detail: json!({ "of": subject }) });
        }
    }
    for (author, _, _) in crate::edgegraph::edges_naming(&state.node_db, root_hex).await.unwrap_or_default() {
        if author != root_hex && is_new("followed", &author) {
            lines.push(Line { kind: "followed", source: author.clone(), pennies: PER_FOLLOW, at_ms: crate::clock::now_ms(), detail: json!({ "by": author }) });
        }
    }

    bank(data, lines).await
}

/// The balance, in horsepennies, summed exactly.
pub async fn balance(data: &Store) -> Result<i128> {
    let rows: Vec<(i64,)> = data.db().fetch_all("SELECT pennies FROM bank_lines", ()).await?;
    Ok(rows.into_iter().map(|(p,)| i128::from(p)).sum())
}

#[derive(serde::Deserialize)]
pub struct BankQuery {
    lines: Option<i64>,
    /// Which month's lines, `YYYY-MM` (UTC); the newest month with any by default.
    month: Option<String>,
}

/// A month's first moment and the next month's, in ms (UTC), from `YYYY-MM`.
fn month_bounds(month: &str) -> Option<(i64, i64)> {
    let (y, m) = month.split_once('-')?;
    let (y, m): (i64, i64) = (y.parse().ok()?, m.parse().ok()?);
    if !(1..=12).contains(&m) {
        return None;
    }
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    let start = crate::heartbeat::day_of_date(&format!("{y:04}-{m:02}-01"))?;
    let end = crate::heartbeat::day_of_date(&format!("{ny:04}-{nm:02}-01"))?;
    Some((i64::from(start) * 86_400_000, i64::from(end) * 86_400_000))
}

/// GET `/api/identity/{root}/bank` - the balance (horsepennies, as a decimal string: it's a bigint
/// on the page), a total per kind, every month's line count and total (newest first), and ONE
/// month's lines that paid something, newest first, with what each was for (Curtis, 2026-09-29:
/// after years the ledger is tens of thousands of lines - the page opens a month at a time).
/// `?lines=0` skips the ledger (the corner balance's poll).
pub async fn bank_handler(
    session: crate::auth::Session,
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Path(root): axum::extract::Path<String>,
    axum::extract::Query(q): axum::extract::Query<BankQuery>,
) -> Result<axum::Json<serde_json::Value>, crate::error::AppError> {
    let data = crate::record::store::open(&state, &session.account.id, &root).await?;
    catch_up(&state, &data, &root).await.map_err(crate::error::AppError::Internal)?;
    let total = balance(&data).await.map_err(crate::error::AppError::Internal)?;
    // Every month's count and total, off the lines' own times.
    let stamps: Vec<(i64, i64)> = data
        .db()
        .fetch_all("SELECT at_ms, pennies FROM bank_lines WHERE pennies <> 0", ())
        .await
        .map_err(crate::error::AppError::Internal)?;
    let mut months: BTreeMap<String, (i64, i128)> = BTreeMap::new();
    for (at, p) in stamps {
        let slot = months.entry(crate::heartbeat::utc_date(at)[..7].to_string()).or_insert((0, 0));
        slot.0 += 1;
        slot.1 += i128::from(p);
    }
    let month = q.month.clone().filter(|m| months.contains_key(m)).or_else(|| months.keys().next_back().cloned());
    let (from, to) = month.as_deref().and_then(month_bounds).unwrap_or((0, 0));
    let rows: Vec<(String, String, i64, i64, String)> = data
        .db()
        .fetch_all(
            "SELECT kind, source, pennies, at_ms, detail FROM bank_lines
             WHERE pennies <> 0 AND at_ms >= ?1 AND at_ms < ?2 ORDER BY at_ms DESC, kind, source LIMIT ?3",
            (from, to, q.lines.unwrap_or(5000).clamp(0, 20_000)),
        )
        .await
        .map_err(crate::error::AppError::Internal)?;
    let kinds: Vec<(String, i64)> = data
        .db()
        .fetch_all("SELECT kind, SUM(pennies) FROM bank_lines GROUP BY kind", ())
        .await
        .map_err(crate::error::AppError::Internal)?;
    let by_kind: BTreeMap<String, String> = kinds.into_iter().map(|(k, p)| (k, p.to_string())).collect();
    let lines: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|(kind, source, pennies, at_ms, detail)| {
            json!({
                "kind": kind,
                "source": source,
                "pennies": pennies.to_string(),
                "at_ms": at_ms,
                "detail": serde_json::from_str::<serde_json::Value>(&detail).unwrap_or_default(),
            })
        })
        .collect();
    let months: Vec<serde_json::Value> = months
        .into_iter()
        .rev()
        .map(|(m, (count, pennies))| json!({ "month": m, "lines": count, "pennies": pennies.to_string() }))
        .collect();
    Ok(axum::Json(json!({ "balance": total.to_string(), "by_kind": by_kind, "months": months, "month": month, "lines": lines })))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Words are what's new: a paragraph pasted twice is one paragraph's shingles, and case and
    /// punctuation don't make a word new.
    #[test]
    fn shingles_count_what_repetition_never_adds() {
        let once = "The quick brown fox jumps over the lazy dog.";
        assert_eq!(shingles(once).len(), 7);
        assert_eq!(shingles(&format!("{once} {once}")).len(), 9, "the seam adds two; the second copy adds none");
        assert_eq!(shingles("THE QUICK, brown fox!"), shingles("the quick brown fox"));
        assert_eq!(shingles("two words").len(), 1);
        assert!(shingles("  ").is_empty());
    }

    /// A stroke's shape is where it goes, not where it starts or when: the same stamp pressed at two
    /// places is one shape, a different path is another, and a grab is no mark at all.
    #[test]
    fn a_shape_drawn_twice_is_one_shape() {
        let body = serde_json::json!({ "strokes": [
            { "id": "a1a1a1a1a1a1a1a1", "t": 1, "tool": "brush", "color": "#112233", "size": 4, "points": [10, 10, 5, 0, 5, 0] },
            { "id": "b2b2b2b2b2b2b2b2", "t": 2, "tool": "brush", "color": "#112233", "size": 4, "points": [90, 40, 5, 0, 5, 0] },
            { "id": "c3c3c3c3c3c3c3c3", "t": 3, "tool": "brush", "color": "#112233", "size": 4, "points": [10, 10, 0, 5] },
            { "id": "d4d4d4d4d4d4d4d4", "t": 4, "tool": "move", "dx": 3, "dy": 3 }
        ]});
        assert_eq!(stroke_shapes(body.to_string().as_bytes()).len(), 2);
    }

    /// A published drawing is measured in its strokes: its body is JSON, and read as words it would
    /// be hundreds of distinct "shingles" (2026-09-29: one drawing paid 12,292 H$ that way).
    #[test]
    fn a_published_drawing_is_its_strokes_not_its_json() {
        let strokes: Vec<serde_json::Value> = (0..40)
            .map(|i| serde_json::json!({ "id": format!("{:016x}", i + 1), "t": i, "tool": "brush", "color": "#112233", "size": 4, "points": [i, i, i + 1, 2, 3, i] }))
            .collect();
        let body = serde_json::json!({ "strokes": strokes }).to_string();
        let as_words = shingles(&body).len();
        assert!(as_words > 100, "read as words, the JSON is a novel: {as_words}");
        assert_eq!(publication_measure(Some(Format::Drawing), body.as_bytes()), (0, 40));
        assert_eq!(publication_measure(Some(Format::Marquee), b"one two three four"), (2, 0));
        assert_eq!(publication_measure(Some(Format::Avif), b"\x89PNG noise noise noise"), (0, 0), "a picture brings no words");
    }

    /// A month's bounds, December rolling into the next year; nonsense is nothing.
    #[test]
    fn a_month_is_its_first_moment_to_the_next() {
        assert_eq!(month_bounds("1970-01"), Some((0, 31 * 86_400_000)));
        let (a, b) = month_bounds("2026-12").unwrap();
        assert_eq!(crate::heartbeat::utc_date(a), "2026-12-01");
        assert_eq!(crate::heartbeat::utc_date(b), "2027-01-01");
        assert_eq!(month_bounds("2026-13"), None);
        assert_eq!(month_bounds("horse"), None);
    }

    /// Nothing below 100, the ramp meets the line at 300 at the line's own height, and it grows.
    #[test]
    fn the_bonus_ramps_then_runs() {
        assert_eq!(publication_bonus(99), 0);
        assert_eq!(publication_bonus(100), 0);
        assert_eq!(publication_bonus(200), 50);
        assert_eq!(publication_bonus(299), (199 * 199) / 200);
        assert_eq!(publication_bonus(300), 200);
        assert_eq!(publication_bonus(1000), 1600);
        assert_eq!(publication_bonus(2200), 4000);
    }
}
