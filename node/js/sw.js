// The service worker: Web Push's browser half (node/src/webpush.rs has the node's).
//
// Served from `/sw.js` - the origin's root, so its scope covers the whole app - and deliberately
// NOT part of the bundle: a service worker is its own script with its own lifetime, and the browser
// re-checks it byte for byte on every navigation (the node serves it `no-cache`).
//
// A push is one alert, already decrypted by the browser: { title, body, route }. It is shown unless
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
            await self.registration.showNotification(alert.title || 'Horse Drawing Tycoon 2', {
                body: alert.body || '',
                data: { route: alert.route || '/home' },
            });
        })()
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const wanted = (event.notification.data && event.notification.data.route) || '/home';
    const route = wanted.startsWith('/home') ? wanted : '/home';
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
