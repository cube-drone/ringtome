//! Heartbeats (HORSE_BASED_CURRENCIES.md, Curtis 2026-09-29): one public mark per persona per day
//! in which they used the app - the date, never a time, and always on.
//!
//! A heartbeat is the profile field `heartbeat`, holding the UTC date (`2026-09-29`). The profile
//! is its own public chain (never the identity chain, whose ceiling it would eat), it already
//! travels wherever the persona's face does, and it folds last-write-wins per field - so a
//! persona's card, the People page and anyone holding their chains read "active today" off the
//! same fold. Nodes that predate the field store it and ignore it: a received profile field is
//! checked for length, not name.
//!
//! **When:** the persona's first signed-in activity of the day on this node - every persona-scoped
//! request passes `store::open`, which rings `note`. The note is an in-memory check; the write is
//! spawned, opens the persona with the node's own key (the sweeps' door), and skips itself when the
//! folded profile already says today (another of the persona's computers got there first). So a
//! persona costs at most one entry a day per computer, and usually one a day.
//!
//! **Not user-settable:** `PROFILE_FIELDS`, the route's allowlist, doesn't name it. The node writes
//! it; a person can't backdate their activity through the profile form.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use crate::AppState;

/// The profile field a heartbeat is.
pub const FIELD: &str = "heartbeat";

/// Each persona's last heartbeat date sent (or being sent) from this node.
static SENT: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// The UTC date of a moment, `YYYY-MM-DD`.
pub fn utc_date(ms: i64) -> String {
    let (y, m, d) = civil_from_days(ms.div_euclid(86_400_000));
    format!("{y:04}-{m:02}-{d:02}")
}

/// A heartbeat's date back to its day number (days since 1970-01-01), or `None` if it isn't one -
/// Howard Hinnant's `days_from_civil`.
pub fn day_of_date(date: &str) -> Option<u32> {
    let mut parts = date.splitn(3, '-');
    let (y, m, d): (i64, i64, i64) =
        (parts.next()?.parse().ok()?, parts.next()?.parse().ok()?, parts.next()?.parse().ok()?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    u32::try_from(era * 146_097 + doe - 719_468).ok()
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's `civil_from_days`).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

/// A persona did something on this node: send today's heartbeat unless it's already sent.
pub fn note(state: &AppState, root_hex: &str) {
    let today = utc_date(crate::clock::now_ms());
    {
        let mut sent = SENT.lock().expect("heartbeats poisoned");
        if sent.get(root_hex) == Some(&today) {
            return;
        }
        sent.insert(root_hex.to_string(), today.clone());
    }
    let (state, root) = (state.clone(), root_hex.to_string());
    tokio::spawn(async move {
        // Active today, on this node: into today's census sketch (census.rs).
        crate::census::saw(&state, &root, crate::census::day_of(crate::clock::now_ms())).await;
        if let Err(e) = beat(&state, &root, &today).await {
            tracing::debug!(root = %root, error = ?e, "a heartbeat wasn't sent; the next activity tries again");
            SENT.lock().expect("heartbeats poisoned").remove(&root);
        }
    });
}

async fn beat(state: &AppState, root_hex: &str, today: &str) -> Result<(), crate::error::AppError> {
    let data = crate::record::store::open_agented(state, root_hex).await?;
    let said = data.profile().all().await?.into_iter().find(|f| f.field == FIELD).map(|f| f.value);
    if said.as_deref() == Some(today) {
        return Ok(()); // another of the persona's computers already said today
    }
    crate::record::imaol::set_profile_field(data.db(), data.signer(), FIELD, today).await?;
    // This node's own byline cache learns it now, rather than on the lane's next move.
    let _ = crate::profiles::refresh(state, root_hex).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    /// Dates are UTC and exact across the calendar's edges: the epoch, a leap day, a century
    /// that isn't a leap year, and a moment one millisecond before midnight.
    #[test]
    fn a_moment_is_its_utc_date() {
        assert_eq!(super::utc_date(0), "1970-01-01");
        assert_eq!(super::utc_date(951_782_400_000), "2000-02-29");
        assert_eq!(super::utc_date(4_107_542_400_000), "2100-03-01");
        assert_eq!(super::utc_date(1_790_726_399_999), "2026-09-29");
        assert_eq!(super::utc_date(1_790_726_400_000), "2026-09-30");
        assert_eq!(super::utc_date(-1), "1969-12-31");
        for day in [0u32, 11_016, 20_725, 47_541] {
            assert_eq!(
                super::day_of_date(&super::utc_date(i64::from(day) * 86_400_000)),
                Some(day),
                "round trip"
            );
        }
        assert_eq!(super::day_of_date("last tuesday"), None);
    }
}
