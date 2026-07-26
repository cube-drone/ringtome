// The application registry: the curated menu of apps (PROJECT_PLAN, The Client Is a Console -
// a console with good games, not an app-builder). Each app carries a `style` - its app-type.
//
// The bucket <-> app-type mapping is mostly implicit: a bucket whose NAME is an app-type simply
// IS that type (the `recipes` bucket is a recipes bucket, no mapping needed), so every app has
// an eponymous bucket we can just assume exists - open the recipes app and you're working in
// the `recipes` bucket. The registry (`name -> app`, on the server) is only consulted for
// USER-named buckets like `grandmas-recipes`. Anything we can't resolve falls back to `default`
// (Notes), so an unknown style never strands you.
import { Icons } from './icons.js';

export const DEFAULT_STYLE = 'default';

export const APPS = [
    { id: 'notes', name: 'Notes', icon: Icons.notes, style: 'default', live: true },
    {
        id: 'recipes',
        name: 'Recipes',
        icon: Icons.recipes,
        style: 'recipes',
        live: true,
        // A recipe book: just the interactive editor, tags and title, and a tag cloud beside
        // the list. No dates, no descriptions, no format-juggling, no debug chip.
        features: {
            modes: ['interactive'],
            format: false,
            date: false,
            description: false,
            debug: false,
            tagColumn: true,
        },
    },
    { id: 'journal', name: 'Journal', icon: Icons.journal, soon: true },
    { id: 'wiki', name: 'Wiki', icon: Icons.wiki, soon: true },
    { id: 'blog', name: 'Blog', icon: Icons.blog, soon: true },
    { id: 'book', name: 'Book', icon: Icons.book, soon: true },
    { blank: true },
    { blank: true },
];

// What an app's surface offers. The default is the full Notes experience; an app overrides
// only the pieces it wants to drop or add, so a new app style is a short `features` block.
const DEFAULT_FEATURES = {
    modes: ['interactive', 'side', 'plain', 'read'], // view modes offered
    format: true, // the format-convert chip
    date: true, // the claimed date/time annotation
    description: true, // the description annotation
    debug: true, // the TEMPORARY debug-dump chip
    tagColumn: false, // a sidebar listing every tag by frequency
};

/// The resolved feature set for an app (defaults, then the app's overrides). Safe on undefined.
export const featuresOf = (app) => ({ ...DEFAULT_FEATURES, ...((app && app.features) || {}) });

/// The launchable apps, in registry order.
export const liveApps = APPS.filter((a) => a.live);

/// An app by its route id (live apps only).
export const appById = (id) => liveApps.find((a) => a.id === id) || null;

/// The set of names that are app-types in their own right (so a like-named bucket is implicit).
const KNOWN_STYLES = new Set(liveApps.map((a) => a.style));

/// The app-type of a bucket by name: its name IS a style (implicit), else its explicit registry
/// mapping, else the default. `roster` is the streamed bucket registry (`{name, app}`), only
/// needed for user-named buckets.
export function appTypeOf(bucketName, roster) {
    if (KNOWN_STYLES.has(bucketName)) return bucketName;
    const reg = (roster || []).find((b) => b.name === bucketName);
    if (reg && reg.app) return reg.app;
    return DEFAULT_STYLE;
}

/// Which app opens a bucket of this style - the default app when the style has no live app.
export const appForStyle = (style) =>
    liveApps.find((a) => a.style === style) || liveApps.find((a) => a.style === DEFAULT_STYLE);
