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
    {
        id: 'people',
        name: 'People',
        icon: 'people',
        live: true,
        // The rolodex (PROJECT_PLAN, Addressing: the console's people surface): look up an
        // address, and browse everyone your ledger holds a relationship with - identity-free
        // at the list level, navigating OUT to /id/<root> pages. Not a documents app: no
        // style, no buckets, no tree - its rows are the mirror's `contacts` kind.
        itemNoun: 'person',
    },
    // The app's two nouns, both in the user's words rather than ours. `bucketNoun` is what ONE
    // bucket is called, Capitalised because it lands in titles and prompts ("New Recipe Book",
    // "Delete this Journal…"); `itemNoun` is what one THING INSIDE a bucket is called, lowercase
    // because it lands mid-sentence ("+ new recipe", "a new page in this section"). A recipe book
    // holds recipes, a wikibook holds pages, and neither of them holds "items".
    {
        id: 'journal',
        name: 'Journal',
        icon: 'journal',
        style: 'journal',
        live: true,
        bucketNoun: 'Journal',
        itemNoun: 'entry',
        itemPlural: 'entries',
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
        itemNoun: 'recipe',
        // A recipe book: just the interactive editor, tags and title, and a tag cloud beside
        // the list. No dates, no descriptions, no format-juggling.
        features: {
            modes: ['interactive'],
            format: false,
            date: false,
            description: false,
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
        itemNoun: 'page',
        // A knowledge base: pages in a TREE. Its own component (WikiApp) - the tree is a root
        // taxonomy (titled `wiki:<bucket>`), sections are child taxonomies, pages are document
        // leaves. Composes the shared Editor for the page surface. `features.tree` marks it
        // tree-having for the shared surfaces (uploads file into the tree root). The label is
        // "Wikibook" but the id, style, and bucket are all `wiki`: only the display name changed.
        wiki: true,
        // No pin: pinning floats a document in a LIST, and the wiki has no list - its order
        // is the tree's. A button that does nothing is worse than no button.
        features: { tree: true, pin: false },
    },
    {
        id: 'notes',
        name: 'TurboNotes',
        icon: 'notes',
        style: 'default',
        live: true,
        bucketNoun: 'TurboNotes',
        itemNoun: 'note',
        // The everything-app, embraced at last (and renamed to match its ambition): the recipe
        // app's tag column on the left, the wikibook's tree on the right, the list between -
        // each column tuckable, so it's only as monstrous as you choose to make it.
        features: { tagColumn: true, tree: true },
    },
    {
        id: 'all',
        name: 'All',
        icon: 'all',
        live: true,
        // The everything-view: every document from every notebook, PLUS the unbucketed - the
        // one surface where nothing can be orphaned out of sight (a repudiation striking a
        // bucket's definition relocates its documents; this is where they remain findable).
        // No `style` on purpose: it owns no bucket type, mints no implicit bucket, and the
        // bucket switcher never shows. A browsing surface: rows carry their bucket names and
        // a follow-me-home button to each document's own app; creation stays with the real
        // apps. Its URLs live under /all and never re-dress into cozy bucket addresses -
        // one document shows in many places, but an /all link means the everything-view.
        everything: true,
        bucketNoun: 'Archive',
        itemNoun: 'file',
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
    tagColumn: false, // a sidebar listing every tag by frequency
    tree: false, // the wiki tree pane (doc/tree.js), right of the list
    pin: true, // the pin chip - floats the doc atop the LIST, so list-less apps drop it
};

/// What ONE thing inside this app's bucket is called, lowercase, for mid-sentence use. Falls back
/// to "item" for an app that hasn't named its own - which reads as placeholder text, and is meant to.
export const itemNoun = (app) => (app && app.itemNoun) || 'item';

/// And MANY of them, for the places that need a plural (a column header). Naive `+ 's'` by default,
/// which is right for notes and recipes and pages and wrong for entries - so an app whose plural is
/// irregular says so, rather than every caller reaching for a pluralizer or dodging the plural.
export const itemPlural = (app) => (app && app.itemPlural) || `${itemNoun(app)}s`;

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

/// Does this app, showing this bucket, hold that document?
///
/// Membership IS the rule: a document is in view when it's a member of the notebook on screen,
/// and the everything-view holds everything. The unbucketed live ONLY in the everything-view
/// (labeled "unfiled" there) - that surface is the formal home for strays, and it retired the
/// old catch-all clause that quietly mingled them into TurboNotes' home notebook (settled
/// 2026-08-01; the default-app clause predated All, when "something has to hold them" had
/// nowhere better to point).
export function bucketHolds(doc, app, bucket) {
    if (!doc || !app) return false; // nothing holds a document that isn't there
    if (app.everything) return true; // the everything-view: all notebooks, plus the unbucketed
    return (doc.buckets || []).includes(bucket);
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

/// A document's OFFICIAL home: the app that opens its first bucket (resolved through the
/// roster) - and the unbucketed's official home IS the everything-view, since nothing else
/// holds them anymore. What the follow-me-home button navigates to; the router's deep-link
/// correction then picks the right notebook, because the document knows which buckets hold it.
export const homeAppFor = (doc, roster) => {
    const first = ((doc && doc.buckets) || [])[0];
    return first ? appForStyle(appTypeOf(first, roster)) : appById('all');
};
