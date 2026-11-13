//! Store builds (plans/STORES.md, section 3): the app as Google Play or Apple's App Store ship it.
//! Both forbid an app to update itself, or to send people to update it, by any road but the
//! store's own - so a store build never shows the update notice, and its "get the app" panel
//! leaves out the download for its own system (js/update.js, js/downloads.js), and on a desktop
//! the self-updater is never registered (desktop/src/update.rs). Everything else is the same app.
//!
//! Fixed when the node is compiled: `RINGTOME_STORE=play` or `app-store`, checked by build.rs.
//! Unset, the build is a download, which updates itself from the releases page as ever.

/// The store this build is for, or `None` for a download.
pub const STORE: Option<&str> = option_env!("RINGTOME_STORE_BUILD");

/// The page's meta tag saying so - nothing at all for a download.
pub fn meta() -> String {
    STORE.map(|s| format!("\n    <meta name=\"app-store\" content=\"{s}\">")).unwrap_or_default()
}

#[cfg(test)]
mod tests {
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
