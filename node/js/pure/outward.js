// Which links leave the desktop app for the system's browser or mail app (Curtis, 2026-10-22: the
// version label's release notes and the update notice's "here" opened nothing on the Mac, through
// three rounds of fixes). The webview never made those clicks a navigation the shell is asked
// about, so the page hands the address to the shell itself (index.js, `handOutLink`; shell.rs
// `open_link_handler`). The web and mail, at an origin that isn't this node's; nothing else.

const OUTWARD = new Set(['http:', 'https:', 'mailto:']);

/// The address to hand out for a link `href` on a page at `origin`, or null when the link is ours
/// (it stays in the app) or isn't the web's or mail's (nothing leaves by it).
export function outwardLink(href, origin) {
    let url;
    try {
        url = new URL(href, origin);
    } catch {
        return null;
    }
    if (!OUTWARD.has(url.protocol)) return null;
    if (url.protocol !== 'mailto:' && url.origin === new URL(origin).origin) return null;
    return url.href;
}
