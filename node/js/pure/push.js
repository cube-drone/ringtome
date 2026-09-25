// Web Push's decisions, as values in and values out (STYLE: logic that can be a function is one).

/// A VAPID public key as the node sends it (base64url, no padding) to the bytes
/// `PushManager.subscribe({ applicationServerKey })` wants.
export function keyBytes(base64url) {
    const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

/// What this browser can do about push, in the order a person needs to hear it:
///   'desktop'     - the desktop app, which notifies natively; never offered here
///   'unsupported' - no service workers, no Push API, or no notifications at all
///   'insecure'    - served over plain http from somewhere that isn't localhost
///   'denied'      - the person said no; only the browser's own settings can undo that
///   'ready'       - it can be turned on (or already is)
export function pushSupport({ desktop, secure, serviceWorker, pushManager, notification, permission }) {
    if (desktop) return 'desktop';
    if (!notification) return 'unsupported';
    if (!secure) return 'insecure';
    if (!serviceWorker || !pushManager) return 'unsupported';
    if (permission === 'denied') return 'denied';
    return 'ready';
}

/// Is this browser one of the endpoints the node pushes to for this persona?
export function subscribedHere(endpoint, endpoints) {
    return !!endpoint && Array.isArray(endpoints) && endpoints.includes(endpoint);
}
