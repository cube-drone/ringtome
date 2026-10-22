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
import { cacheKeyed } from './pure/cachekey.js';

/// The shell's key for this launch, or nothing at all in a browser. Read per call rather than
/// cached: it is set before the first script runs, and a value read once at module load would
/// be a second place for it to go stale. Since 2026-09-28 it signs nobody in - the desktop app's
/// window signs in like any browser - and only names the window (`X-Ringtome-Window`), so the
/// node knows whose alerts the operating system should show.
const launchToken = () =>
    typeof window === 'undefined' ? null : window.__ringtome_launch_token || null;

/// Is this the desktop app, rather than a browser? The shell's key is on the window only there.
/// What decides "Device" over "Server", and "show in folder" over "download".
export const isDevice = () => !!launchToken();

/// ...and the desktop app on Linux, whose webview is a poorer place to be than the person's own
/// browser (Curtis, 2026-09-28); its sign-in says so.
export const isLinuxApp = () => isDevice() && window.__ringtome_platform === 'linux';

/// ...and the desktop app on a Mac.
export const isMacApp = () => isDevice() && window.__ringtome_platform === 'macos';

/// ...and the app on a computer rather than a phone: the shell that takes the page's requests
/// (desktop/src/requests.rs runs on the desktop only).
export const isDesktopApp = () =>
    isDevice() && ['macos', 'windows', 'linux'].includes(window.__ringtome_platform);

/// The window's name for itself, as headers: empty in a browser, where the cookie is all there is.
function authHeaders() {
    const token = launchToken();
    return token ? { 'X-Ringtome-Window': token } : {};
}

/// Save a file this page made - `blob`, suggesting `name` - to the person's own disk. In a browser,
/// the ordinary way: a link to it, clicked. In the desktop app that does nothing (a webview
/// downloads nothing from a `blob:` link - Curtis, 2026-09-28, the spare key going nowhere), so the
/// file goes to the node, which asks the app to save it, and the app asks where (shell.rs).
export async function saveFile(name, blob) {
    if (isDevice()) {
        await api(`/api/shell/save?name=${encodeURIComponent(name)}`, {
            method: 'POST',
            body: blob,
            headers: { 'Content-Type': blob.type || 'application/octet-stream' },
        });
        return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    // Not at once: some browsers start reading the file only after the click returns.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/// A file the node makes on request - an ePub (epub.rs) - fetched and saved as the page's own files
/// are (`saveFile`): under the name the node gives it, else `fallback`. A refusal throws with the
/// node's words, as `api` does. While the node is still making it (`202`), `onPending` hears how
/// far it has got ({ done, total }) and the file is asked for again shortly.
export async function downloadFile(path, fallback, onPending = () => {}) {
    let res;
    for (;;) {
        res = await fetch(path, { credentials: 'same-origin', headers: authHeaders() });
        if (res.status !== 202) break;
        const made = await res.json().catch(() => ({}));
        if (made.status === 'failed')
            throw new Error(made.error || `request failed (${res.status})`);
        onPending(made);
        await new Promise((r) => setTimeout(r, 1500));
    }
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
            body.key
                ? t(body.key, body.message || '', body.params)
                : body.message || `request failed (${res.status})`,
        );
    }
    const named = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '');
    await saveFile(named ? named[1] : fallback, await res.blob());
}

/// GETs of one address out at once, shared (plans/CACHE.md, Stage 9): the notebook's tree pane and
/// its book column, a document's reader and its snippet, a card and its neighbour each asked the
/// node for the same thing in the same instant. Each caller gets its own copy of the answer, so
/// none can change another's. A request with a body, a method, or a signal to cancel it goes
/// alone - cancelling one caller's must never cancel another's.
const inFlight = new Map();

export function api(path, options = {}) {
    const plainGet =
        (!options.method || options.method === 'GET') && !options.body && !options.signal;
    if (!plainGet) return apiOnce(path, options);
    const key = `${path}\u0000${JSON.stringify(options.headers || {})}`;
    let shared = inFlight.get(key);
    if (!shared) {
        shared = apiOnce(path, options).finally(() => inFlight.delete(key));
        inFlight.set(key, shared);
    }
    return shared.then((answer) =>
        typeof structuredClone === 'function' ? structuredClone(answer) : answer,
    );
}

/// An interval's callback that does nothing while the tab is hidden (plans/CACHE.md, Stage 9):
/// notifications, the chat rooms and the feed's look polled a hidden tab every half minute. Each
/// poller also asks on focus, so a reader coming back sees it fresh.
export const whileVisible = (fn) => () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    fn();
};

async function apiOnce(path, options = {}) {
    // The caller's own headers are merged rather than replaced, and they win: ours are
    // defaults, and one of them - the launch token - must survive a caller that sets any.
    const { headers: given, ...rest } = options;
    // A GET whose query repeats a key is told apart from its neighbours at the CDN (pure/cachekey.js).
    const res = await fetch(options.method && options.method !== 'GET' ? path : cacheKeyed(path), {
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
        // Which sentence it was (error.rs `key`), for a caller that answers one refusal its own way.
        err.key = body.key;
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
            title = new TextDecoder().decode(
                Uint8Array.from(hex.match(/../g) || [], (b) => parseInt(b, 16)),
            );
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

/// A file's bytes, as `apiText` reads its words - the cassette reads a song a second time to find
/// its kicks (player.js).
export async function apiBytes(path) {
    const res = await fetch(path, { credentials: 'same-origin', headers: authHeaders() });
    if (!res.ok) {
        const err = new Error(`request failed (${res.status})`);
        err.status = res.status;
        throw err;
    }
    return res.arrayBuffer();
}

/// The node's upload cap, from the page (ui.rs `app_page`), or null when the page doesn't say.
export function maxUploadBytes() {
    const el = document.querySelector('meta[name="app-max-upload"]');
    const n = el ? Number(el.getAttribute('content')) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
}

const megabytes = (n) => `${Math.round(n / (1024 * 1024))} MB`;

/// What a file too large for the node is told: its size when known, and the cap.
function tooLarge(size, max) {
    return size && max
        ? t('net.upload-too-large', 'that file is {size} - more than this place takes ({max})', {
              size: megabytes(size),
              max: megabytes(max),
          })
        : t('net.upload-too-large-plain', 'that file is larger than this place takes');
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
        // Larger than this place takes: said before a byte goes (Curtis, 2026-10-10: a 165 MB file
        // ended "upload failed (network)" - a server refuses an over-cap body before reading it, and
        // the browser sees only the connection drop).
        const max = maxUploadBytes();
        if (max && body instanceof Blob && body.size > max) {
            const err = new Error(tooLarge(body.size, max));
            err.status = 413;
            reject(err);
            return;
        }
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.responseType = 'json';
        for (const [name, value] of Object.entries(authHeaders()))
            xhr.setRequestHeader(name, value);
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && onPct) onPct(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(xhr.response);
                return;
            }
            const message =
                (xhr.response && xhr.response.message) ||
                (xhr.status === 413
                    ? tooLarge(body instanceof Blob ? body.size : null, max)
                    : t('net.upload-failed-status', 'the upload failed ({status})', {
                          status: xhr.status,
                      }));
            const err = new Error(message);
            err.status = xhr.status;
            reject(err);
        };
        xhr.onerror = () =>
            reject(
                new Error(
                    t(
                        'net.upload-cut-off',
                        'the upload was cut off before it finished - the connection dropped, or something between here and the server refused a file this size. Try again, or try a smaller file.',
                    ),
                ),
            );
        xhr.send(body);
    });
}
