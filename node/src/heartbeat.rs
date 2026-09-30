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
static SENT: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// The UTC date of a moment, `YYYY-MM-DD`.
pub fn utc_date(ms: i64) -> String {
    let (y, m, d) = civil_from_days(ms.div_euclid(86_400_000));
    format!("{y:04}-{m:02}-{d:02}")
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
    }
}
