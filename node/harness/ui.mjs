// The single-doc UI probe: sign in with existing credentials, deep-link the real SPA straight
// onto one document, and report what the editor buffer actually holds. The reading half of
// state.mjs's writing half - state builds a history the UI couldn't, this shows what the UI
// makes of it. Same jsdom stubs as drive.mjs (which owns the from-scratch walk).
//
// Usage: node ui.mjs <base> <user> <pw> <docId>     (state.mjs prints this line ready-made)
import pkg from 'jsdom';
const { JSDOM, ResourceLoader } = pkg;
import 'fake-indexeddb/auto';

const [BASE, USER, PW, DOC] = process.argv.slice(2);
if (!DOC) {
    console.error('usage: node ui.mjs <base> <user> <pw> <docId>');
    process.exit(2);
}
let cookies = '';
async function bridgedFetch(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url, BASE).href;
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
}
await bridgedFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PW }),
});

const html = await (await fetch(`${BASE}/home/notes/${DOC}`)).text();
const dom = new JSDOM(html, {
    url: `${BASE}/home/notes/${DOC}`,
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
        window.Element.prototype.scrollIntoView = () => {}; // jsdom doesn't implement it
        window.prompt = () => 'x';
        window.alert = (m) => console.log(`[alert] ${m}`);
        window.console.warn = (...a) => console.log('[warn]', ...a);
        window.console.error = (...a) => console.log('[error]', ...a);
    },
});
const { window } = dom;
const doc = window.document;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let t = 0; t < 20; t++) {
    await sleep(500);
    const ta = doc.querySelector('textarea.editor-source, .editor textarea, textarea');
    const cm = doc.querySelector('.cm-content');
    if (ta || cm) {
        console.log('--- editor surface found at', t * 0.5, 's');
        if (ta) console.log('textarea value:', JSON.stringify(ta.value).slice(0, 400));
        if (cm) console.log('cm content:', JSON.stringify(cm.textContent).slice(0, 400));
        break;
    }
    if (t === 19) {
        console.log('no editor surface found');
        console.log('body text:', JSON.stringify(doc.body.textContent).slice(0, 400));
    }
}
console.log('final url:', window.location.pathname);
process.exit(0);
