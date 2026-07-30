// The application registry: the curated menu of apps (PROJECT_PLAN, The Client Is a Console -
// a console with good games, not an app-builder). Each app carries a `style` - its app-type.
//
// The bucket <-> app-type mapping is mostly implicit: a bucket whose NAME is an app-type simply
// IS that type (the `recipes` bucket is a recipes bucket, no mapping needed), so every app has
// an eponymous bucket we can just assume exists - open the recipes app and you're working in
// the `recipes` bucket. The registry (`name -> app`, on the server) is only consulted for
// USER-named buckets like `grandmas-recipes`. Anything we can't resolve falls back to `default`
// (Notes), so an unknown style never strands you.
//
// The registry imports NOTHING. An app's `icon` is a role name that icons.js resolves at the two
// render sites (`iconFor`), not a component - a table of app metadata and the rules over it has no
// business depending on a rendering library. That is what lets this module join the pure set and be
// tested without a browser (integration/test/pure/apps.cjs, which also checks every name resolves).

export const DEFAULT_STYLE = 'default';

export const APPS = [
    // Persona is a SYSTEM app: a real app with its own tile and the unified header, but its own
    // pages (profile, computers, log out) rather than a document surface - so no `style`, and it
    // is excluded from the document-app routes. Its dock tile wears the persona's own name.
    { id: 'persona', name: 'Persona', icon: 'persona', live: true, system: true },
    // `bucketNoun` is what ONE bucket of this app is called to the user - the word the bucket
    // switcher builds its labels from ("New Recipe Book", "Delete this Journal…").
    {
        id: 'journal',
        name: 'Journal',
        icon: 'journal',
        style: 'journal',
        live: true,
        bucketNoun: 'Journal',
        // A day book: its own component (JournalApp), a stream of one entry per day - NOT the
        // notes list. It composes the shared editing session directly, so it needs no `features`.
        journal: true,
    },
    {
        id: 'recipes',
        name: 'Recipes',
        icon: 'recipes',
        style: 'recipes',
        live: true,
        bucketNoun: 'Recipe Book',
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
    {
        id: 'wiki',
        name: 'Wikibook',
        icon: 'wiki',
        style: 'wiki',
        live: true,
        bucketNoun: 'Wikibook',
        // A knowledge base: pages in a TREE. Its own component (WikiApp) - the tree is a root
        // taxonomy (titled `wiki:<bucket>`), sections are child taxonomies, pages are document
        // leaves. Composes the shared Editor for the page surface. `features.tree` marks it
        // tree-having for the shared surfaces (uploads file into the tree root). The label is
        // "Wikibook" but the id, style, and bucket are all `wiki`: only the display name changed.
        wiki: true,
        features: { tree: true },
    },
    {
        id: 'notes',
        name: 'TurboNotes',
        icon: 'notes',
        style: 'default',
        live: true,
        bucketNoun: 'TurboNotes',
        // The everything-app, embraced at last (and renamed to match its ambition): the recipe
        // app's tag column on the left, the wikibook's tree on the right, the list between -
        // each column tuckable, so it's only as monstrous as you choose to make it.
        features: { tagColumn: true, tree: true },
    },
    { blank: true },
];

// What an app's surface offers. The default is the full Notes experience; an app overrides
// only the pieces it wants to drop or add, so a new app style is a short `features` block.
const DEFAULT_FEATURES = {
    modes: ['interactive', 'side', 'plain', 'read'], // view modes offered
    format: true, // the format-convert chip
    date: true, // the claimed date/time annotation
    description: true, // the description annotation
    debug: true, // the version-history dump: a development tool, off at ship day
    tagColumn: false, // a sidebar listing every tag by frequency
    tree: false, // the wiki tree pane (doc/tree.js), right of the list
};

/// The resolved feature set for an app (defaults, then the app's overrides). Safe on undefined.
export const featuresOf = (app) => ({ ...DEFAULT_FEATURES, ...((app && app.features) || {}) });

/// The launchable apps, in registry order (the console tiles).
export const liveApps = APPS.filter((a) => a.live);

/// The document apps: live apps that own a document surface (a `style`). System apps like Persona
/// have none and carry their own routes instead. Internal - the styles set below is what callers
/// actually want.
const docApps = liveApps.filter((a) => a.style);

/// An app by its route id (live apps only) - Persona included, so the shell gives it the header.
export const appById = (id) => liveApps.find((a) => a.id === id) || null;

/// The label a tile or the app header shows for an app. Persona wears the CURRENT persona's name
/// (so "Persona" reads as whoever you are); every other app is its registry name. `personaName`
/// is the live name, '' when unset - then the persona app falls back to its own registry name.
export const appLabel = (app, personaName) =>
    app && app.id === 'persona' && personaName ? personaName : app ? app.name : '';

/// The set of names that are app-types in their own right (so a like-named bucket is implicit).
/// Document apps only - a system app (Persona) has no style and names no bucket type.
const KNOWN_STYLES = new Set(docApps.map((a) => a.style));

/// The app-type of a bucket by name: its name IS a style (implicit), else its explicit registry
/// mapping, else the default. `roster` is the streamed bucket registry (`{name, app}`), only
/// needed for user-named buckets.
export function appTypeOf(bucketName, roster) {
    if (KNOWN_STYLES.has(bucketName)) return bucketName;
    const reg = (roster || []).find((b) => b.name === bucketName);
    if (reg && reg.app) return reg.app;
    return DEFAULT_STYLE;
}

/// The buckets an app can page through: its HOME bucket first (the eponymous one, named for the
/// app's style - always present, even before anything is filed in it), then every other roster
/// bucket that resolves to this app's type, alphabetically. This is the bucket switcher's rail.
export function bucketsForApp(app, roster) {
    const others = (roster || [])
        .map((b) => b.name)
        .filter((n) => n !== app.style && appTypeOf(n, roster) === app.style)
        .sort();
    return [app.style, ...others];
}

/// Which app opens a bucket of this style - the default app when the style has no live app.
///
/// `a.style && ...` is load-bearing: a SYSTEM app (Persona) has no `style` at all, so a bare
/// equality match would answer `appForStyle(undefined)` with Persona - a styleless app that owns
/// no documents - instead of falling through to the default. No caller passes undefined today
/// (they all come via `appTypeOf`, which always returns a style), which is exactly why the trap
/// would have waited for the one that eventually did. Found by this module's vectors, 2026-07-29.
export const appForStyle = (style) =>
    liveApps.find((a) => a.style && a.style === style) ||
    liveApps.find((a) => a.style === DEFAULT_STYLE);
