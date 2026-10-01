// The colourways (Curtis, 2026-09-30): the whole app in horse-relax, the beige and teal it was born
// in; witchlight, black and purple with a yellow accent; doors-xp, something windowsy; bosc,
// something mac-ossy; micross, white, royal blue and cherry red; or terminal, black and lime green. A colourway is only a `data-colorway` on
// the page root - tokens.css redefines every colour under it. Yours is a profile field, `colorway`,
// public on purpose: on a person's page the app wears THEIRS, and everywhere else your own. Signed
// out, horse-relax, but on a person's page theirs all the same.
//
// The last one worn is kept in this browser, and put on before anything draws, so a witchlight
// persona's reload doesn't flash beige before their profile arrives.
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

// Before the first paint: the last one this browser wore.
try {
    const kept = known(localStorage.getItem(KEPT));
    if (kept) wear(kept);
} catch {
    /* no storage: the default until a profile says otherwise */
}

/// The reader's own colourway, or null (signed out, or not chosen). Kept for the next reload.
export function useOwnColorway(value) {
    useEffect(() => {
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

/// While a person's page is showing: their colourway, until it closes.
export function usePageColorway(value) {
    useEffect(() => {
        page = known(value);
        apply();
        return () => {
            page = null;
            apply();
        };
    }, [value]);
}
