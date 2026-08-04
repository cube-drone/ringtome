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
// the unload path (see pure/keepalive.js for why that flag is conditional).

export async function api(path, options = {}) {
    const res = await fetch(path, {
        credentials: 'same-origin',
        // A FormData body picks its own multipart Content-Type (boundary included) - naming
        // one here would break the upload; everything else that carries a body is JSON.
        headers:
            options.body && !(options.body instanceof FormData)
                ? { 'Content-Type': 'application/json' }
                : undefined,
        ...options,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(body.message || `request failed (${res.status})`);
        err.status = res.status;
        // The server's structural discriminator, when it sent one (error.rs `code`). One code
        // matters enough to announce globally: "revoked-signer" means this computer is no
        // longer part of the persona - any surface can hit it mid-write, and the farewell
        // flow (persona.js) listens rather than every caller learning to check.
        err.code = body.code;
        if (body.code === 'revoked-signer') {
            window.dispatchEvent(new CustomEvent('ringtome:revoked-signer'));
        }
        throw err;
    }
    return body;
}

/**
 * The same client, for a body that is not JSON: a public document's words, served as bytes
 * under their own mime type (`/id/<root>/docs/<id>/body`). Same session, same thrown-Error
 * contract with `err.status` - only the parse differs, which is exactly why this lives here
 * beside `api()` rather than as a bare `fetch` in whichever module wanted text this week.
 */
export async function apiText(path, options = {}) {
    const res = await fetch(path, { credentials: 'same-origin', ...options });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
        const err = new Error(`request failed (${res.status})`);
        err.status = res.status;
        throw err;
    }
    return text;
}

/**
 * The one job `fetch` cannot do: report upload progress. Same JSON-out, same thrown-Error contract
 * as `api()`, so a caller cannot tell which transport it got - only the progress callback differs.
 *
 * `body` is whatever XHR can send directly: a `File`/`Blob` for a single blob, or a `FormData` for
 * the video fallback's two parts. That difference was two 27-line twins before.
 *
 * @param onPct  called with 0-100 as the bytes go up (only while the length is known)
 */
export function xhrUpload(url, body, onPct) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.responseType = 'json';
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && onPct) onPct(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(xhr.response);
                return;
            }
            const message = (xhr.response && xhr.response.message) || `upload failed (${xhr.status})`;
            const err = new Error(message);
            err.status = xhr.status;
            reject(err);
        };
        xhr.onerror = () => reject(new Error('upload failed (network)'));
        xhr.send(body);
    });
}
