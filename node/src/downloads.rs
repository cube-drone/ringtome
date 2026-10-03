//! The front page's Download tab (Curtis, 2026-09-29): the newest release's desktop app, one button
//! per system - the macOS `.dmg`, the Windows installer, the Linux AppImage - read off the GitHub
//! releases page.
//!
//! **The node asks GitHub, not the page.** A visitor's browser asking api.github.com would tell
//! GitHub about everyone who so much as opens this sign-in page, and would spend each visitor's own
//! sixty-an-hour allowance. The node asks at most once an hour, only when somebody opens the tab,
//! and hands the page three links. When GitHub doesn't answer, the tab says so and offers the
//! releases page itself; a failure is remembered for a few minutes, never hammered.

use std::sync::LazyLock;
use std::time::{Duration, Instant};

use axum::Json;
use serde::Serialize;

const LATEST: &str = "https://api.github.com/repos/cube-drone/ringtome/releases/latest";
/// Where the buttons fall back to when an asset (or GitHub) is missing: every release, by hand.
pub const RELEASES_PAGE: &str = "https://github.com/cube-drone/ringtome/releases";
const FRESH: Duration = Duration::from_secs(60 * 60);
const RETRY: Duration = Duration::from_secs(5 * 60);
const TIMEOUT: Duration = Duration::from_secs(5);

/// What the tab draws. Every link is optional: an asset a release didn't ship is a button the tab
/// leaves out, not a dead link.
#[derive(Serialize, Clone, Default, Debug, PartialEq)]
pub struct Downloads {
    /// The release's tag, `v0.2.2-snuff-nest`.
    pub tag: Option<String>,
    pub mac: Option<String>,
    pub windows: Option<String>,
    pub linux: Option<String>,
    /// Every release, for whatever the three buttons don't cover.
    pub releases: &'static str,
}

/// The three downloads out of a GitHub release: the `.dmg`, the `-setup.exe` (the installer a
/// person double-clicks; the `.msi` is for administrators), and the `.AppImage` (runs on any
/// distribution) - never their `.sig` siblings.
pub fn pick(release: &serde_json::Value) -> Downloads {
    let assets: Vec<(&str, &str)> = release["assets"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| Some((x["name"].as_str()?, x["browser_download_url"].as_str()?)))
                .collect()
        })
        .unwrap_or_default();
    let find = |suffix: &str| {
        assets.iter().find(|(name, _)| name.ends_with(suffix)).map(|(_, url)| url.to_string())
    };
    Downloads {
        tag: release["tag_name"].as_str().map(String::from),
        mac: find(".dmg"),
        windows: find("-setup.exe"),
        linux: find(".AppImage"),
        releases: RELEASES_PAGE,
    }
}

static CACHE: LazyLock<tokio::sync::Mutex<Option<(Instant, Downloads, bool)>>> =
    LazyLock::new(|| tokio::sync::Mutex::new(None));

async fn fetch() -> anyhow::Result<Downloads> {
    let client = reqwest::Client::builder().timeout(TIMEOUT).build()?;
    let text = client
        .get(LATEST)
        .header(reqwest::header::USER_AGENT, "ringtome-node")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    Ok(pick(&serde_json::from_str(&text)?))
}

/// GET `/api/node/downloads` - the newest release's three desktop downloads.
pub async fn downloads() -> Json<Downloads> {
    let mut cache = CACHE.lock().await;
    if let Some((at, held, ok)) = cache.as_ref() {
        if at.elapsed() < if *ok { FRESH } else { RETRY } {
            return Json(held.clone());
        }
    }
    let (got, ok) = match fetch().await {
        Ok(d) => (d, true),
        Err(e) => {
            tracing::debug!(error = ?e, "the newest release couldn't be read from GitHub");
            (Downloads { releases: RELEASES_PAGE, ..Default::default() }, false)
        }
    };
    *cache = Some((Instant::now(), got.clone(), ok));
    Json(got)
}

#[cfg(test)]
mod tests {
    /// The three a person wants, out of the release's whole shelf - never a signature, never the
    /// administrators' `.msi` or the updater's tarball (the 0.2.2 release's own asset names).
    #[test]
    fn a_release_offers_one_download_per_system() {
        let base = "https://github.com/cube-drone/ringtome/releases/download/v0.2.2-snuff-nest";
        let names = [
            "Horse.Drawing.Tycoon.2-0.2.2-1.x86_64.rpm",
            "Horse.Drawing.Tycoon.2_0.2.2_amd64.AppImage.sig",
            "Horse.Drawing.Tycoon.2_0.2.2_amd64.AppImage",
            "Horse.Drawing.Tycoon.2_0.2.2_amd64.deb",
            "Horse.Drawing.Tycoon.2_0.2.2_universal.dmg",
            "Horse.Drawing.Tycoon.2_0.2.2_x64-setup.exe.sig",
            "Horse.Drawing.Tycoon.2_0.2.2_x64-setup.exe",
            "Horse.Drawing.Tycoon.2_0.2.2_x64_en-US.msi",
            "Horse.Drawing.Tycoon.2_universal.app.tar.gz",
            "latest.json",
        ];
        let release = serde_json::json!({
            "tag_name": "v0.2.2-snuff-nest",
            "assets": names.iter().map(|n| serde_json::json!({ "name": n, "browser_download_url": format!("{base}/{n}") })).collect::<Vec<_>>(),
        });
        let d = super::pick(&release);
        assert_eq!(d.tag.as_deref(), Some("v0.2.2-snuff-nest"));
        assert_eq!(d.mac, Some(format!("{base}/Horse.Drawing.Tycoon.2_0.2.2_universal.dmg")));
        assert_eq!(d.windows, Some(format!("{base}/Horse.Drawing.Tycoon.2_0.2.2_x64-setup.exe")));
        assert_eq!(d.linux, Some(format!("{base}/Horse.Drawing.Tycoon.2_0.2.2_amd64.AppImage")));
        assert_eq!(
            super::pick(&serde_json::json!({})),
            super::Downloads { releases: super::RELEASES_PAGE, ..Default::default() },
            "nothing to offer, no dead links"
        );
    }
}
