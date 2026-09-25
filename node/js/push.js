// Web Push in this browser (node/src/webpush.rs; the service worker is js/sw.js): the control that
// turns it on and off for one persona, and the listener that lets a notification's click route an
// already-open tab.
//
// On is per BROWSER and per persona. The browser holds one push subscription for this origin; the
// node records it once per persona that asked for it. So "on" means "this browser's endpoint is
// among the ones the node pushes to for this persona", which the node answers (`endpoints`), and
// turning it off tells the node to forget this persona here - it never unsubscribes the browser,
// whose subscription may be serving another persona too.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import htm from 'htm';

import { api } from './net.js';
import { t } from './i18n.js';
import { keyBytes, pushSupport, subscribedHere } from './pure/push.js';

const html = htm.bind(h);

const support = () =>
    pushSupport({
        desktop: !!window.__ringtome_launch_token,
        secure: window.isSecureContext,
        serviceWorker: 'serviceWorker' in navigator,
        pushManager: 'PushManager' in window,
        notification: 'Notification' in window,
        permission: 'Notification' in window ? Notification.permission : 'default',
    });

/// This browser's current push subscription, if it has one (and a worker registered to hold it).
async function currentSubscription() {
    const reg = await navigator.serviceWorker.getRegistration('/');
    return reg ? reg.pushManager.getSubscription() : null;
}

/// "Notify me in this browser" for one persona. Renders nothing in the desktop app, which
/// notifies natively.
export const PushToggle = ({ root }) => {
    const [state, setState] = useState(support());
    const [on, setOn] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [report, setReport] = useState(null);

    useEffect(() => {
        if (state !== 'ready') return undefined;
        let live = true;
        (async () => {
            try {
                const [{ endpoints }, sub] = await Promise.all([api(`/api/identity/${root}/push`), currentSubscription()]);
                if (live) setOn(subscribedHere(sub && sub.endpoint, endpoints));
            } catch {
                /* the control starts off; turning it on will say what went wrong */
            }
        })();
        return () => {
            live = false;
        };
    }, [root, state]);

    const turnOn = async () => {
        setBusy(true);
        setError(null);
        try {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                setState(support());
                return;
            }
            const { public_key } = await api(`/api/identity/${root}/push`);
            const reg = await navigator.serviceWorker.register('/sw.js');
            await navigator.serviceWorker.ready;
            let sub = await reg.pushManager.getSubscription();
            const wanted = keyBytes(public_key);
            const sameKey = (s) => {
                const k = s && s.options && s.options.applicationServerKey && new Uint8Array(s.options.applicationServerKey);
                return !!k && k.length === wanted.length && k.every((b, i) => b === wanted[i]);
            };
            // A subscription made against another key (this node's key changed, or another node
            // on this origin) cannot carry our pushes: replace it.
            if (sub && !sameKey(sub)) {
                await sub.unsubscribe();
                sub = null;
            }
            if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted });
            await api(`/api/identity/${root}/push`, { method: 'POST', body: JSON.stringify(sub.toJSON()) });
            setOn(true);
        } catch (e) {
            setError(e.message || String(e));
        } finally {
            setBusy(false);
        }
    };

    const turnOff = async () => {
        setBusy(true);
        setError(null);
        try {
            const sub = await currentSubscription();
            if (sub) await api(`/api/identity/${root}/push/forget`, { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) });
            setOn(false);
        } catch (e) {
            setError(e.message || String(e));
        } finally {
            setBusy(false);
        }
    };

    // The diagnostic (webpush.rs's push_test): push now, and say what each push service answered.
    // "Delivered" with nothing on screen means the browser or the OS is withholding it - on a Mac,
    // System Settings > Notifications, for this browser, or a Focus mode (2026-09-25: Curtis's
    // first live test "failed" at night because Do Not Disturb filed every alert silently).
    const sendTest = async () => {
        setBusy(true);
        setError(null);
        setReport(null);
        try {
            const { deliveries } = await api(`/api/identity/${root}/push/test`, { method: 'POST' });
            setReport(deliveries || []);
        } catch (e) {
            setError(e.message || String(e));
        } finally {
            setBusy(false);
        }
    };

    if (state === 'desktop' || state === 'unsupported') return null;
    if (state === 'insecure') {
        return html`<p class="push-note">${t('push.needs-https', 'notifications in this browser need https (or localhost)')}</p>`;
    }
    if (state === 'denied') {
        return html`<p class="push-note">${t('push.blocked', 'notifications are blocked for this site - your browser\'s settings can allow them')}</p>`;
    }
    return html`<div class="push-toggle">
        <button class="push-button" disabled=${busy} onClick=${on ? turnOff : turnOn}>
            ${on ? t('push.stop-notifying', 'stop notifying this browser') : t('push.notify-this-browser', 'notify me in this browser')}
        </button>
        ${on && html`<button class="push-button" disabled=${busy} onClick=${sendTest}>${t('push.send-a-test', 'send a test')}</button>`}
        ${error && html`<span class="push-error">${error}</span>`}
        ${report &&
        html`<span class="push-note">
            ${report.length === 0
                ? t('push.no-browsers', 'no browser is subscribed for this persona')
                : report.map((d) => `${d.service}: ${d.outcome}`).join(' · ')}
            ${report.some((d) => d.outcome === 'delivered') &&
            html` - ${t('push.delivered-but-nothing', 'delivered; if nothing popped up, look in your notification centre - a Focus mode like Do Not Disturb files them silently, and on a Mac System Settings > Notifications decides for this browser')}`}
        </span>`}
    </div>`;
};

/// A notification clicked while a tab is open: the service worker focuses the tab and says
/// where to go (js/sw.js); this follows, inside the router, without a reload.
export const PushRoutes = () => {
    const loc = useLocation();
    useEffect(() => {
        if (!('serviceWorker' in navigator)) return undefined;
        const onMessage = (event) => {
            const d = event.data;
            if (d && d.type === 'route' && typeof d.route === 'string' && d.route.startsWith('/home')) loc.route(d.route);
        };
        navigator.serviceWorker.addEventListener('message', onMessage);
        return () => navigator.serviceWorker.removeEventListener('message', onMessage);
    }, [loc]);
    return null;
};
