// The harness's shared boot: one cookie-jar session per node, and a jsdom window running the
// REAL bundle with every browser global the SPA touches - including a real WebSocket (npm
// `ws`, cookie riding along), so the live-cache stream and the Dexie mirror work for real.
// Pure-mirror surfaces (the notes list) render nothing without it, which is how the first
// thumbnail probe came back empty (2026-07-31) and this module got the bridge.
//
// Every scenario script (drive/ui/join/state/...) imports from here; the stubs lived as four
// drifting copies before this file existed, which is the finding that consolidates
// (STYLE.md, the second copy).
import pkg from 'jsdom';
const { JSDOM, ResourceLoader } = pkg;
import 'fake-indexeddb/auto';
import WsClient from 'ws';

import { httpSession, sleep } from './http.mjs';
export { sleep };

/// One node's session: a fetch that keeps cookies (register/login/API calls and everything
/// the booted SPA does share the same jar), plus `boot(path)` opening the real SPA at a path.
/// The cookie fetch itself lives in http.mjs, browser-free, so API-only scripts (the test-data
/// generator) can have it without loading jsdom.
export function session(base) {
    const http = httpSession(base);
    const bridgedFetch = http.fetch;
    const cookieHeader = http.cookieHeader;

    // The browser WebSocket surface mirror.js actually uses (onmessage/onclose/onerror/close),
    // bridged to a real client carrying the session cookie.
    class BridgedWebSocket {
        constructor(url) {
            this.ws = new WsClient(url, { headers: { cookie: cookieHeader() } });
            this.ws.on('open', () => this.onopen && this.onopen());
            this.ws.on('message', (data) => this.onmessage && this.onmessage({ data: data.toString() }));
            this.ws.on('close', () => this.onclose && this.onclose());
            this.ws.on('error', (e) => (this.onerror ? this.onerror(e) : undefined));
        }
        send(d) {
            try {
                this.ws.send(d);
            } catch {
                /* a closing socket shrugs */
            }
        }
        close() {
            try {
                this.ws.close();
            } catch {
                /* already closed */
            }
        }
        addEventListener(t, f) {
            this['on' + t] = f;
        }
        removeEventListener() {}
    }

    const boot = async (path = '/home') => {
        // The initial page GET rides the session jar exactly as a browser's would - the /id
        // surface branches on that cookie (session -> SPA, anonymous -> the static face), so
        // a bare fetch here would boot the wrong audience's page.
        const html = await (await bridgedFetch(path)).text();
        return new JSDOM(html, {
            url: base + path,
            runScripts: 'dangerously',
            pretendToBeVisual: true,
            resources: new ResourceLoader(),
            beforeParse(window) {
                window.fetch = bridgedFetch;
                window.Headers = Headers;
                window.TextEncoder = TextEncoder;
                window.TextDecoder = TextDecoder;
                window.crypto = globalThis.crypto;
                window.requestAnimationFrame = (f) => setTimeout(() => f(Date.now()), 16);
                window.cancelAnimationFrame = clearTimeout;
                window.indexedDB = indexedDB; // fake-indexeddb/auto owns the global
                window.IDBKeyRange = IDBKeyRange;
                window.WebSocket = BridgedWebSocket;
                window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
                window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
                window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
                window.scrollTo = () => {};
                window.Element.prototype.scrollIntoView = () => {}; // jsdom doesn't implement it
                window.prompt = (msg) => {
                    console.log(`[prompt] ${msg} -> "${window.__nextPrompt}"`);
                    return window.__nextPrompt;
                };
                window.alert = (m) => console.log(`[alert] ${m}`);
                window.console.warn = (...a) => console.log('[warn]', ...a);
                window.console.error = (...a) => console.log('[error]', ...a);
            },
        });
    };

    return { fetch: bridgedFetch, boot };
}

/// Register + sign in on a session. Returns the username it minted (or used).
export async function signUp(s, prefix, password = `${prefix}-password-123`) {
    const username = `${prefix}${Date.now() % 100000}`;
    const J = { 'Content-Type': 'application/json' };
    const creds = JSON.stringify({ username, password });
    await s.fetch('/api/auth/register', { method: 'POST', headers: J, body: creds });
    await s.fetch('/api/auth/login', { method: 'POST', headers: J, body: creds });
    return { username, password };
}

export async function signIn(s, username, password) {
    await s.fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
    });
}

/// Wait for a predicate over the document, with the body dumped on timeout.
export async function waitFor(doc, pred, what, ms = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const v = pred();
        if (v) return v;
        await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}\n--- body:\n${doc.body.innerHTML.slice(0, 1500)}`);
}

/// A real bubbling click.
export const click = (window, el) =>
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
