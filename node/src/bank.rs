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
//! words is 25 pennies a word. Every line and every sum is an exact bigint (2026-10-06, as
//! HORSE_BASED_CURRENCIES.md settled it): kept as a decimal string, never rounded, never clamped.
//!
//! **What's new, not what's there.** Words are distinct three-word shingles, strokes are distinct
//! shapes, and a document version pays only for what it added over its parents - so pasting a
//! paragraph fifty times, or pressing one stamp five hundred times, pays once.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};

use anyhow::Result;
use num_bigint::BigInt;
use num_traits::{Signed, Zero};
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
/// The magic words (Curtis, 2026-10-04): the old cheat codes, said in public, pay - once per post
/// that says them (2026-10-05: "for users who don't want to play our weird games, they can just
/// cheat their way to a full unlock, so long as they admit it to the network by saying the magic
/// words out loud"). They paid once per persona until then.
const PER_MAGIC_WORDS: i64 = 10_000 * HORSEBUCK;
const MAGIC_WORDS: [&str; 9] = [
    "glittering prizes",
    "show me the money",
    "pot of gold",
    "greedisgood",
    "rosebud",
    "klapaucius",
    "mother lode",
    "robin hood",
    "porntipsguzzardo",
];

// ---- contracts (Curtis, 2026-10-04) ----
//
// A contract is a goal: reach it and it pays, once. Completion is a fact on the persona's PRIVATE
// chain (`contracts`: id -> the moment it was recorded) - it syncs, so every computer of the persona
// knows it, pays it once (`contract` / id, like any line), and only the computer that RECORDED it
// says so in hrseMsg: a message shown once, however many computers there are.

/// The private register completions are recorded in.
const CONTRACTS_KV: &str = "contracts";

/// One contract: its id (stable - the key everywhere), its name as the player reads it, its reward,
/// and the unlocks it needs before the column offers it (UNLOCKS.md, "Contracts").
pub struct Contract {
    pub id: &'static str,
    pub name: &'static str,
    pub pennies: i64,
    pub requires: &'static [&'static str],
}

const fn contract(
    id: &'static str,
    name: &'static str,
    horsebucks: i64,
    requires: &'static [&'static str],
) -> Contract {
    Contract { id, name, pennies: horsebucks * HORSEBUCK, requires }
}

/// Every contract, in the order the column lists them.
pub const CONTRACTS: [Contract; 21] = [
    contract("draw-a-horse", "Draw a horse in hrseDrawing™", 5_000, &[]),
    contract("post-a-horse", "Post your horse to the hrseFeed™", 10_000, &["social"]),
    contract("follow-a-stranger", "Follow a stranger", 5_000, &["friends"]),
    contract("get-a-follower", "Get a follower", 5_000, &["friends"]),
    contract("write-a-note", "Create a private note in hrseWriter™", 2_500, &["private-notes"]),
    contract("upload-an-image", "Upload an image to hrseFiles™", 5_000, &["file-upload"]),
    contract("set-a-profile-picture", "Set your profile picture", 2_500, &[]),
    contract("choose-a-colorway", "Customize your Colorway", 2_500, &[]),
    contract("say-hello", "Say hello in a hrseChat™ room", 2_500, &["chat"]),
    contract("tag-a-public-post", "Tag a public post", 2_500, &["social", "tags"]),
    contract("tag-a-private-note", "Tag a private note", 2_500, &["private-notes", "tags"]),
    contract("react-to-a-post", "React to someone else's post", 2_500, &["social", "tags"]),
    contract("link-two-notes", "Link one private note to another", 2_500, &["links"]),
    contract("organize-a-note", "Organize a note into a tree section", 2_500, &["taxonomy"]),
    contract("start-a-room", "Start a chat room", 2_500, &["chat"]),
    contract("buy-a-horsebond", "Buy a hrseBond", 2_500, &["horse-financial"]),
    // The safety contracts (Curtis, 2026-10-05): what keeps a person safe is never sold, so it is
    // taught - and paid - instead (UNLOCKS.md, "Never gated").
    contract("make-a-second-persona", "Make a second persona", 2_500, &[]),
    contract("bring-your-persona", "Bring your persona to another computer", 5_000, &[]),
    // The second batch's (UNLOCKS.md): each shown once its unlock is owned.
    contract("seal-a-post", "Seal a post", 2_500, &["sealing"]),
    contract("share-a-post", "Share someone else's post", 2_500, &["sharing"]),
    contract("start-a-chat-for-two", "Start a chat for two", 2_500, &["chats-for-two"]),
];

// ---- unlocks (Curtis, 2026-10-05; plans/UNLOCKS.md) ----
//
// The paywall as tutorial: a new player has their persona, hrseDrawing, hrseBank and hrseMsg, and
// buys the rest from the Market. A purchase is a fact on the PRIVATE chain (`unlocks`: id -> the
// moment it was bought), so every computer of the persona owns it, and a spend in the ledger
// (`unlock` / id), paid once. The gates are the client's: this is a tutorial, not a lock - the
// node serves every feature to anyone who asks.

/// The private register purchases are recorded in.
const UNLOCKS_KV: &str = "unlocks";

/// One unlock: its id (stable - the client's gates name it), its name, its price, and the unlocks
/// it needs first.
pub struct Unlock {
    pub id: &'static str,
    pub name: &'static str,
    pub pennies: i64,
    pub requires: &'static [&'static str],
}

const fn unlock(
    id: &'static str,
    name: &'static str,
    horsebucks: i64,
    requires: &'static [&'static str],
) -> Unlock {
    Unlock { id, name, pennies: horsebucks * HORSEBUCK, requires }
}

/// Every unlock, in the order the Market lists them.
pub const UNLOCKS: [Unlock; 23] = [
    unlock("friends", "Friends", 1_000, &[]),
    unlock("social", "Social", 1_000, &[]),
    unlock("private-notes", "Private notes", 2_500, &[]),
    unlock("chat", "Chat", 5_000, &[]),
    unlock("taxonomy", "Taxonomy & tree publication", 2_500, &["private-notes"]),
    unlock("tags", "Reactions, tags & filters", 2_500, &[]),
    unlock("file-upload", "File upload", 5_000, &[]),
    // Notes and posts both (Curtis, 2026-10-05): a pin with nothing to pin is no purchase.
    unlock("pins", "Pins", 2_500, &["private-notes", "social"]),
    unlock("post-editing", "Public post editing", 5_000, &["social"]),
    unlock("sharing", "Sharing", 2_500, &["social"]),
    unlock("links", "Links", 2_500, &["private-notes"]),
    unlock("chats-for-two", "Chats for two", 2_500, &["chat", "friends"]),
    unlock("sealing", "Trusted only posts & post audiences", 10_000, &["social", "friends"]),
    // hrseBonds, and the financial instruments to come (Curtis, 2026-10-05).
    unlock("horse-financial", "Horse Financial", 500, &[]),
    // Last, and dearest: experimental, and said so (Curtis, 2026-10-05).
    unlock("video-upload", "Video upload", 10_000, &["file-upload"]),
    // The colourways (Curtis, 2026-10-05): cosmetic, each sold alone - horse-relax and witchlight
    // stay free - and not meant to be reachable on contract money: something to keep playing for.
    // The Market shows them in a section of their own (`colorway-` is the client's word for it).
    unlock("colorway-doors-xp", "doors-xp", 25_000, &[]),
    unlock("colorway-bosc", "bosc", 25_000, &[]),
    unlock("colorway-micross", "micross", 25_000, &[]),
    unlock("colorway-terminal", "terminal", 25_000, &[]),
    unlock("colorway-terminal-white", "terminal-white", 25_000, &[]),
    unlock("colorway-terminal-cyan", "terminal-cyan", 25_000, &[]),
    unlock("colorway-terminal-orange", "terminal-orange", 25_000, &[]),
    unlock("colorway-terminal-gold", "terminal-gold", 500_000, &[]),
];

/// The unlocks owned, as the private chain records them: id -> when bought.
pub async fn unlocks_owned(data: &Store) -> Result<HashMap<String, i64>> {
    let (recorded, _) = data.private_registers(UNLOCKS_KV).all().await?;
    Ok(recorded
        .into_iter()
        .filter_map(|r| r.value.trim().parse::<i64>().ok().map(|at| (r.key, at)))
        .collect())
}

/// Does this node hand every persona every unlock? The test rig does (LOCAL_TEST), so the harness
/// probes reach Writer and Chat without buying their way in - unless `RINGTOME_TEST_LOCKS` asks
/// for the locks, to test the gates themselves.
fn everything_unlocked(state: &AppState) -> bool {
    state.config.local_test && std::env::var("RINGTOME_TEST_LOCKS").is_err()
}

/// "Unlock everything" (Curtis, 2026-10-07): a node administrator's way out of the tutorial, H$ 0,
/// in their Market alone - they run the place, but the tutorial is still theirs to play, so it is a
/// purchase rather than a gift. Bought, it is a fact on the private chain like any unlock, and the
/// bank's answers say `everything`, which every gate already reads (the client's, and MCP's). It is
/// no entry of `UNLOCKS`: nobody else is ever offered it, and it pays no ledger line.
const EVERYTHING: &str = "everything";

/// The bank's `everything`: the test rig's answer, or a persona that bought "Unlock everything".
fn owns_everything(state: &AppState, owned: &HashMap<String, i64>) -> bool {
    everything_unlocked(state) || owned.contains_key(EVERYTHING)
}

/// Is this account a node administrator - the one "Unlock everything" is offered to?
async fn node_admin(
    state: &AppState,
    account: &uuid::Uuid,
) -> Result<bool, crate::error::AppError> {
    crate::auth::has_tag(&state.node_db, account, crate::auth::TAG_NODE_ADMIN).await
}

