// Portable references: pasted text that names THIS node by absolute URL gets relativized, so
// a document never bakes in one server's address for content the persona carries everywhere
// (a `http://localhost:5281/api/...` embed works exactly until the persona is read anywhere
// else - field-raised 2026-07-31). The SPA only ever talks to the node that served it, so
// `location.origin` is a complete self-test: any absolute URL under it is a self-reference.
// The honest boundary: a URL copied under one of the node's OTHER names (a different port or
// hostname, another day) doesn't match and passes through untouched.

/// Strip this node's own origin from every absolute self-URL in `text`, leaving the
/// origin-relative path (`http://host/api/x` -> `/api/x`, `/home/...` links alike). Only
/// origin-followed-by-slash matches, so prose that merely mentions the bare origin survives.
export function stripSelfOrigin(text, origin) {
    if (!text || !origin) return text;
    return text.split(origin + '/').join('/');
}

/// The `?via=` set for a minted address: this node first (the one provably alive - it is
/// serving the page), then the liveliest known peers, deduped, capped at TEN (widened from
/// three, 2026-08-02: with no root-directory backstop yet, the hints ARE the ladder, and a
/// fast-moving identity survives exactly as long as some listed node answers - so the URL
/// spends length on liveness; base58 dressing claws half of it back).
export function viaHints(self, peers = [], cap = 10) {
    const out = [];
    for (const key of [self, ...peers]) {
        if (key && !out.includes(key)) out.push(key);
        if (out.length >= cap) break;
    }
    return out;
}

/// The mirror image of the stripper: MINT the persona's shareable identity address
/// (PROJECT_PLAN, Addressing - "The prefix gets its name: /id/"). The origin comes from the
/// operator's declared public URL and nowhere else - never window.location, whose origin
/// (localhost, a LAN name, a tailnet alias) proves nothing about what the world can dial. No
/// declared URL means the origin-free path form: minimal, always correct, and the honest
/// shape for a node the web cannot reach. `via` keys are reachability hints (node keys,
/// never addresses); an empty set leaves the query off entirely.
export function identityAddress({ publicUrl, root, via = [] }) {
    const base = (publicUrl || '').trim().replace(/\/+$/, '');
    const keys = (via || []).filter(Boolean);
    const query = keys.length ? `?via=${keys.join(',')}` : '';
    return `${base}/id/${root}${query}`;
}
