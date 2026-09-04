// The application registry: the curated menu of apps (PROJECT_PLAN, The Client Is a Console -
// a console with good games, not an app-builder). Each app carries a `style` - its app-type.
//
// The bucket <-> app-type mapping is mostly implicit: a bucket whose NAME is an app-type simply
// IS that type (the `feed` bucket is a feed bucket, no mapping needed), so every app has an
// eponymous bucket we can just assume exists - open the feed app and you're working in the
// `feed` bucket. The registry (`name -> app`, on the server) is only consulted for
// USER-named buckets like `dream-diary`. Anything we can't resolve falls back to `default`
// (Writer), so an unknown style never strands you - which is also what retires an app
// gracefully: the buckets of a style nobody serves anymore simply open in Writer.
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
        // People brings its own control to the header's search slot: a LOOKUP, not a filter
        // (apps/people.js, PeopleLookup). The shell renders it in place of the search box.
        lookup: true,
    },
    // The app's two nouns, both in the user's words rather than ours. `bucketNoun` is what ONE
    // bucket is called, Capitalised because it lands in titles and prompts ("New Notebook",
    // "Delete this Notebook…"); `itemNoun` is what one THING INSIDE a bucket is called, lowercase
    // because it lands mid-sentence ("+ new note", "a new page in this section"). A notebook holds
    // notes and a feed holds posts; neither of them holds "items".
    {
        id: 'notes',
        // Writer (renamed from Writer, 2026-09-02, the day the Journal was retired): the
        // core notes-and-editing primitive of the whole application. The route id stays
        // `notes` - it is a persisted key, and the word is right.
        name: 'Writer',
        icon: 'notes',
        style: 'default',
        live: true,
        bucketNoun: 'Notebook',
        itemNoun: 'note',
        // The everything-app, and now the ONLY notebook app. Recipes and Wikibook lived here
        // until 2026-08-08, and the cut is the point: each was this surface with one column
        // taken away - Recipes was the tag column plus the list, Wikibook was the list plus
        // the tree - so shipping them separately bought two app tiles and two vocabularies for
        // no capability. What made the single "complicated notes app" safe to embrace was the
        // tucking: `startsTucked` opens on the plain list, and the tag column and the tree are
        // rails until someone wants them. It is only as monstrous as you choose to make it.
        features: { tagColumn: true, tree: true, bookColumn: true },
        // Columns tucked until this device says otherwise (panes.js `useColTucks`). The list is
        // the app; the other two are the powers it can grow.
        startsTucked: ['tags', 'tree', 'publish'],
    },
    {
        id: 'feed',
        name: 'Feed',
        icon: 'feed',
        live: true,
        // The app that writes in PUBLIC (apps/feed.js). Its drafts are ordinary private
        // notes in one eponymous bucket; posting mints their public form.
        style: 'feed',
        // Feed has a style so its drafts have somewhere to live, but it is not a notebook
        // app, and the shell used to read `style` as "wears the documents chrome" - which
        // put a bucket switcher over a single eponymous bucket and a search box over a
        // component that never receives the query. Both are said outright now.
        soleBucket: true,
        searchable: false,
        bucketNoun: 'Feed',
        itemNoun: 'post',
        // No read-only tab: a post's read view is the feed itself, and the composer is for
        // writing. 'plain' stays listed so a plaintext-format post is still editable - the
        // side-by-side rule (editorModes) hides it whenever side is offered anyway.
        features: {
            tree: false,
            tagColumn: false,
            pin: false,
            publish: false, // the composer's Post button is the door here
            // The claimed date is the post's preferred date (PUBLISH.md): a past date files
            // the post there, a future one schedules it. Off until 2026-09-02, when a post
            // was stamped at publish and the claim had nothing to say.
            date: true,
            modes: ['interactive', 'side', 'plain'],
        },
    },
    {
        id: 'notifications',
        name: 'Notifications',
        icon: 'notifications',
        live: true,
        // The derived-events surface (PROJECT_PLAN, Arrival and Attention: the follow-edge
        // rule): things people you follow did that point at you, folded locally from chains
        // this node already syncs - today, published relationship edges. Not a documents app
        // and not the inbox: strangers' knocks are the future envelope path, not this list.
        itemNoun: 'notification',
    },
    {
        id: 'lost-found',
        name: 'Lost & Found',
        icon: 'lostFound',
        live: true,
        // Every PRIVATE document, from every notebook, plus the unbucketed - the one surface
        // where nothing can be orphaned out of sight (a repudiation striking a bucket's
        // definition relocates its documents; this is where they remain findable).
        //
        // Named for what you come here to DO rather than what it holds, which is the honest
        // trade: most of what is listed is filed and perfectly happy in its own notebook, and
        // only the strays are genuinely lost. It was "All" until 2026-08-08, and that name told
        // two lies at once - it is not everything (public posts live on the feed, not here) and
        // nobody ever went looking for "all". It is emphatically NOT a trash can: a deleted
        // document is tombstoned out of every list and search, including this one.
        // No `style` on purpose: it owns no bucket type, mints no implicit bucket, and the
        // bucket switcher never shows. A browsing surface: rows carry their bucket names and
        // a follow-me-home button to each document's own app; creation stays with the real
        // apps. Its URLs live under /lost-found and never re-dress into cozy bucket addresses -
        // one document shows in many places, but a /lost-found link means this surface.
        everything: true,
        bucketNoun: 'Lost & Found',
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
    tree: false, // the document tree pane (doc/tree.js), right of the list
    pin: true, // the pin chip - floats the doc atop the LIST, so list-less apps drop it
    publish: true, // the publish chip (PUBLISH.md): the feed composer has its own Post button
    bookColumn: false, // the Publish column (BOOKS.md): a notebook published as a book
};