/// Has this persona uploaded an image? A private document whose current head is a picture - a
/// still (AVIF, APNG) or a silent loop - that isn't a drawing's flattened copy (the image picker
/// makes those itself; `FLAT_FROM`). Avatars and banners are public, so never in view here; a
/// sound or a film isn't an image. The annotations are read only once a candidate exists.
async fn uploaded_an_image(
    data: &Store,
    view: &crate::record::documents::DocumentsView,
) -> Result<bool> {
    let pictures: Vec<[u8; 16]> = view
        .docs
        .iter()
        .filter(|(_, d)| d.lane == "private")
        .filter(|(_, d)| {
            d.display_head().is_some_and(|h| match Format::from_wire(h.header.format) {
                Format::Avif | Format::Apng => true,
                Format::WebmAv1 => h.header.animation,
                _ => false,
            })
        })
        .map(|(id, _)| *id)
        .collect();
    if pictures.is_empty() {
        return Ok(false);
    }
    let copies: HashSet<[u8; 16]> = data
        .annotations()
        .all()
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .into_iter()
        .filter(|r| r.fields.contains_key(FLAT_FROM))
        .filter_map(|r| hex::decode(&r.doc_id).ok()?.try_into().ok())
        .collect();
    Ok(pictures.iter().any(|id| !copies.contains(id)))
}

/// Is this notebook hrseWriter's? The client's `appTypeOf` (js/pure/apps.js), restated: the
/// reserved notebooks (`chat`, `files`) are nobody's; a notebook named for an app's style is that
/// app's (`default` is Writer's, `feed` and `drawing` aren't); any other is the app it's registered
/// to, and Writer's when it's registered to none.
fn is_writer_notebook(name: &str, registered: &HashMap<String, String>) -> bool {
    match name {
        "chat" | "files" | "feed" | "drawing" => false,
        "default" => true,
        _ => registered.get(name).is_none_or(|app| app.is_empty() || app == "default"),
    }
}

/// Has this persona a private note in hrseWriter? A private text document (Marquee or plain)
/// filed in a Writer notebook - not a Feed draft, a room's, or a picture. The notebooks are read
/// only once a private text document exists at all.
async fn wrote_a_private_note(
    data: &Store,
    view: &crate::record::documents::DocumentsView,
) -> Result<bool> {
    let notes: Vec<&[u8; 16]> = view
        .docs
        .iter()
        .filter(|(_, d)| d.lane == "private")
        .filter(|(_, d)| {
            d.display_head().is_some_and(|h| {
                matches!(Format::from_wire(h.header.format), Format::Marquee | Format::Plaintext)
            })
        })
        .map(|(id, _)| id)
        .collect();
    if notes.is_empty() {
        return Ok(false);
    }
    let filed = data.buckets().all().await.map_err(|e| anyhow::anyhow!("{e}"))?;
    let registered: HashMap<String, String> = data
        .buckets()
        .roster()
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .into_iter()
        .map(|b| (b.name, b.app))
        .collect();
    Ok(notes.into_iter().any(|id| {
        filed.get(id).is_some_and(|names| names.iter().any(|n| is_writer_notebook(n, &registered)))
    }))
}

/// Has somebody else set interest in this persona of their own accord? "Follow a stranger" turned
/// round: a published edge naming this persona with an interest band (a trust alone is no follow).
/// Never the node's doing - the group this persona joined follows it automatically, both ways
/// (Starter Friends only ever goes from the newcomer) - and never this account's own other
/// personas, or following yourself would pay.
async fn got_a_follower(state: &AppState, root_hex: &str) -> Result<bool> {
    let followers: Vec<String> = crate::edgegraph::edges_naming(&state.node_db, root_hex)
        .await?
        .into_iter()
        .filter(|(_, _, interest)| {
            interest.as_deref().is_some_and(|i| matches!(i, "low" | "medium" | "high" | "max"))
        })
        .map(|(author, _, _)| author)
        .collect();
    if followers.is_empty() {
        return Ok(false);
    }
    let mut not_strangers: HashSet<String> = crate::groups::paired_with(state, root_hex)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .into_iter()
        .collect();
    if let Some(account) = crate::identity::account_of(&state.node_db, root_hex)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?
    {
        if let Ok(account) = account.parse::<uuid::Uuid>() {
            for persona in crate::identity::list_for_account(&state.node_db, &account)
                .await
                .map_err(|e| anyhow::anyhow!("{e}"))?
            {
                not_strangers.insert(persona.root_pubkey);
            }
        }
    }
    Ok(followers.iter().any(|f| f != root_hex && !not_strangers.contains(f)))
}

/// Has this persona set interest in somebody of its own accord? A contact with interest set (and
/// not "none") that the node didn't follow for them: no `auto` mark (starters.rs, groups.rs), and -
/// for follows made before the mark - not one of this node's starters, its operator's auto-follow
/// list, or the group this persona joined. The node's lists are read only once a candidate exists.
async fn followed_a_stranger(state: &AppState, data: &Store, root_hex: &str) -> Result<bool> {
    let contacts = data.contacts().await.map_err(|e| anyhow::anyhow!("{e}"))?;
    let candidates: Vec<String> = contacts
        .into_iter()
        .filter(|(root, facts)| {
            root != root_hex
                && !facts.contains_key(crate::starters::AUTO_KEY)
                && facts.get("interest").is_some_and(|i| !i.trim().is_empty() && i.trim() != "none")
        })
        .map(|(root, _)| root)
        .collect();
    if candidates.is_empty() {
        return Ok(false);
    }
    let mut automatic: HashSet<String> =
        state.config.starter_contacts.iter().map(|s| hex::encode(s.root)).collect();
    for a in
        crate::starters::auto_follow(&state.node_db).await.map_err(|e| anyhow::anyhow!("{e}"))?
    {
        automatic.insert(a.root);
    }
    for peer in
        crate::groups::paired_with(state, root_hex).await.map_err(|e| anyhow::anyhow!("{e}"))?
    {
        automatic.insert(peer);
    }
    Ok(candidates.iter().any(|r| !automatic.contains(r)))
}

/// The private annotation a drawing's flattened copy carries - the drawing it is a picture of
/// (js/pure/flatcopy.js `FLAT_FROM`): how a picture in a post is known to be a drawing.
const FLAT_FROM: &str = "flattened_from";

