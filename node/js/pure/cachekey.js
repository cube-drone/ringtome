// A query a CDN can't confuse with another (2026-10-20). BunnyCDN keys its cache on the first value
// of a repeated parameter, so `?not_bucket=blog&not_bucket=toots` was answered with the copy kept
// for `?not_bucket=blog`, and the left-out toots came back. The node can't stop that from its end:
// the CDN answers from its cache without asking. An address whose keys repeat gets one more
// parameter, `qk`, a fingerprint of the whole query, which the node ignores. The first-value key
// then differs wherever the query does. An address with no repeated key is left exactly as it was,
// so everything else keeps the copies it has.

/// FNV-1a, 32 bits, as hex: short, and the same in every browser.
function fingerprint(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
}

/// `path` with `qk=<fingerprint>` added when a query key repeats; as it was otherwise.
export function cacheKeyed(path) {
    const at = path.indexOf('?');
    if (at < 0) return path;
    const query = path.slice(at + 1);
    const keys = query
        .split('&')
        .filter(Boolean)
        .map((pair) => pair.split('=')[0]);
    if (new Set(keys).size === keys.length) return path;
    return `${path}&qk=${fingerprint(query)}`;
}
