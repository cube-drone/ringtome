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
    // Persona is a SYSTEM app: a real app with its own tile and the unified header, but its own
    // pages (profile, computers, log out) rather than a document surface - so no `style`, and it
    // is excluded from the document-app routes. Also reachable from the footer gear.
    { id: 'persona', name: 'Persona', icon: Icons.persona, live: true, system: true },
    // `bucketNoun` is what ONE bucket of this app is called to the user - the word the bucket
    // switcher builds its labels from ("New Recipe Book", "Delete this Journal…").
    {
        id: 'journal',
        name: 'Journal',
        icon: Icons.journal,
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
        icon: Icons.recipes,
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
        icon: Icons.wiki,
        style: 'wiki',
        live: true,
        bucketNoun: 'Wikibook',
        // A knowledge base: pages in a TREE. Its own component (WikiApp) - the tree is a root
        // taxonomy (titled `wiki:<bucket>`), sections are child taxonomies, pages are document
        // leaves. Composes the shared Editor for the page surface. `features.tree` marks it
        // tree-having for the shared surfaces (uploads file into the tree root). Renamed
        // Wikibook 2026-07-28; the id, style, and bucket all stay `wiki` (User-1 or not, the
        // routes and roster carry the old word fine - only the label changed).
        wiki: true,
        features: { tree: true },
    },
    {
        id: 'notes',
        name: 'TurboNotes',
        icon: Icons.notes,
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
    debug: true, // the TEMPORARY debug-dump chip
    tagColumn: false, // a sidebar listing every tag by frequency
    tree: false, // the wiki tree pane (doc/tree.js), right of the list
};

/// The resolved feature set for an app (defaults, then the app's overrides). Safe on undefined.
export const featuresOf = (app) => ({ ...DEFAULT_FEATURES, ...((app && app.features) || {}) });

/// The launchable apps, in registry order (the console tiles).
export const liveApps = APPS.filter((a) => a.live);

/// The document apps: live apps that own a document surface (a `style`). These get the generated
/// `/home/<app>/<doc?>` routes; system apps like Persona carry their own routes instead.
export const docApps = liveApps.filter((a) => a.style);

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
export const appForStyle = (style) =>
    liveApps.find((a) => a.style === style) || liveApps.find((a) => a.style === DEFAULT_STYLE);