/// Has this persona published a post holding a drawing? A drawing published as itself, or a note
/// whose embeds include a drawing's flattened copy (the image picker's road). Lookups in what the
/// pass already holds - which note each post came from, and that note's embeds - and the
/// annotations read once, only if some published note embeds anything. No body is opened.
async fn posted_a_drawing(
    data: &Store,
    view: &crate::record::documents::DocumentsView,
    claimed: &HashMap<[u8; 16], [u8; 16]>,
) -> Result<bool> {
    let mut flat: Option<HashSet<[u8; 16]>> = None;
    for (post_id, post) in &view.docs {
        if post.lane != "public" || post.display_head().is_none() {
            continue;
        }
        let Some(note) = claimed.get(post_id).and_then(|n| view.docs.get(n)) else { continue };
        let Some(head) = note.display_head() else { continue };
        if Format::from_wire(head.header.format) == Format::Drawing {
            return Ok(true);
        }
        if head.header.refs.is_empty() {
            continue;
        }
        if flat.is_none() {
            let rows = data.annotations().all().await.map_err(|e| anyhow::anyhow!("{e}"))?;
            flat = Some(
                rows.into_iter()
                    .filter(|r| r.fields.contains_key(FLAT_FROM))
                    .filter_map(|r| hex::decode(&r.doc_id).ok()?.try_into().ok())
                    .collect(),
            );
        }
        if head.header.refs.iter().any(|r| flat.as_ref().is_some_and(|f| f.contains(r))) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// A tag a person chose, as a contract counts one: not an emoji (a reaction) and not one of the
/// implicit tags a post says of itself (a length, a medium).
fn chosen_tag(tag: &str) -> bool {
    let tag = tag.trim();
    !tag.is_empty()
        && !crate::annotations::is_emoji_tag(tag)
        && !crate::record::documents::IMPLICIT_TAGS.contains(&tag)
}

/// Has one of this persona's private notes a link to another? The search index's stored links
/// (no refresh), each naming the document it points at when it's one of ours.
async fn linked_two_notes(
    data: &Store,
    view: &crate::record::documents::DocumentsView,
) -> Result<bool> {
    let private = |hex: &str| {
        hex::decode(hex)
            .ok()
            .and_then(|b| <[u8; 16]>::try_from(b.as_slice()).ok())
            .and_then(|id| view.docs.get(&id))
            .is_some_and(|d| d.lane == "private")
    };
    let rows = crate::record::documents::stored_links(data.db())
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(rows.into_iter().any(|(from, links)| {
        view.docs.get(&from).is_some_and(|d| d.lane == "private")
            && links
                .iter()
                .filter_map(|l| l.doc.as_deref())
                .any(|to| to != hex::encode(from) && private(to))
    }))
}

/// Has a note been filed in a section of a notebook's tree? A section is a taxonomy inside a
/// notebook's tree (the `wiki:` roots); one holding a document directly is a note organized.
async fn organized_a_note(data: &Store) -> Result<bool> {
    fn section_holds_a_note(node: &crate::record::store::TaxonomyNode, depth: usize) -> bool {
        node.members.iter().flatten().any(|m| match &m.taxonomy {
            Some(sub) => section_holds_a_note(sub, depth + 1),
            None => depth > 0,
        })
    }
    let roots = data.taxonomies().all().await.map_err(|e| anyhow::anyhow!("{e}"))?;
    for root in roots.iter().filter(|t| t.title.starts_with("wiki:")) {
        let tree =
            data.taxonomies().tree(&root.taxonomy_id).await.map_err(|e| anyhow::anyhow!("{e}"))?;
        if section_holds_a_note(&tree, 0) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Does this persona's account hold another persona? Every persona of an account that has made
/// a second is done (Curtis, 2026-10-05): the new one starts with it achieved, or a completionist
/// would make personas forever, each one's contract waiting on the next.
async fn made_a_second_persona(state: &AppState, root_hex: &str) -> Result<bool> {
    let Some(account) = crate::identity::account_of(&state.node_db, root_hex)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?
    else {
        return Ok(false);
    };
    let Ok(account) = uuid::Uuid::parse_str(&account) else { return Ok(false) };
    let personas = crate::identity::list_for_account(&state.node_db, &account)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(personas.iter().any(|p| p.root_pubkey != root_hex))
}

/// Is this persona on a second computer? Its key tree holds an Active key besides the root and
/// the recovery key - every persona is born with those two, on the root and the all-zeros spine
/// (identity.rs `designated_recovery`); an adopted computer's key is anywhere else.
async fn on_another_computer(data: &Store, root_hex: &str) -> Result<bool> {
    use ringtome_proto::crown::KeyStatus;
    let tree = crate::record::imaol::load_key_tree(data.db(), root_hex)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let adopted = tree.members().any(|(pk, status)| {
        status == KeyStatus::Active
            && tree.rank_path(pk).is_some_and(|p| !p.is_empty() && !p.iter().all(|&r| r == 0))
    });
    Ok(adopted)
}

/// A contract reached: recorded on the private chain first, then said in hrseMsg - by this
/// computer alone, the one that recorded it; a second computer, finding it recorded, pays and
/// says nothing.
async fn complete_contract(
    state: &AppState,
    data: &Store,
    root_hex: &str,
    id: &str,
    done: &mut HashMap<String, i64>,
) -> Result<()> {
    let Some(c) = CONTRACTS.iter().find(|c| c.id == id) else { return Ok(()) };
    let at = crate::clock::now_ms();
    data.private_registers(CONTRACTS_KV).set(c.id, &at.to_string()).await?;
    done.insert(c.id.to_string(), at);
    let detail = json!({ "name": c.name, "pennies": c.pennies.to_string() }).to_string();
    if let Err(e) =
        crate::notifications::note_contract(&state.node_db, root_hex, c.id, &detail).await
    {
        tracing::warn!(error = ?e, "a completed contract's message wasn't stored");
    }
    Ok(())
}

/// The completed contracts, as the private chain records them: id -> when.
async fn contracts_done(data: &Store) -> Result<HashMap<String, i64>> {
    let (recorded, _) = data.private_registers(CONTRACTS_KV).all().await?;
    Ok(recorded
        .into_iter()
        .filter_map(|r| r.value.trim().parse::<i64>().ok().map(|at| (r.key, at)))
        .collect())
}

/// A drawing's marking strokes - what "draw" counts: a move, copy, crop or transform moves marks
/// already made, and an eraser takes them away.
fn marks_in(body: &[u8]) -> usize {
    crate::drawing::read(body)
        .strokes
        .iter()
        .filter(|s| !matches!(s.tool, "move" | "copy" | "crop" | "transform" | "eraser"))
        .count()
}

/// Drawing heads already looked at for "Draw a horse", process-wide: each head is read at most once
/// while the contract is open - a version's body never changes, so its answer never does.
static DRAWINGS_LOOKED_AT: LazyLock<Mutex<HashSet<[u8; 32]>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// The post the magic words paid for under the once-per-persona rule (until 2026-10-05), if they
/// did: its line keeps standing, and that post isn't paid again under the per-post rule.
async fn magic_paid_once(data: &Store) -> Result<Option<String>> {
    let row: Option<(String,)> = data
        .db()
        .fetch_optional(
            "SELECT detail FROM bank_lines WHERE kind = 'magic_words' AND source = 'once'",
            (),
        )
        .await?;
    Ok(row.and_then(|(detail,)| {
        serde_json::from_str::<serde_json::Value>(&detail).ok()?["post"].as_str().map(String::from)
    }))
}

/// The first of the magic words a post says, any case. Run on words the publication pass has
/// already read - nine substring checks, never a read of its own.
fn magic_words_in(body: &[u8]) -> Option<&'static str> {
    let text = String::from_utf8_lossy(body).to_lowercase();
    MAGIC_WORDS.into_iter().find(|w| text.contains(w))
}

// The instruments (HORSE_BASED_CURRENCIES.md, "HorseBonds"; Curtis, 2026-09-29).
/// Where purchases live: the persona's private registers, one key per purchase, synced to their
/// own computers - two computers buying at once make two bonds, and both stand.
pub const INSTRUMENTS: &str = "horse_instruments";
/// The debt ceiling (Curtis, 2026-10-06): debt interest stops at the most negative 64-bit number of
/// horsepennies, about -9.2 x 10^16 H$ - "eleventy horsejillion dollars of horsedebt just sounds
/// mean". The ledger itself has no floor; this only stops interest growing a debt past it.
const DEBT_CEILING: i64 = i64::MIN;
/// A day's charge on a balance below zero: 2% of it, toward zero (BigInt's division truncates), and
/// never past the ceiling - a charge that would carry the debt beyond it charges only the way
/// there, and a debt at or past it, nothing.
fn debt_charge(balance: &BigInt, ceiling: &BigInt) -> BigInt {
    (balance * DEBT_RATE.0 / DEBT_RATE.1).max(ceiling - balance).min(BigInt::zero())
}

/// A HorseBond's smallest price, and how many heartbeat days it pays before it returns its price.
pub const BOND_MIN: i64 = 2000 * HORSEBUCK;
/// And at most a million (Curtis, 2026-09-30: "past that users will require a better financial
/// instrument").
pub const BOND_MAX: i64 = 1_000_000 * HORSEBUCK;
const BOND_DAYS: usize = 100;
/// Debt's daily compounding, as a rational: 2%.
const DEBT_RATE: (i64, i64) = (2, 100);

// ---------------------------------------------------------------------------------------------
// Measuring what's new

fn hash64(bytes: &[u8]) -> u64 {
    u64::from_be_bytes(blake3::hash(bytes).as_bytes()[..8].try_into().expect("eight bytes"))
}

/// A text's distinct three-word shingles: lowercased, everything but letters and digits a space,
/// every overlapping run of three words. A text of one or two words is one shingle.
pub fn shingles(text: &str) -> HashSet<u64> {
    let normal: String = text
        .chars()
        .map(|c| if c.is_alphanumeric() { c.to_lowercase().next().unwrap_or(c) } else { ' ' })
        .collect();
    let words: Vec<&str> = normal.split_whitespace().collect();
    if words.len() < 3 {
        return if words.is_empty() {
            HashSet::new()
        } else {
            HashSet::from([hash64(words.join(" ").as_bytes())])
        };
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
        None | Some(Format::Marquee) | Some(Format::Plaintext) => {
            (shingles(&String::from_utf8_lossy(body)).len() as i64, 0)
        }
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
    pennies: BigInt,
    at_ms: i64,
    detail: serde_json::Value,
}

async fn banked(data: &Store) -> Result<HashSet<(String, String)>> {
    let rows: Vec<(String, String)> =
        data.db().fetch_all("SELECT kind, source FROM bank_lines", ()).await?;
    Ok(rows.into_iter().collect())
}

async fn bank(data: &Store, lines: Vec<Line>) -> Result<()> {
    for l in lines {
        data.db()
            .execute(
                "INSERT OR IGNORE INTO bank_lines (kind, source, pennies, at_ms, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
                (l.kind, l.source, l.pennies.to_string(), l.at_ms, l.detail.to_string()),
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
    let rows: Vec<(String, String)> = data
        .db()
        .fetch_all("SELECT source, detail FROM bank_lines WHERE kind = 'publication'", ())
        .await?;
    for (source, detail) in rows {
        let rules = serde_json::from_str::<serde_json::Value>(&detail)
            .ok()
            .and_then(|d| d["rules"].as_i64())
            .unwrap_or(1);
        if rules < PUBLICATION_RULES {
            data.db()
                .execute(
                    "DELETE FROM bank_lines WHERE kind = 'publication' AND source = ?1",
                    (source,),
                )
                .await?;
        }
    }
    Ok(())
}

/// One catch-up at a time per persona. The corner polls its balance, and a slow pass used to
/// meet the next poll's pass, and the next: three walks of the same shelf at once, each holding
/// the persona's database (2026-10-01). A second caller waits for the first, then finds its work
/// already banked.
static CATCHING_UP: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Bring the ledger up to date with what this computer holds.
pub async fn catch_up(state: &AppState, data: &Store, root_hex: &str) -> Result<()> {
    let lane = CATCHING_UP
        .lock()
        .expect("bank lanes poisoned")
        .entry(root_hex.to_string())
        .or_default()
        .clone();
    let _turn = lane.lock().await;
    catch_up_now(state, data, root_hex).await
}

/// How long the corner may go without a catch-up while the persona's own files sit still: the
/// earnings those files don't record (a chat line, a reaction - node.db's) show within this.
const CORNER_RECHECK: std::time::Duration = std::time::Duration::from_secs(60);

/// Per persona: when the corner last caught up, and the database files' mtime just BEFORE it
/// ran - so a write landing during the run reads as a change, and the next poll runs again.
static CORNER_SEEN: LazyLock<Mutex<HashMap<String, (std::time::Instant, i64)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The corner balance's catch-up: skipped while the persona's files haven't moved since the
/// last one and it was under a minute ago. The corner asks every ten seconds and on every
/// autosave, and each catch-up walks the persona's whole history - its documents, its chats,
/// its heartbeats - to find, nearly always, nothing new; on a large persona that was seconds
/// of its one database connection per ask, queued in front of everything the person was
/// actually doing (2026-10-02). The bank page itself always catches up in full.
async fn catch_up_for_corner(state: &AppState, data: &Store, root_hex: &str) -> Result<()> {
    let files = state.user_dbs.db_mtime_ms(root_hex);
    let started = std::time::Instant::now();
    if let Some(files) = files {
        let seen = CORNER_SEEN.lock().expect("corner marks poisoned").get(root_hex).copied();
        if seen.is_some_and(|(at, mtime)| mtime == files && at.elapsed() < CORNER_RECHECK) {
            return Ok(());
        }
    }
    catch_up(state, data, root_hex).await?;
    if let Some(files) = files {
        CORNER_SEEN
            .lock()
            .expect("corner marks poisoned")
            .insert(root_hex.to_string(), (started, files));
    }
    Ok(())
}

async fn catch_up_now(state: &AppState, data: &Store, root_hex: &str) -> Result<()> {
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
                        lines.push(Line {
                            kind: "image",
                            source,
                            pennies: BigInt::from(PER_IMAGE),
                            at_ms: v.timestamp_ms,
                            detail: json!({ "title": title }),
                        });
                    }
                }
                Format::Marquee | Format::Plaintext | Format::Drawing => {
                    let (kind, rate) = if format == Format::Drawing {
                        ("strokes", PER_STROKE)
                    } else {
                        ("words", PER_WORD)
                    };
                    let source = hex::encode(hash);
                    if !is_new(kind, &source) {
                        continue;
                    }
                    let Some(body) = body_of(v).await else { continue };
                    let measure = |b: &[u8]| {
                        if format == Format::Drawing {
                            stroke_shapes(b)
                        } else {
                            shingles(&String::from_utf8_lossy(b))
                        }
                    };
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
                    lines.push(Line {
                        kind,
                        source,
                        pennies: BigInt::from(added * rate),
                        at_ms: v.timestamp_ms,
                        detail: json!({ "title": title, "count": added }),
                    });
                }
                _ => {}
            }
        }
    }

    // Publications: once per note, the private amounts again plus the size bonus. Who claims
    // each post, read once for them all (a fold per post was minutes at 700 posts, 2026-10-01).
    let claimed = data.annotations().notes_claiming().await.unwrap_or_default();
    // The magic words pay once per post that says them (2026-10-05). A persona paid under the old
    // once-ever rule keeps that line, and the post it named isn't paid a second time.
    let paid_once = magic_paid_once(data).await?;
    for (post_id, doc) in &view.docs {
        if doc.lane != "public" {
            continue;
        }
        let Some(v) = doc.versions.values().min_by_key(|v| v.timestamp_ms) else { continue };
        if !matches!(Format::from_wire(v.header.format), Format::Marquee | Format::Plaintext) {
            continue;
        }
        let note = claimed.get(post_id).copied();
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
            None if !v.header.trusted_only => state
                .files
                .get_public(iroh_blobs::Hash::from_bytes(v.header.file_hash))
                .await
                .ok()
                .flatten(),
            None => None,
        };
        let Some(body) = body else { continue };
        let post_hex = hex::encode(post_id);
        if note_format != Some(Format::Drawing)
            && is_new("magic_words", &post_hex)
            && paid_once.as_deref() != Some(post_hex.as_str())
        {
            if let Some(said) = magic_words_in(&body) {
                lines.push(Line {
                    kind: "magic_words",
                    source: post_hex.clone(),
                    pennies: BigInt::from(PER_MAGIC_WORDS),
                    at_ms: v.timestamp_ms,
                    detail: json!({ "title": v.header.title, "post": hex::encode(post_id), "said": said }),
                });
            }
        }
        let (words, strokes) = publication_measure(note_format, &body);
        let images = v.header.refs.iter().collect::<HashSet<_>>().len() as i64;
        let size = words + 50 * images + strokes / 2;
        let bonus = publication_bonus(size) * HORSEBUCK;
        let again = words * PER_WORD + images * PER_IMAGE + strokes * PER_STROKE;
        lines.push(Line {
            kind: "publication",
            source,
            pennies: BigInt::from(again + bonus),
            at_ms: v.timestamp_ms,
            detail: json!({ "title": v.header.title, "post": hex::encode(post_id), "words": words, "strokes": strokes, "images": images, "bonus": bonus, "rules": PUBLICATION_RULES }),
        });
    }

    // Heartbeats: one a day, however many computers sent one.
    if let Ok(entries) = crate::record::imaol::entries_of_type(
        data.db(),
        ringtome_proto::registry::service::PROFILE_PUBLIC,
        ringtome_proto::registry::entry_type::PROFILE_SET,
    )
    .await
    {
        for e in entries {
            let ringtome_proto::Payload::Inline(p) = &e.entry().payload else { continue };
            let Ok(ps) = ringtome_proto::ProfileSet::decode(p) else { continue };
            if ps.field != crate::heartbeat::FIELD {
                continue;
            }
            let Some(day) = crate::heartbeat::day_of_date(&ps.value) else { continue };
            if is_new("heartbeat", &ps.value)
                && !lines.iter().any(|l| l.kind == "heartbeat" && l.source == ps.value)
            {
                lines.push(Line {
                    kind: "heartbeat",
                    source: ps.value,
                    pennies: BigInt::from(PER_HEARTBEAT),
                    at_ms: i64::from(day) * 86_400_000,
                    detail: json!({}),
                });
            }
        }
    }

    // Chat: lines said, reactions given, reactions received.
    for (hash, at) in crate::chat::lines_by(&state.node_db, root_hex).await.unwrap_or_default() {
        if is_new("chat", &hash) {
            lines.push(Line {
                kind: "chat",
                source: hash,
                pennies: BigInt::from(PER_CHAT_LINE),
                at_ms: at,
                detail: json!({}),
            });
        }
    }
    for (hash, at) in crate::chat::reactions_by(&state.node_db, root_hex).await.unwrap_or_default()
    {
        if is_new("reaction", &hash) {
            lines.push(Line {
                kind: "reaction",
                source: hash,
                pennies: BigInt::from(PER_REACTION_GIVEN),
                at_ms: at,
                detail: json!({}),
            });
        }
    }
    for (hash, at, who) in
        crate::chat::reactions_to(&state.node_db, root_hex).await.unwrap_or_default()
    {
        if is_new("reacted", &hash) {
            lines.push(Line {
                kind: "reacted",
                source: hash,
                pennies: BigInt::from(PER_REACTION_RECEIVED),
                at_ms: at,
                detail: json!({ "by": who }),
            });
        }
    }

    // Post reactions: emoji said about posts, and about the persona's own.
    for a in crate::record::imaol::public_annotations(data.db()).await.unwrap_or_default() {
        if !a.present
            || a.key != "tag"
            || !crate::annotations::is_emoji_tag(&a.value)
            || a.target_author == root_hex
        {
            continue;
        }
        let source = format!("{}:{}:{}", a.target_author, hex::encode(a.target_doc), a.value);
        if is_new("post_reaction", &source) {
            lines.push(Line {
                kind: "post_reaction",
                source,
                pennies: BigInt::from(PER_REACTION_GIVEN),
                at_ms: a.received_at_ms,
                detail: json!({ "emoji": a.value }),
            });
        }
    }
    for (who, doc, emoji, at) in
        crate::annotations::emoji_received(&state.node_db, root_hex).await.unwrap_or_default()
    {
        let source = format!("{who}:{doc}:{emoji}");
        if is_new("post_reacted", &source) {
            lines.push(Line {
                kind: "post_reacted",
                source,
                pennies: BigInt::from(PER_REACTION_RECEIVED),
                at_ms: at,
                detail: json!({ "by": who, "emoji": emoji }),
            });
        }
    }

    // Published edges, either way: once per pair, ever.
    for (subject, row) in data.public_edges().published().await.unwrap_or_default() {
        if subject != root_hex && !row.edge.is_empty() && is_new("follow", &subject) {
            lines.push(Line {
                kind: "follow",
                source: subject.clone(),
                pennies: BigInt::from(PER_FOLLOW),
                at_ms: row.received_at_ms,
                detail: json!({ "of": subject }),
            });
        }
    }
    for (author, _, _) in
        crate::edgegraph::edges_naming(&state.node_db, root_hex).await.unwrap_or_default()
    {
        if author != root_hex && is_new("followed", &author) {
            lines.push(Line {
                kind: "followed",
                source: author.clone(),
                pennies: BigInt::from(PER_FOLLOW),
                at_ms: crate::clock::now_ms(),
                detail: json!({ "by": author }),
            });
        }
    }

    // Contracts: what the private chain says is done, and what is done now that it doesn't say yet.
    let mut done = contracts_done(data).await?;
    if !done.contains_key("draw-a-horse") {
        // The current head of each drawing, read once ever while the contract is open.
        let mut drew = false;
        for doc in view.docs.values() {
            if doc.lane != "private" {
                continue;
            }
            let Some(head) = doc.display_head() else { continue };
            if Format::from_wire(head.header.format) != Format::Drawing {
                continue;
            }
            if DRAWINGS_LOOKED_AT.lock().expect("looked-at poisoned").contains(&head.hash) {
                continue;
            }
            // A body not here yet is asked again on a later pass; one read is remembered.
            let Some(body) = body_of(head).await else { continue };
            DRAWINGS_LOOKED_AT.lock().expect("looked-at poisoned").insert(head.hash);
            if marks_in(&body) >= 3 {
                drew = true;
                break;
            }
        }
        if drew {
            complete_contract(state, data, root_hex, "draw-a-horse", &mut done).await?;
        }
    }
    // "Post your horse": a published post holding a drawing - posts from before the contract count.
    if !done.contains_key("post-a-horse") && posted_a_drawing(data, &view, &claimed).await? {
        complete_contract(state, data, root_hex, "post-a-horse", &mut done).await?;
    }
    // "Follow a stranger": interest set, of the person's own accord, in somebody.
    if !done.contains_key("follow-a-stranger") && followed_a_stranger(state, data, root_hex).await?
    {
        complete_contract(state, data, root_hex, "follow-a-stranger", &mut done).await?;
    }
    // "Create a private note": one, in a Writer notebook.
    if !done.contains_key("write-a-note") && wrote_a_private_note(data, &view).await? {
        complete_contract(state, data, root_hex, "write-a-note", &mut done).await?;
    }
    // "Upload an image": a picture of the person's own, not a drawing's copy.
    if !done.contains_key("upload-an-image") && uploaded_an_image(data, &view).await? {
        complete_contract(state, data, root_hex, "upload-an-image", &mut done).await?;
    }
    // The profile's contracts, off one read of it: a picture, a colourway - each set only by the
    // person (nothing sets an avatar or a colourway for them).
    if !done.contains_key("set-a-profile-picture") || !done.contains_key("choose-a-colorway") {
        let profile = data.profile().all().await.map_err(|e| anyhow::anyhow!("{e}"))?;
        let set =
            |field: &str| profile.iter().any(|f| f.field == field && !f.value.trim().is_empty());
        // "Set your profile picture": an avatar chosen.
        if !done.contains_key("set-a-profile-picture") && set("avatar") {
            complete_contract(state, data, root_hex, "set-a-profile-picture", &mut done).await?;
        }
        // "Customize your Colorway": any colourway chosen - the default too, chosen on purpose
        // (Curtis, 2026-10-04: opening the picker and choosing horse-relax counts).
        if !done.contains_key("choose-a-colorway") && set("colorway") {
            complete_contract(state, data, root_hex, "choose-a-colorway", &mut done).await?;
        }
    }
    // "Get a follower": the same, turned round.
    if !done.contains_key("get-a-follower") && got_a_follower(state, root_hex).await? {
        complete_contract(state, data, root_hex, "get-a-follower", &mut done).await?;
    }
    // The quick ones (2026-10-04): most read what this pass already holds.
    let said =
        |kind: &str| have.iter().any(|(k, _)| k == kind) || lines.iter().any(|l| l.kind == kind);
    if !done.contains_key("say-hello") && said("chat") {
        complete_contract(state, data, root_hex, "say-hello", &mut done).await?;
    }
    if !done.contains_key("react-to-a-post") && said("post_reaction") {
        complete_contract(state, data, root_hex, "react-to-a-post", &mut done).await?;
    }
    // A room of the persona's own - and a chat for two is a room too, with a contract of its own.
    // Which kind is the signed header's word (`chat::is_im`): the documents view is folded from
    // a memo that doesn't keep it. Read only while either contract is open, one header a room.
    if !done.contains_key("start-a-room") || !done.contains_key("start-a-chat-for-two") {
        let (mut room, mut im) = (false, false);
        for (doc_id, d) in &view.docs {
            let is_room = d.lane == "public"
                && d.display_head()
                    .is_some_and(|h| Format::from_wire(h.header.format) == Format::Room);
            if !is_room {
                continue;
            }
            if crate::chat::is_im(state, root_hex, doc_id).await {
                im = true;
            } else {
                room = true;
            }
        }
        if !done.contains_key("start-a-room") && room {
            complete_contract(state, data, root_hex, "start-a-room", &mut done).await?;
        }
        if !done.contains_key("start-a-chat-for-two") && im {
            complete_contract(state, data, root_hex, "start-a-chat-for-two", &mut done).await?;
        }
    }
    // "Seal a post": a post of the persona's own, trusted only - a room isn't a post here (every
    // chat for two is sealed without anyone choosing to seal it).
    if !done.contains_key("seal-a-post")
        && view.docs.values().any(|d| {
            d.lane == "public"
                && d.display_head().is_some_and(|h| {
                    h.header.trusted_only && Format::from_wire(h.header.format) != Format::Room
                })
        })
    {
        complete_contract(state, data, root_hex, "seal-a-post", &mut done).await?;
    }
    // "Share someone else's post": a share standing - the door refuses a share of one's own.
    if !done.contains_key("share-a-post")
        && data
            .rebroadcasts()
            .all()
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?
            .iter()
            .any(|r| !r.is_retracted())
    {
        complete_contract(state, data, root_hex, "share-a-post", &mut done).await?;
    }
    if !done.contains_key("make-a-second-persona") && made_a_second_persona(state, root_hex).await?
    {
        complete_contract(state, data, root_hex, "make-a-second-persona", &mut done).await?;
    }
    if !done.contains_key("bring-your-persona") && on_another_computer(data, root_hex).await? {
        complete_contract(state, data, root_hex, "bring-your-persona", &mut done).await?;
    }
    if !done.contains_key("buy-a-horsebond") && !bonds(data).await?.is_empty() {
        complete_contract(state, data, root_hex, "buy-a-horsebond", &mut done).await?;
    }
    if !done.contains_key("tag-a-private-note") {
        let rows = data.annotations().all().await.map_err(|e| anyhow::anyhow!("{e}"))?;
        if rows.iter().any(|r| r.tags.iter().any(|t| chosen_tag(t))) {
            complete_contract(state, data, root_hex, "tag-a-private-note", &mut done).await?;
        }
    }
    if !done.contains_key("tag-a-public-post") {
        let said_tags = crate::record::imaol::public_annotations(data.db())
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        if said_tags.iter().any(|a| a.present && a.key == "tag" && chosen_tag(&a.value)) {
            complete_contract(state, data, root_hex, "tag-a-public-post", &mut done).await?;
        }
    }
    if !done.contains_key("link-two-notes") && linked_two_notes(data, &view).await? {
        complete_contract(state, data, root_hex, "link-two-notes", &mut done).await?;
    }
    if !done.contains_key("organize-a-note") && organized_a_note(data).await? {
        complete_contract(state, data, root_hex, "organize-a-note", &mut done).await?;
    }
    for c in &CONTRACTS {
        if let Some(at) = done.get(c.id).filter(|_| is_new("contract", c.id)) {
            lines.push(Line {
                kind: "contract",
                source: c.id.to_string(),
                pennies: BigInt::from(c.pennies),
                at_ms: *at, // the recorded moment: the same line on every computer
                detail: json!({ "title": c.name }),
            });
        }
    }

    bank(data, lines).await?;
    instruments(data).await
}

