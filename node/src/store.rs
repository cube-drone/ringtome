//! Store builds (plans/STORES.md, section 3): the app as Google Play or Apple's App Store ship it.
//! Both forbid an app to update itself, or to send people to update it, by any road but the
//! store's own - so a store build never shows the update notice, and its "get the app" panel
//! leaves out the download for its own system (js/update.js, js/downloads.js), and on a desktop
//! the self-updater is never registered (desktop/src/update.rs). A store build also asks a year
//! of birth at sign-up and turns away anyone who might be under 13 ([`admit_age`]). Everything
//! else is the same app.
//!
//! Fixed when the node is compiled: `RINGTOME_STORE=play` or `app-store`, checked by build.rs.
//! Unset, the build is a download, which updates itself from the releases page as ever.

/// The store this build is for, or `None` for a download.
pub const STORE: Option<&str> = option_env!("RINGTOME_STORE_BUILD");

/// The youngest a person may be to make an account in a store build.
pub const MINIMUM_AGE: i32 = 13;

/// Why the age screen turned a sign-up away.
#[derive(Debug, PartialEq, Eq)]
pub enum AgeRefusal {
    /// No year, or one nobody alive was born in.
    NoYear,
    /// Might be under [`MINIMUM_AGE`].
    TooYoung,
}

/// Whether someone born in `birth_year` is certainly [`MINIMUM_AGE`] or over in `this_year`. A
/// year is all that is asked, so the birthday may not have come yet: the youngest they could be
/// is one less than the difference, and "might conceivably be under" is a no (Curtis, 2026-11-12).
pub fn old_enough(birth_year: i32, this_year: i32) -> bool {
    this_year - birth_year > MINIMUM_AGE
}

/// The age screen at registration (plans/STORES.md, section 1): a store build asks the year of
/// birth and refuses anyone who might be a child; a download asks nothing. The year is looked at
/// here and kept nowhere.
pub fn admit_age(
    store: Option<&str>,
    birth_year: Option<i32>,
    this_year: i32,
) -> Result<(), AgeRefusal> {
    if store.is_none() {
        return Ok(());
    }
    let year = birth_year.ok_or(AgeRefusal::NoYear)?;
    if !(1900..=this_year).contains(&year) {
        return Err(AgeRefusal::NoYear);
    }
    if old_enough(year, this_year) {
        Ok(())
    } else {
        Err(AgeRefusal::TooYoung)
    }
}

/// The page's meta tag saying so - nothing at all for a download.
pub fn meta() -> String {
    STORE.map(|s| format!("\n    <meta name=\"app-store\" content=\"{s}\">")).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{admit_age, old_enough, AgeRefusal};

    #[test]
    fn the_year_alone_leaves_a_year_of_doubt() {
        // Born 2012, asked in 2026: 13 or 14. Born 2013: 12 or 13, which might be a child.
        assert!(old_enough(2012, 2026));
        assert!(!old_enough(2013, 2026));
        assert!(!old_enough(2026, 2026));
        assert!(old_enough(1950, 2026));
    }

    #[test]
    fn only_a_store_build_asks() {
        assert_eq!(admit_age(None, None, 2026), Ok(()));
        assert_eq!(admit_age(None, Some(2020), 2026), Ok(()));
        assert_eq!(admit_age(Some("play"), None, 2026), Err(AgeRefusal::NoYear));
        assert_eq!(admit_age(Some("play"), Some(2013), 2026), Err(AgeRefusal::TooYoung));
        assert_eq!(admit_age(Some("app-store"), Some(2012), 2026), Ok(()));
    }

    #[test]
    fn a_year_nobody_was_born_in_is_no_year() {
        assert_eq!(admit_age(Some("play"), Some(1066), 2026), Err(AgeRefusal::NoYear));
        assert_eq!(admit_age(Some("play"), Some(2027), 2026), Err(AgeRefusal::NoYear));
    }

    #[test]
    fn a_download_says_nothing() {
        // The test build is a download unless someone built it for a store.
        if super::STORE.is_none() {
            assert_eq!(super::meta(), "");
        } else {
            assert!(super::meta().contains("name=\"app-store\""));
        }
    }
}
