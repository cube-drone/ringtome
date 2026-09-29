// The service worker: Web Push's browser half (node/src/webpush.rs has the node's).
//
// Served from `/sw.js` - the origin's root, so its scope covers the whole app - and deliberately
// NOT part of the bundle: a service worker is its own script with its own lifetime, and the browser
// re-checks it byte for byte on every navigation (the node serves it `no-cache`).
//
// A push is one alert, already decrypted by the browser: { title, body, route, image }. It is shown unless
// one of our tabs is focused and visible - the badge is right there, the same rule the desktop app
// keeps. (Chrome shows a stand-in notification for a push that shows none; it exempts an origin in
// the foreground, which is exactly the case skipped here.) A click focuses a tab and routes it, or
// opens one at the route; only an app path is ever followed.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
    let alert = {};
    try {
        alert = event.data ? event.data.json() : {};
    } catch {
        alert = {};
    }
    event.waitUntil(
        (async () => {
            const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            // The test push (webpush.rs's push_test) is clicked FROM a focused tab: it always shows.
            if (!alert.always && windows.some((w) => w.focused && w.visibilityState === 'visible')) return;
            const image = await pictureOf(alert.image);
            await self.registration.showNotification(alert.title || 'Horse Drawing Tycoon 2', {
                body: alert.body || '',
                data: { route: alert.route || '/ringtome' },
                ...(image ? { image } : {}),
            });
        })()
    );
});

// A room line's picture (2026-09-27), fetched here rather than left to the notification's own
// loader: this fetch carries the reader's session, which a sealed room's picture asks for, and a
// picture that will not come - the node out of reach, the fetch too slow - means a notification
// without one, never no notification. Handed over as a data URL. Only our own paths are fetched.
// (Chrome shows `image` on Windows, Linux and Android; macOS's native banners, Safari and Firefox
// leave it out.)
async function pictureOf(path) {
    if (typeof path !== 'string' || !(path.startsWith('/ringtome/') || path.startsWith('/id/'))) return null;
    try {
        const response = await fetch(path, { credentials: 'same-origin', signal: AbortSignal.timeout(5000) });
        if (!response.ok) return null;
        const blob = await response.blob();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return `data:${blob.type || 'image/avif'};base64,${btoa(binary)}`;
    } catch {
        return null;
    }
}

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    // Only our own app's addresses (`/ringtome/…`, and the old `/home/…`, which the app redirects).
    const wanted = (event.notification.data && event.notification.data.route) || '/ringtome';
    const route = wanted.startsWith('/ringtome') || wanted.startsWith('/home') ? wanted : '/ringtome';
    event.waitUntil(
        (async () => {
            const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            for (const w of windows) {
                if ('focus' in w) {
                    await w.focus();
                    w.postMessage({ type: 'route', route });
                    return;
                }
            }
            await self.clients.openWindow(route);
        })()
    );
});