/// One hrseBond as bought: its id (the register's key), price, when, and when it was sold, if it was.
pub struct Bond {
    pub id: String,
    pub pennies: i64,
    pub bought_ms: i64,
    pub sold_ms: Option<i64>,
}

/// Every instrument the persona holds, oldest first.
pub async fn bonds(data: &Store) -> Result<Vec<Bond>> {
    let (registers, _) = data
        .private_registers(INSTRUMENTS)
        .all()
        .await
        .map_err(|e| anyhow::anyhow!("reading instruments: {e}"))?;
    let mut out: Vec<Bond> = registers
        .into_iter()
        .filter_map(|r| {
            let v: serde_json::Value = serde_json::from_str(&r.value).ok()?;
            (v["kind"] == "horsebond").then_some(())?;
            Some(Bond {
                id: r.key,
                pennies: v["pennies"].as_str()?.parse().ok()?,
                bought_ms: v["bought_ms"].as_i64()?,
                sold_ms: v["sold_ms"].as_i64(),
            })
        })
        .collect();
    out.sort_by_key(|b| (b.bought_ms, b.id.clone()));
    Ok(out)
}

/// The instruments' lines, after the earnings: each bond's price out, its 1% a heartbeat day for
/// the hundred heartbeat days after the day it was bought, and its price back after the hundredth;
/// then debt - 2% of the balance, compounding, on every heartbeat day that ends below zero.
/// Heartbeat days are the ledger's own `heartbeat` lines: days, never a clock.
async fn instruments(data: &Store) -> Result<()> {
    let have = banked(data).await?;
    let is_new = |kind: &str, source: &str| !have.contains(&(kind.to_string(), source.to_string()));
    let days: Vec<String> = {
        let mut d: Vec<(String,)> = data
            .db()
            .fetch_all("SELECT source FROM bank_lines WHERE kind = 'heartbeat'", ())
            .await?;
        d.sort();
        d.into_iter().map(|(s,)| s).collect()
    };
    let day_ms =
        |date: &str| i64::from(crate::heartbeat::day_of_date(date).unwrap_or(0)) * 86_400_000;
    let mut lines: Vec<Line> = Vec::new();
    // Unlocks: each purchase's price out, once, at the moment it was bought.
    let owned = unlocks_owned(data).await?;
    for u in &UNLOCKS {
        if let Some(at) = owned.get(u.id).filter(|_| is_new("unlock", u.id)) {
            lines.push(Line {
                kind: "unlock",
                source: u.id.to_string(),
                pennies: BigInt::from(-u.pennies),
                at_ms: *at,
                detail: json!({ "title": u.name }),
            });
        }
    }
    // Commodities (2026-10-06): each lot's cost out when bought, each sale's takings in when sold,
    // at the prices the lot and the sale recorded - the same lines on every computer.
    let (lots, sales) = crate::commodities::holdings(data).await?;
    for lot in &lots {
        if is_new("commodity", &lot.id) {
            lines.push(Line {
                kind: "commodity",
                source: lot.id.clone(),
                pennies: -(&lot.units * &lot.price),
                at_ms: lot.bought_ms,
                detail: json!({ "commodity": lot.commodity, "units": lot.units.to_string(), "price": lot.price.to_string() }),
            });
        }
    }
    for sale in &sales {
        if is_new("commodity_sale", &sale.id) {
            let commodity = lots.iter().find(|l| l.id == sale.lot).map(|l| l.commodity.clone());
            lines.push(Line {
                kind: "commodity_sale",
                source: sale.id.clone(),
                pennies: &sale.units * &sale.price,
                at_ms: sale.sold_ms,
                detail: json!({ "commodity": commodity, "units": sale.units.to_string(), "price": sale.price.to_string() }),
            });
        }
    }
    for bond in bonds(data).await? {
        if is_new("bond", &bond.id) {
            lines.push(Line {
                kind: "bond",
                source: bond.id.clone(),
                pennies: BigInt::from(-bond.pennies),
                at_ms: bond.bought_ms,
                detail: json!({ "price": bond.pennies.to_string() }),
            });
        }
        let bought_day = crate::heartbeat::utc_date(bond.bought_ms);
        // A sold bond (2026-09-30) pays no day from the day it was sold, and never matures.
        let sold_day = bond.sold_ms.map(crate::heartbeat::utc_date);
        let paying: Vec<&String> = days
            .iter()
            .filter(|d| **d > bought_day && sold_day.as_ref().is_none_or(|s| *d < s))
            .take(BOND_DAYS)
            .collect();
        if let Some(sold) = bond.sold_ms {
            if is_new("bond_sold", &bond.id) {
                lines.push(Line {
                    kind: "bond_sold",
                    source: bond.id.clone(),
                    pennies: BigInt::from(bond.pennies),
                    at_ms: sold,
                    detail: json!({ "bond": bond.id }),
                });
            }
        }
        for (n, date) in paying.iter().enumerate() {
            let source = format!("{}:{date}", bond.id);
            if is_new("bond_interest", &source) {
                lines.push(Line {
                    kind: "bond_interest",
                    source,
                    pennies: BigInt::from(bond.pennies / 100),
                    at_ms: day_ms(date),
                    detail: json!({ "bond": bond.id, "day": n + 1 }),
                });
            }
        }
        if bond.sold_ms.is_none() && paying.len() == BOND_DAYS && is_new("bond_matured", &bond.id) {
            lines.push(Line {
                kind: "bond_matured",
                source: bond.id.clone(),
                pennies: BigInt::from(bond.pennies),
                at_ms: day_ms(paying[BOND_DAYS - 1]),
                detail: json!({ "bond": bond.id }),
            });
        }
    }
    bank(data, lines).await?;

    // Debt, day by day in order, each day's charge on the balance its predecessors left.
    let mut ledger: Vec<(i64, BigInt)> = data
        .db()
        .fetch_all::<(i64, String)>("SELECT at_ms, pennies FROM bank_lines", ())
        .await?
        .into_iter()
        .map(|(at, p)| (at, amount(&p)))
        .collect();
    let ceiling = BigInt::from(DEBT_CEILING);
    let mut charges: Vec<Line> = Vec::new();
    for date in &days {
        if !is_new("debt_interest", date) {
            continue;
        }
        let end = day_ms(date) + 86_400_000;
        let balance: BigInt = ledger.iter().filter(|(at, _)| *at < end).map(|(_, p)| p).sum();
        if !balance.is_negative() {
            continue;
        }
        let charge = debt_charge(&balance, &ceiling);
        if !charge.is_negative() {
            continue;
        }
        let at = end - 1;
        ledger.push((at, charge.clone()));
        charges.push(Line {
            kind: "debt_interest",
            source: date.clone(),
            pennies: charge,
            at_ms: at,
            detail: json!({ "balance": balance.to_string() }),
        });
    }
    bank(data, charges).await
}

