//! One publish (plans/ONE_PUBLISH.md): the steps every publish road shares, written once. Slice
//! 1 is the date and the plan - what a draft's claimed date makes of a publish (now, or a
//! schedule, or a refusal), the plan a schedule leaves on the draft, and what the sweep says
//! when it can't carry a plan out. Every door asks here: the public publish and its drawing
//! door, a group's publish and its drawing door, and the publish-due sweep.

use crate::error::AppError;
use crate::record::store;
use serde::{Deserialize, Serialize};

/// The draft's claimed date (PUBLISH.md): its `display_date`, in the author's zone
/// (`tz_offset_min`, the browser's `getTimezoneOffset()`), re-read at every publish so a changed
/// date re-sorts the post everywhere.
pub async fn claimed(
    data: &store::Store,
    draft: &[u8; 16],
    tz_offset_min: i32,
) -> Result<Option<i64>, AppError> {
    Ok(data.annotations().field(draft, store::DISPLAY_DATE).await?.and_then(|v| {
        crate::record::documents::claimed_ms(&v, crate::clock::now_ms(), tz_offset_min)
    }))
}

/// What the publish is, as far as its date cares.
#[derive(Clone, Copy, Debug, Default)]
pub struct Shape {
    /// A reply: it answers what's there now.
    pub answers: bool,
    /// A room (or an IM, which is one): it opens now.
    pub room: bool,
    /// The post this draft already is, live where it's going, and the date it carries there:
    /// `Some(dated)` for an edit of a live post, `None` for a new one.
    pub live: Option<Option<i64>>,
}

/// What a publish does with its date.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum When {
    /// Post now, stamped with this claimed date (none: its mint time). `kept` when a future
    /// date was asked of a live post, which keeps the date it already carries (ruling 2).
    Now { dated_ms: Option<i64>, kept: bool },
    /// A schedule: nothing is posted until then (PUBLISH.md ruling 3).
    Later(i64),
}

/// The date's rulings, the same on every road (plans/ONE_PUBLISH.md):
///
/// - a past date, or none, posts now, dated so;
/// - a future date schedules a new post;
/// - but a reply or a room is refused one (ruling 1) - it answers, or opens, now;
/// - and an edit of a live post publishes now, keeping the date it carries (ruling 2): a date
///   never takes a live post back.
pub fn when(dated_ms: Option<i64>, shape: Shape, now_ms: i64) -> Result<When, AppError> {
    let Some(at) = dated_ms.filter(|at| *at > now_ms) else {
        return Ok(When::Now { dated_ms, kept: false });
    };
    if shape.answers || shape.room {
        return Err(AppError::BadRequest(crate::msg!(
            "publication.replies-and-rooms-are-now",
            "a reply or a room can't wait for a date - clear its date, or give it one that has passed"
        )));
    }
    match shape.live {
        Some(standing) => Ok(When::Now { dated_ms: standing, kept: true }),
        None => Ok(When::Later(at)),
    }
}

/// A schedule, on the draft's private meta (`store::PUBLISH_PLAN`): device-durable, minted by the
/// device `by` names so two devices never race. The same JSON every road has always written, so
/// a plan made before this module reads the same.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Plan {
    pub at: i64,
    pub by: String,
    #[serde(default)]
    pub settled: bool,
    #[serde(default)]
    pub trusted_only: bool,
    /// Into this group, for its members (plans/GROUPS.md, slice 4c), hex.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// In public, as this public group (plans/PUBLIC_GROUPS.md), hex.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub as_group: Option<String>,
}

/// Leave `plan` on the draft. A refusal said of an earlier plan is over: this is a new one.
pub async fn schedule(data: &store::Store, draft: &[u8; 16], plan: &Plan) -> Result<(), AppError> {
    let json = serde_json::to_string(plan)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("writing a publish plan: {e}")))?;
    data.annotations().set_field(draft, store::PUBLISH_PLAN, &json).await?;
    clear(data, draft, store::PUBLISH_REFUSED).await?;
    Ok(())
}

/// The draft's plan, if it has one this node can read.
pub async fn plan_of(data: &store::Store, draft: &[u8; 16]) -> Result<Option<Plan>, AppError> {
    Ok(data
        .annotations()
        .field(draft, store::PUBLISH_PLAN)
        .await?
        .filter(|p| !p.trim().is_empty())
        .and_then(|p| serde_json::from_str(&p).ok()))
}

