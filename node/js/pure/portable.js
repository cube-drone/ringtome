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
