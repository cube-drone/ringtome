// Is there a newer Horse Drawing Tycoon 2 than the one running, and where does this system get it
// (Curtis, 2026-10-09: an installed app is told, every hour, until it updates - "HDT2 is so new that
// ALL UPDATES ARE IMPORTANT"). Pure: js/update.js asks the node and draws the notice.

/// Every release, by hand - where a system with no download of its own is sent.
export const RELEASES_PAGE = 'https://github.com/cube-drone/ringtome/releases';

/// A release tag's or version's numbers - `v0.3.1-keep-large` and `0.3.1` alike - or null.
export function versionOf(text) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text || '').trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/// Is the release `latestTag` newer than the `running` version? Anything unreadable is "no": a
/// notice that can't be dismissed must never appear on a guess.
export function isNewer(latestTag, running) {
    const a = versionOf(latestTag);
    const b = versionOf(running);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
}

/// This system's download out of the node's `/api/node/downloads` answer, by the platform the app
/// shell names (`window.__ringtome_platform`: Rust's OS names) - else every release.
export function downloadFor(platform, found) {
    const own = {
        android: found && found.android,
        macos: found && found.mac,
        windows: found && found.windows,
        linux: found && found.linux,
    }[platform];
    return own || (found && found.releases) || RELEASES_PAGE;
}