#[derive(serde::Deserialize)]
pub struct BuyRequest {
    kind: String,
    /// Horsepennies, as a decimal string.
    pennies: String,
}

/// POST `/api/identity/{root}/bank/instruments` - buy one (hrseBonds, for now), if the balance
/// affords it. The purchase is a private register of its own; the ledger folds it on the next ask.
pub async fn buy_handler(
    session: crate::auth::Session,
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Path(root): axum::extract::Path<String>,
    axum::Json(req): axum::Json<BuyRequest>,
) -> Result<axum::Json<serde_json::Value>, crate::error::AppError> {
    use crate::error::AppError;
    if req.kind != "horsebond" {
        return Err(AppError::BadRequest(crate::msg!(
            "bank.no-such-instrument",
            "no such instrument"
        )));
    }
    let pennies: i64 = req.pennies.parse().map_err(|_| {
        AppError::BadRequest(crate::msg!("bank.not-an-amount", "that isn't an amount"))
    })?;
    if pennies < BOND_MIN {
        return Err(AppError::BadRequest(crate::msg!(
            "bank.a-horsebond-costs-at-least",
            "a hrseBond costs at least H$ 2,000"
        )));
    }
    if pennies > BOND_MAX {
        return Err(AppError::BadRequest(crate::msg!(
            "bank.a-hrsebond-costs-at-most",
            "a hrseBond costs at most H$ 1,000,000"
        )));
    }
    let data = crate::record::store::open(&state, &session.account.id, &root).await?;
    // No overdraft (Curtis, 2026-09-30: "should not allow any transaction that would spend more
    // money than the user has: overdraft is for special cases, not the average case"). Debt still
    // happens - two computers buying at once, each affording it alone - and is still charged.
    catch_up(&state, &data, &root).await.map_err(AppError::Internal)?;
    if balance(&data).await.map_err(AppError::Internal)? < BigInt::from(pennies) {
        return Err(AppError::BadRequest(crate::msg!(
            "bank.you-cant-afford-that",
            "you can't afford that"
        )));
    }
    let id = {
        use rand::RngCore;
        let mut b = [0u8; 16];
        rand::rngs::OsRng.fill_bytes(&mut b);
        hex::encode(b)
    };
    let value = json!({ "kind": "horsebond", "pennies": pennies.to_string(), "bought_ms": crate::clock::now_ms() }).to_string();
    data.private_registers(INSTRUMENTS).set(&id, &value).await?;
    catch_up(&state, &data, &root).await.map_err(AppError::Internal)?;
    Ok(axum::Json(json!({ "id": id })))
}

