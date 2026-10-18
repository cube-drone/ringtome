//! One publish (plans/ONE_PUBLISH.md): the steps every publish road shares, written once.
//!
//! - **Where it goes** (`To`): in public, into a group for its members, or in public as a public
//!   group - one value every door reads, with one table of what can't go where (`refuse`), one
//!   membership check (`admit`), and what each destination owes once a post is minted (`claim`,
//!   `after_public`).
//! - **What the draft already is there** (`live`): the post it became, and the date it carries.
//! - **The date and the plan**: what a draft's claimed date makes of a publish (now, a schedule,
//!   or a refusal), the plan a schedule leaves on the draft, and what the sweep says when it can't
//!   carry a plan out.
//!
//! Every door asks here: the public publish and its drawing door, a group's publish and its
//! drawing door, a book's rollout, and the publish-due sweep.

use crate::error::AppError;
use crate::record::store;
use crate::roster::GroupIdOf as GroupId;
use crate::AppState;
use serde::{Deserialize, Serialize};

/// Where a publish goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum To {
    /// The persona's own public chain.
    Public,
    /// Into a group, for its members (plans/GROUPS.md).
    Group(GroupId),
    /// In public, as a public group the persona is in (plans/PUBLIC_GROUPS.md): their own public
    /// post, which their lane for the group claims.
    AsGroup(GroupId),
}

impl To {
    /// The destination a request names: a group to post into, one to post in public as, or
    /// neither - never both.
    pub fn of(group: Option<&str>, as_group: Option<&str>) -> Result<To, AppError> {
        fn nonempty(g: Option<&str>) -> Option<&str> {
            g.map(str::trim).filter(|g| !g.is_empty())
        }
        match (nonempty(group), nonempty(as_group)) {
            (None, None) => Ok(To::Public),
            (Some(g), None) => Ok(To::Group(crate::roster::group_of(g)?)),
            (None, Some(g)) => Ok(To::AsGroup(crate::roster::group_of(g)?)),
            (Some(_), Some(_)) => Err(AppError::BadRequest(crate::msg!(
                "publication.one-place",
                "a post goes to one place: into a group, or in public as one"
            ))),
        }
    }

    /// The group it's for, either way.
    pub fn group(&self) -> Option<GroupId> {
        match self {
            To::Public => None,
            To::Group(g) | To::AsGroup(g) => Some(*g),
        }
    }
}

/// What is being published, as far as where it may go cares.
#[derive(Clone, Copy, Debug, Default)]
pub struct Asked {
    pub sealed: bool,
    pub room: bool,
    pub im: bool,
    pub book: bool,
}

/// What can't go where, the one table every door reads: a book in a group, or as one, isn't
/// sealed too - the group is who reads it, or everyone; a post as a public group is an open post,
/// never sealed, never a room (Curtis, 2026-10-18: "not now") or an IM. (A group's own doors take
/// no seal and no IM to be asked.)
pub fn refuse(to: &To, asked: Asked) -> Result<(), AppError> {
    match to {
        To::Public => Ok(()),
        To::Group(_) | To::AsGroup(_) if asked.book && asked.sealed => {
            Err(AppError::BadRequest(crate::msg!(
                "publication.a-groups-book-isnt-sealed",
                "a book in a group, or as one, isn't sealed too"
            )))
        }
        To::AsGroup(_) if asked.sealed || asked.room || asked.im => {
            Err(AppError::BadRequest(crate::msg!(
                "publication.as-the-group-is-open",
                "a post as the group is an open post - not sealed, not a room"
            )))
        }
        _ => Ok(()),
    }
}

/// May `root` post there? Into a group, or as one, while they're a member - and as one only if
/// it's public.
pub async fn admit(state: &AppState, root: &str, to: &To) -> Result<(), AppError> {
    match to {
        To::Public => Ok(()),
        To::Group(g) => crate::roster::may_post_in(state, root, &hex::encode(g)).await.map(|_| ()),
        To::AsGroup(g) => {
            crate::roster::may_post_as(state, root, &hex::encode(g)).await.map(|_| ())
        }
    }
}

/// What a post as the group owes once it's minted: the poster's public lane claims it as the
/// group's (once - an edit says nothing more). Nothing for anywhere else.
pub async fn claim(
    state: &AppState,
    data: &store::Store,
    root: &str,
    to: &To,
    post: [u8; 16],
) -> Result<(), AppError> {
    match to {
        To::AsGroup(g) => crate::roster::claim_public(state, data, root, *g, post).await,
        _ => Ok(()),
    }
}

/// Everything a public mint of `draft` owes, by any door - the publish, the drawing door, the
/// sweep: the post's own after-duties (`identity::after_posted`), then what its destination owes
/// (`claim`).
#[allow(clippy::too_many_arguments)]
pub async fn after_public(
    state: &AppState,
    data: &store::Store,
    root: &str,
    draft: &[u8; 16],
    post: [u8; 16],
    reply: Option<crate::record::documents::ReplyLinks>,
    flags: crate::record::documents::PublishFlags,
    to: &To,
) -> Result<(), AppError> {
    crate::identity::after_posted(state, data, root, draft, post, reply, flags).await?;
    claim(state, data, root, to, post).await
}

/// The post `draft` already is where it's going, live, and the date it carries (`Shape::live`):
/// `Some(dated)` for an edit, `None` for a new post. In public - as the group too, which is the
/// poster's own public post - the draft's `published_as`; in a group, what the group's lanes say.
pub async fn live(
    state: &AppState,
    data: &store::Store,
    root: &str,
    draft: &[u8; 16],
    to: &To,
) -> Result<Option<Option<i64>>, AppError> {
    match to {
        To::Public | To::AsGroup(_) => {
            let Some(post) = data
                .annotations()
                .field(draft, store::PUBLISHED_AS)
                .await?
                .filter(|p| !p.trim().is_empty())
            else {
                return Ok(None);
            };
            Ok(crate::identity::routes::held_public_header(state, root, post.trim())
                .await?
                .map(|h| h.dated_ms))
        }
        To::Group(g) => crate::roster::live_date(state, root, g, draft).await,
    }
}

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
    fn the_table_of_what_cant_go_where() {
        let g = To::Group([1; 16]);
        let a = To::AsGroup([1; 16]);
        let sealed = Asked { sealed: true, ..Default::default() };
        let room = Asked { room: true, ..Default::default() };
        let im = Asked { im: true, room: true, ..Default::default() };
        let sealed_book = Asked { sealed: true, book: true, ..Default::default() };
        for asked in [sealed, room, im, sealed_book, Asked::default()] {
            assert!(refuse(&To::Public, asked).is_ok(), "anything goes in public: {asked:?}");
        }
        assert!(refuse(&g, room).is_ok(), "a group has rooms");
        assert!(
            refuse(&a, sealed).is_err() && refuse(&a, room).is_err() && refuse(&a, im).is_err()
        );
        assert!(refuse(&g, sealed_book).is_err() && refuse(&a, sealed_book).is_err());
        assert!(refuse(&a, Asked { book: true, ..Default::default() }).is_ok());
    }

    #[test]
    fn a_post_goes_to_one_place() {
        let g = "00112233445566778899aabbccddeeff";
        assert_eq!(To::of(None, Some(" ")).unwrap(), To::Public);
        assert!(matches!(To::of(Some(g), None).unwrap(), To::Group(_)));
        assert!(matches!(To::of(None, Some(g)).unwrap(), To::AsGroup(_)));
        assert!(To::of(Some(g), Some(g)).is_err());
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
