// The contact ledger's dials, as data: what one persona privately records about another.
// These are EDGE INPUTS to the trust layer (PROJECT_PLAN, Trust) - my direct assessment,
// stored on my private chain; the Advogato joint-flow computation consumes them later and
// nothing here pretends to be that math. Wording rule carried from doctrine: trust is
// "do I believe they're real", never "do I like them" - Interest is the liking dial.
//
// A stored value is a BAND - one of five words, the same five for every dial and every
// system an edge passes through (PROJECT_PLAN, Bands Not Numbers - settled 2026-08-09,
// retiring the 0-100 scale whose in-between values nothing ever consumed). The max trust
// stop IS the vouch (settled 2026-08-02 - PROJECT_PLAN, The Vouch Dissolved into the
// Ledger): a vouch is a positive trust edge its author chose to publish, so the publication
// machinery mints its public statement from this stop plus the `edges_public` consent - no
// separate vouch record exists, here or anywhere.

/// The five bands, weakest first. The order IS the meaning: renderers and the node's routing
/// memo compare bands by ordinal (index), so this array is the one place the ladder lives.
///
/// Values only, deliberately: the human words for each stop live with the UI (js/person.js,
/// `trustStops`/`interestStops`) where they can go through `t()` - a pure module is invisible
/// to the localization scanner and cannot call the catalog, so any prose kept here would be
/// English forever (found 2026-08-09, when the whole worded scale turned out to be exactly
/// that).
export const BANDS = ['none', 'low', 'medium', 'high', 'max'];

/// The private-KV collection carrying everything I record about one contact. Keys inside:
/// `trust`, `interest`, `interest_rebroadcasts`, `edges_public`, `blocked`, `nickname`.
export const contactCollection = (root) => `contact:${root}`;

/// A stored value as a band, or null for "no opinion". Silence and garbage both land on
/// null, never on 'none': an unset dial is the absence of an opinion, while 'none' is one -
/// the same distinction whose collapse (Number(null) is 0) let emphasisOf render unset dials
/// as "Don't show" until 2026-08-08. Values from the retired numeric scale also read as
/// null: pre-User-1, a dropped dev-data dial beats a shim carried forever.
export function bandOf(value) {
    return BANDS.includes(value) ? value : null;
}

/// A band's rung on the five-step ladder (0-4), or null for no opinion.
export function bandOrdinal(value) {
    const band = bandOf(value);
    return band === null ? null : BANDS.indexOf(band);
}
