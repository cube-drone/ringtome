// The message layer: every word the app says to a person passes through `t`.
//
// The shape is `t(key, seed, params)` - a STABLE key, the sentence written out at the call site,
// and the values that fill its holes:
//
//     t('computers.was-this-computer-really-you', 'Was this computer really you?')
//     t('people.nobody-matches', 'nobody matches "{query}" - try fewer letters.', { query })
//
// LOOKUP ORDER, which is the whole design in one line:
//
//     the active catalog's entry for `key`   ->   the seed at the call site
//
// The seed is a FALLBACK, not "the English". `locales/en.js` is a catalog like any other and it
// wins over the seed; English is not a special case, and pretending it were would leave `en-GB`
// and every copy edit that doesn't touch code with nowhere to live. What the seed is for: it keeps
// a screen readable as prose (nobody should have to go fetch a string to review a component), it
// bootstraps a new key into the catalog, and it is the safety net if a catalog is ever missing an
// entry.
//
// SO: TO CHANGE WHAT THE APP SAYS IN ENGLISH, EDIT `locales/en.js`. It is authoritative. Running
// `just strings` then rewrites the seeds in the source to agree with it - the sync is one-way for
// a key that already exists (catalog -> code), and the other way only for a key the catalog has
// never seen (code -> catalog). Editing a seed by hand and regenerating will simply put it back.
//
// WHY BOTH a key and a seed. Using the English AS the key is tempting - nothing to invent, nothing
// to look up - but it makes every copy edit a two-place change: the call site and the key of every
// translation. Miss one and the translations don't go stale, they silently vanish, and the
// fallback hides it. A stable key survives rewording. Keys are minted once and NEVER edited
// afterwards: a key is a name, not a summary, and renaming one orphans every translation
// attached to it.
//
// Locale is read once at startup. Switching languages is a reload, deliberately: a live swap
// would mean every component re-rendering off a global, and there is no user asking for it yet.
import en from './locales/en.js';

/// Every catalog the bundle carries, English among them.
///
/// English is NOT a special case, and the seat matters: `en` is an ordinary table that wins over
/// the call-site text exactly the way `fr` does. Treating "the default" and "the English locale" as
/// the same thing is a category error - the default is what you reach when a lookup FAILS, and it
/// would leave `en-GB` (or a copy edit that never touches code) with nowhere to live.
///
/// To add a language: copy `locales/en.js` to `locales/fr.js`, translate its values - the keys are
/// already right - then import it and name it here. A key with no entry falls back to the seed at
/// its call site, so a half-finished translation is a working app, and a regional variant can hold
/// only the handful of keys it disagrees about.
const CATALOGS = { en };

/// The active table: `{ key: translated }`. Empty for English, which needs no table because the
/// English is already at every call site.
let active = {};
let activeTag = 'en';

/// `{name}` holes filled from `params`. A hole with no matching param is left standing rather
/// than blanked - a visible `{count}` in the UI is a bug report; a silent empty string is not.
function fill(template, params) {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (whole, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
    );
}

/**
 * What the app says for `key` in the active locale, falling back to the seed.
 *
 * @param key     stable, minted once, never edited
 * @param seed    the sentence as written at the call site, with `{name}` holes - a fallback and a
 *                bootstrap, NOT the English (that lives in `locales/en.js`, which outranks this)
 * @param params  values for those holes
 */
export function t(key, seed, params) {
    const template = active[key] ?? seed;
    return fill(template, params);
}

/// The best-matching catalog for a BCP-47 tag: exact match first, then the base language, then
/// English. `fr-CA` finds `fr`; anything unknown finds nothing and English stands.
export function chooseLocale(tag) {
    if (!tag) return 'en';
    const wanted = String(tag).toLowerCase();
    if (CATALOGS[wanted]) return wanted;
    const base = wanted.split('-')[0];
    return CATALOGS[base] ? base : 'en';
}

/// Point `t` at a locale. Called once at startup; exported so tests can pin one.
export function setLocale(tag) {
    activeTag = chooseLocale(tag);
    active = CATALOGS[activeTag] || {};
    if (typeof document !== 'undefined' && document.documentElement) {
        // The `lang` attribute is what a screen reader reads pronunciation from, so it follows
        // the catalog rather than being hard-coded in index.html.
        document.documentElement.lang = activeTag;
    }
    return activeTag;
}

/// Which locale is actually in force - the resolved tag, not what was asked for.
export function locale() {
    return activeTag;
}

/// The reader's own preference, as the browser reports it.
export function detectLocale() {
    if (typeof navigator === 'undefined') return 'en';
    return chooseLocale(navigator.language || 'en');
}
