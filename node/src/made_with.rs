//! What a post was made with (plans/MCP.md, _Provenance_; Curtis, 2026-10-06: provenance is
//! "valuable enough metadata about a post that it's worth displaying as a tag - users might want
//! to filter out agentic posts in app").
//!
//! A write made with an API key marks the draft with a reserved tag: [`AI_AGENT`] when it came
//! through `/mcp`, [`API_KEY`] for any other key (auth/extractor.rs `Session::made_with`). The
//! tag is an ordinary private tag on the draft, so publishing carries it onto the post exactly
//! as it carries every other (identity/routes.rs `replicate_annotations`): signed by the author,
//! read by every node that holds the post, and narrowed out by the feed's own `not_tag` - nothing
//! new on the wire. Three rules make it a provenance rather than a tag:
//!
//! - **It sticks** (ruling 6). Nothing takes it off when a person edits the post afterwards: the
//!   draft keeps it, and every later publication restates it.
//! - **A person can remove it, a key can't** ([`refuse_by_key`]): removing it is the author
//!   vouching that the words are theirs, which only a signed-in browser may do - or an agent
//!   could edit a post and take its own label off.
//! - **The next keyed write puts it back.** [`mark`] runs on every write a key makes, so a
//!   removal clears the history up to that point and no further.
//!
//! It is the author's claim, not a proof: someone running their own node signs what they like.
//! The values are plain words, readable as they stand, so a node or a client that has never heard
//! of them still shows something true.

use crate::auth::Session;
use crate::error::AppError;
use crate::record::store::Store;

/// The tag on a post an AI agent wrote or published, through `/mcp`.
pub const AI_AGENT: &str = "ai-agent";
/// The tag on a post written or published with an API key some other way: a script, a
/// crossposter.
pub const API_KEY: &str = "api-key";

/// Is this one of the reserved tags?
pub fn is_reserved(tag: &str) -> bool {
    let tag = tag.trim();
    tag == AI_AGENT || tag == API_KEY
}

/// Mark a draft this request wrote or published with what it was made with - nothing for a
/// browser. A draft already marked is left alone: a tag restated is another entry on the
/// doc-meta chain, and an agent saving a note thirty times should not write thirty.
pub async fn mark(session: &Session, data: &Store, doc_id: &[u8; 16]) -> Result<(), AppError> {
    let Some(tag) = session.made_with() else { return Ok(()) };
    if !data.annotations().tags(doc_id).await?.iter().any(|t| t == tag) {
        data.annotations().tag(doc_id, tag).await?;
    }
    Ok(())
}

/// A key may not take a reserved tag off: only a person may vouch for their own words.
pub fn refuse_by_key(session: &Session, tag: &str) -> Result<(), AppError> {
    if session.key.is_some() && is_reserved(tag) {
        return Err(AppError::Forbidden(crate::msg!(
            "made-with.only-a-person-removes-it",
            "only a person can take the \"{tag}\" tag off, from a signed-in browser",
            tag = tag.trim()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reserved_tags_are_these_two_and_no_others() {
        assert!(is_reserved("ai-agent") && is_reserved(" api-key "));
        assert!(!is_reserved("agent") && !is_reserved("AI-AGENT") && !is_reserved("horses"));
    }
}
