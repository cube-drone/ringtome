// Recents (plans/RECENTS.md): the rules over what this browser last used - which recent things
// head the dock and the launcher. The apps themselves keep the registry's order (Curtis,
// 2026-11-11: a dock that reordered at every app opened was more confusing than it was worth).
// The rows are mirror/recents.js's;
// this module imports nothing, so the rules are tested without a browser
// (integration/test/pure/recents.cjs).

/// How many recent things head the dock and the launcher.
export const RECENT_SLOTS = 3;
/// How many recent things the table keeps: more than are shown, so a thing deleted or gone still
/// leaves three.
export const RECENT_KEPT = 12;
/// The app whose tile leads, before the recent things (ruling 2): it wears your face and holds the
/// persona switcher.
export const LEAD_APP = 'persona';

/// The recent things to show: the newest first, `slots` of them, only those whose app this persona
/// may open (`mayShow(appId)`) - a thing of an app given up is not a door into it.
export function newestThings(things, mayShow = () => true, slots = RECENT_SLOTS) {
    return [...(things || [])]
        .filter((t) => t && t.href && mayShow(t.app))
        .sort((a, b) => (b.at || 0) - (a.at || 0))
        .slice(0, slots);
}

/// A thing's name from what was saved: its title, else its first words, cut short.
export function thingTitle(title, body, max = 60) {
    const said = (title || '').trim() || firstWords(body);
    return said.length > max ? `${said.slice(0, max - 1).trimEnd()}…` : said;
}

const firstWords = (body) =>
    (typeof body === 'string' ? body : '')
        .split('\n')
        .map((line) => line.replace(/^[#>*\-\s]+/, '').trim())
        .find((line) => line.length > 0 && !line.startsWith(':::')) || '';