/// The draft is posted, by hand or by its plan: the plan is spent, and so is any word that an
/// earlier one was refused.
pub async fn posted(data: &store::Store, draft: &[u8; 16]) -> Result<(), AppError> {
    clear(data, draft, store::PUBLISH_PLAN).await?;
    clear(data, draft, store::PUBLISH_REFUSED).await
}

/// A plan its day refused (ruling 3): spent, and the draft says why it wasn't posted, until its
/// author publishes it or schedules it again.
pub async fn refused(data: &store::Store, draft: &[u8; 16], why: &str) -> Result<(), AppError> {
    clear(data, draft, store::PUBLISH_PLAN).await?;
    data.annotations().set_field(draft, store::PUBLISH_REFUSED, why).await?;
    Ok(())
}

/// What the sweep's try at a plan leaves on the draft: posted, the plan spent; refused - the
/// node said no, in words, and would say it again - spent with why (ruling 3); anything else (the
/// node's own trouble: a database, a disk) leaves the plan for the next pass.
pub async fn settle<T>(
    data: &store::Store,
    draft: &[u8; 16],
    tried: &Result<T, AppError>,
) -> Result<(), AppError> {
    match tried {
        Ok(_) => posted(data, draft).await,
        Err(AppError::Internal(_)) => Ok(()),
        Err(e) => refused(data, draft, &e.to_string()).await,
    }
}

async fn clear(data: &store::Store, draft: &[u8; 16], field: &str) -> Result<(), AppError> {
    if data.annotations().field(draft, field).await?.is_some_and(|v| !v.is_empty()) {
        data.annotations().set_field(draft, field, "").await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_000_000;

    fn new_post() -> Shape {
        Shape::default()
    }

    #[test]
    fn a_past_date_or_none_posts_now() {
        assert_eq!(when(None, new_post(), NOW).unwrap(), When::Now { dated_ms: None, kept: false });
        assert_eq!(
            when(Some(NOW - 5), new_post(), NOW).unwrap(),
            When::Now { dated_ms: Some(NOW - 5), kept: false }
        );
    }

    #[test]
    fn a_future_date_schedules_a_new_post() {
        assert_eq!(when(Some(NOW + 5), new_post(), NOW).unwrap(), When::Later(NOW + 5));
    }

    #[test]
    fn a_reply_or_a_room_is_refused_a_future_date_and_only_a_future_one() {
        for shape in [Shape { answers: true, ..new_post() }, Shape { room: true, ..new_post() }] {
            assert!(when(Some(NOW + 5), shape, NOW).is_err());
            assert!(when(Some(NOW - 5), shape, NOW).is_ok());
            assert!(when(None, shape, NOW).is_ok());
        }
    }

    #[test]
    fn an_edit_of_a_live_post_publishes_now_and_keeps_its_date() {
        let live = Shape { live: Some(Some(NOW - 50)), ..new_post() };
        assert_eq!(
            when(Some(NOW + 5), live, NOW).unwrap(),
            When::Now { dated_ms: Some(NOW - 50), kept: true }
        );
        let undated = Shape { live: Some(None), ..new_post() };
        assert_eq!(
            when(Some(NOW + 5), undated, NOW).unwrap(),
            When::Now { dated_ms: None, kept: true }
        );
        // A past date re-dates a live post, as it always has (PUBLISH.md ruling 4).
        assert_eq!(
            when(Some(NOW - 9), live, NOW).unwrap(),
            When::Now { dated_ms: Some(NOW - 9), kept: false }
        );
    }

    #[test]
    fn a_plan_reads_the_json_every_road_has_written() {
        let old = r#"{"at":5,"by":"abc","settled":true,"trusted_only":false,"as_group":null}"#;
        let plan: Plan = serde_json::from_str(old).unwrap();
        assert_eq!((plan.at, plan.settled, plan.as_group), (5, true, None));
        let group: Plan = serde_json::from_str(r#"{"at":5,"by":"abc","group":"ff"}"#).unwrap();
        assert_eq!(group.group.as_deref(), Some("ff"));
    }
}