/// POST `/api/identity/{root}/bank/instruments/{id}/sell` - the way out of debt (Curtis,
/// 2026-09-30: "If you're in debt you should be allowed to sell bonds… now I need an out"). Only
/// while the balance is below zero; the bond returns its price, keeps what it already paid, and
/// pays nothing from the day it's sold. A matured or sold bond has nothing to sell.
pub async fn sell_handler(
    session: crate::auth::Session,
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Path((root, id)): axum::extract::Path<(String, String)>,
) -> Result<axum::Json<serde_json::Value>, crate::error::AppError> {
    use crate::error::AppError;
    let data = crate::record::store::open(&state, &session.account.id, &root).await?;
    catch_up(&state, &data, &root).await.map_err(AppError::Internal)?;
    if !balance(&data).await.map_err(AppError::Internal)?.is_negative() {
        return Err(AppError::BadRequest(crate::msg!(
            "bank.sell-only-in-debt",
            "a hrseBond can be sold only to get out of debt"
        )));
    }
    let Some(bond) =
        bonds(&data).await.map_err(AppError::Internal)?.into_iter().find(|b| b.id == id)
    else {
        return Err(AppError::NotFound(crate::msg!("bank.no-such-bond", "no such hrseBond")));
    };
    let matured: Option<(i64,)> = data
        .db()
        .fetch_optional(
            "SELECT 1 FROM bank_lines WHERE kind = 'bond_matured' AND source = ?1",
            (id.as_str(),),
        )
        .await
        .map_err(AppError::Internal)?;
    if bond.sold_ms.is_some() || matured.is_some() {
        return Err(AppError::BadRequest(crate::msg!(
            "bank.nothing-to-sell",
            "that hrseBond has nothing left to sell"
        )));
    }
    let value = json!({ "kind": "horsebond", "pennies": bond.pennies.to_string(), "bought_ms": bond.bought_ms, "sold_ms": crate::clock::now_ms() }).to_string();
    data.private_registers(INSTRUMENTS).set(&id, &value).await?;
    catch_up(&state, &data, &root).await.map_err(AppError::Internal)?;
    Ok(axum::Json(json!({ "sold": id })))
}

/// GET `/api/identity/{root}/bank/unlocks` - what's owned, and nothing else: the client's gates
/// at page load, before the corner's poll (which catches the ledger up first, and on a large
/// persona's first ask of the day that can take a while) has answered. One register read.
pub async fn unlocks_handler(
    session: crate::auth::Session,
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Path(root): axum::extract::Path<String>,
) -> Result<axum::Json<serde_json::Value>, crate::error::AppError> {
    let data = crate::record::store::open(&state, &session.account.id, &root).await?;
    let owned = unlocks_owned(&data).await.map_err(crate::error::AppError::Internal)?;
    Ok(axum::Json(json!({
        "unlocked": owned.keys().collect::<Vec<_>>(),
        "everything": owns_everything(&state, &owned),
    })))
}

#[derive(serde::Deserialize)]
pub struct UnlockRequest {
    id: String,
}

