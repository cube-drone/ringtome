// The join-flow probe: B's browser starts the join (the real NullState -> JoinFlow click
// path), A grants via API (one-trip delivery), and we watch what B's tab renders once the
// persona arrives on its own. Two throwaway nodes as in state.mjs's usage header.
//
// First catch (2026-07-30, reproduced on its first run): the arrival watcher cleared the
// join state BEFORE the async `open` finished, so a transitional render met JoinFlow with a
// null join, threw, and the corrupted tree left the new computer showing only the quickbar.
// Fixed in persona.js (open-then-clear, plus a render guard); this script proves the arrival
// now lands on the open console within one poll tick.
import pkg from 'jsdom';
const { JSDOM, ResourceLoader } = pkg;
import 'fake-indexeddb/auto';

const A = 'http://localhost:5297';
const B = 'http://localhost:5296';

function jar() {
    let cookies = '';
    const f = async (input, init = {}, base = B) => {
        const url = new URL(typeof input === 'string' ? input : input.url, base).href;
        const headers = new Headers(init.headers || {});
        if (cookies) headers.set('cookie', cookies);
        const resp = await fetch(url, { ...init, headers, redirect: 'manual' });
        const setc = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
        for (const c of setc) {
            const pair = c.split(';')[0];
            const name = pair.split('=')[0];
            cookies = [...cookies.split('; ').filter((x) => x && !x.startsWith(name + '=')), pair].join('; ');
        }
        return resp;
    };
    return f;
}

const J = { 'Content-Type': 'application/json' };
const user = `join${Date.now() % 100000}`;

// A: account + persona, via API.
const aFetch = jar();
await aFetch('/api/auth/register', { method: 'POST', headers: J, body: JSON.stringify({ username: user + 'a', password: 'pw-aaaaaaaa' }) }, A);
await aFetch('/api/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ username: user + 'a', password: 'pw-aaaaaaaa' }) }, A);
const made = await (await aFetch('/api/identity', { method: 'POST', headers: J }, A)).json();
const root = made.root_pubkey;

// B: account only, via the browser's own jar (shared with the SPA).
const bFetch = jar();
await bFetch('/api/auth/register', { method: 'POST', headers: J, body: JSON.stringify({ username: user + 'b', password: 'pw-bbbbbbbb' }) });
await bFetch('/api/auth/login', { method: 'POST', headers: J, body: JSON.stringify({ username: user + 'b', password: 'pw-bbbbbbbb' }) });

const html = await (await fetch(`${B}/home`)).text();
const dom = new JSDOM(html, {
    url: `${B}/home`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    resources: new ResourceLoader(),
    beforeParse(window) {
        window.fetch = (i, init) => bFetch(i, init);
        window.Headers = Headers;
        window.TextEncoder = TextEncoder;
        window.TextDecoder = TextDecoder;
        window.crypto = globalThis.crypto;
        window.requestAnimationFrame = (f) => setTimeout(() => f(Date.now()), 16);
        window.cancelAnimationFrame = clearTimeout;
        window.indexedDB = indexedDB;
        window.IDBKeyRange = IDBKeyRange;
        window.WebSocket = class {
            constructor() { setTimeout(() => this.onopen && this.onopen(), 0); }
            send() {}
            close() {}
            addEventListener(t, f) { if (t === 'open') setTimeout(f, 0); }
            removeEventListener() {}
        };
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
        window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
        window.scrollTo = () => {};
        window.Element.prototype.scrollIntoView = () => {};
        window.alert = (m) => console.log(`[alert] ${m}`);
        window.console.warn = (...a) => console.log('[warn]', ...a);
        window.console.error = (...a) => console.log('[error]', ...a);
    },
});
const { window } = dom;
const doc = window.document;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
const snap = (label) => {
    const text = doc.body.textContent.replace(/\s+/g, ' ').trim().slice(0, 250);
    console.log(`### ${label}\n    url=${window.location.pathname} hexes=${doc.querySelectorAll('.quickbar-hex').length} frame=${!!doc.querySelector('.app-frame-inner')} stage=${!!doc.querySelector('.app-stage')}\n    text="${text}"`);
};

// Wait for the null state, start the join.
for (let t = 0; t < 30 && !doc.querySelector('.skip-link'); t++) await sleep(500);
snap('null state');
const joinBtn = [...doc.querySelectorAll('button')].find((b) => /bring your persona/.test(b.textContent));
click(joinBtn);
for (let t = 0; t < 30 && !doc.querySelector('.spare-key'); t++) await sleep(500);
snap('join screen (request code showing)');
const code = doc.querySelector('.spare-key').textContent.trim();

// A grants - one-trip delivery expected (both nodes live on one machine).
const grant = await (await aFetch(`/api/identity/${root}/nodes`, { method: 'POST', headers: J, body: JSON.stringify({ code }) }, A)).json();
console.log('grant delivered over the wire:', grant.delivered);

// Now watch B's tab: the 2s arrival poll should open the persona.
for (let t = 1; t <= 8; t++) {
    await sleep(2000);
    snap(`${t * 2}s after grant`);
    if (doc.querySelector('.console, .app-frame-inner')) break;
}
process.exit(0);
