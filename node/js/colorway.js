// The colourways (Curtis, 2026-09-30): the whole app in horse-relax, the beige and teal it was born
// in; witchlight, black and purple with a yellow accent; doors-xp, something windowsy; bosc,
// something mac-ossy; micross, white, royal blue and cherry red; or terminal, black and lime green. A colourway is only a `data-colorway` on
// the page root - tokens.css redefines every colour under it. Yours is a profile field, `colorway`,
// public on purpose: on a person's page the app wears THEIRS, and everywhere else your own. Signed
// out, horse-relax, but on a person's page theirs all the same.
//
// The last one worn is kept in this browser, and put on before anything draws, so a witchlight
// persona's reload doesn't flash beige before their profile arrives - by index.html's first script
// (2026-10-02; the bundle runs after the first paint), which also wears a person's own when the
// server names it in their page's head (`page-colorway`). This module starts from the same place.
import { useEffect } from 'preact/hooks';

export const COLORWAYS = ['horse-relax', 'witchlight', 'doors-xp', 'bosc', 'micross', 'terminal'];
export const DEFAULT_COLORWAY = 'horse-relax';
const KEPT = 'colorway';

const known = (c) => (COLORWAYS.includes(c) ? c : null);
let own = null; // the reader's
let page = null; // the person whose page this is

const wear = (colorway) => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.colorway = colorway;
};

const apply = () => wear(known(page) || known(own) || DEFAULT_COLORWAY);

// Where index.html left it: a person's page named by the server (theirs until their profile says,
// and `usePageColorway` takes over), else the last one this browser wore.
try {
    const named =
        typeof document !== 'undefined' && document.querySelector('meta[name="page-colorway"]');
    page = known(named && named.content);
    own = known(localStorage.getItem(KEPT));
    apply();
} catch {
    /* no storage: the default until a profile says otherwise */
}

/// The reader's own colourway. Kept for the next reload. `undefined` is "not known yet" - the
/// profile hasn't been read, or hasn't arrived on this computer - and changes nothing: what's worn
/// stays (2026-10-02: the first render, before the mirror answered, took the kept colourway off and
/// put the default on, so the page flashed it right after index.html had avoided it). `null` is
/// "signed out", and clears it.
export function useOwnColorway(value) {
    useEffect(() => {
        if (value === undefined) return;
        own = known(value);
        try {
            if (own) localStorage.setItem(KEPT, own);
            else localStorage.removeItem(KEPT);
        } catch {
            /* no storage */
        }
        apply();
    }, [value]);
}

/// While a person's page is showing: their colourway, until it closes. `undefined` is "their profile
/// hasn't arrived": whatever is worn stays (the colourway their page's head named, if any) rather
/// than flashing the reader's own until it does; `null` is "they chose none".
export function usePageColorway(value) {
    useEffect(() => {
        if (value === undefined) return;
        page = known(value);
        apply();
    }, [value]);
    // Leaving their page, by any road - their profile arrived or never did - takes theirs off.
    useEffect(
        () => () => {
            page = null;
            apply();
        },
        [],
    );
}
