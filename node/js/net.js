// The one way the UI talks to its node: JSON in, JSON out, the session cookie riding along, and
// the server's `{ message }` surfaced as the thrown Error's message so a form can show it
// verbatim. Sessions are an HttpOnly cookie the server sets, so nothing here ever touches a
// token - `credentials: 'same-origin'` does all of the work.
//
// Twelve modules each carried a private copy of this function and three had already drifted: two
// set `err.status` (which the recovery flow's 409 re-homing branch reads) and the other ten
// silently didn't, so whether an error carried its status depended on which module happened to
// raise it. One owner, one contract: `err.status` is ALWAYS the response status, and a body that
// isn't JSON (a 204, an HTML error page from a proxy) reads as `{}` rather than throwing a parse
// error over top of the real failure.
//
// `options` passes through to fetch untouched, which is how `doc/session.js` sets `keepalive` on
// the unload path (see keepalive.js for why that flag is conditional).

export async function api(path, options = {}) {
    const res = await fetch(path, {
        credentials: 'same-origin',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        ...options,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(body.message || `request failed (${res.status})`);
        err.status = res.status;
        throw err;
    }
    return body;
}