/// What ONE thing inside this app's bucket is called, lowercase, for mid-sentence use. Falls back
/// to "item" for an app that hasn't named its own - which reads as placeholder text, and is meant to.
export const itemNoun = (app) => (app && app.itemNoun) || 'item';

/// And MANY of them, for the places that need a plural (a column header). Naive `+ 's'` by default,
/// which is right for notes and recipes and pages and wrong for entries - so an app whose plural is
/// irregular says so, rather than every caller reaching for a pluralizer or dodging the plural.
export const itemPlural = (app) => (app && app.itemPlural) || `${itemNoun(app)}s`;

/// The view modes an editor actually OFFERS for a document, from the format's possibilities
/// narrowed by the app's feature list - plus two house rules (2026-08-06):
///
///   - Wherever SIDE-BY-SIDE is available, the plaintext tab is hidden: side-by-side contains
///     the raw source already, so the plain tab was a duplicate that crowded the row. (A
///     plaintext-format document never offers side-by-side, so plain survives exactly where
///     it is the only way to edit.)
///   - An app's list that leaves a format nothing falls back to the format's full set rather
///     than trapping the document.
export function editorModes(format, featureModes) {
    const base =
        format === 'marquee' ? ['interactive', 'side', 'plain', 'read'] : ['plain', 'read'];
    let available = base.filter((m) => featureModes.includes(m));
    if (available.length === 0) available = base;
    if (available.includes('side')) available = available.filter((m) => m !== 'plain');
    return available;
}

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
/// and Lost & Found holds every private document. The unbucketed live ONLY in the everything-view
/// (labeled "unfiled" there) - that surface is the formal home for strays, and it retired the
/// old catch-all clause that quietly mingled them into Writer's home notebook (settled
/// 2026-08-01; the default-app clause predated this surface, when "something has to hold
/// them" had nowhere better to point).
export function bucketHolds(doc, app, bucket) {
    if (!doc || !app) return false; // nothing holds a document that isn't there
    if (app.everything) return true; // Lost & Found: every notebook, plus the unbucketed
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
/// roster) - and the unbucketed's official home IS Lost & Found, since nothing else holds
/// them anymore. What the follow-me-home button navigates to; the router's deep-link
/// correction then picks the right notebook, because the document knows which buckets hold it.
export const homeAppFor = (doc, roster) => {
    const first = ((doc && doc.buckets) || [])[0];
    return first ? appForStyle(appTypeOf(first, roster)) : appById('lost-found');
};
