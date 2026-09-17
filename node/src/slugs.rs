//! Node slugs (PROJECT_PLAN's The node's public face, rulings 6 and 7): a short address a hosted persona claims on
//! this node - `@cube-drone` - first come first served, a node fact that means nothing on
//! any other node. A persona holds at most two: the current, and the last it claimed, which
//! redirects to the current and which nobody else may take. Changing again drops the older;
//! retaking one's own last swaps the two; leaving the node releases both.
//!
//! Owns the `node_slugs` SQL (tests/conventions.rs).

use anyhow::{Context, Result};

use crate::db::Db;

pub const MIN_LEN: usize = 3;
pub const MAX_LEN: usize = 32;

/// The grammar: lowercase letters, digits and hyphens, three to thirty-two characters, no
/// leading or trailing hyphen. Uppercase is lowered and a leading `@` forgiven; anything
/// else is refused rather than repaired.
pub fn normalise(raw: &str) -> Option<String> {
    let s = raw.trim().trim_start_matches('@').to_lowercase();
    let n = s.chars().count();
    if !(MIN_LEN..=MAX_LEN).contains(&n) {
        return None;
    }
    if s.starts_with('-') || s.ends_with('-') {
        return None;
    }
    if !s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return None;
    }
    Some(s)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// The slug is this persona's current one now.
    Claimed,
    /// Another persona holds it, as its current or its last.
    Taken,
    /// Not a slug.
    Invalid,
}

/// `(current, last)` for a persona.
pub async fn of_root(node_db: &Db, root: &str) -> Result<(Option<String>, Option<String>)> {
    let rows: Vec<(String, i64)> = node_db
        .fetch_all("SELECT slug, standing FROM node_slugs WHERE root_pubkey = ?1", (root,))
        .await
        .context("reading a persona's slugs")?;
    let mut current = None;
    let mut last = None;
    for (slug, standing) in rows {
        if standing != 0 {
            current = Some(slug);
        } else {
            last = Some(slug);
        }
    }
    Ok((current, last))
}

/// Who holds a slug, and whether it is their current one.
pub async fn resolve(node_db: &Db, slug: &str) -> Result<Option<(String, bool)>> {
    let Some(slug) = normalise(slug) else { return Ok(None) };
    let row: Option<(String, i64)> = node_db
        .fetch_optional("SELECT root_pubkey, standing FROM node_slugs WHERE slug = ?1", (slug,))
        .await
        .context("resolving a slug")?;
    Ok(row.map(|(root, standing)| (root, standing != 0)))
}

/// Claim `raw` for `root` (ruling 7). The current, if any, becomes the last and the old last
/// goes; claiming one's own last swaps; claiming one's own current is a no-op.
pub async fn claim(node_db: &Db, root: &str, raw: &str) -> Result<Outcome> {
    let Some(slug) = normalise(raw) else { return Ok(Outcome::Invalid) };
    let now = crate::clock::now_ms();
    let held = resolve(node_db, &slug).await?;
    if let Some((holder, _)) = &held {
        if holder != root {
            return Ok(Outcome::Taken);
        }
    }
    let (current, last) = of_root(node_db, root).await?;
    if current.as_deref() == Some(slug.as_str()) {
        return Ok(Outcome::Claimed);
    }
    if last.as_deref() == Some(slug.as_str()) {
        // The swap: the last becomes current, the current becomes last.
        node_db
            .execute("UPDATE node_slugs SET standing = 1, noted_ms = ?2 WHERE slug = ?1", (slug.as_str(), now))
            .await
            .context("promoting a last slug")?;
        if let Some(c) = current {
            node_db
                .execute("UPDATE node_slugs SET standing = 0, noted_ms = ?2 WHERE slug = ?1", (c.as_str(), now))
                .await
                .context("demoting a current slug")?;
        }
        return Ok(Outcome::Claimed);
    }
    if let Some(l) = last {
        node_db
            .execute("DELETE FROM node_slugs WHERE slug = ?1", (l.as_str(),))
            .await
            .context("dropping the older slug")?;
    }
    if let Some(c) = current {
        node_db
            .execute("UPDATE node_slugs SET standing = 0, noted_ms = ?2 WHERE slug = ?1", (c.as_str(), now))
            .await
            .context("demoting a current slug")?;
    }
    node_db
        .execute(
            "INSERT INTO node_slugs (slug, root_pubkey, standing, noted_ms) VALUES (?1, ?2, 1, ?3)",
            (slug.as_str(), root, now),
        )
        .await
        .context("claiming a slug")?;
    Ok(Outcome::Claimed)
}

