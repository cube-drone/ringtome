// One subtle browser rule, isolated and tested because it cost real debugging time: fetch's
// `keepalive` flag - the thing that lets a save outlive a closing tab - caps the request body
// at 64 KiB by spec. A larger body with keepalive set is rejected CLIENT-SIDE as an opaque
// NetworkError before the request ever leaves the browser: nothing in the network tab, nothing
// in the server log (field-found 2026-07-25 pasting a ~600KB document, which "never saved").
//
// So keepalive is safe to set only when (a) we actually need it - the page is going away and a
// normal fetch might be killed mid-flight - AND (b) the body fits. A large document flushed on
// unload simply can't use it and falls back to a plain fetch (best-effort, which is all an
// unload flush ever was; the debounced autosave has almost certainly already saved it).

// Headroom under the 64 KiB (65536-byte) spec cap - the quota is shared across a page's
// in-flight keepalive requests, so we don't sail right up to the line.
export const KEEPALIVE_MAX_BYTES = 60_000;

/// Whether this save may set fetch's keepalive flag: only on the unload path, only when the
/// encoded body fits under the cap.
export function keepaliveOk(unloading, bodyByteLength) {
    return unloading === true && bodyByteLength <= KEEPALIVE_MAX_BYTES;
}
