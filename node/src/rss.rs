//! A person's RSS (Curtis, 2026-09-30: "for each user page, can we create a rss endpoint… it can
//! contain all the stuff they've posted"). GET `/ringtome/user/{seg}/rss.xml`, beside the page it
//! describes: RSS 2.0, their newest posts first - notes, drawings, pictures, books, rooms, replies -
//! each with its title, its address, its date, and what it says (the author's description, else its
//! words) under the picture it carries. Not their shares: those are other people's words.
//!
//! Only for a persona this node hosts, as the page's own head is (idface.rs `post_page`): the node
//! vouches for a shelf it keeps, and for nobody else's. A sealed post never appears - a feed reader
//! is a stranger, and its title and words are for trusted readers.

use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::error::AppError;
use crate::speakable::{self, Parsed};
use crate::AppState;

/// The newest this many posts: enough for any reader's catching-up, few enough to build per ask.
const ITEMS: i64 = 50;
/// How much of a post's words an item carries.
const ITEM_CHARS: usize = 4000;

/// Escape text for XML (element text and attribute values alike).
fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Milliseconds since the epoch as RFC 822, the date RSS speaks: `Wed, 30 Sep 2026 14:05:09 GMT`.
fn rfc822(ms: i64) -> String {
    const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"]; // 1970-01-01 was a Thursday
    const MONTHS: [&str; 12] =
        ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil from days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{}, {:02} {} {} {:02}:{:02}:{:02} GMT",
        DAYS[days.rem_euclid(7) as usize],
        day,
        MONTHS[(month - 1) as usize],
        year,
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// GET `/ringtome/user/{seg}/rss.xml`.
pub async fn rss_handler(
    State(state): State<AppState>,
    Path(seg): Path<String>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let missing =
        || AppError::NotFound(crate::msg!("rss.no-such-persona-here", "no such persona here"));
    let Some(Parsed::Ok(root)) = speakable::parse(&seg) else {
        return Err(missing());
    };
    let root_hex = hex::encode(root);
    if !crate::idface::hosted_here(&state, &root_hex).await? {
        return Err(missing());
    }
    let Some(db) = state.user_dbs.get(&root_hex).await.map_err(AppError::Internal)? else {
        return Err(missing());
    };
    let speak = speakable::speakable(&root);
    let short = speak.rsplit('-').next().unwrap_or(&speak).to_string();
    let words_of_name = speak.rsplit_once('-').map(|x| x.0).unwrap_or("").to_string();
    let fields = crate::idface::public_profile(&state, &root_hex).await.unwrap_or_default();
    let name = crate::idface::profile_value(&fields, "name").unwrap_or(&words_of_name).to_string();
    let bio = crate::idface::profile_value(&fields, "bio").unwrap_or("").to_string();
    let base = crate::nodeface::public_base(&state, &headers);
    let page = format!("{base}/ringtome/user/{short}");

    let posts =
        crate::record::documents::public_docs(&db, None, ITEMS * 2).await.unwrap_or_default();
    let mut items = String::new();
    for post in posts.iter().filter(|p| p.part_of.is_none() && !p.trusted_only).take(ITEMS as usize)
    {
        let doc_hex = hex::encode(post.doc_id);
        let said = crate::idface::post_words(&state, &db, &root_hex, post, &name).await?;
        let link = format!("{page}/post/{doc_hex}");
        // The picture it carries: its own, for a picture or a drawing, else the first its words embed.
        let picture = if post.thumb_hash.is_some() {
            Some(format!("{page}/doc/{doc_hex}/thumb"))
        } else {
            said.picture.map(|path| format!("{base}{path}"))
        };
        let text = said.described.unwrap_or_else(|| crate::idface::clip(&said.words, ITEM_CHARS));
        let mut body = String::new();
        if let Some(picture) = picture {
            body.push_str(&format!("<p><img src=\"{}\" alt=\"\"></p>", xml(&picture)));
        }
        if !text.is_empty() {
            body.push_str(&format!("<p>{}</p>", xml(&text)));
        }
        items.push_str(&format!(
            "<item><title>{}</title><link>{}</link><guid isPermaLink=\"true\">{}</guid><pubDate>{}</pubDate><description>{}</description></item>\n",
            xml(&said.title),
            xml(&link),
            xml(&link),
            rfc822(post.display_ms()),
            xml(&body),
        ));
    }
    let description = if bio.is_empty() { name.clone() } else { bio };
    let feed = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <rss version=\"2.0\" xmlns:atom=\"http://www.w3.org/2005/Atom\">\n<channel>\n\
         <title>{}</title>\n<link>{}</link>\n<description>{}</description>\n\
         <atom:link href=\"{}\" rel=\"self\" type=\"application/rss+xml\"/>\n{}</channel>\n</rss>\n",
        xml(&name),
        xml(&page),
        xml(&description),
        xml(&format!("{page}/rss.xml")),
        items,
    );
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/rss+xml; charset=utf-8"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        feed,
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RSS's date, from the epoch's first second to a leap day and past it.
    #[test]
    fn dates_read_as_rfc822() {
        assert_eq!(rfc822(0), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(rfc822(951_782_400_000), "Tue, 29 Feb 2000 00:00:00 GMT");
        assert_eq!(rfc822(1_790_777_109_000), "Wed, 30 Sep 2026 14:05:09 GMT");
    }

    #[test]
    fn xml_escapes_all_five() {
        assert_eq!(
            xml(r#"<a href="x">Tom & 'Bea'</a>"#),
            "&lt;a href=&quot;x&quot;&gt;Tom &amp; &apos;Bea&apos;&lt;/a&gt;"
        );
    }
}