/// Give up the current slug: it becomes the last (the older last goes), so links keep
/// working a while longer; nothing else changes.
pub async fn drop_current(node_db: &Db, root: &str) -> Result<()> {
    let (current, last) = of_root(node_db, root).await?;
    let Some(c) = current else { return Ok(()) };
    if let Some(l) = last {
        node_db
            .execute("DELETE FROM node_slugs WHERE slug = ?1", (l.as_str(),))
            .await
            .context("dropping the older slug")?;
    }
    node_db
        .execute(
            "UPDATE node_slugs SET standing = 0, noted_ms = ?2 WHERE slug = ?1",
            (c.as_str(), crate::clock::now_ms()),
        )
        .await
        .context("demoting a current slug")?;
    Ok(())
}

/// A persona leaving the node releases both (ruling 7).
pub async fn release_root(node_db: &Db, root: &str) -> Result<()> {
    node_db
        .execute("DELETE FROM node_slugs WHERE root_pubkey = ?1", (root,))
        .await
        .context("releasing a persona's slugs")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_grammar() {
        assert_eq!(normalise("@Cube-Drone").as_deref(), Some("cube-drone"));
        assert_eq!(normalise("ab"), None, "too short");
        assert_eq!(normalise(&"a".repeat(33)), None, "too long");
        assert_eq!(normalise("-abc"), None);
        assert_eq!(normalise("abc-"), None);
        assert_eq!(normalise("a b"), None);
        assert_eq!(normalise("naïve"), None);
        assert_eq!(normalise("a-1-b").as_deref(), Some("a-1-b"));
    }

    #[tokio::test]
    async fn first_come_first_served_with_one_held_back() {
        let db = crate::db::test_node_db().await;
        let (ada, bea) = ("aa".repeat(32), "bb".repeat(32));
        assert_eq!(claim(&db, &ada, "cube-drone").await.unwrap(), Outcome::Claimed);
        assert_eq!(claim(&db, &bea, "cube-drone").await.unwrap(), Outcome::Taken);
        assert_eq!(claim(&db, &ada, "cube").await.unwrap(), Outcome::Claimed, "a change");
        assert_eq!(of_root(&db, &ada).await.unwrap(), (Some("cube".into()), Some("cube-drone".into())));
        assert_eq!(resolve(&db, "cube-drone").await.unwrap(), Some((ada.clone(), false)), "the last still resolves, not current");
        assert_eq!(claim(&db, &bea, "cube-drone").await.unwrap(), Outcome::Taken, "the last is held");
        assert_eq!(claim(&db, &ada, "cube-drone").await.unwrap(), Outcome::Claimed, "retaking one's own last");
        assert_eq!(of_root(&db, &ada).await.unwrap(), (Some("cube-drone".into()), Some("cube".into())), "the swap");
        assert_eq!(claim(&db, &ada, "drone").await.unwrap(), Outcome::Claimed, "a third");
        assert_eq!(of_root(&db, &ada).await.unwrap(), (Some("drone".into()), Some("cube-drone".into())), "the oldest dropped");
        assert_eq!(claim(&db, &bea, "cube").await.unwrap(), Outcome::Claimed, "and is free again");
        assert_eq!(claim(&db, &ada, "x").await.unwrap(), Outcome::Invalid);
        release_root(&db, &ada).await.unwrap();
        assert_eq!(of_root(&db, &ada).await.unwrap(), (None, None));
        assert_eq!(claim(&db, &bea, "drone").await.unwrap(), Outcome::Claimed, "released");
    }
}
