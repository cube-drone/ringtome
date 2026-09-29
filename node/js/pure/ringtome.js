// Ringtome addresses (PROJECT_PLAN's "`/ringtome/` replaces `/home`, `/in` and `/id`", 2026-09-28):
// one grammar under one prefix that can only be us, so a link is recognizable at ANY origin and
// every Ringtome renderer can rehome it to its own node.
//
//   /ringtome/user/<root>                              a person
//   /ringtome/user/<root>/post/<doc>                   a public post
//   /ringtome/user/<root>/post/<book>/page/<doc>       a book's page (the page's own post id)
//   /ringtome/user/<root>/doc/<doc>                    any other document, private or public
//   /ringtome/user/<root>/room/<doc>[/line/<hash>]     a chat room, or one line in it
//
// Two query hints ride any of them, and only these two: `?via=` (where the person can be reached)
// and, on a document filed in more than one notebook, `?bucket=` (the notebook it was opened in -
// a preference, never an authority: honoured only for the document's owner, and only while it is
// still filed there).
//
// `<root>` is minted in the short form (bare base58) and read in any form the speakable parser
// takes; this module leaves the key's spelling to its caller and only carries the segment. The
// origin never matters: it is a lens, and resolution is by key.

export const PREFIX = '/ringtome';
const USER = `${PREFIX}/user/`;

const DOC_ID = /^[0-9a-f]{32}$/;
// A segment of a person's address: hex, bare base58, or the worded form - nothing with a slash,
// a query or a fragment.
const SEG = /^[A-Za-z0-9-]{16,}$/;
const LINE = /^[0-9a-f]{8,}$/;

/// The path for a thing, from its parts. `seg` is the person's address segment (already spelled);
/// `doc` a 32-hex document id; `kind` one of post, doc, room.
export function ringtomePath({ seg, kind, doc, page, line }) {
    if (!seg) return '';
    const who = `${USER}${seg}`;
    if (!kind) return who;
    if (kind === 'post') return page ? `${who}/post/${doc}/page/${page}` : `${who}/post/${doc}`;
    if (kind === 'room') return line ? `${who}/room/${doc}/line/${line}` : `${who}/room/${doc}`;
    return `${who}/doc/${doc}`;
}

/// Read an address - a whole URL at any origin, or a path - into its parts, or null when it is not
/// one of ours. `{ seg, kind, doc, page, line, via, bucket, path }`: `kind` is null for a person,
/// `via` the query's hint list (possibly empty), `bucket` the notebook slug or null, `path` the
/// origin-free address with its hints kept.
export function parseRingtome(text) {
    const s = (text || '').trim();
    if (!s) return null;
    let pathname;
    let search = '';
    const abs = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?(\?[^#]*)?/.exec(s);
    if (abs) {
        pathname = abs[1] || '/';
        search = abs[2] || '';
    } else if (s.startsWith('/')) {
        const q = s.indexOf('?');
        const h = s.indexOf('#');
        const end = h < 0 ? s.length : h;
        pathname = q < 0 || q > end ? s.slice(0, end) : s.slice(0, q);
        search = q < 0 || q > end ? '' : s.slice(q, end);
    } else {
        return null;
    }
    if (!pathname.startsWith(USER)) return null;
    const parts = pathname.slice(USER.length).split('/').filter((p, i, all) => p !== '' || i < all.length - 1);
    if (parts.length && parts[parts.length - 1] === '') parts.pop();
    const [seg, kind, doc, sub, subValue, ...rest] = parts;
    if (!seg || !SEG.test(seg) || rest.length) return null;
    const out = { seg, kind: null, doc: null, page: null, line: null, via: viaOf(search), bucket: bucketOf(search) };
    if (kind === undefined) return withPath(out);
    if (!['post', 'doc', 'room'].includes(kind) || !doc || !DOC_ID.test(doc)) return null;
    out.kind = kind;
    out.doc = doc;
    if (sub === undefined) return withPath(out);
    if (kind === 'post' && sub === 'page' && DOC_ID.test(subValue || '')) out.page = subValue;
    else if (kind === 'room' && sub === 'line' && LINE.test(subValue || '')) out.line = subValue;
    else return null;
    return withPath(out);
}

function viaOf(search) {
    const m = /[?&]via=([^&]*)/.exec(search || '');
    if (!m) return [];
    return decodeURIComponent(m[1])
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);
}

const BUCKET_SLUG = /^[a-z0-9][a-z0-9-]*$/;

function bucketOf(search) {
    const m = /[?&]bucket=([^&]*)/.exec(search || '');
    if (!m) return null;
    const slug = decodeURIComponent(m[1]).trim();
    return BUCKET_SLUG.test(slug) ? slug : null;
}

/// An address path with its hints: `?via=` first, then `?bucket=`, each only when present.
export function withHints(path, { via = [], bucket = null } = {}) {
    const q = [];
    if (via && via.length) q.push(`via=${via.join(',')}`);
    if (bucket) q.push(`bucket=${bucket}`);
    return q.length ? `${path}?${q.join('&')}` : path;
}

function withPath(parts) {
    parts.path = withHints(ringtomePath(parts), parts);
    return parts;
}

/// The address as THIS node shows it: the origin dropped, whatever it was, the hints kept. Null
/// for anything that is not a Ringtome address - which stays exactly as written.
export function rehome(text) {
    const parts = parseRingtome(text);
    return parts ? parts.path : null;
}

/// An address the old way (`/id/<seg>`, `/id/<seg>/post/<book>[/<page doc>]`) - the prefix before
/// `/ringtome/` - as its `/ringtome/` path, or null. Only ever a PATH or this node's own URL: `/id/`
/// is ambiguous at a foreign origin, which is why the new prefix exists.
export function fromLegacyId(pathAndQuery) {
    const s = (pathAndQuery || '').trim();
    const m = /^\/id\/([A-Za-z0-9-]{16,})(?:\/post\/([0-9a-f]{32})(?:\/([0-9a-f]{32}))?)?\/?(\?[^#]*)?$/.exec(s);
    if (!m) return null;
    const [, seg, doc, page, search] = m;
    const via = viaOf(search || '');
    const base = ringtomePath({ seg, kind: doc ? 'post' : null, doc, page });
    return via.length ? `${base}?via=${via.join(',')}` : base;
}
