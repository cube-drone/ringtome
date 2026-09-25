//! Links that leave the app open in the person's own browser (Curtis, 2026-09-25: the version
//! label's link to its release notes did nothing in the desktop app).
//!
//! A Tauri window is a webview with no browser around it: a `target="_blank"` link asks for a new
//! window, which the webview silently drops, and a link to another site would navigate the app's
//! only window away from the app. Neither is what anybody means by clicking a link - so every
//! navigation and every new-window request is judged here, from the shell:
//!
//! - **our own origin** (the node on loopback) navigates as usual, and a new-window request for it
//!   lands in the app's window instead - the app has one window, and a second would be a second
//!   copy of the app without its launch token;
//! - **the web and mail** (`http`, `https`, `mailto`) open in the system's own browser or mail app,
//!   and the webview stays where it is;
//! - **anything else** is refused: a page must not be able to make the app launch arbitrary URL
//!   handlers on the person's machine.

use tauri::{AppHandle, Manager, Url};
use tauri_plugin_opener::OpenerExt;

/// Is `url` the app itself - same scheme, host and port as the node the window was opened at?
pub fn is_ours(url: &Url, origin: &Url) -> bool {
    url.scheme() == origin.scheme()
        && url.host_str() == origin.host_str()
        && url.port_or_known_default() == origin.port_or_known_default()
}

/// A navigation inside the window: allow ours (and the blank page a webview uses internally);
/// hand everything else out.
pub fn navigation(app: &AppHandle, origin: &Url, url: &Url) -> bool {
    if is_ours(url, origin) || url.scheme() == "about" {
        return true;
    }
    hand_out(app, url);
    false
}

/// A request for a new window (`target="_blank"`, `window.open`): ours lands in the app's own
/// window; everything else is handed out. Never a second webview.
pub fn new_window(app: &AppHandle, origin: &Url, url: Url) {
    if is_ours(&url, origin) {
        if let Some(window) = app.get_webview_window("main") {
            if let Err(e) = window.navigate(url) {
                tracing::warn!(error = %e, "could not follow an in-app link");
            }
        }
        return;
    }
    hand_out(app, &url);
}

/// The system's own handler for the web and mail; nothing else.
fn hand_out(app: &AppHandle, url: &Url) {
    match url.scheme() {
        "http" | "https" | "mailto" => {
            if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
                tracing::warn!(error = %e, %url, "could not open a link in the system browser");
            }
        }
        other => tracing::info!(scheme = other, "refused a link to a non-web scheme"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ours_is_the_node_exactly() {
        let origin = Url::parse("http://127.0.0.1:6305/").unwrap();
        assert!(is_ours(&Url::parse("http://127.0.0.1:6305/home/chat/a/b").unwrap(), &origin));
        assert!(!is_ours(&Url::parse("http://127.0.0.1:6306/home").unwrap(), &origin), "another port is another node");
        assert!(!is_ours(&Url::parse("http://localhost:6305/home").unwrap(), &origin), "another host spelling is another origin");
        assert!(!is_ours(&Url::parse("https://github.com/cube-drone/ringtome").unwrap(), &origin));
    }
}
