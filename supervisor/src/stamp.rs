//! UTC timestamps for file names: `YYYYMMDDTHHMMSSZ`, which sort lexically in time order.
//!
//! The same spelling as the node's backups (`node/src/backup.rs`, `utc_stamp`), copied rather than
//! shared because the supervisor does not depend on the node crate (see Cargo.toml). The two must
//! agree: backup retention sorts the node's archives and the supervisor's by name, together.

use std::time::{SystemTime, UNIX_EPOCH};

/// Seconds since the epoch, now.
pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// `secs` since the epoch as `YYYYMMDDTHHMMSSZ` (civil-from-days, Howard Hinnant's algorithm).
pub fn utc_stamp(secs: i64) -> String {
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    format!(
        "{year:04}{month:02}{day:02}T{:02}{:02}{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Seconds from `now` until the next time the UTC clock reads `hour`:00:00 (never zero: at exactly
/// that moment, the answer is a day).
pub fn secs_until_utc_hour(now: i64, hour: i64) -> i64 {
    let into_day = now.rem_euclid(86_400);
    let target = hour * 3600;
    let wait = (target - into_day).rem_euclid(86_400);
    if wait == 0 {
        86_400
    } else {
        wait
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_read_as_the_calendar() {
        assert_eq!(utc_stamp(0), "19700101T000000Z");
        // 2026-09-25 18:30:12 UTC
        assert_eq!(utc_stamp(1_790_361_012), "20260925T183012Z");
        assert_eq!(utc_stamp(951_782_400), "20000229T000000Z", "a leap day");
    }

    #[test]
    fn the_next_hour_is_ahead_and_within_a_day() {
        let four_am = 1_790_308_800; // 2026-09-25 04:00:00 UTC
        assert_eq!(
            secs_until_utc_hour(four_am, 4),
            86_400,
            "exactly on it: tomorrow"
        );
        assert_eq!(secs_until_utc_hour(four_am - 60, 4), 60);
        assert_eq!(secs_until_utc_hour(four_am + 60, 4), 86_400 - 60);
    }
}
