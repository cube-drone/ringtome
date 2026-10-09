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
//!
//! One exception rides inside the window: the **players a post embeds** (Marquee's turbolinks - a
//! YouTube video, a Spotify track, an OpenStreetMap map) load in an iframe, and the webview asks
//! the same question for a frame's navigation as for the window's - WebKit's navigation policy
//! fires for every frame, and wry hands on only the URL, not which frame (Curtis, 2026-10-08: a
//! YouTube post opened a browser to "Error 153" - the embed, handed out, and refused there for
//! arriving with no page around it). Those three exact addresses load where they are.

use tauri::{AppHandle, Manager, Url};
use tauri_plugin_opener::OpenerExt;

/// Is `url` the app itself - same scheme, host and port as the node the window was opened at?
pub fn is_ours(url: &Url, origin: &Url) -> bool {
    url.scheme() == origin.scheme()
        && url.host_str() == origin.host_str()
        && url.port_or_known_default() == origin.port_or_known_default()
}

/// The embedded players' own addresses, as the turbolinks write them (`@cube-drone/marquee-turbolink`
/// and the Rust renderer alike): host and path prefix, https only. Nothing navigates the window to
/// one of these - they are an iframe's `src`, nothing a person clicks - so letting them load is
/// letting the frame load.
const EMBEDS: [(&str, &str); 3] = [
    ("www.youtube-nocookie.com", "/embed/"),
    ("open.spotify.com", "/embed/"),
    ("www.openstreetmap.org", "/export/embed.html"),
];

/// Is `url` a player a post embeds?
pub fn is_embed(url: &Url) -> bool {
    url.scheme() == "https"
        && EMBEDS.iter().any(|(host, path)| url.host_str() == Some(*host) && url.path().starts_with(path))
}

/// A navigation inside the window: allow ours (and the blank page a webview uses internally), and
/// an embedded player loading in its frame; hand everything else out.
pub fn navigation(app: &AppHandle, origin: &Url, url: &Url) -> bool {
    if is_ours(url, origin) || url.scheme() == "about" || is_embed(url) {
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
///
/// Off the calling thread (2026-10-09: every external link froze the Android app until the system
/// killed it). Android asks for a navigation's verdict on its main thread, and the opener there is
/// a Kotlin plugin, which tauri runs by posting to that same main thread and waiting for the
/// answer - so asked from inside the verdict, it waits on a thread that is waiting on it. Handed
/// to another thread, the verdict returns and the main thread is free to open the link.
fn hand_out(app: &AppHandle, url: &Url) {
    match url.scheme() {
        "http" | "https" | "mailto" => {
            let (app, url) = (app.clone(), url.clone());
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
                    tracing::warn!(error = %e, %url, "could not open a link in the system browser");
                }
            });
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

    #[test]
    fn embeds_are_the_players_exactly() {
        let yes = |u: &str| is_embed(&Url::parse(u).unwrap());
        assert!(yes("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"));
        assert!(yes("https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC"));
        assert!(yes("https://www.openstreetmap.org/export/embed.html?bbox=1,2,3,4&layer=mapnik"));
        assert!(!yes("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "the watch page is the web: handed out");
        assert!(!yes("https://www.youtube-nocookie.com/watch?v=dQw4w9WgXcQ"), "only the embed path");
        assert!(!yes("http://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"), "https only");
        assert!(!yes("https://evil.example/embed/x"));
        assert!(!yes("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"), "a track page is the web");
    }
}