/// POST `/api/identity/{root}/bank/unlocks` - buy an unlock, if it's for sale to this persona: not
/// owned already, its prerequisites owned, and the balance pays it (the bonds' no-overdraft rule).
/// Two computers buying the same unlock at once record it twice in one register and pay once.
pub async fn unlock_handler(
    session: crate::auth::Session,
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Path(root): axum::extract::Path<String>,
    axum::Json(req): axum::Json<UnlockRequest>,
) -> Result<axum::Json<serde_json::Value>, crate::error::AppError> {
    use crate::error::AppError;
    if req.id == EVERYTHING {
        return unlock_everything(&state, &session, &root).await;
    }
    let Some(u) = UNLOCKS.iter().find(|u| u.id == req.id) else {
        return Err(AppError::BadRequest(crate::msg!("bank.no-such-unlock", "no such unlock")));
    };
    let data = crate::record::store::open(&state, &session.account.id, &root).await?;
    let owned = unlocks_owned(&data).await.map_err(AppError::Internal)?;
    if owned.contains_key(u.id) {
        return Err(AppError::BadRequest(crate::msg!(
            "bank.you-own-that-already",
            "that's yours already"
        )));
    }
    if u.requires.iter().any(|r| !owned.contains_key(*r)) {
        return Err(AppError::BadRequest(crate::msg!(
            "bank.unlock-the-others-first",
            "that one needs another unlock first"
        )));
    }
    catch_up(&state, &data, &root).await.map_err(AppError::Internal)?;
    if balance(&data).await.map_err(AppError::Internal)? < BigInt::from(u.pennies) {
        return Err(AppError::BadRequest(crate::msg!(
            "bank.you-cant-afford-that-2",
            "you can't afford that"
        )));
    }
    let at = crate::clock::now_ms();
    data.private_registers(UNLOCKS_KV).set(u.id, &at.to_string()).await?;
    catch_up(&state, &data, &root).await.map_err(AppError::Internal)?;
    Ok(axum::Json(json!({ "id": u.id, "bought_ms": at })))
}

/// The buy door's "Unlock everything": a node administrator's, once, for nothing - no balance to
/// check and no ledger line to pay.
async fn unlock_everything(
    state: &AppState,
    session: &crate::auth::Session,
    root: &str,
) -> Result<axum::Json<serde_json::Value>, crate::error::AppError> {
    use crate::error::AppError;
    if !node_admin(state, &session.account.id).await? {
        return Err(AppError::Forbidden(crate::msg!(
            "bank.only-node-admins-unlock-everything",
            "only a node administrator can unlock everything"
        )));
    }
    let data = crate::record::store::open(state, &session.account.id, root).await?;
    let owned = unlocks_owned(&data).await.map_err(AppError::Internal)?;
    if owned.contains_key(EVERYTHING) {
        return Err(AppError::BadRequest(crate::msg!(
            "bank.you-own-that-already",
            "that's yours already"
        )));
    }
    let at = crate::clock::now_ms();
    data.private_registers(UNLOCKS_KV).set(EVERYTHING, &at.to_string()).await?;
    Ok(axum::Json(json!({ "id": EVERYTHING, "bought_ms": at })))
}

/// A line put straight into the ledger, for the test rig only (`/test/credit`): funding a persona,
/// or sinking one into debt, without the months of earning either would take.
pub async fn credit_for_test(data: &Store, pennies: BigInt) -> Result<()> {
    let source = format!("{}", crate::clock::now_ms());
    bank(
        data,
        vec![Line {
            kind: "test_credit",
            source,
            pennies,
            at_ms: crate::clock::now_ms(),
            detail: json!({}),
        }],
    )
    .await
}

/// The balance, in horsepennies, summed exactly.
pub async fn balance(data: &Store) -> Result<BigInt> {
    let rows: Vec<(String,)> = data.db().fetch_all("SELECT pennies FROM bank_lines", ()).await?;
    Ok(rows.iter().map(|(p,)| amount(p)).sum())
}

/// Per persona: the corner's last balance, and the database files' mtime just BEFORE it was
/// summed - `CORNER_SEEN`'s discipline, so a write landing mid-sum reads as a change.
static CORNER_BALANCE: LazyLock<Mutex<HashMap<String, (i64, BigInt)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The corner's balance: the last sum while the persona's files sit still, summed afresh when
/// they move. `balance` reads every line the ledger holds, and after years that is tens of
/// thousands, on a poll every ten seconds - it logged slow 17 times in half an hour on scratch
/// (2026-10-06). A line only lands by a write, and a write moves the files. Buying, selling and
/// unlocking read `balance` itself: they must see the exact figure, and they are rare.
async fn corner_balance(state: &AppState, data: &Store, root_hex: &str) -> Result<BigInt> {
    let files = state.user_dbs.db_mtime_ms(root_hex);
    if let Some(files) = files {
        let seen = CORNER_BALANCE.lock().expect("corner balances poisoned").get(root_hex).cloned();
        if let Some((mtime, total)) = seen {
            if mtime == files {
                return Ok(total);
            }
        }
    }
    let total = balance(data).await?;
    if let Some(files) = files {
        CORNER_BALANCE
            .lock()
            .expect("corner balances poisoned")
            .insert(root_hex.to_string(), (files, total.clone()));
    }
    Ok(total)
}

/// A balance in pennies - a decimal string of any length, since balances are exact bigints
/// (bank.rs) - as HorseBucks: `-1,234.05`.
pub fn horsebucks(pennies: &str) -> String {
    let (sign, digits) = pennies.strip_prefix('-').map_or(("", pennies), |d| ("-", d));
    let digits = format!("{digits:0>3}");
    let (whole, cents) = digits.split_at(digits.len() - 2);
    let whole = whole.trim_start_matches('0');
    let whole = if whole.is_empty() { "0" } else { whole };
    let mut grouped = String::with_capacity(whole.len() + whole.len() / 3);
    for (i, digit) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    format!("{sign}{grouped}.{cents}")
}

