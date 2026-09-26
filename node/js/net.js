// The one way the UI talks to its node: JSON in, JSON out, the session riding along, and the
// server's `{ message }` surfaced as the thrown Error's message so a form can show it verbatim.
//
// The session is an HttpOnly cookie in a browser - `credentials: 'same-origin'` does all of the
// work - and in the DESKTOP app it is the shell's launch token instead (DESKTOP.md, Stage 3),
// which the shell put on `window` before any of this ran. The difference is one header, added
// here and nowhere else: a cookie is carried by anything that reaches loopback, and a header is
// carried only by code that can set one, which a page navigating itself at our door cannot.
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
import { t } from './i18n.js';

/// The shell's key for this launch, or nothing at all in a browser. Read per call rather than
/// cached: it is set before the first script runs, and a value read once at module load would
/// be a second place for it to go stale.
const launchToken = () => (typeof window === 'undefined' ? null : window.__ringtome_launch_token || null);

/// Is this the desktop app, rather than a browser? The shell's key is on the window only there.
/// What decides "Device" over "Server", and "show in folder" over "download".
export const isDevice = () => !!launchToken();

/// The proof this client can offer, as headers. Empty in a browser, where the cookie is the
/// proof and nothing here should touch a token.
export function authHeaders() {
    const token = launchToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
}

/// ...and the same proof for a WebSocket, which has no headers to set: the one string its
/// constructor takes is the subprotocol list, so the token rides there (the node echoes it).
/// Empty in a browser, which is what makes `new WebSocket(url)` the ordinary case.
export function wsProtocols() {
    const token = launchToken();
    return token ? [`ringtome.token.${token}`] : [];
}

export async function api(path, options = {}) {
    // The caller's own headers are merged rather than replaced, and they win: ours are
    // defaults, and one of them - the launch token - must survive a caller that sets any.
    const { headers: given, ...rest } = options;
    const res = await fetch(path, {
        credentials: 'same-origin',
        ...rest,
        // A FormData body picks its own multipart Content-Type (boundary included) - naming
        // one here would break the upload; everything else that carries a body is JSON.
        headers: {
            ...(options.body && !(options.body instanceof FormData)
                ? { 'Content-Type': 'application/json' }
                : {}),
            ...authHeaders(),
            ...(given || {}),
        },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        // The server's prose is translated HERE, once, rather than at each of the fifteen places
        // that display it - so every existing `setError(e.message)` shows the reader's own
        // language without knowing anything changed. `key` is the catalog key and `params` the
        // values that filled the sentence's holes (error.rs); with no catalog entry, `message` is
        // the server's already-formatted English and nothing is lost.
        const err = new Error(
            body.key
                ? t(body.key, body.message || '', body.params)
                : body.message || `request failed (${res.status})`,
        );
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
/// The words, and a sealed post's title beside them (PROJECT_PLAN's Replies under the
/// author's seal, ruling 5): the body door hands the title back to whoever it hands the
/// words, hex-encoded, so no surface needs a key. `{ text, title }`, the title null unless
/// the post is sealed and this reader may have it.
export async function apiTextTitled(path, options = {}) {
    const res = await fetch(path, {
        credentials: 'same-origin',
        ...options,
        headers: { ...authHeaders(), ...(options.headers || {}) },
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
        const err = new Error(`request failed (${res.status})`);
        err.status = res.status;
        throw err;
    }
    const hex = res.headers.get('x-post-title-hex');
    let title = null;
    if (hex && /^[0-9a-f]*$/i.test(hex) && hex.length % 2 === 0) {
        try {
            title = new TextDecoder().decode(Uint8Array.from(hex.match(/../g) || [], (b) => parseInt(b, 16)));
        } catch {
            title = null;
        }
    }
    return { text, title };
}

export async function apiText(path, options = {}) {
    const res = await fetch(path, {
        credentials: 'same-origin',
        ...options,
        headers: { ...authHeaders(), ...(options.headers || {}) },
    });
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
        for (const [name, value] of Object.entries(authHeaders())) xhr.setRequestHeader(name, value);
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