/// A line's stored amount: a decimal string (0031_bank_lines_bigint.sql). Only ever written by
/// `bank`, so a string that doesn't parse is a corrupt row - read as nothing, and said so.
fn amount(text: &str) -> BigInt {
    text.parse().unwrap_or_else(|_| {
        tracing::warn!(text, "a ledger line's amount isn't a number");
        BigInt::zero()
    })
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
/// `?lines=0` is the corner balance's poll: the balance alone, caught up only when something
/// moved (`catch_up_for_corner`).
pub async fn bank_handler(
    session: crate::auth::Session,
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Path(root): axum::extract::Path<String>,
    axum::extract::Query(q): axum::extract::Query<BankQuery>,
) -> Result<axum::Json<serde_json::Value>, crate::error::AppError> {
    let data = crate::record::store::open(&state, &session.account.id, &root).await?;
    if q.lines == Some(0) {
        catch_up_for_corner(&state, &data, &root)
            .await
            .map_err(crate::error::AppError::Internal)?;
        let total =
            corner_balance(&state, &data, &root).await.map_err(crate::error::AppError::Internal)?;
        // The client's gates ride this poll (UNLOCKS.md, "The gate"): one register read.
        let owned = unlocks_owned(&data).await.map_err(crate::error::AppError::Internal)?;
        return Ok(axum::Json(json!({
            "balance": total.to_string(),
            "unlocked": owned.keys().collect::<Vec<_>>(),
            "everything": owns_everything(&state, &owned),
        })));
    }
    catch_up(&state, &data, &root).await.map_err(crate::error::AppError::Internal)?;
    let total = balance(&data).await.map_err(crate::error::AppError::Internal)?;
    // Every month's count and total, off the lines' own times.
    // And each kind's total: summed here, as bigints, never by SQL (whose SUM is 64-bit).
    let every: Vec<(String, i64, String)> = data
        .db()
        .fetch_all("SELECT kind, at_ms, pennies FROM bank_lines", ())
        .await
        .map_err(crate::error::AppError::Internal)?;
    let mut months: BTreeMap<String, (i64, BigInt)> = BTreeMap::new();
    let mut kinds: BTreeMap<String, BigInt> = BTreeMap::new();
    for (kind, at, p) in &every {
        let p = amount(p);
        *kinds.entry(kind.clone()).or_default() += &p;
        if p.is_zero() {
            continue;
        }
        let slot = months.entry(crate::heartbeat::utc_date(*at)[..7].to_string()).or_default();
        slot.0 += 1;
        slot.1 += p;
    }
    let month = q
        .month
        .clone()
        .filter(|m| months.contains_key(m))
        .or_else(|| months.keys().next_back().cloned());
    let (from, to) = month.as_deref().and_then(month_bounds).unwrap_or((0, 0));
    let rows: Vec<(String, String, String, i64, String)> = data
        .db()
        .fetch_all(
            "SELECT kind, source, pennies, at_ms, detail FROM bank_lines
             WHERE pennies <> '0' AND at_ms >= ?1 AND at_ms < ?2 ORDER BY at_ms DESC, kind, source LIMIT ?3",
            (from, to, q.lines.unwrap_or(5000).clamp(0, 20_000)),
        )
        .await
        .map_err(crate::error::AppError::Internal)?;
    let by_kind: BTreeMap<String, String> =
        kinds.into_iter().map(|(k, p)| (k, p.to_string())).collect();
    let lines: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|(kind, source, pennies, at_ms, detail)| {
            json!({
                "kind": kind,
                "source": source,
                "pennies": amount(&pennies).to_string(),
                "at_ms": at_ms,
                "detail": serde_json::from_str::<serde_json::Value>(&detail).unwrap_or_default(),
            })
        })
        .collect();
    // Each bond's progress, off its own lines.
    let paid: Vec<(String, String, String)> = data
        .db()
        .fetch_all("SELECT kind, source, pennies FROM bank_lines WHERE kind IN ('bond_interest', 'bond_matured')", ())
        .await
        .map_err(crate::error::AppError::Internal)?;
    let instruments: Vec<serde_json::Value> = bonds(&data)
        .await
        .map_err(crate::error::AppError::Internal)?
        .into_iter()
        .rev()
        .map(|b| {
            let prefix = format!("{}:", b.id);
            let days = paid.iter().filter(|(k, s, _)| k == "bond_interest" && s.starts_with(&prefix)).count();
            let earned: BigInt = paid.iter().filter(|(k, s, _)| k == "bond_interest" && s.starts_with(&prefix)).map(|(_, _, p)| amount(p)).sum();
            let matured = paid.iter().any(|(k, s, _)| k == "bond_matured" && *s == b.id);
            json!({ "id": b.id, "kind": "horsebond", "pennies": b.pennies.to_string(), "bought_ms": b.bought_ms, "days": days, "of_days": BOND_DAYS, "paid": earned.to_string(), "matured": matured, "sold": b.sold_ms.is_some() })
        })
        .collect();
    let months: Vec<serde_json::Value> = months
        .into_iter()
        .rev()
        .map(|(m, (count, pennies))| json!({ "month": m, "lines": count, "pennies": pennies.to_string() }))
        .collect();
    // The Contracts column (2026-10-04): every contract, done or not, with when.
    let done = contracts_done(&data).await.map_err(crate::error::AppError::Internal)?;
    let contracts: Vec<serde_json::Value> = CONTRACTS
        .iter()
        .map(|c| json!({ "id": c.id, "name": c.name, "pennies": c.pennies.to_string(), "requires": c.requires, "completed_ms": done.get(c.id) }))
        .collect();
    // The Market's unlocks (2026-10-05): every one, with when it was bought, if it was.
    let owned = unlocks_owned(&data).await.map_err(crate::error::AppError::Internal)?;
    let mut unlocks: Vec<serde_json::Value> = Vec::new();
    // "Unlock everything" first, for a node administrator - or for a persona that bought it while
    // its account was one, so the Unlocked list still says when.
    if owned.contains_key(EVERYTHING) || node_admin(&state, &session.account.id).await? {
        unlocks.push(json!({ "id": EVERYTHING, "name": "Unlock everything", "pennies": "0", "requires": [], "bought_ms": owned.get(EVERYTHING) }));
    }
    unlocks.extend(UNLOCKS.iter().map(|u| json!({ "id": u.id, "name": u.name, "pennies": u.pennies.to_string(), "requires": u.requires, "bought_ms": owned.get(u.id) })));
    Ok(axum::Json(json!({
        "balance": total.to_string(),
        "by_kind": by_kind,
        "instruments": instruments,
        "months": months,
        "month": month,
        "lines": lines,
        "contracts": contracts,
        "unlocks": unlocks,
        "everything": owns_everything(&state, &owned),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Debt charges 2% a day toward zero, and stops at the ceiling: the last charge only goes the
    /// way there, and a debt at or past it is charged nothing (Curtis, 2026-10-06).
    #[test]
    fn debt_charges_two_percent_and_stops_at_the_ceiling() {
        let ceiling = BigInt::from(DEBT_CEILING);
        let charge = |b: BigInt| debt_charge(&b, &ceiling);
        assert_eq!(charge(BigInt::from(-100_000)), BigInt::from(-2_000));
        assert_eq!(charge(BigInt::from(-49)), BigInt::zero(), "toward zero: under a penny is none");
        let near = &ceiling + 100;
        assert_eq!(charge(near), BigInt::from(-100), "only the way to the ceiling");
        assert_eq!(charge(ceiling.clone()), BigInt::zero(), "at it, nothing");
        assert_eq!(charge(&ceiling - 500), BigInt::zero(), "past it, nothing - and never a credit");
    }

    /// A balance is exact however big (HORSE_BASED_CURRENCIES.md, "Stinkingly broken numbers"):
    /// lines past every machine integer round-trip through their stored text and sum to the penny.
    #[test]
    fn amounts_past_every_machine_integer_stay_exact() {
        let huge: BigInt = BigInt::from(10).pow(700u32) + 1;
        let stored = huge.to_string();
        assert_eq!(amount(&stored), huge);
        let sum: BigInt = [stored.as_str(), "-1", "250000"].iter().map(|p| amount(p)).sum();
        assert_eq!(sum, BigInt::from(10).pow(700u32) + 250_000);
        assert_eq!(amount("not a number"), BigInt::zero());
    }

    /// The bigint rung keeps every line, its amount now text - and a line past 64 bits, written
    /// after it, comes back to the penny (0031_bank_lines_bigint.sql).
    #[tokio::test]
    async fn the_bigint_rung_keeps_the_ledger_and_widens_it() {
        let db = crate::db::test_memory_db().await;
        let ladder = crate::migrations::USER;
        crate::migrations::climb(&db, &ladder[..ladder.len() - 1], "user").await.unwrap();
        db.execute(
            "INSERT INTO bank_lines (kind, source, pennies, at_ms) VALUES ('heartbeat', 'a', -12345, 1), ('words', 'b', 9223372036854775807, 2)",
            (),
        )
        .await
        .unwrap();
        crate::migrations::climb(&db, ladder, "user").await.unwrap();
        let kept: Vec<(String, String)> = db
            .fetch_all("SELECT source, pennies FROM bank_lines ORDER BY source", ())
            .await
            .unwrap();
        assert_eq!(
            kept,
            vec![
                ("a".to_string(), "-12345".to_string()),
                ("b".to_string(), "9223372036854775807".to_string())
            ]
        );
        let past = (BigInt::from(i64::MAX) * 1000u32).to_string();
        db.execute(
            "INSERT INTO bank_lines (kind, source, pennies, at_ms) VALUES ('words', 'c', ?1, 3)",
            (past.clone(),),
        )
        .await
        .unwrap();
        let (back,): (String,) =
            db.fetch_one("SELECT pennies FROM bank_lines WHERE source = 'c'", ()).await.unwrap();
        assert_eq!(back, past);
    }

    /// Every unlock a contract or an unlock names exists, comes earlier in the Market than what
    /// needs it, and no two unlocks share an id: a typo would hide a contract forever.
    #[test]
    fn every_required_unlock_exists_and_comes_first() {
        let ids: Vec<&str> = UNLOCKS.iter().map(|u| u.id).collect();
        let unique: HashSet<&str> = ids.iter().copied().collect();
        assert_eq!(unique.len(), ids.len());
        for (n, u) in UNLOCKS.iter().enumerate() {
            for r in u.requires {
                let at = ids.iter().position(|i| i == r);
                assert!(at.is_some_and(|at| at < n), "{} needs {r}", u.id);
            }
        }
        for c in &CONTRACTS {
            for r in c.requires {
                assert!(unique.contains(r), "{} needs {r}", c.id);
            }
        }
    }

    /// "Draw" counts marks: a brush stroke is one, and a move, copy, crop, transform or eraser
    /// stroke isn't - three marks is a horse, as far as the contract is concerned.
    #[test]
    fn a_drawing_s_marks_are_its_strokes_that_mark() {
        let stroke = |tool: &str, n: u32| serde_json::json!({ "id": format!("{n:016x}"), "t": n, "tool": tool, "color": "#112233", "size": 4, "points": [n, n, 1, 2] });
        let body =
            |strokes: Vec<serde_json::Value>| serde_json::json!({ "strokes": strokes }).to_string();
        assert_eq!(marks_in(body(vec![stroke("brush", 1), stroke("brush", 2)]).as_bytes()), 2);
        assert_eq!(
            marks_in(
                body(vec![
                    stroke("brush", 1),
                    stroke("eraser", 2),
                    stroke("brush", 3),
                    stroke("brush", 4)
                ])
                .as_bytes()
            ),
            3
        );
        assert_eq!(marks_in(b"not a drawing"), 0);
    }

    /// Writer's notebooks, as the client reckons them: `default`, and any notebook registered to it
    /// or to nothing; never a reserved one, Feed's or Drawing's.
    #[test]
    fn a_notebook_is_writers_as_the_client_reckons_it() {
        let registered: HashMap<String, String> = [
            ("recipes".to_string(), "default".to_string()),
            ("sketches".to_string(), "drawing".to_string()),
            ("loose".to_string(), String::new()),
        ]
        .into();
        for (name, writers) in [
            ("default", true),
            ("recipes", true),
            ("loose", true),
            ("never-registered", true),
            ("sketches", false),
            ("feed", false),
            ("drawing", false),
            ("chat", false),
            ("files", false),
        ] {
            assert_eq!(is_writer_notebook(name, &registered), writers, "{name}");
        }
    }

    /// The magic words are found in any case, inside other words' company, and the first one said
    /// is the one named; nothing like them is them.
    #[test]
    fn the_magic_words_are_heard_in_any_case() {
        assert_eq!(magic_words_in(b"well, SHOW ME THE MONEY then"), Some("show me the money"));
        assert_eq!(magic_words_in(b"<b>Rosebud</b>"), Some("rosebud"));
        assert_eq!(magic_words_in(b"a pot of golden retrievers"), Some("pot of gold"));
        assert_eq!(magic_words_in(b"show me the honey"), None);
        assert_eq!(magic_words_in(b""), None);
    }

    /// Words are what's new: a paragraph pasted twice is one paragraph's shingles, and case and
    /// punctuation don't make a word new.
    #[test]
    fn shingles_count_what_repetition_never_adds() {
        let once = "The quick brown fox jumps over the lazy dog.";
        assert_eq!(shingles(once).len(), 7);
        assert_eq!(
            shingles(&format!("{once} {once}")).len(),
            9,
            "the seam adds two; the second copy adds none"
        );
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
        assert_eq!(
            publication_measure(Some(Format::Avif), b"\x89PNG noise noise noise"),
            (0, 0),
            "a picture brings no words"
        );
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
